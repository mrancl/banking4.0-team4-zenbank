import crypto from 'node:crypto';
import { applyZenBankProfileUpdate, createSeedCustomer } from '../banking/mockZenBankCore.js';
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
  AgentStage,
  AuditEvent,
  BankRuleEvaluation,
  ChatCard,
  ChatMessage,
  CustomerId,
  DemoScenario,
  KycIncomeProfile,
  Language,
  SessionPublicState,
  StructuredAddress,
  TrustCheckItem,
  ZenBankCustomerProfile,
  ZeroPiiAgentContext,
} from '../types.js';
import { ZeroPiiAssistant, buildZeroPiiContext } from './geminiAssistant.js';

interface ActiveVerification {
  transactionId: string;
  profileCode: string;
  status: string;
  expiresAt: string;
  deepLink: string;
  qrSvg: string;
}

interface PendingUpdate {
  id: string;
  transactionId: string;
  verifiedAddress: StructuredAddress | null;
  verifiedIncome: KycIncomeProfile | null;
  canUpdateAddress: boolean;
  canUpdateIncome: boolean;
  canConfirmIdentityOnly: boolean;
}

interface SessionInternal {
  sessionId: string;
  scenario: DemoScenario;
  stage: AgentStage;
  language: Language;
  customer: ZenBankCustomerProfile;
  messages: ChatMessage[];
  activeVerification: ActiveVerification | null;
  pendingUpdate: PendingUpdate | null;
  lastEvaluation: BankRuleEvaluation | null;
  lastTrustChecks: TrustCheckItem[];
  lastZeroPiiContext: ZeroPiiAgentContext | null;
  auditLog: AuditEvent[];
}

