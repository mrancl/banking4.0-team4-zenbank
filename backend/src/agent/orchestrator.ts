import crypto from 'node:crypto';
import {
  activatePaymentRestrictionIfUpdateNeeded,
  applyZenBankProfileUpdate,
  checkCustomerAccountStatus,
  createSeedCustomer,
} from '../banking/mockZenBankCore.js';
import { evaluateVerificationResult } from '../banking/rules.js';
import { safeLog } from '../logging.js';
import {
  VerificationCryptoError,
  openAndVerifyResult,
  type JwksResolver,
} from '../verifier/crypto.js';
import {
  MockVerifierClient,
  VerifierHttpError,
  type VerifierClient,
} from '../verifier/client.js';
import type {
  AccountStatusCheck,
  AgentStage,
  AuditEvent,
  BankRuleEvaluation,
  ChatCard,
  ChatMessage,
  CustomerId,
  DemoScenario,
  FlowChannel,
  KycIncomeProfile,
  Language,
  SessionPublicState,
  StructuredAddress,
  TrustCheckItem,
  VerificationLaunchMode,
  VerificationScope,
  ZenBankCustomerProfile,
  ZeroPiiAgentContext,
} from '../types.js';
import {
  ZeroPiiAssistant,
  buildZeroPiiContext,
  classifyDeterministicIntent,
} from './geminiAssistant.js';

interface ActiveVerification {
  transactionId: string;
  scope: VerificationScope;
  profileCode: string;
  sameDevice: boolean;
  status: string;
  expiresAt: string;
  deepLink: string;
  qrSvg: string;
}

interface PendingUpdate {
  id: string;
  transactionId: string;
  scope: VerificationScope;
  profileCode: string;
  verifiedAddress: StructuredAddress | null;
  verifiedIncome: KycIncomeProfile | null;
  canUpdateAddress: boolean;
  canUpdateIncome: boolean;
  canConfirmIdentityOnly: boolean;
  validUntil?: { pid?: string; address?: string; income?: string };
  expiredCredentials?: Array<'PID' | 'ADDRESS' | 'INCOME'>;
}

interface SessionInternal {
  sessionId: string;
  scenario: DemoScenario;
  stage: AgentStage;
  flowChannel: FlowChannel | null;
  selectedScope: VerificationScope;
  selectedProfileCode: string;
  activeFlowCard: ChatCard | null;
  language: Language;
  customer: ZenBankCustomerProfile;
  messages: ChatMessage[];
  activeVerification: ActiveVerification | null;
  pendingUpdate: PendingUpdate | null;
  lastEvaluation: BankRuleEvaluation | null;
  lastTrustChecks: TrustCheckItem[];
  lastZeroPiiContext: ZeroPiiAgentContext | null;
  lastLlmMeta: { usedGemini: boolean; model: string; fallbackReason?: string } | null;
  auditLog: AuditEvent[];
}

export interface OrchestratorDeps {
  verifierClient: VerifierClient;
  jwks: JwksResolver;
  assistant: ZeroPiiAssistant;
  issuer: string;
  audience: string;
  profileCode: string;
  webReturnUri?: string;
  nativeReturnUri?: string;
  privateKeyPem: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

export function resolveProfileCode(scope: VerificationScope, defaultFullCode: string): string {
  switch (scope) {
    case 'address':
      return 'qa-address-23';
    case 'income':
      return 'qa-income-23';
    case 'full':
    default:
      return defaultFullCode;
  }
}

function buildPreConsentCard(scope: VerificationScope, profileCode: string): ChatCard {
  const pidCred = {
    credential: 'Identitatea ta',
    vct: 'urn:banking40:sandbox:pid-ro:1',
    attributes: ['Nume și prenume', 'Data nașterii'],
    why: 'Confirmă că ești titularul contului înregistrat la ZenBank.',
  };
  const addressCred = {
    credential: 'Adresa de domiciliu',
    vct: 'urn:banking40:sandbox:address:1',
    attributes: ['Adresa completă'],
    why: 'Verifică dacă adresa ta s-a schimbat pentru a o actualiza în profil.',
  };

  if (scope === 'address') {
    return {
      type: 'pre_consent',
      scope,
      profileCode,
      purpose: 'Doar adresă',
      requestedCredentials: [addressCred],
      excludedItems: [
        'Nu solicităm date despre venit, angajator sau datele din actul de identitate',
        'Nu stocăm CNP-ul și nici locul nașterii',
        'Nu încarci facturi de utilități sau poze cu documente',
      ],
    };
  }

  if (scope === 'income') {
    return {
      type: 'pre_consent',
      scope,
      profileCode,
      purpose: 'Doar venit',
      requestedCredentials: [
        {
          credential: 'Atestare venit',
          vct: 'urn:banking40:sandbox:income:1',
          attributes: ['Interval de venit (media pe 6 luni)', 'Moneda'],
          why: 'Actualizează intervalul tău de venit în profilul bancar fără adeverință de salariu.',
        },
      ],
      excludedItems: [
        'Nu solicităm adresa de domiciliu și nici datele din actul de identitate',
        'Nu salvăm sumele exacte lunare — reținem doar intervalul de venit',
        'Nu încarci adeverințe de salariu sau extrase PDF',
      ],
    };
  }

  return {
    type: 'pre_consent',
    scope,
    profileCode,
    purpose: 'Profil complet',
    requestedCredentials: [
      pidCred,
      addressCred,
      {
        credential: 'Venit și angajator',
        vct: 'urn:banking40:sandbox:income:1',
        attributes: ['Tipul venitului', 'Numele angajatorului', 'Interval de venit'],
        why: 'Actualizează sursa de venit și angajatorul în profilul tău bancar, fără adeverință de salariu.',
      },
    ],
    excludedItems: [
      'Nu stocăm CNP-ul și nici locul nașterii',
      'Nu salvăm sumele exacte lunare — reținem doar intervalul de venit',
      'Nu încarci poze cu actul de identitate, facturi sau adeverințe',
    ],
  };
}

export class JourneyOrchestrator {
  private readonly sessions = new Map<string, SessionInternal>();
  private readonly seenJtis = new Set<string>();
  private readonly inFlightPolls = new Map<string, Promise<SessionPublicState>>();
  private readonly deps: OrchestratorDeps;

  constructor(deps: OrchestratorDeps) {
    this.deps = deps;
  }

