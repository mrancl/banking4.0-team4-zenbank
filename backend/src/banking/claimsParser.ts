import type {
  DecryptedVerificationPayload,
  IdentitySubject,
  KycIncomeProfile,
  PartialIdentitySubject,
  StructuredAddress,
  VerificationCredentialResult,
} from '../types.js';

export type CredentialKind = 'PID' | 'ADDRESS' | 'INCOME' | 'OTHER';

export interface CredentialValidityIssue {
  kind: CredentialKind;
  label: string;
  validUntil: string | null;
  reason: string;
}

export interface ParsedClaimsResult {
  pidIdentity: IdentitySubject | null;
  addressIdentity: IdentitySubject | null;
  incomeIdentity: IdentitySubject | null;
  pidSubject: PartialIdentitySubject | null;
  addressSubject: PartialIdentitySubject | null;
  incomeSubject: PartialIdentitySubject | null;
  verifiedAddress: StructuredAddress | null;
  verifiedIncome: KycIncomeProfile | null;
  revocationStatuses: string[];
  hasPidCredential: boolean;
  hasAddressCredential: boolean;
  hasIncomeCredential: boolean;
  pidHasLimitedAttestation: boolean;
  pidExpiryDate: string | null;
  ignoredPidFields: string[];
  ignoredRawFields: string[];
  integrityFailures: string[];
  hardIntegrityFailures: string[];
  validityIssues: CredentialValidityIssue[];
  credentialValidUntil: { pid?: string; address?: string; income?: string };
  integrityVerifiedCount: number;
  issuerAuthorities: string[];
}

const USED_PID_KEYS = new Set([
  'given_name',
  'family_name',
  'birthdate',
  'birth_date',
  'date_of_expiry',
  'date_of_issuance',
  'issuing_country',
]);

