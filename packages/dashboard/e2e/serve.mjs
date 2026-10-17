// Test server for the dashboard smoke tests: in-memory MongoDB + the real ReSync server app, serving the built
// dashboard from the same origin (as in docker-compose), with dev login enabled (tests only).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { loadConfig } from '../../server/src/config.js';
import { createLogger } from '../../server/src/lib/logger.js';
import { createApp } from '../../server/src/app.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.E2E_PORT ?? 4319);
const origin = `http://127.0.0.1:${port}`;

const mongod = await MongoMemoryServer.create();
await mongoose.connect(mongod.getUri());

const config = loadConfig({
  NODE_ENV: 'test', PORT: String(port), SESSION_SECRET: 'e2e-secret-e2e-secret-e2e-secret-e2e',
  ALLOW_DEV_LOGIN: 'true', DASHBOARD_URL: origin, PUBLIC_SERVER_URL: origin, SERVE_DASHBOARD: path.resolve(here, '../dist'),
});
const app = createApp({ config, logger: createLogger({ level: 'warn' }), rateLimits: false });
const server = app.listen(port, '127.0.0.1', () => console.log(`e2e server on ${origin}`));

const stop = async () => {
  server.close();
  await mongoose.disconnect();
  await mongod.stop();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