  private createInitialSession(
    sessionId: string,
    customerId: CustomerId = 'radu',
    scenario: DemoScenario = 'data_update',
  ): SessionInternal {
    const customer = createSeedCustomer(customerId, scenario);
    const introText =
      scenario === 'payment_restricted'
        ? 'Bună! Observ că plățile din contul tău sunt momentan blocate. Întreabă-mă „De ce nu pot face plăți?” și verificăm imediat cum rezolvăm.'
        : 'Bună! Sunt asistentul tău ZenBank. Întreabă-mă orice despre contul tău — de exemplu, „De ce nu pot face plăți?” sau „Cum îmi actualizez datele?”';

    return {
      sessionId,
      scenario,
      stage: 'IDLE',
      flowChannel: null,
      selectedScope: 'full',
      selectedProfileCode: this.deps.profileCode,
      activeFlowCard: null,
      language: 'ro',
      customer,
      messages: [
        {
          id: crypto.randomUUID(),
          role: 'agent',
          text: introText,
          timestamp: nowIso(),
        },
      ],
      activeVerification: null,
      pendingUpdate: null,
      lastEvaluation: null,
      lastTrustChecks: [],
      lastZeroPiiContext: buildZeroPiiContext({
        stage: 'IDLE',
        customer,
        language: 'ro',
      }),
      lastLlmMeta: null,
      auditLog: [
        {
          id: crypto.randomUUID(),
          timestamp: nowIso(),
          category: 'ZENBANK_CORE',
          action: 'SESSION_INITIALIZED',
          detail: `Profil ZenBank încărcat (${customer.id}, document=${customer.documentType}, scenariu=${scenario}).`,
          piiStored: false,
        },
      ],
    };
  }

  private getSessionInternal(sessionId: string): SessionInternal {
    let session = this.sessions.get(sessionId);
    if (!session) {
      session = this.createInitialSession(sessionId);
      this.sessions.set(sessionId, session);
    }
    return session;
  }

  private addAudit(
    session: SessionInternal,
    category: AuditEvent['category'],
    action: string,
    detail: string,
  ): void {
    session.auditLog.push({
      id: crypto.randomUUID(),
      timestamp: nowIso(),
      category,
      action,
      detail,
      piiStored: false,
    });
    safeLog('info', `audit:${action}`, { category, action });
  }

  private addMessage(
    session: SessionInternal,
    role: 'user' | 'agent',
    text: string,
    card?: ChatCard,
    accountCheck?: AccountStatusCheck,
  ): void {
    session.messages.push({
      id: crypto.randomUUID(),
      role,
      text,
      timestamp: nowIso(),
      ...(accountCheck ? { accountCheck } : {}),
      ...(card ? { card } : {}),
    });
  }

  private extraForbiddenPii(session: SessionInternal): string[] {
    const extra: string[] = [];
    const verifiedAddr = session.lastEvaluation?.verifiedAddress;
    if (verifiedAddr) {
      if (verifiedAddr.streetAddress) extra.push(verifiedAddr.streetAddress);
      if (verifiedAddr.postalCode) extra.push(verifiedAddr.postalCode);
    }
    const verifiedInc = session.lastEvaluation?.verifiedIncome;
    if (verifiedInc?.employer) {
      extra.push(verifiedInc.employer);
    }
    if (session.pendingUpdate?.verifiedAddress) {
      extra.push(session.pendingUpdate.verifiedAddress.streetAddress);
      extra.push(session.pendingUpdate.verifiedAddress.postalCode);
    }
    if (session.pendingUpdate?.verifiedIncome?.employer) {
      extra.push(session.pendingUpdate.verifiedIncome.employer);
    }
    return extra;
  }

  getPublicState(sessionId: string): SessionPublicState {
    const s = this.getSessionInternal(sessionId);
    return {
      sessionId: s.sessionId,
      scenario: s.scenario,
      stage: s.stage,
      flowChannel: s.flowChannel,
      selectedScope: s.selectedScope,
      selectedProfileCode: s.selectedProfileCode,
      activeFlowCard: s.activeFlowCard,
      customer: {
        ...s.customer,
        currentAddress: { ...s.customer.currentAddress },
        currentIncome: { ...s.customer.currentIncome },
      },
      messages: s.messages,
      activeVerification: s.activeVerification
        ? {
            transactionId: s.activeVerification.transactionId,
            status: s.activeVerification.status,
            sameDevice: s.activeVerification.sameDevice,
            expiresAt: s.activeVerification.expiresAt,
          }
        : null,
      lastTrustChecks: s.lastTrustChecks,
      lastZeroPiiContext: s.lastZeroPiiContext,
      lastLlmMeta: s.lastLlmMeta,
      auditLog: s.auditLog,
      securityBadges: {
        llmPiiExposed: false,
        geminiStoreEnabled: false,
        rawTokensLogged: false,
      },
    };
  }

  async handleChat(
    sessionId: string,
    message: string,
    quickAction?: 'START_DATA_UPDATE' | 'EXPLAIN_PAYMENT_RESTRICTION' | 'EXPLAIN_PRIVACY',
    requestedScope?: VerificationScope,
  ): Promise<SessionPublicState> {
    const session = this.getSessionInternal(sessionId);
    const trimmed = message.trim();
    if (!trimmed) {
      return this.getPublicState(sessionId);
    }

    this.addMessage(session, 'user', trimmed);

    const isPaymentInquiry =
      quickAction === 'EXPLAIN_PAYMENT_RESTRICTION' ||
      classifyDeterministicIntent(trimmed) === 'EXPLAIN_PAYMENT_RESTRICTION';
    if (isPaymentInquiry) {
      activatePaymentRestrictionIfUpdateNeeded(session.customer);
    }

    const reply = await this.deps.assistant.respond({
      userMessage: trimmed,
      quickAction,
      requestedScope,
      customer: session.customer,
      stage: session.stage,
      evaluation: session.lastEvaluation,
      extraForbiddenPii: this.extraForbiddenPii(session),
    });

    session.language = reply.zeroPiiContext.language;
    session.lastZeroPiiContext = reply.zeroPiiContext;
    session.lastLlmMeta = {
      usedGemini: reply.usedGemini,
      model: this.deps.assistant.getModel(),
      ...(reply.fallbackReason ? { fallbackReason: reply.fallbackReason } : {}),
    };

    if (reply.hadPiiInInput) {
      this.addAudit(
        session,
        'AGENT',
        'USER_INPUT_PII_SCRUBBED',
        'Datele personale au fost anonimizate din mesajul utilizatorului înainte de apelul LLM.',
      );
    }

    let card: ChatCard | undefined;
    let accountCheck: AccountStatusCheck | undefined;
    if (reply.intent === 'START_DATA_UPDATE') {
      const scope: VerificationScope = requestedScope ?? reply.requestedScope ?? 'full';
      const profileCode = resolveProfileCode(scope, this.deps.profileCode);
      session.flowChannel = 'chat';
      session.selectedScope = scope;
      session.selectedProfileCode = profileCode;
      session.stage = 'PRE_CONSENT';
      card = buildPreConsentCard(scope, profileCode);
      session.activeFlowCard = card;
      this.addAudit(
        session,
        'AGENT',
        'PRE_CONSENT_PREPARED',
        `Rutare dinamică profil EUDI (scope=${scope}, profile=${profileCode}, kyc=${session.customer.kycStatus}, usedGemini=${String(reply.usedGemini)}).`,
      );
    } else if (reply.intent === 'EXPLAIN_PAYMENT_RESTRICTION') {
      activatePaymentRestrictionIfUpdateNeeded(session.customer);
      accountCheck = checkCustomerAccountStatus(session.customer);
      this.addAudit(
        session,
        'ZENBANK_CORE',
        'ACCOUNT_DATA_CHECKED',
        `Verificat profil client ZenBank (dataUpdateRequired=${String(accountCheck.dataUpdateRequired)}, paymentRestricted=${String(accountCheck.paymentRestricted)}, missing=${accountCheck.missingItems.join(', ') || 'none'}).`,
      );
      if (accountCheck.dataUpdateRequired) {
        const idNeeded = accountCheck.checks.find((c) => c.id === 'identity')?.status !== 'OK';
        const addrNeeded = accountCheck.checks.find((c) => c.id === 'address')?.status !== 'OK';
        const incNeeded = accountCheck.checks.find((c) => c.id === 'income')?.status !== 'OK';

        const paymentScope: VerificationScope =
          !idNeeded && !addrNeeded && incNeeded
            ? 'income'
            : addrNeeded && !incNeeded
              ? 'address'
              : 'full';
        const profileCode = resolveProfileCode(paymentScope, this.deps.profileCode);

        session.flowChannel = 'chat';
        session.selectedScope = paymentScope;
        session.selectedProfileCode = profileCode;
        session.stage = 'PRE_CONSENT';
        card = buildPreConsentCard(paymentScope, profileCode);
        session.activeFlowCard = card;
        this.addAudit(
          session,
          'AGENT',
          accountCheck.paymentRestricted ? 'RESTRICTION_DIAGNOSED' : 'UPDATE_NEEDED_DIAGNOSED',
          accountCheck.paymentRestricted
            ? `Identificată actualizare incompletă care blochează plățile (usedGemini=${String(reply.usedGemini)}); inițiat flux EUDI (${profileCode}).`
            : `Identificată necesitatea actualizării datelor personale la întrebarea din chat (usedGemini=${String(reply.usedGemini)}); inițiat flux EUDI (${profileCode}).`,
        );
      } else {
        this.addAudit(
          session,
          'AGENT',
          'RESTRICTION_CHECKED',
          `Confirmat că datele sunt la zi și plățile efectuate sunt active (usedGemini=${String(reply.usedGemini)}).`,
        );
      }
    } else if (reply.intent === 'CANCEL') {
      session.stage = 'IDLE';
      session.flowChannel = null;
      session.selectedScope = 'full';
      session.selectedProfileCode = this.deps.profileCode;
      session.activeFlowCard = null;
      session.activeVerification = null;
      session.pendingUpdate = null;
      this.addAudit(session, 'AGENT', 'FLOW_CANCELLED', 'Clientul a anulat pasul curent de actualizare.');
    } else {
      this.addAudit(
        session,
        'AGENT',
        'CHAT_ANSWERED',
        `Procesat intent=${reply.intent} (usedGemini=${String(reply.usedGemini)}, zeroPii=true).`,
      );
    }

    session.lastZeroPiiContext = buildZeroPiiContext({
      stage: session.stage,
      customer: session.customer,
      evaluation: session.lastEvaluation,
      selectedScope: session.selectedScope,
      selectedProfileCode: session.selectedProfileCode,
      language: session.language,
    });

    this.addMessage(session, 'agent', reply.reply, card, accountCheck);
    return this.getPublicState(sessionId);
  }

