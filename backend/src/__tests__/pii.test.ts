import { describe, expect, it, vi } from 'vitest';
import { ZeroPiiAssistant, type GeminiTransport } from '../agent/geminiAssistant.js';
import { scrubUserMessage } from '../agent/piiScrubber.js';
import { createSeedCustomer } from '../banking/mockZenBankCore.js';
import { redactObject, redactString } from '../logging.js';

describe('Zero-PII boundary & log redaction', () => {
  it('scrubs customer PII, IBAN, CNP, dates, employer, and JOSE tokens from chat input', () => {
    const radu = createSeedCustomer('radu', 'data_update');
    const rawMsg =
      'Salut, sunt Radu Stan născut 1986-06-08 pe Bulevardul Unirii 22, CNP 1860608000040, IBAN RO49AAAA1B31007593840000, angajator Example Services 4 SRL, token eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghijk';

    const { scrubbedText, hadPii } = scrubUserMessage(rawMsg, radu, [
      'Example Services 4 SRL',
      '16225',
    ]);

    expect(hadPii).toBe(true);
    expect(scrubbedText.toLowerCase()).not.toContain('radu');
    expect(scrubbedText.toLowerCase()).not.toContain('stan');
    expect(scrubbedText).not.toContain('1986-06-08');
    expect(scrubbedText.toLowerCase()).not.toContain('unirii');
    expect(scrubbedText).not.toContain('1860608000040');
    expect(scrubbedText).not.toContain('RO49AAAA1B31007593840000');
    expect(scrubbedText.toLowerCase()).not.toContain('example services');
    expect(scrubbedText).not.toContain('16225');
    expect(scrubbedText).not.toContain('eyJhbGci');
  });

  it('sends zero customer PII (including employer and salary) to Gemini transport across free-text queries', async () => {
    const radu = createSeedCustomer('radu', 'payment_restricted');
    const sentPayloads: string[] = [];

    const spyTransport: GeminiTransport = {
      generateJson: vi.fn(async ({ input, systemInstruction }) => {
        sentPayloads.push(systemInstruction);
        sentPayloads.push(input);
        return { intent: 'EXPLAIN_PRIVACY', reply: 'ZenBank verifică doar atributele minime.' };
      }),
    };

    const assistant = new ZeroPiiAssistant({
      transport: spyTransport,
      model: 'gemini-4-hydrogen',
    });

    await assistant.respond({
      userMessage:
        'Sunt Radu Stan (1986-06-08), CNP 1860608000040, locuiesc la Bulevardul Unirii 22, 030133, lucrez la Example Services 4 SRL cu 16225 RON. De ce aveți nevoie de aceste date?',
      customer: radu,
      stage: 'PRE_CONSENT',
      extraForbiddenPii: ['Strada Exemplului 13', '300001', 'Example Services 4 SRL', '16225'],
    });

    expect(sentPayloads.length).toBe(2);
    const inputPayload = sentPayloads[1].toLowerCase();
    for (const forbidden of [
      'radu',
      'stan',
      '1986-06-08',
      '1860608000040',
      'unirii',
      '030133',
      'exemplului',
      '300001',
      'example services',
      '16225',
      'eu••••4821',
    ]) {
      expect(inputPayload).not.toContain(forbidden);
    }
  });

  it('calls Gemini for quickAction chips while locking deterministic intent and zero PII', async () => {
    const radu = createSeedCustomer('radu', 'data_update');
    const sentInputs: string[] = [];

    const spyTransport: GeminiTransport = {
      generateJson: vi.fn(async ({ input }) => {
        sentInputs.push(input);
        return {
          intent: 'GENERAL',
          reply: 'Profilul tău ZenBank necesită actualizarea datelor prin EUDI Wallet.',
        };
      }),
    };

    const assistant = new ZeroPiiAssistant({
      transport: spyTransport,
      model: 'gemini-4-hydrogen',
    });

    const reply = await assistant.respond({
      userMessage: 'De ce nu pot face plăți?',
      quickAction: 'EXPLAIN_PAYMENT_RESTRICTION',
      customer: radu,
      stage: 'IDLE',
      extraForbiddenPii: ['Example Services 4 SRL', '16225'],
    });

    expect(sentInputs).toHaveLength(1);
    expect(reply.usedGemini).toBe(true);
    expect(reply.intent).toBe('EXPLAIN_PAYMENT_RESTRICTION');
    expect(reply.reply).toContain('EUDI Wallet');
    expect(sentInputs[0].toLowerCase()).not.toContain('radu');
    expect(sentInputs[0].toLowerCase()).not.toContain('unirii');
  });

  it('redacts secrets, PEMs, JWEs, evidence, income/employer keys, and PII keys in logs', () => {
    const redactedObj = redactObject({
      secret: 'super-secret-value',
      given_name: 'RADU',
      personal_numeric_code: '1860608000040',
      employer: 'Example Services 4 SRL',
      legal_name: 'Example Services 4 SRL',
      net_amount_minor: 1622500,
      monthly_income: { currency: 'RON' },
      evidence: { 'pid_ro_sandbox_sd-jwt-vc': ['eyJhbGciOiJFUzI1NiJ9.eyJhIjoxfQ.1234567890abcdef'] },
      claims: { birthdate: '1986-06-08' },
      note: 'Bearer eyJhbGciOiJFUzI1NiJ9.eyJhIjoxfQ.1234567890abcdef and vo_DummyWebsiteKey123456',
    }) as Record<string, unknown>;

    expect(redactedObj.secret).toBe('[REDACTED]');
    expect(redactedObj.given_name).toBe('[REDACTED]');
    expect(redactedObj.personal_numeric_code).toBe('[REDACTED]');
    expect(redactedObj.employer).toBe('[REDACTED]');
    expect(redactedObj.legal_name).toBe('[REDACTED]');
    expect(redactedObj.net_amount_minor).toBe('[REDACTED]');
    expect(redactedObj.monthly_income).toBe('[REDACTED]');
    expect(redactedObj.evidence).toBe('[REDACTED]');
    expect(redactedObj.claims).toBe('[REDACTED]');
    expect(String(redactedObj.note)).not.toContain('eyJhbGci');
    expect(String(redactedObj.note)).not.toContain('vo_DummyWebsiteKey');

    expect(redactString('-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----')).toBe(
      '[REDACTED_PEM]',
    );
  });
});
