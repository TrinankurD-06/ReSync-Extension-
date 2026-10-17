import { useState } from 'react';
import { useApi } from '../useApi.js';
import { get, del } from '../api.js';

/** Passports, summaries and trees that teammates chose to share (per item, opt-in). @param {{ me: any }} props */
export default function Shared({ me }) {
  const list = useApi(me.team ? '/shared' : null);
  const [open, setOpen] = useState(/** @type {any} */ (null));
  if (!me.team) return <><h1>Shared passports</h1><p className="muted">Join or create a team to share handoffs.</p></>;
  return (
    <>
      <h1>Shared passports</h1>
      <p className="muted">Context Passports, summaries and topic trees that teammates explicitly shared for handoffs. Nothing appears here unless someone clicks Share.</p>
      {list.error && <p className="banner">{list.error.message}</p>}
      {list.data?.items.length === 0 && <p className="muted">Nothing shared yet.</p>}
      {list.data?.items.map((x) => (
        <div className="card" key={x.id}>
          <div className="row">
            <span className="tag">{x.kind}</span>
            <strong className="grow">{x.title}</strong>
            <span className="small muted">{x.userName} · {new Date(x.createdAt).toLocaleString()}{x.project ? ` · ${x.project}` : ''}</span>
            <button onClick={async () => setOpen((await get(`/shared/${x.id}`)).item)}>Open</button>
            {(x.mine || me.role === 'owner') && <button className="danger" onClick={async () => { await del(`/shared/${x.id}`); list.reload(); }}>Remove</button>}
          </div>
        </div>
      ))}
      {open && (
        <section className="card" aria-label="Shared item">
          <div className="row"><h2 className="grow" style={{ margin: 0 }}>{open.title}</h2>
            <button onClick={() => navigator.clipboard.writeText(open.content)}>Copy</button>
            <button onClick={() => setOpen(null)}>Close</button></div>
          <p className="small muted">To continue this work: paste it into a new Claude chat, or save it under <code>.resync/passports/</code> and run <code>/resync:resume</code> in Claude Code.</p>
          <pre>{open.content}</pre>
        </section>
      )}
    </>
  );
}
