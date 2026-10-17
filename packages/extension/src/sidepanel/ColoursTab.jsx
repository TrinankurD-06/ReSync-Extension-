import { useEffect, useState } from 'react';
import { PRESETS } from '../lib/colours.js';
import { toPage } from './bridge.js';

/** @param {{ settings: import('../lib/settings.js').Settings, update: (fn: (s: any) => void) => Promise<void> }} props */
export default function ColoursTab({ settings, update }) {
  const [items, setItems] = useState(/** @type {{ key: string, kind: string, title: string }[] | null} */ (null));
  const [error, setError] = useState('');
  const preset = PRESETS[settings.colours.preset] ?? PRESETS.startup;

  const load = async () => {
    const r = await toPage({ type: 'resync:listItems' });
    if (r?.ok) {
      setItems(r.items);
      setError('');
    } else setError(r?.error ?? 'Could not read the sidebar.');
  };
  useEffect(() => {
    load();
  }, []);

  const assign = (key, colourId) =>
    update((s) => {
      if (colourId) s.colours.assignments[key] = colourId;
      else delete s.colours.assignments[key];
    });

  return (
    <>
      <h2>Project colours</h2>
      <div className="row">
        <label htmlFor="preset" style={{ flex: '0 0 auto', margin: 0 }}>Preset</label>
        <select id="preset" value={settings.colours.preset} onChange={(e) => update((s) => { s.colours.preset = e.target.value; })}>
          {Object.entries(PRESETS).map(([id, p]) => <option key={id} value={id}>{p.label}</option>)}
        </select>
        <button className="secondary" onClick={load}>Refresh</button>
      </div>
      <p className="small">
        {preset.colours.map((c) => <span key={c.id} className="tag" style={{ boxShadow: `inset 3px 0 0 ${c.colour}` }}>{c.label}</span>)}
      </p>
      {error && <p className="banner">{error}</p>}
      {items && items.length === 0 && <p className="muted">No projects or chats found in the sidebar. Open the claude.ai sidebar and press Refresh.</p>}
      {items?.map((it) => (
        <div className="row card" key={it.key}>
          <span title={it.key}>{it.kind === 'project' ? '📁 ' : ''}{it.title}</span>
          <select aria-label={`Colour for ${it.title}`} value={settings.colours.assignments[it.key] ?? ''} onChange={(e) => assign(it.key, e.target.value)} style={{ maxWidth: 140 }}>
            <option value="">No colour</option>
            {preset.colours.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
          </select>
        </div>
      ))}
      <p className="small muted">Colours sync to your team server when you are signed in (Settings).</p>
    </>
  );
}
