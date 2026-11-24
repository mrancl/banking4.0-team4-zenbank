import crypto from 'node:crypto';
import {
  CompactEncrypt,
  SignJWT,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  importSPKI,
  type JWK,
} from 'jose';
import type { JwksResolver } from './crypto.js';
import { signedHeaders } from './signer.js';
import type { DecryptedVerificationPayload } from '../types.js';

export interface StartVerificationResponse {
  transactionId: string;
  deepLink: string;
  qrSvg: string;
  expiresAt: string;
}

export interface VerificationStatusResponse {
  transactionId: string;
  status: string;
  outcome?: string | null;
  reason?: string | null;
  walletError?: string | null;
}

export interface WebsiteStatusResponse {
  status: string;
  [key: string]: unknown;
}

export interface WebsiteProfileResponse {
  code: string;
  name: string;
  mode: string;
  default?: boolean;
  requestedCredentials?: unknown[];
}

export type FetchResultOutcome =
  | { kind: 'ok'; sealedJwe: string }
  | { kind: 'not_ready'; code: string; message: string }
  | { kind: 'gone'; code: string; message: string }
  | { kind: 'not_sealed'; code: string; message: string };

export interface VerifierClient {
  getStatus(): Promise<WebsiteStatusResponse>;
  getProfiles(): Promise<WebsiteProfileResponse[]>;
  startVerification(profileCode: string, returnUri?: string): Promise<StartVerificationResponse>;
  getVerificationStatus(transactionId: string): Promise<VerificationStatusResponse>;
  claimVerification(transactionId: string, responseCode: string): Promise<VerificationStatusResponse>;
  fetchSealedResult(transactionId: string): Promise<FetchResultOutcome>;
  acknowledgeResult(transactionId: string): Promise<boolean>;
}

export class VerifierHttpError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly traceId?: string;

  constructor(statusCode: number, code: string, message: string, traceId?: string) {
    super(message);
    this.name = 'VerifierHttpError';
    this.statusCode = statusCode;
    this.code = code;
    this.traceId = traceId;
  }
}

export interface LiveVerifierClientConfig {
  baseUrl: string;
  websiteKey: string;
  websiteSecret: string;
  requestTimeoutMs?: number;
}

/**
 * HTTP client for the Tremend Verifier Website API with HMAC-SHA256 request signing.
 */
export class LiveVerifierClient implements VerifierClient {
  private readonly baseUrl: string;
  private readonly key: string;
  private readonly secret: string;
  private readonly requestTimeoutMs: number;

  constructor(cfg: LiveVerifierClientConfig) {
    this.baseUrl = cfg.baseUrl.replace(/\/+$/, '');
    this.key = cfg.websiteKey;
    this.secret = cfg.websiteSecret;
    this.requestTimeoutMs = cfg.requestTimeoutMs ?? 60_000;
  }

