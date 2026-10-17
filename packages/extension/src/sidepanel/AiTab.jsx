import { useEffect, useMemo, useState } from 'react';
import { resolveFeature, ApiModeOffError } from '@resync/shared/models';
import { buildApiRequest, parsePassport, renderPassport, parseTreeResponse, parseSummary } from '@resync/shared/templates';
import { treeToMermaid } from '@resync/shared/tree';
import { createArtifacts, ARTIFACTS_KEY } from '../lib/artifacts.js';
import { setPendingInsert } from '../content/conversation.js';
import { aiRun, toPage, activeClaudeTab, panelSync } from './bridge.js';
import { Icon } from './Icon.jsx';
import Voice from './Voice.jsx';

const FEATURES = [
  ['passport', 'Context Passport', 'A handoff brief: goal, state, decisions, open questions, dead ends, next steps, key files.'],
  ['tree', 'Topic tree', 'The topics of this chat as a collapsible tree and a Mermaid mindmap.'],
  ['summary', 'Summary', '5 to 10 lines you can read or listen to.'],
];
const MAX_TOKENS = { passport: 4000, tree: 3000, summary: 800 };

/** @param {{ settings: import('../lib/settings.js').Settings, update: (fn: (s: any) => void) => Promise<void> }} props */
export default function AiTab({ settings, update }) {
  const artifacts = useMemo(() => createArtifacts(), []);
  const [busy, setBusy] = useState('');
  const [stream, setStream] = useState('');
  const [error, setError] = useState(/** @type {any} */ (null));
  const [current, setCurrent] = useState(/** @type {any} */ (null));
  const [history, setHistory] = useState([]);

  useEffect(() => {
    const load = () => artifacts.list().then(setHistory);
    load();
    const onChange = (c, area) => area === 'local' && c[ARTIFACTS_KEY] && load();
    chrome.storage.onChanged.addListener(onChange);
    return () => chrome.storage.onChanged.removeListener(onChange);
  }, [artifacts]);

  const modeKind = (feature) => {
    try {
      return resolveFeature(settings.ai, feature).mode === 'api' ? 'api' : 'chat';
    } catch {
      return 'off';
    }
  };
  const modeLabel = (feature) => {
    try {
      const r = resolveFeature(settings.ai, feature);
      return r.mode === 'api' ? `API: ${r.providerId} / ${r.model}` : 'In-chat (free, uses your Claude chat)';
    } catch (e) {
      return e instanceof ApiModeOffError ? `API mode not ready: ${e.message}` : 'In-chat';
    }
  };

  /** Turn reply text into a saved artifact. */
  const finish = async (feature, text, mode) => {
    let item;
    if (feature === 'passport') {
      const p = parsePassport(text);
      const content = renderPassport(p.sections, { title: (await activeClaudeTab())?.title?.replace(/ - Claude$/, ''), source: mode });
      item = { kind: 'passport', title: 'Context Passport', content, mode, data: { missing: p.missing } };
    } else if (feature === 'tree') {
      const t = parseTreeResponse(text);
      if (!t.ok) throw new Error(`The topic tree was not valid JSON: ${t.errors.join('; ')}`);
      item = { kind: 'tree', title: t.tree.topic, content: treeToMermaid(t.tree), data: t.tree, mode };
    } else {
      const s = parseSummary(text);
      item = { kind: 'summary', title: s.lines[0]?.slice(0, 60) ?? 'Summary', content: s.lines.join('\n'), mode };
    }
    setCurrent(await artifacts.add(item));
  };

  const run = async (feature, retry = 0) => {
    setError(null);
    setStream('');
    setCurrent(null);
    setBusy(feature);
    try {
      const route = resolveFeature(settings.ai, feature); // throws a readable ApiModeOffError if misconfigured
      if (route.mode === 'in-chat') {
        const r = await toPage({ type: 'resync:inChat', feature });
        if (!r?.ok) throw new Error(r?.error ?? 'In-chat run failed.');
        await finish(feature, r.text, 'in-chat');
        return;
      }
      const conv = await toPage({ type: 'resync:readConversation' });
      if (!conv?.ok) throw new Error(conv?.error ?? 'Could not read the conversation.');
      if (!conv.messages.length) throw new Error('This chat has no messages yet.');
      const req = buildApiRequest(feature, conv.messages);
      const r = await aiRun({ feature, system: req.system, messages: req.messages, maxTokens: MAX_TOKENS[feature] }, (d) => setStream((s) => s + d));
      if (!r.ok) {
        if (r.error.kind === 'needs_ack' && retry === 0) {
          // First use of API mode for this feature: say clearly what is sent where.
          if (!confirm(r.error.message)) throw new Error('Cancelled: nothing was sent.');
          await update((s) => {
            s.privacy.apiModeAcknowledged[feature] = true;
          });
          return run(feature, 1);
        }
        setError({ ...r.error, feature });
        return;
      }
      await finish(feature, r.text, `api: ${r.providerId}/${r.model}`);
    } catch (e) {
      setError({ kind: 'error', message: e.message });
    } finally {
      setBusy('');
    }
  };

  const allow = async (origins, feature) => {
    // Called directly from the click: permission requests need a user gesture.
    if (await chrome.permissions.request({ origins })) run(feature);
  };

  const newChatWithPassport = async (text) => {
    await setPendingInsert(text);
    const tab = await activeClaudeTab();
    if (tab?.id) await chrome.tabs.update(tab.id, { url: 'https://claude.ai/new' });
    else await chrome.tabs.create({ url: 'https://claude.ai/new' });
  };

  return (
    <>
      {FEATURES.map(([id, label, desc]) => (
        <section key={id} className="card">
          <div className="feature-head">
            <span className="feature-icon"><Icon name={id} /></span>
            <strong style={{ flex: 1 }}>{label}</strong>
            <button className="primary" disabled={Boolean(busy)} onClick={() => run(id)}>{busy === id ? 'Working...' : 'Run'}</button>
          </div>
          <div className="small muted" style={{ marginTop: 6 }}>{desc}</div>
          <span className="mode-pill" data-mode={modeKind(id)}>{modeLabel(id)}</span>
        </section>
      ))}
      {busy && <p className="small muted">{resolveSafe(settings, busy) === 'in-chat' ? 'Sent in your chat. Waiting for Claude to finish replying...' : 'Waiting for the provider...'}</p>}
      {stream && busy && <pre className="small">{stream}</pre>}
      {error && (
        <div className="banner">
          {error.message}
          {error.hint && <div className="small">{error.hint}</div>}
          {error.kind === 'needs_permission' && <div><button className="primary" onClick={() => allow(error.origins, error.feature)}>Allow</button></div>}
        </div>
      )}
      {current && <ArtifactView item={current} onNewChat={newChatWithPassport} settings={settings} />}
      {history.length > 0 && (
        <details>
          <summary>Recent ({history.length})</summary>
          {history.map((h) => (
            <div key={h.id} className="row card">
              <span>{h.kind}: {h.title}</span>
              <span className="small muted">{new Date(h.createdAt).toLocaleString()}</span>
              <button className="secondary" onClick={() => setCurrent(h)}>Open</button>
              <button className="secondary" onClick={() => artifacts.remove(h.id)}>Delete</button>
            </div>
          ))}
        </details>
      )}
    </>
  );
}