  /**
   * Starts a direct client-profile update flow without touching the support Chat stream.
   */
  startProfileUpdate(sessionId: string, scope: VerificationScope = 'full'): SessionPublicState {
    const session = this.getSessionInternal(sessionId);
    const profileCode = resolveProfileCode(scope, this.deps.profileCode);
    const card = buildPreConsentCard(scope, profileCode);

    session.flowChannel = 'profile';
    session.selectedScope = scope;
    session.selectedProfileCode = profileCode;
    session.stage = 'PRE_CONSENT';
    session.activeFlowCard = card;
    session.activeVerification = null;
    session.pendingUpdate = null;
    session.lastZeroPiiContext = buildZeroPiiContext({
      stage: session.stage,
      customer: session.customer,
      evaluation: session.lastEvaluation,
      selectedScope: scope,
      selectedProfileCode: profileCode,
      language: session.language,
    });

    this.addAudit(
      session,
      'ZENBANK_CORE',
      'PRE_CONSENT_PREPARED',
      `Actualizare inițiată din pagina Datele mele (source=profile, scope=${scope}, profile=${profileCode}, kyc=${session.customer.kycStatus}).`,
    );

    return this.getPublicState(sessionId);
  }

  /**
   * Explicitly cancels the active update / verification flow (either user-cancelled or
   * wallet-declined), ensuring polling stops cleanly and no ZenBank profile fields mutate.
   */
  cancelFlow(
    sessionId: string,
    opts?: { reason?: 'USER_CANCELLED' | 'WALLET_DECLINED'; detail?: string },
  ): SessionPublicState {
    const session = this.getSessionInternal(sessionId);

    if (opts?.reason === 'WALLET_DECLINED') {
      this.handleTerminalErrorStatus(session, 'DECLINED', opts.detail);
      return this.getPublicState(sessionId);
    }

    const wasChat = session.flowChannel === 'chat';
    session.stage = 'IDLE';
    session.flowChannel = null;
    session.selectedScope = 'full';
    session.selectedProfileCode = this.deps.profileCode;
    session.activeFlowCard = null;
    session.activeVerification = null;
    session.pendingUpdate = null;

    session.lastZeroPiiContext = buildZeroPiiContext({
      stage: session.stage,
      customer: session.customer,
      evaluation: session.lastEvaluation,
      selectedScope: session.selectedScope,
      selectedProfileCode: session.selectedProfileCode,
      language: session.language,
    });

    this.addAudit(
      session,
      'AGENT',
      'FLOW_CANCELLED',
      'Clientul a anulat pasul curent de actualizare.',
    );

    if (wasChat) {
      this.addMessage(
        session,
        'agent',
        'Am anulat operațiunea curentă. Profilul tău ZenBank a rămas neschimbat și poți relua verificarea oricând.',
      );
    }

    return this.getPublicState(sessionId);
  }

