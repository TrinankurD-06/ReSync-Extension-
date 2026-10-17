// Counts messages the user sends on claude.ai and estimates tokens for them and for finished replies.
// Messages already on the page when it loads are history and are not counted.
import { estimateTokens } from '@resync/shared/tokens';
import { queryAll, query, isStreaming } from '../lib/selectors.js';
import { markdownOf } from './conversation.js';

/**
 * @param {{
 *   add: (e: { project: string, messages?: number, tokens?: number }) => Promise<unknown>,
 *   getOverrides: () => Record<string, string[]>,
 *   projectName?: () => string,
 * }} o
 */
export function createUsageTracker(o) {
  const seen = new WeakSet();
  /** Replies seen while still streaming; counted once they finish. */
  const pending = new Set();
  const opts = () => ({ overrides: o.getOverrides() });
  const project = o.projectName ?? (() => {
    const link = query('currentProjectLink', opts());
    return (link?.textContent ?? '').trim() || 'No project';
  });

  /** Mark everything currently on the page as already seen (history). */
  function baseline() {
    for (const el of [...queryAll('userMessage', opts()), ...queryAll('assistantMessage', opts())]) seen.add(el);
  }

  /** Look for new messages and finished replies. Call on page mutations. */
  async function scan() {
    const proj = project();
    for (const el of queryAll('userMessage', opts())) {
      if (seen.has(el)) continue;
      seen.add(el);
      await o.add({ project: proj, messages: 1, tokens: estimateTokens(markdownOf(el)) });
    }
    for (const el of queryAll('assistantMessage', opts())) {
      if (!seen.has(el)) {
        seen.add(el);
        pending.add(el);
      }
    }
    if (pending.size && !isStreaming(opts())) {
      for (const el of pending) {
        pending.delete(el);
        if (el.isConnected) await o.add({ project: proj, tokens: estimateTokens(markdownOf(el)) });
      }
    }
  }

  return { baseline, scan };
}
