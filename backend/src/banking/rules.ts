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
  StructuredAddress,
  TrustCheckItem,
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

function subjectsMatch(a: IdentitySubject, b: IdentitySubject): boolean {
  return (
    normalizeForMatch(a.givenName) === normalizeForMatch(b.givenName) &&
    normalizeForMatch(a.familyName) === normalizeForMatch(b.familyName) &&
    a.birthdate.trim() === b.birthdate.trim()
  );
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
    { field: 'bracket', label: 'Tranșă venit KYC' },
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
}

/**
 * Deterministic ZenBank rules engine:
 * - Never reads claims unless outcome.status === 'SATISFIED'.
 * - Enforces credential cryptographic checks (issuerSignature, holderBinding, validity, trustedIssuer) and expiry.
 * - Verifies cross-credential subject binding (PID <-> Address / Income) and ZenBank customer binding.
 * - Enforces revocation=NOT_CHECKED policy (no automatic identity field mutation).
 * - Computes structured address & KYC income diffs; never auto-writes without explicit user confirmation.
 */
export function evaluateVerificationResult({
  customer,
  payload,
  cryptoChecks,
  acknowledged,
}: EvaluateRulesParams): BankRuleEvaluation {
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

  if (outcomeStatus !== 'SATISFIED') {
    checks.push({
      id: 'outcome_status',
      label: 'Rezultat verificare Verifier',
      status: 'FAIL',
      detail: `Statusul returnat a fost ${outcomeStatus} (atributele sunt ignorate conform politicii).`,
    });

    const isRefused = outcomeStatus === 'REFUSED';
    return {
      decision: 'UNHAPPY_PATH',
      reasonCode: isRefused ? 'PRESENTATION_REFUSED' : 'REQUIREMENT_NOT_SATISFIED',
      message: isRefused
        ? 'Ai ales să nu partajezi credențialele solicitate în EUDI Wallet. Profilul tău ZenBank a rămas neschimbat.'
        : 'Prezentarea din wallet nu a îndeplinit cerințele de verificare ZenBank. Profilul tău ZenBank a rămas neschimbat.',
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

  const parsed = parseVerifiedCredentials(payload);

  // Credential integrity check (issuerSignature, holderBinding, validity, trustedIssuer)
  if (parsed.integrityFailures.length > 0) {
    checks.push({
      id: 'credential_integrity',
      label: 'Verificări criptografice credențiale',
      status: 'FAIL',
      detail: `Verificări eșuate: ${parsed.integrityFailures.join(', ')}.`,
    });
    return {
      decision: 'SECURITY_BLOCKED',
      reasonCode: 'CREDENTIAL_INTEGRITY_FAILED',
      message:
        'Blocaj de securitate: unul sau mai multe credențiale nu au trecut verificările de semnătură emitent, legare deținător, validitate sau listă de încredere.',
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
      detail: `Validat issuerSignature=true, holderBinding=true, validity=true, trustedIssuer=true pentru ${parsed.integrityVerifiedCount} credențial(e)${authLabel}.`,
    });
  }

  // PID document expiry check (date_of_expiry)
  if (parsed.pidExpiryDate && /^\d{4}-\d{2}-\d{2}$/.test(parsed.pidExpiryDate)) {
    const today = new Date().toISOString().slice(0, 10);
    if (parsed.pidExpiryDate < today) {
      checks.push({
        id: 'pid_expiry',
        label: 'Valabilitate document PID',
        status: 'FAIL',
        detail: `PID-ul prezentat a expirat la ${parsed.pidExpiryDate}.`,
      });
      return {
        decision: 'SECURITY_BLOCKED',
        reasonCode: 'CREDENTIAL_EXPIRED',
        message:
          'Blocaj de securitate: documentul PID prezentat este expirat. Reînnoiește PID-ul în EUDI Wallet înainte de a actualiza profilul ZenBank.',
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
    checks.push({
      id: 'pid_expiry',
      label: 'Valabilitate document PID',
      status: 'PASS',
      detail: `Data de expirare PID (${parsed.pidExpiryDate}) este validă.`,
    });
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

  if (parsed.pidIdentity) {
    // Cross-credential subject association check (PID <-> Address & Income)
    const secondarySubjects: Array<{ label: string; subject: IdentitySubject }> = [];
    if (parsed.addressIdentity) {
      secondarySubjects.push({ label: 'atestarea de adresă', subject: parsed.addressIdentity });
    }
    if (parsed.incomeIdentity) {
      secondarySubjects.push({ label: 'atestarea de venit', subject: parsed.incomeIdentity });
    }

    for (const sec of secondarySubjects) {
      if (!subjectsMatch(parsed.pidIdentity, sec.subject)) {
        checks.push({
          id: 'cross_credential_binding',
          label: 'Asociere între credențiale (PID ↔ Adresă / Venit)',
          status: 'FAIL',
          detail: `Atributele de identitate din PID nu corespund cu titularul pentru ${sec.label}.`,
        });
        return {
          decision: 'SECURITY_BLOCKED',
          reasonCode: 'CROSS_CREDENTIAL_SUBJECT_MISMATCH',
          message:
            'Blocaj de securitate: credențialele prezentate aparțin unor persoane diferite. Profilul tău ZenBank nu a fost modificat.',
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
          canConfirmIdentityOnly: false,
        };
      }
    }

    if (secondarySubjects.length > 0) {
      checks.push({
        id: 'cross_credential_binding',
        label: 'Asociere între credențiale (PID ↔ Adresă / Venit)',
        status: 'PASS',
        detail: 'Credențialele cu atribute de titular au același nume, prenume și dată a nașterii.',
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

    // Customer record binding check
    const customerSubject: IdentitySubject = {
      givenName: customer.givenName,
      familyName: customer.familyName,
      birthdate: customer.birthdate,
    };
    if (!subjectsMatch(parsed.pidIdentity, customerSubject)) {
      checks.push({
        id: 'zenbank_customer_binding',
        label: 'Asociere identitate client ZenBank',
        status: 'FAIL',
        detail: 'Identitatea verificată în EUDI Wallet nu corespunde cu titularul contului ZenBank.',
      });
      return {
        decision: 'SECURITY_BLOCKED',
        reasonCode: 'CUSTOMER_SUBJECT_MISMATCH',
        message:
          'Blocaj de securitate: identitatea verificată în EUDI Wallet nu corespunde cu clientul autentificat în ZenBank. Actualizarea profilului a fost blocată.',
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
    checks.push({
      id: 'zenbank_customer_binding',
      label: 'Asociere identitate client ZenBank',
      status: 'WARN',
      detail:
        'Profilul sandbox a verificat atestarea PID fără nume/dată nașterii. Folosește un profil DISCLOSURE cu given_name/family_name/birthdate pentru asociere completă.',
    });
  }

  // Evaluate address & income disclosures independently so withholding one still preserves the other
  const addressWithheld =
    withheldFields.some((f) => f.toLowerCase().includes('address') || f.toLowerCase().includes('street')) ||
    !parsed.verifiedAddress ||
    (!parsed.verifiedAddress.streetAddress && !parsed.verifiedAddress.formatted);

  const incomeWithheld =
    withheldFields.some((f) => f.toLowerCase().includes('income') || f.toLowerCase().includes('bri')) ||
    !parsed.verifiedIncome;

  if (addressWithheld && incomeWithheld) {
    checks.push({
      id: 'profile_comparison',
      label: 'Comparație adresă și sursă venit',
      status: 'WARN',
      detail: 'Atât adresa cât și atestarea de venit au fost nepartajate; reconfirmarea identității rămâne disponibilă.',
    });
    return {
      decision: 'PARTIAL_IDENTITY_ONLY',
      reasonCode: 'ATTRIBUTES_WITHHELD',
      message:
        'Identitatea ta corespunde cu datele din ZenBank, însă adresa și atestarea de venit nu au fost partajate. Poți confirma reconfirmarea identității acum sau poți reîncerca partajarea.',
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
    };
  }

  const addressDiff = !addressWithheld && parsed.verifiedAddress
    ? computeAddressDiff(customer.currentAddress, parsed.verifiedAddress)
    : null;
  const incomeDiff = !incomeWithheld && parsed.verifiedIncome
    ? computeIncomeDiff(customer.currentIncome, parsed.verifiedIncome)
    : null;

  const hasAddressChanges = Boolean(addressDiff?.hasChanges);
  const hasIncomeChanges = Boolean(incomeDiff?.hasChanges);

  if (addressWithheld || incomeWithheld) {
    const missingLabel = addressWithheld ? 'adresa' : 'atestarea de venit';
    checks.push({
      id: 'profile_comparison',
      label: 'Comparație adresă și sursă venit',
      status: 'WARN',
      detail: `Atributele pentru ${missingLabel} nu au fost partajate; celelalte date verificate sunt pregătite pentru confirmare.`,
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

    return {
      decision: 'READY_FOR_CONFIRMATION',
      reasonCode: 'PROFILE_CHANGES_DETECTED',
      message: `Identitatea ta corespunde cu datele înregistrate la ZenBank. Am identificat actualizări verificate pentru ${changedLabels.join(' și ')}.`,
      checks,
      verifiedIdentity: parsed.pidIdentity,
      verifiedAddress: !addressWithheld ? parsed.verifiedAddress : null,
      verifiedIncome: !incomeWithheld ? parsed.verifiedIncome : null,
      addressDiff,
      incomeDiff,
      withheldFields,
      revocationStatus,
      canConfirmAddressUpdate: hasAddressChanges,
      canConfirmIncomeUpdate: hasIncomeChanges,
      canConfirmIdentityOnly: true,
    };
  }

  return {
    decision: 'NO_CHANGES_CONFIRM_IDENTITY',
    reasonCode: 'PROFILE_UNCHANGED',
    message:
      'Identitatea, adresa și sursa de venit corespund cu datele din ZenBank. Confirmă mai jos pentru a finaliza reconfirmarea identității.',
    checks,
    verifiedIdentity: parsed.pidIdentity,
    verifiedAddress: parsed.verifiedAddress,
    verifiedIncome: parsed.verifiedIncome,
    addressDiff,
    incomeDiff,
    withheldFields,
    revocationStatus,
    canConfirmAddressUpdate: false,
    canConfirmIncomeUpdate: false,
    canConfirmIdentityOnly: true,
  };
}
