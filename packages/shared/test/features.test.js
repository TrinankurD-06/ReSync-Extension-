// Shared rules, chains (intake, chainContext, field check, success criteria), passport Meta, topic-tree repair and
// summary audiences.
import { describe, it, expect } from 'vitest';
import { SHARED_RULES, sharedRulesText, withSharedRules, hasSharedRules } from '../src/rules.js';
import {
  passportInstructions, treeInstructions, summaryInstructions, inChatPrompt, buildApiRequest, passportRepairPrompt,
  parsePassport, renderPassport, passportLengthWarnings, parseTreeResponse, parseSummary, SUMMARY_AUDIENCES, PASSPORT_HEADINGS,
} from '../src/templates.js';
import {
  planIntake, applyIntakeAnswers, mergeChainContext, emptyChainContext, composeChainStep, chainSteps, applyFieldChecks,
  successCriteriaDefault, isPlanningChain, chainContextBlock, parseTeamMembers, MAX_INTAKE_QUESTIONS,
} from '../src/chains.js';
import { repairTopicTree, topicTargets, validateTopicTree } from '../src/tree.js';
import { parsePrompt, validatePrompt } from '../src/prompts.js';
import { readFileSync } from 'node:fs';

const LAUNCH = parsePrompt(readFileSync(new URL('../../../prompts/startup/launch-chain.md', import.meta.url), 'utf8'), { path: 'prompts/startup/launch-chain.md' });
const FEATURE = parsePrompt(readFileSync(new URL('../../../prompts/dev/feature-chain.md', import.meta.url), 'utf8'), { path: 'prompts/dev/feature-chain.md' });
const MSGS = [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }];

describe('shared rules module', () => {
  it('has the four rules, once, in one block', () => {
    expect(SHARED_RULES).toHaveLength(4);
    expect(sharedRulesText()).toContain("Never invent file paths, names, numbers or commands. Write 'unknown' instead.");
    expect(withSharedRules(withSharedRules('x'))).toBe(withSharedRules('x'));
  });

  it('is appended to every built-in prompt, in both modes, and to every chain step', () => {
    const ctx = mergeChainContext({ inputs: { product: 'ReSync' } });
    const prompts = [
      passportInstructions(), treeInstructions({ turns: 4 }), passportRepairPrompt(['Goal']),
      ...Object.keys(SUMMARY_AUDIENCES).map((a) => summaryInstructions({ audience: /** @type {any} */ (a) })),
      ...['passport', 'tree', 'summary'].map((f) => inChatPrompt(/** @type {any} */ (f))),
      ...['passport', 'tree', 'summary'].map((f) => buildApiRequest(/** @type {any} */ (f), MSGS).messages[0].content),
      ...chainSteps(LAUNCH, { context: ctx, successCriteria: true }).map((s, i) => composeChainStep(s, { context: ctx, index: i, previousOutput: 'prev' })),
    ];
    for (const p of prompts) {
      expect(hasSharedRules(p)).toBe(true);
      // The rules live only in rules.js: each prompt carries them exactly once.
      expect(p.split(SHARED_RULES[0]).length - 1).toBe(1);
    }
  });
});

describe('chain intake', () => {
  it('asks at most 3 questions, only for missing facts, in this chain\'s order', () => {
    const one = planIntake(LAUNCH, mergeChainContext({ inputs: { product: 'Claude extension named ReSync' } }), { successCriteria: true });
    expect(one.questions.map((q) => q.key)).toEqual(['coreFeature', 'targetUser', 'differentiator']);
    expect(one.questions.length).toBeLessThanOrEqual(MAX_INTAKE_QUESTIONS);
    // The owner column needs team names and the success step needs a metric: missing, but not asked this time.
    expect(one.missing).toEqual(['coreFeature', 'targetUser', 'differentiator', 'teamMembers', 'successMetric']);

    const known = mergeChainContext({ coreFeature: 'Saved prompts', targetUser: 'Claude power users' });
    const two = planIntake(LAUNCH, known, { successCriteria: true });
    expect(two.questions.map((q) => q.key)).toEqual(['differentiator', 'teamMembers', 'successMetric']);

    const all = mergeChainContext(known, { differentiator: 'x', teamMembers: [{ name: 'Asha', role: 'founder' }], successMetric: '200 installs' });
    expect(planIntake(LAUNCH, all, { successCriteria: true }).questions).toEqual([]);
  });

  it('only asks for the success metric when the success step is on, and follows a chain\'s own intake list', () => {
    const ctx = mergeChainContext({ coreFeature: 'a', targetUser: 'b', differentiator: 'c', teamMembers: [{ name: 'Asha', role: '' }] });
    expect(planIntake(LAUNCH, ctx, { successCriteria: false }).questions).toEqual([]);
    expect(planIntake(LAUNCH, ctx, { successCriteria: true }).questions.map((q) => q.key)).toEqual(['successMetric']);
    expect(planIntake(FEATURE, emptyChainContext()).questions).toEqual([]); // intake: [] and no field needs
  });

  it('records skipped questions as assumptions and parses team answers', () => {
    const plan = planIntake(LAUNCH, emptyChainContext(), { successCriteria: true });
    const ctx = applyIntakeAnswers(emptyChainContext(), plan.questions, { coreFeature: 'Saved prompts and chains' });
    expect(ctx.coreFeature).toBe('Saved prompts and chains');
    expect(ctx.assumptions).toEqual([
      'Target user was not given: infer it from the product and mark it (assumed).',
      'Key differentiator was not given: infer it from the product and mark it (assumed).',
    ]);
    expect(parseTeamMembers('Asha: founder, Ravi (design); Mei - marketing, Sam')).toEqual([
      { name: 'Asha', role: 'founder' }, { name: 'Ravi', role: 'design' }, { name: 'Mei', role: 'marketing' }, { name: 'Sam', role: '' },
    ]);
  });
});

