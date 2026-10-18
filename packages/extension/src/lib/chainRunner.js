// Multi-step chains (spec section 5.3): send the next step only after the previous reply has finished
// streaming, then wait the optional delay. Pause, resume, skip, cancel, progress with a countdown.
// Stops by itself on an error notice, a usage-limit notice, a missing message box, or a reply that never
// comes. Never sends faster than one message per completed response.
//
// The runner is DOM-free: it talks to a `page` object (real claude.ai in the content script, a fake in tests).

/**
 * @typedef {{
 *   hasComposer(): boolean,
 *   isStreaming(): boolean,
 *   replyCount(): number,
 *   lastReply?(): unknown,     identity of the newest reply (preferred over replyCount: claude.ai only keeps
 *                              part of a long chat in the page, so the count can stay flat as replies arrive)
 *   findAlert(): { kind: 'limit' | 'error', text: string } | null,
 *   send(text: string): boolean,
 *   lastReplyText?(): string,  text of the newest reply (passed on to the next step)
 * }} ChainPage
 *
 * @typedef {'idle' | 'sending' | 'waiting-reply' | 'countdown' | 'paused' | 'done' | 'stopped' | 'cancelled'} ChainStatus
 *
 * @typedef {{
 *   status: ChainStatus,
 *   step: number,              index of the current/next step (0-based)
 *   total: number,
 *   countdown: number,         seconds left before the next step (status 'countdown')
 *   sent: number[],            indexes of steps that were sent
 *   skipped: number[],
 *   reason?: string,           why it stopped
 *   pausedFrom?: ChainStatus,
 * }} ChainState
 */

export const DEFAULTS = {
  pollMs: 250,
  settleMs: 1500, // reply must be quiet (not streaming) this long to count as finished
  replyStartTimeoutMs: 60_000, // a reply must appear within this time after sending
  replyTimeoutMs: 15 * 60_000, // and finish within this time
};

/**
 * @param {{
 *   page: ChainPage,
 *   steps: { text: string, waitFor: 'response' | 'timer', delaySeconds: number }[],
 *   compose?: (step: { text: string }, o: { index: number, previousOutput: string }) => string,
 *              builds the text actually sent (chain context, previous output, rules); default: the step text
 *   onState?: (s: ChainState) => void,
 *   wait?: (ms: number) => Promise<void>,
 *   now?: () => number,
 *   options?: Partial<typeof DEFAULTS>,
 * }} o
 */
