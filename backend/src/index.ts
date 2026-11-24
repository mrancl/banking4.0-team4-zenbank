import { loadConfig } from './config.js';
import { safeLog } from './logging.js';
import { createApp } from './server.js';

const config = loadConfig();
const { app } = await createApp(config);

const server = app.listen(config.port, () => {
  safeLog('info', 'ZenBank EUDI backend listening', {
    port: config.port,
    verifierMode: config.verifierMode,
    profileCode: config.profileCode,
    resultKeyLoaded: Boolean(config.resultPrivateKeyPem),
    geminiConfigured: Boolean(config.geminiApiKey),
  });
});

server.requestTimeout = 300_000;
server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;
