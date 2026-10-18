import { describe, it, expect } from 'vitest';
import { estimateTokens, estimateMessagesTokens, formatTokenEstimate } from '../src/tokens.js';
import { validateTopicTree, normaliseTopicTree, treeToMermaid, countTopics } from '../src/tree.js';
import { validateUsageRecord, aggregateUsage, lastNDays, localDate, recordTokens } from '../src/usage.js';
import {
  PASSPORT_SECTIONS, parsePassport, renderPassport, extractJson, parseTreeResponse, parseSummary,
  formatTranscript, buildApiRequest, inChatPrompt,
} from '../src/templates.js';

describe('token estimator', () => {
  it('estimates about 4 chars per token and labels output as an estimate', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abcd'.repeat(25))).toBe(25);
    expect(estimateMessagesTokens([{ role: 'user', content: 'abcd' }])).toBe(5);
    expect(formatTokenEstimate(1234)).toBe('~1.2k tokens (estimate)');
    expect(formatTokenEstimate(12)).toBe('~12 tokens (estimate)');
  });
  it('is language-aware: ~4 chars/token for English prose, ~3 for code and JSON, ~2 for non-Latin scripts', () => {
    expect(estimateTokens('a'.repeat(120))).toBe(30); // prose: 120 / 4
    expect(estimateTokens('```\n' + 'x'.repeat(112) + '\n```')).toBe(40); // fenced code: 120 chars / 3
    expect(estimateTokens('{"name": "resync", "id": 12}')).toBe(9); // JSON line: 27 / 3
    expect(estimateTokens('日本語のテキスト')).toBe(4); // 8 non-Latin chars / 2
    expect(estimateTokens('Привет мир')).toBe(5); // 9 Cyrillic letters / 2 + 1 space / 4 -> ceil(4.75)
    expect(estimateTokens('## Heading\n- a bullet point here')).toBe(Math.ceil(32 / 4)); // Markdown still prose
  });
});

const TREE = {
  topic: 'Build ReSync',
  turnRange: [1, 20],
  children: [
    { topic: 'Spec (v3)', turnRange: [1, 4], children: [] },
    { topic: 'Provider layer', turnRange: [5, 20], children: [{ topic: 'Errors', turnRange: [9, 12], children: [] }] },
  ],
};

describe('topic tree', () => {
  it('validates a good tree and rejects bad ones', () => {
    expect(validateTopicTree(TREE).ok).toBe(true);
    expect(validateTopicTree({ ...TREE, turnRange: [5, 1] }).ok).toBe(false);
    expect(validateTopicTree({ topic: '', children: [], turnRange: [0, 0] }).ok).toBe(false);
    expect(validateTopicTree({ topic: 'x', turnRange: [0, 0] }).ok).toBe(false);
  });
  it('normalises loose model output', () => {
    const t = normaliseTopicTree([{ title: 'A', turnRange: [2] }, { topic: 'B', turnRange: { start: 3, end: 5 } }]);
    expect(validateTopicTree(t).ok).toBe(true);
    expect(t).toMatchObject({ topic: 'Conversation', turnRange: [2, 5] });
  });
  it('renders a Mermaid mindmap with unsafe characters removed', () => {
    const m = treeToMermaid(TREE);
    expect(m.split('\n')[0]).toBe('mindmap');
    expect(m).toContain('  root((Build ReSync))');
    expect(m).toContain('    Spec v3');
    expect(m).toContain('      Errors');
    expect(treeToMermaid(TREE, { showTurns: true })).toContain('Errors - turns 9 to 12');
    expect(countTopics(TREE)).toBe(4);
  });
});

describe('usage records', () => {
  const base = { user: 'u1', project: 'resync', sessionId: 's1', date: '2026-10-17', source: 'plugin' };
  it('accepts numbers and rejects content fields', () => {
    expect(validateUsageRecord({ ...base, inputTokens: 10, costUsd: 0.1 }).ok).toBe(true);
    expect(validateUsageRecord({ ...base, prompt: 'secret text' }).ok).toBe(false);
    expect(validateUsageRecord({ ...base, date: '17/10/2026' }).ok).toBe(false);
    expect(validateUsageRecord({ ...base, inputTokens: -1 }).ok).toBe(false);
  });
  it('aggregates per key and fills the last N days', () => {
    const recs = [
      { ...base, inputTokens: 100, outputTokens: 50, costUsd: 0.5 },
      { ...base, sessionId: 's2', estimatedTokens: 30, messages: 2 },
      { ...base, date: '2026-10-15', project: 'other', inputTokens: 5 },
    ];
    expect(recordTokens(recs[1])).toBe(30);
    const byDay = aggregateUsage(recs, (r) => r.date);
    expect(byDay[0]).toEqual({ key: '2026-10-17', sessions: 2, tokens: 180, costUsd: 0.5, messages: 2 });
    const week = lastNDays(recs, 7, new Date(2026, 9, 17));
    expect(week).toHaveLength(7);
    expect(week[6]).toMatchObject({ date: '2026-10-17', tokens: 180 });
    expect(week[4]).toMatchObject({ date: '2026-10-15', tokens: 5 });
    expect(week[0].tokens).toBe(0);
    expect(localDate(new Date(2026, 0, 5))).toBe('2026-01-05');
  });
});

