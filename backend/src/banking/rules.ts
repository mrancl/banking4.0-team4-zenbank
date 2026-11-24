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
}

/**
 * Deterministic ZenBank rules engine:
 * - Never reads claims unless outcome.status === 'SATISFIED'.
 * - Enforces credential cryptographic checks (issuerSignature, holderBinding, validity, trustedIssuer) and expiry.
 * - Verifies cross-credential subject binding (PID <-> Address / Income) and ZenBank customer binding when PID is requested.
 * - Supports dynamic minimal profile scopes ('full', 'address', 'income').
 * - Enforces revocation=NOT_CHECKED policy (no automatic identity field mutation).
 * - Computes structured address & KYC income diffs; never auto-writes without explicit user confirmation.
 */
export function evaluateVerificationResult({
  customer,
  payload,
  cryptoChecks,
  acknowledged,
  requestedScope = 'full',
}: EvaluateRulesParams): BankRuleEvaluation {
  const scope: VerificationScope = requestedScope;
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
          'Documentul tău de identitate din EUDI Wallet este expirat. Te rugăm să îl reînnoiești înainte de a actualiza profilul ZenBank.',
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
            'Datele trimise din EUDI Wallet par să aparțină unor persoane diferite, așa că nu putem actualiza profilul.',
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
          'Identitatea din EUDI Wallet nu corespunde titularului acestui cont ZenBank. Pentru siguranța ta, actualizarea a fost blocată.',
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
  } else if (scope === 'full') {
    checks.push({
      id: 'zenbank_customer_binding',
      label: 'Asociere identitate client ZenBank',
      status: 'WARN',
      detail:
        'Profilul sandbox a verificat atestarea PID fără nume/dată nașterii. Folosește un profil DISCLOSURE cu given_name/family_name/birthdate pentru asociere completă.',
    });
  }

  // When qa-income-23 omits payer.legal_name / income_type, preserve existing employer/source while updating bracket
  let effectiveIncome: KycIncomeProfile | null = parsed.verifiedIncome;
  if (scope === 'income' && parsed.verifiedIncome) {
    const preserveEmployer =
      !parsed.verifiedIncome.employer || parsed.verifiedIncome.employer === 'Neconfirmat';
    const preserveSource = parsed.verifiedIncome.source === 'Venit declarat';
    effectiveIncome = {
      ...parsed.verifiedIncome,
      employer: preserveEmployer ? customer.currentIncome.employer : parsed.verifiedIncome.employer,
      source: preserveSource ? customer.currentIncome.source : parsed.verifiedIncome.source,
    };
  }

  // Evaluate address & income disclosures independently according to the requested minimal scope
  const expectAddress = scope !== 'income';
  const expectIncome = scope !== 'address';
  const canConfirmIdentityOnly = Boolean(parsed.pidIdentity);

  const addressWithheld =
    expectAddress &&
    (withheldFields.some((f) => f.toLowerCase().includes('address') || f.toLowerCase().includes('street')) ||
      !parsed.verifiedAddress ||
      (!parsed.verifiedAddress.streetAddress && !parsed.verifiedAddress.formatted));

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
    };
  }

  const addressDiff =
    expectAddress && !addressWithheld && parsed.verifiedAddress
      ? computeAddressDiff(customer.currentAddress, parsed.verifiedAddress)
      : null;
  const incomeDiff =
    expectIncome && !incomeWithheld && effectiveIncome
      ? computeIncomeDiff(customer.currentIncome, effectiveIncome)
      : null;

  const hasAddressChanges = Boolean(addressDiff?.hasChanges);
  const hasIncomeChanges = Boolean(incomeDiff?.hasChanges);

  if (addressWithheld || incomeWithheld) {
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
      verifiedAddress: expectAddress && !addressWithheld ? parsed.verifiedAddress : null,
      verifiedIncome: expectIncome && !incomeWithheld ? effectiveIncome : null,
      addressDiff,
      incomeDiff,
      withheldFields,
      revocationStatus,
      canConfirmAddressUpdate: hasAddressChanges,
      canConfirmIncomeUpdate: hasIncomeChanges,
      canConfirmIdentityOnly,
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
    verifiedAddress: expectAddress && !addressWithheld ? parsed.verifiedAddress : null,
    verifiedIncome: expectIncome && !incomeWithheld ? effectiveIncome : null,
    addressDiff,
    incomeDiff,
    withheldFields,
    revocationStatus,
    canConfirmAddressUpdate: false,
    canConfirmIncomeUpdate: false,
    canConfirmIdentityOnly,
  };
}
