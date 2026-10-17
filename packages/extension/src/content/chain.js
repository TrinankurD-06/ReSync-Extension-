// Runs chains on the real claude.ai page. The runner (src/lib/chainRunner.js) is DOM-free; this file gives it
// the page: selectors for streaming/replies/alerts, the composer for sending, and a MutationObserver so it
// reacts as soon as the streaming indicator changes (polling is only a fallback cap).
import { createChainRunner } from '../lib/chainRunner.js';
import { query, queryAll, isStreaming, findAlert } from '../lib/selectors.js';
import { insertText, submit } from '../lib/composer.js';

/**
 * @param {() => Record<string, string[]>} getOverrides
 * @returns {import('../lib/chainRunner.js').ChainPage}
 */
export function realPage(getOverrides) {
  const o = () => ({ overrides: getOverrides() });
  return {
    hasComposer: () => Boolean(query('composer', o())),
    isStreaming: () => isStreaming(o()),
    replyCount: () => queryAll('assistantMessage', o()).length,
    findAlert: () => findAlert(o()),
    send(text) {
      const c = query('composer', o());
      if (!c) return false;
      insertText(c, text, { replace: true });
      return submit(o());
    },
  };
}

/** A wait() that resolves after `ms`, or earlier when the page changes. */
export function mutationWait(target = document.body) {
  const waiters = new Set();
  const observer = new MutationObserver(() => {
    for (const w of waiters) w();
    waiters.clear();
  });
  observer.observe(target, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-is-streaming', 'aria-label', 'disabled'] });
  const wait = (ms) =>
    new Promise((resolve) => {
      const done = () => {
        clearTimeout(t);
        waiters.delete(done);
        resolve();
      };
      const t = setTimeout(done, ms);
      waiters.add(done);
    });
  return { wait, disconnect: () => observer.disconnect() };
}

/**
 * One chain at a time per tab. Broadcasts progress as 'resync:chainUpdate' messages.
 * @param {{ getOverrides: () => Record<string, string[]>, broadcast?: (msg: unknown) => void, page?: import('../lib/chainRunner.js').ChainPage, wait?: (ms: number) => Promise<void> }} o
 */
export function createChainController(o) {
  const broadcast = o.broadcast ?? ((m) => chrome.runtime.sendMessage(m).catch(() => {}));
  /** @type {ReturnType<typeof createChainRunner> | null} */
  let runner = null;
  let last = null;
  let title = '';

  return {
    /** @param {{ title?: string, steps: { text: string, waitFor: 'response' | 'timer', delaySeconds: number }[] }} msg */
    start(msg) {
      if (runner && !['done', 'stopped', 'cancelled'].includes(runner.state.status)) {
        return { ok: false, error: 'A chain is already running in this tab. Cancel it first.' };
      }
      title = msg.title ?? 'Chain';
      const mw = o.wait ? null : mutationWait();
      runner = createChainRunner({
        page: o.page ?? realPage(o.getOverrides),
        steps: msg.steps,
        wait: o.wait ?? mw.wait,
        onState: (s) => {
          last = { ...s, title, paused: runner?.paused ?? false };
          broadcast({ type: 'resync:chainUpdate', state: last });
        },
      });
      runner.start().finally(() => mw?.disconnect());
      return { ok: true };
    },
    /** @param {{ action: 'pause' | 'resume' | 'skip' | 'cancel' }} msg */
    control(msg) {
      if (!runner) return { ok: false, error: 'No chain is running.' };
      if (!['pause', 'resume', 'skip', 'cancel'].includes(msg.action)) return { ok: false, error: 'Unknown action.' };
      runner[msg.action]();
      last = { ...runner.state, title, paused: runner.paused };
      broadcast({ type: 'resync:chainUpdate', state: last });
      return { ok: true };
    },
    state() {
      return { ok: true, state: last };
    },
  };
}
