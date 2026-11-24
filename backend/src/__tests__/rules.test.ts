import { describe, expect, it } from 'vitest';
import { createSeedCustomer } from '../banking/mockZenBankCore.js';
import { evaluateVerificationResult } from '../banking/rules.js';
import type { DecryptedVerificationPayload } from '../types.js';

describe('evaluateVerificationResult & claimsParser', () => {
  it('computes Address A -> Address B diff for matching Alex Popescu (nested claims)', () => {
    const alex = createSeedCustomer('alex', 'data_update');
    const payload: DecryptedVerificationPayload = {
      schema: 'eudi-verification-result/v1',
      transactionId: 'tx-1',
      outcome: { status: 'SATISFIED', basis: 'DISCLOSURE' },
      credentials: [
        {
          type: 'PID',
          documentType: 'urn:eudi:pid:1',
          claims: { given_name: 'ALEX', family_name: 'POPESCU', birthdate: '1990-05-15' },
          checks: { status: 'NOT_CHECKED' },
        },
        {
          type: 'ADDRESS',
          documentType: 'urn:banking40:sandbox:address:1',
          claims: {
            given_name: 'Alex',
            family_name: 'Popescu',
            birthdate: '1990-05-15',
            address: {
              street_address: 'Strada Exemplului 10',
              locality: 'Bucuresti',
              postal_code: '010101',
              country: 'Romania',
            },
          },
          checks: { status: 'NOT_CHECKED' },
        },
      ],
    };

    const res = evaluateVerificationResult({
      customer: alex,
      payload,
      cryptoChecks: [],
      acknowledged: true,
    });

    expect(res.decision).toBe('READY_FOR_CONFIRMATION');
    expect(res.canConfirmAddressUpdate).toBe(true);
    expect(res.addressDiff?.hasChanges).toBe(true);
    expect(res.addressDiff?.changedFields).toEqual(['streetAddress', 'postalCode']);
    expect(res.checks.some((c) => c.id === 'revocation_policy' && c.status === 'WARN')).toBe(true);
  });

  it('supports flat-dotted claim keys and detects NO_CHANGES_CONFIRM_IDENTITY', () => {
    const alex = createSeedCustomer('alex', 'data_update');
    const payload: DecryptedVerificationPayload = {
      outcome: { status: 'SATISFIED' },
      credentials: [
        {
          documentType: 'urn:eudi:pid:ro:1',
          claims: { given_name: 'ALEX', family_name: 'POPESCU', birthdate: '1990-05-15' },
          checks: { status: 'NOT_CHECKED' },
        },
        {
          documentType: 'urn:banking40:sandbox:address:1',
          claims: {
            'address.street_address': 'Bulevardul Unirii 22',
            'address.locality': 'București',
            'address.postal_code': '030133',
            'address.country': 'România',
          },
          checks: { status: 'NOT_CHECKED' },
        },
      ],
    };

    const res = evaluateVerificationResult({
      customer: alex,
      payload,
      cryptoChecks: [],
      acknowledged: true,
    });

    expect(res.decision).toBe('NO_CHANGES_CONFIRM_IDENTITY');
    expect(res.addressDiff?.hasChanges).toBe(false);
    expect(res.canConfirmIdentityOnly).toBe(true);
  });

  it('blocks Maria Ionescu session when Alex Popescu wallet presentation is SATISFIED', () => {
    const maria = createSeedCustomer('maria', 'data_update');
    const payload: DecryptedVerificationPayload = {
      outcome: { status: 'SATISFIED' },
      credentials: [
        {
          documentType: 'urn:eudi:pid:1',
          claims: { given_name: 'ALEX', family_name: 'POPESCU', birthdate: '1990-05-15' },
        },
      ],
    };

    const res = evaluateVerificationResult({
      customer: maria,
      payload,
      cryptoChecks: [],
      acknowledged: true,
    });

    expect(res.decision).toBe('SECURITY_BLOCKED');
    expect(res.reasonCode).toBe('CUSTOMER_SUBJECT_MISMATCH');
  });

  it('blocks when PID and Address belong to different subjects (cross-credential mismatch)', () => {
    const alex = createSeedCustomer('alex', 'data_update');
    const payload: DecryptedVerificationPayload = {
      outcome: { status: 'SATISFIED' },
      credentials: [
        {
          documentType: 'urn:eudi:pid:1',
          claims: { given_name: 'ALEX', family_name: 'POPESCU', birthdate: '1990-05-15' },
        },
        {
          documentType: 'urn:banking40:sandbox:address:1',
          claims: {
            given_name: 'ION',
            family_name: 'POPESCU',
            birthdate: '1990-05-15',
            address: {
              street_address: 'Strada Exemplului 10',
              locality: 'București',
              postal_code: '010101',
              country: 'România',
            },
          },
        },
      ],
    };

    const res = evaluateVerificationResult({
      customer: alex,
      payload,
      cryptoChecks: [],
      acknowledged: true,
    });

    expect(res.decision).toBe('SECURITY_BLOCKED');
    expect(res.reasonCode).toBe('CROSS_CREDENTIAL_SUBJECT_MISMATCH');
  });

  it('handles withheld address and income gracefully with PARTIAL_IDENTITY_ONLY', () => {
    const alex = createSeedCustomer('alex', 'data_update');
    const payload: DecryptedVerificationPayload = {
      outcome: { status: 'SATISFIED', withheld: ['address.street_address', 'monthly_income'] },
      credentials: [
        {
          documentType: 'urn:eudi:pid:1',
          claims: { given_name: 'ALEX', family_name: 'POPESCU', birthdate: '1990-05-15' },
        },
      ],
    };

    const res = evaluateVerificationResult({
      customer: alex,
      payload,
      cryptoChecks: [],
      acknowledged: true,
    });

    expect(res.decision).toBe('PARTIAL_IDENTITY_ONLY');
    expect(res.canConfirmAddressUpdate).toBe(false);
    expect(res.canConfirmIncomeUpdate).toBe(false);
    expect(res.canConfirmIdentityOnly).toBe(true);
  });

  it('never reads claims when outcome.status is REFUSED or NOT_SATISFIED', () => {
    const alex = createSeedCustomer('alex', 'data_update');
    for (const status of ['REFUSED', 'NOT_SATISFIED']) {
      const res = evaluateVerificationResult({
        customer: alex,
        payload: {
          outcome: { status },
          credentials: [
            {
              documentType: 'urn:eudi:pid:1',
              claims: { given_name: 'ALEX', family_name: 'POPESCU', birthdate: '1990-05-15' },
            },
          ],
        },
        cryptoChecks: [],
        acknowledged: true,
      });

      expect(res.decision).toBe('UNHAPPY_PATH');
      expect(res.verifiedIdentity).toBeNull();
      expect(res.verifiedAddress).toBeNull();
      expect(res.verifiedIncome).toBeNull();
    }
  });

  it('handles limited PID attestation + formatted address + income claims without dropping updates', () => {
    const alex = createSeedCustomer('alex', 'data_update');
    const payload: DecryptedVerificationPayload = {
      schema: 'eudi-verification-result/v1',
      transactionId: 'tx-qa-both-23',
      outcome: { status: 'SATISFIED', basis: 'DISCLOSURE' },
      credentials: [
        {
          type: 'PID_RO_SANDBOX',
          format: 'dc+sd-jwt',
          claims: { 'age_equal_or_over.18': true },
          checks: { status: 'NOT_CHECKED' },
        },
        {
          type: 'ADDRESS',
          format: 'dc+sd-jwt',
          claims: { 'address.formatted': 'Strada Exemplului 10, 010101 București, România' },
          checks: { status: 'NOT_CHECKED' },
        },
        {
          type: 'INCOME_ATTESTATION',
          format: 'dc+sd-jwt',
          claims: {
            'monthly_income.periods': [{ month: '2026-10', net_amount_minor: 1650000 }],
            'monthly_income.currency': 'RON',
            'monthly_income.income_type': 'salary',
            'monthly_income.payer.legal_name': 'Example Services 4 SRL',
          },
          checks: { status: 'NOT_CHECKED' },
        },
      ],
    };

    const res = evaluateVerificationResult({
      customer: alex,
      payload,
      cryptoChecks: [],
      acknowledged: true,
    });

    expect(res.decision).toBe('READY_FOR_CONFIRMATION');
    expect(res.verifiedAddress?.streetAddress).toBe('Strada Exemplului 10');
    expect(res.verifiedAddress?.postalCode).toBe('010101');
    expect(res.verifiedAddress?.locality).toBe('București');
    expect(res.verifiedAddress?.country).toBe('România');
    expect(res.verifiedIncome?.employer).toBe('Example Services 4 SRL');
    expect(res.verifiedIncome?.bracket).toBe('15.000 – 20.000 RON / lună');
    expect(res.addressDiff?.changedFields).toEqual(['streetAddress', 'postalCode']);
    expect(res.checks.some((c) => c.id === 'data_minimization_filter' && c.status === 'INFO')).toBe(true);
    expect(res.checks.some((c) => c.id === 'zenbank_customer_binding' && c.status === 'WARN')).toBe(true);
  });

  it('validates real Team 04 live payload (Radu Stan, Address + Income Attestation, checks booleans, expiry)', () => {
    const radu = createSeedCustomer('radu', 'data_update');
    const maria = createSeedCustomer('maria', 'data_update');

    const realShape: DecryptedVerificationPayload = {
      schema: 'eudi-verification-result/v1',
      transactionId: '5a9848ba-f914-4d09-8949-1af4196cdae2',
      outcome: { status: 'SATISFIED', basis: 'DISCLOSURE', withheld: [] },
      credentials: [
        {
          type: 'PID_RO_SANDBOX',
          format: 'dc+sd-jwt',
          documentType: 'urn:banking40:sandbox:pid-ro:1',
          claims: {
            age_equal_or_over: { '18': true },
            birthdate: '1986-06-08',
            given_name: 'RADU',
            family_name: 'STAN',
            place_of_birth: { country: 'RO', locality: 'Mun.Timișoara' },
            date_of_issuance: '2026-11-24',
            issuing_country: 'RO',
            date_of_expiry: '2030-11-23',
            personal_numeric_code: '1860608000040',
            nationalities: ['RO'],
          },
          issuer: { country: 'RO', authority: 'Banking 4.0 Sandbox' },
          checks: {
            issuerSignature: true,
            holderBinding: true,
            validity: true,
            trustedIssuer: true,
            status: 'NOT_CHECKED',
          },
        },
        {
          type: 'ADDRESS',
          format: 'dc+sd-jwt',
          documentType: 'urn:banking40:sandbox:address:1',
          claims: {
            address: { formatted: 'Strada Exemplului 13, 300001 Timișoara, România' },
          },
          issuer: { country: 'RO', authority: 'Banking 4.0 Sandbox' },
          checks: {
            issuerSignature: true,
            holderBinding: true,
            validity: true,
            trustedIssuer: true,
            status: 'NOT_CHECKED',
          },
        },
        {
          type: 'INCOME_ATTESTATION',
          format: 'dc+sd-jwt',
          documentType: 'urn:banking40:sandbox:income:1',
          claims: {
            monthly_income: {
              periods: [
                { month: '2026-05', net_amount_minor: 1622500 },
                { month: '2026-06', net_amount_minor: 1642500 },
                { month: '2026-07', net_amount_minor: 1622500 },
                { month: '2026-08', net_amount_minor: 1672500 },
                { month: '2026-09', net_amount_minor: 1652500 },
                { month: '2026-10', net_amount_minor: 1662500 },
              ],
              currency: 'RON',
              income_type: 'salary',
              payer: { legal_name: 'Example Services 4 SRL' },
            },
          },
          issuer: { country: 'RO', authority: 'Banking 4.0 Sandbox' },
          checks: {
            issuerSignature: true,
            holderBinding: true,
            validity: true,
            trustedIssuer: true,
            status: 'NOT_CHECKED',
          },
        },
      ],
    };

    const ok = evaluateVerificationResult({
      customer: radu,
      payload: realShape,
      cryptoChecks: [],
      acknowledged: true,
    });
    expect(ok.decision).toBe('READY_FOR_CONFIRMATION');
    expect(ok.checks.some((c) => c.id === 'zenbank_customer_binding' && c.status === 'PASS')).toBe(true);
    expect(ok.checks.some((c) => c.id === 'credential_integrity' && c.status === 'PASS')).toBe(true);
    expect(ok.checks.some((c) => c.id === 'pid_expiry' && c.status === 'PASS')).toBe(true);
    expect(ok.checks.some((c) => c.id === 'data_minimization_filter' && c.status === 'INFO')).toBe(true);
    expect(ok.addressDiff?.changedFields).toEqual(['streetAddress', 'locality', 'postalCode']);
    expect(ok.canConfirmIncomeUpdate).toBe(true);
    expect(ok.incomeDiff?.changedFields).toEqual(['employer', 'bracket']);
    expect(ok.verifiedIncome?.employer).toBe('Example Services 4 SRL');
    expect(ok.verifiedIncome?.bracket).toBe('15.000 – 20.000 RON / lună');
    expect(ok.verifiedIncome?.basisLabel).toContain('2026-05 – 2026-10');

    // Failed holderBinding -> SECURITY_BLOCKED
    const badBinding = structuredClone(realShape);
    badBinding.credentials![0].checks!.holderBinding = false;
    const blockedBinding = evaluateVerificationResult({
      customer: radu,
      payload: badBinding,
      cryptoChecks: [],
      acknowledged: true,
    });
    expect(blockedBinding.decision).toBe('SECURITY_BLOCKED');
    expect(blockedBinding.reasonCode).toBe('CREDENTIAL_INTEGRITY_FAILED');

    // Expired PID -> SECURITY_BLOCKED
    const expiredPid = structuredClone(realShape);
    expiredPid.credentials![0].claims!.date_of_expiry = '2020-01-01';
    const blockedExpired = evaluateVerificationResult({
      customer: radu,
      payload: expiredPid,
      cryptoChecks: [],
      acknowledged: true,
    });
    expect(blockedExpired.decision).toBe('SECURITY_BLOCKED');
    expect(blockedExpired.reasonCode).toBe('CREDENTIAL_EXPIRED');

    // Maria Ionescu logged in -> CUSTOMER_SUBJECT_MISMATCH
    const blockedCustomer = evaluateVerificationResult({
      customer: maria,
      payload: realShape,
      cryptoChecks: [],
      acknowledged: true,
    });
    expect(blockedCustomer.decision).toBe('SECURITY_BLOCKED');
    expect(blockedCustomer.reasonCode).toBe('CUSTOMER_SUBJECT_MISMATCH');
  });

  it('supports FIDES BRI annual tax-year fallback with explicit annual caveat and subject binding', () => {
    const alex = createSeedCustomer('alex', 'data_update');
    const payload: DecryptedVerificationPayload = {
      outcome: { status: 'SATISFIED', basis: 'DISCLOSURE' },
      credentials: [
        {
          type: 'PID',
          documentType: 'urn:eudi:pid:1',
          claims: { given_name: 'ALEX', family_name: 'POPESCU', birthdate: '1990-05-15' },
        },
        {
          type: 'INCOME_ATTESTATION',
          documentType: 'urn:org:fides:nl_bld_bri:1',
          claims: {
            subject: { given_name: 'ALEX', family_name: 'POPESCU', birthdate: '1990-05-15' },
            nl_bld_bri: { year: 2025, income: 48000 },
          },
        },
      ],
    };

    const res = evaluateVerificationResult({
      customer: alex,
      payload,
      cryptoChecks: [],
      acknowledged: true,
    });

    expect(res.decision).toBe('READY_FOR_CONFIRMATION');
    expect(res.canConfirmIncomeUpdate).toBe(true);
    expect(res.verifiedIncome?.source).toBe('Venit anual raportat fiscal');
    expect(res.verifiedIncome?.bracket).toContain('48');
    expect(res.verifiedIncome?.bracket).toContain('EUR / an fiscal 2025');
    expect(res.verifiedIncome?.basisLabel).toContain('nu salariu lunar net');
  });

  it('supports minimal address-only profile (qa-address-23) with ADDRESS attestation and no PID', () => {
    const radu = createSeedCustomer('radu', 'data_update');
    const payload: DecryptedVerificationPayload = {
      schema: 'eudi-verification-result/v1',
      transactionId: 'tx-qa-address-23',
      outcome: { status: 'SATISFIED', basis: 'DISCLOSURE' },
      credentials: [
        {
          type: 'ADDRESS',
          format: 'dc+sd-jwt',
          documentType: 'urn:banking40:sandbox:address:1',
          claims: {
            address: {
              formatted: 'Strada Exemplului 13, 300001 Timișoara, România',
            },
          },
          issuer: { country: 'RO', authority: 'Banking 4.0 Sandbox' },
          checks: {
            issuerSignature: true,
            holderBinding: true,
            validity: true,
            trustedIssuer: true,
            status: 'NOT_CHECKED',
          },
        },
      ],
    };

    const res = evaluateVerificationResult({
      customer: radu,
      payload,
      cryptoChecks: [],
      acknowledged: true,
      requestedScope: 'address',
    });

    expect(res.decision).toBe('READY_FOR_CONFIRMATION');
    expect(res.canConfirmAddressUpdate).toBe(true);
    expect(res.canConfirmIncomeUpdate).toBe(false);
    expect(res.canConfirmIdentityOnly).toBe(false);
    expect(res.verifiedAddress?.streetAddress).toBe('Strada Exemplului 13');
    expect(res.verifiedIncome).toBeNull();
    expect(res.incomeDiff).toBeNull();
    expect(res.checks.some((c) => c.id === 'zenbank_customer_binding' && c.status === 'INFO')).toBe(true);
  });
});
