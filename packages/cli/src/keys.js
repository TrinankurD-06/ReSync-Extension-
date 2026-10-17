// API keys: OS keychain (via @napi-rs/keyring) with an environment-variable fallback.
// Key VALUES never go to config files, logs, the ReSync server, or stdout.
import { loadConfig, saveConfig } from './config.js';

const SERVICE = 'resync-cli';

/**
 * Environment variable names checked for a provider, most specific first.
 * e.g. anthropic -> RESYNC_ANTHROPIC_API_KEY, ANTHROPIC_API_KEY
 * @param {string} provider
 */
export function envNamesFor(provider) {
  const up = provider.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
  const names = [`RESYNC_${up}_API_KEY`];
  const common = { ANTHROPIC: 'ANTHROPIC_API_KEY', OPENAI: 'OPENAI_API_KEY', GEMINI: 'GEMINI_API_KEY', OPENROUTER: 'OPENROUTER_API_KEY' };
  if (common[up]) names.push(common[up]);
  return names;
}

/**
 * A key store. The default uses the OS keychain; tests inject an in-memory one.
 * @typedef {{ get(account: string): Promise<string | null>, set(account: string, value: string): Promise<void>, delete(account: string): Promise<boolean>, available(): Promise<boolean> }} KeyStore
 */

/** @returns {KeyStore} */
export function osKeychain() {
  /** @type {Promise<any> | undefined} */
  let mod;
  const load = () => (mod ??= import('@napi-rs/keyring').catch(() => null));
  return {
    async available() {
      const m = await load();
      if (!m) return false;
      try {
        new m.Entry(SERVICE, '__resync_probe__').getPassword();
        return true;
      } catch {
        return false;
      }
    },
    async get(account) {
      const m = await load();
      if (!m) return null;
      try {
        return new m.Entry(SERVICE, account).getPassword() ?? null;
      } catch {
        return null;
      }
    },
    async set(account, value) {
      const m = await load();
      if (!m) throw new Error('The OS keychain is not available on this system. Use an environment variable instead (see `resync keys set --help`).');
      new m.Entry(SERVICE, account).setPassword(value);
    },
    async delete(account) {
      const m = await load();
      if (!m) return false;
      try {
        return Boolean(new m.Entry(SERVICE, account).deletePassword());
      } catch {
        return false;
      }
    },
  };
}

/** @type {KeyStore} */
let store = osKeychain();

/** Replace the key store (tests). @param {KeyStore} s */
export function setKeyStore(s) {
  store = s;
}

/**
 * Store a key for a provider id in the keychain and remember (only) the provider name.
 * @param {string} provider
 * @param {string} key
 */
export async function setKey(provider, key) {
  const value = String(key ?? '').trim();
  if (!value) throw new Error('Empty key: nothing stored.');
  await store.set(provider, value);
  const cfg = await loadConfig();
  if (!cfg.keys.providers.includes(provider)) cfg.keys.providers.push(provider);
  await saveConfig(cfg);
}

/**
 * Find a provider's key: keychain first, then environment variables.
 * @param {string} provider provider id (as in config ai.providers)
 * @param {string} [type] adapter type, used for the env fallback names
 * @returns {Promise<{ key: string, source: 'keychain' | 'env', envName?: string } | null>}
 */
export async function getKey(provider, type) {
  const fromStore = await store.get(provider);
  if (fromStore) return { key: fromStore, source: 'keychain' };
  for (const name of new Set([...envNamesFor(provider), ...(type ? envNamesFor(type) : [])])) {
    if (process.env[name]) return { key: process.env[name], source: 'env', envName: name };
  }
  return null;
}

/** @param {string} provider */
export async function removeKey(provider) {
  const removed = await store.delete(provider);
  const cfg = await loadConfig();
  cfg.keys.providers = cfg.keys.providers.filter((p) => p !== provider);
  await saveConfig(cfg);
  return removed;
}

/**
 * Which providers have a key, and where it comes from. Never returns key values.
 * @returns {Promise<{ provider: string, source: string }[]>}
 */
export async function listKeys() {
  const cfg = await loadConfig();
  const ids = new Set([...cfg.keys.providers, ...Object.keys(cfg.ai.providers)]);
  const out = [];
  for (const id of ids) {
    const type = cfg.ai.providers[id]?.type;
    const k = await getKey(id, type);
    if (k) out.push({ provider: id, source: k.source === 'env' ? `env ${k.envName}` : 'OS keychain' });
    else if (type && type !== 'openai-compatible') out.push({ provider: id, source: 'missing' });
  }
  return out;
}

/**
 * Non-provider secrets (the ReSync server token): same keychain, but not listed as AI providers.
 * @param {string} account
 */
export async function getSecret(account) {
  return store.get(account);
}
/** @param {string} account @param {string} value */
export async function setSecret(account, value) {
  await store.set(account, value);
}
/** @param {string} account */
export async function removeSecret(account) {
  return store.delete(account);
}

/**
 * Build a ProviderConfig (with key) for the provider layer.
 * @param {import('./config.js').ReSyncConfig} cfg
 * @param {string} providerId
 */
export async function providerConfig(cfg, providerId) {
  const p = cfg.ai.providers[providerId];
  if (!p) throw new Error(`Provider "${providerId}" is not configured. Add it with \`resync provider add\`.`);
  const k = await getKey(providerId, p.type);
  return { ...p, apiKey: k?.key };
}
