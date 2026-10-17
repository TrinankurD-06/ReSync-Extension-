import { useState } from 'react';
import { useApi } from '../useApi.js';
import { post, put, del, get } from '../api.js';

const EMPTY = { slug: '', title: '', category: 'general', tags: [], description: '', scope: 'personal', variables: [], steps: [], body: '' };
const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const varsIn = (text) => [...new Set([...text.matchAll(/\{\{\s*([A-Za-z_][A-Za-z0-9_-]*)\s*\}\}/g)].map((m) => m[1]))];

/** @param {{ me: any }} props */
export default function Prompts({ me }) {
  const [scope, setScope] = useState('all');
  const [q, setQ] = useState('');
  const list = useApi(`/prompts?scope=${scope}`);
  const [editing, setEditing] = useState(/** @type {any} */ (null));
  const [history, setHistory] = useState(/** @type {any} */ (null));
  const [msg, setMsg] = useState('');
  const prompts = (list.data?.prompts ?? []).filter((p) => !q || `${p.title} ${p.description} ${p.tags.join(' ')} ${p.category}`.toLowerCase().includes(q.toLowerCase()));

  const act = async (fn, okMsg) => {
    setMsg('');
    try {
      await fn();
      setMsg(okMsg);
      list.reload();
    } catch (e) {
      setMsg(e.message);
    }
  };

  if (editing) return <Editor prompt={editing} me={me} onCancel={() => setEditing(null)} onSaved={() => { setEditing(null); list.reload(); setMsg('Saved.'); }} />;

  return (
    <>
      <h1>Prompts</h1>
      <p className="muted">Team prompts are shared with everyone in {me.team?.name ?? 'your team'}; personal prompts are yours. Teammates get team prompts with <code>resync sync</code> (Claude Code) or automatically in the extension.</p>
      <div className="row">
        <input aria-label="Search prompts" placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} className="grow" />
        <select aria-label="Scope" value={scope} onChange={(e) => setScope(e.target.value)}>
          <option value="all">All</option><option value="personal">Personal</option><option value="team">Team</option>
        </select>
        <button className="primary" onClick={() => setEditing({ ...EMPTY, scope: me.team ? 'team' : 'personal' })}>New prompt</button>
      </div>
      {msg && <p className="small">{msg}</p>}
      {list.error && <p className="banner">{list.error.message}</p>}
      <table aria-label="Prompts">
        <thead><tr><th>Title</th><th>Category</th><th>Scope</th><th className="num">Version</th><th></th></tr></thead>
        <tbody>
          {prompts.map((p) => (
            <tr key={p.id}>
              <td><strong>{p.title}</strong><div className="small muted">{p.description}</div>{p.steps.length > 1 && <span className="tag">chain · {p.steps.length} steps</span>}</td>
              <td>{p.category}</td>
              <td>{p.scope}</td>
              <td className="num">v{p.version}</td>
              <td>
                <div className="row">
                  <button onClick={() => setEditing(p)}>Edit</button>
                  <button onClick={async () => setHistory({ prompt: p, ...(await get(`/prompts/${p.id}/versions`)) })}>History</button>
                  {me.team && <button onClick={() => act(() => post(`/prompts/${p.id}/move`, { scope: p.scope === 'team' ? 'personal' : 'team' }), `Moved to ${p.scope === 'team' ? 'personal' : 'team'}.`)}>Move to {p.scope === 'team' ? 'personal' : 'team'}</button>}
                  <button className="danger" onClick={() => confirm(`Delete "${p.title}"?`) && act(() => del(`/prompts/${p.id}`), 'Deleted.')}>Delete</button>
                </div>
              </td>
            </tr>
          ))}
          {list.data && prompts.length === 0 && <tr><td colSpan={5} className="muted">No prompts yet.</td></tr>}
        </tbody>
      </table>
      {history && (
        <section className="card" aria-label="Version history">
          <div className="row"><h2 className="grow" style={{ margin: 0 }}>History: {history.prompt.title}</h2><button onClick={() => setHistory(null)}>Close</button></div>
          <p className="small">Current: v{history.current.version} by {history.current.editedBy ?? 'unknown'}</p>
          {history.versions.length === 0 && <p className="muted small">No earlier versions.</p>}
          {history.versions.map((v) => (
            <div key={v.version} className="card">
              <div className="row"><strong className="grow">v{v.version}</strong><span className="small muted">{v.editedBy ?? 'unknown'} · {new Date(v.createdAt).toLocaleString()}</span>
                <button onClick={() => act(async () => { await post(`/prompts/${history.prompt.id}/restore`, { version: v.version }); setHistory(null); }, `Restored v${v.version}.`)}>Restore</button></div>
              <pre className="small">{v.prompt.body || v.prompt.steps.map((s, i) => `Step ${i + 1}: ${s.text}`).join('\n')}</pre>
            </div>
          ))}
        </section>
      )}
    </>
  );
}

