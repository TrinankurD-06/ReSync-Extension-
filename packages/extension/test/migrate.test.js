import { describe, it, expect } from 'vitest';
import { migrateRenamedKeys } from '../src/lib/migrate.js';
import { memoryArea } from './fakeChrome.js';

describe('migration after the rename to ReSync', () => {
  it('moves relay.* keys to resync.* and removes the old ones', async () => {
    const area = memoryArea();
    await area.set({ 'relay.settings': { serverUrl: 'x' }, 'relay.vault': { salt: 's' }, 'other.key': 1 });
    expect(await migrateRenamedKeys(area)).toBe(2);
    expect(area.dump()).toEqual({ 'resync.settings': { serverUrl: 'x' }, 'resync.vault': { salt: 's' }, 'other.key': 1 });
  });

  it('never overwrites data already saved under the new name, and is a no-op when nothing is left', async () => {
    const area = memoryArea();
    await area.set({ 'relay.library': ['old'], 'resync.library': ['new'] });
    expect(await migrateRenamedKeys(area)).toBe(0);
    expect(area.dump()).toEqual({ 'resync.library': ['new'] });
    expect(await migrateRenamedKeys(area)).toBe(0);
  });
});
