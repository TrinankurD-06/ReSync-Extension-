import { useEffect, useMemo, useRef, useState } from 'react';
import { resolveFeature, ApiModeOffError } from '@resync/shared/models';
import { buildApiRequest, parsePassport, renderPassport, parseTreeResponse, parseSummary, passportLengthWarnings, SUMMARY_AUDIENCES } from '@resync/shared/templates';
import { treeToMermaid } from '@resync/shared/tree';
import { renderMermaid, tagMindmapNodes, turnFromEvent } from './mindmap.js';
import { createArtifacts, ARTIFACTS_KEY } from '../lib/artifacts.js';
import { setPendingInsert } from '../content/conversation.js';
import { aiRun, toPage, activeClaudeTab, panelSync } from './bridge.js';
import { createLedger } from '../lib/ledger.js';
import { authorName, confirmSameFn } from './ledgerBridge.js';
import { Icon } from './Icon.jsx';
import Voice from './Voice.jsx';

const FEATURES = [
  ['passport', 'Context Passport', 'For handing off work: a brief a new chat or a teammate can continue from (goal, state, decisions, open questions, dead ends, next steps, key files).'],
  ['tree', 'Topic tree', 'The topics of this chat as a collapsible tree and a mindmap. Click a topic to jump to it in the chat.'],
  ['summary', 'Summary', 'For a quick catch-up: a few plain lines you can read or listen to. Pick who it is for.'],
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
  /** A topic-tree reply that couldn't be parsed: shown raw with a Retry button. */
  const [treeFailure, setTreeFailure] = useState(/** @type {{ raw: string, errors: string[] } | null} */ (null));
  /** What the last passport added to the Decision Ledger. */
  const [ledgerMsg, setLedgerMsg] = useState('');
  const audience = settings.summary.audience;

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

  /**
   * Turn reply text into a saved artifact.
   * @param {{ turns?: number, meta?: { date: string, project: string, source: string } }} page what ReSync read from the page
   */
  const finish = async (feature, text, mode, page = {}) => {
    let item;
    if (feature === 'passport') {
      const p = parsePassport(text);
      // Meta comes from the page (date, project, chat URL), not from the model.
      const content = renderPassport(p.sections, { title: (await activeClaudeTab())?.title?.replace(/ - Claude$/, ''), project: page.meta?.project, source: page.meta?.source, mode });
      item = { kind: 'passport', title: 'Context Passport', content, mode, data: { missing: p.missing, warnings: passportLengthWarnings(p.sections), sourceChat: page.meta?.source } };
      // Its "Decisions made (and why)" go into the Decision Ledger ((assumed) ones as pending; near-duplicates merge).
      const d = await createLedger().addFromPassport(content, { author: await authorName(settings), project: page.meta?.project, sourceChat: page.meta?.source }, { confirmSame: confirmSameFn(settings) });
      setLedgerMsg(d.added.length || d.merged.length ? `Decision Ledger: ${d.added.length} added${d.pending ? ` (${d.pending} pending: confirm them in the Ledger tab)` : ''}${d.merged.length ? `, ${d.merged.length} merged into existing decisions` : ''}.` : '');
    } else if (feature === 'tree') {
      const t = parseTreeResponse(text, { turns: page.turns });
      if (!t.ok) {
        setTreeFailure({ raw: t.raw, errors: t.errors });
        return;
      }
      item = { kind: 'tree', title: t.tree.topic, content: treeToMermaid(t.tree), data: { tree: t.tree, warnings: t.warnings, turns: page.turns }, mode };
    } else {
      const s = parseSummary(text, { audience });
      item = { kind: 'summary', title: s.lines[0]?.slice(0, 60) ?? 'Summary', content: s.lines.join('\n'), mode, data: { audience } };
    }
    setCurrent(await artifacts.add(item));
  };

  const run = async (feature, retry = 0) => {
    setError(null);
    setStream('');
    setCurrent(null);
    setTreeFailure(null);
    setLedgerMsg('');
    setBusy(feature);
    try {
      const route = resolveFeature(settings.ai, feature); // throws a readable ApiModeOffError if misconfigured
      if (route.mode === 'in-chat') {
        const r = await toPage({ type: 'resync:inChat', feature, audience });
        if (!r?.ok) throw new Error(r?.error ?? 'In-chat run failed.');
        await finish(feature, r.text, 'in-chat', { turns: r.turns, meta: r.meta });
        return;
      }
      const conv = await toPage({ type: 'resync:readConversation' });
      if (!conv?.ok) throw new Error(conv?.error ?? 'Could not read the conversation.');
      if (!conv.messages.length) throw new Error('This chat has no messages yet.');
      const req = buildApiRequest(feature, conv.messages, { meta: conv.meta, audience });
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
      await finish(feature, r.text, `api: ${r.providerId}/${r.model}`, { turns: conv.messages.length, meta: conv.meta });
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
          {id === 'summary' && (
            <div className="row" style={{ marginTop: 6 }}>
              <label htmlFor="audience">For</label>
              <select id="audience" value={audience} onChange={(e) => update((s) => { s.summary.audience = e.target.value; })}>
                {Object.entries(SUMMARY_AUDIENCES).map(([k, a]) => <option key={k} value={k}>{a.label}</option>)}
              </select>
            </div>
          )}
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
      {treeFailure && (
        <div className="banner" data-testid="tree-failure">
          ReSync couldn't read the topic tree from the reply: {treeFailure.errors.join('; ')}. Here is the raw reply:
          <pre>{treeFailure.raw}</pre>
          <button className="primary" disabled={Boolean(busy)} onClick={() => run('tree')}>Retry</button>
        </div>
      )}
      {ledgerMsg && <p className="tip" data-testid="ledger-msg">{ledgerMsg}</p>}
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
          {item.data?.warnings?.length > 0 && <p className="banner small">Longer than the cap: {item.data.warnings.join('; ')}.</p>}
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
            <button className={view === 'mermaid' ? 'primary' : 'secondary'} onClick={() => setView('mermaid')}>Mindmap</button>
          </div>
          {treeWarnings(item).length > 0 && (
            <details className="small" data-testid="tree-warnings">
              <summary>ReSync fixed {treeWarnings(item).length} problem(s) in the tree</summary>
              <ul>{treeWarnings(item).map((w, i) => <li key={i}>{w}</li>)}</ul>
            </details>
          )}
          {view === 'tree' ? <TreeNode node={treeOf(item)} open /> : (
            <>
              <Mindmap tree={treeOf(item)} source={item.content} />
              <button className="secondary" onClick={() => copy(item.content)}>Copy Mermaid source</button>
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

/** Saved trees: { tree, warnings } now; older ones stored the tree itself. */
const treeOf = (item) => item.data?.tree ?? item.data;
const treeWarnings = (item) => item.data?.warnings ?? [];

/** Scroll the chat to a turn (the page counts turns the same way it did for the prompt). */
const goToTurn = (turn) => toPage({ type: 'resync:scrollToTurn', turn });

/** The mindmap, rendered from the same JSON with the bundled Mermaid; click a node to jump to its turn. */
function Mindmap({ tree, source }) {
  const ref = useRef(/** @type {HTMLDivElement | null} */ (null));
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    setError('');
    renderMermaid(source)
      .then((svg) => {
        if (!live || !ref.current) return;
        ref.current.innerHTML = svg;
        tagMindmapNodes(ref.current, tree);
      })
      .catch((e) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [tree, source]);
  const onActivate = (e) => {
    if (e.type === 'keydown' && e.key !== 'Enter' && e.key !== ' ') return;
    const turn = turnFromEvent(e.target);
    if (turn) goToTurn(turn);
  };
  return (
    <>
      {error && <p className="banner small">Couldn't draw the mindmap ({error}). The Mermaid source is below.</p>}
      <div ref={ref} className="mindmap" data-testid="mindmap" onClick={onActivate} onKeyDown={onActivate} />
      {error && <pre>{source}</pre>}
    </>
  );
}

/** Collapsible topic tree; clicking a topic scrolls the chat to it. @param {{ node: import('@resync/shared/tree').TopicNode, open?: boolean }} props */
function TreeNode({ node, open = false }) {
  const go = (e) => {
    e.preventDefault(); // inside <summary>, don't also toggle
    goToTurn(node.turnRange[0]);
  };
  const label = (
    <>
      <span className="tree-node" role="button" tabIndex={0} data-turn={node.turnRange[0]} title={`Go to turn ${node.turnRange[0]}`} onClick={go} onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && go(e)}>{node.topic}</span>{' '}
      <span className="small muted">turns {node.turnRange[0]}-{node.turnRange[1]}</span>
    </>
  );
  if (!node.children.length) return <div style={{ paddingLeft: 14 }}>{label}</div>;
  return (
    <details open={open} style={{ paddingLeft: 6 }}>
      <summary>{label}</summary>
      <div style={{ paddingLeft: 8 }}>{node.children.map((c, i) => <TreeNode key={i} node={c} />)}</div>
    </details>
  );
}
