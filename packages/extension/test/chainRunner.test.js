import { describe, it, expect } from 'vitest';
import { createChainRunner } from '../src/lib/chainRunner.js';

/**
 * Simulated claude.ai: after each send, a reply starts after `delay` ms and streams for `stream` ms.
 * Time is virtual: it only moves when the runner waits.
 */
function simulator({ delay = 1000, stream = 4000 } = {}) {
  const sim = {
    t: 0,
    sends: [], // { text, at }
    replies: [], // { start, end }
    composer: true,
    alert: null,
    hooks: [], // { at, fn } run once when time passes `at`
    page: {
      hasComposer: () => sim.composer,
      isStreaming: () => sim.replies.some((r) => sim.t >= r.start && sim.t < r.end),
      replyCount: () => sim.replies.filter((r) => sim.t >= r.start).length,
      findAlert: () => sim.alert,
      send: (text) => {
        sim.sends.push({ text, at: sim.t });
        sim.replies.push({ start: sim.t + delay, end: sim.t + delay + stream });
        return true;
      },
    },
    async wait(ms) {
      sim.t += ms;
      for (const h of sim.hooks.filter((x) => !x.done && sim.t >= x.at)) {
        h.done = true;
        h.fn();
      }
    },
    now: () => sim.t,
  };
  return sim;
}

const STEPS = [
  { text: 'step one', waitFor: 'response', delaySeconds: 0 },
  { text: 'step two', waitFor: 'timer', delaySeconds: 20 },
  { text: 'step three', waitFor: 'response', delaySeconds: 0 },
];

function run(sim, steps = STEPS, extra = {}) {
  const states = [];
  const runner = createChainRunner({ page: sim.page, steps, wait: (ms) => sim.wait(ms), now: sim.now, onState: (s) => states.push(s), ...extra });
  return { runner, states };
}

describe('chain runner', () => {
  it('runs a 3-step chain with a timer, each step only after the previous reply finished', async () => {
    const sim = simulator();
    const { runner, states } = run(sim);
    const final = await runner.start();
    expect(final.status).toBe('done');
    expect(sim.sends.map((s) => s.text)).toEqual(['step one', 'step two', 'step three']);
    // Reply 1 ends at 5000 ms; +1.5 s settle; +20 s timer -> step two no earlier than 26.5 s.
    expect(sim.sends[1].at).toBeGreaterThanOrEqual(5000 + 1500 + 20000);
    // Never faster than one message per completed response.
    for (let i = 1; i < sim.sends.length; i++) expect(sim.sends[i].at).toBeGreaterThanOrEqual(sim.replies[i - 1].end);
    // Progress included a countdown from 20.
    const counts = states.filter((s) => s.status === 'countdown').map((s) => s.countdown);
    expect(counts[0]).toBe(20);
    expect(counts.at(-1)).toBeLessThanOrEqual(1);
  });

  it('pauses (holding the next send) and resumes', async () => {
    const sim = simulator();
    const { runner, states } = run(sim);
    sim.hooks.push({ at: 2000, fn: () => runner.pause() });
    sim.hooks.push({ at: 60_000, fn: () => runner.resume() });
    const final = await runner.start();
    expect(final.status).toBe('done');
    expect(states.some((s) => s.status === 'paused')).toBe(true);
    expect(sim.sends[1].at).toBeGreaterThanOrEqual(60_000); // nothing was sent while paused
  });

  it('freezes the countdown while paused', async () => {
    const sim = simulator();
    const { runner } = run(sim);
    // Reply 1 ends at 5 s, settles by ~6.5 s, so the 20 s countdown runs ~6.5 s to ~26.5 s. Pause 10 s inside it.
    sim.hooks.push({ at: 10_000, fn: () => runner.pause() });
    sim.hooks.push({ at: 20_000, fn: () => runner.resume() });
    await runner.start();
    expect(sim.sends[1].at).toBeGreaterThanOrEqual(26_500 + 10_000 - 500);
  });

  it('skips the next step and cancels cleanly', async () => {
    const sim = simulator();
    const { runner } = run(sim);
    sim.hooks.push({ at: 8000, fn: () => runner.skip() }); // during the countdown before step two
    const final = await runner.start();
    expect(sim.sends.map((s) => s.text)).toEqual(['step one', 'step three']);
    expect(final.skipped).toEqual([1]);

    const sim2 = simulator();
    const r2 = run(sim2);
    sim2.hooks.push({ at: 3000, fn: () => r2.runner.cancel() });
    expect((await r2.runner.start()).status).toBe('cancelled');
    expect(sim2.sends).toHaveLength(1);
  });

  it('stops automatically on a usage-limit notice', async () => {
    const sim = simulator();
    const { runner } = run(sim);
    sim.hooks.push({ at: 3000, fn: () => (sim.alert = { kind: 'limit', text: "You've hit your session limit" }) });
    const final = await runner.start();
    expect(final.status).toBe('stopped');
    expect(final.reason).toMatch(/Usage limit/);
    expect(sim.sends).toHaveLength(1);
  });

  it('stops on an error notice and when the message box disappears', async () => {
    const sim = simulator();
    const { runner } = run(sim);
    sim.hooks.push({ at: 3000, fn: () => (sim.alert = { kind: 'error', text: 'Something went wrong' }) });
    expect((await runner.start()).reason).toMatch(/error/);

    const sim2 = simulator();
    const r2 = run(sim2);
    sim2.hooks.push({ at: 3000, fn: () => (sim2.composer = false) });
    const f2 = await r2.runner.start();
    expect(f2.status).toBe('stopped');
    expect(f2.reason).toMatch(/message box/);
  });

  it('stops if no reply ever appears, and waits for a reply already streaming before the first send', async () => {
    const sim = simulator();
    sim.page.send = (text) => (sim.sends.push({ text, at: sim.t }), true); // reply never comes
    const { runner } = run(sim, STEPS, { options: { replyStartTimeoutMs: 10_000 } });
    const f = await runner.start();
    expect(f.reason).toMatch(/No reply appeared/);

    const sim2 = simulator();
    sim2.replies.push({ start: 0, end: 7000 }); // claude.ai is still answering something
    const r2 = run(sim2, [STEPS[0]]);
    await r2.runner.start();
    expect(sim2.sends[0].at).toBeGreaterThanOrEqual(7000);
  });
});
