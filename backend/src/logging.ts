const SENSITIVE_KEYS = new Set([
  'secret',
  'signature',
  'privatekey',
  'pem',
  'jwe',
  'jws',
  'token',
  'given_name',
  'family_name',
  'givenname',
  'familyname',
  'birthdate',
  'street_address',
  'streetaddress',
  'address',
  'claims',
  'raw',
  'evidence',
  'personal_numeric_code',
  'cnp',
  'place_of_birth',
  'monthly_income',
  'payer',
  'employer',
  'employername',
  'legal_name',
  'net_amount_minor',
  'periods',
  'bracket',
  'income',
  'apikey',
  'eudi_verifier_secret',
  'gemini_api_key',
  'result_private_key_pem',
]);

const REDACTED = '[REDACTED]';

/**
 * Redacts PEM blocks, compact JWE/JWS tokens, verifier keys, IBANs, and Romanian CNPs.
 */
export function redactString(input: string): string {
  let out = input;

  // PEM private/public blocks
  out = out.replace(
    /-----BEGIN [A-Z0-9 ]+-----[\s\S]*?-----END [A-Z0-9 ]+-----/g,
    '[REDACTED_PEM]',
  );

  // Compact JWE (5 base64url segments) and compact JWS/JWT (3 base64url segments)
  out = out.replace(
    /\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
    '[REDACTED_JWE]',
  );
  out = out.replace(
    /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{8,}\b/g,
    '[REDACTED_JWS]',
  );

  // Tremend website keys
  out = out.replace(/\bvo_[A-Za-z0-9_-]{6,}\b/g, '[REDACTED_VERIFIER_KEY]');

  // IBANs (e.g., RO49AAAA1B31007593840000)
  out = out.replace(/\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/g, '[REDACTED_IBAN]');

  // Romanian 13-digit CNP
  out = out.replace(/\b[1-8]\d{12}\b/g, '[REDACTED_CNP]');

  return out;
}

/**
 * Deep-clones an object/value while redacting sensitive keys and token/PII patterns.
 */
export function redactObject(value: unknown, depth = 0): unknown {
  if (depth > 8) {
    return '[TRUNCATED]';
  }
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === 'string') {
    return redactString(value);
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactString(value.message),
    };
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactObject(item, depth + 1));
  }
  if (typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEYS.has(key.toLowerCase())) {
        result[key] = REDACTED;
      } else {
        result[key] = redactObject(val, depth + 1);
      }
    }
    return result;
  }
  return String(value);
}

/**
 * Writes a single sanitized JSON log entry to stdout/stderr. Never logs raw PII, tokens, or secrets.
 */
export function safeLog(
  level: 'info' | 'warn' | 'error',
  message: string,
  meta?: Record<string, unknown>,
): void {
  const entry = {
    ts: new Date().toISOString(),
    level,
    msg: redactString(message),
    ...(meta ? { meta: redactObject(meta) } : {}),
  };
  const serialized = JSON.stringify(entry);
  if (level === 'error') {
    console.error(serialized);
  } else {
    console.log(serialized);
  }
}
