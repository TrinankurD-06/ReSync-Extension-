// Topic tree: { topic, children[], turnRange } with validation and a Mermaid mindmap renderer.
import { z } from 'zod';

/**
 * @typedef {{ topic: string, children: TopicNode[], turnRange: [number, number] }} TopicNode
 */

/** @type {z.ZodType<TopicNode>} */
export const topicNodeSchema = z.lazy(() =>
  z
    .object({
      topic: z.string().min(1).max(200),
      children: z.array(topicNodeSchema).max(50),
      turnRange: z.tuple([z.number().int().min(0), z.number().int().min(0)]),
    })
    .refine((n) => n.turnRange[0] <= n.turnRange[1], { message: 'turnRange start must be <= end', path: ['turnRange'] }),
);

/**
 * Validate a topic tree (one root node).
 * @param {unknown} tree
 * @returns {{ ok: true, tree: TopicNode, errors: [] } | { ok: false, errors: string[] }}
 */
export function validateTopicTree(tree) {
  const r = topicNodeSchema.safeParse(tree);
  if (!r.success) {
    return { ok: false, errors: r.error.issues.map((i) => `${i.path.join('.') || 'root'}: ${i.message}`) };
  }
  const depth = treeDepth(r.data);
  if (depth > 8) return { ok: false, errors: [`tree is too deep (${depth} levels, max 8)`] };
  return { ok: true, tree: r.data, errors: [] };
}

/** @param {TopicNode} n @returns {number} */
function treeDepth(n) {
  return 1 + Math.max(0, ...n.children.map(treeDepth));
}

/**
 * Accept the model's output loosely: a root node, an array of nodes (wrapped under a root),
 * or { tree: node }.
 * @param {unknown} data
 * @param {string} [rootTopic]
 * @returns {unknown}
 */
export function normaliseTopicTree(data, rootTopic = 'Conversation') {
  const fix = (/** @type {any} */ n) => {
    if (!n || typeof n !== 'object') return n;
    const children = Array.isArray(n.children) ? n.children.map(fix) : [];
    let range = n.turnRange;
    if (Array.isArray(range) && range.length === 1) range = [range[0], range[0]];
    if (range && typeof range === 'object' && !Array.isArray(range) && 'start' in range) range = [range.start, range.end];
    return { topic: String(n.topic ?? n.title ?? '').trim(), children, turnRange: range };
  };
  const d = /** @type {any} */ (data);
  if (Array.isArray(d)) {
    const kids = d.map(fix);
    const lo = Math.min(...kids.map((k) => k.turnRange?.[0] ?? 0));
    const hi = Math.max(...kids.map((k) => k.turnRange?.[1] ?? 0));
    return { topic: rootTopic, children: kids, turnRange: [Number.isFinite(lo) ? lo : 0, Number.isFinite(hi) ? hi : 0] };
  }
  if (d && typeof d === 'object' && d.tree) return fix(d.tree);
  return fix(d);
}

/** Mermaid mindmap node text cannot contain these shape delimiters. */
function mermaidText(s) {
  return String(s).replace(/[()[\]{}<>"`]/g, ' ').replace(/\s+/g, ' ').trim() || '-';
}

/**
 * Render a tree as a Mermaid mindmap.
 * @param {TopicNode} tree
 * @param {{ showTurns?: boolean }} [opts]
 */
export function treeToMermaid(tree, opts = {}) {
  const lines = ['mindmap'];
  const walk = (/** @type {TopicNode} */ n, depth) => {
    const indent = '  '.repeat(depth + 1);
    const turns = opts.showTurns ? ` - turns ${n.turnRange[0]} to ${n.turnRange[1]}` : '';
    const text = mermaidText(n.topic + turns);
    lines.push(depth === 0 ? `${indent}root((${text}))` : `${indent}${text}`);
    for (const c of n.children) walk(c, depth + 1);
  };
  walk(tree, 0);
  return lines.join('\n');
}

/**
 * Count all nodes in a tree.
 * @param {TopicNode} tree
 */
export function countTopics(tree) {
  return 1 + tree.children.reduce((s, c) => s + countTopics(c), 0);
}
