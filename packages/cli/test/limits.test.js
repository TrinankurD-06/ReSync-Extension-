import { describe, it, expect } from 'vitest';
import { compilePatterns, detectLimit, parseResetTime, nextBackoffMinutes, scheduleRetry } from '../src/queue/limits.js';
import { DEFAULT_LIMIT_PATTERNS } from '../src/config.js';

const { patterns } = compilePatterns(DEFAULT_LIMIT_PATTERNS);
// Fri 17 Oct 2026, 14:00 local
const NOW = new Date(2026, 9, 17, 14, 0, 0);

describe('limit detection (patterns from config)', () => {
  it.each([
    "You've hit your session limit · resets 3:45pm",
    "You've hit your weekly limit · resets Mon 12:00am",
    "You've hit your Opus limit · resets 3:45pm",
    'You’ve hit your Sonnet limit · resets 3:45pm',
    'Claude AI usage limit reached|1760720400',
    'Request rejected (429)',
    'Server is temporarily limiting requests',
    'Credit balance is too low',
    "You've hit your monthly spend limit",
    'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
  ])('detects: %s', (s) => {
    expect(detectLimit(`some output\n${s}\nmore`, patterns)).toMatchObject({ limited: true, line: s });
  });

  it.each(['All tests passed', 'Error: Cannot find module x', 'TypeError: undefined is not a function'])('ignores: %s', (s) => {
    expect(detectLimit(s, patterns).limited).toBe(false);
  });

  it('reports invalid user patterns instead of crashing', () => {
    expect(compilePatterns(['ok', '([bad']).invalid).toEqual(['([bad']);
  });
});

describe('reset time parsing', () => {
  const at = (s) => parseResetTime(s, NOW);
  it('reads "resets 3:45pm" as today when still ahead', () => {
    expect(at("You've hit your session limit · resets 3:45pm")).toEqual(new Date(2026, 9, 17, 15, 45));
  });
  it('rolls a past time over to tomorrow', () => {
    expect(at('resets 9am')).toEqual(new Date(2026, 9, 18, 9, 0));
  });
  it('reads weekday forms like "resets Mon 12:00am"', () => {
    expect(at("You've hit your weekly limit · resets Mon 12:00am")).toEqual(new Date(2026, 9, 19, 0, 0));
  });
  it('reads 24h, relative, month-day, ISO and epoch forms', () => {
    expect(at('limit resets at 15:30')).toEqual(new Date(2026, 9, 17, 15, 30));
    expect(at('resets in 2 hours')).toEqual(new Date(NOW.getTime() + 2 * 3600_000));
    expect(at('try again in 45 minutes')).toEqual(new Date(NOW.getTime() + 45 * 60_000));
    expect(at('resets in 1h 30m')).toEqual(new Date(NOW.getTime() + 90 * 60_000));
    expect(at('resets Oct 18, 9am')).toEqual(new Date(2026, 9, 18, 9, 0));
    expect(at('resets at 2026-10-17T20:00:00Z')).toEqual(new Date('2026-10-17T20:00:00Z'));
    const epoch = Math.floor(new Date(2026, 9, 17, 18, 0).getTime() / 1000);
    expect(at(`{"resets_at": ${epoch}}`)).toEqual(new Date(epoch * 1000));
  });
  it('returns null when there is no usable time', () => {
    expect(at('You have hit a limit')).toBeNull();
    expect(at('resets 3')).toBeNull();
    expect(at('resets 25:00')).toBeNull();
  });
});

describe('backoff', () => {
  const cfg = { initialMinutes: 15, maxMinutes: 120 };
  it('starts at 15 min, doubles, caps at 2 h', () => {
    const seq = [];
    let m;
    for (let i = 0; i < 6; i++) seq.push((m = nextBackoffMinutes(m, cfg)));
    expect(seq).toEqual([15, 30, 60, 120, 120, 120]);
  });
  it('prefers a parsed reset time (plus a minute) over backoff', () => {
    const r = scheduleRetry('resets 3:45pm', {}, cfg, NOW);
    expect(r.notBefore).toEqual(new Date(2026, 9, 17, 15, 46));
    expect(r.backoffMinutes).toBeUndefined();
    const b = scheduleRetry('usage limit reached', { backoffMinutes: 30 }, cfg, NOW);
    expect(b.backoffMinutes).toBe(60);
    expect(b.notBefore).toEqual(new Date(NOW.getTime() + 60 * 60_000));
  });
});
