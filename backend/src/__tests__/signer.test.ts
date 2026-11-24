import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { signedHeaders } from '../verifier/signer.js';

describe('signedHeaders', () => {
  it('computes canonical HMAC-SHA256 signature matching Tremend recipe and strips query strings', () => {
    const key = 'vo_test_key';
    const secret = 'test_secret_value';
    const body = JSON.stringify({ profile: 'qa-both-23' });

    const headers = signedHeaders({
      key,
      secret,
      method: 'post',
      path: '/api/website/verifications?foo=bar',
      body,
      timestamp: '1700000000',
      nonce: '11111111-1111-4111-8111-111111111111',
    });

    const bodyHash = crypto.createHash('sha256').update(body).digest('hex');
    const canonical = [
      'POST',
      '/api/website/verifications',
      '1700000000',
      '11111111-1111-4111-8111-111111111111',
      bodyHash,
    ].join('\n');
    const expectedSig = crypto.createHmac('sha256', secret).update(canonical).digest('hex');

    expect(headers['X-Verifier-Key']).toBe(key);
    expect(headers['X-Verifier-Timestamp']).toBe('1700000000');
    expect(headers['X-Verifier-Nonce']).toBe('11111111-1111-4111-8111-111111111111');
    expect(headers['X-Verifier-Signature']).toBe(expectedSig);
  });

  it('signs GET and DELETE requests with empty body hash', () => {
    const emptySha256 = crypto.createHash('sha256').update('').digest('hex');

    for (const method of ['GET', 'DELETE']) {
      const headers = signedHeaders({
        key: 'vo_k',
        secret: 'sec',
        method,
        path: '/api/website/verifications/tx-123/result',
        timestamp: '1700000001',
        nonce: 'nonce-1',
      });

      const canonical = `${method}\n/api/website/verifications/tx-123/result\n1700000001\nnonce-1\n${emptySha256}`;
      const expected = crypto.createHmac('sha256', 'sec').update(canonical).digest('hex');
      expect(headers['X-Verifier-Signature']).toBe(expected);
    }
  });
});
