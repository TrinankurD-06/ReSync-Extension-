// Token ESTIMATES. Real tokenizers differ per model; these numbers are labelled as estimates everywhere they are shown.

export const ESTIMATE_LABEL = 'estimate';

/**
 * Rough token count for text: about 4 characters per token for English prose and code,
 * with CJK characters counted closer to one token each.
 * @param {string} text
 * @returns {number}
 */
export function estimateTokens(text) {
  const s = String(text ?? '');
  if (!s) return 0;
  // CJK and similar scripts tokenize much more densely than Latin text.
  const dense = (s.match(/[぀-ヿ㐀-鿿가-힯]/g) ?? []).length;
  const rest = s.length - dense;
  return Math.ceil(rest / 4 + dense);
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
  const v = Math.max(0, Math.round(n));
  const short = v >= 1_000_000 ? `${(v / 1_000_000).toFixed(1)}M` : v >= 1000 ? `${(v / 1000).toFixed(1)}k` : String(v);
  return `~${short} tokens (${ESTIMATE_LABEL})`;
}
