import crypto from 'node:crypto';
import { CompactEncrypt, SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, importSPKI } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import { MockVerifierClient } from '../verifier/client.js';
import { VerificationCryptoError, openAndVerifyResult } from '../verifier/crypto.js';

describe('openAndVerifyResult', () => {
  const issuer = 'https://verifier.example.test';
  const audience = 'org-uuid-1234';
  let orgPrivatePem = '';
  let orgPublicPem = '';

  beforeAll(() => {
    const pair = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    orgPrivatePem = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    orgPublicPem = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  });

  it('decrypts a valid JWE, verifies ES256 JWKS signature, and checks all claims', async () => {
    const mock = new MockVerifierClient({ issuer, audience, orgPublicKeyPem: orgPublicPem });
    const started = await mock.startVerification('qa-both-23');
    await mock.approveTransaction(started.transactionId, 'SATISFIED_BOTH');
    const fetched = await mock.fetchSealedResult(started.transactionId);
    expect(fetched.kind).toBe('ok');
    if (fetched.kind !== 'ok') return;

    const jwks = await mock.getJwksResolver();
    const seenJtis = new Set<string>();
    const res = await openAndVerifyResult({
      sealedJwe: fetched.sealedJwe,
      privateKeyPem: orgPrivatePem,
      issuer,
      jwks,
      audience,
      expectedTransactionId: started.transactionId,
      seenJtis,
    });

    expect(res.payload.outcome.status).toBe('SATISFIED');
    expect(res.payload.transactionId).toBe(started.transactionId);
    expect(res.checks.every((c) => c.status === 'PASS')).toBe(true);
    expect(seenJtis.size).toBe(1);
  });

  it('rejects replayed jti with JTI_REPLAY', async () => {
    const mock = new MockVerifierClient({ issuer, audience, orgPublicKeyPem: orgPublicPem });
    const started = await mock.startVerification('qa-both-23');
    await mock.approveTransaction(started.transactionId, 'SATISFIED_BOTH');
    const fetched = await mock.fetchSealedResult(started.transactionId);
    if (fetched.kind !== 'ok') throw new Error('expected ok');

    const jwks = await mock.getJwksResolver();
    const seenJtis = new Set<string>();

    await openAndVerifyResult({
      sealedJwe: fetched.sealedJwe,
      privateKeyPem: orgPrivatePem,
      issuer,
      jwks,
      audience,
      expectedTransactionId: started.transactionId,
      seenJtis,
    });

    await expect(
      openAndVerifyResult({
        sealedJwe: fetched.sealedJwe,
        privateKeyPem: orgPrivatePem,
        issuer,
        jwks,
        audience,
        expectedTransactionId: started.transactionId,
        seenJtis,
      }),
    ).rejects.toMatchObject({ code: 'JTI_REPLAY' });
  });

  it('rejects tampered inner JWS signature', async () => {
    const { privateKey: signerPriv } = await generateKeyPair('ES256');
    const { publicKey: differentPub } = await generateKeyPair('ES256');
    const wrongJwk = await exportJWK(differentPub);
    wrongJwk.kid = 'k1';
    wrongJwk.alg = 'ES256';
    const wrongJwks = createLocalJWKSet({ keys: [wrongJwk] });

    const jwt = await new SignJWT({ schema: 'eudi-verification-result/v1', transactionId: 'tx-1', outcome: { status: 'SATISFIED' } })
      .setProtectedHeader({ alg: 'ES256', typ: 'eudi-result+jwt', kid: 'k1' })
      .setIssuer(issuer)
      .setAudience(audience)
      .setIssuedAt()
      .setExpirationTime('10m')
      .setJti('jti-1')
      .sign(signerPriv);

    const encKey = await importSPKI(orgPublicPem, 'ECDH-ES+A256KW');
    const sealed = await new CompactEncrypt(new TextEncoder().encode(jwt))
      .setProtectedHeader({ alg: 'ECDH-ES+A256KW', enc: 'A256GCM' })
      .encrypt(encKey);

    await expect(
      openAndVerifyResult({
        sealedJwe: sealed,
        privateKeyPem: orgPrivatePem,
        issuer,
        jwks: wrongJwks,
        audience,
        expectedTransactionId: 'tx-1',
        seenJtis: new Set(),
      }),
    ).rejects.toBeInstanceOf(VerificationCryptoError);
  });

  it('rejects wrong audience, transactionId mismatch, and wrong schema', async () => {
    const mock = new MockVerifierClient({ issuer, audience, orgPublicKeyPem: orgPublicPem });
    const jwks = await mock.getJwksResolver();

    const sealedValid = await mock.sealPayload({
      schema: 'eudi-verification-result/v1',
      transactionId: 'tx-expected',
      outcome: { status: 'SATISFIED' },
    });

    await expect(
      openAndVerifyResult({
        sealedJwe: sealedValid,
        privateKeyPem: orgPrivatePem,
        issuer,
        jwks,
        audience: 'wrong-aud',
        expectedTransactionId: 'tx-expected',
        seenJtis: new Set(),
      }),
    ).rejects.toMatchObject({ code: 'JWS_VERIFY_FAILED' });

    await expect(
      openAndVerifyResult({
        sealedJwe: sealedValid,
        privateKeyPem: orgPrivatePem,
        issuer,
        jwks,
        audience,
        expectedTransactionId: 'tx-other',
        seenJtis: new Set(),
      }),
    ).rejects.toMatchObject({ code: 'TRANSACTION_MISMATCH' });

    const sealedBadSchema = await mock.sealPayload({
      schema: 'wrong-schema/v2',
      transactionId: 'tx-expected',
      outcome: { status: 'SATISFIED' },
    });

    await expect(
      openAndVerifyResult({
        sealedJwe: sealedBadSchema,
        privateKeyPem: orgPrivatePem,
        issuer,
        jwks,
        audience,
        expectedTransactionId: 'tx-expected',
        seenJtis: new Set(),
      }),
    ).rejects.toMatchObject({ code: 'INVALID_SCHEMA' });
  });
});
