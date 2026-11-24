import crypto from 'node:crypto';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import type { AppConfig } from '../config.js';
import { createApp } from '../server.js';
import { MockVerifierClient } from '../verifier/client.js';

describe('ZenBank EUDI API end-to-end journeys', () => {
  const issuer = 'https://verifier.example.test';
  const audience = 'org-aud-test';
  let orgPrivatePem = '';
  let orgPublicPem = '';

  beforeAll(() => {
    const pair = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    orgPrivatePem = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    orgPublicPem = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  });

  async function setupTestServer() {
    const mockVerifier = new MockVerifierClient({
      issuer,
      audience,
      orgPublicKeyPem: orgPublicPem,
    });
    const jwks = await mockVerifier.getJwksResolver();
    const config: AppConfig = {
      port: 0,
      verifierMode: 'mock',
      verifierUrl: issuer,
      verifierKey: 'vo_test',
      verifierSecret: 'sec_test',
      resultAudience: audience,
      profileCode: 'qa-both-23',
      resultPrivateKeyPem: orgPrivatePem,
      geminiApiKey: '',
      geminiModel: 'gemini-4-hydrogen',
      frontendDistDir: '/nonexistent-dist',
    };
    const { app } = await createApp(config, { verifierClient: mockVerifier, jwks });
    return { app, mockVerifier };
  }

  it('completes Happy Path: chat -> pre-consent -> real crypto JWE/JWS -> diff (address+income) -> explicit confirm -> ZenBank update', async () => {
    const { app, mockVerifier } = await setupTestServer();
    const sid = 'sess-happy-1';

    // 1. User requests personal data update in Romanian
    const chatRes = await request(app)
      .post('/api/chat')
      .set('X-Session-Id', sid)
      .send({ message: 'Vreau să-mi actualizez datele personale' });
    expect(chatRes.status).toBe(200);
    expect(chatRes.body.stage).toBe('PRE_CONSENT');
    expect(chatRes.body.messages.at(-1).card.type).toBe('pre_consent');
    expect(chatRes.body.messages.at(-1).card.requestedCredentials).toHaveLength(3);
    expect(chatRes.body.messages.at(-1).text).toContain('EUDI Wallet');

    // 2. Start EUDI verification
    const startRes = await request(app)
      .post('/api/verifications/start')
      .set('X-Session-Id', sid)
      .send({});
    expect(startRes.status).toBe(201);
    const txId = startRes.body.activeVerification.transactionId as string;

    // 3. Approve in mock wallet with new Address B + Income Attestation
    await mockVerifier.approveTransaction(txId, 'SATISFIED_BOTH');

    // 4. Poll picks up result, decrypts, verifies, deletes from verifier, and shows diff WITHOUT auto-updating ZenBank
    const pollRes = await request(app)
      .get(`/api/verifications/${txId}/poll`)
      .set('X-Session-Id', sid);
    expect(pollRes.status).toBe(200);
    expect(pollRes.body.stage).toBe('DIFF_READY');
    expect(pollRes.body.customer.id).toBe('radu');
    expect(pollRes.body.customer.currentAddress.streetAddress).toBe('Bulevardul Unirii 22');
    expect(pollRes.body.customer.currentIncome.employer).toBe('Nedeclarat / Necesită actualizare');

    const diffCard = pollRes.body.messages.at(-1).card;
    expect(diffCard.type).toBe('diff_confirm');
    expect(diffCard.verifiedAddress.streetAddress).toBe('Strada Exemplului 13');
    expect(diffCard.verifiedAddress.locality).toBe('Timișoara');
    expect(diffCard.verifiedAddress.postalCode).toBe('300001');
    expect(diffCard.verifiedIncome.employer).toBe('Example Services 4 SRL');
    expect(diffCard.verifiedIncome.bracket).toBe('15.000 – 20.000 RON / lună');

    // Verify DELETE /result removed the sealed token (RESULT_GONE on re-fetch)
    const refetch = await mockVerifier.fetchSealedResult(txId);
    expect(refetch.kind).toBe('gone');

    // 5. Explicit confirmation triggers mock ZenBank Customer Profile API update
    const confirmRes = await request(app)
      .post('/api/profile/confirm-update')
      .set('X-Session-Id', sid)
      .send({ pendingUpdateId: diffCard.pendingUpdateId, mode: 'UPDATE_PROFILE' });

    expect(confirmRes.status).toBe(200);
    expect(confirmRes.body.stage).toBe('COMPLETED');
    expect(confirmRes.body.customer.kycStatus).toBe('UP_TO_DATE');
    expect(confirmRes.body.customer.currentAddress.streetAddress).toBe('Strada Exemplului 13');
    expect(confirmRes.body.customer.currentIncome.employer).toBe('Example Services 4 SRL');
    expect(confirmRes.body.customer.currentIncome.bracket).toBe('15.000 – 20.000 RON / lună');
    expect(confirmRes.body.messages.at(-1).card.identityReconfirmed).toBe(true);
    expect(confirmRes.body.messages.at(-1).card.addressUpdated).toBe(true);
    expect(confirmRes.body.messages.at(-1).card.incomeUpdated).toBe(true);
  });

  it('deduplicates concurrent poll requests so overlapping 2s polls never trigger JTI_REPLAY', async () => {
    const { app, mockVerifier } = await setupTestServer();
    const sid = 'sess-concurrent-1';

    const startRes = await request(app)
      .post('/api/verifications/start')
      .set('X-Session-Id', sid)
      .send({});
    const txId = startRes.body.activeVerification.transactionId as string;

    await mockVerifier.approveTransaction(txId, 'SATISFIED_BOTH');

    const [pollA, pollB] = await Promise.all([
      request(app).get(`/api/verifications/${txId}/poll`).set('X-Session-Id', sid),
      request(app).get(`/api/verifications/${txId}/poll`).set('X-Session-Id', sid),
    ]);

    expect(pollA.status).toBe(200);
    expect(pollB.status).toBe(200);
    expect(pollA.body.stage).toBe('DIFF_READY');
    expect(pollB.body.stage).toBe('DIFF_READY');
  });

  it('completes Payment Restriction Recovery mini-demo via same EUDI engine', async () => {
    const { app, mockVerifier } = await setupTestServer();
    const sid = 'sess-restrict-1';

    const switchRes = await request(app)
      .post('/api/demo/scenario')
      .set('X-Session-Id', sid)
      .send({ customerId: 'radu', scenario: 'payment_restricted' });
    expect(switchRes.body.customer.paymentRestricted).toBe(true);

    const chatRes = await request(app)
      .post('/api/chat')
      .set('X-Session-Id', sid)
      .send({ message: 'De ce nu pot face plăți?' });
    expect(chatRes.body.stage).toBe('PRE_CONSENT');
    expect(chatRes.body.messages.at(-1).text).toContain('Am identificat motivul');
    expect(chatRes.body.messages.at(-1).card.type).toBe('pre_consent');

    const startRes = await request(app).post('/api/verifications/start').set('X-Session-Id', sid).send({});
    const txId = startRes.body.activeVerification.transactionId as string;
    await mockVerifier.approveTransaction(txId, 'SATISFIED_BOTH');

    const pollRes = await request(app).get(`/api/verifications/${txId}/poll`).set('X-Session-Id', sid);
    const pendingId = pollRes.body.messages.at(-1).card.pendingUpdateId as string;

    const confirmRes = await request(app)
      .post('/api/profile/confirm-update')
      .set('X-Session-Id', sid)
      .send({ pendingUpdateId: pendingId, mode: 'UPDATE_PROFILE' });

    expect(confirmRes.body.customer.paymentRestricted).toBe(false);
    expect(confirmRes.body.customer.kycStatus).toBe('UP_TO_DATE');
    expect(confirmRes.body.messages.at(-1).card.restrictionLifted).toBe(true);
  });

  it('blocks profile update when Maria Ionescu approves with Radu Stan wallet', async () => {
    const { app, mockVerifier } = await setupTestServer();
    const sid = 'sess-mismatch-1';

    await request(app)
      .post('/api/demo/scenario')
      .set('X-Session-Id', sid)
      .send({ customerId: 'maria', scenario: 'data_update' });

    const startRes = await request(app).post('/api/verifications/start').set('X-Session-Id', sid).send({});
    const txId = startRes.body.activeVerification.transactionId as string;
    await mockVerifier.approveTransaction(txId, 'SATISFIED_BOTH');

    const pollRes = await request(app).get(`/api/verifications/${txId}/poll`).set('X-Session-Id', sid);
    expect(pollRes.body.stage).toBe('BLOCKED');
    expect(pollRes.body.customer.id).toBe('maria');
    expect(pollRes.body.customer.kycStatus).toBe('RECONFIRMATION_NEEDED');
    expect(pollRes.body.messages.at(-1).card.code).toBe('CUSTOMER_SUBJECT_MISMATCH');
  });
});
