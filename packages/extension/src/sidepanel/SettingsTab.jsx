import { useEffect, useMemo, useState } from 'react';
import { listAdapters, hostPermissionsFor } from '@resync/shared/providers';
import { FEATURES } from '@resync/shared/models';
import { createVault } from '../lib/vault.js';
import { STATUS_KEY } from '../lib/syncEngine.js';
import { createUsageStore, projectFileTokens } from '../lib/usageEstimates.js';
import { testProvider, panelSync } from './bridge.js';

const FEATURE_LABELS = { passport: 'Context Passport', tree: 'Topic tree', summary: 'Summary', promptTools: 'Prompt tools', tts: 'Voice (provider TTS)', ledger: 'Decision Ledger checks' };

/** @param {{ settings: import('../lib/settings.js').Settings, update: (fn: (s: any) => void) => Promise<void> }} props */
export default function SettingsTab({ settings, update }) {
  const vault = useMemo(() => createVault(), []);
  return (
    <>
      <p className="muted small">ReSync works fully without API keys: every AI feature runs in your current Claude chat (in-chat mode). API mode is optional.</p>
      <ServerSection settings={settings} update={update} />
      {settings.serverUrl && <AccountSection />}
      <VaultSection vault={vault} />
      <ProvidersSection settings={settings} update={update} vault={vault} />
      <FeatureMapSection settings={settings} update={update} />
      <PrivacySection settings={settings} update={update} />
      <LedgerSection settings={settings} update={update} />
      <ChatHealthSection settings={settings} update={update} />
      <UsageModelSection settings={settings} update={update} />
      <SelectorsSection settings={settings} update={update} />
    </>
  );
}

function ServerSection({ settings, update }) {
  const [url, setUrl] = useState(settings.serverUrl);
  const [msg, setMsg] = useState('');
  const save = async () => {
    const v = url.trim();
    if (v && !/^https?:\/\/[^\s]+$/.test(v)) return setMsg('Enter a URL starting with http:// or https://, or leave blank for local-only.');
    if (v) {
      // Talking to the team server needs host permission for it (requested on this click).
      const origin = `${new URL(v).origin}/*`;
      if (!(await chrome.permissions.request({ origins: [origin] }))) return setMsg('Permission to contact the server was not granted.');
    }
    await update((s) => {
      s.serverUrl = v.replace(/\/+$/, '');
    });
    setMsg(v ? 'Saved. Sign in from the Account section.' : 'Saved: local-only, nothing is synced.');
  };
  return (
    <section>
      <h2>Team server</h2>
      <label htmlFor="server-url">Server URL (blank = local only)</label>
      <div className="row">
        <input id="server-url" placeholder="https://resync.example.com" value={url} onChange={(e) => setUrl(e.target.value)} />
        <button className="secondary" onClick={save}>Save</button>
      </div>
      {msg && <p className="small muted">{msg}</p>}
    </section>
  );
}

