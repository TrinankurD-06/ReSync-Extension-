// One-click handoff: Context Passport in the current chat -> save it (linked to the source chat) -> its decisions
// into the Decision Ledger -> open a new chat (in the same project when the source chat is in one, which lands on the
// project home page) -> paste "Continue from this handoff brief:" + the passport into the message box. ReSync does
// not press Send unless "auto-send" is on in Settings.
// Handoffs are stored both ways (source chat <-> new chat) so the topic tree and the ledger can trace a chain of chats.
import { parsePassport, renderPassport, passportLengthWarnings } from '@resync/shared/templates';
import { chatKeyOf } from './chatHealth.js';

export const HANDOFFS_KEY = 'resync.handoffs';
export const HANDOFF_PREFIX = 'Continue from this handoff brief:';
const MAX = 200;

/**
 * @typedef {{ id: string, sourceChat: string, project: string, targetUrl: string, newChat: string, passportId: string, createdAt: number, linkedAt?: number }} Handoff
 * @param {{ get(k: string): Promise<Record<string, any>>, set(o: Record<string, any>): Promise<void> }} [area]
 */
export function createHandoffs(area) {
  const store = area ?? chrome.storage.local;
  const read = async () => /** @type {Handoff[]} */ ((await store.get(HANDOFFS_KEY))[HANDOFFS_KEY] ?? []);
  const write = (list) => store.set({ [HANDOFFS_KEY]: list.slice(0, MAX) });
  return {
    list: read,
    /** @param {{ sourceChat: string, project?: string, targetUrl: string, passportId?: string }} h */
    async add(h) {
      const item = { id: `h-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`, sourceChat: chatKeyOf(h.sourceChat), project: h.project ?? '', targetUrl: h.targetUrl, newChat: '', passportId: h.passportId ?? '', createdAt: Date.now() };
      await write([item, ...(await read())]);
      return item;
    },
    /** The new chat got its URL (after its first message was sent). @param {string} id @param {string} url */
    async linkNewChat(id, url) {
      const list = await read();
      const h = list.find((x) => x.id === id);
      if (!h || h.newChat) return h ?? null;
      h.newChat = chatKeyOf(url);
      h.linkedAt = Date.now();
      await write(list);
      return h;
    },
    /** @param {string} id @param {Partial<Handoff>} patch */
    async update(id, patch) {
      await write((await read()).map((x) => (x.id === id ? { ...x, ...patch } : x)));
    },
    /**
     * Links of one chat: the handoff that started it, and the handoffs it started.
     * @param {string} url
     */
    async linksFor(url) {
      const k = chatKeyOf(url);
      const list = await read();
      return { from: list.find((h) => h.newChat === k) ?? null, to: list.filter((h) => h.sourceChat === k) };
    },
    /**
     * The chain of chats this one belongs to, oldest first (following handoffs back, then forward).
     * @param {string} url
     * @returns {Promise<string[]>}
     */
    async chainFor(url) {
      const list = await read();
      let k = chatKeyOf(url);
      const seen = new Set([k]);
      for (let h = list.find((x) => x.newChat === k); h && !seen.has(h.sourceChat); h = list.find((x) => x.newChat === k)) {
        k = h.sourceChat;
        seen.add(k);
      }
      const chain = [k];
      for (let h = list.find((x) => x.sourceChat === k && x.newChat); h && !chain.includes(h.newChat); h = list.find((x) => x.sourceChat === k && x.newChat)) {
        k = h.newChat;
        chain.push(k);
      }
      return chain;
    },
  };
}

/**
 * The new chat's address: the source chat's project home when it has one, else a plain new chat.
 * @param {{ projectUrl?: string }} meta
 */
export const handoffTarget = (meta) => (meta.projectUrl && /^https:\/\/claude\.ai\/project\/[^/]+$/.test(meta.projectUrl) ? meta.projectUrl : 'https://claude.ai/new');

/** The text pasted into the new chat. @param {string} passport */
export const handoffText = (passport) => `${HANDOFF_PREFIX}\n\n${passport}`;

/**
 * Run a handoff. Every side effect is a dependency, so the flow is testable and the side panel wires in the real ones.
 * @param {{
 *   runPassport: () => Promise<{ ok: true, text: string, mode: string, meta: { date?: string, project: string, source: string, projectUrl?: string } } | { ok: false, error: string }>,
 *   artifacts: ReturnType<typeof import('./artifacts.js').createArtifacts>,
 *   ledger: { addFromPassport(text: string, meta: { author?: string, project?: string, sourceChat?: string }): Promise<{ added: any[], merged: any[], pending: number }> },
 *   handoffs: ReturnType<typeof createHandoffs>,
 *   setPendingInsert: (text: string, extra: { autoSend?: boolean, handoffId?: string }) => Promise<void>,
 *   navigate: (url: string) => Promise<void>,
 *   autoSend?: boolean,
 *   author?: string,
 *   title?: string,
 *   onStep?: (step: 'passport' | 'saving' | 'opening') => void,
 * }} deps
 */
export async function runHandoff(deps) {
  deps.onStep?.('passport');
  const r = await deps.runPassport();
  if (!r.ok) throw new Error(r.error);
  deps.onStep?.('saving');
  const p = parsePassport(r.text);
  const content = renderPassport(p.sections, { title: deps.title, project: r.meta.project, source: r.meta.source, mode: r.mode });
  const passport = await deps.artifacts.add({ kind: 'passport', title: 'Context Passport (handoff)', content, mode: /** @type {any} */ (r.mode), data: { missing: p.missing, warnings: passportLengthWarnings(p.sections), sourceChat: chatKeyOf(r.meta.source) } });
  const decisions = await deps.ledger.addFromPassport(content, { author: deps.author, project: r.meta.project, sourceChat: chatKeyOf(r.meta.source) });
  const targetUrl = handoffTarget(r.meta);
  const handoff = await deps.handoffs.add({ sourceChat: r.meta.source, project: r.meta.project, targetUrl, passportId: passport.id });
  await deps.artifacts.update(passport.id, { data: { ...(/** @type {object} */ (passport.data)), handoffId: handoff.id } });
  deps.onStep?.('opening');
  await deps.setPendingInsert(handoffText(content), { autoSend: Boolean(deps.autoSend), handoffId: handoff.id });
  await deps.navigate(targetUrl);
  return { handoff, passport, decisions, targetUrl };
}
