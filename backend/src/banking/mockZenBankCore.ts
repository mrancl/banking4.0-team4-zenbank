import type {
  AccountCheckItem,
  AccountStatusCheck,
  CustomerId,
  DemoScenario,
  KycIncomeProfile,
  StructuredAddress,
  VerificationScope,
  ZenBankCustomerProfile,
} from '../types.js';

const ADDRESS_A: StructuredAddress = {
  streetAddress: 'Bulevardul Unirii 22',
  locality: 'București',
  postalCode: '030133',
  country: 'România',
  formatted: 'Bulevardul Unirii 22, 030133 București, România',
};

const MARIA_ADDRESS: StructuredAddress = {
  streetAddress: 'Calea Victoriei 114',
  locality: 'București',
  postalCode: '010093',
  country: 'România',
  formatted: 'Calea Victoriei 114, 010093 București, România',
};

const DEFAULT_INCOME: KycIncomeProfile = {
  source: 'Salariu',
  employer: 'Nedeclarat / Necesită actualizare',
  bracket: '10.000 – 15.000 RON / lună',
  basisLabel: 'Declarat anterior (neverificat)',
};

const MARIA_INCOME: KycIncomeProfile = {
  source: 'Salariu',
  employer: 'Companie anterioară SRL',
  bracket: '10.000 – 15.000 RON / lună',
  basisLabel: 'Declarat anterior (neverificat)',
};

const PAYMENT_RESTRICTION_REASON =
  'Actualizarea datelor personale este incompletă — este necesară reconfirmarea identității pentru ridicarea restricției pe plăți.';

/**
 * Creates a fresh deep-cloned ZenBank customer record for a demo session and scenario.
 */
export function createSeedCustomer(
  customerId: CustomerId,
  scenario: DemoScenario,
): ZenBankCustomerProfile {
  const kycStatus = scenario === 'payment_restricted' ? 'INCOMPLETE_UPDATE' : 'RECONFIRMATION_NEEDED';
  const paymentRestricted = scenario === 'payment_restricted';
  const restrictionReason = paymentRestricted ? PAYMENT_RESTRICTION_REASON : null;

  if (customerId === 'maria') {
    return {
      id: 'maria',
      givenName: 'MARIA',
      familyName: 'IONESCU',
      birthdate: '1988-03-10',
      citizenshipLabel: 'Cetățean UE',
      documentType: 'IDENTITY_DOCUMENT',
      documentNumberMasked: 'EU••••7319',
      currentAddress: { ...MARIA_ADDRESS },
      currentIncome: { ...MARIA_INCOME },
      kycStatus,
      paymentRestricted,
      restrictionReason,
      lastReconfirmedAt: null,
      addressVerified: false,
      incomeVerified: false,
    };
  }

  if (customerId === 'alex') {
    return {
      id: 'alex',
      givenName: 'ALEX',
      familyName: 'POPESCU',
      birthdate: '1990-05-15',
      citizenshipLabel: 'Cetățean UE',
      documentType: 'IDENTITY_DOCUMENT',
      documentNumberMasked: 'EU••••5190',
      currentAddress: { ...ADDRESS_A },
      currentIncome: { ...DEFAULT_INCOME },
      kycStatus,
      paymentRestricted,
      restrictionReason,
      lastReconfirmedAt: null,
      addressVerified: false,
      incomeVerified: false,
    };
  }

  return {
    id: 'radu',
    givenName: 'RADU',
    familyName: 'STAN',
    birthdate: '1986-06-08',
    citizenshipLabel: 'Cetățean UE',
    documentType: 'IDENTITY_DOCUMENT',
    documentNumberMasked: 'EU••••4821',
    currentAddress: { ...ADDRESS_A },
    currentIncome: { ...DEFAULT_INCOME },
    kycStatus,
    paymentRestricted,
    restrictionReason,
    lastReconfirmedAt: null,
    addressVerified: false,
    incomeVerified: false,
  };
}

export interface ProfileUpdateReceipt {
  identityReconfirmed: boolean;
  addressUpdated: boolean;
  incomeUpdated: boolean;
  restrictionLifted: boolean;
  noDocumentUploadRequired: true;
  updatedAddress: StructuredAddress;
  updatedIncome: KycIncomeProfile;
  completedAt: string;
}

/**
 * Simulated ZenBank Customer Profile API update.
 * Executed ONLY after deterministic validation AND explicit customer confirmation.
 */
