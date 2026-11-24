import { loadConfig } from './config.js';
import { safeLog } from './logging.js';
import { createApp } from './server.js';

const config = loadConfig();
const { app } = await createApp(config);

app.listen(config.port, () => {
  safeLog('info', 'ZenBank EUDI backend listening', {
    port: config.port,
    verifierMode: config.verifierMode,
    profileCode: config.profileCode,
    resultKeyLoaded: Boolean(config.resultPrivateKeyPem),
    geminiConfigured: Boolean(config.geminiApiKey),
  });
});
