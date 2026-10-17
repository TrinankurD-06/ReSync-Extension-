import { useEffect, useMemo, useState } from 'react';
import { renderVariables, promptText, extractVariables, slugify } from '@resync/shared/prompts';
import { createLibrary, searchPrompts, facets, promptId, LIBRARY_KEY } from '../lib/library.js';
import { toPage } from './bridge.js';

/** Live library list for the side panel. */
function useLibrary() {
  const lib = useMemo(() => createLibrary(), []);
  const [prompts, setPrompts] = useState([]);
  useEffect(() => {
    let alive = true;
    const load = () => lib.list().then((p) => alive && setPrompts(p));
    load();
    const onChange = (changes, area) => area === 'local' && changes[LIBRARY_KEY] && load();
    chrome.storage.onChanged.addListener(onChange);
    return () => {
      alive = false;
      chrome.storage.onChanged.removeListener(onChange);
    };
  }, [lib]);
  return { lib, prompts };
}

/** @param {{ onRunChain: (p: import('@resync/shared/prompts').Prompt) => void }} props */
export default function PromptsTab({ onRunChain }) {
  const { lib, prompts } = useLibrary();
  const [q, setQ] = useState({ text: '', scope: 'all', category: '', tag: '' });
  const [active, setActive] = useState(/** @type {any} */ (null)); // prompt being inserted
  const [editing, setEditing] = useState(/** @type {any} */ (null)); // prompt being edited (or a new draft)
  const [msg, setMsg] = useState('');
  const f = facets(prompts);
  const results = searchPrompts(prompts, q);

  const insert = async (p, values = {}) => {
    const text = renderVariables(promptText(p), values, { defaults: p.variables });
    const r = await toPage({ type: 'resync:insert', text });
    setMsg(r?.ok ? 'Inserted. Review it and press send.' : r?.error ?? 'Could not insert.');
    if (r?.ok) setActive(null);
  };

  if (editing) return <PromptEditor draft={editing} onCancel={() => setEditing(null)} onSave={async (p, prevId) => { await lib.upsert(p, prevId); setEditing(null); setMsg(`Saved "${p.title}".`); }} />;

  return (
    <>
      <div className="row">
        <input aria-label="Search prompts" placeholder="Search prompts" value={q.text} onChange={(e) => setQ({ ...q, text: e.target.value })} />
        <button className="secondary" onClick={() => setEditing(newDraft())}>New</button>
      </div>
      <div className="row" style={{ marginTop: 6 }}>
        <select aria-label="Scope" value={q.scope} onChange={(e) => setQ({ ...q, scope: e.target.value })}>
          <option value="all">All scopes</option><option value="personal">Personal</option><option value="team">Team</option>
        </select>
        <select aria-label="Category" value={q.category} onChange={(e) => setQ({ ...q, category: e.target.value })}>
          <option value="">All categories</option>{f.categories.map((c) => <option key={c}>{c}</option>)}
        </select>
        <select aria-label="Tag" value={q.tag} onChange={(e) => setQ({ ...q, tag: e.target.value })}>
          <option value="">All tags</option>{f.tags.map((t) => <option key={t}>{t}</option>)}
        </select>
      </div>
      <p className="small muted">Tip: type <code>;;</code> in the claude.ai message box to pick a prompt without leaving the chat.</p>
      {msg && <p className="small">{msg}</p>}
      {results.map((p) => (
        <div className="card" key={promptId(p)}>
          <div className="row">
            <strong>{p.title}</strong>
            <span className="muted small" style={{ flex: '0 0 auto' }}>{p.scope}</span>
          </div>
          {p.description && <div className="small muted">{p.description}</div>}
          <div>{[p.category, ...p.tags].map((t) => <span className="tag" key={t}>{t}</span>)}</div>
          {active && promptId(active) === promptId(p) ? (
            <VariablesForm prompt={p} onSubmit={(v) => insert(p, v)} onCancel={() => setActive(null)} />
          ) : (
            <div className="row" style={{ marginTop: 6 }}>
              <button className="primary" onClick={() => (p.variables.length ? setActive(p) : insert(p))}>{p.steps.length > 1 ? 'Insert step 1' : 'Insert'}</button>
              {p.steps.length > 1 && <button className="secondary" onClick={() => onRunChain(p)}>Run chain ({p.steps.length} steps)</button>}
              <button className="secondary" onClick={() => setEditing({ ...p, _prevId: promptId(p) })}>Edit</button>
            </div>
          )}
        </div>
      ))}
      {results.length === 0 && <p className="muted">No prompts match.</p>}
    </>
  );
}

