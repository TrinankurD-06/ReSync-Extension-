// The chain controller on a DOM page (happy-dom): real selectors, composer and MutationObserver wait.
import { describe, it, expect, beforeEach } from 'vitest';
import { createChainController, realPage, mutationWait } from '../src/content/chain.js';
import { mergeChainContext, chainContextBlock } from '@resync/shared/chains';
import { hasSharedRules } from '@resync/shared/rules';

beforeEach(() => {
  document.body.innerHTML = '<main id="thread"></main><textarea placeholder="Reply"></textarea><button aria-label="Send message">Send</button>';
});

/**
 * Fake claude.ai behaviour: on send, stream a reply (stop button visible), then finish it.
 * `keep`: like the real virtualised transcript, keep only the newest N replies in the page.
 */
function fakeClaude({ streamMs = 30, keep = Infinity } = {}) {
  const sent = [];
  document.querySelector('button').addEventListener('click', () => {
    const ta = document.querySelector('textarea');
    sent.push(ta.value);
    ta.value = '';
    const msg = document.createElement('div');
    msg.dataset.testid = 'assistant-message';
    msg.dataset.turnKey = `turn-${sent.length}`;
    msg.dataset.isStreaming = 'true';
    msg.textContent = '...';
    const thread = document.getElementById('thread');
    thread.appendChild(msg);
    while (thread.children.length > keep) thread.firstElementChild.remove();
    const stop = document.createElement('button');
    stop.setAttribute('aria-label', 'Stop response');
    document.body.appendChild(stop);
    setTimeout(() => {
      msg.dataset.isStreaming = 'false';
      msg.textContent = `Reply to: ${sent.at(-1)}`;
      stop.remove();
    }, streamMs);
  });
  return sent;
}

describe('chain on a page', () => {
  it('real page adapter reads streaming state, replies and sends through the composer', async () => {
    const sent = fakeClaude();
    const page = realPage(() => ({}));
    expect(page.hasComposer()).toBe(true);
    expect(page.replyCount()).toBe(0);
    expect(page.send('hello')).toBe(true);
    expect(sent).toEqual(['hello']);
    expect(page.isStreaming()).toBe(true);
    await new Promise((r) => setTimeout(r, 60));
    expect(page.isStreaming()).toBe(false);
    expect(page.replyCount()).toBe(1);
  });

  it('mutationWait wakes early on page changes', async () => {
    const mw = mutationWait();
    const started = Date.now();
    setTimeout(() => document.body.appendChild(document.createElement('p')), 10);
    await mw.wait(5000);
    expect(Date.now() - started).toBeLessThan(1000);
    mw.disconnect();
  });

  it('controller runs a 3-step chain with a timer end to end and broadcasts progress', async () => {
    const sent = fakeClaude();
    const updates = [];
    const ctl = createChainController({
      getOverrides: () => ({}),
      broadcast: (m) => updates.push(m.state),
    });
    const steps = [
      { text: 'one', waitFor: 'response', delaySeconds: 0 },
      { text: 'two', waitFor: 'timer', delaySeconds: 1 },
      { text: 'three', waitFor: 'response', delaySeconds: 0 },
    ];
    expect(ctl.start({ title: 'Test chain', steps })).toEqual({ ok: true });
    expect(ctl.start({ steps })).toMatchObject({ ok: false });
    // Runner settles 1.5 s after each reply; allow for 3 replies + a 1 s timer.
    for (let i = 0; i < 100 && updates.at(-1)?.status !== 'done'; i++) await new Promise((r) => setTimeout(r, 100));
    expect(updates.at(-1)).toMatchObject({ status: 'done', title: 'Test chain' });
    expect(sent).toEqual(['one', 'two', 'three']);
    expect(updates.some((u) => u.status === 'countdown')).toBe(true);
    expect(ctl.state().state.status).toBe('done');
  }, 20_000);

  it('sends every step with the chain context, the previous reply and the shared rules', async () => {
    const sent = fakeClaude();
    const updates = [];
    const ctl = createChainController({ getOverrides: () => ({}), broadcast: (m) => updates.push(m.state) });
    const context = mergeChainContext({ inputs: { product: 'ReSync' }, budget: '₹0', teamMembers: [{ name: 'Asha', role: 'founder' }] });
    ctl.start({ steps: ['Position it.', 'Pick channels.', 'Calendar with owner.'].map((text) => ({ text, waitFor: 'response', delaySeconds: 0 })), context });
    for (let i = 0; i < 100 && updates.at(-1)?.status !== 'done'; i++) await new Promise((r) => setTimeout(r, 100));
    expect(updates.at(-1)).toMatchObject({ status: 'done' });
    expect(sent).toHaveLength(3);
    for (const [i, text] of sent.entries()) {
      expect(text).toContain(chainContextBlock(context));
      expect(hasSharedRules(text)).toBe(true);
      if (i > 0) expect(text).toContain(`Previous step's output:\n"""\nReply to: ${sent[i - 1]}\n"""`);
    }
    expect(sent[0]).not.toContain("Previous step's output");
    expect(sent[2]).toContain('Owners must be people from the team: Asha (founder).');
  }, 15_000);

  it('finishes a chain when the page keeps only the newest replies (virtualised transcript)', async () => {
    // Regression (real claude.ai, 2026-10-17): the reply count stays flat in a long chat, so a count-based
    // wait never saw step 2's reply finish and step 3 was never sent.
    const sent = fakeClaude({ keep: 1 });
    document.getElementById('thread').insertAdjacentHTML('beforeend', '<div data-testid="assistant-message" data-turn-key="old" data-is-streaming="false">old</div>');
    const updates = [];
    const ctl = createChainController({ getOverrides: () => ({}), broadcast: (m) => updates.push(m.state) });
    ctl.start({ steps: ['one', 'two', 'three'].map((text) => ({ text, waitFor: 'response', delaySeconds: 0 })) });
    for (let i = 0; i < 100 && updates.at(-1)?.status !== 'done'; i++) await new Promise((r) => setTimeout(r, 100));
    expect(updates.at(-1)).toMatchObject({ status: 'done' });
    expect(sent).toEqual(['one', 'two', 'three']);
  }, 20_000);

  it('controller pauses, resumes and cancels', async () => {
    fakeClaude();
    const updates = [];
    const ctl = createChainController({ getOverrides: () => ({}), broadcast: (m) => updates.push(m.state) });
    ctl.start({ steps: [{ text: 'a', waitFor: 'response', delaySeconds: 0 }, { text: 'b', waitFor: 'timer', delaySeconds: 30 }] });
    expect(ctl.control({ action: 'pause' })).toEqual({ ok: true });
    expect(updates.at(-1).paused).toBe(true);
    ctl.control({ action: 'resume' });
    ctl.control({ action: 'cancel' });
    for (let i = 0; i < 50 && updates.at(-1)?.status !== 'cancelled'; i++) await new Promise((r) => setTimeout(r, 100));
    expect(updates.at(-1).status).toBe('cancelled');
    expect(ctl.control({ action: 'jump' })).toMatchObject({ ok: false });
  }, 10_000);
});