export interface OrchestratorDeps {
  verifierClient: VerifierClient;
  jwks: JwksResolver;
  assistant: ZeroPiiAssistant;
  issuer: string;
  audience: string;
  profileCode: string;
  privateKeyPem: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function buildPreConsentCard(): ChatCard {
  return {
    type: 'pre_consent',
    purpose: 'Actualizarea datelor client ZenBank',
    requestedCredentials: [
      {
        credential: 'Identitate verificată (PID)',
        vct: 'urn:banking40:sandbox:pid-ro:1',
        attributes: ['given_name', 'family_name', 'birthdate'],
        why: 'Reconfirmă identitatea asociată pașaportului tău UE înregistrat la ZenBank.',
      },
      {
        credential: 'Adresă verificată',
        vct: 'urn:banking40:sandbox:address:1',
        attributes: ['address.formatted'],
        why: 'Verifică dacă adresa de domiciliu s-a schimbat înainte de actualizarea ZenBank.',
      },
      {
        credential: 'Sursă venit și angajator',
        vct: 'urn:banking40:sandbox:income:1',
        attributes: ['income_type', 'payer.legal_name', 'monthly_income.periods (tranșă KYC)'],
        why: 'Actualizează sursa fondurilor și angajatorul conform obligațiilor KYC (Legea 129/2019).',
      },
    ],
    excludedItems: [
      'CNP (personal_numeric_code) și locul nașterii — ignorate de regulile ZenBank',
      'Sumele lunare brute — ZenBank reține doar tranșa KYC agregată',
      'Încărcarea de poze/PDF-uri după pașaport, facturi sau adeverință de venit',
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
        ? 'Bine ai revenit în ZenBank. Contul tău are momentan o restricție pe plățile efectuate din cauza unei actualizări incomplete de date. Întreabă „De ce nu pot face plăți?” sau alege o acțiune rapidă din stânga.'
        : 'Bine ai venit în ZenBank. Profilul tău este înregistrat cu pașaport UE. Îți poți actualiza adresa, sursa de venit și reconfirmarea identității digital prin EUDI Wallet — fără să încarci documente.';

    return {
      sessionId,
      scenario,
      stage: 'IDLE',
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
  ): void {
    session.messages.push({
      id: crypto.randomUUID(),
      role,
      text,
      timestamp: nowIso(),
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
            expiresAt: s.activeVerification.expiresAt,
          }
        : null,
      lastTrustChecks: s.lastTrustChecks,
      lastZeroPiiContext: s.lastZeroPiiContext,
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
  ): Promise<SessionPublicState> {
    const session = this.getSessionInternal(sessionId);
    const trimmed = message.trim();
    if (!trimmed) {
      return this.getPublicState(sessionId);
    }

    this.addMessage(session, 'user', trimmed);

    const reply = await this.deps.assistant.respond({
      userMessage: trimmed,
      quickAction,
      customer: session.customer,
      stage: session.stage,
      evaluation: session.lastEvaluation,
      extraForbiddenPii: this.extraForbiddenPii(session),
    });

    session.language = reply.zeroPiiContext.language;
    session.lastZeroPiiContext = reply.zeroPiiContext;

    if (reply.hadPiiInInput) {
      this.addAudit(
        session,
        'AGENT',
        'USER_INPUT_PII_SCRUBBED',
        'Datele personale au fost anonimizate din mesajul utilizatorului înainte de apelul LLM.',
      );
    }

    let card: ChatCard | undefined;
    if (reply.intent === 'START_DATA_UPDATE') {
      session.stage = 'PRE_CONSENT';
      card = buildPreConsentCard();
      this.addAudit(
        session,
        'AGENT',
        'PRE_CONSENT_PREPARED',
        `Evaluat context ZenBank (document=${session.customer.documentType}, kyc=${session.customer.kycStatus}); pregătită cererea minimă PID + Adresă + Venit.`,
      );
    } else if (reply.intent === 'EXPLAIN_PAYMENT_RESTRICTION') {
      if (session.customer.paymentRestricted) {
        session.stage = 'PRE_CONSENT';
        card = buildPreConsentCard();
        this.addAudit(
          session,
          'AGENT',
          'RESTRICTION_DIAGNOSED',
          'Identificată actualizare KYC incompletă care blochează plățile; client direcționat în același flux EUDI.',
        );
      } else {
        this.addAudit(
          session,
          'AGENT',
          'RESTRICTION_CHECKED',
          'Confirmat că plățile efectuate sunt active.',
        );
      }
    } else if (reply.intent === 'CANCEL') {
      session.stage = 'IDLE';
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
      language: session.language,
    });

    this.addMessage(session, 'agent', reply.reply, card);
    return this.getPublicState(sessionId);
  }

  async startVerification(sessionId: string): Promise<SessionPublicState> {
    const session = this.getSessionInternal(sessionId);
    const started = await this.deps.verifierClient.startVerification(this.deps.profileCode);

    session.stage = 'AWAITING_WALLET';
    session.pendingUpdate = null;
    session.activeVerification = {
      transactionId: started.transactionId,
      profileCode: this.deps.profileCode,
      status: 'CREATED',
      expiresAt: started.expiresAt,
      deepLink: started.deepLink,
      qrSvg: started.qrSvg,
    };

    session.lastZeroPiiContext = buildZeroPiiContext({
      stage: session.stage,
      customer: session.customer,
      language: session.language,
    });

    this.addAudit(
      session,
      'VERIFIER',
      'VERIFICATION_STARTED',
      `Creată verificare cross-device pentru profilul=${this.deps.profileCode}.`,
    );

    const text =
      'Scanează codul QR cu EUDI Wallet (sau deschide link-ul în emulator) și aprobă partajarea pentru PID, Adresă și Atestarea de venit.';

    this.addMessage(session, 'agent', text, {
      type: 'wallet_qr',
      transactionId: started.transactionId,
      profileCode: this.deps.profileCode,
      qrSvg: started.qrSvg,
      deepLink: started.deepLink,
      expiresAt: started.expiresAt,
      status: 'CREATED',
    });

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

    if (statusResp.status === 'CREATED' || statusResp.status === 'REQUEST_RETRIEVED') {
      return this.getPublicState(sessionId);
    }

    if (
      statusResp.status === 'DECLINED' ||
      statusResp.status === 'WALLET_ERROR' ||
      statusResp.status === 'EXPIRED'
    ) {
      this.handleTerminalErrorStatus(session, statusResp.status, statusResp.reason ?? statusResp.walletError ?? undefined);
      return this.getPublicState(sessionId);
    }

    if (statusResp.status !== 'COMPLETED') {
      return this.getPublicState(sessionId);
    }

    const fetched = await this.deps.verifierClient.fetchSealedResult(transactionId);
    if (fetched.kind === 'not_ready') {
      return this.getPublicState(sessionId);
    }
    if (fetched.kind === 'gone' || fetched.kind === 'not_sealed') {
      this.handleTerminalErrorStatus(session, fetched.code, fetched.message);
      return this.getPublicState(sessionId);
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
      return this.getPublicState(sessionId);
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
      return this.getPublicState(sessionId);
    }

    let acknowledged = false;
    try {
      acknowledged = await this.deps.verifierClient.acknowledgeResult(transactionId);
    } catch {
      acknowledged = false;
    }

    const evaluation = evaluateVerificationResult({
      customer: session.customer,
      payload: cryptoResult.payload,
      cryptoChecks: cryptoResult.checks,
      acknowledged,
    });

    this.applyEvaluationToSession(session, transactionId, evaluation, false);
    return this.getPublicState(sessionId);
  }

  private applyEvaluationToSession(
    session: SessionInternal,
    transactionId: string,
    evaluation: BankRuleEvaluation,
    simulated: boolean,
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
        verifiedAddress: evaluation.verifiedAddress,
        verifiedIncome: evaluation.verifiedIncome,
        canUpdateAddress: evaluation.canConfirmAddressUpdate,
        canUpdateIncome: evaluation.canConfirmIncomeUpdate,
        canConfirmIdentityOnly: evaluation.canConfirmIdentityOnly,
      };
      session.stage = 'DIFF_READY';

      this.addAudit(
        session,
        simulated ? 'SIMULATION' : 'RULES',
        `EVALUATION_${evaluation.decision}`,
        `Identitate confirmată cu clientul ZenBank; decizie=${evaluation.decision}; se așteaptă confirmarea explicită.`,
      );

      if (evaluation.decision === 'PARTIAL_IDENTITY_ONLY') {
        const card: ChatCard = {
          type: 'recovery',
          code: evaluation.reasonCode,
          title: 'Identitate verificată · Date suplimentare nepartajate',
          detail: evaluation.message,
          simulated,
          canRetryEudi: true,
          canConfirmIdentityOnly: true,
          pendingUpdateId: pendingId,
          fallbackOptions: [
            'Confirmă doar reconfirmarea identității (păstrează datele curente din ZenBank)',
            'Reîncearcă în EUDI Wallet și aprobă partajarea adresei și venitului',
          ],
        };
        this.addMessage(session, 'agent', evaluation.message, card);
      } else {
        const hasAnyUpdate =
          Boolean(evaluation.addressDiff?.hasChanges) || Boolean(evaluation.incomeDiff?.hasChanges);
        const promptText = hasAnyUpdate
          ? `${evaluation.message}\n\nVrei să actualizez profilul tău ZenBank cu aceste date verificate?`
          : evaluation.message;

        const revocationNote =
          evaluation.revocationStatus === 'VALID'
            ? 'Status revocare: VALID.'
            : `Status revocare: ${evaluation.revocationStatus} (sandbox) — actualizarea instantanee este permisă doar pentru adresa și sursa de venit a aceleiași persoane.`;

        const card: ChatCard = {
          type: 'diff_confirm',
          pendingUpdateId: pendingId,
          identityMatched: true,
          identityName: evaluation.verifiedIdentity
            ? `${evaluation.verifiedIdentity.givenName} ${evaluation.verifiedIdentity.familyName}`
            : `${session.customer.givenName} ${session.customer.familyName} (atestare PID verificată)`,
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
        };
        this.addMessage(session, 'agent', promptText, card);
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
      this.addMessage(session, 'agent', evaluation.message, {
        type: 'recovery',
        code: evaluation.reasonCode,
        title: 'Blocaj de securitate — Neconcordanță identitate',
        detail: evaluation.message,
        simulated,
        canRetryEudi: true,
        canConfirmIdentityOnly: false,
        fallbackOptions: [
          'Autentifică-te în contul ZenBank corespunzător sau folosește propriul EUDI Wallet',
          'Continuă printr-o sucursală ZenBank cu verificarea fizică a pașaportului',
        ],
      });
    } else {
      session.pendingUpdate = null;
      session.stage = 'DECLINED';
      this.addAudit(
        session,
        simulated ? 'SIMULATION' : 'RULES',
        `UNHAPPY_${evaluation.reasonCode}`,
        evaluation.message,
      );
      this.addMessage(session, 'agent', evaluation.message, {
        type: 'recovery',
        code: evaluation.reasonCode,
        title: 'Verificare nefinalizată',
        detail: evaluation.message,
        simulated,
        canRetryEudi: true,
        canConfirmIdentityOnly: false,
        fallbackOptions: [
          'Reîncearcă verificarea cu EUDI Wallet',
          'Încarcă pașaportul, dovada adresei și adeverința de venit sau programează o vizită în sucursală',
        ],
      });
    }

    session.lastZeroPiiContext = buildZeroPiiContext({
      stage: session.stage,
      customer: session.customer,
      evaluation,
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
          'Ai refuzat partajarea datelor în EUDI Wallet. Profilul tău ZenBank nu a fost modificat.',
      },
      EXPIRED: {
        title: 'Cererea de verificare a expirat',
        detail:
          'Cererea de verificare de 5 minute a expirat înainte de aprobare. Poți porni oricând o verificare nouă.',
      },
      WALLET_ERROR: {
        title: 'Eroare prezentare în wallet',
        detail:
          reason ||
          'Wallet-ul a întâmpinat o eroare la generarea prezentării. Poți reîncerca sau folosi fluxul standard cu documente.',
      },
      RESULT_GONE: {
        title: 'Rezultat verificare expirat',
        detail: 'Rezultatul verificării a fost deja preluat sau a expirat pe serverul de verificare.',
      },
      RESULT_NOT_SEALED: {
        title: 'Rezultat nesigilat de la Verifier',
        detail: 'Profilul de verificare nu a returnat un răspuns DISCLOSURE sigilat.',
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

    this.addAudit(session, 'VERIFIER', `STATUS_${statusCode}`, info.detail);
    this.addMessage(session, 'agent', info.detail, {
      type: 'recovery',
      code: statusCode,
      title: info.title,
      detail: info.detail,
      simulated: false,
      canRetryEudi: true,
      canConfirmIdentityOnly: false,
      fallbackOptions: [
        'Reîncearcă verificarea cu EUDI Wallet',
        'Continuă cu încărcarea manuală a pașaportului, dovezii de adresă și adeverinței de venit',
      ],
    });
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

    this.addAudit(session, 'CRYPTO', `CRYPTO_REJECTED_${err.code}`, err.message);
    this.addMessage(
      session,
      'agent',
      'ZenBank nu a putut valida criptografic răspunsul de verificare, astfel încât profilul tău nu a fost modificat.',
      {
        type: 'recovery',
        code: err.code,
        title: 'Validare criptografică eșuată',
        detail: err.message,
        simulated: false,
        canRetryEudi: true,
        canConfirmIdentityOnly: false,
        fallbackOptions: [
          'Pornește o nouă sesiune de verificare EUDI',
          'Folosește verificarea standard în sucursală ZenBank',
        ],
      },
    );
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

    const updateAddress =
      (opts.mode === 'UPDATE_PROFILE' || opts.mode === 'UPDATE_ADDRESS') &&
      pending.canUpdateAddress;
    const updateIncome = opts.mode === 'UPDATE_PROFILE' && pending.canUpdateIncome;

    const receipt = applyZenBankProfileUpdate(session.customer, {
      updateAddress,
      verifiedAddress: pending.verifiedAddress,
      updateIncome,
      verifiedIncome: pending.verifiedIncome,
    });

    session.pendingUpdate = null;
    session.stage = 'COMPLETED';
    session.lastZeroPiiContext = buildZeroPiiContext({
      stage: session.stage,
      customer: session.customer,
      evaluation: session.lastEvaluation,
      language: session.language,
    });

    this.addAudit(
      session,
      'ZENBANK_CORE',
      'PROFILE_UPDATED',
      `Actualizare ZenBank aplicată după confirmare (identityReconfirmed=${receipt.identityReconfirmed}, addressUpdated=${receipt.addressUpdated}, incomeUpdated=${receipt.incomeUpdated}, restrictionLifted=${receipt.restrictionLifted}).`,
    );

    this.addMessage(session, 'agent', 'Datele tale ZenBank sunt acum actualizate.', {
      type: 'completed',
      identityReconfirmed: receipt.identityReconfirmed,
      addressUpdated: receipt.addressUpdated,
      incomeUpdated: receipt.incomeUpdated,
      restrictionLifted: receipt.restrictionLifted,
      noPassportUploadRequired: receipt.noPassportUploadRequired,
      updatedAddress: receipt.updatedAddress,
      updatedIncome: receipt.updatedIncome,
      completedAt: receipt.completedAt,
    });

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
    const lastMsg = session.messages[session.messages.length - 1];
    if (lastMsg?.card?.type === 'recovery') {
      lastMsg.card.simulated = true;
      lastMsg.card.title = `[Simulare Demo] ${lastMsg.card.title}`;
    }
    return this.getPublicState(sessionId);
  }
}