  async startVerification(
    sessionId: string,
    launchMode: VerificationLaunchMode = 'cross_device',
  ): Promise<SessionPublicState> {
    const session = this.getSessionInternal(sessionId);
    const scope = session.selectedScope ?? 'full';
    const profileCode =
      session.selectedProfileCode || resolveProfileCode(scope, this.deps.profileCode);

    const returnUri =
      launchMode === 'same_device_native'
        ? this.deps.nativeReturnUri || 'ro.banking40.team04://same-device'
        : launchMode === 'same_device_web' && this.deps.webReturnUri
          ? this.deps.webReturnUri
          : undefined;
    const sameDevice = Boolean(returnUri);

    const started = await this.deps.verifierClient.startVerification(profileCode, returnUri);

    const card: ChatCard = {
      type: 'wallet_qr',
      transactionId: started.transactionId,
      profileCode,
      sameDevice,
      qrSvg: started.qrSvg,
      deepLink: started.deepLink,
      expiresAt: started.expiresAt,
      status: 'CREATED',
    };

    session.stage = 'AWAITING_WALLET';
    session.pendingUpdate = null;
    session.activeFlowCard = card;
    session.activeVerification = {
      transactionId: started.transactionId,
      scope,
      profileCode,
      sameDevice,
      status: 'CREATED',
      expiresAt: started.expiresAt,
      deepLink: started.deepLink,
      qrSvg: started.qrSvg,
    };

    session.lastZeroPiiContext = buildZeroPiiContext({
      stage: session.stage,
      customer: session.customer,
      selectedScope: scope,
      selectedProfileCode: profileCode,
      language: session.language,
    });

    this.addAudit(
      session,
      'VERIFIER',
      'VERIFICATION_STARTED',
      `Creată verificare EUDI (${scope}, mode=${sameDevice ? launchMode : 'cross_device'}) pentru profilul=${profileCode}.`,
    );

    if (session.flowChannel !== 'profile') {
      const text = sameDevice
        ? scope === 'address'
          ? 'Apasă butonul Deschide în EUDI Wallet de mai jos și aprobă partajarea atestării de adresă.'
          : scope === 'income'
            ? 'Apasă butonul Deschide în EUDI Wallet de mai jos și aprobă partajarea atestării de venit.'
            : 'Apasă butonul Deschide în EUDI Wallet de mai jos și aprobă partajarea datelor tale de identitate, adresă și venit.'
        : scope === 'address'
          ? 'Scanează codul QR de mai jos cu aplicația EUDI Wallet (sau apasă Deschide în EUDI Wallet) și aprobă partajarea atestării de adresă.'
          : scope === 'income'
            ? 'Scanează codul QR de mai jos cu aplicația EUDI Wallet (sau apasă Deschide în EUDI Wallet) și aprobă partajarea atestării de venit.'
            : 'Scanează codul QR de mai jos cu aplicația EUDI Wallet și aprobă partajarea datelor tale de identitate, adresă și venit.';
      this.addMessage(session, 'agent', text, card);
    }

    return this.getPublicState(sessionId);
  }

  /**
   * Deduplicates concurrent poll calls for the same session/transaction so overlapping 2s polls
   * never race into JTI_REPLAY or RESULT_GONE when network latency exceeds the poll interval.
   */
  pollVerification(sessionId: string, transactionId: string): Promise<SessionPublicState> {
    const lockKey = `${sessionId}:${transactionId}`;
    const existing = this.inFlightPolls.get(lockKey);
    if (existing) {
      return existing;
    }

    const promise = this.executePollVerification(sessionId, transactionId).finally(() => {
      this.inFlightPolls.delete(lockKey);
    });
    this.inFlightPolls.set(lockKey, promise);
    return promise;
  }

  private async executePollVerification(
    sessionId: string,
    transactionId: string,
  ): Promise<SessionPublicState> {
    const session = this.getSessionInternal(sessionId);
    if (!session.activeVerification || session.activeVerification.transactionId !== transactionId) {
      return this.getPublicState(sessionId);
    }

    const statusResp = await this.deps.verifierClient.getVerificationStatus(transactionId);
    session.activeVerification.status = statusResp.status;
    this.syncWalletQrStatus(session, transactionId, statusResp.status);

    if (
      statusResp.status === 'CREATED' ||
      statusResp.status === 'REQUEST_RETRIEVED' ||
      statusResp.status === 'RESPONSE_CODE_REQUIRED'
    ) {
      return this.getPublicState(sessionId);
    }

    if (statusResp.status !== 'COMPLETED') {
      this.handleTerminalErrorStatus(
        session,
        statusResp.status,
        statusResp.reason ?? statusResp.walletError ?? undefined,
      );
      return this.getPublicState(sessionId);
    }

    return await this.fetchVerifyAndApplyResult(session, transactionId);
  }

  private syncWalletQrStatus(
    session: SessionInternal,
    transactionId: string,
    status: string,
  ): void {
    if (
      session.activeFlowCard?.type === 'wallet_qr' &&
      session.activeFlowCard.transactionId === transactionId
    ) {
      session.activeFlowCard.status = status;
    }
    for (const msg of session.messages) {
      if (msg.card?.type === 'wallet_qr' && msg.card.transactionId === transactionId) {
        msg.card.status = status;
      }
    }
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async claimWithRetry(transactionId: string, responseCode: string) {
    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return await this.deps.verifierClient.claimVerification(transactionId, responseCode);
      } catch (err) {
        const isTransientNotReady =
          err instanceof VerifierHttpError &&
          err.statusCode === 409 &&
          err.code === 'RESULT_NOT_READY';
        if (!isTransientNotReady || attempt >= maxAttempts) {
          throw err;
        }
        await this.sleep(750);
      }
    }
    throw new VerifierHttpError(
      409,
      'RESULT_NOT_READY',
      'Rezultatul EUDI nu este încă pregătit.',
    );
  }

  /**
   * Claims a same-device verification using the one-time response_code returned from EUDI Wallet,
   * sharing the inFlightPolls lock so concurrent 2s polls never race into JTI_REPLAY or RESULT_GONE.
   */
  async claimVerification(
    sessionId: string,
    responseCode: string,
    transactionId?: string,
  ): Promise<SessionPublicState> {
    const session = this.getSessionInternal(sessionId);
    const txId = transactionId || session.activeVerification?.transactionId;
    if (!txId) {
      throw new VerifierHttpError(
        409,
        'NO_ACTIVE_VERIFICATION',
        'Nu există o verificare EUDI activă pentru confirmare.',
      );
    }

    const lockKey = `${sessionId}:${txId}`;
    const existing = this.inFlightPolls.get(lockKey);
    if (existing) {
      await existing.catch(() => undefined);
    }

    if (!session.activeVerification || session.activeVerification.transactionId !== txId) {
      return this.getPublicState(sessionId);
    }

    const promise = (async () => {
      let claimed;
      try {
        claimed = await this.claimWithRetry(txId, responseCode);
      } catch (err) {
        const terminalClaimCodes = new Set([
          'VERIFICATION_EXPIRED',
          'RESPONSE_CODE_INVALID',
          'RESULT_GONE',
          'DECLINED',
          'WALLET_ERROR',
          'EXPIRED',
        ]);
        if (err instanceof VerifierHttpError && terminalClaimCodes.has(err.code)) {
          this.handleTerminalErrorStatus(session, err.code, err.message);
          return this.getPublicState(sessionId);
        }
        throw err;
      }

      if (session.activeVerification) {
        session.activeVerification.status = claimed.status;
      }
      this.syncWalletQrStatus(session, txId, claimed.status);

      if (
        claimed.status === 'CREATED' ||
        claimed.status === 'REQUEST_RETRIEVED' ||
        claimed.status === 'RESPONSE_CODE_REQUIRED'
      ) {
        return this.getPublicState(sessionId);
      }

      if (claimed.status !== 'COMPLETED') {
        this.handleTerminalErrorStatus(
          session,
          claimed.status,
          claimed.reason ?? claimed.walletError ?? undefined,
        );
        return this.getPublicState(sessionId);
      }

      return await this.fetchVerifyAndApplyResult(session, txId, true);
    })().finally(() => {
      this.inFlightPolls.delete(lockKey);
    });

    this.inFlightPolls.set(lockKey, promise);
    return promise;
  }

