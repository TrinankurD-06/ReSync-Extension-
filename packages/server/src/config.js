// Server configuration, from environment variables only (spec: nothing tied to us). See .env.example.

/**
 * @typedef {{
 *   port: number,
 *   mongodbUri: string,
 *   publicServerUrl: string,
 *   dashboardUrl: string,
 *   corsOrigins: string[],
 *   sessionSecret: string,
 *   github: { clientId: string, clientSecret: string },
 *   google: { clientId: string, clientSecret: string },
 *   allowDevLogin: boolean,
 *   logLevel: string,
 *   production: boolean,
 *   serveDashboard: string,     path to a built dashboard to serve (same origin), or ''
 *   trustProxy: boolean,
 * }} ServerConfig
 */

/** @param {Record<string, string | undefined>} [env] @returns {ServerConfig} */
export function loadConfig(env = process.env) {
  const list = (s) => (s ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  const strip = (s) => (s ?? '').replace(/\/+$/, '');
  const production = env.NODE_ENV === 'production';
  const cfg = {
    port: Number(env.PORT ?? 8787),
    mongodbUri: env.MONGODB_URI ?? 'mongodb://localhost:27017/resync',
    publicServerUrl: strip(env.PUBLIC_SERVER_URL ?? `http://localhost:${env.PORT ?? 8787}`),
    dashboardUrl: strip(env.DASHBOARD_URL ?? 'http://localhost:5173'),
    corsOrigins: list(env.CORS_ORIGINS),
    sessionSecret: env.SESSION_SECRET ?? '',
    github: { clientId: env.GITHUB_CLIENT_ID ?? '', clientSecret: env.GITHUB_CLIENT_SECRET ?? '' },
    google: { clientId: env.GOOGLE_CLIENT_ID ?? '', clientSecret: env.GOOGLE_CLIENT_SECRET ?? '' },
    allowDevLogin: env.ALLOW_DEV_LOGIN === 'true',
    logLevel: env.LOG_LEVEL ?? 'info',
    production,
    serveDashboard: env.SERVE_DASHBOARD ?? '',
    trustProxy: env.TRUST_PROXY === 'true',
  };
  if (production) {
    if (!cfg.sessionSecret || cfg.sessionSecret === 'change-me' || cfg.sessionSecret.length < 32) {
      throw new Error('SESSION_SECRET must be set to a random string of at least 32 characters in production.');
    }
    if (cfg.allowDevLogin) throw new Error('ALLOW_DEV_LOGIN must not be enabled in production.');
  }
  return cfg;
}

/** Which sign-in methods are configured (the dashboard shows only these). @param {ServerConfig} cfg */
export function authProviders(cfg) {
  return {
    github: Boolean(cfg.github.clientId && cfg.github.clientSecret),
    google: Boolean(cfg.google.clientId && cfg.google.clientSecret),
    dev: cfg.allowDevLogin,
  };
}
