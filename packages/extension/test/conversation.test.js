import { describe, it, expect, beforeEach } from 'vitest';
import { readConversation, runInChat, setPendingInsert, takePendingInsert, markdownOf, conversationTurns, scrollToTurn, pageMeta } from '../src/content/conversation.js';
import { createArtifacts } from '../src/lib/artifacts.js';
import { realPage } from '../src/content/chain.js';
import { memoryArea } from './fakeChrome.js';

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('conversation on the page', () => {
  it('reads user and assistant turns in page order, ignoring nested matches', () => {
    document.body.innerHTML = `
      <div data-testid="user-message">Build a login page</div>
      <div class="font-claude-response"><div data-is-streaming="false">Sure, here is the form.</div></div>
      <div data-testid="user-message">Add dark mode</div>
      <div class="font-claude-response">Done.</div>`;
    expect(readConversation()).toEqual([
      { role: 'user', content: 'Build a login page' },
      { role: 'assistant', content: 'Sure, here is the form.' },
      { role: 'user', content: 'Add dark mode' },
      { role: 'assistant', content: 'Done.' },
    ]);
  });

  it('reads only the code of a code block, not its language label or copy button', () => {
    document.body.innerHTML = '<div data-testid="assistant-message"><p>Here:</p><pre><div>json</div><button data-testid="code-block-copy">Copy</button><code>{"topic":"x"}</code></pre></div>';
    expect(readConversation()[0].content).toBe('Here:\n\n```\n{"topic":"x"}\n```');
  });

  it('runs a feature in-chat: sends the instructions, waits for the reply, returns its text', async () => {
    document.body.innerHTML = '<main id="t"></main><textarea placeholder="Reply"></textarea><button aria-label="Send message">Send</button>';
    const sent = [];
    document.querySelector('button').addEventListener('click', () => {
      const ta = document.querySelector('textarea');
      sent.push(ta.value);
      ta.value = '';
      const r = document.createElement('div');
      r.className = 'font-claude-response';
      r.innerHTML = '<ul><li>point one</li><li>point two</li></ul>';
      document.getElementById('t').appendChild(r);
    });
    let t = 0;
    const res = await runInChat('summary', { page: realPage(() => ({})), wait: async (ms) => void (t += ms), options: { settleMs: 500 } });
    expect(res).toMatchObject({ ok: true, text: '- point one\n- point two', turns: 0 });
    expect(sent[0]).toMatch(/Summarise this conversation in 5 to 10 lines/);
  });

  it('counts turns from the page before sending, tells the model, and maps turns back for scrolling', async () => {
    document.body.innerHTML = `<header><a href="/project/p1">Launch</a></header><main id="t">
      <div data-testid="user-message">q1</div><div class="font-claude-response">a1</div>
      <div data-testid="user-message">q2</div><div class="font-claude-response">a2</div></main>
      <textarea placeholder="Reply"></textarea><button aria-label="Send message">Send</button>`;
    expect(conversationTurns().map((t) => t.content)).toEqual(['q1', 'a1', 'q2', 'a2']);
    const sent = [];
    document.querySelector('button[aria-label="Send message"]').addEventListener('click', () => {
      sent.push(document.querySelector('textarea').value);
      document.getElementById('t').insertAdjacentHTML('beforeend', '<div class="font-claude-response">```json\n{}\n```</div>');
    });
    const res = await runInChat('tree', { page: realPage(() => ({})), wait: async () => {}, options: { settleMs: 0 }, href: 'https://claude.ai/chat/abc?x=1' });
    expect(sent[0]).toContain('The conversation has 4 turns.'); // the request itself is not counted
    expect(res).toMatchObject({ ok: true, turns: 4, meta: { project: 'Launch', source: 'https://claude.ai/chat/abc' } });

    // Click-to-scroll: turn N is the Nth message counted the same way (the request and reply come after).
    const scrolled = [];
    for (const el of document.querySelectorAll('[data-testid="user-message"], .font-claude-response')) el.scrollIntoView = () => scrolled.push(el.textContent);
    expect(scrollToTurn(3)).toEqual({ ok: true, turn: 3 });
    expect(scrolled).toEqual(['q2']);
    expect(scrollToTurn(99)).toEqual({ ok: true, turn: 5 }); // clamped to the last turn (Claude's reply to the request)
    document.body.innerHTML = '';
    expect(scrollToTurn(1).ok).toBe(false);
  });

  it('passport Meta comes from the page: date, project and chat URL', async () => {
    document.body.innerHTML = '<header><a href="/project/p1"> Launch </a></header><main><textarea placeholder="Reply"></textarea><button aria-label="Send message">Send</button></main>';
    expect(pageMeta({ href: 'https://claude.ai/chat/abc#x', now: new Date(2026, 9, 19) })).toEqual({ date: '2026-10-19', project: 'Launch', source: 'https://claude.ai/chat/abc' });
    const sent = [];
    document.querySelector('button').addEventListener('click', () => {
      sent.push(document.querySelector('textarea').value);
      document.querySelector('main').insertAdjacentHTML('beforeend', '<div class="font-claude-response"><h2>Goal</h2><p>x</p></div>');
    });
    await runInChat('passport', { page: realPage(() => ({})), wait: async () => {}, options: { settleMs: 0 }, href: 'https://claude.ai/chat/abc' });
    expect(sent[0]).toContain('- Project: Launch\n- Source: https://claude.ai/chat/abc');
  });

  it('turns a rendered reply back into Markdown the shared parsers understand', async () => {
    const { parsePassport, parseTreeResponse } = await import('@resync/shared/templates');
    const el = document.createElement('div');
    el.innerHTML = `<p>Here it is:</p><h2>Goal</h2><p>Ship <strong>v1</strong>.</p><h2>Current state</h2><p>Login done.</p>
      <h2>Decisions made (and why)</h2><ol><li>JWT, because stateless.</li><li>Postgres.</li></ol>
      <h2>Open questions</h2><p>None</p><h2>Dead ends</h2><p>None</p><h2>Next 3 steps</h2><ol><li>a</li><li>b</li><li>c</li></ol>
      <h2>Key files</h2><ul><li><code>src/auth.js</code></li></ul><button>Copy</button>`;
    const md = markdownOf(el);
    expect(md).toMatch(/## Goal\n+Ship v1\./);
    expect(md).toMatch(/1\. JWT, because stateless\.\n+2\. Postgres\./);
    expect(md).toContain('- src/auth.js');
    expect(md).not.toContain('Copy');
    expect(parsePassport(md).ok).toBe(true);

    const tree = document.createElement('div');
    tree.innerHTML = '<p>Tree:</p><pre><code class="language-json">{"topic":"A","children":[],"turnRange":[1,2]}\n</code></pre>';
    expect(markdownOf(tree)).toContain('```json\n{"topic"');
    expect(parseTreeResponse(markdownOf(tree)).ok).toBe(true);
  });

  it('reports in-chat failures (e.g. no message box)', async () => {
    const res = await runInChat('passport', { page: realPage(() => ({})), wait: async () => {} });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/message box/);
  });

  it('pending insert is taken once and expires', async () => {
    const area = memoryArea();
    await setPendingInsert('# Context Passport', area);
    expect(await takePendingInsert(area)).toBe('# Context Passport');
    expect(await takePendingInsert(area)).toBeNull();
    await area.set({ 'resync.pendingInsert': { text: 'old', at: Date.now() - 10 * 60_000 } });
    expect(await takePendingInsert(area)).toBeNull();
  });

  it('keeps the last artifacts locally', async () => {
    const a = createArtifacts(memoryArea());
    const item = await a.add({ kind: 'summary', title: 'S', content: 'x', mode: 'in-chat' });
    await a.update(item.id, { sharedAt: 1 });
    expect((await a.list())[0]).toMatchObject({ kind: 'summary', sharedAt: 1 });
    await a.remove(item.id);
    expect(await a.list()).toEqual([]);
  });
});