export function applyZenBankProfileUpdate(
  customer: ZenBankCustomerProfile,
  opts: {
    updateAddress: boolean;
    verifiedAddress: StructuredAddress | null;
    updateIncome: boolean;
    verifiedIncome: KycIncomeProfile | null;
    scope?: VerificationScope;
    identityVerified?: boolean;
    partialDueToExpiry?: boolean;
  },
): ProfileUpdateReceipt {
  const completedAt = new Date().toISOString();
  const wasRestricted = customer.paymentRestricted;
  const identityReconfirmed = opts.identityVerified ?? (!opts.scope || opts.scope === 'full');

  const addressUpdated = Boolean(opts.updateAddress && opts.verifiedAddress);
  if (addressUpdated && opts.verifiedAddress) {
    customer.currentAddress = { ...opts.verifiedAddress };
    customer.addressVerified = true;
  }

  const incomeUpdated = Boolean(opts.updateIncome && opts.verifiedIncome);
  if (incomeUpdated && opts.verifiedIncome) {
    customer.currentIncome = { ...opts.verifiedIncome };
    customer.incomeVerified = true;
  }

  if (identityReconfirmed) {
    customer.lastReconfirmedAt = completedAt;
  }

  const isFullScope = !opts.scope || opts.scope === 'full';
  const allPartialComplete =
    Boolean(customer.addressVerified) && Boolean(customer.incomeVerified);

  if ((isFullScope && !opts.partialDueToExpiry) || allPartialComplete) {
    customer.kycStatus = 'UP_TO_DATE';
    customer.paymentRestricted = false;
    customer.restrictionReason = null;
  } else if (opts.partialDueToExpiry) {
    customer.kycStatus = 'INCOMPLETE_UPDATE';
  }

  return {
    identityReconfirmed,
    addressUpdated,
    incomeUpdated,
    restrictionLifted: wasRestricted && !customer.paymentRestricted,
    noDocumentUploadRequired: true,
    updatedAddress: { ...customer.currentAddress },
    updatedIncome: { ...customer.currentIncome },
    completedAt,
  };
}

/**
 * Inspects a customer's current ZenBank profile to determine whether identity reconfirmation,
 * address verification, or income update is required (and whether payments are blocked).
 */
export function checkCustomerAccountStatus(customer: ZenBankCustomerProfile): AccountStatusCheck {
  const isUpToDate = customer.kycStatus === 'UP_TO_DATE';
  const identityOk = isUpToDate || Boolean(customer.lastReconfirmedAt);
  const addressOk = isUpToDate || Boolean(customer.addressVerified);
  const employerLower = customer.currentIncome.employer.toLowerCase();
  const basisLower = customer.currentIncome.basisLabel.toLowerCase();
  const incomeOk =
    Boolean(customer.incomeVerified) ||
    (isUpToDate &&
      !employerLower.includes('nedeclarat') &&
      !employerLower.includes('necesită actualizare') &&
      !basisLower.includes('neverificat'));

  const missingItems: string[] = [];
  if (!identityOk) missingItems.push('Reconfirmare identitate');
  if (!addressOk) missingItems.push('Verificare adresă');
  if (!incomeOk) missingItems.push('Actualizare venit și angajator');

  const dataUpdateRequired = missingItems.length > 0 || customer.paymentRestricted;

  const checks: AccountCheckItem[] = [
    {
      id: 'identity',
      label: 'Identitate',
      status: identityOk ? 'OK' : 'ACTION_REQUIRED',
      summary: identityOk ? 'Reconfirmată' : 'Necesită reconfirmare',
    },
    {
      id: 'address',
      label: 'Adresă',
      status: addressOk ? 'OK' : 'ACTION_REQUIRED',
      summary: addressOk ? 'Verificată și la zi' : 'Necesită verificare',
    },
    {
      id: 'income',
      label: 'Venit și angajator',
      status: incomeOk ? 'OK' : 'ACTION_REQUIRED',
      summary: incomeOk ? 'Verificat' : 'Angajator și venit neverificate',
    },
    {
      id: 'payments',
      label: 'Plăți și transferuri',
      status: customer.paymentRestricted
        ? 'BLOCKED'
        : dataUpdateRequired
          ? 'ACTION_REQUIRED'
          : 'OK',
      summary: customer.paymentRestricted
        ? 'Blocate temporar până la actualizare'
        : dataUpdateRequired
          ? 'Active, dar profilul necesită actualizare'
          : 'Active, fără restricții',
    },
  ];

  return {
    checkedAt: new Date().toISOString(),
    dataUpdateRequired,
    paymentRestricted: customer.paymentRestricted,
    kycStatus: customer.kycStatus,
    eudiRouteAvailable: true,
    missingItems,
    checks,
  };
}

/**
 * Automatically activates the blocked-payments state when a customer asks about payments
 * while their ZenBank profile still requires a data update / identity reconfirmation.
 */
export function activatePaymentRestrictionIfUpdateNeeded(
  customer: ZenBankCustomerProfile,
): boolean {
  const status = checkCustomerAccountStatus(customer);
  if (!status.dataUpdateRequired) {
    return false;
  }

  if (!customer.paymentRestricted) {
    customer.paymentRestricted = true;
    customer.kycStatus = 'INCOMPLETE_UPDATE';
    customer.restrictionReason = PAYMENT_RESTRICTION_REASON;
  }
  return true;
}
