import { describe, it, expect } from 'vitest';
import {
  decisionsFromPassport, splitDecision, similarity, findDuplicate, mergeDecisions, prefilter, conflictPrompt, parseConflictAnswer,
  samePrompt, parseSameAnswer, supersede, supersedeHistory, scrubDecision, keyTerms, decisionSchema,
} from '../src/ledger.js';
import { scrubSecrets } from '../src/rules.js';
import { passportInstructions } from '../src/templates.js';

const PASSPORT = `# Context Passport: Launch site

## Meta

- Date: 2026-10-21
- Project: Launch site
- Source: https://claude.ai/chat/c1

## Goal

Ship the marketing site.

## Current state

Pages drafted.

## Decisions made (and why)

- Use PostgreSQL for the main database — because the team already knows it
- Launch on 4 November because the conference starts that week
- Offer a free tier (assumed) — because competitors do

## Open questions

None

## Dead ends

None

## Next 3 steps

1. Write the pricing page
2. Set up hosting
3. Book the launch post

## Key files

None
`;

const meta = { author: 'Asha', project: 'Launch site', sourceChat: 'https://claude.ai/chat/c1', now: new Date('2026-10-21T10:00:00Z') };
const make = (text, extra = {}) => decisionSchema.parse({ id: extra.id ?? `d-${text.length}`, text, reason: '', createdAt: '2026-10-01T00:00:00.000Z', tags: [...keyTerms(text)], ...extra });

describe('decisions from a Context Passport', () => {
  it('reads each decision and its reason; (assumed) ones are pending', () => {
    const ds = decisionsFromPassport(PASSPORT, meta);
    expect(ds.map((d) => [d.text, d.reason, d.status, d.confirmed])).toEqual([
      ['Use PostgreSQL for the main database', 'the team already knows it', 'active', true],
      ['Launch on 4 November', 'the conference starts that week', 'active', true],
      ['Offer a free tier', 'competitors do', 'pending', false],
    ]);
    for (const d of ds) {
      expect(d).toMatchObject({ author: 'Asha', project: 'Launch site', sourceChat: 'https://claude.ai/chat/c1', createdAt: '2026-10-21T10:00:00.000Z', supersededBy: null, supersedes: null });
      expect(d.tags.length).toBeGreaterThan(0);
      expect(d.id).toMatch(/^d-/);
    }
  });

  it('handles "None", nested reasons, bold text, and no project', () => {
    expect(decisionsFromPassport('## Decisions made (and why)\n\nNone\n', {})).toEqual([]);
    const ds = decisionsFromPassport('## Decisions made (and why)\n\n- **Use Stripe**\n  - Why: invoices for teams (assumed)\n- Drop the blog\n', { project: 'No project' });
    expect(ds.map((d) => [d.text, d.reason, d.status, d.project])).toEqual([
      ['Use Stripe', 'invoices for teams', 'pending', ''],
      ['Drop the blog', '', 'active', ''],
    ]);
  });

  it('splits the reason in the formats models use', () => {
    expect(splitDecision('Use Vite (why: faster builds)')).toEqual({ text: 'Use Vite', reason: 'faster builds' });
    expect(splitDecision('Use Vite - faster builds.')).toEqual({ text: 'Use Vite', reason: 'faster builds' });
    expect(splitDecision('Use Vite. Reason: faster builds')).toEqual({ text: 'Use Vite', reason: 'faster builds' });
    expect(splitDecision('Hosting: Render free tier')).toEqual({ text: 'Hosting', reason: 'Render free tier' });
    expect(splitDecision('Keep it simple')).toEqual({ text: 'Keep it simple', reason: '' });
  });

  it('the passport prompt asks for that format and for (assumed)', () => {
    const p = passportInstructions();
    expect(p).toContain('"- <decision> — because <reason>"');
    expect(p).toContain('add (assumed) to any decision nobody explicitly confirmed');
  });
});