  private async request(
    method: string,
    apiPath: string,
    options: { body?: string; accept?: string; allowedStatuses?: number[] } = {},
  ): Promise<Response> {
    if (!this.key || !this.secret) {
      throw new VerifierHttpError(500, 'VERIFIER_NOT_CONFIGURED', 'Website key/secret not configured.');
    }

    const bodyStr = options.body ?? '';
    const authHeaders = signedHeaders({
      key: this.key,
      secret: this.secret,
      method,
      path: apiPath,
      body: bodyStr,
    });

    const headers: Record<string, string> = {
      Accept: options.accept ?? 'application/json',
      ...authHeaders,
    };
    if (bodyStr) {
      headers['Content-Type'] = 'application/json';
    }

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${apiPath}`, {
        method,
        headers,
        body: bodyStr || undefined,
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      });
    } catch (err) {
      if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
        throw new VerifierHttpError(
          504,
          'VERIFIER_TIMEOUT',
          'Serviciul EUDI Verifier a răspuns prea lent. Te rugăm să reîncerci.',
        );
      }
      throw new VerifierHttpError(
        502,
        'VERIFIER_UNREACHABLE',
        'Conexiunea cu serviciul EUDI Verifier a eșuat temporar.',
      );
    }

    if (res.ok || options.allowedStatuses?.includes(res.status)) {
      return res;
    }

    let errCode = `HTTP_${res.status}`;
    let errMsg = `Verifier responded with HTTP ${res.status}`;
    let traceId: string | undefined;

    try {
      const json = (await res.json()) as { code?: string; message?: string; traceId?: string };
      errCode = json.code ?? errCode;
      errMsg = json.message ?? errMsg;
      traceId = json.traceId;
    } catch {
      // Ignore non-JSON error bodies
    }

    throw new VerifierHttpError(res.status, errCode, errMsg, traceId);
  }

  async getStatus(): Promise<WebsiteStatusResponse> {
    const res = await this.request('GET', '/api/website/status');
    return (await res.json()) as WebsiteStatusResponse;
  }

  async getProfiles(): Promise<WebsiteProfileResponse[]> {
    const res = await this.request('GET', '/api/website/profiles');
    return (await res.json()) as WebsiteProfileResponse[];
  }

  async startVerification(profileCode: string, returnUri?: string): Promise<StartVerificationResponse> {
    const body = JSON.stringify({
      profile: profileCode,
      ...(returnUri ? { returnUri } : {}),
    });
    const res = await this.request('POST', '/api/website/verifications', { body });
    return (await res.json()) as StartVerificationResponse;
  }

  async getVerificationStatus(transactionId: string): Promise<VerificationStatusResponse> {
    const res = await this.request(
      'GET',
      `/api/website/verifications/${encodeURIComponent(transactionId)}`,
      { allowedStatuses: [409] },
    );
    if (res.status === 409) {
      let code = 'RESPONSE_CODE_REQUIRED';
      let message: string | null = null;
      try {
        const json = (await res.json()) as { code?: string; message?: string };
        code = json.code ?? code;
        message = json.message ?? null;
      } catch {
        // ignore parse errors
      }
      return {
        transactionId,
        status: code,
        reason: message,
      };
    }
    return (await res.json()) as VerificationStatusResponse;
  }

  async claimVerification(
    transactionId: string,
    responseCode: string,
  ): Promise<VerificationStatusResponse> {
    const body = JSON.stringify({ responseCode });
    const res = await this.request(
      'POST',
      `/api/website/verifications/${encodeURIComponent(transactionId)}/claim`,
      { body },
    );
    return (await res.json()) as VerificationStatusResponse;
  }

  async fetchSealedResult(transactionId: string): Promise<FetchResultOutcome> {
    const res = await this.request(
      'GET',
      `/api/website/verifications/${encodeURIComponent(transactionId)}/result`,
      {
        accept: 'application/jose',
        allowedStatuses: [404, 409, 410],
      },
    );

    if (res.status === 200) {
      const sealedJwe = (await res.text()).trim();
      return { kind: 'ok', sealedJwe };
    }

    let code = `HTTP_${res.status}`;
    let message = 'Result unavailable';
    try {
      const errBody = (await res.json()) as { code?: string; message?: string };
      code = errBody.code ?? code;
      message = errBody.message ?? message;
    } catch {
      // ignore
    }

    if (res.status === 410 || code === 'RESULT_GONE') {
      return { kind: 'gone', code, message };
    }
    if (code === 'RESULT_NOT_SEALED') {
      return { kind: 'not_sealed', code, message };
    }
    return { kind: 'not_ready', code, message };
  }

  async acknowledgeResult(transactionId: string): Promise<boolean> {
    const res = await this.request(
      'DELETE',
      `/api/website/verifications/${encodeURIComponent(transactionId)}/result`,
      { allowedStatuses: [204, 404, 409] },
    );
    return res.status === 204;
  }
}

export type MockWalletVariant =
  | 'SATISFIED_BOTH'
  | 'SATISFIED_ADDRESS_ONLY'
  | 'SATISFIED_INCOME_ONLY'
  | 'SATISFIED_SAME_ADDRESS'
  | 'WITHHELD_ADDRESS'
  | 'REFUSED'
  | 'NOT_SATISFIED'
  | 'DECLINED'
  | 'EXPIRED'
  | 'WALLET_ERROR'
  | 'CROSS_CREDENTIAL_MISMATCH';

interface MockTxState {
  transactionId: string;
  profileCode: string;
  returnUri?: string;
  expectedResponseCode?: string;
  claimed?: boolean;
  status: string;
  reason?: string;
  walletError?: string;
  expiresAt: string;
  sealedJwe?: string;
  acknowledged: boolean;
}

/**
 * Cryptographically faithful in-memory verifier mock for offline automated tests and local mock mode.
 * Signs inner JWTs with ES256 and seals results with ECDH-ES+A256KW / A256GCM JWEs.
 */
export class MockVerifierClient implements VerifierClient {
  private readonly issuer: string;
  private readonly audience: string;
  private readonly orgPublicKeyPem: string;
  private readonly txs = new Map<string, MockTxState>();
  private signingKeyPairPromise: ReturnType<typeof generateKeyPair> | null = null;
  private jwksCache: JwksResolver | null = null;
  private kid = 'mock-verifier-es256-1';

  constructor(opts: { issuer: string; audience: string; orgPublicKeyPem: string }) {
    this.issuer = opts.issuer;
    this.audience = opts.audience;
    this.orgPublicKeyPem = opts.orgPublicKeyPem;
  }

  private async getSigningKeys() {
    if (!this.signingKeyPairPromise) {
      this.signingKeyPairPromise = generateKeyPair('ES256');
    }
    return this.signingKeyPairPromise;
  }

  async getJwksResolver(): Promise<JwksResolver> {
    if (!this.jwksCache) {
      const { publicKey } = await this.getSigningKeys();
      const jwk: JWK = await exportJWK(publicKey);
      jwk.kid = this.kid;
      jwk.use = 'sig';
      jwk.alg = 'ES256';
      this.jwksCache = createLocalJWKSet({ keys: [jwk] });
    }
    return this.jwksCache;
  }

  async getStatus(): Promise<WebsiteStatusResponse> {
    return { status: 'ACTIVE', mode: 'mock' };
  }

  async getProfiles(): Promise<WebsiteProfileResponse[]> {
    return [
      {
        code: 'qa-both-23',
        name: 'ZenBank Actualizare Date (PID + Adresă + Venit)',
        mode: 'DISCLOSURE',
        default: false,
        requestedCredentials: [
          'urn:banking40:sandbox:pid-ro:1',
          'urn:banking40:sandbox:address:1',
          'urn:banking40:sandbox:income:1',
        ],
      },
      {
        code: 'qa-address-23',
        name: 'ZenBank Doar Adresă (PID + Adresă)',
        mode: 'DISCLOSURE',
        default: false,
        requestedCredentials: [
          'urn:banking40:sandbox:pid-ro:1',
          'urn:banking40:sandbox:address:1',
        ],
      },
      {
        code: 'qa-income-23',
        name: 'ZenBank Doar Venit (Atestare Venit)',
        mode: 'DISCLOSURE',
        default: false,
        requestedCredentials: ['urn:banking40:sandbox:income:1'],
      },
      {
        code: 'age-18',
        name: 'Vârstă 18+',
        mode: 'DECISION',
        default: true,
        requestedCredentials: ['urn:banking40:sandbox:pid-ro:1'],
      },
    ];
  }

  async startVerification(profileCode: string, returnUri?: string): Promise<StartVerificationResponse> {
    const transactionId = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    const deepLink = `openid4vp://?client_id=x509_hash%3Amock&request_uri=https%3A%2F%2Fmock.local%2Freq%2F${transactionId}`;
    const qrSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120"><rect width="120" height="120" fill="#fff"/><rect x="10" y="10" width="32" height="32" fill="#000"/><rect x="78" y="10" width="32" height="32" fill="#000"/><rect x="10" y="78" width="32" height="32" fill="#000"/><text x="60" y="64" font-size="9" text-anchor="middle" fill="#FF6200">MOCK EUDI</text></svg>`;

    this.txs.set(transactionId, {
      transactionId,
      profileCode,
      ...(returnUri
        ? {
            returnUri,
            expectedResponseCode: `mock-rc-${crypto.randomUUID().slice(0, 8)}`,
            claimed: false,
          }
        : {}),
      status: 'CREATED',
      expiresAt,
      acknowledged: false,
    });

    return { transactionId, deepLink, qrSvg, expiresAt };
  }