  private async fetchVerifyAndApplyResult(
    session: SessionInternal,
    transactionId: string,
    retryOnNotReady = false,
  ): Promise<SessionPublicState> {
    if (!session.activeVerification || session.activeVerification.transactionId !== transactionId) {
      return this.getPublicState(session.sessionId);
    }

    let fetched = await this.deps.verifierClient.fetchSealedResult(transactionId);
    if (fetched.kind === 'not_ready' && retryOnNotReady) {
      await this.sleep(750);
      fetched = await this.deps.verifierClient.fetchSealedResult(transactionId);
    }
    if (fetched.kind === 'not_ready') {
      return this.getPublicState(session.sessionId);
    }
    if (fetched.kind === 'gone' || fetched.kind === 'not_sealed') {
      this.handleTerminalErrorStatus(session, fetched.code, fetched.message);
      return this.getPublicState(session.sessionId);
    }

    if (!this.deps.privateKeyPem) {
      this.handleCryptoFailure(
        session,
        new VerificationCryptoError(
          'MISSING_PRIVATE_KEY',
          'Cheia privată a organizației pentru decriptarea rezultatelor nu este încărcată pe backend.',
          [
            {
              id: 'jwe_decrypt',
              label: 'Decriptare plic JWE',
              status: 'FAIL',
              detail: 'RESULT_PRIVATE_KEY_PATH / RESULT_PRIVATE_KEY_PEM nu este configurat.',
            },
          ],
        ),
      );
      return this.getPublicState(session.sessionId);
    }

    let cryptoResult;
    try {
      cryptoResult = await openAndVerifyResult({
        sealedJwe: fetched.sealedJwe,
        privateKeyPem: this.deps.privateKeyPem,
        issuer: this.deps.issuer,
        jwks: this.deps.jwks,
        audience: this.deps.audience,
        expectedTransactionId: transactionId,
        seenJtis: this.seenJtis,
      });
    } catch (err) {
      const cryptoErr =
        err instanceof VerificationCryptoError
          ? err
          : new VerificationCryptoError('CRYPTO_ERROR', 'Validarea criptografică a rezultatului a eșuat.', []);
      this.handleCryptoFailure(session, cryptoErr);
      return this.getPublicState(session.sessionId);
    }

    let acknowledged = false;
    try {
      acknowledged = await this.deps.verifierClient.acknowledgeResult(transactionId);
    } catch {
      acknowledged = false;
    }

    const txScope = session.activeVerification.scope;
    const txProfileCode = session.activeVerification.profileCode;

    const evaluation = evaluateVerificationResult({
      customer: session.customer,
      payload: cryptoResult.payload,
      cryptoChecks: cryptoResult.checks,
      acknowledged,
      requestedScope: txScope,
    });

    this.applyEvaluationToSession(session, transactionId, evaluation, false, txScope, txProfileCode);
    return this.getPublicState(session.sessionId);
  }

  private applyEvaluationToSession(
    session: SessionInternal,
    transactionId: string,
    evaluation: BankRuleEvaluation,
    simulated: boolean,
    scope: VerificationScope = session.selectedScope ?? 'full',
    profileCode: string = session.selectedProfileCode || resolveProfileCode(scope, this.deps.profileCode),
  ): void {
    session.activeVerification = null;
    session.lastEvaluation = evaluation;
    session.lastTrustChecks = evaluation.checks;

    if (
      evaluation.decision === 'READY_FOR_CONFIRMATION' ||
      evaluation.decision === 'NO_CHANGES_CONFIRM_IDENTITY' ||
      evaluation.decision === 'PARTIAL_IDENTITY_ONLY'
    ) {
      const pendingId = crypto.randomUUID();
      session.pendingUpdate = {
        id: pendingId,
        transactionId,
        scope,
        profileCode,
        verifiedAddress: evaluation.verifiedAddress,
        verifiedIncome: evaluation.verifiedIncome,
        canUpdateAddress: evaluation.canConfirmAddressUpdate,
        canUpdateIncome: evaluation.canConfirmIncomeUpdate,
        canConfirmIdentityOnly: evaluation.canConfirmIdentityOnly,
        ...(evaluation.credentialValidUntil ? { validUntil: evaluation.credentialValidUntil } : {}),
        ...(evaluation.expiredCredentials ? { expiredCredentials: evaluation.expiredCredentials } : {}),
      };
      session.stage = 'DIFF_READY';

      this.addAudit(
        session,
        simulated ? 'SIMULATION' : 'RULES',
        `EVALUATION_${evaluation.decision}`,
        `Rezultat EUDI evaluat (scope=${scope}, profile=${profileCode}); decizie=${evaluation.decision}; se așteaptă confirmarea explicită.`,
      );

      if (evaluation.decision === 'PARTIAL_IDENTITY_ONLY') {
        const card: ChatCard = {
          type: 'recovery',
          code: evaluation.reasonCode,
          title: 'Identitate confirmată · Unele date nu au fost partajate',
          detail: evaluation.message,
          simulated,
          canRetryEudi: true,
          canConfirmIdentityOnly: true,
          pendingUpdateId: pendingId,
          fallbackOptions: [
            'Confirmă doar reconfirmarea identității (păstrează datele curente din ZenBank)',
            'Reîncearcă în EUDI Wallet și aprobă partajarea datelor solicitate',
          ],
        };
        session.activeFlowCard = card;
        if (session.flowChannel !== 'profile') {
          this.addMessage(session, 'agent', evaluation.message, card);
        }
      } else {
        const hasAnyUpdate =
          Boolean(evaluation.addressDiff?.hasChanges) || Boolean(evaluation.incomeDiff?.hasChanges);
        const promptText = hasAnyUpdate
          ? `${evaluation.message}\n\nVrei să actualizez profilul tău ZenBank cu aceste date verificate?`
          : evaluation.message;

        const revocationNote =
          'Profilul tău nu se modifică până când nu apeși confirmarea. Poți verifica fiecare schimbare înainte de salvare.';

        const card: ChatCard = {
          type: 'diff_confirm',
          pendingUpdateId: pendingId,
          scope,
          profileCode,
          identityMatched: Boolean(evaluation.verifiedIdentity),
          identityName: evaluation.verifiedIdentity
            ? `${evaluation.verifiedIdentity.givenName} ${evaluation.verifiedIdentity.familyName}`
            : `${session.customer.givenName} ${session.customer.familyName}`,
          identityBirthdate:
            evaluation.verifiedIdentity?.birthdate ?? session.customer.birthdate,
          currentAddress: { ...session.customer.currentAddress },
          verifiedAddress: evaluation.verifiedAddress,
          addressDiff: evaluation.addressDiff,
          currentIncome: { ...session.customer.currentIncome },
          verifiedIncome: evaluation.verifiedIncome,
          incomeDiff: evaluation.incomeDiff,
          withheldFields: evaluation.withheldFields,
          canUpdateAddress: evaluation.canConfirmAddressUpdate,
          canUpdateIncome: evaluation.canConfirmIncomeUpdate,
          canConfirmIdentityOnly: evaluation.canConfirmIdentityOnly,
          revocationNote,
          ...(evaluation.warningNote ? { warningNote: evaluation.warningNote } : {}),
        };
        session.activeFlowCard = card;
        if (session.flowChannel !== 'profile') {
          this.addMessage(session, 'agent', promptText, card);
        }
      }
    } else if (evaluation.decision === 'SECURITY_BLOCKED') {
      session.pendingUpdate = null;
      session.stage = 'BLOCKED';
      this.addAudit(
        session,
        'RULES',
        'SECURITY_BLOCKED',
        `Modificare profil blocată: ${evaluation.reasonCode}.`,
      );
      const card: ChatCard = {
        type: 'recovery',
        code: evaluation.reasonCode,
        title: 'Nu putem aplica această actualizare',
        detail: evaluation.message,
        simulated,
        canRetryEudi: true,
        canConfirmIdentityOnly: false,
        fallbackOptions: [
          'Autentifică-te în contul ZenBank corespunzător sau folosește propriul EUDI Wallet',
          'Continuă printr-o sucursală ZenBank cu verificarea actului de identitate',
        ],
      };
      session.activeFlowCard = card;
      if (session.flowChannel !== 'profile') {
        this.addMessage(session, 'agent', evaluation.message, card);
      }
    } else {
      session.pendingUpdate = null;
      session.stage = 'DECLINED';
      this.addAudit(
        session,
        simulated ? 'SIMULATION' : 'RULES',
        `UNHAPPY_${evaluation.reasonCode}`,
        evaluation.message,
      );
      const isIncomeExpired = evaluation.reasonCode === 'INCOME_CREDENTIAL_EXPIRED';
      const card: ChatCard = {
        type: 'recovery',
        code: evaluation.reasonCode,
        title: isIncomeExpired
          ? 'Atestarea de venit a expirat'
          : 'Verificarea nu a fost finalizată',
        detail: evaluation.message,
        simulated,
        canRetryEudi: true,
        canConfirmIdentityOnly: false,
        ...(isIncomeExpired ? { suggestedFallbackScope: 'address' as VerificationScope } : {}),
        fallbackOptions: isIncomeExpired
          ? [
              'Reemite atestarea de venit în EUDI Wallet și reîncearcă actualizarea completă',
              'Actualizează acum doar adresa de domiciliu (documentul de adresă rămâne valid)',
            ]
          : [
              'Reîncearcă verificarea cu EUDI Wallet',
              'Încarcă actul de identitate, dovada adresei și adeverința de venit sau programează o vizită în sucursală',
            ],
      };
      session.activeFlowCard = card;
      if (session.flowChannel !== 'profile') {
        this.addMessage(session, 'agent', evaluation.message, card);
      }
    }

    session.lastZeroPiiContext = buildZeroPiiContext({
      stage: session.stage,
      customer: session.customer,
      evaluation,
      selectedScope: scope,
      selectedProfileCode: profileCode,
      language: session.language,
    });
  }

