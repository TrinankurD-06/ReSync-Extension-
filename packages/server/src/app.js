// The ReSync team server (Express). REST under /api/v1 with validation on every route, rate limiting, CORS
// restricted to the dashboard and extension origins, helmet, and logs without bodies or tokens.
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { rateLimit } from 'express-rate-limit';
import path from 'node:path';
import { existsSync } from 'node:fs';
import * as models from './models/index.js';
import { authenticate } from './lib/auth.js';
import { requestLogger } from './lib/logger.js';
import { errorHandler, notFound } from './lib/http.js';
import { authRoutes } from './routes/auth.js';
import { meRoutes } from './routes/me.js';
import { teamRoutes } from './routes/teams.js';
import { promptRoutes } from './routes/prompts.js';
import { dataRoutes } from './routes/data.js';

/**
 * @param {{ config: import('./config.js').ServerConfig, logger: import('pino').Logger, fetch?: typeof fetch, rateLimits?: boolean }} o
 */
export function createApp(o) {
  const { config: cfg, logger } = o;
  const app = express();
  if (cfg.trustProxy) app.set('trust proxy', 1); // behind Render/other proxies, for correct client IPs
  app.disable('x-powered-by');

  app.use(helmet({ contentSecurityPolicy: cfg.serveDashboard ? { directives: { 'img-src': ["'self'", 'data:', 'https://avatars.githubusercontent.com', 'https://*.googleusercontent.com'] } } : false }));

  // CORS: only the dashboard and configured extension origins (chrome-extension://<id>) may call the API.
  const allowed = new Set([cfg.dashboardUrl, ...cfg.corsOrigins].filter(Boolean));
  app.use('/api', cors({
    origin: (origin, cb) => cb(null, !origin || allowed.has(origin)),
    credentials: true,
    allowedHeaders: ['content-type', 'authorization', 'x-resync-csrf', 'x-resync-client'],
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    maxAge: 600,
  }));

  if (o.rateLimits !== false) {
    app.use('/api', rateLimit({ windowMs: 15 * 60_000, limit: 600, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: { code: 'rate_limited', message: 'Too many requests. Try again in a few minutes.' } } }));
    // Stricter on sign-in endpoints (device-code polling is allowed through at its own pace).
    app.use(['/api/v1/auth/dev-login', '/api/v1/auth/device/code', '/api/v1/auth/github', '/api/v1/auth/google'], rateLimit({ windowMs: 15 * 60_000, limit: 60, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: { code: 'rate_limited', message: 'Too many sign-in attempts. Wait a few minutes.' } } }));
  }

  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser(cfg.sessionSecret || 'dev-only-secret'));
  app.use(requestLogger(logger));

  const api = express.Router();
  api.get('/health', (_req, res) => res.json({ ok: true, service: 'resync-server', version: '0.1.0' }));
  api.use(authenticate(models));
  api.use(authRoutes(cfg, { fetch: o.fetch }));
  api.use(meRoutes(cfg));
  api.use(teamRoutes(cfg));
  api.use(promptRoutes());
  api.use(dataRoutes());
  api.use((_req, _res, next) => next(notFound('No such API route.')));
  app.use('/api/v1', api);

  // Self-hosting: serve the built dashboard from the same origin (single free service; no CORS needed).
  if (cfg.serveDashboard && existsSync(cfg.serveDashboard)) {
    const dir = path.resolve(cfg.serveDashboard);
    app.use(express.static(dir, { index: 'index.html', maxAge: '1h' }));
    app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(path.join(dir, 'index.html')));
  }

  app.use(errorHandler(logger));
  return app;
}
