import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import cors from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { ZeroPiiAssistant } from './agent/geminiAssistant.js';
import { JourneyOrchestrator } from './agent/orchestrator.js';
import type { AppConfig } from './config.js';
import { safeLog } from './logging.js';
import {
  LiveVerifierClient,
  MockVerifierClient,
  VerifierHttpError,
  type VerifierClient,
} from './verifier/client.js';
import { createVerifierJwks, type JwksResolver } from './verifier/crypto.js';

const chatSchema = z.object({
  message: z.string().min(1).max(1000),
  quickAction: z
    .enum(['START_DATA_UPDATE', 'EXPLAIN_PAYMENT_RESTRICTION', 'EXPLAIN_PRIVACY'])
    .optional(),
});

const confirmSchema = z.object({
  pendingUpdateId: z.string().min(1),
  mode: z.enum(['UPDATE_PROFILE', 'UPDATE_ADDRESS', 'IDENTITY_ONLY']),
});

const scenarioSchema = z.object({
  customerId: z.enum(['radu', 'alex', 'maria']),
  scenario: z.enum(['data_update', 'payment_restricted']),
});

const unhappySchema = z.object({
  kind: z.enum(['DECLINED', 'WITHHELD_ADDRESS', 'EXPIRED', 'WALLET_ERROR']),
});

export interface ServerContext {
  app: express.Express;
  orchestrator: JourneyOrchestrator;
  verifierClient: VerifierClient;
}

function resolveSessionId(req: Request): string {
  const header = req.header('X-Session-Id')?.trim();
  if (header && /^[a-zA-Z0-9_-]{4,80}$/.test(header)) {
    return header;
  }
  return 'default-demo-session';
}

/**
 * Creates the Express application with optional dependency injection for tests.
 */
export async function createApp(
  config: AppConfig,
  overrides?: {
    verifierClient?: VerifierClient;
    jwks?: JwksResolver;
    assistant?: ZeroPiiAssistant;
  },
): Promise<ServerContext> {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '1mb' }));

  let verifierClient: VerifierClient;
  let jwks: JwksResolver;
  let effectivePrivateKeyPem = config.resultPrivateKeyPem;

  if (overrides?.verifierClient && overrides?.jwks) {
    verifierClient = overrides.verifierClient;
    jwks = overrides.jwks;
  } else if (config.verifierMode === 'mock') {
    let orgPublicKeyPem = '';
    if (effectivePrivateKeyPem) {
      orgPublicKeyPem = crypto
        .createPublicKey(effectivePrivateKeyPem)
        .export({ type: 'spki', format: 'pem' })
        .toString();
    } else {
      const generated = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
      effectivePrivateKeyPem = generated.privateKey
        .export({ type: 'pkcs8', format: 'pem' })
        .toString();
      orgPublicKeyPem = generated.publicKey
        .export({ type: 'spki', format: 'pem' })
        .toString();
    }
    const mockClient = new MockVerifierClient({
      issuer: config.verifierUrl,
      audience: config.resultAudience,
      orgPublicKeyPem,
    });
    verifierClient = overrides?.verifierClient ?? mockClient;
    jwks = overrides?.jwks ?? (await mockClient.getJwksResolver());
  } else {
    verifierClient =
      overrides?.verifierClient ??
      new LiveVerifierClient({
        baseUrl: config.verifierUrl,
        websiteKey: config.verifierKey,
        websiteSecret: config.verifierSecret,
      });
    jwks = overrides?.jwks ?? createVerifierJwks(config.verifierUrl);
  }

  const assistant =
    overrides?.assistant ??
    new ZeroPiiAssistant({
      geminiApiKey: config.geminiApiKey,
      model: config.geminiModel,
    });

  const orchestrator = new JourneyOrchestrator({
    verifierClient,
    jwks,
    assistant,
    issuer: config.verifierUrl,
    audience: config.resultAudience,
    profileCode: config.profileCode,
    privateKeyPem: effectivePrivateKeyPem,
  });

  app.get('/api/health', (_req: Request, res: Response) => {
    res.json({
      ok: true,
      verifierMode: config.verifierMode,
      profileCode: config.profileCode,
      resultKeyLoaded: Boolean(config.resultPrivateKeyPem),
      geminiConfigured: Boolean(config.geminiApiKey),
    });
  });

  app.get('/api/verifier/health', async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const [status, profiles] = await Promise.all([
        verifierClient.getStatus(),
        verifierClient.getProfiles(),
      ]);
      res.json({
        websiteStatus: status.status,
        profiles: profiles.map((p) => ({
          code: p.code,
          name: p.name,
          mode: p.mode,
          default: Boolean(p.default),
        })),
      });
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/session', (req: Request, res: Response) => {
    res.json(orchestrator.getPublicState(resolveSessionId(req)));
  });

  app.post('/api/chat', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = chatSchema.parse(req.body);
      const state = await orchestrator.handleChat(
        resolveSessionId(req),
        parsed.message,
        parsed.quickAction,
      );
      res.json(state);
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/verifications/start', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const state = await orchestrator.startVerification(resolveSessionId(req));
      res.status(201).json(state);
    } catch (err) {
      next(err);
    }
  });

  app.get(
    '/api/verifications/:transactionId/poll',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const txId = String(req.params.transactionId ?? '');
        const state = await orchestrator.pollVerification(resolveSessionId(req), txId);
        res.json(state);
      } catch (err) {
        next(err);
      }
    },
  );

  app.post('/api/profile/confirm-update', (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = confirmSchema.parse(req.body);
      const state = orchestrator.confirmUpdate(resolveSessionId(req), parsed);
      res.json(state);
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/demo/scenario', (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = scenarioSchema.parse(req.body);
      const state = orchestrator.switchScenario(
        resolveSessionId(req),
        parsed.customerId,
        parsed.scenario,
      );
      res.json(state);
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/demo/reset', (req: Request, res: Response) => {
    res.json(orchestrator.resetSession(resolveSessionId(req)));
  });

  app.post('/api/demo/simulate-unhappy', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = unhappySchema.parse(req.body);
      const state = await orchestrator.simulateUnhappy(resolveSessionId(req), parsed.kind);
      res.json(state);
    } catch (err) {
      next(err);
    }
  });

  // Serve built frontend static bundle when present
  if (fs.existsSync(config.frontendDistDir)) {
    app.use(express.static(config.frontendDistDir));
    app.get('*', (req: Request, res: Response, next: NextFunction) => {
      if (req.path.startsWith('/api/')) {
        next();
        return;
      }
      res.sendFile(path.join(config.frontendDistDir, 'index.html'));
    });
  }

  // Sanitized error handler (never exposes stack traces, tokens, or secrets)
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: 'Invalid request payload' });
      return;
    }
    if (err instanceof VerifierHttpError) {
      safeLog('warn', 'Verifier HTTP error', { status: err.statusCode, code: err.code });
      res.status(err.statusCode >= 400 && err.statusCode < 600 ? err.statusCode : 502).json({
        error: err.message,
        code: err.code,
      });
      return;
    }
    safeLog('error', 'Unhandled request error', { err });
    res.status(500).json({ error: 'Internal server error' });
  });

  return { app, orchestrator, verifierClient };
}
