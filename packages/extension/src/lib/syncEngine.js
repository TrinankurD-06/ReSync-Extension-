// Extension <-> team server sync (optional; nothing happens without a server URL and sign-in).
// Syncs prompts, project colours and usage NUMBERS (per the privacy toggles). Never API keys or conversations.
//
// Prompt merge rules:
//  - prompts that came from the server are tracked in SYNCED_KEY; the server copy wins on pull, and if one
//    disappears on the server it is removed locally;
//  - local-only prompts (e.g. the bundled seeds) stay local until the user edits them; edits and deletes are
//    queued (DIRTY_KEY / DELETED_KEY by library.js) and pushed on the next sync.
import { createSyncClient } from '@resync/shared/sync';
import { jsonToLibrary } from '@resync/shared/prompts';
import { promptId, LIBRARY_KEY, DIRTY_KEY, DELETED_KEY, SYNCED_KEY } from './library.js';
import { toUsageRecords } from './usageEstimates.js';

export const TOKEN_KEY = 'resync.serverToken';
export const STATUS_KEY = 'resync.syncStatus';

/**
 * @param {{
 *   area: { get(k: string | string[]): Promise<Record<string, any>>, set(o: Record<string, any>): Promise<void>, remove(k: string): Promise<void> },
 *   settings: { get(): Promise<import('./settings.js').Settings>, update(fn: (s: any) => void): Promise<any> },
 *   library: ReturnType<typeof import('./library.js').createLibrary>,
 *   usage: ReturnType<typeof import('./usageEstimates.js').createUsageStore>,
 *   fetch?: typeof fetch,
 * }} deps
 */
export function createExtensionSync(deps) {
  const { area } = deps;
  const getToken = async () => (await area.get(TOKEN_KEY))[TOKEN_KEY];

  async function client() {
    const s = await deps.settings.get();
    return createSyncClient({ serverUrl: s.serverUrl, token: await getToken(), fetch: deps.fetch, client: 'extension' });
  }

  return {
    async signedIn() {
      const s = await deps.settings.get();
      return Boolean(s.serverUrl && (await getToken()));
    },

    /** Start the device-code login (the side panel shows the code and polls). */
    async startLogin() {
      return (await client()).startDeviceLogin('ReSync extension');
    },

    /** Poll until approved, then store the token. @param {any} start @param {{ sleep?: (ms: number) => Promise<void>, signal?: AbortSignal }} [o] */
    async finishLogin(start, o = {}) {
      const r = await (await client()).pollDeviceToken(start, o);
      await area.set({ [TOKEN_KEY]: r.token });
      return r.user;
    },

    async me() {
      return (await client()).me();
    },

    async signOut() {
      const c = await client();
      if (c.signedIn) await c.logout().catch(() => {});
      await area.remove(TOKEN_KEY);
    },

    /** One full sync. Returns a summary (also saved for the UI). */
    async syncNow() {
      const s = await deps.settings.get();
      const token = await getToken();
      if (!s.serverUrl || !token) return { skipped: true, reason: s.serverUrl ? 'not signed in' : 'local only' };
      const c = await client();
      const summary = { at: Date.now(), pushed: 0, deleted: 0, pulled: 0, removedLocally: 0, colours: 'skipped', usage: 0 };
      try {
        const me = await c.me();

        if (s.privacy.syncPrompts) {
          // 1) Push local edits.
          const dirty = new Set((await area.get(DIRTY_KEY))[DIRTY_KEY] ?? []);
          const local = await deps.library.list();
          for (const p of local.filter((x) => dirty.has(promptId(x)))) {
            if (p.scope === 'team' && !me.team) continue; // can't push team prompts without a team
            await c.upsertPrompt(p);
            summary.pushed++;
          }
          // 2) Push deletions of prompts that were synced before.
          const deleted = (await area.get(DELETED_KEY))[DELETED_KEY] ?? [];
          if (deleted.length) {
            const remote = (await c.listPrompts('all')).prompts;
            for (const d of deleted) {
              const hit = remote.find((r) => r.scope === d.scope && r.category === d.category && r.slug === d.slug);
              if (hit) {
                await c.deletePrompt(hit.id);
                summary.deleted++;
              }
            }
          }
          await area.set({ [DIRTY_KEY]: [], [DELETED_KEY]: [] });

          // 3) Pull: server prompts + local-only prompts; drop synced prompts that vanished on the server.
          const { prompts: remote } = jsonToLibrary(await c.getLibrary());
          const remoteIds = new Set(remote.map(promptId));
          const previouslySynced = new Set((await area.get(SYNCED_KEY))[SYNCED_KEY] ?? []);
          const current = await deps.library.list();
          const keepLocal = current.filter((p) => !remoteIds.has(promptId(p)) && !previouslySynced.has(promptId(p)));
          summary.removedLocally = current.filter((p) => !remoteIds.has(promptId(p)) && previouslySynced.has(promptId(p))).length;
          await area.set({ [LIBRARY_KEY]: { prompts: [...remote, ...keepLocal], updatedAt: Date.now() }, [SYNCED_KEY]: [...remoteIds] });
          summary.pulled = remote.length;
        }

        // 4) Colours: push ours; on a fresh browser with none, take the server's.
        if (s.privacy.syncColours) {
          const remote = await c.getColours();
          const hasLocal = Object.keys(s.colours.assignments).length > 0 || s.colours.custom.length > 0;
          if (!hasLocal && (Object.keys(remote.assignments ?? {}).length || remote.presets?.length)) {
            await deps.settings.update((x) => {
              x.colours = { preset: remote.preset ?? x.colours.preset, assignments: remote.assignments ?? {}, custom: remote.presets ?? [] };
            });
            summary.colours = 'pulled';
          } else if (hasLocal) {
            await c.putColours({ preset: s.colours.preset, presets: s.colours.custom, assignments: s.colours.assignments });
            summary.colours = 'pushed';
          }
        }

        // 5) Usage numbers (estimates; the server replaces the day's record, so re-sending is safe).
        if (s.privacy.syncUsage) {
          const rows = await deps.usage.all();
          if (rows.length) summary.usage = (await c.uploadUsage(toUsageRecords(rows, me.name))).accepted;
        }
        await area.set({ [STATUS_KEY]: { ok: true, ...summary } });
        return { ok: true, ...summary };
      } catch (e) {
        const status = { ok: false, at: Date.now(), error: String(/** @type {any} */ (e)?.message ?? e), code: /** @type {any} */ (e)?.code };
        if (/** @type {any} */ (e)?.status === 401) await area.remove(TOKEN_KEY); // revoked from the dashboard
        await area.set({ [STATUS_KEY]: status });
        return status;
      }
    },

    /** Share a passport/summary/tree with the team (explicit, per item). */
    async share(item) {
      return (await client()).share(item);
    },
  };
}
