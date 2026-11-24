import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_ROOT = path.resolve(__dirname, '..');

dotenv.config({ path: path.join(BACKEND_ROOT, '.env') });

export interface AppConfig {
  port: number;
  verifierMode: 'live' | 'mock';
  verifierUrl: string;
  verifierKey: string;
  verifierSecret: string;
  resultAudience: string;
  profileCode: string;
  resultPrivateKeyPem: string;
  geminiApiKey: string;
  geminiModel: string;
  frontendDistDir: string;
}

function loadPrivateKeyPem(): string {
  const inlinePem = process.env.RESULT_PRIVATE_KEY_PEM?.trim();
  if (inlinePem) {
    return inlinePem.replace(/\\n/g, '\n');
  }

  const keyPath = process.env.RESULT_PRIVATE_KEY_PATH?.trim();
  if (!keyPath) {
    return '';
  }

  const resolved = path.isAbsolute(keyPath)
    ? keyPath
    : path.resolve(BACKEND_ROOT, keyPath);

  if (!fs.existsSync(resolved)) {
    return '';
  }
  return fs.readFileSync(resolved, 'utf8').trim();
}

/**
 * Loads application configuration from environment variables and backend/.env.
 */
export function loadConfig(): AppConfig {
  const modeRaw = (process.env.VERIFIER_MODE ?? 'live').toLowerCase();
  const verifierMode = modeRaw === 'mock' ? 'mock' : 'live';
  const parsedPort = Number.parseInt(process.env.PORT ?? '3001', 10);

  return {
    port: Number.isFinite(parsedPort) && parsedPort > 0 ? parsedPort : 3001,
    verifierMode,
    verifierUrl: (
      process.env.EUDI_VERIFIER_URL ??
      'https://srv-verifier-ui-prod-yrqn8u.wittyflower-739866d8.westeurope.azurecontainerapps.io'
    ).replace(/\/+$/, ''),
    verifierKey: process.env.EUDI_VERIFIER_KEY?.trim() ?? '',
    verifierSecret: process.env.EUDI_VERIFIER_SECRET?.trim() ?? '',
    resultAudience:
      process.env.EUDI_VERIFIER_RESULT_AUDIENCE?.trim() ??
      '646562f7-a30d-4536-92a8-56f358aaf035',
    profileCode: process.env.VERIFIER_PROFILE_CODE?.trim() ?? 'qa-both-23',
    resultPrivateKeyPem: loadPrivateKeyPem(),
    geminiApiKey: process.env.GEMINI_API_KEY?.trim() ?? '',
    geminiModel: process.env.GEMINI_MODEL?.trim() || 'gemini-4-hydrogen',
    frontendDistDir: path.resolve(BACKEND_ROOT, '..', 'frontend', 'dist'),
  };
}