/** @param {{ prompt: import('@resync/shared/prompts').Prompt, onSubmit: (v: Record<string, string>) => void, onCancel: () => void, submitLabel?: string }} props */
export function VariablesForm({ prompt, onSubmit, onCancel, submitLabel = 'Insert' }) {
  const [values, setValues] = useState(() => Object.fromEntries(prompt.variables.map((v) => [v.name, v.default ?? ''])));
  return (
    <form onSubmit={(e) => { e.preventDefault(); onSubmit(values); }}>
      {prompt.variables.map((v, i) => (
        <div key={v.name}>
          <label htmlFor={`var-${v.name}`}>{v.name}{v.description ? `: ${v.description}` : ''}</label>
          {v.name === 'notes' || v.name === 'material' || v.name === 'error'
            ? <textarea id={`var-${v.name}`} autoFocus={i === 0} value={values[v.name]} onChange={(e) => setValues({ ...values, [v.name]: e.target.value })} />
            : <input id={`var-${v.name}`} autoFocus={i === 0} value={values[v.name]} onChange={(e) => setValues({ ...values, [v.name]: e.target.value })} />}
        </div>
      ))}
      <div className="row" style={{ marginTop: 6 }}>
        <button type="submit" className="primary">{submitLabel}</button>
        <button type="button" className="secondary" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

function newDraft() {
  return { title: '', category: 'dev', tags: [], description: '', scope: 'personal', variables: [], steps: [], body: '', slug: '' };
}

/** @param {{ draft: any, onSave: (p: any, prevId?: string) => Promise<void>, onCancel: () => void }} props */
function PromptEditor({ draft, onSave, onCancel }) {
  const [p, setP] = useState({ ...draft, tagsText: draft.tags.join(', '), stepsText: draft.steps.map((s) => s.text).join('\n---\n'), delay: draft.steps[1]?.delaySeconds ?? 0 });
  const [err, setErr] = useState('');
  const save = async () => {
    setErr('');
    const steps = p.stepsText.trim()
      ? p.stepsText.split(/\n-{3,}\n/).map((t, i) => ({ text: t.trim(), waitFor: i > 0 && Number(p.delay) > 0 ? 'timer' : 'response', delaySeconds: i > 0 ? Number(p.delay) || 0 : 0 })).filter((s) => s.text)
      : [];
    const used = extractVariables([p.body, ...steps.map((s) => s.text)].join('\n'));
    const keep = draft.variables.filter((v) => used.includes(v.name));
    const variables = [...keep, ...used.filter((n) => !keep.some((v) => v.name === n)).map((name) => ({ name }))];
    const prompt = {
      slug: draft.slug || slugify(p.title), title: p.title.trim(), category: slugify(p.category) || 'general',
      tags: p.tagsText.split(',').map((t) => t.trim()).filter(Boolean), description: p.description.trim(),
      scope: p.scope, variables, steps, body: p.body,
    };
    try {
      await onSave(prompt, draft._prevId);
    } catch (e) {
      setErr(e.message);
    }
  };
  const field = (k, label, props = {}) => (
    <>
      <label htmlFor={`ed-${k}`}>{label}</label>
      <input id={`ed-${k}`} value={p[k]} onChange={(e) => setP({ ...p, [k]: e.target.value })} {...props} />
    </>
  );
  return (
    <>
      <h2>{draft._prevId ? 'Edit prompt' : 'New prompt'}</h2>
      {field('title', 'Title')}
      {field('category', 'Category')}
      {field('tagsText', 'Tags (comma separated)')}
      {field('description', 'Description')}
      <label htmlFor="ed-scope">Scope</label>
      <select id="ed-scope" value={p.scope} onChange={(e) => setP({ ...p, scope: e.target.value })}>
        <option value="personal">Personal</option><option value="team">Team (shared with your team when signed in)</option>
      </select>
      <label htmlFor="ed-body">Prompt text (use {'{{name}}'} for variables)</label>
      <textarea id="ed-body" rows={6} value={p.body} onChange={(e) => setP({ ...p, body: e.target.value })} />
      <details open={Boolean(p.stepsText)}>
        <summary>Multi-step chain (optional)</summary>
        <label htmlFor="ed-steps">Steps, separated by a line with ---</label>
        <textarea id="ed-steps" rows={6} value={p.stepsText} onChange={(e) => setP({ ...p, stepsText: e.target.value })} />
        <label htmlFor="ed-delay">Extra wait after each reply before the next step (seconds)</label>
        <input id="ed-delay" type="number" min="0" value={p.delay} onChange={(e) => setP({ ...p, delay: e.target.value })} />
      </details>
      {err && <p className="error small">{err}</p>}
      <div className="row" style={{ marginTop: 8 }}>
        <button className="primary" onClick={save}>Save</button>
        <button className="secondary" onClick={onCancel}>Cancel</button>
      </div>
    </>
  );
}