/** Team server sign-in (device code) and sync status. */
function AccountSection() {
  const sync = useMemo(() => panelSync(), []);
  const [me, setMe] = useState(/** @type {any} */ (null));
  const [login, setLogin] = useState(/** @type {any} */ (null));
  const [status, setStatus] = useState(/** @type {any} */ (null));
  const [msg, setMsg] = useState('');
  const refresh = async () => {
    setStatus((await chrome.storage.local.get(STATUS_KEY))[STATUS_KEY] ?? null);
    if (await sync.signedIn()) setMe(await sync.me().catch(() => null));
    else setMe(null);
  };
  useEffect(() => {
    refresh();
  }, []);

  const signInFlow = async () => {
    setMsg('');
    try {
      const start = await sync.startLogin();
      setLogin(start);
      chrome.tabs.create({ url: start.verificationUriComplete ?? start.verificationUri });
      await sync.finishLogin(start);
      setLogin(null);
      setMsg('Signed in. Syncing...');
      const r = await chrome.runtime.sendMessage({ type: 'resync:syncNow' });
      setMsg(r?.ok ? 'Signed in and synced.' : `Signed in. Sync: ${r?.error ?? r?.reason}`);
      refresh();
    } catch (e) {
      setLogin(null);
      setMsg(e.message);
    }
  };

  return (
    <section>
      <h2>Account</h2>
      {me ? (
        <>
          <div className="row">
            <span>Signed in as <strong>{me.name}</strong>{me.team ? ` · ${me.team.name}` : ' · no team yet'}</span>
            <button className="secondary" onClick={async () => { const r = await chrome.runtime.sendMessage({ type: 'resync:syncNow' }); setMsg(r?.ok ? `Synced: ${r.pulled} prompts, ${r.usage} usage records.` : r?.error ?? r?.reason); refresh(); }}>Sync now</button>
            <button className="secondary" onClick={async () => { await sync.signOut(); setMsg('Signed out.'); refresh(); }}>Sign out</button>
          </div>
          {status && <p className={`small ${status.ok ? 'muted' : 'error'}`}>Last sync {new Date(status.at).toLocaleString()}: {status.ok ? 'OK' : status.error}</p>}
        </>
      ) : login ? (
        <div className="card">
          <div>Confirm this code in the dashboard tab that just opened:</div>
          <div style={{ fontSize: 20, fontFamily: 'monospace', letterSpacing: 2 }}>{login.userCode}</div>
          <div className="small muted">Waiting for approval...</div>
        </div>
      ) : (
        <button className="primary" onClick={signInFlow}>Sign in to the team server</button>
      )}
      {msg && <p className="small">{msg}</p>}
    </section>
  );
}

