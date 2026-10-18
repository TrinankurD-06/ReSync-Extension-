// Multi-step chain planning, shared by the extension (side panel + content script) and the plugin generator.
//  - Intake: before the first step, find the facts this chain needs that are still missing and ask at most
//    3 short questions in one go. Skipped questions become recorded assumptions.
//  - chainContext: product facts, budget, team, deadline, success metric and assumptions. It goes into EVERY
//    step's prompt together with the previous step's output, so no step has to ask again.
//  - Field check: a step that asks for a field the context can't fill (an "owner" with no team names) is
//    relabelled or told to leave it out, instead of getting a silent placeholder.
//  - Success criteria: an optional last step for planning chains that puts a measurable target on each item.
// Everything here is plain text work: no model or API key is needed.
import { withSharedRules } from './rules.js';

export const MAX_INTAKE_QUESTIONS = 3;

/** Facts a chain can collect. `question` is what intake asks; `label` is how the context lists it. */
export const CHAIN_FACTS = /** @type {const} */ ({
  coreFeature: { label: 'Core feature', question: 'What is the one core feature?' },
  targetUser: { label: 'Target user', question: 'Who is the target user?' },
  differentiator: { label: 'Key differentiator', question: 'What makes it different from the alternatives?' },
  teamMembers: { label: 'Team', question: 'Who is on the team? Name and role, comma-separated (for example "Asha: founder, Ravi: design").' },
  deadline: { label: 'Deadline or launch date', question: 'What is the deadline or launch date?' },
  successMetric: { label: 'Primary success metric', question: 'What one number would mean this worked? (for example "200 installs in the first week")' },
  budget: { label: 'Budget', question: 'What is the budget? (for example "₹0" or "$500")' },
  teamSize: { label: 'Team size', question: 'How many people are working on this?' },
});

/** @typedef {keyof typeof CHAIN_FACTS} FactKey */

/** Checked for every chain unless the chain lists its own intake facts. */
export const PRODUCT_FACTS = /** @type {FactKey[]} */ (['coreFeature', 'targetUser', 'differentiator']);

/**
 * @typedef {{ name: string, role: string }} TeamMember
 * @typedef {{
 *   inputs: Record<string, string>,   the chain's variable values, by variable description or name
 *   coreFeature?: string, targetUser?: string, differentiator?: string,
 *   budget?: string, teamSize?: string, deadline?: string, successMetric?: string,
 *   teamMembers: TeamMember[],
 *   assumptions: string[],
 * }} ChainContext
 */

/** @returns {ChainContext} */
export function emptyChainContext() {
  return { inputs: {}, teamMembers: [], assumptions: [] };
}

/** Merge saved context (team, budget...) with this run's values. @param {...Partial<ChainContext>} parts */
export function mergeChainContext(...parts) {
  const out = emptyChainContext();
  for (const p of parts) {
    if (!p) continue;
    for (const [k, v] of Object.entries(p)) {
      if (k === 'inputs') Object.assign(out.inputs, v);
      else if (k === 'teamMembers') out.teamMembers = Array.isArray(v) && v.length ? v.map((m) => ({ name: String(m.name ?? '').trim(), role: String(m.role ?? '').trim() })).filter((m) => m.name) : out.teamMembers;
      else if (k === 'assumptions') out.assumptions = [...out.assumptions, ...(Array.isArray(v) ? v.map(String) : [])];
      else if (k in CHAIN_FACTS && v != null && String(v).trim()) out[k] = String(v).trim();
    }
  }
  out.assumptions = [...new Set(out.assumptions)];
  return out;
}

/** @param {FactKey} key @param {ChainContext} ctx */
export function isFactMissing(key, ctx) {
  if (key === 'teamMembers') return !ctx.teamMembers?.length;
  return !String(ctx[key] ?? '').trim();
}

/**
 * "Asha: founder, Ravi (design), Mei - marketing" -> [{ name, role }].
 * @param {string} text
 * @returns {TeamMember[]}
 */
export function parseTeamMembers(text) {
  return String(text ?? '')
    .split(/[,;\n]+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const m = /^(.+?)\s*(?::|\(|\s-\s|\s–\s)\s*(.+?)\)?$/.exec(part);
      return m ? { name: m[1].trim(), role: m[2].trim() } : { name: part, role: '' };
    })
    .filter((m) => m.name);
}

/**
 * Output fields a step can ask for that need a fact from the context. When the fact is missing, the field is
 * relabelled (`relabel`) or left out (`relabel: null`). Generic: it works on any chain's step text.
 */
