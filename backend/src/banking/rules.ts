import { parseVerifiedCredentials } from './claimsParser.js';
import type {
  AddressDiff,
  AddressFieldDiff,
  BankRuleEvaluation,
  DecryptedVerificationPayload,
  IdentitySubject,
  IncomeDiff,
  IncomeFieldDiff,
  KycIncomeProfile,
  PartialIdentitySubject,
  StructuredAddress,
  TrustCheckItem,
  VerificationScope,
  ZenBankCustomerProfile,
} from '../types.js';

/**
 * Normalizes strings for comparison across uppercase/lowercase and Romanian diacritics.
 */
export function normalizeForMatch(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function findSubjectConflicts(
  a: PartialIdentitySubject,
  b: PartialIdentitySubject,
): string[] {
  const conflicts: string[] = [];
  if (a.personalNumericCode && b.personalNumericCode) {
    if (a.personalNumericCode.trim() !== b.personalNumericCode.trim()) {
      conflicts.push('CNP');
    }
  }
  if (a.givenName && b.givenName) {
    if (normalizeForMatch(a.givenName) !== normalizeForMatch(b.givenName)) {
      conflicts.push('prenume');
    }
  }
  if (a.familyName && b.familyName) {
    if (normalizeForMatch(a.familyName) !== normalizeForMatch(b.familyName)) {
      conflicts.push('nume');
    }
  }
  if (a.birthdate && b.birthdate) {
    if (a.birthdate.trim() !== b.birthdate.trim()) {
      conflicts.push('data nașterii');
    }
  }
  return conflicts;
}

/**
 * Computes field-level diff between current ZenBank address and verified EUDI address.
 */
export function computeAddressDiff(
  current: StructuredAddress,
  verified: StructuredAddress,
): AddressDiff {
  const specs: Array<{ field: 'streetAddress' | 'locality' | 'postalCode' | 'country'; label: string }> = [
    { field: 'streetAddress', label: 'Stradă și număr' },
    { field: 'locality', label: 'Localitate' },
    { field: 'postalCode', label: 'Cod poștal' },
    { field: 'country', label: 'Țară' },
  ];

  const fields: AddressFieldDiff[] = specs.map(({ field, label }) => {
    const currentValue = current[field] ?? '';
    const verifiedValue = verified[field] ?? '';
    const changed = normalizeForMatch(currentValue) !== normalizeForMatch(verifiedValue);
    return { field, label, currentValue, verifiedValue, changed };
  });

  const changedFields = fields.filter((f) => f.changed).map((f) => f.field);

  return {
    hasChanges: changedFields.length > 0,
    changedFields,
    fields,
  };
}

/**
 * Computes field-level diff between current ZenBank KYC income profile and verified EUDI income attestation.
 */
export function computeIncomeDiff(
  current: KycIncomeProfile,
  verified: KycIncomeProfile,
): IncomeDiff {
  const specs: Array<{ field: 'source' | 'employer' | 'bracket'; label: string }> = [
    { field: 'source', label: 'Sursă venit' },
    { field: 'employer', label: 'Angajator' },
    { field: 'bracket', label: 'Interval venit' },
  ];

  const fields: IncomeFieldDiff[] = specs.map(({ field, label }) => {
    const currentValue = current[field] ?? '';
    const verifiedValue = verified[field] ?? '';
    const changed = normalizeForMatch(currentValue) !== normalizeForMatch(verifiedValue);
    return { field, label, currentValue, verifiedValue, changed };
  });

  const changedFields = fields.filter((f) => f.changed).map((f) => f.field);

  return {
    hasChanges: changedFields.length > 0,
    changedFields,
    fields,
  };
}

export interface EvaluateRulesParams {
  customer: ZenBankCustomerProfile;
  payload: DecryptedVerificationPayload;
  cryptoChecks: TrustCheckItem[];
  acknowledged: boolean;
  requestedScope?: VerificationScope;
  now?: Date;
}

function credentialKindLabelRo(kind: 'PID' | 'ADDRESS' | 'INCOME'): string {
  switch (kind) {
    case 'PID':
      return 'actul de identitate';
    case 'ADDRESS':
      return 'atestarea de adresă';
    case 'INCOME':
      return 'atestarea de venit';
  }
}

/**
 * Deterministic ZenBank rules engine:
 * - Never reads claims unless outcome.status === 'SATISFIED'.
 * - Enforces credential cryptographic checks (issuerSignature, holderBinding, validity, trustedIssuer) and per-credential expiry.
 * - Verifies cross-credential subject binding (PID <-> Address / Income, including partial claims and CNP in memory) and ZenBank customer binding.
 * - Supports dynamic minimal profile scopes ('full', 'address', 'income') and graceful partial recovery when only income expires.
 * - Enforces revocation=NOT_CHECKED policy (no automatic identity field mutation).
 * - Computes structured address & KYC income diffs; never auto-writes without explicit user confirmation.
 */
export function evaluateVerificationResult({
  customer,
  payload,
  cryptoChecks,
  acknowledged,
  requestedScope = 'full',
  now,
}: EvaluateRulesParams): BankRuleEvaluation {
  const scope: VerificationScope = requestedScope;
  const effectiveNow = now ?? new Date();
  const checks: TrustCheckItem[] = [...cryptoChecks];
  const outcomeStatus = payload.outcome?.status ?? 'UNKNOWN';
  const withheldFields = Array.isArray(payload.outcome?.withheld)
    ? payload.outcome.withheld.filter((v): v is string => typeof v === 'string')
    : [];

  if (acknowledged) {
    checks.push({
      id: 'result_acknowledged',
      label: 'Confirmare preluare rezultat',
      status: 'PASS',
      detail: 'Trimis DELETE /verifications/{id}/result după validarea pe backend.',
    });
  } else {
    checks.push({
      id: 'result_acknowledged',
      label: 'Confirmare preluare rezultat',
      status: 'WARN',
      detail: 'Confirmarea preluării a fost omisă sau procesată anterior.',
    });
  }

  if (scope === 'age') {
    if (outcomeStatus !== 'SATISFIED') {
      checks.push({
        id: 'outcome_status',
        label: 'Rezultat verificare Verifier',
        status: 'FAIL',
        detail: `Statusul returnat a fost ${outcomeStatus} (fără date personale dezvăluite).`,
      });
      const isRefused = outcomeStatus === 'REFUSED';
      return {
        decision: 'UNHAPPY_PATH',
        reasonCode: isRefused ? 'PRESENTATION_REFUSED' : 'AGE_REQUIREMENT_NOT_SATISFIED',
        message: isRefused
          ? 'Ai ales să nu partajezi verificarea de vârstă în EUDI Wallet. Profilul tău ZenBank a rămas neschimbat.'
          : 'Nu am putut confirma eligibilitatea 18+ din EUDI Wallet. Profilul tău ZenBank a rămas neschimbat.',
        checks,
        verifiedIdentity: null,
        verifiedAddress: null,
        verifiedIncome: null,
        addressDiff: null,
        incomeDiff: null,
        withheldFields,
        revocationStatus: 'UNKNOWN',
        canConfirmAddressUpdate: false,
        canConfirmIncomeUpdate: false,
        canConfirmIdentityOnly: false,
      };
    }

    checks.push({
      id: 'outcome_status',
      label: 'Rezultat verificare Verifier',
      status: 'PASS',
      detail: 'Rezultat Verifier: outcome.status = SATISFIED (DECISION age-18).',
    });

    if (Array.isArray(payload.credentials) && payload.credentials.length > 0) {
      const parsedAge = parseVerifiedCredentials(payload, effectiveNow);
      if (parsedAge.hardIntegrityFailures.length > 0) {
        checks.push({
          id: 'credential_integrity',
          label: 'Verificări criptografice credențiale',
          status: 'FAIL',
          detail: `Verificări eșuate: ${parsedAge.hardIntegrityFailures.join(', ')}.`,
        });
        return {
          decision: 'SECURITY_BLOCKED',
          reasonCode: 'CREDENTIAL_INTEGRITY_FAILED',
          message:
            'Nu am putut confirma autenticitatea datelor din EUDI Wallet. Din motive de siguranță, verificarea a fost oprită.',
          checks,
          verifiedIdentity: null,
          verifiedAddress: null,
          verifiedIncome: null,
          addressDiff: null,
          incomeDiff: null,
          withheldFields,
          revocationStatus: parsedAge.revocationStatuses.join(', ') || 'NOT_CHECKED',
          canConfirmAddressUpdate: false,
          canConfirmIncomeUpdate: false,
          canConfirmIdentityOnly: false,
        };
      }
      if (parsedAge.validityIssues.length > 0) {
        checks.push({
          id: 'credential_expiry',
          label: 'Valabilitate credențiale',
          status: 'FAIL',
          detail: 'Documentul folosit pentru verificarea de vârstă a expirat.',
        });
        return {
          decision: 'SECURITY_BLOCKED',
          reasonCode: 'CREDENTIAL_EXPIRED',
          message:
            'Documentul din EUDI Wallet folosit pentru verificarea de vârstă este expirat.',
          checks,
          verifiedIdentity: null,
          verifiedAddress: null,
          verifiedIncome: null,
          addressDiff: null,
          incomeDiff: null,
          withheldFields,
          revocationStatus: parsedAge.revocationStatuses.join(', ') || 'NOT_CHECKED',
          canConfirmAddressUpdate: false,
          canConfirmIncomeUpdate: false,
          canConfirmIdentityOnly: false,
        };
      }
    }

    const rawAgeOver18 = payload.outcome?.answers?.age_over_18;
    const isOver18 =
      rawAgeOver18 === true ||
      (typeof rawAgeOver18 === 'string' && rawAgeOver18.trim().toLowerCase() === 'true');

    if (!isOver18) {
      checks.push({
        id: 'age_decision',
        label: 'Decizie eligibilitate 18+ (0 PII)',
        status: 'FAIL',
        detail: 'Răspunsul age_over_18 nu a confirmat vârsta minimă de 18 ani.',
      });
      return {
        decision: 'UNHAPPY_PATH',
        reasonCode: 'AGE_REQUIREMENT_NOT_SATISFIED',
        message:
          'Nu am putut confirma eligibilitatea 18+ din EUDI Wallet. Profilul tău ZenBank a rămas neschimbat.',
        checks,
        verifiedIdentity: null,
        verifiedAddress: null,
        verifiedIncome: null,
        addressDiff: null,
        incomeDiff: null,
        withheldFields,
        revocationStatus: 'NOT_CHECKED',
        canConfirmAddressUpdate: false,
        canConfirmIncomeUpdate: false,
        canConfirmIdentityOnly: false,
      };
    }

    checks.push({
      id: 'age_decision',
      label: 'Decizie eligibilitate 18+ (0 PII)',
      status: 'PASS',
      detail: 'Rezultat DECISION (age-18): age_over_18=true; fără date personale dezvăluite.',
    });

    return {
      decision: 'AGE_DECISION_SATISFIED',
      reasonCode: 'AGE_OVER_18_CONFIRMED',
      message:
        'Eligibilitatea 18+ a fost confirmată prin EUDI Wallet — fără a partaja numele, data nașterii sau alte date personale.',
      checks,
      verifiedIdentity: null,
      verifiedAddress: null,
      verifiedIncome: null,
      addressDiff: null,
      incomeDiff: null,
      withheldFields,
      revocationStatus: 'NOT_CHECKED',
      canConfirmAddressUpdate: false,
      canConfirmIncomeUpdate: false,
      canConfirmIdentityOnly: false,
      decisionAnswers: { age_over_18: 'true' },
      decisionBasis: payload.outcome?.basis ?? 'ATTESTATION',
    };
  }

  if (outcomeStatus !== 'SATISFIED') {
    checks.push({
      id: 'outcome_status',
      label: 'Rezultat verificare Verifier',
      status: 'FAIL',
      detail: `Statusul returnat a fost ${outcomeStatus} (atributele sunt ignorate conform politicii).`,
    });

    const isRefused = outcomeStatus === 'REFUSED';
    if (!isRefused) {
      const metadataOnly = parseVerifiedCredentials(payload, effectiveNow);
      const expiredKinds = Array.from(
        new Set(
          metadataOnly.validityIssues
            .map((v) => v.kind)
            .filter((k): k is 'PID' | 'ADDRESS' | 'INCOME' => k === 'PID' || k === 'ADDRESS' || k === 'INCOME'),
        ),
      );
      if (expiredKinds.length === 1 && expiredKinds[0] === 'INCOME' && scope === 'full') {
        checks.push({
          id: 'income_expiry',
          label: 'Valabilitate atestare venit',
          status: 'FAIL',
          detail: 'Atestarea de venit din EUDI Wallet a expirat.',
        });
        return {
          decision: 'UNHAPPY_PATH',
          reasonCode: 'INCOME_CREDENTIAL_EXPIRED',
          message:
            'Atestarea ta de venit din EUDI Wallet a expirat, însă identitatea și adresa rămân valide. Poți reemite atestarea de venit în wallet sau poți actualiza acum doar adresa de domiciliu.',
          checks,
          verifiedIdentity: null,
          verifiedAddress: null,
          verifiedIncome: null,
          addressDiff: null,
          incomeDiff: null,
          withheldFields,
          revocationStatus: 'UNKNOWN',
          canConfirmAddressUpdate: false,
          canConfirmIncomeUpdate: false,
          canConfirmIdentityOnly: false,
          expiredCredentials: ['INCOME'],
        };
      }
      if (expiredKinds.length > 0) {
        const labels = expiredKinds.map(credentialKindLabelRo).join(' și ');
        checks.push({
          id: 'credential_expiry',
          label: 'Valabilitate credențiale',
          status: 'FAIL',
          detail: `Au expirat: ${labels}.`,
        });
        return {
          decision: 'UNHAPPY_PATH',
          reasonCode: 'CREDENTIAL_EXPIRED',
          message: `Următorul document din EUDI Wallet a expirat: ${labels}. Reemite documentul în wallet și reîncearcă verificarea.`,
          checks,
          verifiedIdentity: null,
          verifiedAddress: null,
          verifiedIncome: null,
          addressDiff: null,
          incomeDiff: null,
          withheldFields,
          revocationStatus: 'UNKNOWN',
          canConfirmAddressUpdate: false,
          canConfirmIncomeUpdate: false,
          canConfirmIdentityOnly: false,
          expiredCredentials: expiredKinds,
        };
      }
    }

    return {
      decision: 'UNHAPPY_PATH',
      reasonCode: isRefused ? 'PRESENTATION_REFUSED' : 'REQUIREMENT_NOT_SATISFIED',
      message: isRefused
        ? 'Ai ales să nu partajezi datele din EUDI Wallet. Profilul tău ZenBank a rămas neschimbat.'
        : 'Nu am primit toate datele necesare din EUDI Wallet. Profilul tău ZenBank a rămas neschimbat.',
      checks,
      verifiedIdentity: null,
      verifiedAddress: null,
      verifiedIncome: null,
      addressDiff: null,
      incomeDiff: null,
      withheldFields,
      revocationStatus: 'UNKNOWN',
      canConfirmAddressUpdate: false,
      canConfirmIncomeUpdate: false,
      canConfirmIdentityOnly: false,
    };
  }

  checks.push({
    id: 'outcome_status',
    label: 'Rezultat verificare Verifier',
    status: 'PASS',
    detail: 'Rezultat Verifier: outcome.status = SATISFIED.',
  });

  const parsed = parseVerifiedCredentials(payload, effectiveNow);

  // Hard cryptographic integrity check (issuerSignature, holderBinding, trustedIssuer)
  if (parsed.hardIntegrityFailures.length > 0) {
    checks.push({
      id: 'credential_integrity',
      label: 'Verificări criptografice credențiale',
      status: 'FAIL',
      detail: `Verificări eșuate: ${parsed.hardIntegrityFailures.join(', ')}.`,
    });
    return {
      decision: 'SECURITY_BLOCKED',
      reasonCode: 'CREDENTIAL_INTEGRITY_FAILED',
      message:
        'Nu am putut confirma autenticitatea datelor din EUDI Wallet. Din motive de siguranță, actualizarea a fost oprită.',
      checks,
      verifiedIdentity: parsed.pidIdentity,
      verifiedAddress: null,
      verifiedIncome: null,
      addressDiff: null,
      incomeDiff: null,
      withheldFields,
      revocationStatus: parsed.revocationStatuses.join(', ') || 'NOT_CHECKED',
      canConfirmAddressUpdate: false,
      canConfirmIncomeUpdate: false,
      canConfirmIdentityOnly: false,
    };
  }
  if (parsed.integrityVerifiedCount > 0) {
    const authLabel =
      parsed.issuerAuthorities.length > 0
        ? ` (Emitent: ${parsed.issuerAuthorities.join(', ')})`
        : '';
    checks.push({
      id: 'credential_integrity',
      label: 'Verificări criptografice credențiale',
      status: 'PASS',
      detail:
        parsed.validityIssues.length > 0
          ? `Validat issuerSignature=true, holderBinding=true, trustedIssuer=true pentru ${parsed.integrityVerifiedCount} credențial(e) valide${authLabel}.`
          : `Validat issuerSignature=true, holderBinding=true, validity=true, trustedIssuer=true pentru ${parsed.integrityVerifiedCount} credențial(e)${authLabel}.`,
    });
  }

  // Scenario 1: Cross-credential and customer subject binding runs BEFORE any expiry filtering
  // so an expired credential belonging to another person still triggers a hard SECURITY_BLOCKED.
  const revocationStatusEarly =
    parsed.revocationStatuses.length > 0 ? parsed.revocationStatuses.join(', ') : 'NOT_CHECKED';
  const customerPartialSubject: PartialIdentitySubject = {
    givenName: customer.givenName,
    familyName: customer.familyName,
    birthdate: customer.birthdate,
  };

  if (parsed.pidSubject) {
    const secondarySubjects: Array<{ label: string; subject: PartialIdentitySubject }> = [];
    if (parsed.addressSubject) {
      secondarySubjects.push({ label: 'atestarea de adresă', subject: parsed.addressSubject });
    }
    if (parsed.incomeSubject) {
      secondarySubjects.push({ label: 'atestarea de venit', subject: parsed.incomeSubject });
    }

    for (const sec of secondarySubjects) {
      const conflicts = findSubjectConflicts(parsed.pidSubject, sec.subject);
      if (conflicts.length > 0) {
        checks.push({
          id: 'cross_credential_binding',
          label: 'Asociere între credențiale (PID ↔ Adresă / Venit)',
          status: 'FAIL',
          detail: `Atributele de identitate (${conflicts.join(', ')}) din PID nu corespund cu titularul pentru ${sec.label}.`,
        });
        return {
          decision: 'SECURITY_BLOCKED',
          reasonCode: 'CROSS_CREDENTIAL_SUBJECT_MISMATCH',
          message:
            'Datele trimise din EUDI Wallet par să aparțină unor persoane diferite, așa că nu putem actualiza profilul.',
          checks,
          verifiedIdentity: parsed.pidIdentity,
          verifiedAddress: null,
          verifiedIncome: null,
          addressDiff: null,
          incomeDiff: null,
          withheldFields,
          revocationStatus: revocationStatusEarly,
          canConfirmAddressUpdate: false,
          canConfirmIncomeUpdate: false,
          canConfirmIdentityOnly: false,
        };
      }
    }

    if (secondarySubjects.length > 0) {
      checks.push({
        id: 'cross_credential_binding',
        label: 'Asociere între credențiale (PID ↔ Adresă / Venit)',
        status: 'PASS',
        detail: 'Credențialele cu atribute de titular corespund între ele.',
      });
    } else {
      checks.push({
        id: 'cross_credential_binding',
        label: 'Asociere între credențiale (PID ↔ Adresă / Venit)',
        status: 'INFO',
        detail:
          'PID, Adresa și Venitul au fost prezentate în aceeași sesiune OpenID4VP cu legare criptografică a deținătorului (holderBinding=true).',
      });
    }

    const customerConflicts = findSubjectConflicts(parsed.pidSubject, customerPartialSubject);
    if (customerConflicts.length > 0) {
      checks.push({
        id: 'zenbank_customer_binding',
        label: 'Asociere identitate client ZenBank',
        status: 'FAIL',
        detail: `Identitatea verificată în EUDI Wallet nu corespunde cu titularul contului ZenBank (${customerConflicts.join(', ')}).`,
      });
      return {
        decision: 'SECURITY_BLOCKED',
        reasonCode: 'CUSTOMER_SUBJECT_MISMATCH',
        message:
          'Identitatea din EUDI Wallet nu corespunde titularului acestui cont ZenBank. Pentru siguranța ta, actualizarea a fost blocată.',
        checks,
        verifiedIdentity: parsed.pidIdentity,
        verifiedAddress: null,
        verifiedIncome: null,
        addressDiff: null,
        incomeDiff: null,
        withheldFields,
        revocationStatus: revocationStatusEarly,
        canConfirmAddressUpdate: false,
        canConfirmIncomeUpdate: false,
        canConfirmIdentityOnly: false,
      };
    }

    checks.push({
      id: 'zenbank_customer_binding',
      label: 'Asociere identitate client ZenBank',
      status: 'PASS',
      detail: 'Identitatea verificată în EUDI corespunde cu clientul ZenBank autentificat (nume + dată naștere).',
    });
  } else {
    if (parsed.addressSubject && parsed.incomeSubject) {
      const secondaryConflicts = findSubjectConflicts(parsed.addressSubject, parsed.incomeSubject);
      if (secondaryConflicts.length > 0) {
        checks.push({
          id: 'cross_credential_binding',
          label: 'Asociere între credențiale (Adresă ↔ Venit)',
          status: 'FAIL',
          detail: `Atributele de identitate (${secondaryConflicts.join(', ')}) nu corespund între atestarea de adresă și atestarea de venit.`,
        });
        return {
          decision: 'SECURITY_BLOCKED',
          reasonCode: 'CROSS_CREDENTIAL_SUBJECT_MISMATCH',
          message:
            'Datele trimise din EUDI Wallet par să aparțină unor persoane diferite, așa că nu putem actualiza profilul.',
          checks,
          verifiedIdentity: parsed.pidIdentity,
          verifiedAddress: null,
          verifiedIncome: null,
          addressDiff: null,
          incomeDiff: null,
          withheldFields,
          revocationStatus: revocationStatusEarly,
          canConfirmAddressUpdate: false,
          canConfirmIncomeUpdate: false,
          canConfirmIdentityOnly: false,
        };
      }
    }

    const secondaryEntries: Array<{ label: string; subject: PartialIdentitySubject }> = [];
    if (parsed.addressSubject) {
      secondaryEntries.push({ label: 'atestarea de adresă', subject: parsed.addressSubject });
    }
    if (parsed.incomeSubject) {
      secondaryEntries.push({ label: 'atestarea de venit', subject: parsed.incomeSubject });
    }
    for (const entry of secondaryEntries) {
      const conflicts = findSubjectConflicts(entry.subject, customerPartialSubject);
      if (conflicts.length > 0) {
        checks.push({
          id: 'zenbank_customer_binding',
          label: 'Asociere identitate client ZenBank',
          status: 'FAIL',
          detail: `Titularul pentru ${entry.label} nu corespunde cu clientul ZenBank (${conflicts.join(', ')}).`,
        });
        return {
          decision: 'SECURITY_BLOCKED',
          reasonCode: 'CUSTOMER_SUBJECT_MISMATCH',
          message:
            'Identitatea din EUDI Wallet nu corespunde titularului acestui cont ZenBank. Pentru siguranța ta, actualizarea a fost blocată.',
          checks,
          verifiedIdentity: parsed.pidIdentity,
          verifiedAddress: null,
          verifiedIncome: null,
          addressDiff: null,
          incomeDiff: null,
          withheldFields,
          revocationStatus: revocationStatusEarly,
          canConfirmAddressUpdate: false,
          canConfirmIncomeUpdate: false,
          canConfirmIdentityOnly: false,
        };
      }
    }
  }

  // Scenario 2: Per-credential validity & expiry evaluation
  const pidIssue = parsed.validityIssues.find((v) => v.kind === 'PID');
  const addressIssue = parsed.validityIssues.find((v) => v.kind === 'ADDRESS');
  const incomeIssue = parsed.validityIssues.find((v) => v.kind === 'INCOME');
  const otherIssue = parsed.validityIssues.find((v) => v.kind === 'OTHER');

  if (otherIssue) {
    checks.push({
      id: 'credential_expiry',
      label: 'Valabilitate credențiale',
      status: 'FAIL',
      detail: `Credențial expirat sau nevalid: ${otherIssue.label}.`,
    });
    return {
      decision: 'SECURITY_BLOCKED',
      reasonCode: 'CREDENTIAL_EXPIRED',
      message:
        'Unul dintre documentele prezentate din EUDI Wallet este expirat. Te rugăm să îl reînnoiești înainte de a actualiza profilul ZenBank.',
      checks,
      verifiedIdentity: parsed.pidIdentity,
      verifiedAddress: null,
      verifiedIncome: null,
      addressDiff: null,
      incomeDiff: null,
      withheldFields,
      revocationStatus: revocationStatusEarly,
      canConfirmAddressUpdate: false,
      canConfirmIncomeUpdate: false,
      canConfirmIdentityOnly: false,
    };
  }

  if (pidIssue) {
    checks.push({
      id: 'pid_expiry',
      label: 'Valabilitate document PID',
      status: 'FAIL',
      detail: parsed.pidExpiryDate
        ? `PID-ul prezentat a expirat la ${parsed.pidExpiryDate}.`
        : 'Documentul de identitate (PID) din EUDI Wallet a expirat.',
    });
    return {
      decision: 'SECURITY_BLOCKED',
      reasonCode: 'CREDENTIAL_EXPIRED',
      message:
        'Documentul tău de identitate din EUDI Wallet este expirat. Te rugăm să îl reînnoiești înainte de a actualiza profilul ZenBank.',
      checks,
      verifiedIdentity: parsed.pidIdentity,
      verifiedAddress: null,
      verifiedIncome: null,
      addressDiff: null,
      incomeDiff: null,
      withheldFields,
      revocationStatus: revocationStatusEarly,
      canConfirmAddressUpdate: false,
      canConfirmIncomeUpdate: false,
      canConfirmIdentityOnly: false,
      expiredCredentials: ['PID'],
    };
  }
  if (parsed.pidExpiryDate && /^\d{4}-\d{2}-\d{2}$/.test(parsed.pidExpiryDate)) {
    checks.push({
      id: 'pid_expiry',
      label: 'Valabilitate document PID',
      status: 'PASS',
      detail: `Data de expirare PID (${parsed.pidExpiryDate}) este validă.`,
    });
  }

  const expiredCredentials: Array<'PID' | 'ADDRESS' | 'INCOME'> = [];
  let warningNote: string | undefined;

  if (
    (scope === 'address' && addressIssue) ||
    (scope === 'income' && incomeIssue) ||
    (addressIssue && incomeIssue)
  ) {
    if (addressIssue) expiredCredentials.push('ADDRESS');
    if (incomeIssue) expiredCredentials.push('INCOME');
    const labels = expiredCredentials.map(credentialKindLabelRo).join(' și ');
    checks.push({
      id: 'credential_expiry',
      label: 'Valabilitate credențiale',
      status: 'FAIL',
      detail: `Au expirat: ${labels}.`,
    });
    return {
      decision: 'SECURITY_BLOCKED',
      reasonCode: 'CREDENTIAL_EXPIRED',
      message: `Documentul prezentat din EUDI Wallet (${labels}) este expirat. Reemite documentul în wallet și reîncearcă verificarea.`,
      checks,
      verifiedIdentity: parsed.pidIdentity,
      verifiedAddress: null,
      verifiedIncome: null,
      addressDiff: null,
      incomeDiff: null,
      withheldFields,
      revocationStatus: revocationStatusEarly,
      canConfirmAddressUpdate: false,
      canConfirmIncomeUpdate: false,
      canConfirmIdentityOnly: false,
      expiredCredentials,
    };
  }

  if (scope === 'full' && incomeIssue) {
    expiredCredentials.push('INCOME');
    checks.push({
      id: 'income_expiry',
      label: 'Valabilitate atestare venit',
      status: 'FAIL',
      detail: 'Atestarea de venit a expirat și a fost exclusă; identitatea și adresa rămân valide.',
    });
    warningNote =
      'Atestarea ta de venit din EUDI Wallet a expirat și nu a fost inclusă. Poți confirma acum actualizarea adresei și reconfirmarea identității, apoi poți actualiza venitul după reemiterea documentului în wallet.';
  } else if (scope === 'full' && addressIssue) {
    expiredCredentials.push('ADDRESS');
    checks.push({
      id: 'address_expiry',
      label: 'Valabilitate atestare adresă',
      status: 'FAIL',
      detail: 'Atestarea de adresă a expirat și a fost exclusă; identitatea și venitul rămân valide.',
    });
    warningNote =
      'Atestarea ta de adresă din EUDI Wallet a expirat și nu a fost inclusă. Poți confirma acum actualizarea venitului și reconfirmarea identității, apoi poți actualiza adresa după reemiterea documentului în wallet.';
  }

  if (parsed.ignoredPidFields.length > 0 || parsed.ignoredRawFields.length > 0) {
    const parts: string[] = [];
    if (parsed.ignoredPidFields.length > 0) {
      parts.push(`atribute PID suplimentare: ${parsed.ignoredPidFields.join(', ')}`);
    }
    if (parsed.ignoredRawFields.length > 0) {
      parts.push(`date granulare nepersistate: ${parsed.ignoredRawFields.join(', ')}`);
    }
    checks.push({
      id: 'data_minimization_filter',
      label: 'Filtru minimizare date',
      status: 'INFO',
      detail: `Se păstrează doar rezumatul KYC minim (${parts.join('; ')}) — nu se stochează și nu ajung la LLM.`,
    });
  }

  const revocationStatus =
    parsed.revocationStatuses.length > 0 ? parsed.revocationStatuses.join(', ') : 'NOT_CHECKED';

  if (parsed.revocationStatuses.every((s) => s === 'VALID')) {
    checks.push({
      id: 'revocation_policy',
      label: 'Verificare revocare credențiale',
      status: 'PASS',
      detail: 'Toate verificările de status au returnat VALID.',
    });
  } else {
    checks.push({
      id: 'revocation_policy',
      label: 'Politică status revocare',
      status: 'WARN',
      detail: `Status sandbox ${revocationStatus}: actualizarea automată este permisă doar pentru adresa și sursa de venit a aceleiași persoane; modificările de nume/CNP necesită analiză KYC manuală.`,
    });
  }

  if (!parsed.pidIdentity && !(parsed.hasPidCredential && parsed.pidHasLimitedAttestation)) {
    if (scope === 'income') {
      if (!parsed.hasIncomeCredential || !parsed.verifiedIncome) {
        checks.push({
          id: 'zenbank_customer_binding',
          label: 'Profil minimal de venit',
          status: 'FAIL',
          detail: 'Lipsesc atributele verificate de venit din răspunsul wallet.',
        });
        return {
          decision: 'UNHAPPY_PATH',
          reasonCode: 'REQUIREMENT_NOT_SATISFIED',
          message: 'Nu am primit datele de venit din EUDI Wallet. Profilul tău ZenBank a rămas neschimbat.',
          checks,
          verifiedIdentity: null,
          verifiedAddress: null,
          verifiedIncome: null,
          addressDiff: null,
          incomeDiff: null,
          withheldFields,
          revocationStatus,
          canConfirmAddressUpdate: false,
          canConfirmIncomeUpdate: false,
          canConfirmIdentityOnly: false,
        };
      }

      checks.push({
        id: 'zenbank_customer_binding',
        label: 'Profil minimal de venit',
        status: 'INFO',
        detail:
          'Profil minimal (qa-income-23): titularul este deja autentificat în ZenBank; s-au solicitat strict datele de venit.',
      });
    } else if (scope === 'address') {
      if (
        !parsed.hasAddressCredential ||
        !parsed.verifiedAddress ||
        (!parsed.verifiedAddress.streetAddress && !parsed.verifiedAddress.formatted)
      ) {
        checks.push({
          id: 'zenbank_customer_binding',
          label: 'Profil minimal de adresă',
          status: 'FAIL',
          detail: 'Lipsesc atributele verificate de adresă din răspunsul wallet.',
        });
        return {
          decision: 'UNHAPPY_PATH',
          reasonCode: 'REQUIREMENT_NOT_SATISFIED',
          message:
            'Nu am primit datele de adresă din EUDI Wallet. Profilul tău ZenBank a rămas neschimbat.',
          checks,
          verifiedIdentity: null,
          verifiedAddress: null,
          verifiedIncome: null,
          addressDiff: null,
          incomeDiff: null,
          withheldFields,
          revocationStatus,
          canConfirmAddressUpdate: false,
          canConfirmIncomeUpdate: false,
          canConfirmIdentityOnly: false,
        };
      }

      checks.push({
        id: 'zenbank_customer_binding',
        label: 'Profil minimal de adresă',
        status: 'INFO',
        detail:
          'Profil minimal (qa-address-23): titularul este deja autentificat în ZenBank; s-a solicitat strict atestarea de adresă.',
      });
    } else {
      checks.push({
        id: 'zenbank_customer_binding',
        label: 'Asociere identitate client ZenBank',
        status: 'FAIL',
        detail: 'Lipsesc atributele de identitate PID (given_name, family_name, birthdate).',
      });
      return {
        decision: 'UNHAPPY_PATH',
        reasonCode: 'MISSING_IDENTITY_CLAIMS',
        message: 'Atributele de identitate verificate nu au fost incluse în răspunsul din wallet.',
        checks,
        verifiedIdentity: null,
        verifiedAddress: parsed.verifiedAddress,
        verifiedIncome: parsed.verifiedIncome,
        addressDiff: null,
        incomeDiff: null,
        withheldFields,
        revocationStatus,
        canConfirmAddressUpdate: false,
        canConfirmIncomeUpdate: false,
        canConfirmIdentityOnly: false,
      };
    }
  }

  if (!parsed.pidSubject && scope === 'full') {
    checks.push({
      id: 'zenbank_customer_binding',
      label: 'Asociere identitate client ZenBank',
      status: 'WARN',
      detail:
        'Profilul sandbox a verificat atestarea PID fără nume/dată nașterii. Folosește un profil DISCLOSURE cu given_name/family_name/birthdate pentru asociere completă.',
    });
  }

  // Exclude expired optional credential in full scope so expired claims are never read/offered
  let effectiveAddress: StructuredAddress | null = addressIssue ? null : parsed.verifiedAddress;
  // When qa-income-23 omits payer.legal_name / income_type, preserve existing employer/source while updating bracket
  let effectiveIncome: KycIncomeProfile | null = incomeIssue ? null : parsed.verifiedIncome;
  if (scope === 'income' && effectiveIncome) {
    const preserveEmployer =
      !effectiveIncome.employer || effectiveIncome.employer === 'Neconfirmat';
    const preserveSource = effectiveIncome.source === 'Venit declarat';
    effectiveIncome = {
      ...effectiveIncome,
      employer: preserveEmployer ? customer.currentIncome.employer : effectiveIncome.employer,
      source: preserveSource ? customer.currentIncome.source : effectiveIncome.source,
    };
  }

  // Evaluate address & income disclosures independently according to the requested minimal scope
  const expectAddress = scope !== 'income' && !addressIssue;
  const expectIncome = scope !== 'address' && !incomeIssue;
  const canConfirmIdentityOnly = Boolean(parsed.pidIdentity);

  const addressWithheld =
    expectAddress &&
    (withheldFields.some((f) => f.toLowerCase().includes('address') || f.toLowerCase().includes('street')) ||
      !effectiveAddress ||
      (!effectiveAddress.streetAddress && !effectiveAddress.formatted));

  const incomeWithheld =
    expectIncome &&
    (withheldFields.some((f) => f.toLowerCase().includes('income') || f.toLowerCase().includes('bri')) ||
      !effectiveIncome);

  const allExpectedWithheld =
    (!expectAddress || addressWithheld) && (!expectIncome || incomeWithheld);

  if (allExpectedWithheld && canConfirmIdentityOnly) {
    checks.push({
      id: 'profile_comparison',
      label: 'Comparație date solicitate',
      status: 'WARN',
      detail: 'Atributele solicitate nu au fost partajate; reconfirmarea identității rămâne disponibilă.',
    });
    return {
      decision: 'PARTIAL_IDENTITY_ONLY',
      reasonCode: 'ATTRIBUTES_WITHHELD',
      message:
        'Identitatea ta a fost confirmată, însă datele solicitate nu au fost partajate. Poți confirma reconfirmarea identității acum sau poți reîncerca partajarea din EUDI Wallet.',
      checks,
      verifiedIdentity: parsed.pidIdentity,
      verifiedAddress: null,
      verifiedIncome: null,
      addressDiff: null,
      incomeDiff: null,
      withheldFields,
      revocationStatus,
      canConfirmAddressUpdate: false,
      canConfirmIncomeUpdate: false,
      canConfirmIdentityOnly: true,
      ...(expiredCredentials.length > 0 ? { expiredCredentials } : {}),
      credentialValidUntil: parsed.credentialValidUntil,
      ...(warningNote ? { warningNote } : {}),
    };
  }

  const addressDiff =
    expectAddress && !addressWithheld && effectiveAddress
      ? computeAddressDiff(customer.currentAddress, effectiveAddress)
      : null;
  const incomeDiff =
    expectIncome && !incomeWithheld && effectiveIncome
      ? computeIncomeDiff(customer.currentIncome, effectiveIncome)
      : null;

  const hasAddressChanges = Boolean(addressDiff?.hasChanges);
  const hasIncomeChanges = Boolean(incomeDiff?.hasChanges);

  if (expiredCredentials.length > 0) {
    const expiredLabel = expiredCredentials.map(credentialKindLabelRo).join(' și ');
    checks.push({
      id: 'profile_comparison',
      label: 'Comparație date solicitate',
      status: 'WARN',
      detail: `Exclus din actualizare (${expiredLabel} expirat); datele valide rămase sunt pregătite pentru confirmare.`,
    });
  } else if (addressWithheld || incomeWithheld) {
    const missingLabel = addressWithheld ? 'adresa' : 'atestarea de venit';
    checks.push({
      id: 'profile_comparison',
      label: 'Comparație date solicitate',
      status: 'WARN',
      detail: `Atributele pentru ${missingLabel} nu au fost partajate; celelalte date verificate sunt pregătite pentru confirmare.`,
    });
  } else if (scope === 'address') {
    checks.push({
      id: 'profile_comparison',
      label: 'Minimizare date · Doar adresă',
      status: 'PASS',
      detail: hasAddressChanges
        ? 'Detectată adresă nouă verificată (qa-address-23); identitatea și venitul nu au fost solicitate.'
        : 'Adresa corespunde profilului curent ZenBank (qa-address-23); identitatea și venitul nu au fost solicitate.',
    });
  } else if (scope === 'income') {
    checks.push({
      id: 'profile_comparison',
      label: 'Minimizare date · Doar venit',
      status: 'PASS',
      detail: hasIncomeChanges
        ? 'Detectată modificare a intervalului de venit (qa-income-23); identitatea și adresa nu au fost solicitate.'
        : 'Datele de venit corespund profilului curent ZenBank (qa-income-23); identitatea și adresa nu au fost solicitate.',
    });
  } else {
    checks.push({
      id: 'profile_comparison',
      label: 'Comparație adresă și sursă venit',
      status: 'PASS',
      detail:
        hasAddressChanges || hasIncomeChanges
          ? 'Detectate actualizări verificate față de profilul ZenBank; se așteaptă confirmarea explicită a clientului.'
          : 'Adresa și datele de venit corespund cu profilul curent ZenBank; gata pentru reconfirmarea identității.',
    });
  }

  if (hasAddressChanges || hasIncomeChanges) {
    const changedLabels: string[] = [];
    if (hasAddressChanges) changedLabels.push('adresa de domiciliu');
    if (hasIncomeChanges) changedLabels.push('sursa de venit și angajatorul');

    const readyMessage =
      scope === 'income' && !parsed.pidIdentity
        ? 'Intervalul tău de venit a fost verificat în EUDI Wallet! Verifică modificarea de mai jos înainte de salvare.'
        : scope === 'address' && !parsed.pidIdentity
          ? 'Adresa ta de domiciliu a fost verificată în EUDI Wallet! Verifică modificarea de mai jos înainte de salvare.'
          : `Identitatea ta a fost confirmată! Am detectat informații noi pentru ${changedLabels.join(' și ')}.`;

    return {
      decision: 'READY_FOR_CONFIRMATION',
      reasonCode: 'PROFILE_CHANGES_DETECTED',
      message: readyMessage,
      checks,
      verifiedIdentity: parsed.pidIdentity,
      verifiedAddress: expectAddress && !addressWithheld ? effectiveAddress : null,
      verifiedIncome: expectIncome && !incomeWithheld ? effectiveIncome : null,
      addressDiff,
      incomeDiff,
      withheldFields,
      revocationStatus,
      canConfirmAddressUpdate: hasAddressChanges,
      canConfirmIncomeUpdate: hasIncomeChanges,
      canConfirmIdentityOnly,
      ...(expiredCredentials.length > 0 ? { expiredCredentials } : {}),
      credentialValidUntil: parsed.credentialValidUntil,
      ...(warningNote ? { warningNote } : {}),
    };
  }

  return {
    decision: 'NO_CHANGES_CONFIRM_IDENTITY',
    reasonCode: 'PROFILE_UNCHANGED',
    message: canConfirmIdentityOnly
      ? 'Datele tale din ZenBank corespund deja cu cele din EUDI Wallet. Confirmă mai jos pentru a finaliza reconfirmarea identității.'
      : scope === 'address'
        ? 'Adresa ta din EUDI Wallet corespunde deja cu profilul curent ZenBank.'
        : 'Datele tale de venit din EUDI Wallet corespund deja cu profilul curent ZenBank.',
    checks,
    verifiedIdentity: parsed.pidIdentity,
    verifiedAddress: expectAddress && !addressWithheld ? effectiveAddress : null,
    verifiedIncome: expectIncome && !incomeWithheld ? effectiveIncome : null,
    addressDiff,
    incomeDiff,
    withheldFields,
    revocationStatus,
    canConfirmAddressUpdate: false,
    canConfirmIncomeUpdate: false,
    canConfirmIdentityOnly,
    ...(expiredCredentials.length > 0 ? { expiredCredentials } : {}),
    credentialValidUntil: parsed.credentialValidUntil,
    ...(warningNote ? { warningNote } : {}),
  };
}
