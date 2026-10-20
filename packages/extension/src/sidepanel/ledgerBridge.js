// Side panel glue for the Decision Ledger and the handoff: run a passport (in-chat or API, as the user set it up),
// the author name for new decisions, and the optional model dedupe (only when the ledger is routed to a provider).
import { resolveFeature } from '@resync/shared/models';
import { buildApiRequest } from '@resync/shared/templates';
import { samePrompt, parseSameAnswer } from '@resync/shared/ledger';
import { ME_KEY } from '../lib/syncEngine.js';
import { aiRun, toPage } from './bridge.js';

/** Name on decisions you add: Settings > Ledger, else your team-server name, else "You". @param {import('../lib/settings.js').Settings} settings */
export async function authorName(settings) {
  if (settings.ledger.author) return settings.ledger.author;
  const me = (await chrome.storage.local.get(ME_KEY))[ME_KEY];
  return me?.name || 'You';
}

/** Is the ledger routed to a provider (BYOK)? @param {import('../lib/settings.js').Settings} settings */
export function ledgerUsesModel(settings) {
  try {
    return resolveFeature(settings.ai, 'ledger').mode === 'api' && Boolean(settings.privacy.apiModeAcknowledged.ledger);
  } catch {
    return false;
  }
}

/**
 * Dedupe confirmation for borderline matches, or undefined when no provider is set (then only close matches merge).
 * @param {import('../lib/settings.js').Settings} settings
 */
export function confirmSameFn(settings) {
  if (!ledgerUsesModel(settings)) return undefined;
  return async (a, b) => {
    const p = samePrompt(a, b);
    const r = await aiRun({ feature: 'ledger', system: p.system, messages: p.messages, maxTokens: 20 });
    return r.ok ? parseSameAnswer(r.text) : null;
  };
}

/**
 * Run a Context Passport the way the user set it up and return its raw text and the page's Meta.
 * @param {import('../lib/settings.js').Settings} settings
 * @param {(fn: (s: any) => void) => Promise<void>} update
 * @returns {Promise<{ ok: true, text: string, mode: string, meta: { date: string, project: string, source: string, projectUrl?: string } } | { ok: false, error: string }>}
 */
export async function runPassport(settings, update) {
  let route;
  try {
    route = resolveFeature(settings.ai, 'passport');
  } catch (e) {
    return { ok: false, error: e.message };
  }
  if (route.mode === 'in-chat') {
    const r = await toPage({ type: 'resync:inChat', feature: 'passport' });
    return r?.ok ? { ok: true, text: r.text, mode: 'in-chat', meta: r.meta } : { ok: false, error: r?.error ?? 'In-chat run failed.' };
  }
  const conv = await toPage({ type: 'resync:readConversation' });
  if (!conv?.ok) return { ok: false, error: conv?.error ?? 'Could not read the conversation.' };
  if (!conv.messages.length) return { ok: false, error: 'This chat has no messages yet.' };
  const req = buildApiRequest('passport', conv.messages, { meta: conv.meta });
  let r = await aiRun({ feature: 'passport', system: req.system, messages: req.messages, maxTokens: 4000 });
  if (!r.ok && r.error.kind === 'needs_ack') {
    if (!confirm(r.error.message)) return { ok: false, error: 'Cancelled: nothing was sent.' };
    await update((s) => {
      s.privacy.apiModeAcknowledged.passport = true;
    });
    r = await aiRun({ feature: 'passport', system: req.system, messages: req.messages, maxTokens: 4000 });
  }
  if (!r.ok) return { ok: false, error: r.error.message };
  return { ok: true, text: r.text, mode: `api: ${r.providerId}/${r.model}`, meta: conv.meta };
}
