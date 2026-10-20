import { useEffect, useMemo, useState } from 'react';
import { supersedeHistory } from '@resync/shared/ledger';
import { createLedger, LEDGER_KEY, FEEDBACK_KEY } from '../lib/ledger.js';
import { createHandoffs } from '../lib/handoff.js';
import { authorName } from './ledgerBridge.js';
import { Icon } from './Icon.jsx';

const STATUS_FILTERS = [
  ['open', 'Active and pending'],
  ['active', 'Active'],
  ['pending', 'Pending'],
  ['superseded', 'Superseded'],
  ['all', 'All'],
];
const day = (iso) => (iso ?? '').slice(0, 10);

/**
 * Team Decision Ledger: "Your team's AI remembers what you decided, and why."
 * @param {{ settings: import('../lib/settings.js').Settings }} props
 */
export default function LedgerTab({ settings }) {
  const ledger = useMemo(() => createLedger(), []);
  const [list, setList] = useState(/** @type {import('@resync/shared/ledger').Decision[]} */ ([]));
  const [muted, setMuted] = useState(/** @type {string[]} */ ([]));
  const [q, setQ] = useState('');
  const [project, setProject] = useState('');
  const [person, setPerson] = useState('');
  const [status, setStatus] = useState('open');
  const [view, setView] = useState('list');
  const [draft, setDraft] = useState({ text: '', reason: '', project: '', pending: false });
  const [msg, setMsg] = useState('');

  const load = async () => {
    setList(await ledger.list());
    setMuted(await ledger.muted());
  };
  useEffect(() => {
    load();
    const onChange = (c, area) => area === 'local' && (c[LEDGER_KEY] || c[FEEDBACK_KEY]) && load();
    chrome.storage.onChanged.addListener(onChange);
    return () => chrome.storage.onChanged.removeListener(onChange);
  }, []);

  const projects = [...new Set(list.map((d) => d.project).filter(Boolean))].sort();
  const people = [...new Set(list.map((d) => d.author).filter(Boolean))].sort();
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = list.filter((d) => {
    if (status === 'open' ? d.status === 'superseded' : status !== 'all' && d.status !== status) return false;
    if (project && d.project !== project) return false;
    if (person && d.author !== person) return false;
    const hay = `${d.text} ${d.reason} ${d.tags.join(' ')} ${d.author} ${d.project}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });

  const add = async () => {
    await ledger.add({ text: draft.text.trim(), reason: draft.reason.trim(), project: draft.project.trim(), author: await authorName(settings), status: draft.pending ? 'pending' : 'active' });
    setDraft({ text: '', reason: '', project: '', pending: false });
    setMsg('Added.');
  };

  const sync = !settings.serverUrl ? 'Local only: decisions stay in this browser.' : settings.privacy.syncLedger ? 'Synced with your team (when your team owner allows it). Secrets, emails and phone numbers are removed before upload.' : 'Kept in this browser. Turn on "Sync decisions" in Settings to share them with your team.';

  return (
    <>
      <p className="small muted">Your team's AI remembers what you decided, and why. Decisions come from Context Passports (pending if marked "assumed") or are added here. {sync}</p>
      <details className="card">
        <summary><strong>Add a decision</strong></summary>
        <label htmlFor="new-decision">Decision</label>
        <input id="new-decision" value={draft.text} onChange={(e) => setDraft({ ...draft, text: e.target.value })} />
        <label htmlFor="new-reason">Why</label>
        <input id="new-reason" value={draft.reason} onChange={(e) => setDraft({ ...draft, reason: e.target.value })} />
        <label htmlFor="new-project">Project (optional)</label>
        <input id="new-project" list="ledger-projects" value={draft.project} onChange={(e) => setDraft({ ...draft, project: e.target.value })} />
        <datalist id="ledger-projects">{projects.map((p) => <option key={p} value={p} />)}</datalist>
        <label className="row"><input type="checkbox" checked={draft.pending} onChange={(e) => setDraft({ ...draft, pending: e.target.checked })} /> Not confirmed yet (pending)</label>
        <div className="actions"><button className="primary" disabled={!draft.text.trim()} onClick={add}>Add</button></div>
      </details>

      <div className="search" style={{ marginTop: 10 }}>
        <Icon name="search" size={16} />
        <input aria-label="Search decisions" placeholder="Search decisions" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <div className="filters">
        <select aria-label="Filter by project" value={project} onChange={(e) => setProject(e.target.value)}>
          <option value="">All projects</option>
          {projects.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
        <select aria-label="Filter by person" value={person} onChange={(e) => setPerson(e.target.value)}>
          <option value="">Everyone</option>
          {people.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
        <select aria-label="Filter by status" value={status} onChange={(e) => setStatus(e.target.value)}>
          {STATUS_FILTERS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
      </div>
      <div className="row" style={{ marginTop: 8 }}>
        <button className={view === 'list' ? 'primary' : 'secondary'} onClick={() => setView('list')}>List</button>
        <button className={view === 'timeline' ? 'primary' : 'secondary'} onClick={() => setView('timeline')}>Timeline</button>
      </div>
      {msg && <p className="small">{msg}</p>}

      {!shown.length && <div className="empty" style={{ marginTop: 10 }}><Icon name="ledger" size={22} /><div>{list.length ? 'No decisions match.' : 'No decisions yet. Run a Context Passport or add one above.'}</div></div>}
      {view === 'list'
        ? shown.map((d) => <DecisionCard key={d.id} d={d} list={list} ledger={ledger} settings={settings} onMsg={setMsg} />)
        : timeline(shown).map(([date, items]) => (
          <div key={date}>
            <div className="timeline-day">{date}</div>
            {items.map((d) => <DecisionCard key={d.id} d={d} list={list} ledger={ledger} settings={settings} onMsg={setMsg} />)}
          </div>
        ))}

      {muted.length > 0 && (
        <details style={{ marginTop: 12 }}>
          <summary className="small">Muted in banners ({muted.length})</summary>
          {muted.map((id) => {
            const d = list.find((x) => x.id === id);
            return (
              <div key={id} className="row small">
                <span>{d?.text ?? id}</span>
                <button className="secondary" onClick={() => ledger.unmute(id)}>Unmute</button>
              </div>
            );
          })}
        </details>
      )}
    </>
  );
}

/** Decisions grouped by the day they were made, newest first. @param {import('@resync/shared/ledger').Decision[]} list */
function timeline(list) {
  const by = new Map();
  for (const d of [...list].sort((a, b) => b.createdAt.localeCompare(a.createdAt))) {
    if (!by.has(day(d.createdAt))) by.set(day(d.createdAt), []);
    by.get(day(d.createdAt)).push(d);
  }
  return [...by.entries()];
}

/** @param {{ d: import('@resync/shared/ledger').Decision, list: import('@resync/shared/ledger').Decision[], ledger: ReturnType<typeof createLedger>, settings: any, onMsg: (m: string) => void }} props */
function DecisionCard({ d, list, ledger, settings, onMsg }) {
  const [mode, setMode] = useState(/** @type {'' | 'correct' | 'edit' | 'supersede'} */ (''));
  const [form, setForm] = useState({ text: d.text, reason: d.reason });
  const [chain, setChain] = useState(/** @type {string[] | null} */ (null));
  const history = d.supersedes || d.supersededBy ? supersedeHistory(list, d.id) : [];

  const act = async (fn, done) => {
    try {
      await fn();
      setMode('');
      onMsg(done);
    } catch (e) {
      onMsg(e.message);
    }
  };
  const save = () => {
    if (mode === 'correct') return act(() => ledger.confirm(d.id, form), 'Corrected and confirmed.');
    if (mode === 'edit') return act(() => ledger.update(d.id, form), 'Saved.');
    return act(async () => ledger.supersede(d.id, { ...form, author: await authorName(settings) }), 'Superseded. Both decisions are linked.');
  };
  const showChain = async () => setChain(await createHandoffs().chainFor(d.sourceChat));

  return (
    <div className="card decision" data-testid="decision" data-status={d.status}>
      <div><strong>{d.text}</strong><span className="status-pill" data-status={d.status}>{d.status}</span></div>
      {d.reason && <div className="small">Why: {d.reason}</div>}
      <div className="meta">
        {[d.author || 'unknown', day(d.createdAt), d.project].filter(Boolean).join(' · ')}
        {d.sourceChat && <> · <a href={d.sourceChat} target="_blank" rel="noreferrer">source chat</a></>}
      </div>
      {d.tags.length > 0 && <div className="tags">{d.tags.map((t) => <span key={t} className="tag">{t}</span>)}</div>}

      {mode ? (
        <div>
          <label htmlFor={`t-${d.id}`}>{mode === 'supersede' ? 'New decision' : 'Decision'}</label>
          <input id={`t-${d.id}`} value={form.text} onChange={(e) => setForm({ ...form, text: e.target.value })} />
          <label htmlFor={`r-${d.id}`}>Why</label>
          <input id={`r-${d.id}`} value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} />
          <div className="actions">
            <button className="primary" disabled={!form.text.trim()} onClick={save}>{mode === 'correct' ? 'Confirm' : mode === 'supersede' ? 'Save new decision' : 'Save'}</button>
            <button className="secondary" onClick={() => setMode('')}>Cancel</button>
          </div>
        </div>
      ) : (
        <div className="actions">
          {d.status === 'pending' && <button className="primary" onClick={() => act(() => ledger.confirm(d.id), 'Confirmed.')}>Confirm</button>}
          {d.status === 'pending' && <button className="secondary" onClick={() => { setForm({ text: d.text, reason: d.reason }); setMode('correct'); }}>Correct</button>}
          {d.status !== 'superseded' && <button className="secondary" onClick={() => { setForm({ text: '', reason: '' }); setMode('supersede'); }}>Supersede</button>}
          {d.status !== 'superseded' && <button className="secondary" onClick={() => { setForm({ text: d.text, reason: d.reason }); setMode('edit'); }}>Edit</button>}
          <button className="secondary" onClick={() => confirm('Delete this decision from the ledger?') && act(() => ledger.remove(d.id), 'Deleted.')}>Delete</button>
          {d.sourceChat && <button className="secondary" onClick={showChain}>Chat chain</button>}
        </div>
      )}

      {history.length > 1 && (
        <details>
          <summary className="small">Supersede history ({history.length})</summary>
          <ol className="history" data-testid="supersede-history">
            {history.map((h) => <li key={h.id}><span style={{ textDecoration: h.status === 'superseded' ? 'line-through' : 'none' }}>{h.text}</span> <span className="muted">({h.status}, {day(h.createdAt)}{h.author ? `, ${h.author}` : ''})</span>{h.reason && <div className="muted">Why: {h.reason}</div>}</li>)}
          </ol>
        </details>
      )}
      {chain && (
        <div className="small history">
          {chain.length > 1 ? chain.map((c, i) => <div key={c}>{i + 1}. <a href={c} target="_blank" rel="noreferrer">{c.replace('https://claude.ai', '')}</a></div>) : 'This chat has no handoffs.'}
        </div>
      )}
    </div>
  );
}
