import { normalizeForMatch } from '../banking/rules.js';
import type { ZenBankCustomerProfile } from '../types.js';

const REDACTED_PII = '[REDACTED_PII]';
const GENERIC_EMPLOYER_PLACEHOLDERS = new Set([
  'nedeclarat / necesita actualizare',
  'neconfirmat',
  'nespecificat',
]);

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getForbiddenEmployer(customer: ZenBankCustomerProfile): string | null {
  const emp = customer.currentIncome?.employer?.trim();
  if (!emp) return null;
  if (GENERIC_EMPLOYER_PLACEHOLDERS.has(normalizeForMatch(emp))) {
    return null;
  }
  return emp;
}

function buildDynamicTokens(
  customer: ZenBankCustomerProfile,
  extraForbidden: string[] = [],
): string[] {
  const employer = getForbiddenEmployer(customer);
  const rawValues = [
    customer.givenName,
    customer.familyName,
    `${customer.givenName} ${customer.familyName}`,
    customer.birthdate,
    customer.documentNumberMasked,
    customer.currentAddress.streetAddress,
    customer.currentAddress.postalCode,
    customer.currentAddress.formatted,
    ...(employer ? [employer] : []),
    ...extraForbidden,
  ];

  const stopWords = new Set(['bucuresti', 'romania', 'timisoara', 'srl', 'sa', 'actualizare']);
  const tokens = new Set<string>();

  for (const val of rawValues) {
    const trimmed = val?.trim();
    if (trimmed && trimmed.length >= 3) {
      tokens.add(trimmed);
    }
    if (trimmed) {
      for (const part of trimmed.split(/[\s,]+/)) {
        const clean = part.trim();
        if (clean.length >= 4 && !stopWords.has(normalizeForMatch(clean))) {
          tokens.add(clean);
        }
      }
    }
  }

  return Array.from(tokens).sort((a, b) => b.length - a.length);
}

/**
 * Scrubs both generic PII/token patterns (IBAN, CNP, dates, emails, phone numbers, JWE/JWS)
 * and active customer-specific PII tokens from user text before any LLM call.
 */
export function scrubUserMessage(
  message: string,
  customer: ZenBankCustomerProfile,
  extraForbidden: string[] = [],
): { scrubbedText: string; hadPii: boolean } {
  let scrubbed = message;
  let hadPii = false;

  const patterns: RegExp[] = [
    // PEM & JOSE tokens
    /-----BEGIN [A-Z0-9 ]+-----[\s\S]*?-----END [A-Z0-9 ]+-----/g,
    /\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
    /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{8,}\b/g,
    // IBAN
    /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/gi,
    // Romanian CNP (13 digits starting with 1-8)
    /\b[1-8]\d{12}\b/g,
    // Email addresses
    /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
    // Phone numbers (8+ digits with optional separators/+)
    /(?:\+?\d[\d\s().-]{7,}\d)/g,
    // Dates (YYYY-MM-DD, DD.MM.YYYY, DD/MM/YYYY)
    /\b\d{4}-\d{2}-\d{2}\b/g,
    /\b\d{2}[./-]\d{2}[./-]\d{4}\b/g,
  ];

  for (const regex of patterns) {
    const next = scrubbed.replace(regex, REDACTED_PII);
    if (next !== scrubbed) {
      hadPii = true;
      scrubbed = next;
    }
  }

  // Dynamic customer PII tokens (diacritic-insensitive)
  const dynamicTokens = buildDynamicTokens(customer, extraForbidden);
  for (const token of dynamicTokens) {
    const directRegex = new RegExp(`\\b${escapeRegex(token)}\\b`, 'gi');
    const nextDirect = scrubbed.replace(directRegex, REDACTED_PII);
    if (nextDirect !== scrubbed) {
      hadPii = true;
      scrubbed = nextDirect;
      continue;
    }

    const normToken = normalizeForMatch(token);
    const normScrubbed = normalizeForMatch(scrubbed);
    if (normToken.length >= 4 && normScrubbed.includes(normToken)) {
      const asciiRegex = new RegExp(`\\b${escapeRegex(normToken)}\\b`, 'gi');
      const nextAscii = scrubbed.replace(asciiRegex, REDACTED_PII);
      if (nextAscii !== scrubbed) {
        hadPii = true;
        scrubbed = nextAscii;
      } else {
        const words = scrubbed.split(/(\s+)/);
        scrubbed = words
          .map((w) => (normalizeForMatch(w) === normToken ? REDACTED_PII : w))
          .join('');
        hadPii = true;
      }
    }
  }

  return { scrubbedText: scrubbed, hadPii };
}

/**
 * Runtime guard executed right before invoking Gemini.
 * Verifies zero customer PII values or raw tokens appear in the serialized outbound payload.
 */
export function assertZeroPii(
  serializedPayload: string,
  customer: ZenBankCustomerProfile,
  extraForbidden: string[] = [],
): void {
  const normalizedPayload = normalizeForMatch(serializedPayload);
  const employer = getForbiddenEmployer(customer);
  const forbidden = [
    customer.givenName,
    customer.familyName,
    customer.birthdate,
    customer.documentNumberMasked,
    customer.currentAddress.streetAddress,
    customer.currentAddress.postalCode,
    ...(employer ? [employer] : []),
    ...extraForbidden,
  ]
    .map((v) => v?.trim())
    .filter((v): v is string => Boolean(v && v.length >= 3));

  for (const value of forbidden) {
    const normVal = normalizeForMatch(value);
    if (!normVal) continue;
    const isAlphaWord = /^[a-z0-9]+$/i.test(normVal);
    const matched = isAlphaWord
      ? new RegExp(`\\b${escapeRegex(normVal)}\\b`, 'i').test(normalizedPayload)
      : normalizedPayload.includes(normVal);
    if (matched) {
      throw new Error('Zero-PII guard blocked outbound LLM payload containing customer PII.');
    }
  }

  if (/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\./.test(serializedPayload)) {
    throw new Error('Zero-PII guard blocked outbound LLM payload containing JOSE token.');
  }
}