function VaultSection({ vault }) {
  const [state, setState] = useState({ exists: false, unlocked: false, loading: true });
  const [pass, setPass] = useState('');
  const [msg, setMsg] = useState('');
  const refresh = async () => setState({ exists: await vault.exists(), unlocked: await vault.isUnlocked(), loading: false });
  useEffect(() => {
    refresh();
  }, []);
  const act = async (fn) => {
    setMsg('');
    try {
      await fn();
      setPass('');
    } catch (e) {
      setMsg(e.message);
    }
    refresh();
  };
  if (state.loading) return null;
  return (
    <section>
      <h2>API keys</h2>
      <p className="small muted">Keys are encrypted with your passphrase and stored only in this browser. They are never synced or sent to the ReSync server, only to the provider they belong to. They stay locked until you unlock them in each browser session.</p>
      {!state.exists && (
        <div className="row">
          <input type="password" aria-label="New passphrase" placeholder="Choose a passphrase (8+ characters)" value={pass} onChange={(e) => setPass(e.target.value)} />
          <button className="primary" onClick={() => act(() => vault.create(pass))}>Create</button>
        </div>
      )}
      {state.exists && !state.unlocked && (
        <div className="row">
          <input type="password" aria-label="Passphrase" placeholder="Passphrase" value={pass} onChange={(e) => setPass(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && act(async () => { if (!(await vault.unlock(pass))) throw new Error('Wrong passphrase.'); })} />
          <button className="primary" onClick={() => act(async () => { if (!(await vault.unlock(pass))) throw new Error('Wrong passphrase.'); })}>Unlock</button>
        </div>
      )}
      {state.exists && state.unlocked && (
        <div className="row">
          <span className="ok">Unlocked for this browser session.</span>
          <button className="secondary" onClick={() => act(() => vault.lock())}>Lock</button>
        </div>
      )}
      {state.exists && !state.unlocked && (
        <p className="small muted">
          Forgot it?{' '}
          <button className="secondary small" onClick={() => confirm('Delete all saved API keys and start over?') && act(() => vault.reset())}>Reset keys</button>
        </p>
      )}
      {msg && <p className="error small">{msg}</p>}
    </section>
  );
}

function ProvidersSection({ settings, update, vault }) {
  const adapters = listAdapters();
  const [form, setForm] = useState({ id: '', type: 'openai-compatible', baseUrl: '', model: '', key: '' });
  const [msg, setMsg] = useState('');
  const [results, setResults] = useState({});
  const adapter = adapters.find((a) => a.type === form.type);

  const add = async () => {
    setMsg('');
    const id = (form.id || form.type).toLowerCase().replace(/[^a-z0-9-]/g, '-');
    const provider = { type: form.type, ...(form.baseUrl ? { baseUrl: form.baseUrl.trim() } : {}), ...(form.model ? { defaultModel: form.model.trim() } : {}) };
    // FIRST await in the click handler: Chrome only allows permission requests during a user gesture.
    let origins;
    try {
      origins = hostPermissionsFor(provider);
    } catch (e) {
      return setMsg(e.message);
    }
    const granted = await chrome.permissions.request({ origins });
    if (!granted) return setMsg(`Permission to contact ${origins.join(', ')} was not granted, so the provider was not added.`);
    try {
      if (form.key.trim()) {
        if (!(await vault.isUnlocked())) throw new Error('Unlock (or create) the key vault above before saving a key.');
        await vault.setKey(id, form.key);
      } else if (adapter?.requiresKey) {
        throw new Error(`${adapter.label} needs an API key.`);
      }
      await update((s) => {
        s.ai.providers[id] = provider;
      });
      setForm({ id: '', type: form.type, baseUrl: '', model: '', key: '' });
      setMsg(`Added "${id}".${form.type === 'openai-compatible' ? ' For Ollama, start it with OLLAMA_ORIGINS=chrome-extension://* so it accepts requests from the extension.' : ''}`);
    } catch (e) {
      setMsg(e.message);
    }
  };

  const remove = async (id) => {
    await vault.removeKey(id);
    await update((s) => {
      delete s.ai.providers[id];
      for (const f of Object.keys(s.ai.features)) if (s.ai.features[f]?.provider === id) s.ai.features[f] = { mode: 'in-chat' };
    });
  };

  const test = async (id) => {
    setResults((r) => ({ ...r, [id]: 'Testing...' }));
    const r = await testProvider(id);
    setResults((x) => ({ ...x, [id]: r.ok ? `OK: ${r.detail}` : `${r.error.kind}: ${r.error.message}` }));
  };

  const providers = Object.entries(settings.ai.providers);
  return (
    <section>
      <h2>Providers (API mode)</h2>
      {providers.length === 0 && <p className="small muted">No providers. Everything runs in-chat.</p>}
      {providers.map(([id, p]) => (
        <div className="card" key={id}>
          <div className="row">
            <strong>{id}</strong>
            <span className="muted small">{p.type}{p.defaultModel ? ` · ${p.defaultModel}` : ''}</span>
            <button className="secondary" onClick={() => test(id)}>Test</button>
            <button className="secondary" onClick={() => remove(id)}>Remove</button>
          </div>
          {results[id] && <div className={`small ${results[id].startsWith('OK') ? 'ok' : 'error'}`}>{results[id]}</div>}
        </div>
      ))}
      <details>
        <summary>Add a provider</summary>
        <label htmlFor="p-type">Type</label>
        <select id="p-type" value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
          {adapters.map((a) => <option key={a.type} value={a.type}>{a.label}</option>)}
        </select>
        <label htmlFor="p-id">Name</label>
        <input id="p-id" placeholder={form.type} value={form.id} onChange={(e) => setForm({ ...form, id: e.target.value })} />
        <label htmlFor="p-url">Base URL {adapter?.type === 'openai-compatible' ? '(Ollama: http://localhost:11434/v1, LM Studio: http://localhost:1234/v1)' : '(optional)'}</label>
        <input id="p-url" placeholder={adapter?.defaultBaseUrl} value={form.baseUrl} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} />
        <label htmlFor="p-model">Default model</label>
        <input id="p-model" placeholder={adapter?.suggestedModels.cheap ?? 'model id'} value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} />
        <label htmlFor="p-key">API key {adapter?.requiresKey ? '' : '(optional)'}</label>
        <input id="p-key" type="password" autoComplete="off" value={form.key} onChange={(e) => setForm({ ...form, key: e.target.value })} />
        <p><button className="primary" onClick={add}>Add provider</button></p>
        {msg && <p className="small">{msg}</p>}
      </details>
    </section>
  );
}

