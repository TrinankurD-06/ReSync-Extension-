import { useEffect, useMemo, useState } from 'react';
import { createLedger } from '../lib/ledger.js';
import { ledgerAlertKey, decisionInsertText } from '../lib/ledgerAlerts.js';
import { toPage, activeClaudeTab } from './bridge.js';
import { authorName } from './ledgerBridge.js';

/**
 * Non-blocking Decision Ledger banner in the ReSync panel (never in the chat input, never auto-inserted).
 * Shows the decision, its reason, who made it and when. Actions: Dismiss | Insert into chat | Supersede.
 * @param {{ settings: import('../lib/settings.js').Settings }} props
 */
export default function LedgerBanner({ settings }) {
  const ledger = useMemo(() => createLedger(), []);
  const [tabId, setTabId] = useState(/** @type {number | null} */ (null));
  const [alert, setAlert] = useState(/** @type {any} */ (null));
  const [form, setForm] = useState(/** @type {{ text: string, reason: string } | null} */ (null));
  const [msg, setMsg] = useState('');

  useEffect(() => {
    let id = null;
    const load = async () => {
      id = (await activeClaudeTab())?.id ?? null;
      setTabId(id);
      setAlert(id == null ? null : (await chrome.storage.session.get(ledgerAlertKey(id)))[ledgerAlertKey(id)] ?? null);
    };
    load();
    const onChange = (c, area) => area === 'session' && id != null && c[ledgerAlertKey(id)] && setAlert(c[ledgerAlertKey(id)].newValue ?? null);
    chrome.storage.onChanged.addListener(onChange);
    chrome.tabs.onActivated?.addListener(load);
    return () => {
      chrome.storage.onChanged.removeListener(onChange);
      chrome.tabs.onActivated?.removeListener(load);
    };
  }, []);

  if (!alert?.alerts?.length) return msg ? <p className="small" style={{ margin: '0 12px 8px' }}>{msg}</p> : null;
  const { decision: d, relation, why } = alert.alerts[0];

  /** Drop the shown decision from the alert (the next one, if any, shows). */
  const next = async () => {
    setForm(null);
    const rest = { ...alert, alerts: alert.alerts.slice(1) };
    if (tabId != null) await chrome.storage.session.set({ [ledgerAlertKey(tabId)]: rest });
    setAlert(rest);
  };
  const dismiss = async () => {
    const r = await ledger.dismiss(d.id, alert.chat);
    setMsg(r.muted ? 'Dismissed. This decision kept coming up, so it is muted in banners (unmute it in the Ledger tab).' : 'Dismissed for this chat.');
    next();
  };
  const insert = async () => {
    const text = decisionInsertText(d);
    const r = await toPage({ type: 'resync:insert', text });
    if (r?.ok) return setMsg('Inserted into the message box. Send it if you want Claude to take it into account.');
    const copied = await navigator.clipboard.writeText(text).then(() => true, () => false);
    setMsg(`${r?.error ?? "Couldn't find the message box. Click into it and press Retry"}${copied ? ' The decision is on your clipboard.' : ''}`);
  };
  const supersede = async () => {
    try {
      await ledger.supersede(d.id, { text: form.text, reason: form.reason, author: await authorName(settings), sourceChat: alert.chat });
      setMsg('Superseded. The Ledger tab shows the linked history.');
      next();
    } catch (e) {
      setMsg(e.message);
    }
  };

  return (
    <div className="card ledger-alert" data-relation={relation} data-testid="ledger-banner" role="status" style={{ margin: '0 8px 8px' }}>
      <div className="small"><strong>{relation === 'conflict' ? 'Possible conflict with a team decision' : 'Related team decision'}</strong>{alert.alerts.length > 1 ? ` (1 of ${alert.alerts.length})` : ''}</div>
      <div style={{ marginTop: 4 }}>{d.text}</div>
      {d.reason && <div className="small">Why: {d.reason}</div>}
      <div className="small muted">{[d.author, d.createdAt?.slice(0, 10), d.project].filter(Boolean).join(' · ')}{d.status === 'pending' ? ' · not confirmed yet' : ''}</div>
      {relation === 'conflict' && why && <div className="small" style={{ marginTop: 4 }}>{why}</div>}
      {form ? (
        <div>
          <label htmlFor="sup-text">New decision</label>
          <input id="sup-text" value={form.text} onChange={(e) => setForm({ ...form, text: e.target.value })} />
          <label htmlFor="sup-reason">Reason</label>
          <input id="sup-reason" value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} />
          <div className="actions">
            <button className="primary" disabled={!form.text.trim()} onClick={supersede}>Save new decision</button>
            <button className="secondary" onClick={() => setForm(null)}>Cancel</button>
          </div>
        </div>
      ) : (
        <div className="actions">
          <button className="secondary" onClick={dismiss}>Dismiss</button>
          <button className="secondary" onClick={insert}>Insert into chat</button>
          <button className="secondary" onClick={() => setForm({ text: '', reason: '' })}>Supersede</button>
        </div>
      )}
      {alert.note && <div className="small muted" style={{ marginTop: 4 }}>{alert.note}</div>}
    </div>
  );
}
