import { useEffect, useState } from 'react';
import { PRESETS, colourById, makeCustomColour } from '../lib/colours.js';
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

  const custom = settings.colours.custom;
  const [name, setName] = useState('');
  const [hex, setHex] = useState('#0ea5e9');
  const addCustom = async (e) => {
    e.preventDefault();
    try {
      const c = makeCustomColour(name, hex, custom);
      await update((s) => {
        s.colours.custom.push(c);
      });
      setName('');
      setError('');
    } catch (err) {
      setError(/** @type {Error} */ (err).message);
    }
  };
  const editCustom = (id, patch) =>
    update((s) => {
      const c = s.colours.custom.find((x) => x.id === id);
      if (c) Object.assign(c, patch);
    });
  const removeCustom = (id) =>
    update((s) => {
      s.colours.custom = s.colours.custom.filter((x) => x.id !== id);
      for (const [k, v] of Object.entries(s.colours.assignments)) if (v === id) delete s.colours.assignments[k];
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
      <h3>Your colours</h3>
      {custom.map((c) => (
        <div className="row" key={c.id}>
          <input type="color" aria-label={`Colour for ${c.label}`} value={c.colour} onChange={(e) => editCustom(c.id, { colour: e.target.value })} style={{ flex: '0 0 40px', padding: 0 }} />
          <input aria-label="Colour name" value={c.label} maxLength={60} onChange={(e) => editCustom(c.id, { label: e.target.value })} />
          <button className="secondary" onClick={() => removeCustom(c.id)}>Delete</button>
        </div>
      ))}
      <form className="row" onSubmit={addCustom}>
        <input type="color" aria-label="New colour" value={hex} onChange={(e) => setHex(e.target.value)} style={{ flex: '0 0 40px', padding: 0 }} />
        <input aria-label="New colour name" placeholder="Name, e.g. Client work" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
        <button type="submit" className="secondary">Add colour</button>
      </form>
      {error && <p className="banner">{error}</p>}
      {items && items.length === 0 && <p className="muted">No projects or chats found in the sidebar. Open the claude.ai sidebar and press Refresh.</p>}
      {items?.map((it) => (
        <div className="row card" key={it.key}>
          <span title={it.key}>{it.kind === 'project' ? '📁 ' : ''}{it.title}</span>
          <select aria-label={`Colour for ${it.title}`} value={settings.colours.assignments[it.key] ?? ''} onChange={(e) => assign(it.key, e.target.value)} style={{ maxWidth: 140 }}>
            <option value="">No colour</option>
            {custom.length > 0 && <optgroup label="Your colours">{custom.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}</optgroup>}
            {(() => {
              // A colour from another preset stays selectable after switching presets.
              const id = settings.colours.assignments[it.key];
              const c = id && !custom.some((x) => x.id === id) && !preset.colours.some((x) => x.id === id) ? colourById(id) : null;
              return c && <option value={c.id}>{c.label}</option>;
            })()}
            <optgroup label={preset.label}>{preset.colours.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}</optgroup>
          </select>
        </div>
      ))}
      <p className="small muted">Colours sync to your team server when you are signed in (Settings).</p>
    </>
  );
}