  private handleTerminalErrorStatus(
    session: SessionInternal,
    statusCode: string,
    reason?: string,
  ): void {
    session.activeVerification = null;
    session.pendingUpdate = null;
    session.stage = 'DECLINED';

    const detailMap: Record<string, { title: string; detail: string }> = {
      DECLINED: {
        title: 'Partajare refuzată în wallet',
        detail:
          reason ||
          'Ai ales să nu partajezi datele în EUDI Wallet. Profilul tău ZenBank nu a fost modificat.',
      },
      CANCELLED: {
        title: 'Verificare anulată',
        detail: 'Ai anulat verificarea în EUDI Wallet. Profilul tău ZenBank a rămas neschimbat.',
      },
      REJECTED: {
        title: 'Verificare respinsă',
        detail:
          reason ||
          'Verificarea din EUDI Wallet nu a îndeplinit cerințele. Profilul tău ZenBank a rămas neschimbat.',
      },
      RESPONSE_RECEIVED: {
        title: 'Răspuns incomplet de la EUDI Wallet',
        detail:
          reason ||
          'Verificarea s-a încheiat fără un rezultat aprobat. Poți reîncerca verificarea.',
      },
      FAILED: {
        title: 'Verificarea a eșuat',
        detail:
          reason ||
          'Verificarea nu a putut fi finalizată în EUDI Wallet. Te rugăm să reîncerci.',
      },
      EXPIRED: {
        title: 'Cererea de verificare a expirat',
        detail:
          'Timpul de 5 minute pentru aprobare a expirat. Poți porni oricând o verificare nouă.',
      },
      VERIFICATION_EXPIRED: {
        title: 'Cererea de verificare a expirat',
        detail:
          'Cererea de verificare a expirat înainte de finalizare. Poți porni o verificare nouă.',
      },
      RESPONSE_CODE_INVALID: {
        title: 'Cod de confirmare expirat sau invalid',
        detail:
          'Codul de confirmare din EUDI Wallet nu mai este valabil. Te rugăm să pornești o verificare nouă.',
      },
      WALLET_ERROR: {
        title: 'Eroare în aplicația EUDI Wallet',
        detail:
          reason ||
          'Aplicația wallet a întâmpinat o eroare temporară. Poți reîncerca sau folosi opțiunea clasică cu documente.',
      },
      RESULT_GONE: {
        title: 'Sesiune de verificare expirată',
        detail: 'Această cerere a fost deja procesată sau a expirat. Te rugăm să pornești o verificare nouă.',
      },
      RESULT_NOT_SEALED: {
        title: 'Răspuns incomplet de la EUDI Wallet',
        detail: 'Nu am primit un răspuns complet din EUDI Wallet. Te rugăm să încerci din nou.',
      },
    };

    const info = detailMap[statusCode] ?? {
      title: `Verificare întreruptă (${statusCode})`,
      detail: reason || 'Verificarea EUDI nu a putut fi finalizată.',
    };

    session.lastTrustChecks = [
      {
        id: 'verifier_status',
        label: 'Status tranzacție Verifier',
        status: 'FAIL',
        detail: `Status final: ${statusCode}`,
      },
    ];

    session.lastZeroPiiContext = buildZeroPiiContext({
      stage: session.stage,
      customer: session.customer,
      unhappyCode: statusCode,
      language: session.language,
    });

    const card: ChatCard = {
      type: 'recovery',
      code: statusCode,
      title: info.title,
      detail: info.detail,
      simulated: false,
      canRetryEudi: true,
      canConfirmIdentityOnly: false,
      fallbackOptions: [
        'Reîncearcă verificarea cu EUDI Wallet',
        'Continuă cu încărcarea manuală a actului de identitate, dovezii de adresă și adeverinței de venit',
      ],
    };
    session.activeFlowCard = card;

    this.addAudit(session, 'VERIFIER', `STATUS_${statusCode}`, info.detail);
    if (session.flowChannel !== 'profile') {
      this.addMessage(session, 'agent', info.detail, card);
    }
  }