  getMockResponseCode(transactionId: string): string | undefined {
    return this.txs.get(transactionId)?.expectedResponseCode;
  }

  async getVerificationStatus(transactionId: string): Promise<VerificationStatusResponse> {
    const tx = this.txs.get(transactionId);
    if (!tx) {
      throw new VerifierHttpError(404, 'NOT_FOUND', 'Verification transaction not found');
    }
    if (tx.returnUri && tx.status === 'COMPLETED' && !tx.claimed) {
      return {
        transactionId: tx.transactionId,
        status: 'RESPONSE_CODE_REQUIRED',
        reason: 'Same-device response code required',
        walletError: null,
      };
    }
    return {
      transactionId: tx.transactionId,
      status: tx.status,
      reason: tx.reason ?? null,
      walletError: tx.walletError ?? null,
    };
  }

  async claimVerification(
    transactionId: string,
    responseCode: string,
  ): Promise<VerificationStatusResponse> {
    const tx = this.txs.get(transactionId);
    if (!tx) {
      throw new VerifierHttpError(404, 'NOT_FOUND', 'Verification transaction not found');
    }
    if (tx.status !== 'COMPLETED') {
      throw new VerifierHttpError(409, 'RESULT_NOT_READY', 'Wallet has not answered yet');
    }
    if (tx.expectedResponseCode && responseCode !== tx.expectedResponseCode) {
      throw new VerifierHttpError(400, 'INVALID_RESPONSE_CODE', 'Invalid response code');
    }
    tx.claimed = true;
    return {
      transactionId: tx.transactionId,
      status: tx.status,
      reason: tx.reason ?? null,
      walletError: tx.walletError ?? null,
    };
  }