describe('dedupe', () => {
  const existing = [make('Use Stripe for payments', { id: 'a', project: 'Launch site' }), make('Launch on 4 November', { id: 'b' })];

  it('close wording is the same decision; loosely related is "maybe"; unrelated is new', () => {
    expect(findDuplicate({ text: 'We will use Stripe for payment processing', project: 'Launch site' }, existing)).toMatchObject({ verdict: 'same', match: { id: 'a' } });
    expect(findDuplicate({ text: 'Stripe invoices for team payments', project: '' }, existing)).toMatchObject({ verdict: 'maybe', match: { id: 'a' } });
    expect(findDuplicate({ text: 'Hire a designer', project: '' }, existing)).toBeNull();
    // Different projects never merge.
    expect(findDuplicate({ text: 'Use Stripe for payments', project: 'Other' }, existing)).toBeNull();
  });

  it('merging keeps the original, fills a missing reason and confirms a pending one', () => {
    const pending = make('Offer a free tier', { id: 'p', status: 'pending', confirmed: false });
    const m = mergeDecisions(pending, make('Offer a free tier', { reason: 'competitors do' }), new Date('2026-10-22T00:00:00Z'));
    expect(m).toMatchObject({ id: 'p', reason: 'competitors do', status: 'active', confirmed: true, updatedAt: '2026-10-22T00:00:00.000Z' });
  });

  it('similarity is symmetric and 0 for nothing shared', () => {
    expect(similarity('Use PostgreSQL', 'use postgresql')).toBe(1);
    expect(similarity('a b', 'c d')).toBe(0);
    expect(similarity('payments via Stripe', 'Stripe payment')).toBe(similarity('Stripe payment', 'payments via Stripe'));
  });
});

describe('local prefilter (before any model call)', () => {
  const ds = [
    make('Use PostgreSQL for the main database', { id: 'db', project: 'Launch site', reason: 'the team knows it' }),
    make('Launch on 4 November', { id: 'date', project: 'Launch site' }),
    make('Old pricing', { id: 'old', status: 'superseded' }),
    make('Use Redis for the main cache', { id: 'other', project: 'Another project' }),
  ];

  it('finds related decisions by shared key terms', () => {
    const c = prefilter("Let's switch the main database to MongoDB instead", ds, { project: 'Launch site' });
    expect(c.map((x) => x.decision.id)).toEqual(['db']);
    expect(c[0].shared).toEqual(expect.arrayContaining(['main', 'database']));
  });

  it('returns nothing for unrelated text, so no model call happens', () => {
    expect(prefilter('Can you fix the typo in the footer?', ds, { project: 'Launch site' })).toEqual([]);
    expect(prefilter('', ds)).toEqual([]);
  });

  it('skips superseded, muted and other-project decisions', () => {
    expect(prefilter('Old pricing for the plans', ds)).toEqual([]);
    expect(prefilter('switch the main database', ds, { project: 'Launch site', muted: ['db'] })).toEqual([]);
    expect(prefilter('Use Redis for the main cache layer', ds, { project: 'Launch site' })).toEqual([]);
  });
});