  private handleCryptoFailure(session: SessionInternal, err: VerificationCryptoError): void {
    session.activeVerification = null;
    session.pendingUpdate = null;
    session.stage = 'BLOCKED';
    session.lastTrustChecks = err.checks;
    session.lastZeroPiiContext = buildZeroPiiContext({
      stage: session.stage,
      customer: session.customer,
      unhappyCode: err.code,
      language: session.language,
    });

    const card: ChatCard = {
      type: 'recovery',
      code: err.code,
      title: 'Verificarea de securitate nu a reușit',
      detail: err.message,
      simulated: false,
      canRetryEudi: true,
      canConfirmIdentityOnly: false,
      fallbackOptions: [
        'Pornește o nouă verificare prin EUDI Wallet',
        'Continuă printr-o sucursală ZenBank cu actul de identitate',
      ],
    };
    session.activeFlowCard = card;

    this.addAudit(session, 'CRYPTO', `CRYPTO_REJECTED_${err.code}`, err.message);
    if (session.flowChannel !== 'profile') {
      this.addMessage(
        session,
        'agent',
        'Nu am putut confirma siguranța răspunsului primit, așa că profilul tău nu a fost modificat.',
        card,
      );
    }
  }

  private isCredentialTimestampExpired(iso?: string, nowMs = Date.now()): boolean {
    if (!iso) return false;
    const parsed = Date.parse(iso);
    return Number.isFinite(parsed) && parsed <= nowMs;
  }

  confirmUpdate(
    sessionId: string,
    opts: { pendingUpdateId: string; mode: 'UPDATE_PROFILE' | 'UPDATE_ADDRESS' | 'IDENTITY_ONLY' },
  ): SessionPublicState {
    const session = this.getSessionInternal(sessionId);
    const pending = session.pendingUpdate;
    if (!pending || pending.id !== opts.pendingUpdateId) {
      throw new VerifierHttpError(
        409,
        'NO_PENDING_UPDATE',
        'Nu există nicio actualizare verificată în așteptarea confirmării.',
      );
    }

    if (opts.mode === 'UPDATE_ADDRESS' && !pending.canUpdateAddress) {
      throw new VerifierHttpError(
        400,
        'ADDRESS_UPDATE_NOT_AVAILABLE',
        'Actualizarea adresei nu este disponibilă pentru acest rezultat.',
      );
    }

    if (
      opts.mode === 'UPDATE_PROFILE' &&
      !pending.canUpdateAddress &&
      !pending.canUpdateIncome
    ) {
      throw new VerifierHttpError(
        400,
        'PROFILE_UPDATE_NOT_AVAILABLE',
        'Nu există modificări de adresă sau venit disponibile pentru aplicare.',
      );
    }

    const pendingScope = pending.scope;
    const pendingProfileCode = pending.profileCode;

    const updateAddress =
      (opts.mode === 'UPDATE_PROFILE' || opts.mode === 'UPDATE_ADDRESS') &&
      pending.canUpdateAddress;
    const updateIncome = opts.mode === 'UPDATE_PROFILE' && pending.canUpdateIncome;

    // TOCTOU re-validation against short-lived credential timestamps (e.g. 2-minute TTL)
    const nowMs = Date.now();
    if (this.isCredentialTimestampExpired(pending.validUntil?.pid, nowMs)) {
      session.pendingUpdate = null;
      session.stage = 'DECLINED';
      session.lastTrustChecks = [
        ...session.lastTrustChecks,
        {
          id: 'pid_expiry_toctou',
          label: 'Valabilitate document PID la confirmare',
          status: 'FAIL',
          detail: 'Documentul de identitate (PID) a expirat înainte de confirmarea finală.',
        },
      ];
      this.addAudit(
        session,
        'RULES',
        'CREDENTIAL_EXPIRED_BEFORE_CONFIRM',
        'Confirmare oprită: documentul PID a expirat înainte de salvarea datelor.',
      );
      const expiredCard: ChatCard = {
        type: 'recovery',
        code: 'CREDENTIAL_EXPIRED',
        title: 'Documentul de identitate a expirat',
        detail:
          'Documentul tău de identitate din EUDI Wallet a expirat între timp. Reemite documentul în wallet și pornește o verificare nouă.',
        simulated: false,
        canRetryEudi: true,
        canConfirmIdentityOnly: false,
        fallbackOptions: ['Pornește o nouă verificare cu EUDI Wallet'],
      };
      session.activeFlowCard = expiredCard;
      if (session.flowChannel !== 'profile') {
        this.addMessage(session, 'agent', expiredCard.detail, expiredCard);
      }
      return this.getPublicState(sessionId);
    }

    const incomeExpiredAtConfirm =
      updateIncome && this.isCredentialTimestampExpired(pending.validUntil?.income, nowMs);
    const addressExpiredAtConfirm =
      updateAddress && this.isCredentialTimestampExpired(pending.validUntil?.address, nowMs);

    if (incomeExpiredAtConfirm || addressExpiredAtConfirm) {
      if (incomeExpiredAtConfirm) {
        this.addAudit(
          session,
          'RULES',
          'INCOME_EXPIRED_BEFORE_CONFIRM',
          'Atestarea de venit a expirat înainte de confirmare și a fost exclusă.',
        );
        session.lastTrustChecks = [
          ...session.lastTrustChecks,
          {
            id: 'income_expiry_toctou',
            label: 'Valabilitate atestare venit la confirmare',
            status: 'FAIL',
            detail: 'Atestarea de venit a expirat înainte de confirmare și a fost exclusă.',
          },
        ];
        pending.verifiedIncome = null;
        pending.canUpdateIncome = false;
        pending.expiredCredentials = Array.from(
          new Set([...(pending.expiredCredentials ?? []), 'INCOME']),
        );
      }

      if (addressExpiredAtConfirm) {
        this.addAudit(
          session,
          'RULES',
          'ADDRESS_EXPIRED_BEFORE_CONFIRM',
          'Atestarea de adresă a expirat înainte de confirmare și a fost exclusă.',
        );
        session.lastTrustChecks = [
          ...session.lastTrustChecks,
          {
            id: 'address_expiry_toctou',
            label: 'Valabilitate atestare adresă la confirmare',
            status: 'FAIL',
            detail: 'Atestarea de adresă a expirat înainte de confirmare și a fost exclusă.',
          },
        ];
        pending.verifiedAddress = null;
        pending.canUpdateAddress = false;
        pending.expiredCredentials = Array.from(
          new Set([...(pending.expiredCredentials ?? []), 'ADDRESS']),
        );
      }

      const addressStillValid =
        pending.canUpdateAddress && !this.isCredentialTimestampExpired(pending.validUntil?.address, nowMs);
      const incomeStillValid =
        pending.canUpdateIncome && !this.isCredentialTimestampExpired(pending.validUntil?.income, nowMs);

      if (addressStillValid || incomeStillValid || pending.canConfirmIdentityOnly) {
        const warningNote = incomeExpiredAtConfirm && !addressExpiredAtConfirm
          ? 'Atestarea de venit a expirat între timp și a fost exclusă din actualizare. Adresa și identitatea rămân valide — apasă din nou confirmarea pentru a salva doar datele valide.'
          : addressExpiredAtConfirm && !incomeExpiredAtConfirm
            ? 'Atestarea de adresă a expirat între timp și a fost exclusă din actualizare. Datele valide rămase sunt pregătite pentru confirmare.'
            : 'Documentele de adresă și venit au expirat între timp; poți confirma doar reconfirmarea identității sau poți reîncearca verificarea.';

        if (session.activeFlowCard?.type === 'diff_confirm') {
          const updatedCard: ChatCard = {
            ...session.activeFlowCard,
            ...(pending.verifiedAddress === null
              ? { verifiedAddress: null, addressDiff: null, canUpdateAddress: false }
              : {}),
            ...(pending.verifiedIncome === null
              ? { verifiedIncome: null, incomeDiff: null, canUpdateIncome: false }
              : {}),
            warningNote,
          };
          session.activeFlowCard = updatedCard;
          if (session.flowChannel !== 'profile') {
            this.addMessage(session, 'agent', warningNote, updatedCard);
          }
        }
        return this.getPublicState(sessionId);
      }

      session.pendingUpdate = null;
      session.stage = 'DECLINED';
      const expiredCard: ChatCard = {
        type: 'recovery',
        code: incomeExpiredAtConfirm ? 'INCOME_CREDENTIAL_EXPIRED' : 'CREDENTIAL_EXPIRED',
        title: incomeExpiredAtConfirm
          ? 'Atestarea de venit a expirat'
          : 'Atestarea de adresă a expirat',
        detail: incomeExpiredAtConfirm
          ? 'Atestarea de venit a expirat înainte de confirmare. Reemite documentul în EUDI Wallet și reîncearcă.'
          : 'Atestarea de adresă a expirat înainte de confirmare. Reemite documentul în EUDI Wallet și reîncearcă.',
        simulated: false,
        canRetryEudi: true,
        canConfirmIdentityOnly: false,
        fallbackOptions: ['Reemite documentul în EUDI Wallet și pornește o nouă verificare'],
      };
      session.activeFlowCard = expiredCard;
      if (session.flowChannel !== 'profile') {
        this.addMessage(session, 'agent', expiredCard.detail, expiredCard);
      }
      return this.getPublicState(sessionId);
    }

    const receipt = applyZenBankProfileUpdate(session.customer, {
      updateAddress,
      verifiedAddress: pending.verifiedAddress,
      updateIncome,
      verifiedIncome: pending.verifiedIncome,
      scope: pendingScope,
      identityVerified: pending.canConfirmIdentityOnly,
      partialDueToExpiry: Boolean(pending.expiredCredentials?.length),
    });

    session.pendingUpdate = null;
    session.stage = 'COMPLETED';
    session.lastZeroPiiContext = buildZeroPiiContext({
      stage: session.stage,
      customer: session.customer,
      evaluation: session.lastEvaluation,
      selectedScope: pendingScope,
      selectedProfileCode: pendingProfileCode,
      language: session.language,
    });

    const card: ChatCard = {
      type: 'completed',
      scope: pendingScope,
      profileCode: pendingProfileCode,
      identityReconfirmed: receipt.identityReconfirmed,
      addressUpdated: receipt.addressUpdated,
      incomeUpdated: receipt.incomeUpdated,
      restrictionLifted: receipt.restrictionLifted,
      noDocumentUploadRequired: receipt.noDocumentUploadRequired,
      updatedAddress: receipt.updatedAddress,
      updatedIncome: receipt.updatedIncome,
      completedAt: receipt.completedAt,
    };
    session.activeFlowCard = card;

    this.addAudit(
      session,
      'ZENBANK_CORE',
      'PROFILE_UPDATED',
      `Actualizare ZenBank aplicată după confirmare (identityReconfirmed=${receipt.identityReconfirmed}, addressUpdated=${receipt.addressUpdated}, incomeUpdated=${receipt.incomeUpdated}, restrictionLifted=${receipt.restrictionLifted}).`,
    );

    if (session.flowChannel !== 'profile') {
      this.addMessage(session, 'agent', 'Datele tale ZenBank sunt acum actualizate.', card);
    }

    return this.getPublicState(sessionId);
  }

