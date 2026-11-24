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
      webReturnUri: '',
      nativeReturnUri: 'ro.banking40.team04://same-device',
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

  it('completes direct Client Info update flow without touching Chat message history', async () => {
    const { app, mockVerifier } = await setupTestServer();
    const sid = 'sess-profile-direct-1';

    const startProfile = await request(app)
      .post('/api/profile/start-update')
      .set('X-Session-Id', sid)
      .send({});
    expect(startProfile.status).toBe(200);
    expect(startProfile.body.flowChannel).toBe('profile');
    expect(startProfile.body.stage).toBe('PRE_CONSENT');
    expect(startProfile.body.activeFlowCard.type).toBe('pre_consent');
    expect(startProfile.body.messages).toHaveLength(1);

    const startRes = await request(app)
      .post('/api/verifications/start')
      .set('X-Session-Id', sid)
      .send({});
    expect(startRes.status).toBe(201);
    expect(startRes.body.flowChannel).toBe('profile');
    expect(startRes.body.activeFlowCard.type).toBe('wallet_qr');
    expect(startRes.body.messages).toHaveLength(1);

    const txId = startRes.body.activeVerification.transactionId as string;
    await mockVerifier.approveTransaction(txId, 'SATISFIED_BOTH');

    const pollRes = await request(app)
      .get(`/api/verifications/${txId}/poll`)
      .set('X-Session-Id', sid);
    expect(pollRes.status).toBe(200);
    expect(pollRes.body.stage).toBe('DIFF_READY');
    expect(pollRes.body.flowChannel).toBe('profile');
    expect(pollRes.body.activeFlowCard.type).toBe('diff_confirm');
    expect(pollRes.body.messages).toHaveLength(1);

    const pendingId = pollRes.body.activeFlowCard.pendingUpdateId as string;
    const confirmRes = await request(app)
      .post('/api/profile/confirm-update')
      .set('X-Session-Id', sid)
      .send({ pendingUpdateId: pendingId, mode: 'UPDATE_PROFILE' });
    expect(confirmRes.status).toBe(200);
    expect(confirmRes.body.stage).toBe('COMPLETED');
    expect(confirmRes.body.flowChannel).toBe('profile');
    expect(confirmRes.body.activeFlowCard.type).toBe('completed');
    expect(confirmRes.body.customer.kycStatus).toBe('UP_TO_DATE');
    expect(confirmRes.body.customer.currentAddress.streetAddress).toBe('Strada Exemplului 13');
    expect(confirmRes.body.customer.currentIncome.employer).toBe('Example Services 4 SRL');
    expect(confirmRes.body.messages).toHaveLength(1);
  });

  it('activates blocked payments on Chat payment inquiry only when update is needed and clears it after update', async () => {
    const { app, mockVerifier } = await setupTestServer();
    const sid = 'sess-chat-payment-need-update';

    const chatBefore = await request(app)
      .post('/api/chat')
      .set('X-Session-Id', sid)
      .send({ message: "why can't I initiate a payment?" });

    expect(chatBefore.status).toBe(200);
    expect(chatBefore.body.customer.paymentRestricted).toBe(true);
    expect(chatBefore.body.customer.kycStatus).toBe('INCOMPLETE_UPDATE');
    expect(chatBefore.body.flowChannel).toBe('chat');
    expect(chatBefore.body.stage).toBe('PRE_CONSENT');
    const msgBefore = chatBefore.body.messages.at(-1);
    expect(msgBefore.accountCheck.dataUpdateRequired).toBe(true);
    expect(msgBefore.accountCheck.paymentRestricted).toBe(true);
    expect(msgBefore.accountCheck.missingItems.length).toBeGreaterThan(0);
    expect(msgBefore.card.type).toBe('pre_consent');

    // Complete full EUDI update so customer profile reaches UP_TO_DATE and payment restriction lifts
    const startRes = await request(app).post('/api/verifications/start').set('X-Session-Id', sid).send({});
    const txId = startRes.body.activeVerification.transactionId as string;
    await mockVerifier.approveTransaction(txId, 'SATISFIED_BOTH');
    const pollRes = await request(app).get(`/api/verifications/${txId}/poll`).set('X-Session-Id', sid);
    const pendingId = pollRes.body.activeFlowCard.pendingUpdateId as string;
    const confirmRes = await request(app)
      .post('/api/profile/confirm-update')
      .set('X-Session-Id', sid)
      .send({ pendingUpdateId: pendingId, mode: 'UPDATE_PROFILE' });
    expect(confirmRes.body.customer.paymentRestricted).toBe(false);
    expect(confirmRes.body.customer.kycStatus).toBe('UP_TO_DATE');
    expect(confirmRes.body.messages.at(-1).card.restrictionLifted).toBe(true);

    // Ask again after profile is fully UP_TO_DATE -> verifies profile is OK and does NOT re-initiate EUDI
    const chatAfter = await request(app)
      .post('/api/chat')
      .set('X-Session-Id', sid)
      .send({ message: "why can't I initiate a payment?" });

    expect(chatAfter.status).toBe(200);
    expect(chatAfter.body.stage).toBe('COMPLETED');
    expect(chatAfter.body.customer.paymentRestricted).toBe(false);
    const msgAfter = chatAfter.body.messages.at(-1);
    expect(msgAfter.accountCheck.dataUpdateRequired).toBe(false);
    expect(msgAfter.accountCheck.checks.every((c: { status: string }) => c.status === 'OK')).toBe(true);
    expect(msgAfter.card).toBeUndefined();
  });

  it('dynamically routes address-only chat intent to qa-address-23 without requesting income', async () => {
    const { app, mockVerifier } = await setupTestServer();
    const sid = 'sess-dynamic-addr';

    const chatRes = await request(app)
      .post('/api/chat')
      .set('X-Session-Id', sid)
      .send({ message: 'Mi-am schimbat adresa' });
    expect(chatRes.status).toBe(200);
    expect(chatRes.body.selectedScope).toBe('address');
    expect(chatRes.body.selectedProfileCode).toBe('qa-address-23');
    expect(chatRes.body.stage).toBe('PRE_CONSENT');
    expect(chatRes.body.activeFlowCard.profileCode).toBe('qa-address-23');
    expect(chatRes.body.activeFlowCard.requestedCredentials).toHaveLength(1);

    const startRes = await request(app)
      .post('/api/verifications/start')
      .set('X-Session-Id', sid)
      .send({});
    expect(startRes.status).toBe(201);
    expect(startRes.body.activeFlowCard.profileCode).toBe('qa-address-23');

    const txId = startRes.body.activeVerification.transactionId as string;
    await mockVerifier.approveTransaction(txId, 'SATISFIED_ADDRESS_ONLY');

    const pollRes = await request(app)
      .get(`/api/verifications/${txId}/poll`)
      .set('X-Session-Id', sid);
    expect(pollRes.status).toBe(200);
    expect(pollRes.body.stage).toBe('DIFF_READY');
    expect(pollRes.body.activeFlowCard.addressDiff.hasChanges).toBe(true);
    expect(pollRes.body.activeFlowCard.incomeDiff).toBeNull();
    expect(pollRes.body.activeFlowCard.identityMatched).toBe(false);
    expect(pollRes.body.activeFlowCard.canConfirmIdentityOnly).toBe(false);

    const confirmRes = await request(app)
      .post('/api/profile/confirm-update')
      .set('X-Session-Id', sid)
      .send({ pendingUpdateId: pollRes.body.activeFlowCard.pendingUpdateId, mode: 'UPDATE_PROFILE' });
    expect(confirmRes.status).toBe(200);
    expect(confirmRes.body.stage).toBe('COMPLETED');
    expect(confirmRes.body.customer.currentAddress.streetAddress).toBe('Strada Exemplului 13');
    expect(confirmRes.body.customer.addressVerified).toBe(true);
    expect(confirmRes.body.customer.incomeVerified).toBe(false);
    expect(confirmRes.body.customer.kycStatus).toBe('RECONFIRMATION_NEEDED');
  });

  it('dynamically routes income-only chat intent to qa-income-23 without PID and preserves employer', async () => {
    const { app, mockVerifier } = await setupTestServer();
    const sid = 'sess-dynamic-income';

    const chatRes = await request(app)
      .post('/api/chat')
      .set('X-Session-Id', sid)
      .send({ message: 'Vreau să îmi actualizez venitul' });
    expect(chatRes.status).toBe(200);
    expect(chatRes.body.selectedScope).toBe('income');
    expect(chatRes.body.selectedProfileCode).toBe('qa-income-23');
    expect(chatRes.body.activeFlowCard.profileCode).toBe('qa-income-23');
    expect(chatRes.body.activeFlowCard.requestedCredentials).toHaveLength(1);

    const startRes = await request(app)
      .post('/api/verifications/start')
      .set('X-Session-Id', sid)
      .send({});
    expect(startRes.status).toBe(201);
    expect(startRes.body.activeFlowCard.profileCode).toBe('qa-income-23');

    const txId = startRes.body.activeVerification.transactionId as string;
    await mockVerifier.approveTransaction(txId, 'SATISFIED_INCOME_ONLY');

    const pollRes = await request(app)
      .get(`/api/verifications/${txId}/poll`)
      .set('X-Session-Id', sid);
    expect(pollRes.status).toBe(200);
    expect(pollRes.body.stage).toBe('DIFF_READY');
    expect(pollRes.body.activeFlowCard.addressDiff).toBeNull();
    expect(pollRes.body.activeFlowCard.incomeDiff.hasChanges).toBe(true);
    expect(pollRes.body.activeFlowCard.canConfirmIdentityOnly).toBe(false);

    const confirmRes = await request(app)
      .post('/api/profile/confirm-update')
      .set('X-Session-Id', sid)
      .send({ pendingUpdateId: pollRes.body.activeFlowCard.pendingUpdateId, mode: 'UPDATE_PROFILE' });
    expect(confirmRes.status).toBe(200);
    expect(confirmRes.body.stage).toBe('COMPLETED');
    expect(confirmRes.body.customer.currentIncome.bracket).toBe('15.000 – 20.000 RON / lună');
    expect(confirmRes.body.customer.currentIncome.employer).toBe('Nedeclarat / Necesită actualizare');
    expect(confirmRes.body.customer.incomeVerified).toBe(true);
  });

  it('promotes KYC status to UP_TO_DATE after sequential minimal profile updates from Datele mele', async () => {
    const { app, mockVerifier } = await setupTestServer();
    const sid = 'sess-seq-minimal';

    // 1. Address update from Datele mele (qa-address-23)
    const p1 = await request(app)
      .post('/api/profile/start-update')
      .set('X-Session-Id', sid)
      .send({ scope: 'address' });
    expect(p1.status).toBe(200);
    expect(p1.body.selectedProfileCode).toBe('qa-address-23');
    const s1 = await request(app).post('/api/verifications/start').set('X-Session-Id', sid).send({});
    await mockVerifier.approveTransaction(s1.body.activeVerification.transactionId, 'SATISFIED_ADDRESS_ONLY');
    const poll1 = await request(app)
      .get(`/api/verifications/${s1.body.activeVerification.transactionId}/poll`)
      .set('X-Session-Id', sid);
    const c1 = await request(app)
      .post('/api/profile/confirm-update')
      .set('X-Session-Id', sid)
      .send({ pendingUpdateId: poll1.body.activeFlowCard.pendingUpdateId, mode: 'UPDATE_PROFILE' });
    expect(c1.body.customer.addressVerified).toBe(true);
    expect(c1.body.customer.incomeVerified).toBe(false);
    expect(c1.body.customer.kycStatus).toBe('RECONFIRMATION_NEEDED');

    // 2. Income update from Datele mele (qa-income-23)
    const p2 = await request(app)
      .post('/api/profile/start-update')
      .set('X-Session-Id', sid)
      .send({ scope: 'income' });
    expect(p2.status).toBe(200);
    expect(p2.body.selectedProfileCode).toBe('qa-income-23');
    const s2 = await request(app).post('/api/verifications/start').set('X-Session-Id', sid).send({});
    await mockVerifier.approveTransaction(s2.body.activeVerification.transactionId, 'SATISFIED_INCOME_ONLY');
    const poll2 = await request(app)
      .get(`/api/verifications/${s2.body.activeVerification.transactionId}/poll`)
      .set('X-Session-Id', sid);
    const c2 = await request(app)
      .post('/api/profile/confirm-update')
      .set('X-Session-Id', sid)
      .send({ pendingUpdateId: poll2.body.activeFlowCard.pendingUpdateId, mode: 'UPDATE_PROFILE' });
    expect(c2.status).toBe(200);
    expect(c2.body.customer.addressVerified).toBe(true);
    expect(c2.body.customer.incomeVerified).toBe(true);
    expect(c2.body.customer.kycStatus).toBe('UP_TO_DATE');
  });

  it('keeps privacy questions about income as EXPLAIN_PRIVACY without opening pre_consent', async () => {
    const { app } = await setupTestServer();
    const sid = 'sess-privacy-income';

    const chatRes = await request(app)
      .post('/api/chat')
      .set('X-Session-Id', sid)
      .send({ message: 'De ce aveți nevoie de venitul meu?' });

    expect(chatRes.status).toBe(200);
    expect(chatRes.body.stage).toBe('IDLE');
    expect(chatRes.body.activeFlowCard).toBeNull();
    expect(chatRes.body.messages.at(-1).card).toBeUndefined();
    expect(chatRes.body.messages.at(-1).text).toContain('ZenBank');
  });

  it('completes same-device native returnUri flow with RESPONSE_CODE_REQUIRED poll, /claim, and acknowledgeResult', async () => {
    const { app, mockVerifier } = await setupTestServer();
    const sid = 'sess-same-device-claim';

    await request(app)
      .post('/api/profile/start-update')
      .set('X-Session-Id', sid)
      .send({ scope: 'full' });

    const startRes = await request(app)
      .post('/api/verifications/start')
      .set('X-Session-Id', sid)
      .send({ mode: 'same_device_native' });
    expect(startRes.status).toBe(201);
    expect(startRes.body.activeVerification.sameDevice).toBe(true);
    expect(startRes.body.activeFlowCard.sameDevice).toBe(true);

    const txId = startRes.body.activeVerification.transactionId as string;
    await mockVerifier.approveTransaction(txId, 'SATISFIED_BOTH');

    // Polling before /claim sees RESPONSE_CODE_REQUIRED and remains in AWAITING_WALLET cleanly
    const pollBeforeClaim = await request(app)
      .get(`/api/verifications/${txId}/poll`)
      .set('X-Session-Id', sid);
    expect(pollBeforeClaim.status).toBe(200);
    expect(pollBeforeClaim.body.stage).toBe('AWAITING_WALLET');
    expect(pollBeforeClaim.body.activeVerification.status).toBe('RESPONSE_CODE_REQUIRED');
    expect(pollBeforeClaim.body.activeFlowCard.status).toBe('RESPONSE_CODE_REQUIRED');

    const responseCode = mockVerifier.getMockResponseCode(txId) as string;
    expect(responseCode).toBeTruthy();

    // Wrong response_code is rejected without consuming result
    const badClaim = await request(app)
      .post('/api/verifications/claim')
      .set('X-Session-Id', sid)
      .send({ transactionId: txId, responseCode: 'wrong-code' });
    expect(badClaim.status).toBe(400);

    // Valid response_code claims, decrypts JWE, acknowledges (DELETE /result), and moves to DIFF_READY
    const claimRes = await request(app)
      .post('/api/verifications/claim')
      .set('X-Session-Id', sid)
      .send({ transactionId: txId, responseCode });
    expect(claimRes.status).toBe(200);
    expect(claimRes.body.stage).toBe('DIFF_READY');
    expect(claimRes.body.activeVerification).toBeNull();
    expect(claimRes.body.activeFlowCard.type).toBe('diff_confirm');

    const refetch = await mockVerifier.fetchSealedResult(txId);
    expect(refetch.kind).toBe('gone');

    const confirmRes = await request(app)
      .post('/api/profile/confirm-update')
      .set('X-Session-Id', sid)
      .send({ pendingUpdateId: claimRes.body.activeFlowCard.pendingUpdateId, mode: 'UPDATE_PROFILE' });
    expect(confirmRes.status).toBe(200);
    expect(confirmRes.body.stage).toBe('COMPLETED');
    expect(confirmRes.body.customer.kycStatus).toBe('UP_TO_DATE');
  });
});
