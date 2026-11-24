export type CustomerId = 'radu' | 'alex' | 'maria';
export type DemoScenario = 'data_update' | 'payment_restricted';
export type KycStatus = 'RECONFIRMATION_NEEDED' | 'INCOMPLETE_UPDATE' | 'UP_TO_DATE';
export type VerificationScope = 'full' | 'address' | 'income';
export type VerificationLaunchMode = 'cross_device' | 'same_device_native' | 'same_device_web';
export type AgentStage =
  | 'IDLE'
  | 'PRE_CONSENT'
  | 'AWAITING_WALLET'
  | 'DIFF_READY'
  | 'COMPLETED'
  | 'DECLINED'
  | 'BLOCKED';

export type FlowChannel = 'profile' | 'chat';

export interface StructuredAddress {
  streetAddress: string;
  locality: string;
  postalCode: string;
  country: string;
  formatted: string;
}

export interface KycIncomeProfile {
  source: string;
  employer: string;
  bracket: string;
  basisLabel: string;
}

export interface ZenBankCustomerProfile {
  id: CustomerId;
  givenName: string;
  familyName: string;
  birthdate: string;
  citizenshipLabel: string;
  documentType: 'IDENTITY_DOCUMENT';
  documentNumberMasked: string;
  currentAddress: StructuredAddress;
  currentIncome: KycIncomeProfile;
  kycStatus: KycStatus;
  paymentRestricted: boolean;
  restrictionReason: string | null;
  lastReconfirmedAt: string | null;
  addressVerified?: boolean;
  incomeVerified?: boolean;
}

export interface TrustCheckItem {
  id: string;
  label: string;
  status: 'PASS' | 'FAIL' | 'WARN' | 'INFO';
  detail: string;
}

export interface AddressFieldDiff {
  field: 'streetAddress' | 'locality' | 'postalCode' | 'country';
  label: string;
  currentValue: string;
  verifiedValue: string;
  changed: boolean;
}

export interface AddressDiff {
  hasChanges: boolean;
  changedFields: Array<'streetAddress' | 'locality' | 'postalCode' | 'country'>;
  fields: AddressFieldDiff[];
}

export interface IncomeFieldDiff {
  field: 'source' | 'employer' | 'bracket';
  label: string;
  currentValue: string;
  verifiedValue: string;
  changed: boolean;
}

export interface IncomeDiff {
  hasChanges: boolean;
  changedFields: Array<'source' | 'employer' | 'bracket'>;
  fields: IncomeFieldDiff[];
}

export type ChatCard =
  | {
      type: 'pre_consent';
      scope?: VerificationScope;
      profileCode?: string;
      purpose: string;
      requestedCredentials: Array<{
        credential: string;
        vct: string;
        attributes: string[];
        why: string;
      }>;
      excludedItems: string[];
    }
  | {
      type: 'wallet_qr';
      transactionId: string;
      profileCode: string;
      sameDevice?: boolean;
      qrSvg: string;
      deepLink: string;
      expiresAt: string;
      status: string;
    }
  | {
      type: 'diff_confirm';
      pendingUpdateId: string;
      scope?: VerificationScope;
      profileCode?: string;
      identityMatched: boolean;
      identityName: string;
      identityBirthdate: string;
      currentAddress: StructuredAddress;
      verifiedAddress: StructuredAddress | null;
      addressDiff: AddressDiff | null;
      currentIncome: KycIncomeProfile;
      verifiedIncome: KycIncomeProfile | null;
      incomeDiff: IncomeDiff | null;
      withheldFields: string[];
      canUpdateAddress: boolean;
      canUpdateIncome: boolean;
      canConfirmIdentityOnly: boolean;
      revocationNote: string;
      warningNote?: string;
    }
  | {
      type: 'completed';
      scope?: VerificationScope;
      profileCode?: string;
      identityReconfirmed: boolean;
      addressUpdated: boolean;
      incomeUpdated: boolean;
      restrictionLifted: boolean;
      noDocumentUploadRequired: boolean;
      updatedAddress: StructuredAddress;
      updatedIncome: KycIncomeProfile;
      completedAt: string;
    }
  | {
      type: 'recovery';
      code: string;
      title: string;
      detail: string;
      simulated: boolean;
      canRetryEudi: boolean;
      canConfirmIdentityOnly: boolean;
      pendingUpdateId?: string;
      suggestedFallbackScope?: VerificationScope;
      fallbackOptions: string[];
    };

export interface AccountCheckItem {
  id: 'identity' | 'address' | 'income' | 'payments';
  label: string;
  status: 'OK' | 'ACTION_REQUIRED' | 'BLOCKED';
  summary: string;
}

export interface AccountStatusCheck {
  checkedAt: string;
  dataUpdateRequired: boolean;
  paymentRestricted: boolean;
  kycStatus: KycStatus;
  eudiRouteAvailable: boolean;
  missingItems: string[];
  checks: AccountCheckItem[];
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'agent';
  text: string;
  timestamp: string;
  accountCheck?: AccountStatusCheck;
  card?: ChatCard;
}

export interface AuditEvent {
  id: string;
  timestamp: string;
  category: 'ZENBANK_CORE' | 'AGENT' | 'VERIFIER' | 'CRYPTO' | 'RULES' | 'SIMULATION';
  action: string;
  detail: string;
  piiStored: false;
}

export interface ZeroPiiAgentContext {
  stage: AgentStage;
  documentOnFile: 'IDENTITY_DOCUMENT';
  kycStatus: KycStatus;
  paymentRestricted: boolean;
  restrictionCode: 'NONE' | 'KYC_UPDATE_INCOMPLETE';
  dataUpdateRequired: boolean;
  missingItems: string[];
  requestedCredentials: Array<'PID' | 'ADDRESS' | 'INCOME'>;
  selectedScope?: VerificationScope;
  selectedProfileCode?: string;
  verificationSummary?: {
    identityMatched: boolean;
    changedFields: Array<'address' | 'income'>;
    withheldFields: string[];
    revocationStatus: string;
  };
  unhappyCode?: string;
  language: 'ro';
}

export interface SessionPublicState {
  sessionId: string;
  scenario: DemoScenario;
  stage: AgentStage;
  flowChannel: FlowChannel | null;
  selectedScope?: VerificationScope;
  selectedProfileCode?: string;
  activeFlowCard: ChatCard | null;
  customer: ZenBankCustomerProfile;
  messages: ChatMessage[];
  activeVerification: {
    transactionId: string;
    status: string;
    sameDevice?: boolean;
    expiresAt: string;
  } | null;
  lastTrustChecks: TrustCheckItem[];
  lastZeroPiiContext: ZeroPiiAgentContext | null;
  lastLlmMeta: { usedGemini: boolean; model: string; fallbackReason?: string } | null;
  auditLog: AuditEvent[];
  securityBadges: {
    llmPiiExposed: false;
    geminiStoreEnabled: false;
    rawTokensLogged: false;
  };
}

export interface HealthResponse {
  ok: boolean;
  verifierMode: 'live' | 'mock';
  profileCode: string;
  resultKeyLoaded: boolean;
  geminiConfigured: boolean;
  geminiModel?: string;
  webReturnUriConfigured?: boolean;
  nativeReturnUriConfigured?: boolean;
}