export function createChainRunner(o) {
  const opt = { ...DEFAULTS, ...(o.options ?? {}) };
  const wait = o.wait ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const now = o.now ?? (() => Date.now());
  /** @type {ChainState} */
  const state = { status: 'idle', step: 0, total: o.steps.length, countdown: 0, sent: [], skipped: [] };
  let paused = false;
  let cancelled = false;
  let skipRequested = false;
  /** Text of the reply to the last step that was sent. */
  let previousOutput = '';

  const emit = () => o.onState?.({ ...state, sent: [...state.sent], skipped: [...state.skipped] });
  const set = (patch) => {
    Object.assign(state, patch);
    emit();
  };

  /** Stop with a reason; returns false so callers can `return stop(...)`. */
  function stop(reason) {
    set({ status: 'stopped', reason, countdown: 0 });
    return false;
  }

  /** While paused, hold here. Returns false if cancelled meanwhile. */
  async function holdWhilePaused() {
    if (!paused) return !cancelled;
    const from = state.status;
    set({ status: 'paused', pausedFrom: from });
    while (paused && !cancelled) await wait(opt.pollMs);
    if (cancelled) return false;
    set({ status: from, pausedFrom: undefined });
    return true;
  }

  /** A value that changes whenever a new reply appears. */
  const replyMarker = () => (o.page.lastReply ? o.page.lastReply() : o.page.replyCount());

  /** Check the page for problems that must stop the chain. */
  function problem() {
    const alert = o.page.findAlert();
    if (alert?.kind === 'limit') return `Usage limit reached: ${alert.text}`;
    if (alert?.kind === 'error') return `claude.ai showed an error: ${alert.text}`;
    return null;
  }

  /**
   * Wait until the reply to the message just sent has finished.
   * @param {unknown} markerBefore replyMarker() before sending
   * @param {{ alreadyStarted?: boolean }} [w] a reply is already streaming: just wait for it to finish
   */
  async function waitForReply(markerBefore, w = {}) {
    set({ status: 'waiting-reply' });
    const sentAt = now();
    let quietSince = null;
    while (!cancelled) {
      const p = problem();
      if (p) return stop(p);
      const fresh = w.alreadyStarted || replyMarker() !== markerBefore;
      const started = fresh || o.page.isStreaming();
      if (!started && now() - sentAt > opt.replyStartTimeoutMs) return stop('No reply appeared after sending. Check the chat, then resume or restart the chain.');
      if (now() - sentAt > opt.replyTimeoutMs) return stop('The reply took too long to finish.');
      if (fresh && !o.page.isStreaming()) {
        quietSince ??= now();
        if (now() - quietSince >= opt.settleMs) return true;
      } else {
        quietSince = null;
      }
      await wait(opt.pollMs);
    }
    return false;
  }

  /** @param {number} seconds */
  async function countdown(seconds) {
    let end = now() + seconds * 1000;
    set({ status: 'countdown', countdown: seconds });
    while (!cancelled) {
      if (skipRequested) break; // the step itself is skipped by the main loop

      const pausedAt = now();
      if (!(await holdWhilePaused())) return false;
      end += now() - pausedAt; // a pause freezes the countdown
      const left = Math.max(0, Math.ceil((end - now()) / 1000));
      if (left !== state.countdown) set({ countdown: left });
      if (left <= 0) break;
      await wait(Math.min(opt.pollMs, 1000));
    }
    set({ countdown: 0 });
    return !cancelled;
  }

  /** Run the steps, then settle the final status in one place (whichever way the loop ended). */
  async function run() {
    await runSteps();
    if (cancelled && state.status !== 'stopped') set({ status: 'cancelled', countdown: 0 });
  }

  async function runSteps() {
    if (!o.steps.length) return stop('This chain has no steps.');
    for (let i = 0; i < o.steps.length; i++) {
      if (cancelled) break;
      set({ step: i });
      const step = o.steps[i];
      // Steps after the first wait for the previous reply (done below) and, for timer steps, a delay.
      if (i > 0 && step.waitFor === 'timer' && step.delaySeconds > 0) {
        if (!(await countdown(step.delaySeconds))) break;
      }
      if (!(await holdWhilePaused())) break;
      if (skipRequested) {
        skipRequested = false;
        set({ skipped: [...state.skipped, i] });
        continue;
      }
      const p = problem();
      if (p) return stop(p);
      if (!o.page.hasComposer()) return stop("ReSync can't find the message box, so the chain stopped.");
      if (o.page.isStreaming()) {
        // Something else is still replying: wait for it before sending (never overlap replies).
        if (!(await waitForReply(replyMarker(), { alreadyStarted: true }))) return;
      }
      set({ status: 'sending' });
      const before = replyMarker();
      const text = o.compose ? o.compose(step, { index: i, previousOutput }) : step.text;
      if (!o.page.send(text)) return stop('Could not send the message (the send button or message box is not available).');
      set({ sent: [...state.sent, i] });
      if (!(await waitForReply(before))) return;
      previousOutput = o.page.lastReplyText?.() ?? '';
    }
    if (!cancelled) set({ status: 'done', step: o.steps.length, countdown: 0 });
  }

  return {
    /** Start the chain; resolves with the final state. */
    async start() {
      if (state.status !== 'idle') throw new Error('This chain has already started.');
      await run();
      return { ...state };
    },
    /** Hold before the next send (the current reply, if any, finishes normally). */
    pause() {
      paused = true;
      if (state.status === 'countdown' || state.status === 'waiting-reply') emit();
    },
    resume() {
      paused = false;
    },
    /** Skip the next step that has not been sent yet (ends a running countdown early). */
    skip() {
      skipRequested = true;
    },
    cancel() {
      cancelled = true;
      paused = false;
    },
    get state() {
      return { ...state };
    },
    get paused() {
      return paused;
    },
  };
}
