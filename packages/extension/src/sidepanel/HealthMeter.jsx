import { useEffect, useMemo, useState } from 'react';
import { HEALTH_TOOLTIP, createSnoozes } from '../lib/chatHealth.js';
import { createHandoffs, runHandoff } from '../lib/handoff.js';
import { createArtifacts } from '../lib/artifacts.js';
import { createLedger } from '../lib/ledger.js';
import { setPendingInsert } from '../content/conversation.js';
import { toPage, activeClaudeTab } from './bridge.js';
import { authorName, confirmSameFn, runPassport } from './ledgerBridge.js';

const LABEL = { green: 'Fine', amber: 'Getting long', red: 'Long' };
const STEP = { passport: 'Writing the passport...', saving: 'Saving...', opening: 'Opening a fresh chat...' };
const fmt = (n) => (n >= 1000 ? `${Math.round(n / 100) / 10}k` : String(n));

/**
 * Chat Health Meter for the current claude.ai chat, with "Hand off to a fresh chat" (always available; suggested in
 * the red state unless snoozed for this chat).
 * @param {{ settings: import('../lib/settings.js').Settings, update: (fn: (s: any) => void) => Promise<void> }} props
 */
export default function HealthMeter({ settings, update }) {
  const [state, setState] = useState(/** @type {any} */ (null));
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');
  const snoozes = useMemo(() => createSnoozes(), []);

  const refresh = async () => {
    const r = await toPage({ type: 'resync:chatHealth' });
    setState(r?.ok ? r : null);
  };
  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 4000);
    return () => clearInterval(t);
  }, []);

  const handoff = async () => {
    setMsg('');
    const tab = await activeClaudeTab();
    if (!tab?.id) return setMsg('Open the claude.ai chat first.');
    try {
      const author = await authorName(settings);
      const ledger = createLedger();
      const r = await runHandoff({
        runPassport: () => runPassport(settings, update),
        artifacts: createArtifacts(),
        ledger: { addFromPassport: (text, meta) => ledger.addFromPassport(text, meta, { confirmSame: confirmSameFn(settings) }) },
        handoffs: createHandoffs(),
        setPendingInsert: (text, extra) => setPendingInsert(text, chrome.storage.local, extra),
        navigate: async (url) => void (await chrome.tabs.update(tab.id, { url })),
        autoSend: settings.handoff.autoSend,
        author,
        title: tab.title?.replace(/ - Claude$/, ''),
        onStep: setBusy,
      });
      const d = r.decisions;
      setMsg(`Handed off. Passport saved; ${d.added.length} decision(s) added to the Ledger${d.pending ? ` (${d.pending} pending)` : ''}${d.merged.length ? `, ${d.merged.length} merged` : ''}. ${settings.handoff.autoSend ? 'The brief was sent in the new chat.' : 'Check the brief in the new chat, then press Send.'}`);
    } catch (e) {
      setMsg(`Handoff stopped: ${e.message}`);
    } finally {
      setBusy('');
    }
  };

  const toggleSnooze = async () => {
    const h = state.health;
    if (h.snoozed) await snoozes.unsnooze(h.chat);
    else await snoozes.snooze(h.chat);
    await toPage({ type: 'resync:repaintBadge' });
    refresh();
  };

  // No meter outside a chat (e.g. the project home page a handoff lands on), but its message stays.
  if (!state?.health) return msg ? <p className="small" style={{ margin: '0 12px 8px' }} data-testid="handoff-msg">{msg}</p> : null;
  const { level, reasons, stats, snoozed, nudge } = state.health;
  return (
    <>
      <div className="meter" data-level={level} data-testid="chat-health" title={`${HEALTH_TOOLTIP}${reasons.length ? `\n${reasons.join('\n')}` : ''}`}>
        <span className="dot" aria-hidden="true" />
        <div className="grow">
          <div><strong>Chat health: {LABEL[level]}</strong> <span className="estimate">estimate</span></div>
          <div className="small muted">~{fmt(stats.tokens)} tokens re-read · {stats.turns} turns · {stats.attachments} attachments</div>
          {nudge && <div className="small">Long chats get slower and lose earlier details. Hand off to a fresh chat?</div>}
          <div className="row" style={{ marginTop: 6 }}>
            <button className={nudge ? 'primary' : 'secondary'} disabled={Boolean(busy)} onClick={handoff}>{busy ? STEP[busy] : 'Hand off to a fresh chat'}</button>
            {level === 'red' && <button className="secondary" onClick={toggleSnooze}>{snoozed ? 'Remind me again' : "Don't remind me in this chat"}</button>}
          </div>
        </div>
      </div>
      {msg && <p className="small" style={{ margin: '0 12px 8px' }} data-testid="handoff-msg">{msg}</p>}
    </>
  );
}