function readClaimRaw(
  claims: Record<string, unknown> | undefined,
  path: string,
): unknown {
  if (!claims) {
    return undefined;
  }
  if (path in claims && claims[path] !== undefined) {
    return claims[path];
  }
  const parts = path.split('.');
  let current: unknown = claims;
  for (const part of parts) {
    if (current && typeof current === 'object' && part in (current as Record<string, unknown>)) {
      current = (current as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return current;
}

function readClaimString(
  claims: Record<string, unknown> | undefined,
  path: string,
): string | null {
  const val = readClaimRaw(claims, path);
  if (typeof val === 'string' && val.trim()) {
    return val.trim();
  }
  return null;
}

function readClaimNumber(
  claims: Record<string, unknown> | undefined,
  path: string,
): number | null {
  const val = readClaimRaw(claims, path);
  if (typeof val === 'number' && Number.isFinite(val)) {
    return val;
  }
  return null;
}

function firstClaim(
  claims: Record<string, unknown> | undefined,
  candidates: string[],
): string | null {
  for (const candidate of candidates) {
    const val = readClaimString(claims, candidate);
    if (val) {
      return val;
    }
  }
  return null;
}

function isPidCredential(cred: VerificationCredentialResult): boolean {
  const doc = (cred.documentType ?? '').toLowerCase();
  const type = (cred.type ?? '').toLowerCase();
  return doc.includes(':pid') || type.includes('pid');
}

function isAddressCredential(cred: VerificationCredentialResult): boolean {
  const doc = (cred.documentType ?? '').toLowerCase();
  const type = (cred.type ?? '').toLowerCase();
  return doc.includes(':address') || type.includes('address');
}

function isIncomeCredential(cred: VerificationCredentialResult): boolean {
  const doc = (cred.documentType ?? '').toLowerCase();
  const type = (cred.type ?? '').toLowerCase();
  return doc.includes('income') || doc.includes('bri') || type.includes('income');
}

function parsePostalAndLocality(segment: string): { postalCode: string; locality: string } {
  const match = segment.match(/^(\d{4,10})\s+(.+)$/);
  if (match) {
    return { postalCode: match[1].trim(), locality: match[2].trim() };
  }
  return { postalCode: '', locality: segment.trim() };
}

function parseFormattedAddress(formatted: string): {
  streetAddress: string;
  locality: string;
  postalCode: string;
  country: string;
} {
  const parts = formatted
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);

  if (parts.length >= 3) {
    const { postalCode, locality } = parsePostalAndLocality(parts[1]);
    return {
      streetAddress: parts[0],
      locality,
      postalCode,
      country: parts.slice(2).join(', '),
    };
  }
  if (parts.length === 2) {
    const { postalCode, locality } = parsePostalAndLocality(parts[1]);
    return {
      streetAddress: parts[0],
      locality,
      postalCode,
      country: '',
    };
  }
  return {
    streetAddress: parts[0] ?? formatted.trim(),
    locality: '',
    postalCode: '',
    country: '',
  };
}

function extractIdentity(
  claims: Record<string, unknown> | undefined,
): IdentitySubject | null {
  const givenName = firstClaim(claims, ['given_name', 'subject.given_name', 'holder.given_name']);
  const familyName = firstClaim(claims, ['family_name', 'subject.family_name', 'holder.family_name']);
  const birthdate = firstClaim(claims, [
    'birthdate',
    'subject.birthdate',
    'birth_date',
    'subject.birth_date',
  ]);

  if (!givenName || !familyName || !birthdate) {
    return null;
  }
  return { givenName, familyName, birthdate };
}

function extractPartialIdentity(
  claims: Record<string, unknown> | undefined,
): PartialIdentitySubject | null {
  const givenName = firstClaim(claims, ['given_name', 'subject.given_name', 'holder.given_name']);
  const familyName = firstClaim(claims, ['family_name', 'subject.family_name', 'holder.family_name']);
  const birthdate = firstClaim(claims, [
    'birthdate',
    'subject.birthdate',
    'birth_date',
    'subject.birth_date',
  ]);
  const personalNumericCode = firstClaim(claims, [
    'personal_numeric_code',
    'subject.personal_numeric_code',
    'cnp',
    'subject.cnp',
    'national_id',
    'subject.national_id',
  ]);

  if (!givenName && !familyName && !birthdate && !personalNumericCode) {
    return null;
  }

  return {
    ...(givenName ? { givenName } : {}),
    ...(familyName ? { familyName } : {}),
    ...(birthdate ? { birthdate } : {}),
    ...(personalNumericCode ? { personalNumericCode } : {}),
  };
}

function buildFormattedAddress(
  streetAddress: string,
  locality: string,
  postalCode: string,
  country: string,
  fallbackFormatted?: string | null,
): string {
  const parts = [streetAddress, [postalCode, locality].filter(Boolean).join(' '), country]
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length > 0) {
    return parts.join(', ');
  }
  return fallbackFormatted?.trim() ?? '';
}

function extractAddress(claims: Record<string, unknown> | undefined): StructuredAddress | null {
  let streetAddress = firstClaim(claims, [
    'address.street_address',
    'street_address',
    'resident_street',
  ]);
  let locality = firstClaim(claims, ['address.locality', 'locality', 'resident_city']);
  let postalCode = firstClaim(claims, ['address.postal_code', 'postal_code', 'resident_postal_code']);
  let country = firstClaim(claims, ['address.country', 'country', 'resident_country']);
  const formattedRaw = firstClaim(claims, ['address.formatted', 'resident_address']);

  if (!streetAddress && !locality && !postalCode && !country && !formattedRaw) {
    return null;
  }

  if (!streetAddress && !locality && !postalCode && !country && formattedRaw) {
    const parsed = parseFormattedAddress(formattedRaw);
    streetAddress = parsed.streetAddress;
    locality = parsed.locality;
    postalCode = parsed.postalCode;
    country = parsed.country;
  }

  return {
    streetAddress: streetAddress ?? '',
    locality: locality ?? '',
    postalCode: postalCode ?? '',
    country: country ?? '',
    formatted:
      formattedRaw?.trim() ||
      buildFormattedAddress(
        streetAddress ?? '',
        locality ?? '',
        postalCode ?? '',
        country ?? '',
        formattedRaw,
      ),
  };
}

function formatIncomeType(rawType: string | null): string {
  const lower = (rawType ?? '').trim().toLowerCase();
  switch (lower) {
    case 'salary':
      return 'Salariu';
    case 'pension':
      return 'Pensie';
    case 'self_employed':
      return 'Activități independente';
    case 'dividends':
      return 'Dividende';
    default:
      return rawType?.trim() ? rawType.trim() : 'Venit declarat';
  }
}

function mapMonthlyAverageToBracket(avgMonthly: number, currency: string): string {
  if (avgMonthly < 5000) return `< 5.000 ${currency} / lună`;
  if (avgMonthly < 10000) return `5.000 – 10.000 ${currency} / lună`;
  if (avgMonthly < 15000) return `10.000 – 15.000 ${currency} / lună`;
  if (avgMonthly < 20000) return `15.000 – 20.000 ${currency} / lună`;
  if (avgMonthly < 30000) return `20.000 – 30.000 ${currency} / lună`;
  return `> 30.000 ${currency} / lună`;
}

function extractIncome(
  claims: Record<string, unknown> | undefined,
  ignoredRawFields: Set<string>,
): KycIncomeProfile | null {
  if (!claims) {
    return null;
  }

  // 1. Live sandbox monthly salary schema (monthly_income.*)
  const rawPeriods = readClaimRaw(claims, 'monthly_income.periods');
  const rawCurrency = firstClaim(claims, ['monthly_income.currency']);
  const rawIncomeType = firstClaim(claims, ['monthly_income.income_type']);
  const payerLegalName = firstClaim(claims, ['monthly_income.payer.legal_name']);

  if (Array.isArray(rawPeriods) || rawCurrency || rawIncomeType || payerLegalName) {
    const currency = rawCurrency || 'RON';
    const source = formatIncomeType(rawIncomeType);
    const employer = payerLegalName || 'Neconfirmat';

    const validEntries: Array<{ month: string; netMajor: number }> = [];
    if (Array.isArray(rawPeriods)) {
      for (const item of rawPeriods) {
        if (!item || typeof item !== 'object') continue;
        const rec = item as Record<string, unknown>;
        const minor = typeof rec.net_amount_minor === 'number' ? rec.net_amount_minor : null;
        const major = typeof rec.amount === 'number' ? rec.amount : null;
        const month = typeof rec.month === 'string' ? rec.month.trim() : '';
        if (minor !== null && Number.isFinite(minor)) {
          validEntries.push({ month, netMajor: minor / 100 });
        } else if (major !== null && Number.isFinite(major)) {
          validEntries.push({ month, netMajor: major });
        }
      }
      if (validEntries.length > 0) {
        ignoredRawFields.add('monthly_income.periods (sume lunare brute)');
      }
    }

    if (validEntries.length > 0) {
      const avg =
        validEntries.reduce((sum, entry) => sum + entry.netMajor, 0) / validEntries.length;
      const months = validEntries.map((e) => e.month).filter(Boolean).sort();
      const span =
        months.length >= 2
          ? `${months[0]} – ${months[months.length - 1]}`
          : months[0] ?? 'perioadă verificată';

      return {
        source,
        employer,
        bracket: mapMonthlyAverageToBracket(avg, currency),
        basisLabel: `Media pe ${validEntries.length} luni verificate (${span}); sumele lunare brute nu se stochează`,
      };
    }

    return {
      source,
      employer,
      bracket: `Confirmat (${currency})`,
      basisLabel: 'Sursă de venit verificată fără sume lunare detaliate',
    };
  }

  // 2. FIDES BRI annual tax-year schema (nl_bld_bri.income / nl_bld_bri.year)
  const annualIncome = readClaimNumber(claims, 'nl_bld_bri.income');
  const taxYear = readClaimNumber(claims, 'nl_bld_bri.year');
  if (annualIncome !== null) {
    const formattedAnnual = annualIncome.toLocaleString('ro-RO');
    const yearLabel = taxYear ?? 2025;
    return {
      source: 'Venit anual raportat fiscal',
      employer: 'Nespecificat (model fiscal anual FIDES BRI)',
      bracket: `${formattedAnnual} EUR / an fiscal ${yearLabel}`,
      basisLabel: 'Venit anual impozabil (nu salariu lunar net și nu dovadă angajare curentă)',
    };
  }

  return null;
}

function evaluateCredentialIntegrity(
  cred: VerificationCredentialResult,
  label: string,
  hardFailures: string[],
  authorities: Set<string>,
): boolean {
  if (cred.issuer?.authority?.trim()) {
    authorities.add(cred.issuer.authority.trim());
  }

  const checks = cred.checks;
  if (!checks) {
    return false;
  }

  const hardKeys: Array<'issuerSignature' | 'holderBinding' | 'trustedIssuer'> = [
    'issuerSignature',
    'holderBinding',
    'trustedIssuer',
  ];

  let allTruePresent = checks.validity === true;
  for (const key of hardKeys) {
    const val = checks[key];
    if (val === false) {
      hardFailures.push(`${label}.${key}=false`);
      allTruePresent = false;
    } else if (val !== true) {
      allTruePresent = false;
    }
  }
  return allTruePresent;
}

function collectCredentialValidityIssues(
  cred: VerificationCredentialResult,
  kind: CredentialKind,
  label: string,
  now: Date,
  issues: CredentialValidityIssue[],
): void {
  const validUntil = typeof cred.validUntil === 'string' && cred.validUntil.trim()
    ? cred.validUntil.trim()
    : null;
  const validFrom = typeof cred.validFrom === 'string' && cred.validFrom.trim()
    ? cred.validFrom.trim()
    : null;

  if (cred.checks?.validity === false) {
    issues.push({
      kind,
      label,
      validUntil,
      reason: `${label}.validity=false`,
    });
  }

  const nowMs = now.getTime();
  if (validUntil) {
    const untilMs = Date.parse(validUntil);
    if (Number.isFinite(untilMs) && untilMs <= nowMs) {
      issues.push({
        kind,
        label,
        validUntil,
        reason: `${label}.validUntil_expired`,
      });
    }
  }

  if (validFrom) {
    const fromMs = Date.parse(validFrom);
    if (Number.isFinite(fromMs) && fromMs > nowMs) {
      issues.push({
        kind,
        label,
        validUntil,
        reason: `${label}.validFrom_not_yet_valid`,
      });
    }
  }

  if (kind === 'PID') {
    const dateOfExpiry = firstClaim(cred.claims, ['date_of_expiry']);
    if (dateOfExpiry && /^\d{4}-\d{2}-\d{2}$/.test(dateOfExpiry)) {
      const today = now.toISOString().slice(0, 10);
      if (dateOfExpiry < today) {
        issues.push({
          kind: 'PID',
          label,
          validUntil: dateOfExpiry,
          reason: `${label}.date_of_expiry_expired`,
        });
      }
    }
  }
}

/**
 * Extracts normalized identity, address, and KYC income claims from a verified Tremend result payload.
 */
export function parseVerifiedCredentials(
  payload: DecryptedVerificationPayload,
  now: Date = new Date(),
): ParsedClaimsResult {
  const credentials = payload.credentials ?? [];
  let pidIdentity: IdentitySubject | null = null;
  let addressIdentity: IdentitySubject | null = null;
  let incomeIdentity: IdentitySubject | null = null;
  let pidSubject: PartialIdentitySubject | null = null;
  let addressSubject: PartialIdentitySubject | null = null;
  let incomeSubject: PartialIdentitySubject | null = null;
  let verifiedAddress: StructuredAddress | null = null;
  let fallbackPidAddress: StructuredAddress | null = null;
  let verifiedIncome: KycIncomeProfile | null = null;
  let hasPidCredential = false;
  let hasAddressCredential = false;
  let hasIncomeCredential = false;
  let pidHasLimitedAttestation = false;
  let pidExpiryDate: string | null = null;
  let integrityVerifiedCount = 0;

  const revocationStatuses: string[] = [];
  const ignoredPidFieldsSet = new Set<string>();
  const ignoredRawFieldsSet = new Set<string>();
  const hardIntegrityFailures: string[] = [];
  const validityIssues: CredentialValidityIssue[] = [];
  const credentialValidUntil: { pid?: string; address?: string; income?: string } = {};
  const authoritySet = new Set<string>();

  for (const cred of credentials) {
    const label = cred.type || cred.documentType || 'CREDENTIAL';
    const kind: CredentialKind = isPidCredential(cred)
      ? 'PID'
      : isAddressCredential(cred)
        ? 'ADDRESS'
        : isIncomeCredential(cred)
          ? 'INCOME'
          : 'OTHER';

    if (evaluateCredentialIntegrity(cred, label, hardIntegrityFailures, authoritySet)) {
      integrityVerifiedCount += 1;
    }
    collectCredentialValidityIssues(cred, kind, label, now, validityIssues);

    const status = cred.checks?.status;
    revocationStatuses.push(typeof status === 'string' && status.trim() ? status.trim() : 'NOT_CHECKED');

    const rawValidUntil =
      typeof cred.validUntil === 'string' && cred.validUntil.trim() ? cred.validUntil.trim() : undefined;

    if (kind === 'PID') {
      hasPidCredential = true;
      const extracted = extractIdentity(cred.claims);
      const partial = extractPartialIdentity(cred.claims);
      pidIdentity = pidIdentity ?? extracted;
      pidSubject = pidSubject ?? partial;
      pidExpiryDate = pidExpiryDate ?? firstClaim(cred.claims, ['date_of_expiry']);
      if (rawValidUntil && !credentialValidUntil.pid) {
        credentialValidUntil.pid = rawValidUntil;
      }

      if (cred.claims) {
        for (const key of Object.keys(cred.claims)) {
          const topKey = key.split('.')[0];
          if (!USED_PID_KEYS.has(key) && !USED_PID_KEYS.has(topKey)) {
            ignoredPidFieldsSet.add(topKey);
          }
        }
        if (!extracted && Object.keys(cred.claims).length > 0) {
          pidHasLimitedAttestation = true;
        }
      }
      fallbackPidAddress = fallbackPidAddress ?? extractAddress(cred.claims);
    } else if (kind === 'ADDRESS') {
      hasAddressCredential = true;
      addressIdentity = addressIdentity ?? extractIdentity(cred.claims);
      addressSubject = addressSubject ?? extractPartialIdentity(cred.claims);
      verifiedAddress = verifiedAddress ?? extractAddress(cred.claims);
      if (rawValidUntil && !credentialValidUntil.address) {
        credentialValidUntil.address = rawValidUntil;
      }
    } else if (kind === 'INCOME') {
      hasIncomeCredential = true;
      incomeIdentity = incomeIdentity ?? extractIdentity(cred.claims);
      incomeSubject = incomeSubject ?? extractPartialIdentity(cred.claims);
      verifiedIncome = verifiedIncome ?? extractIncome(cred.claims, ignoredRawFieldsSet);
      if (rawValidUntil && !credentialValidUntil.income) {
        credentialValidUntil.income = rawValidUntil;
      }
    } else {
      pidIdentity = pidIdentity ?? extractIdentity(cred.claims);
      pidSubject = pidSubject ?? extractPartialIdentity(cred.claims);
      verifiedAddress = verifiedAddress ?? extractAddress(cred.claims);
      verifiedIncome = verifiedIncome ?? extractIncome(cred.claims, ignoredRawFieldsSet);
    }
  }

  const integrityFailures = [
    ...hardIntegrityFailures,
    ...validityIssues.map((v) => v.reason),
  ];

  return {
    pidIdentity,
    addressIdentity,
    incomeIdentity,
    pidSubject,
    addressSubject,
    incomeSubject,
    verifiedAddress: verifiedAddress ?? fallbackPidAddress,
    verifiedIncome,
    revocationStatuses,
    hasPidCredential,
    hasAddressCredential,
    hasIncomeCredential,
    pidHasLimitedAttestation,
    pidExpiryDate,
    ignoredPidFields: Array.from(ignoredPidFieldsSet),
    ignoredRawFields: Array.from(ignoredRawFieldsSet),
    integrityFailures,
    hardIntegrityFailures,
    validityIssues,
    credentialValidUntil,
    integrityVerifiedCount,
    issuerAuthorities: Array.from(authoritySet),
  };
}