function FeatureMapSection({ settings, update }) {
  const providers = Object.keys(settings.ai.providers);
  const set = (feature, patch) =>
    update((s) => {
      s.ai.features[feature] = { ...(s.ai.features[feature] ?? { mode: 'in-chat' }), ...patch };
    });
  // The ledger never posts in the chat: without a provider it only matches decisions locally ("Related team decision").
  // With one, the new message and the matching decisions are sent to it, so ask once.
  const setLedgerMode = async (mode) => {
    if (mode === 'api' && !settings.privacy.apiModeAcknowledged.ledger && !confirm('Decision Ledger checks will send each new chat message, and the team decisions it might conflict with, to your AI provider. Only messages that share key terms with a decision are sent. Continue?')) return;
    await update((s) => {
      s.ai.features.ledger = { ...(s.ai.features.ledger ?? {}), mode };
      if (mode === 'api') s.privacy.apiModeAcknowledged.ledger = true;
    });
  };
  return (
    <section>
      <h2>Feature to model</h2>
      {FEATURES.map((f) => {
        const fs = settings.ai.features[f] ?? { mode: 'in-chat' };
        return (
          <div className="card" key={f}>
            <strong>{FEATURE_LABELS[f] ?? f}</strong>
            <div className="row">
              <select aria-label={`${f} mode`} value={fs.mode} onChange={(e) => (f === 'ledger' ? setLedgerMode(e.target.value) : set(f, { mode: e.target.value }))}>
                <option value="in-chat">{f === 'ledger' ? 'Local matching only (no key)' : 'In-chat (free, no key)'}</option>
                <option value="api" disabled={!providers.length}>API mode</option>
              </select>
              {fs.mode === 'api' && (
                <>
                  <select aria-label={`${f} provider`} value={fs.provider ?? ''} onChange={(e) => set(f, { provider: e.target.value || undefined })}>
                    <option value="">{providers.length === 1 ? providers[0] : 'Choose provider'}</option>
                    {providers.map((p) => <option key={p} value={p}>{p}</option>)}
                  </select>
                  <input aria-label={`${f} model`} placeholder="model (default from provider)" value={fs.model ?? ''} onChange={(e) => set(f, { model: e.target.value || undefined })} />
                </>
              )}
            </div>
          </div>
        );
      })}
    </section>
  );
}

function PrivacySection({ settings, update }) {
  const toggle = (k) => update((s) => {
    s.privacy[k] = !s.privacy[k];
  });
  const acked = Object.keys(settings.privacy.apiModeAcknowledged).filter((k) => settings.privacy.apiModeAcknowledged[k]);
  return (
    <section>
      <h2>Privacy</h2>
      <p className="small muted">Numbers, settings, colours and prompts sync to a team server, and only when you are signed in. Conversations never sync; a passport or summary is shared only when you click Share. Decision Ledger text syncs only if you turn it on below (see Decision Ledger).</p>
      {[['syncPrompts', 'Sync my prompt library'], ['syncColours', 'Sync project colours'], ['syncUsage', 'Sync usage numbers (estimates, no content)']].map(([k, label]) => (
        <label key={k} className="row"><input type="checkbox" style={{ width: 'auto' }} checked={settings.privacy[k]} onChange={() => toggle(k)} /> {label}</label>
      ))}
      <p className="small">API mode approved for: {acked.length ? acked.join(', ') : 'nothing yet'}</p>
      {acked.length > 0 && <button className="secondary" onClick={() => update((s) => { s.privacy.apiModeAcknowledged = {}; })}>Ask again before sending</button>}
    </section>
  );
}

