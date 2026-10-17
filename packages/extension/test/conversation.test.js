import { describe, it, expect, beforeEach } from 'vitest';
import { readConversation, runInChat, setPendingInsert, takePendingInsert, markdownOf } from '../src/content/conversation.js';
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
    expect(res).toEqual({ ok: true, text: '- point one\n- point two' });
    expect(sent[0]).toMatch(/Summarise this conversation in 5 to 10 lines/);
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