  switchScenario(
    sessionId: string,
    customerId: CustomerId,
    scenario: DemoScenario,
  ): SessionPublicState {
    const fresh = this.createInitialSession(sessionId, customerId, scenario);
    this.sessions.set(sessionId, fresh);
    return this.getPublicState(sessionId);
  }

  resetSession(sessionId: string): SessionPublicState {
    const current = this.sessions.get(sessionId);
    const customerId = current?.customer.id ?? 'radu';
    const scenario = current?.scenario ?? 'data_update';
    const fresh = this.createInitialSession(sessionId, customerId, scenario);
    this.sessions.set(sessionId, fresh);
    return this.getPublicState(sessionId);
  }

  async simulateUnhappy(
    sessionId: string,
    kind: 'DECLINED' | 'WITHHELD_ADDRESS' | 'EXPIRED' | 'WALLET_ERROR',
  ): Promise<SessionPublicState> {
    const session = this.getSessionInternal(sessionId);
    const txId = session.activeVerification?.transactionId ?? `sim-${crypto.randomUUID()}`;

    if (this.deps.verifierClient instanceof MockVerifierClient && session.activeVerification) {
      await this.deps.verifierClient.approveTransaction(txId, kind);
      return await this.pollVerification(sessionId, txId);
    }

    if (kind === 'WITHHELD_ADDRESS') {
      const evaluation = evaluateVerificationResult({
        customer: session.customer,
        payload: {
          schema: 'eudi-verification-result/v1',
          transactionId: txId,
          outcome: {
            status: 'SATISFIED',
            basis: 'DISCLOSURE',
            withheld: ['address.formatted', 'monthly_income'],
          },
          credentials: [
            {
              type: 'PID_RO_SANDBOX',
              format: 'dc+sd-jwt',
              documentType: 'urn:banking40:sandbox:pid-ro:1',
              claims: {
                given_name: session.customer.givenName,
                family_name: session.customer.familyName,
                birthdate: session.customer.birthdate,
              },
              checks: {
                issuerSignature: true,
                holderBinding: true,
                validity: true,
                trustedIssuer: true,
                status: 'NOT_CHECKED',
              },
            },
          ],
        },
        cryptoChecks: [
          {
            id: 'simulation_notice',
            label: 'Eveniment simulat (Demo)',
            status: 'INFO',
            detail: '[Simulare Demo] Răspuns generat fără partajarea atributelor de adresă și venit.',
          },
        ],
        acknowledged: true,
      });
      this.applyEvaluationToSession(session, txId, evaluation, true);
      return this.getPublicState(sessionId);
    }

    this.handleTerminalErrorStatus(session, kind);
    if (session.activeFlowCard?.type === 'recovery') {
      session.activeFlowCard.simulated = true;
      session.activeFlowCard.title = `[Simulare Demo] ${session.activeFlowCard.title}`;
    }
    const lastMsg = session.messages[session.messages.length - 1];
    if (session.flowChannel !== 'profile' && lastMsg?.card?.type === 'recovery' && !lastMsg.card.simulated) {
      lastMsg.card.simulated = true;
      lastMsg.card.title = `[Simulare Demo] ${lastMsg.card.title}`;
    }
    return this.getPublicState(sessionId);
  }
}
