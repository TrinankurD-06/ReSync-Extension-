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

// ---- Secrets filter (code, not a prompt rule) ----
// Used before any conversation-derived text leaves the device (e.g. the team Decision Ledger). The prompt rule
// above asks the model not to write secrets; this removes the ones it (or the user) wrote anyway.

/** [name, pattern] pairs, most specific first. Each match is replaced by "[removed <name>]". */
export const SECRET_PATTERNS = /** @type {const} */ ([
  ['api key', /\b(?:sk-ant-[A-Za-z0-9_-]{8,}|sk-or-[A-Za-z0-9_-]{8,}|sk-(?:proj-)?[A-Za-z0-9_-]{16,}|AIza[0-9A-Za-z_-]{20,}|AKIA[0-9A-Z]{16}|xox[abposr]-[A-Za-z0-9-]{10,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,})\b/g],
  ['token', /\b(?:eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}|Bearer\s+[A-Za-z0-9._~+/-]{16,}=*)/g],
  ['secret', /\b((?:password|passwd|secret|api[_-]?key|access[_-]?token|token)\s*[:=]\s*)["']?[^\s"',;]{6,}["']?/gi],
  ['email', /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g],
  ['phone', /(?<![\w.])(?:\+\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)[\s.-]?)?\d{3,4}[\s.-]\d{3,4}(?:[\s.-]\d{2,4})?(?![\w.])/g],
]);

/**
 * Remove API keys, tokens, passwords, emails and phone numbers from text.
 * @param {string} text
 * @returns {{ text: string, removed: string[] }} removed: the kinds found (e.g. ['api key', 'email']), never the values
 */
export function scrubSecrets(text) {
  let out = String(text ?? '');
  const removed = [];
  for (const [name, re] of SECRET_PATTERNS) {
    out = out.replace(re, (m, prefix) => {
      // Number ranges and prices ("1000-2000") are not phone numbers: those have at least 9 digits.
      if (name === 'phone' && m.replace(/\D/g, '').length < 9) return m;
      removed.push(name);
      // "password: hunter22" keeps its label so the sentence still reads.
      return name === 'secret' && typeof prefix === 'string' ? `${prefix}[removed ${name}]` : `[removed ${name}]`;
    });
  }
  return { text: out, removed: [...new Set(removed)] };
}
