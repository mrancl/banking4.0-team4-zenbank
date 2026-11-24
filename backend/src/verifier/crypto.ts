import {
  compactDecrypt,
  createRemoteJWKSet,
  decodeProtectedHeader,
  importPKCS8,
  jwtVerify,
  type JWTVerifyGetKey,
} from 'jose';
import type { DecryptedVerificationPayload, TrustCheckItem } from '../types.js';

export type JwksResolver = JWTVerifyGetKey;

export class VerificationCryptoError extends Error {
  readonly code: string;
  readonly checks: TrustCheckItem[];

  constructor(code: string, message: string, checks: TrustCheckItem[]) {
    super(message);
    this.name = 'VerificationCryptoError';
    this.code = code;
    this.checks = checks;
  }
}

export interface OpenAndVerifyParams {
  sealedJwe: string;
  privateKeyPem: string;
  issuer: string;
  jwks: JwksResolver;
  audience: string;
  expectedTransactionId: string;
  seenJtis: Set<string>;
}

export interface OpenAndVerifyResult {
  payload: DecryptedVerificationPayload;
  checks: TrustCheckItem[];
}

/**
 * Creates a remote JWKS resolver pointing at /.well-known/jwks.json on the verifier host.
 */
export function createVerifierJwks(issuer: string): JwksResolver {
  return createRemoteJWKSet(new URL('/.well-known/jwks.json', issuer));
}

/**
 * Decrypts the compact JWE (ECDH-ES+A256KW / A256GCM), verifies the inner ES256 JWS against
 * the verifier JWKS, validates envelope claims, binds transactionId, and enforces jti anti-replay.
 */
export async function openAndVerifyResult({
  sealedJwe,
  privateKeyPem,
  issuer,
  jwks,
  audience,
  expectedTransactionId,
  seenJtis,
}: OpenAndVerifyParams): Promise<OpenAndVerifyResult> {
  const checks: TrustCheckItem[] = [];
  const trimmed = sealedJwe.trim();

  if (trimmed.split('.').length !== 5) {
    checks.push({
      id: 'jwe_decrypt',
      label: 'Decriptare plic JWE',
      status: 'FAIL',
      detail: 'Răspunsul nu este un JWE compact din 5 segmente.',
    });
    throw new VerificationCryptoError('INVALID_JWE_FORMAT', 'Răspunsul nu este un JWE compact valid.', checks);
  }

  let innerJwt: string;
  try {
    const header = decodeProtectedHeader(trimmed);
    if (header.alg !== 'ECDH-ES+A256KW' || header.enc !== 'A256GCM') {
      throw new Error(`Algoritmi JWE neașteptați: alg=${String(header.alg)}, enc=${String(header.enc)}`);
    }
    const privateKey = await importPKCS8(privateKeyPem, 'ECDH-ES+A256KW');
    const { plaintext } = await compactDecrypt(trimmed, privateKey, {
      keyManagementAlgorithms: ['ECDH-ES+A256KW'],
      contentEncryptionAlgorithms: ['A256GCM'],
    });
    innerJwt = new TextDecoder().decode(plaintext);
    checks.push({
      id: 'jwe_decrypt',
      label: 'Decriptare plic JWE',
      status: 'PASS',
      detail: 'Decriptat ECDH-ES+A256KW / A256GCM folosind cheia privată P-256 înregistrată a organizației.',
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Decriptarea JWE a eșuat';
    checks.push({
      id: 'jwe_decrypt',
      label: 'Decriptare plic JWE',
      status: 'FAIL',
      detail: msg,
    });
    throw new VerificationCryptoError('JWE_DECRYPT_FAILED', msg, checks);
  }

  let payload: DecryptedVerificationPayload;
  try {
    const verified = await jwtVerify(innerJwt, jwks, {
      algorithms: ['ES256'],
      typ: 'eudi-result+jwt',
      issuer,
      audience,
      requiredClaims: ['iat', 'exp', 'jti'],
      clockTolerance: 60,
    });
    payload = verified.payload as unknown as DecryptedVerificationPayload;
    checks.push({
      id: 'jws_signature',
      label: 'Semnătură ES256 Verifier JWKS',
      status: 'PASS',
      detail: 'Semnătura JWT internă a fost verificată cu /.well-known/jwks.json.',
    });
    checks.push({
      id: 'jwt_envelope',
      label: 'Antet JWT și audiență',
      status: 'PASS',
      detail: `Validat typ=eudi-result+jwt, iss, aud=${audience}, fereastră iat/exp.`,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Verificarea JWS a eșuat';
    checks.push({
      id: 'jws_signature',
      label: 'Semnătură ES256 Verifier JWKS',
      status: 'FAIL',
      detail: msg,
    });
    throw new VerificationCryptoError('JWS_VERIFY_FAILED', msg, checks);
  }

  if (payload.schema !== 'eudi-verification-result/v1') {
    const detail = `Schemă rezultat neașteptată: ${String(payload.schema)}`;
    checks.push({
      id: 'schema_version',
      label: 'Versiune schemă rezultat',
      status: 'FAIL',
      detail,
    });
    throw new VerificationCryptoError('INVALID_SCHEMA', detail, checks);
  }
  checks.push({
    id: 'schema_version',
    label: 'Versiune schemă rezultat',
    status: 'PASS',
    detail: 'Confirmat schema=eudi-verification-result/v1.',
  });

  if (payload.transactionId !== expectedTransactionId) {
    const detail = 'transactionId-ul verificat nu corespunde tranzacției din sesiunea clientului.';
    checks.push({
      id: 'session_binding',
      label: 'Asociere tranzacție sesiune',
      status: 'FAIL',
      detail,
    });
    throw new VerificationCryptoError('TRANSACTION_MISMATCH', detail, checks);
  }
  checks.push({
    id: 'session_binding',
    label: 'Asociere tranzacție sesiune',
    status: 'PASS',
    detail: 'transactionId-ul verificat corespunde sesiunii active a clientului.',
  });

  const jti = payload.jti;
  if (typeof jti !== 'string' || !jti.trim()) {
    const detail = 'Lipsește atributul jti.';
    checks.push({
      id: 'jti_replay',
      label: 'Protecție replay (jti)',
      status: 'FAIL',
      detail,
    });
    throw new VerificationCryptoError('MISSING_JTI', detail, checks);
  }
  if (seenJtis.has(jti)) {
    const detail = 'Identificatorul jti a fost deja acceptat anterior (replay blocat).';
    checks.push({
      id: 'jti_replay',
      label: 'Protecție replay (jti)',
      status: 'FAIL',
      detail,
    });
    throw new VerificationCryptoError('JTI_REPLAY', detail, checks);
  }
  seenJtis.add(jti);
  checks.push({
    id: 'jti_replay',
    label: 'Protecție replay (jti)',
    status: 'PASS',
    detail: 'jti unic acceptat și înregistrat împotriva refolosirii.',
  });

  return { payload, checks };
}