describe('chainContext in every step', () => {
  const ctx = mergeChainContext({ inputs: { 'One line about the product': 'Claude extension named ReSync' }, budget: '₹0', teamMembers: [{ name: 'Asha', role: 'founder' }], deadline: '2026-11-01', successMetric: '200 installs in week 1', assumptions: ['Target user (assumed): solo developers'] });
  const steps = chainSteps(LAUNCH, { context: ctx, successCriteria: true });

  it('inserts the context into every step and the previous output into every step after the first', () => {
    const sent = steps.map((s, i) => composeChainStep(s, { context: ctx, index: i, previousOutput: i ? `output of step ${i}` : '' }));
    for (const [i, text] of sent.entries()) {
      expect(text).toContain(chainContextBlock(ctx));
      expect(text).toContain('- Budget: ₹0');
      expect(text).toContain('- Team: Asha (founder)');
      expect(text).toContain('- Primary success metric: 200 installs in week 1');
      expect(text).toContain('do not ask me again for anything listed here');
      if (i === 0) expect(text).not.toContain("Previous step's output");
      else expect(text).toContain(`Previous step's output:\n"""\noutput of step ${i}\n"""`);
    }
  });

  it('cuts a very long previous output', () => {
    const t = composeChainStep(steps[1], { context: ctx, index: 1, previousOutput: 'y'.repeat(10_000) });
    expect(t).toContain('[...cut here; the full reply is above in this chat]');
    expect(t.length).toBeLessThan(8000);
  });
});

describe('field check', () => {
  const calendar = LAUNCH.steps[2].text; // "... day, channel, action and owner."

  it('without team names: relabels owner to "owner role" and says not to make names up', () => {
    const r = applyFieldChecks(calendar, mergeChainContext({}));
    expect(r.text).toContain('action and owner role.');
    expect(r.changed).toEqual(['owner']);
    expect(r.notes.join(' ')).toMatch(/never a made-up name/);
  });

  it('with team names: keeps owner and limits owners to the team', () => {
    const r = applyFieldChecks(calendar, mergeChainContext({ teamMembers: parseTeamMembers('Asha: founder, Ravi: design') }));
    expect(r.text).toBe(calendar);
    expect(r.changed).toEqual([]);
    expect(r.notes).toContain('Owners must be people from the team: Asha (founder), Ravi (design).');
  });

  it('drops budget figures when the budget is unknown', () => {
    const r = applyFieldChecks('Estimate the cost of each channel.', emptyChainContext());
    expect(r.changed).toEqual(['budget']);
    expect(r.notes.join(' ')).toMatch(/leave out cost and budget figures/);
  });
});

