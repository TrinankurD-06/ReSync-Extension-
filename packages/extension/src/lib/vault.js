// API key vault for the extension (spec section 5): keys are encrypted with a passphrase-derived key and stored
// in chrome.storage.local (never chrome.storage.sync, never sent to the ReSync server).
// - PBKDF2-HMAC-SHA256, 600,000 iterations (OWASP), random 16-byte salt -> AES-GCM 256, fresh 12-byte IV
//   per encryption (docs/VERIFIED.md, "WebCrypto").
// - Unlocking puts the raw AES key in chrome.storage.session: in memory, not visible to content scripts by
//   default, cleared when the browser restarts (or the extension reloads/updates). So keys stay locked
//   until the user unlocks once per browser session.

export const DEFAULT_ITERATIONS = 600_000;
const VAULT_KEY = 'resync.vault';
const SESSION_KEY = 'resync.vaultKey';
const CHECK_TEXT = 'resync-vault-ok';

const enc = new TextEncoder();
const dec = new TextDecoder();

/** @param {ArrayBuffer | Uint8Array} buf */
export function toB64(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
/** @param {string} b64 */
export function fromB64(b64) {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

/**
 * @param {string} passphrase
 * @param {Uint8Array} salt
 * @param {number} iterations
 */
async function deriveKey(passphrase, salt, iterations) {
  const base = await crypto.subtle.importKey('raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  // Extractable so the unlocked key can live in storage.session for this browser session.
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
}

/** @param {CryptoKey} key @param {string} text */
async function encrypt(key, text) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(text));
  return { iv: toB64(iv), ct: toB64(ct) };
}

/** @param {CryptoKey} key @param {{ iv: string, ct: string }} box */
async function decrypt(key, box) {
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(box.iv) }, key, fromB64(box.ct));
  return dec.decode(pt);
}

export class VaultLockedError extends Error {
  constructor() {
    super('Keys are locked. Unlock them with your passphrase in ReSync Settings.');
    this.name = 'VaultLockedError';
  }
}

/**
 * @typedef {{ get(key: string): Promise<Record<string, any>>, set(items: Record<string, any>): Promise<void>, remove(key: string): Promise<void> }} StorageArea
 * @param {{ local?: StorageArea, session?: StorageArea, iterations?: number }} [o]
 */
export function createVault(o = {}) {
  const local = o.local ?? chrome.storage.local;
  const session = o.session ?? chrome.storage.session;
  const iterations = o.iterations ?? DEFAULT_ITERATIONS;

  const readVault = async () => (await local.get(VAULT_KEY))[VAULT_KEY] ?? null;
  const writeVault = (v) => local.set({ [VAULT_KEY]: v });

  /** The unlocked AES key, or null. */
  async function sessionKey() {
    const raw = (await session.get(SESSION_KEY))[SESSION_KEY];
    if (!raw) return null;
    return crypto.subtle.importKey('raw', fromB64(raw), { name: 'AES-GCM' }, true, ['encrypt', 'decrypt']);
  }

  async function requireKey() {
    const k = await sessionKey();
    if (!k) throw new VaultLockedError();
    return k;
  }

  return {
    /** Has a passphrase been set up? */
    async exists() {
      return Boolean(await readVault());
    },
    async isUnlocked() {
      return Boolean(await sessionKey());
    },
    /** Provider ids with a stored key (no unlock needed; never returns key values). */
    async providers() {
      return Object.keys((await readVault())?.keys ?? {});
    },

    /**
     * Create the vault with a new passphrase (also unlocks it).
     * @param {string} passphrase
     */
    async create(passphrase) {
      if (String(passphrase).length < 8) throw new Error('Use a passphrase of at least 8 characters.');
      if (await readVault()) throw new Error('A vault already exists. Unlock it, or reset it to start over.');
      const salt = crypto.getRandomValues(new Uint8Array(16));
      const key = await deriveKey(passphrase, salt, iterations);
      await writeVault({ version: 1, kdf: 'PBKDF2-SHA256', iterations, salt: toB64(salt), check: await encrypt(key, CHECK_TEXT), keys: {} });
      await session.set({ [SESSION_KEY]: toB64(await crypto.subtle.exportKey('raw', key)) });
    },

    /**
     * Unlock for this browser session. Returns false for a wrong passphrase.
     * @param {string} passphrase
     */
    async unlock(passphrase) {
      const v = await readVault();
      if (!v) throw new Error('No vault yet: set a passphrase first.');
      const key = await deriveKey(passphrase, fromB64(v.salt), v.iterations);
      try {
        if ((await decrypt(key, v.check)) !== CHECK_TEXT) return false;
      } catch {
        return false; // AES-GCM authentication failed: wrong passphrase
      }
      await session.set({ [SESSION_KEY]: toB64(await crypto.subtle.exportKey('raw', key)) });
      return true;
    },

    async lock() {
      await session.remove(SESSION_KEY);
    },

    /** @param {string} provider @param {string} apiKey */
    async setKey(provider, apiKey) {
      const value = String(apiKey ?? '').trim();
      if (!value) throw new Error('Empty key: nothing stored.');
      const key = await requireKey();
      const v = await readVault();
      v.keys[provider] = await encrypt(key, value);
      await writeVault(v);
    },

    /** @param {string} provider @returns {Promise<string | null>} */
    async getKey(provider) {
      const key = await requireKey();
      const box = (await readVault())?.keys?.[provider];
      return box ? decrypt(key, box) : null;
    },

    /** @param {string} provider */
    async removeKey(provider) {
      const v = await readVault();
      if (v?.keys?.[provider]) {
        delete v.keys[provider];
        await writeVault(v);
      }
    },

    /**
     * Re-encrypt every key under a new passphrase (must be unlocked).
     * @param {string} newPassphrase
     */
    async changePassphrase(newPassphrase) {
      if (String(newPassphrase).length < 8) throw new Error('Use a passphrase of at least 8 characters.');
      const oldKey = await requireKey();
      const v = await readVault();
      const salt = crypto.getRandomValues(new Uint8Array(16));
      const key = await deriveKey(newPassphrase, salt, iterations);
      const keys = {};
      for (const [p, box] of Object.entries(v.keys)) keys[p] = await encrypt(key, await decrypt(oldKey, box));
      await writeVault({ ...v, iterations, salt: toB64(salt), check: await encrypt(key, CHECK_TEXT), keys });
      await session.set({ [SESSION_KEY]: toB64(await crypto.subtle.exportKey('raw', key)) });
    },

    /** Forget everything (for a forgotten passphrase). */
    async reset() {
      await local.remove(VAULT_KEY);
      await session.remove(SESSION_KEY);
    },
  };
}
