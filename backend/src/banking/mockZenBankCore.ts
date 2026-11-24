import type {
  CustomerId,
  DemoScenario,
  KycIncomeProfile,
  StructuredAddress,
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
  'Actualizarea datelor clientului este incompletă — este necesară reconfirmarea identității pentru pașaportul înregistrat pentru ridicarea restricției pe plăți.';

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
      citizenshipLabel: 'Cetățean UE · Identificat cu pașaport',
      documentType: 'EU_PASSPORT',
      documentNumberMasked: 'EU••••7319',
      currentAddress: { ...MARIA_ADDRESS },
      currentIncome: { ...MARIA_INCOME },
      kycStatus,
      paymentRestricted,
      restrictionReason,
      lastReconfirmedAt: null,
    };
  }

  if (customerId === 'alex') {
    return {
      id: 'alex',
      givenName: 'ALEX',
      familyName: 'POPESCU',
      birthdate: '1990-05-15',
      citizenshipLabel: 'Cetățean UE · Identificat cu pașaport',
      documentType: 'EU_PASSPORT',
      documentNumberMasked: 'EU••••5190',
      currentAddress: { ...ADDRESS_A },
      currentIncome: { ...DEFAULT_INCOME },
      kycStatus,
      paymentRestricted,
      restrictionReason,
      lastReconfirmedAt: null,
    };
  }

  return {
    id: 'radu',
    givenName: 'RADU',
    familyName: 'STAN',
    birthdate: '1986-06-08',
    citizenshipLabel: 'Cetățean UE · Identificat cu pașaport',
    documentType: 'EU_PASSPORT',
    documentNumberMasked: 'EU••••4821',
    currentAddress: { ...ADDRESS_A },
    currentIncome: { ...DEFAULT_INCOME },
    kycStatus,
    paymentRestricted,
    restrictionReason,
    lastReconfirmedAt: null,
  };
}

export interface ProfileUpdateReceipt {
  identityReconfirmed: boolean;
  addressUpdated: boolean;
  incomeUpdated: boolean;
  restrictionLifted: boolean;
  noPassportUploadRequired: true;
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
  },
): ProfileUpdateReceipt {
  const completedAt = new Date().toISOString();
  const wasRestricted = customer.paymentRestricted;

  const addressUpdated = Boolean(opts.updateAddress && opts.verifiedAddress);
  if (addressUpdated && opts.verifiedAddress) {
    customer.currentAddress = { ...opts.verifiedAddress };
  }

  const incomeUpdated = Boolean(opts.updateIncome && opts.verifiedIncome);
  if (incomeUpdated && opts.verifiedIncome) {
    customer.currentIncome = { ...opts.verifiedIncome };
  }

  customer.kycStatus = 'UP_TO_DATE';
  customer.paymentRestricted = false;
  customer.restrictionReason = null;
  customer.lastReconfirmedAt = completedAt;

  return {
    identityReconfirmed: true,
    addressUpdated,
    incomeUpdated,
    restrictionLifted: wasRestricted,
    noPassportUploadRequired: true,
    updatedAddress: { ...customer.currentAddress },
    updatedIncome: { ...customer.currentIncome },
    completedAt,
  };
}