describe('success-criteria step', () => {
  it('is on by default for planning chains only, and can be turned off per run', () => {
    expect(isPlanningChain(LAUNCH)).toBe(true);
    expect(successCriteriaDefault(LAUNCH)).toBe(true);
    expect(successCriteriaDefault(FEATURE)).toBe(false);
    expect(isPlanningChain({ tags: ['roadmap'] })).toBe(true);
    const ctx = mergeChainContext({ successMetric: '200 installs in week 1' });
    const on = chainSteps(LAUNCH, { context: ctx, successCriteria: true });
    const off = chainSteps(LAUNCH, { context: ctx, successCriteria: false });
    expect(on).toHaveLength(LAUNCH.steps.length + 1);
    expect(off).toHaveLength(LAUNCH.steps.length);
    expect(on.at(-1).text).toContain('Tie each target to the primary success metric: 200 installs in week 1.');
    expect(on.at(-1).text).toContain('add a "Target" column');
  });

  it('chain settings validate in prompt frontmatter', () => {
    expect(validatePrompt(LAUNCH).ok).toBe(true);
    expect(LAUNCH.chain).toEqual({ type: 'planning', successCriteria: true });
    expect(validatePrompt({ ...LAUNCH, chain: { intake: ['nonsense'] } }).ok).toBe(false);
  });
});

describe('Context Passport', () => {
  it('asks for Meta first with the values ReSync read from the page, plus the dead-ends and length rules', () => {
    const t = passportInstructions({ meta: { date: '2026-10-19', project: 'ReSync', source: 'https://claude.ai/chat/abc' } });
    expect(t.indexOf('## Meta')).toBeLessThan(t.indexOf('## Goal'));
    expect(t).toContain('- Date: 2026-10-19\n- Project: ReSync\n- Source: https://claude.ai/chat/abc');
    expect(t).toContain('nothing before the first heading');
    expect(t).toContain('only list approaches actually tried and abandoned; otherwise write None');
    expect(t).toContain('at most 5 bullets per section and under 400 words');
    expect(PASSPORT_HEADINGS[0]).toBe('Meta');
  });

  it('fills Meta from the page, not the model, when saving', () => {
    const reply = '## Meta\n- Date: 2020-01-01\n- Project: guessed\n- Source: unknown\n\n## Goal\nShip';
    const p = parsePassport(reply);
    expect(p.missing).not.toContain('Meta');
    const out = renderPassport(p.sections, { createdAt: new Date(2026, 9, 19), project: 'ReSync', source: 'https://claude.ai/chat/abc', mode: 'in-chat' });
    expect(out).toMatch(/^# Context Passport\n\n## Meta\n\n- Date: 2026-10-19\n- Project: ReSync\n- Source: https:\/\/claude\.ai\/chat\/abc\n- Made with: in-chat\n/);
    expect(out).not.toContain('guessed');
    // When ReSync has no value, the model's line is kept.
    expect(renderPassport(p.sections, { createdAt: new Date(2026, 9, 19) })).toContain('- Project: guessed');
  });

  it('warns when over the length cap (Key files exempt)', () => {
    const bullets = Array.from({ length: 6 }, (_, i) => `- point ${i}`).join('\n');
    expect(passportLengthWarnings({ Goal: bullets })).toEqual(['"Goal" has 6 bullets (max 5)']);
    expect(passportLengthWarnings({ 'Key files': Array.from({ length: 40 }, (_, i) => `- src/f${i}.js: why it matters here`).join('\n') })).toEqual([]);
    expect(passportLengthWarnings({ Goal: 'word '.repeat(400) })[0]).toMatch(/400 words/);
  });
});

describe('topic tree', () => {
  const N = 10;
  const good = { topic: 'Chat', turnRange: [1, 10], children: [
    { topic: 'Setup', turnRange: [1, 4], children: [{ topic: 'Install', turnRange: [1, 2], children: [] }, { topic: 'Config', turnRange: [3, 4], children: [] }] },
    { topic: 'Build', turnRange: [5, 10], children: [] },
  ] };

  it('tells the model the turn count and the range rules', () => {
    const t = treeInstructions({ turns: 12 });
    expect(t).toContain('The conversation has 12 turns.');
    expect(t).toContain('Only split a topic further if its children cover different turns.');
    expect(t).toContain("Children must lie within their parent's turnRange.");
    expect(t).toContain('Top-level ranges must not overlap and must together cover turns 1 to 12.');
    expect(buildApiRequest('tree', MSGS).messages[0].content).toContain('The conversation has 2 turns.');
  });

  it('parses the JSON block from a reply and leaves a valid tree alone', () => {
    const r = parseTreeResponse('Here you go:\n```json\n' + JSON.stringify(good) + '\n```', { turns: N });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.tree).toEqual(good);
      expect(r.warnings).toEqual([]);
    }
  });

  it('clamps ranges, removes overlaps, closes gaps and merges same-turn splits, with warnings', () => {
    const bad = { topic: 'Chat', turnRange: [0, 14], children: [
      { topic: 'Build', turnRange: [5, 14], children: [{ topic: 'Edge', turnRange: [3, 6], children: [] }] },
      { topic: 'Setup', turnRange: [2, 6], children: [] },
      { topic: 'Dup', turnRange: [6, 7], children: [] },
      { topic: 'One reply', turnRange: [8, 8], children: [{ topic: 'a', turnRange: [8, 8], children: [] }, { topic: 'b', turnRange: [8, 8], children: [] }] },
    ] };
    const { tree, warnings } = repairTopicTree(/** @type {any} */ (bad), N);
    expect(validateTopicTree(tree).ok).toBe(true);
    expect(tree.turnRange).toEqual([1, 10]);
    expect(tree.children.map((c) => [c.topic, c.turnRange])).toEqual([['Setup', [1, 6]], ['Build', [7, 10]]]);
    expect(tree.children[1].children[0].turnRange).toEqual([7, 7]); // clamped inside its parent
    expect(warnings.length).toBeGreaterThanOrEqual(5);
    expect(warnings.join('\n')).toMatch(/clamped to 5-10/);
    expect(warnings.join('\n')).toMatch(/"Dup" 6-7 dropped|"Dup" overlapped/);
    // Top-level ranges now cover 1..N without overlap.
    const top = tree.children.map((c) => c.turnRange);
    expect(top[0][0]).toBe(1);
    expect(top.at(-1)[1]).toBe(N);
    for (let i = 1; i < top.length; i++) expect(top[i][0]).toBe(top[i - 1][1] + 1);
  });

  it('merges children that sit inside a single reply', () => {
    const t = { topic: 'Chat', turnRange: [1, 4], children: [{ topic: 'Answer', turnRange: [1, 1], children: [{ topic: 'x', turnRange: [1, 1], children: [] }] }, { topic: 'Rest', turnRange: [2, 4], children: [] }] };
    const r = repairTopicTree(t, 4);
    expect(r.tree.children[0].children).toEqual([]);
    expect(r.warnings.some((w) => w.includes('sit inside a single turn'))).toBe(true);
  });

  it('falls back to the raw reply when there is no valid JSON', () => {
    const r = parseTreeResponse('Sorry, here are the topics: setup, build', { turns: 4 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.raw).toBe('Sorry, here are the topics: setup, build');
      expect(r.errors[0]).toMatch(/No JSON/);
    }
    const bad = parseTreeResponse('```json\n{"topic": "", "children": [], "turnRange": [1, 2]}\n```');
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.raw).toContain('"topic": ""');
  });

  it('maps each topic to the turn to scroll to, in display order', () => {
    expect(topicTargets(good)).toEqual([
      { topic: 'Chat', depth: 0, turn: 1 }, { topic: 'Setup', depth: 1, turn: 1 }, { topic: 'Install', depth: 2, turn: 1 },
      { topic: 'Config', depth: 2, turn: 3 }, { topic: 'Build', depth: 1, turn: 5 },
    ]);
  });
});