function resolveSafe(settings, feature) {
  try {
    return resolveFeature(settings.ai, feature).mode;
  } catch {
    return 'api';
  }
}

/** @param {{ item: import('../lib/artifacts.js').Artifact, onNewChat: (text: string) => void, settings: any }} props */
function ArtifactView({ item, onNewChat, settings }) {
  const [view, setView] = useState('tree');
  const [shareMsg, setShareMsg] = useState('');
  const copy = (t) => navigator.clipboard.writeText(t);
  const share = async () => {
    const sync = panelSync();
    if (!(await sync.signedIn())) return setShareMsg('Sign in to a team server in Settings to share.');
    if (!confirm('Share this with your team? It will be stored on your team server.')) return;
    try {
      await sync.share({ kind: item.kind, title: item.title.slice(0, 200), content: item.content });
      await createArtifacts().update(item.id, { sharedAt: Date.now() });
      setShareMsg('Shared with your team.');
    } catch (e) {
      setShareMsg(e.message);
    }
  };
  return (
    <section>
      <h2>{item.kind === 'passport' ? 'Context Passport' : item.kind === 'tree' ? `Topic tree: ${item.title}` : 'Summary'}</h2>
      <div className="small muted">Made {new Date(item.createdAt).toLocaleString()} ({item.mode}). {item.sharedAt ? 'Shared with your team.' : 'Saved in this browser only.'}</div>
      {settings.serverUrl && !item.sharedAt && <p><button className="secondary" onClick={share}>Share with team</button></p>}
      {shareMsg && <p className="small">{shareMsg}</p>}
      {item.kind === 'passport' && (
        <>
          {item.data?.missing?.length > 0 && <p className="banner small">Missing sections: {item.data.missing.join(', ')} (saved as "None").</p>}
          <pre>{item.content}</pre>
          <div className="row">
            <button className="primary" onClick={() => onNewChat(item.content)}>New chat with passport</button>
            <button className="secondary" onClick={() => copy(item.content)}>Copy</button>
          </div>
        </>
      )}
      {item.kind === 'tree' && (
        <>
          <div className="row">
            <button className={view === 'tree' ? 'primary' : 'secondary'} onClick={() => setView('tree')}>Tree</button>
            <button className={view === 'mermaid' ? 'primary' : 'secondary'} onClick={() => setView('mermaid')}>Mermaid</button>
          </div>
          {view === 'tree' ? <TreeNode node={item.data} open /> : (
            <>
              <pre>{item.content}</pre>
              <button className="secondary" onClick={() => copy(item.content)}>Copy Mermaid</button>
              <p className="small muted">Paste into any Mermaid viewer (for example mermaid.live) or a Markdown file to see the mindmap.</p>
            </>
          )}
        </>
      )}
      {item.kind === 'summary' && (
        <>
          <ul>{item.content.split('\n').map((l, i) => <li key={i}>{l}</li>)}</ul>
          <Voice text={item.content} settings={settings} />
          <button className="secondary" onClick={() => copy(item.content)}>Copy</button>
        </>
      )}
    </section>
  );
}

/** Collapsible topic tree. @param {{ node: import('@resync/shared/tree').TopicNode, open?: boolean }} props */
function TreeNode({ node, open = false }) {
  const label = <>{node.topic} <span className="small muted">turns {node.turnRange[0]}-{node.turnRange[1]}</span></>;
  if (!node.children.length) return <div style={{ paddingLeft: 14 }}>{label}</div>;
  return (
    <details open={open} style={{ paddingLeft: 6 }}>
      <summary>{label}</summary>
      <div style={{ paddingLeft: 8 }}>{node.children.map((c, i) => <TreeNode key={i} node={c} />)}</div>
    </details>
  );
}