export const FIELD_CHECKS = [
  {
    field: 'owner',
    pattern: /\bowners?\b(?!\s+roles?\b)/gi,
    needs: /** @type {FactKey} */ ('teamMembers'),
    relabel: 'owner role',
    missingNote: 'No team names are known, so the owner column holds a role (for example founder, designer), never a made-up name.',
    knownNote: (/** @type {ChainContext} */ c) => `Owners must be people from the team: ${formatTeam(c.teamMembers)}.`,
  },
  {
    field: 'budget',
    pattern: /\b(?:budget|cost)s?\b/gi,
    needs: /** @type {FactKey} */ ('budget'),
    relabel: null,
    missingNote: 'The budget is unknown: leave out cost and budget figures, or write unknown.',
    knownNote: (/** @type {ChainContext} */ c) => `Stay within the budget: ${c.budget}.`,
  },
  {
    field: 'due date',
    pattern: /\b(?:due dates?|deadlines?|launch date)\b/gi,
    needs: /** @type {FactKey} */ ('deadline'),
    relabel: 'day number',
    missingNote: 'No dates are known, so use day numbers (Day 1, Day 2...), not calendar dates.',
    knownNote: (/** @type {ChainContext} */ c) => `Work back from the deadline: ${c.deadline}.`,
  },
];

/** @param {TeamMember[]} team */
function formatTeam(team) {
  return team.map((m) => (m.role ? `${m.name} (${m.role})` : m.name)).join(', ');
}

/** Facts the steps' output fields need (for intake priority). @param {{ text: string }[]} steps */
export function fieldsNeeded(steps) {
  const needs = [];
  for (const f of FIELD_CHECKS) {
    if (steps.some((s) => new RegExp(f.pattern.source, 'i').test(s.text)) && !needs.includes(f.needs)) needs.push(f.needs);
  }
  return /** @type {FactKey[]} */ (needs);
}

/**
 * Apply the field check to one step's text.
 * @param {string} text
 * @param {ChainContext} ctx
 * @returns {{ text: string, notes: string[], changed: string[] }} changed: fields that were relabelled or dropped
 */
export function applyFieldChecks(text, ctx) {
  let out = String(text);
  const notes = [];
  const changed = [];
  for (const f of FIELD_CHECKS) {
    if (!new RegExp(f.pattern.source, 'i').test(out)) continue;
    if (!isFactMissing(f.needs, ctx)) {
      notes.push(f.knownNote(ctx));
      continue;
    }
    if (f.relabel) out = out.replace(f.pattern, (w) => (w[0] === w[0].toUpperCase() ? f.relabel[0].toUpperCase() + f.relabel.slice(1) : f.relabel));
    notes.push(f.missingNote);
    changed.push(f.field);
  }
  return { text: out, notes, changed };
}

/**
 * Is this a planning chain (launch plans, calendars, roadmaps)? Those get the success-criteria step by default.
 * @param {{ tags?: string[], title?: string, chain?: { type?: string } }} prompt
 */
export function isPlanningChain(prompt) {
  if (prompt.chain?.type) return prompt.chain.type === 'planning';
  const words = [...(prompt.tags ?? []), prompt.title ?? ''].join(' ');
  return /\b(?:plan|planning|launch|roadmap|calendar|schedule)\b/i.test(words);
}

/** Is the success-criteria step on by default for this chain? @param {any} prompt */
export function successCriteriaDefault(prompt) {
  return prompt.chain?.successCriteria ?? isPlanningChain(prompt);
}

/**
 * Plan the intake: which facts are missing, and which (at most 3) to ask about now, by what matters for this
 * chain: its own intake list (or the product facts), then facts its output fields need, then the success
 * metric when the success-criteria step is on.
 * @param {{ steps: { text: string }[], chain?: { intake?: string[] } }} prompt
 * @param {ChainContext} ctx
 * @param {{ successCriteria?: boolean, max?: number }} [o]
 * @returns {{ questions: { key: FactKey, label: string, question: string }[], missing: FactKey[] }}
 */
export function planIntake(prompt, ctx, o = {}) {
  const own = /** @type {FactKey[]} */ ((prompt.chain?.intake ?? PRODUCT_FACTS).filter((k) => k in CHAIN_FACTS));
  const order = [...own, ...fieldsNeeded(prompt.steps), ...(o.successCriteria ? /** @type {FactKey[]} */ (['successMetric']) : [])];
  const missing = /** @type {FactKey[]} */ ([...new Set(order)].filter((k) => isFactMissing(k, ctx)));
  const questions = missing.slice(0, o.max ?? MAX_INTAKE_QUESTIONS).map((key) => ({ key, label: CHAIN_FACTS[key].label, question: CHAIN_FACTS[key].question }));
  return { questions, missing };
}

/**
 * Fold intake answers into the context. Unanswered questions become recorded assumptions.
 * @param {ChainContext} ctx
 * @param {{ key: FactKey, label: string }[]} questions
 * @param {Partial<Record<FactKey, string>>} answers
 * @returns {ChainContext}
 */
export function applyIntakeAnswers(ctx, questions, answers) {
  const next = mergeChainContext(ctx);
  for (const q of questions) {
    const a = String(answers[q.key] ?? '').trim();
    if (!a) {
      next.assumptions.push(`${q.label} was not given: infer it from the product and mark it (assumed).`);
    } else if (q.key === 'teamMembers') {
      next.teamMembers = parseTeamMembers(a);
    } else {
      next[q.key] = a;
    }
  }
  next.assumptions = [...new Set(next.assumptions)];
  return next;
}