/** Decision Ledger: your name on decisions, and the opt-in team sync (text, so off by default). */
function LedgerSection({ settings, update }) {
  const [name, setName] = useState(settings.ledger.author);
  const [me, setMe] = useState(/** @type {any} */ (null));
  const team = me?.team ?? null;
  const [msg, setMsg] = useState('');
  const sync = useMemo(() => panelSync(), []);
  useEffect(() => {
    (async () => {
      if (settings.serverUrl && (await sync.signedIn())) setMe(await sync.me().catch(() => null));
    })();
  }, [settings.serverUrl]);
  const toggleSync = async () => {
    const on = !settings.privacy.syncLedger;
    if (on && !confirm('Sync decisions with your team server? This uploads decision text, reasons, your name, the project name and the source chat link. API keys, tokens, passwords, emails and phone numbers are removed first. Your team owner must also allow ledger sync.')) return;
    await update((s) => {
      s.privacy.syncLedger = on;
    });
  };
  const setTeamSync = async (on) => {
    try {
      await sync.setTeamLedgerSync(on);
      setMe({ ...me, team: { ...team, ledgerSync: on } });
      setMsg(on ? 'Ledger sync allowed for your team.' : 'Ledger sync turned off for your team.');
    } catch (e) {
      setMsg(e.message);
    }
  };
  return (
    <section>
      <h2>Decision Ledger</h2>
      <label htmlFor="ledger-author">Your name on decisions (blank: your team-server name)</label>
      <div className="row">
        <input id="ledger-author" value={name} onChange={(e) => setName(e.target.value)} />
        <button className="secondary" onClick={() => update((s) => { s.ledger.author = name; })}>Save</button>
      </div>
      <label className="row"><input type="checkbox" style={{ width: 'auto' }} checked={settings.privacy.syncLedger} onChange={toggleSync} /> Sync decisions with my team (off by default)</label>
      <p className="small muted">
        What is shared when on: each decision's text and reason, author, project name, source chat link, status and links between decisions. Before upload ReSync removes API keys, tokens, passwords, emails and phone numbers (the server checks again). Without a server, or with this off, the ledger is local to this browser.
        {settings.serverUrl ? (team ? ` Your team (${team.name}) has ledger sync ${team.ledgerSync ? 'allowed' : 'not allowed yet; the owner can allow it here or in the dashboard'}.` : ' Sign in to see whether your team allows it.') : ''}
      </p>
      {team && me.role === 'owner' && <button className="secondary" onClick={() => setTeamSync(!team.ledgerSync)}>{team.ledgerSync ? 'Turn off ledger sync for the team' : 'Allow ledger sync for the team'}</button>}
      {msg && <p className="small">{msg}</p>}
      <p className="small muted">Conflict checks use a model only if "Decision Ledger checks" is set to API mode under Feature to model; otherwise ReSync matches decisions locally and shows them as "Related team decision".</p>
    </section>
  );
}

/** Chat Health Meter thresholds and handoff behaviour. */
function ChatHealthSection({ settings, update }) {
  const t = settings.chatHealth;
  const set = (level, key, v) => update((s) => {
    s.chatHealth[level] = { ...s.chatHealth[level], [key]: Number(v) };
  });
  const rows = [['tokens', 'Estimated tokens the chat re-reads'], ['turns', 'Turns (messages and replies)'], ['attachments', 'Attachments']];
  return (
    <section>
      <h2>Chat health</h2>
      <p className="small muted">Long chats get slower and more likely to lose earlier details. The meter turns amber, then red, when any of these is reached. Estimates and rules of thumb, not a model limit; tune them to your models.</p>
      {rows.map(([k, label]) => (
        <div key={k}>
          <label>{label}</label>
          <div className="row">
            <input type="number" min="1" aria-label={`Amber from: ${label}`} value={t.amber[k]} onChange={(e) => set('amber', k, e.target.value)} />
            <input type="number" min="1" aria-label={`Red from: ${label}`} value={t.red[k]} onChange={(e) => set('red', k, e.target.value)} />
          </div>
        </div>
      ))}
      <p className="small muted">Left: amber from. Right: red from.</p>
      <label className="row"><input type="checkbox" style={{ width: 'auto' }} checked={settings.handoff.autoSend} onChange={() => update((s) => { s.handoff.autoSend = !s.handoff.autoSend; })} /> Handoff: send the brief automatically in the new chat (off: ReSync pastes it and you press Send)</label>
    </section>
  );
}

