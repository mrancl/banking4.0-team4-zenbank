import crypto from 'node:crypto';

export interface SignRequestParams {
  key: string;
  secret: string;
  method: string;
  path: string;
  body?: string;
  timestamp?: string;
  nonce?: string;
}

/**
 * Generates HMAC-SHA256 authentication headers required by the Tremend Verifier Website API.
 * Mirrors Banking-4.0-Team-04/examples/sign-website-request.mjs.
 */
export function signedHeaders({
  key,
  secret,
  method,
  path,
  body = '',
  timestamp = Math.floor(Date.now() / 1000).toString(),
  nonce = crypto.randomUUID(),
}: SignRequestParams): Record<string, string> {
  const cleanPath = path.split('?')[0];
  const bodyHash = crypto.createHash('sha256').update(body).digest('hex');
  const canonical = [method.toUpperCase(), cleanPath, timestamp, nonce, bodyHash].join('\n');

  const signature = crypto
    .createHmac('sha256', secret)
    .update(canonical)
    .digest('hex');

  return {
    'X-Verifier-Key': key,
    'X-Verifier-Timestamp': timestamp,
    'X-Verifier-Nonce': nonce,
    'X-Verifier-Signature': signature,
  };
}