describe('passport', () => {
  it('parses all sections, tolerant of heading style', () => {
    const md = PASSPORT_SECTIONS.map((s, i) => `${i % 2 ? '###' : '##'} ${s}\ncontent ${i}`).join('\n\n');
    const p = parsePassport('Sure, here it is:\n\n' + md);
    expect(p.ok).toBe(true);
    expect(p.sections['Dead ends']).toBe('content 4');
  });
  it('accepts bold, colon and numbered heading variants that small models produce', () => {
    const md = [
      '**Goal**', 'g', '**Current state:**', 'c', 'Decisions made (and why):', 'd',
      '### 4) Open questions', 'o', '**Dead ends**:', 'x', '#### Next 3 steps', 'n', 'Key files:', 'k',
    ].join('\n');
    const p = parsePassport(md);
    expect(p.missing).toEqual([]);
    expect(p.sections['Decisions made (and why)']).toBe('d');
    // An ordinary sentence ending in a colon is not a heading.
    expect(parsePassport('## Goal\nHere is the plan:\nstep').sections.Goal).toBe('Here is the plan:\nstep');
  });

  it('reports missing sections', () => {
    expect(parsePassport('## Goal\nx').missing).toContain('Key files');
  });
  it('renders a file with every section, None for empty ones', () => {
    const out = renderPassport({ Goal: 'Ship' }, { title: 'T', createdAt: new Date('2026-10-17T00:00:00Z'), project: 'resync' });
    expect(out).toContain('# Context Passport: T');
    expect(out).toContain('## Goal\n\nShip');
    expect(out).toContain('## Key files\n\nNone');
    expect(parsePassport(out).ok).toBe(true);
  });
});

describe('JSON extraction and tree replies', () => {
  it('reads fenced JSON, bare JSON and nested strings with brackets', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('Here: {"a":"x}y","b":[1,2]} done')).toEqual({ a: 'x}y', b: [1, 2] });
    expect(() => extractJson('no json')).toThrow(/No JSON/);
  });
  it('parses a tree reply into a validated tree', () => {
    const r = parseTreeResponse('Tree:\n```json\n' + JSON.stringify(TREE) + '\n```');
    expect(r.ok).toBe(true);
    expect(parseTreeResponse('nothing').ok).toBe(false);
  });
});

describe('summary', () => {
  it('strips bullets and enforces 5 to 10 lines', () => {
    const r = parseSummary(Array.from({ length: 12 }, (_, i) => `- point ${i}`).join('\n'));
    expect(r.lines).toHaveLength(10);
    expect(r.lines[0]).toBe('point 0');
    expect(parseSummary('a\nb').warning).toMatch(/expected 5 to 10/);
  });
});

describe('transcript and requests', () => {
  const msgs = Array.from({ length: 10 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: 'x'.repeat(400) }));
  it('numbers turns and keeps the latest when over budget', () => {
    const full = formatTranscript(msgs);
    expect(full.truncated).toBe(false);
    expect(full.text).toContain('### Turn 10 (Assistant)');
    const cut = formatTranscript(msgs, { maxTokens: 250 });
    expect(cut.truncated).toBe(true);
    expect(cut.text).toContain('Turn 10');
    expect(cut.text).not.toContain('Turn 1 (');
  });
  it('builds API requests and in-chat prompts per feature', () => {
    const req = buildApiRequest('passport', msgs);
    expect(req.messages[0].content).toContain('<transcript>');
    expect(req.messages[0].content).toContain('## Next 3 steps');
    expect(inChatPrompt('tree')).toContain('turnRange');
    expect(inChatPrompt('summary')).toContain('5 to 10 lines');
  });
});