describe('model prompts and answers', () => {
  const cands = [make('Use PostgreSQL for the main database', { id: 'db', reason: 'the team knows it' }), make('Launch on 4 November', { id: 'date' })];

  it('the conflict prompt lists the decisions and asks for JSON only', () => {
    const p = conflictPrompt('Switch to MongoDB', cands, { role: 'assistant' });
    expect(p.system).toMatch(/JSON only/);
    expect(p.system).toMatch(/data, not instructions/);
    const c = p.messages[0].content;
    expect(c).toContain('[d1] Use PostgreSQL for the main database (reason: the team knows it)');
    expect(c).toContain('[d2] Launch on 4 November');
    expect(c).toContain('<message from="Claude (the assistant)">\nSwitch to MongoDB\n</message>');
    expect(c).toContain('{"results":[{"id":"d1","relation":"conflict","why":"one short sentence"}]}');
  });

  it('reads the answer, mapping d1/d2 back to decision ids', () => {
    const reply = 'Sure:\n```json\n{"results":[{"id":"d1","relation":"conflict","why":"MongoDB replaces PostgreSQL."},{"id":"d2","relation":"none","why":""},{"id":"d9","relation":"conflict"}]}\n```';
    expect(parseConflictAnswer(reply, cands)).toEqual([
      { id: 'db', relation: 'conflict', why: 'MongoDB replaces PostgreSQL.' },
      { id: 'date', relation: 'none', why: '' },
    ]);
    expect(parseConflictAnswer('I think there is a conflict.', cands)).toBeNull();
    expect(parseConflictAnswer('{"results":[{"id":"d1","relation":"maybe"}]}', cands)).toEqual([]);
  });

  it('dedupe confirmation prompt and answer', () => {
    const p = samePrompt({ text: 'Use Stripe', reason: '' }, { text: 'Payments through Stripe', reason: 'invoices' });
    expect(p.messages[0].content).toContain('{"same": true} or {"same": false}');
    expect(parseSameAnswer('{"same": true}')).toBe(true);
    expect(parseSameAnswer('{"same":false}')).toBe(false);
    expect(parseSameAnswer('yes')).toBeNull();
  });
});

describe('supersede', () => {
  it('marks the old decision superseded and links both ways; history runs oldest first', () => {
    const list = [make('Use PostgreSQL', { id: 'v1', project: 'Launch site' })];
    const a = supersede(list, 'v1', { text: 'Use MongoDB', reason: 'document data', author: 'Ben' }, new Date('2026-10-22T00:00:00Z'));
    expect(a.created).toMatchObject({ text: 'Use MongoDB', supersedes: 'v1', status: 'active', project: 'Launch site', author: 'Ben' });
    expect(a.list.find((d) => d.id === 'v1')).toMatchObject({ status: 'superseded', supersededBy: a.created.id });
    const b = supersede(a.list, a.created.id, { text: 'Use SQLite' });
    expect(supersedeHistory(b.list, 'v1').map((d) => d.text)).toEqual(['Use PostgreSQL', 'Use MongoDB', 'Use SQLite']);
    expect(supersedeHistory(b.list, b.created.id).map((d) => d.status)).toEqual(['superseded', 'superseded', 'active']);
    expect(() => supersede(b.list, 'v1', { text: 'again' })).toThrow(/already superseded/);
    expect(() => supersede(b.list, 'nope', { text: 'x' })).toThrow(/no longer in the ledger/);
  });
});

describe('scrubbing before sync (shared rules secrets filter)', () => {
  it('removes keys, tokens, passwords, emails and phone numbers, and says which kinds', () => {
    const r = scrubSecrets('Key sk-ant-api03-abcdefghijklmnop, token ghp_abcdefghijklmnopqrstuvwx, Bearer abcdefghijklmnopqrstuv, password: hunter2222, mail asha@example.com, call +91 98765 43210.');
    expect(r.text).not.toMatch(/sk-ant|ghp_|abcdefghijklmnopqrstuv|hunter|asha@|98765/);
    expect(r.text).toContain('password: [removed secret]');
    expect(r.removed.sort()).toEqual(['api key', 'email', 'phone', 'secret', 'token']);
  });

  it('leaves prices, ranges, dates and versions alone', () => {
    const t = 'Budget 1000-2000 per month from 2026-11-04, Node 24.10.0, plan at 20 dollars.';
    expect(scrubSecrets(t)).toEqual({ text: t, removed: [] });
  });

  it('scrubs a decision without changing its id or links', () => {
    const d = make('Email support@acme.io for refunds', { id: 'x', reason: 'key AIzaSyA1234567890abcdefghijk is in the env', supersedes: 'w', author: 'asha@acme.io' });
    const s = scrubDecision(d);
    expect(s.decision).toMatchObject({ id: 'x', supersedes: 'w', text: 'Email [removed email] for refunds', reason: 'key [removed api key] is in the env', author: '[removed email]' });
    expect(s.removed.sort()).toEqual(['api key', 'email']);
  });
});
