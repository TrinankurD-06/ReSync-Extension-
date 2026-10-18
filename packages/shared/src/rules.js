// Rules appended to EVERY built-in prompt and chain step (passport, topic tree, summary, chains, repair
// prompts, generated Claude Code commands). They live only here so the wording never drifts between features.

export const SHARED_RULES = /** @type {const} */ ([
  'Mark anything inferred or unconfirmed as (assumed).',
  "Never invent file paths, names, numbers or commands. Write 'unknown' instead.",
  'Never include API keys, tokens, passwords or personal contact details.',
  'Exclude the current request itself from the output.',
]);

/** First line of the rules block; also how tests and parsers recognise it. */
export const RULES_HEADING = 'Rules for every answer:';

/** The rules as a block of text. */
export function sharedRulesText() {
  return [RULES_HEADING, ...SHARED_RULES.map((r) => `- ${r}`)].join('\n');
}

/**
 * Append the shared rules to a prompt (once: text that already ends with them is returned unchanged).
 * @param {string} text
 */
export function withSharedRules(text) {
  const t = String(text).trimEnd();
  const block = sharedRulesText();
  if (t.endsWith(block)) return t;
  return `${t}\n\n${block}`;
}

/**
 * Does this prompt end with the shared rules block?
 * @param {string} text
 */
export function hasSharedRules(text) {
  return String(text).trimEnd().endsWith(sharedRulesText());
}