  async fetchSealedResult(transactionId: string): Promise<FetchResultOutcome> {
    const tx = this.txs.get(transactionId);
    if (!tx) {
      return { kind: 'gone', code: 'RESULT_GONE', message: 'Not found' };
    }
    if (tx.acknowledged) {
      return { kind: 'gone', code: 'RESULT_GONE', message: 'Result already acknowledged and removed' };
    }
    if (tx.status !== 'COMPLETED' || !tx.sealedJwe) {
      return { kind: 'not_ready', code: 'RESULT_NOT_READY', message: 'Result not ready yet' };
    }
    return { kind: 'ok', sealedJwe: tx.sealedJwe };
  }

  async acknowledgeResult(transactionId: string): Promise<boolean> {
    const tx = this.txs.get(transactionId);
    if (!tx || tx.status !== 'COMPLETED' || tx.acknowledged) {
      return false;
    }
    tx.acknowledged = true;
    tx.sealedJwe = undefined;
    return true;
  }

  /**
   * Simulates a wallet response by sealing a real JWE/JWS payload or setting a terminal status.
   */
  async approveTransaction(
    transactionId: string,
    variant: MockWalletVariant = 'SATISFIED_BOTH',
    overrides?: Partial<DecryptedVerificationPayload>,
  ): Promise<void> {
    const tx = this.txs.get(transactionId);
    if (!tx) {
      throw new Error(`Unknown mock transaction: ${transactionId}`);
    }

    if (variant === 'DECLINED') {
      tx.status = 'DECLINED';
      tx.reason = 'Customer declined sharing in the wallet';
      return;
    }
    if (variant === 'EXPIRED') {
      tx.status = 'EXPIRED';
      tx.reason = 'Verification request expired after 5 minutes';
      return;
    }
    if (variant === 'WALLET_ERROR') {
      tx.status = 'WALLET_ERROR';
      tx.walletError = 'Holder device aborted cryptographic presentation';
      return;
    }

    const payload = this.buildPayload(transactionId, variant, overrides);
    tx.sealedJwe = await this.sealPayload(payload);
    tx.status = 'COMPLETED';
  }

  /**
   * Seals an arbitrary payload with the mock verifier's ES256 key + org P-256 encryption key.
   */
  async sealPayload(payload: Record<string, unknown>): Promise<string> {
    const { privateKey } = await this.getSigningKeys();
    const innerJwt = await new SignJWT(payload)
      .setProtectedHeader({ alg: 'ES256', typ: 'eudi-result+jwt', kid: this.kid })
      .setIssuer(this.issuer)
      .setAudience(this.audience)
      .setIssuedAt()
      .setExpirationTime('15m')
      .setJti(typeof payload.jti === 'string' && payload.jti ? payload.jti : crypto.randomUUID())
      .sign(privateKey);

    const encKey = await importSPKI(this.orgPublicKeyPem, 'ECDH-ES+A256KW');
    return await new CompactEncrypt(new TextEncoder().encode(innerJwt))
      .setProtectedHeader({ alg: 'ECDH-ES+A256KW', enc: 'A256GCM' })
      .encrypt(encKey);
  }

