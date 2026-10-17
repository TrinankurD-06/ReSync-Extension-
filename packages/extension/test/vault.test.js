import { describe, it, expect, beforeEach } from 'vitest';
import { createVault, VaultLockedError, DEFAULT_ITERATIONS } from '../src/lib/vault.js';
import { memoryArea } from './fakeChrome.js';

let local;
let session;
let vault;
beforeEach(() => {
  local = memoryArea();
  session = memoryArea();
  // Fewer iterations keep most tests fast; one test below uses the real default.
  vault = createVault({ local, session, iterations: 1000 });
});

describe('key vault', () => {
  it('stores keys encrypted, never in plain text', async () => {
    await vault.create('correct horse battery');
    await vault.setKey('anthropic', 'sk-ant-SECRET-123');
    expect(JSON.stringify(local.dump())).not.toContain('SECRET');
    expect(await vault.getKey('anthropic')).toBe('sk-ant-SECRET-123');
    expect(await vault.providers()).toEqual(['anthropic']);
  });

  it('locks and unlocks; a new browser session starts locked', async () => {
    await vault.create('correct horse battery');
    await vault.setKey('openai', 'sk-1');
    await vault.lock();
    expect(await vault.isUnlocked()).toBe(false);
    await expect(vault.getKey('openai')).rejects.toBeInstanceOf(VaultLockedError);
    expect(await vault.providers()).toEqual(['openai']); // names are visible while locked, values are not
    expect(await vault.unlock('wrong passphrase')).toBe(false);
    expect(await vault.unlock('correct horse battery')).toBe(true);
    expect(await vault.getKey('openai')).toBe('sk-1');

    // Browser restart = storage.session is empty.
    const restarted = createVault({ local, session: memoryArea(), iterations: 1000 });
    expect(await restarted.isUnlocked()).toBe(false);
    expect(await restarted.unlock('correct horse battery')).toBe(true);
    expect(await restarted.getKey('openai')).toBe('sk-1');
  });

  it('uses a fresh IV for every encryption', async () => {
    await vault.create('correct horse battery');
    await vault.setKey('a', 'same');
    await vault.setKey('b', 'same');
    const { keys } = local.dump()['resync.vault'];
    expect(keys.a.iv).not.toBe(keys.b.iv);
    expect(keys.a.ct).not.toBe(keys.b.ct);
  });

  it('changes the passphrase, re-encrypting keys', async () => {
    await vault.create('first passphrase');
    await vault.setKey('gemini', 'AIza-1');
    await vault.changePassphrase('second passphrase');
    await vault.lock();
    expect(await vault.unlock('first passphrase')).toBe(false);
    expect(await vault.unlock('second passphrase')).toBe(true);
    expect(await vault.getKey('gemini')).toBe('AIza-1');
  });

  it('validates input and supports reset and removal', async () => {
    await expect(vault.create('short')).rejects.toThrow(/8 characters/);
    await vault.create('long enough pass');
    await expect(vault.create('long enough pass')).rejects.toThrow(/already exists/);
    await expect(vault.setKey('x', '  ')).rejects.toThrow(/Empty/);
    await vault.setKey('x', 'k');
    await vault.removeKey('x');
    expect(await vault.providers()).toEqual([]);
    await vault.reset();
    expect(await vault.exists()).toBe(false);
    await expect(vault.unlock('long enough pass')).rejects.toThrow(/No vault/);
  });

  it('defaults to 600,000 PBKDF2 iterations (OWASP)', async () => {
    const real = createVault({ local: memoryArea(), session: memoryArea() });
    expect(DEFAULT_ITERATIONS).toBe(600_000);
    await real.create('correct horse battery');
    await real.setKey('p', 'v');
    await real.lock();
    expect(await real.unlock('correct horse battery')).toBe(true);
    expect(await real.getKey('p')).toBe('v');
  }, 30_000);
});