/**
 * The context block inserted into every step.
 * @param {ChainContext} ctx
 */
export function chainContextBlock(ctx) {
  const lines = ['Chain context (collected by ReSync; do not ask me again for anything listed here):'];
  for (const [k, v] of Object.entries(ctx.inputs ?? {})) lines.push(`- ${k}: ${v}`);
  for (const key of /** @type {FactKey[]} */ (Object.keys(CHAIN_FACTS))) {
    const label = CHAIN_FACTS[key].label;
    if (key === 'teamMembers') lines.push(`- ${label}: ${ctx.teamMembers.length ? formatTeam(ctx.teamMembers) : 'unknown'}`);
    else lines.push(`- ${label}: ${ctx[key] || 'unknown'}`);
  }
  lines.push(`- Assumptions: ${ctx.assumptions.length ? ctx.assumptions.join(' ') : 'none'}`);
  lines.push("Where a value is unknown, don't ask: write unknown, or use a reasonable value marked (assumed).");
  return lines.join('\n');
}

/** The previous step's output is quoted up to this many characters (the full reply is in the chat). */
export const PREVIOUS_OUTPUT_MAX_CHARS = 6000;

/**
 * Build the text actually sent for one step: the step (after the field check), the chain context, the
 * previous step's output, and the shared rules.
 * @param {{ text: string }} step
 * @param {{ context: ChainContext, previousOutput?: string, index: number }} o
 */
export function composeChainStep(step, o) {
  const f = applyFieldChecks(step.text, o.context);
  const parts = [f.text];
  if (f.notes.length) parts.push(f.notes.join(' '));
  parts.push(chainContextBlock(o.context));
  const prev = String(o.previousOutput ?? '').trim();
  if (o.index > 0 && prev) {
    const quoted = prev.length > PREVIOUS_OUTPUT_MAX_CHARS ? `${prev.slice(0, PREVIOUS_OUTPUT_MAX_CHARS)}\n[...cut here; the full reply is above in this chat]` : prev;
    parts.push(`Previous step's output:\n"""\n${quoted}\n"""`);
  }
  return withSharedRules(parts.join('\n\n'));
}

/**
 * The optional last step for planning chains: a measurable target on each item, tied to the primary metric.
 * @param {ChainContext} ctx
 */
export function successCriteriaStep(ctx) {
  const metric = ctx.successMetric
    ? `the primary success metric: ${ctx.successMetric}`
    : 'the primary success metric (unknown: pick one that fits the plan and mark it (assumed))';
  return {
    text: [
      'Add success criteria to the plan from the previous step: give every item (for a calendar, every day) one measurable target.',
      `Tie each target to ${metric}. Each target is a number with a unit and a time frame (for example "50 sign-ups by Day 3"), and together the targets should add up to the primary metric where that makes sense.`,
      'Keep the same table and add a "Target" column.',
    ].join(' '),
    waitFor: /** @type {const} */ ('response'),
    delaySeconds: 0,
    successCriteria: true,
  };
}

/**
 * The steps to run: the chain's own steps plus the success-criteria step when it is on.
 * @param {{ steps: { text: string, waitFor: 'response' | 'timer', delaySeconds: number }[] }} prompt
 * @param {{ context: ChainContext, successCriteria?: boolean }} o
 */
export function chainSteps(prompt, o) {
  const steps = prompt.steps.map((s) => ({ ...s }));
  if (o.successCriteria) steps.push(successCriteriaStep(o.context));
  return steps;
}

/**
 * In-chat intake instructions for places without a side panel (the generated Claude Code commands): the
 * model asks the questions itself.
 * @param {{ steps: { text: string }[], chain?: { intake?: string[] } }} prompt
 * @param {{ successCriteria?: boolean }} [o]
 */
export function intakeInstructions(prompt, o = {}) {
  const { missing } = planIntake(prompt, emptyChainContext(), { successCriteria: o.successCriteria, max: 99 });
  const labels = missing.map((k) => CHAIN_FACTS[k].label.toLowerCase());
  return [
    labels.length ? `Before step 1 (intake): check that you know these facts: ${labels.join(', ')}.` : 'Before step 1 (intake): check that you have what this chain needs.',
    `If anything is missing from what I gave you, ask me at most ${MAX_INTAKE_QUESTIONS} short questions in one message (the ones that matter most for this chain) and wait for my answer. If I skip, continue and record your assumptions, marked (assumed).`,
    'Keep these facts as the chain context (product facts, budget, team size, team members with roles, deadline, primary success metric, assumptions) and use them in every step, together with the previous step\'s output. Never ask again for anything already in the chain context.',
    'If a step asks for a field the chain context cannot fill (for example an owner with no team names), relabel it (owner role) or leave it out. Never output placeholders.',
  ].join('\n');
}