describe('summary audiences', () => {
  it('has three audiences, each with its own tone and length, plus the shared format rules', () => {
    expect(Object.values(SUMMARY_AUDIENCES).map((a) => a.label)).toEqual(['Quick recap for me', 'Status update for Slack', 'Memory line for a future session']);
    const texts = Object.keys(SUMMARY_AUDIENCES).map((a) => summaryInstructions({ audience: /** @type {any} */ (a) }));
    expect(new Set(texts).size).toBe(3);
    expect(texts[0]).toContain('in 5 to 10 lines');
    expect(texts[1]).toContain('in 4 to 6 lines');
    expect(texts[1]).toContain('teammates who were not in this chat');
    expect(texts[2]).toContain('in 3 to 5 lines');
    for (const t of texts) {
      expect(t).toContain('No Markdown and no code formatting; one point per line.');
      expect(t).toContain('Include key numbers, names and outcomes.');
      expect(t).toContain('Lines in this order: goal, what was decided or built, what is still open, next step.');
    }
    expect(summaryInstructions({ audience: /** @type {any} */ ('nope') })).toBe(texts[0]);
    expect(buildApiRequest('summary', MSGS, { audience: 'slack' }).messages[0].content).toContain('status update for teammates');
  });

  it('parses lines per audience range and strips stray formatting', () => {
    const six = Array.from({ length: 6 }, (_, i) => `- **point** \`${i}\``).join('\n');
    expect(parseSummary(six, { audience: 'slack' })).toEqual({ lines: ['point 0', 'point 1', 'point 2', 'point 3', 'point 4', 'point 5'], ok: true });
    expect(parseSummary(six, { audience: 'memory' }).lines).toHaveLength(5);
    expect(parseSummary('a\nb', { audience: 'memory' }).warning).toMatch(/expected 3 to 5/);
  });
});
