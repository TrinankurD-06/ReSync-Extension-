// Start the ReSync server: connect to MongoDB, then listen.
import mongoose from 'mongoose';
import { loadConfig, authProviders } from './config.js';
import { createLogger } from './lib/logger.js';
import { createApp } from './app.js';

const config = loadConfig();
const logger = createLogger({ level: config.logLevel });

try {
  await mongoose.connect(config.mongodbUri);
} catch (e) {
  logger.error({ err: { message: e.message } }, 'could not connect to MongoDB; check MONGODB_URI');
  process.exit(1);
}

const app = createApp({ config, logger });
const server = app.listen(config.port, () => {
  logger.info({ port: config.port, publicUrl: config.publicServerUrl, dashboard: config.dashboardUrl, signIn: authProviders(config), servesDashboard: Boolean(config.serveDashboard) }, 'resync server listening');
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    server.close(() => mongoose.disconnect().finally(() => process.exit(0)));
  });
}