  private buildPayload(
    transactionId: string,
    variant: MockWalletVariant,
    overrides?: Partial<DecryptedVerificationPayload>,
  ): Record<string, unknown> {
    const basePid = {
      type: 'PID_RO_SANDBOX',
      format: 'dc+sd-jwt',
      documentType: 'urn:banking40:sandbox:pid-ro:1',
      claims: {
        given_name: 'RADU',
        family_name: 'STAN',
        birthdate: '1986-06-08',
        date_of_expiry: '2030-11-23',
      },
      issuer: {
        country: 'RO',
        authority: 'Banking 4.0 Sandbox',
      },
      checks: {
        issuerSignature: true,
        holderBinding: true,
        validity: true,
        trustedIssuer: true,
        status: 'NOT_CHECKED',
      },
    };

    const newAddress = {
      type: 'ADDRESS',
      format: 'dc+sd-jwt',
      documentType: 'urn:banking40:sandbox:address:1',
      claims: {
        address: {
          formatted: 'Strada Exemplului 13, 300001 Timișoara, România',
        },
      },
      issuer: {
        country: 'RO',
        authority: 'Banking 4.0 Sandbox',
      },
      checks: {
        issuerSignature: true,
        holderBinding: true,
        validity: true,
        trustedIssuer: true,
        status: 'NOT_CHECKED',
      },
    };

    const newIncome = {
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
      issuer: {
        country: 'RO',
        authority: 'Banking 4.0 Sandbox',
      },
      checks: {
        issuerSignature: true,
        holderBinding: true,
        validity: true,
        trustedIssuer: true,
        status: 'NOT_CHECKED',
      },
    };

    const minimalIncome = {
      type: 'INCOME_ATTESTATION',
      format: 'dc+sd-jwt',
      documentType: 'urn:banking40:sandbox:income:1',
      claims: {
        monthly_income: {
          periods: newIncome.claims.monthly_income.periods,
          currency: 'RON',
        },
      },
      issuer: {
        country: 'RO',
        authority: 'Banking 4.0 Sandbox',
      },
      checks: {
        issuerSignature: true,
        holderBinding: true,
        validity: true,
        trustedIssuer: true,
        status: 'NOT_CHECKED',
      },
    };

    let body: DecryptedVerificationPayload;
    switch (variant) {
      case 'SATISFIED_ADDRESS_ONLY':
        body = {
          schema: 'eudi-verification-result/v1',
          transactionId,
          outcome: { status: 'SATISFIED', basis: 'DISCLOSURE' },
          credentials: [newAddress],
        };
        break;
      case 'SATISFIED_INCOME_ONLY':
        body = {
          schema: 'eudi-verification-result/v1',
          transactionId,
          outcome: { status: 'SATISFIED', basis: 'DISCLOSURE' },
          credentials: [minimalIncome],
        };
        break;
      case 'REFUSED':
        body = { schema: 'eudi-verification-result/v1', transactionId, outcome: { status: 'REFUSED' } };
        break;
      case 'NOT_SATISFIED':
        body = { schema: 'eudi-verification-result/v1', transactionId, outcome: { status: 'NOT_SATISFIED' } };
        break;
      case 'WITHHELD_ADDRESS':
        body = {
          schema: 'eudi-verification-result/v1',
          transactionId,
          outcome: {
            status: 'SATISFIED',
            basis: 'DISCLOSURE',
            withheld: ['address.formatted', 'monthly_income'],
          },
          credentials: [basePid],
        };
        break;
      case 'SATISFIED_SAME_ADDRESS':
        body = {
          schema: 'eudi-verification-result/v1',
          transactionId,
          outcome: { status: 'SATISFIED', basis: 'DISCLOSURE' },
          credentials: [
            basePid,
            {
              ...newAddress,
              claims: {
                address: {
                  formatted: 'Bulevardul Unirii 22, 030133 București, România',
                },
              },
            },
            {
              ...newIncome,
              claims: {
                monthly_income: {
                  periods: [{ month: '2026-10', net_amount_minor: 1250000 }],
                  currency: 'RON',
                  income_type: 'salary',
                  payer: { legal_name: 'Nedeclarat / Necesită actualizare' },
                },
              },
            },
          ],
        };
        break;
      case 'CROSS_CREDENTIAL_MISMATCH':
        body = {
          schema: 'eudi-verification-result/v1',
          transactionId,
          outcome: { status: 'SATISFIED', basis: 'DISCLOSURE' },
          credentials: [
            basePid,
            {
              ...newAddress,
              claims: {
                given_name: 'ION',
                family_name: 'DUMITRU',
                birthdate: '1986-06-08',
                address: {
                  formatted: 'Strada Exemplului 13, 300001 Timișoara, România',
                },
              },
            },
            newIncome,
          ],
        };
        break;
      case 'SATISFIED_BOTH':
      default:
        body = {
          schema: 'eudi-verification-result/v1',
          transactionId,
          outcome: { status: 'SATISFIED', basis: 'DISCLOSURE' },
          credentials: [basePid, newAddress, newIncome],
        };
        break;
    }

    return {
      ...body,
      ...overrides,
    };
  }
}
