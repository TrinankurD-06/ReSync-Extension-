// Test helpers: one in-memory MongoDB per test file, an app with dev login, and signed-in agents.
import { beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import { Writable } from 'node:stream';
import { loadConfig } from '../src/config.js';
import { createLogger } from '../src/lib/logger.js';
import { createApp } from '../src/app.js';

/** Captured log lines, to check that logs never contain secrets or bodies. */
export const logLines = [];

export function testConfig(over = {}) {
  return {
    ...loadConfig({ NODE_ENV: 'test', SESSION_SECRET: 'test-secret-test-secret-test-secret', ALLOW_DEV_LOGIN: 'true', DASHBOARD_URL: 'http://dash.test', PUBLIC_SERVER_URL: 'http://api.test', CORS_ORIGINS: 'chrome-extension://abcdefghijklmnop', GITHUB_CLIENT_ID: 'gh-id', GITHUB_CLIENT_SECRET: 'gh-secret', GOOGLE_CLIENT_ID: 'g-id', GOOGLE_CLIENT_SECRET: 'g-secret' }),
    ...over,
  };
}

export function makeApp(o = {}) {
  const destination = new Writable({ write(chunk, _enc, cb) { logLines.push(chunk.toString()); cb(); } });
  return createApp({ config: testConfig(o.config), logger: createLogger({ level: 'info', destination }), fetch: o.fetch, rateLimits: o.rateLimits ?? false });
}

/** Start an in-memory MongoDB for this test file and clear it between tests. */
export function useDb() {
  let mongod;
  beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    await mongoose.connect(mongod.getUri());
    await Promise.all(Object.values(mongoose.models).map((m) => m.syncIndexes()));
  }, 120_000);
  beforeEach(async () => {
    await Promise.all(Object.values(mongoose.models).map((m) => m.deleteMany({})));
    logLines.length = 0;
  });
  afterAll(async () => {
    await mongoose.disconnect();
    await mongod?.stop();
  });
}

/**
 * A supertest agent signed in through dev login (cookie session), with the CSRF header on writes.
 * @param {import('express').Express} app
 * @param {string} email
 */
export async function signIn(app, email, name) {
  const agent = request.agent(app);
  const r = await agent.post('/api/v1/auth/dev-login').send({ email, name });
  if (r.status !== 200) throw new Error(`dev login failed: ${r.status} ${JSON.stringify(r.body)}`);
  const csrf = (req) => req.set('x-resync-csrf', '1');
  return {
    agent,
    user: r.body.user,
    get: (url) => agent.get(url),
    post: (url, body) => csrf(agent.post(url)).send(body ?? {}),
    put: (url, body) => csrf(agent.put(url)).send(body ?? {}),
    patch: (url, body) => csrf(agent.patch(url)).send(body ?? {}),
    del: (url, body) => csrf(agent.delete(url)).send(body ?? {}),
  };
}

/** Get a personal (Bearer) token for a signed-in user through the device-code flow. */
export async function personalToken(app, signedIn, label = 'resync CLI') {
  const start = await request(app).post('/api/v1/auth/device/code').send({ label });
  await signedIn.post('/api/v1/auth/device/approve', { userCode: start.body.userCode, approve: true });
  const r = await request(app).post('/api/v1/auth/device/token').send({ deviceCode: start.body.deviceCode });
  return r.body.token;
}