/** Assumptions behind "Estimated tokens processed" (Usage tab). */
function UsageModelSection({ settings, update }) {
  const m = settings.usage;
  const [detected, setDetected] = useState({});
  const [name, setName] = useState('');
  const [tokens, setTokens] = useState('');
  useEffect(() => {
    createUsageStore().detectedProjects().then(setDetected);
  }, []);
  const setRange = (key, side, v) => update((s) => {
    s.usage[key] = { ...s.usage[key], [side]: Number(v) };
  });
  const ranges = [
    ['imageTokens', 'Each attached image'],
    ['fileTokens', 'Each attached file (its size is not shown)'],
    ['hiddenTokens', 'Hidden instructions per turn (unknown)'],
    ['projectDefault', "Project files, when ReSync can't detect them"],
  ];
  const projects = [...new Set([...Object.keys(detected), ...Object.keys(m.projectFiles)])].sort();
  return (
    <section>
      <h2>Usage estimates</h2>
      <p className="small muted">claude.ai doesn't show real token counts. These assumptions set the low and high ends of "Estimated tokens processed" in the Usage tab.</p>
      {ranges.map(([k, label]) => (
        <div key={k}>
          <label>{label}: tokens, low to high</label>
          <div className="row">
            <input type="number" min="0" aria-label={`${label} low`} value={m[k].low} onChange={(e) => setRange(k, 'low', e.target.value)} />
            <input type="number" min="0" aria-label={`${label} high`} value={m[k].high} onChange={(e) => setRange(k, 'high', e.target.value)} />
          </div>
        </div>
      ))}
      <label htmlFor="cap">Project capacity (tokens at "100% of project capacity")</label>
      <input id="cap" type="number" min="1" value={m.projectCapacityTokens} onChange={(e) => update((s) => { s.usage.projectCapacityTokens = Number(e.target.value); })} />
      <h3 className="small">Project files</h3>
      <p className="small muted">ReSync reads "N% of project capacity used" when you open a project page. If it can't, enter the size here (tokens); otherwise the default above is used.</p>
      {projects.map((p) => {
        const r = projectFileTokens(p, { detected, model: m });
        return (
          <div className="row" key={p}>
            <span>{p}</span>
            <span className="small muted">{r.source === 'detected' ? `detected: ${detected[p].percent}% (${r.low} to ${r.high})` : `entered: ${r.low}`}</span>
            {m.projectFiles[p] != null && <button className="secondary" onClick={() => update((s) => { delete s.usage.projectFiles[p]; })}>Remove</button>}
          </div>
        );
      })}
      <div className="row">
        <input placeholder="Project name (as in the sidebar)" value={name} onChange={(e) => setName(e.target.value)} aria-label="Project name" />
        <input type="number" min="0" placeholder="Tokens" value={tokens} onChange={(e) => setTokens(e.target.value)} aria-label="Project file tokens" />
        <button className="secondary" disabled={!name.trim() || tokens === ''} onClick={async () => {
          await update((s) => { s.usage.projectFiles[name.trim()] = Number(tokens); });
          setName('');
          setTokens('');
        }}>Add</button>
      </div>
    </section>
  );
}

function SelectorsSection({ settings, update }) {
  const [text, setText] = useState(JSON.stringify(settings.selectorOverrides, null, 2));
  const [msg, setMsg] = useState('');
  const save = async () => {
    try {
      const v = JSON.parse(text || '{}');
      await update((s) => {
        s.selectorOverrides = v;
      });
      setMsg('Saved. Reload the claude.ai tab.');
    } catch (e) {
      setMsg(`Not valid JSON: ${e.message}`);
    }
  };
  return (
    <details>
      <summary>Advanced: selector overrides</summary>
      <p className="small muted">If claude.ai changes and ReSync shows a "can't find" banner, add CSS selectors here, e.g. {'{ "composer": ["div.new-editor"] }'}.</p>
      <textarea value={text} onChange={(e) => setText(e.target.value)} aria-label="Selector overrides JSON" />
      <button className="secondary" onClick={save}>Save overrides</button>
      {msg && <p className="small">{msg}</p>}
    </details>
  );
}
