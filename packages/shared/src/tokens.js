// Token ESTIMATES. Real tokenizers differ per model; these numbers are labelled as estimates everywhere they are shown.

export const ESTIMATE_LABEL = 'estimate';

/** Characters per token by kind of text (rough averages; real tokenizers vary by model). */
export const CHARS_PER_TOKEN = /** @type {const} */ ({ prose: 4, code: 3, nonLatin: 2 });

// Characters of any non-Latin script: Greek, Cyrillic, Hebrew, Arabic, Indic, Thai, CJK, Hangul... (accented Latin
// stays "prose"). Punctuation, digits, spaces and emoji (script "Common") are counted with the text around them.
const NON_LATIN = /[^\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}]/gu;
const FENCE = /```[\s\S]*?(?:```|$)/g;
// Markdown marks (#, *, -) are left out so headings and bullet lists still count as prose.
const CODE_CHARS = /[{}[\]();=<>:"`|\\/_$+]/g;

/**
 * Does a line look like code or JSON rather than prose? (symbol-dense, or typical code shapes)
 * @param {string} line
 */
export function looksLikeCode(line) {
  const t = line.trim();
  if (t.length < 4) return false;
  if (/^(?:[{}[\]]|"[^"]*"\s*:|(?:const|let|var|function|import|export|return|if|for|def|class)\b|<\/?[a-z][\w-]*[\s>])/.test(t)) return true;
  if (/[;{}]\s*$/.test(t)) return true;
  const symbols = (t.match(CODE_CHARS) ?? []).length;
  return symbols / t.length > 0.15;
}

/**
 * Split text into prose, code and non-Latin character counts.
 * @param {string} text
 * @returns {{ prose: number, code: number, nonLatin: number }}
 */
export function classifyText(text) {
  const s = String(text ?? '');
  const out = { prose: 0, code: 0, nonLatin: 0 };
  const addPlain = (/** @type {string} */ chunk, /** @type {'prose' | 'code'} */ kind) => {
    const dense = (chunk.match(NON_LATIN) ?? []).length;
    out.nonLatin += dense;
    out[kind] += chunk.length - dense;
  };
  let last = 0;
  for (const m of s.matchAll(FENCE)) {
    addLines(s.slice(last, m.index), addPlain);
    addPlain(m[0], 'code');
    last = m.index + m[0].length;
  }
  addLines(s.slice(last), addPlain);
  return out;
}

/** @param {string} chunk @param {(c: string, k: 'prose' | 'code') => void} add */
function addLines(chunk, add) {
  if (!chunk) return;
  for (const line of chunk.split(/(?<=\n)/)) add(line, looksLikeCode(line) ? 'code' : 'prose');
}

/**
 * Rough token count for text, aware of the kind of text: about 4 characters per token for English prose,
 * 3 for code and JSON, and 2 for non-Latin scripts.
 * @param {string} text
 * @returns {number}
 */
export function estimateTokens(text) {
  const s = String(text ?? '');
  if (!s) return 0;
  const c = classifyText(s);
  return Math.ceil(c.prose / CHARS_PER_TOKEN.prose + c.code / CHARS_PER_TOKEN.code + c.nonLatin / CHARS_PER_TOKEN.nonLatin);
}

/**
 * Estimate tokens for a chat transcript.
 * @param {{ role: string, content: string }[]} messages
 */
export function estimateMessagesTokens(messages) {
  // Small per-message overhead for role markers.
  return (messages ?? []).reduce((sum, m) => sum + estimateTokens(m.content) + 4, 0);
}

/**
 * Format a token count for display with the estimate label, e.g. "~1.2k tokens (estimate)".
 * @param {number} n
 */
export function formatTokenEstimate(n) {
  return `~${shortNumber(n)} tokens (${ESTIMATE_LABEL})`;
}

/**
 * Format a low-high token range, e.g. "~12k to 40k tokens (estimate)".
 * @param {{ low: number, high: number }} r
 */
export function formatTokenRange(r) {
  const lo = shortNumber(r.low);
  const hi = shortNumber(r.high);
  return lo === hi ? formatTokenEstimate(r.low) : `~${lo} to ${hi} tokens (${ESTIMATE_LABEL})`;
}

/** @param {number} n */
function shortNumber(n) {
  const v = Math.max(0, Math.round(n));
  return v >= 1_000_000 ? `${(v / 1_000_000).toFixed(1)}M` : v >= 1000 ? `${(v / 1000).toFixed(1)}k` : String(v);
}