/** @param {{ prompt: any, me: any, onCancel: () => void, onSaved: () => void }} props */
function Editor({ prompt, me, onCancel, onSaved }) {
  const [p, setP] = useState({ ...prompt, tagsText: prompt.tags.join(', '), stepsText: prompt.steps.map((s) => s.text).join('\n---\n') });
  const [error, setError] = useState('');
  const save = async () => {
    setError('');
    const steps = p.stepsText.trim() ? p.stepsText.split(/\n-{3,}\n/).map((t, i) => ({ text: t.trim(), waitFor: prompt.steps[i]?.waitFor ?? 'response', delaySeconds: prompt.steps[i]?.delaySeconds ?? 0 })).filter((s) => s.text) : [];
    const used = varsIn([p.body, ...steps.map((s) => s.text)].join('\n'));
    const variables = [...prompt.variables.filter((v) => used.includes(v.name)), ...used.filter((n) => !prompt.variables.some((v) => v.name === n)).map((name) => ({ name }))];
    const body = {
      prompt: {
        slug: prompt.slug || slugify(p.title), title: p.title.trim(), category: slugify(p.category) || 'general',
        tags: p.tagsText.split(',').map((t) => t.trim()).filter(Boolean), description: p.description.trim(), scope: p.scope, variables, steps, body: p.body,
      },
    };
    try {
      if (prompt.id) await put(`/prompts/${prompt.id}`, body);
      else await post('/prompts', body);
      onSaved();
    } catch (e) {
      setError(e.message);
    }
  };
  const field = (k, label) => (<><label htmlFor={`f-${k}`}>{label}</label><input id={`f-${k}`} style={{ width: '100%' }} value={p[k]} onChange={(e) => setP({ ...p, [k]: e.target.value })} /></>);
  return (
    <>
      <h1>{prompt.id ? `Edit: ${prompt.title}` : 'New prompt'}</h1>
      {field('title', 'Title')}
      {field('category', 'Category')}
      {field('tagsText', 'Tags (comma separated)')}
      {field('description', 'Description')}
      {!prompt.id && (
        <>
          <label htmlFor="f-scope">Scope</label>
          <select id="f-scope" value={p.scope} onChange={(e) => setP({ ...p, scope: e.target.value })}>
            <option value="personal">Personal</option>
            <option value="team" disabled={!me.team}>Team{me.team ? ` (${me.team.name})` : ' (join a team first)'}</option>
          </select>
        </>
      )}
      <label htmlFor="f-body">Prompt text (use {'{{name}}'} for variables)</label>
      <textarea id="f-body" value={p.body} onChange={(e) => setP({ ...p, body: e.target.value })} />
      <label htmlFor="f-steps">Chain steps (optional), separated by a line with ---</label>
      <textarea id="f-steps" value={p.stepsText} onChange={(e) => setP({ ...p, stepsText: e.target.value })} />
      {error && <p className="banner">{error}</p>}
      <div className="row" style={{ marginTop: 12 }}>
        <button className="primary" onClick={save}>Save</button>
        <button onClick={onCancel}>Cancel</button>
      </div>
    </>
  );
}
