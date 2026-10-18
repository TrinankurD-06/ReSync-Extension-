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

/**
 * Enforce the tree rules the prompt asks for, fixing what can be fixed safely. Never throws.
 *  - ranges lie within 1..turns (when the turn count is known) and the root covers 1..turns;
 *  - children lie within their parent's range (clamped);
 *  - top-level ranges do not overlap and together cover 1..turns (overlaps trimmed, gaps closed, fully
 *    covered topics dropped);
 *  - a topic is only split if its children cover different turns (children that all cover the same turns,
 *    or sit inside a single turn, are merged into the parent).
 * @param {TopicNode} tree a validated tree
 * @param {number} [turns] number of turns in the conversation (counted by ReSync)
 * @returns {{ tree: TopicNode, warnings: string[] }}
 */
export function repairTopicTree(tree, turns) {
  /** @type {string[]} */
  const warnings = [];
  /** @type {TopicNode} */
  const root = structuredClone(tree);
  const n = Number.isInteger(turns) && turns > 0 ? turns : null;
  const fmt = (/** @type {[number, number]} */ r) => `${r[0]}-${r[1]}`;

  if (n && (root.turnRange[0] !== 1 || root.turnRange[1] !== n)) {
    warnings.push(`Root range ${fmt(root.turnRange)} set to 1-${n} (the conversation has ${n} turns).`);
    root.turnRange = [1, n];
  }

  /** Clamp a node into [lo, hi]. */
  const clamp = (/** @type {TopicNode} */ node, lo, hi, why) => {
    const [s, e] = node.turnRange;
    const c = /** @type {[number, number]} */ ([Math.min(Math.max(s, lo), hi), Math.min(Math.max(e, lo), hi)]);
    if (c[0] !== s || c[1] !== e) {
      warnings.push(`"${node.topic}" ${fmt(node.turnRange)} clamped to ${fmt(c)} (${why}).`);
      node.turnRange = c;
    }
  };

  if (n) {
    // Top level: within 1..n, sorted, no overlaps, no gaps.
    for (const c of root.children) clamp(c, 1, n, `the conversation has ${n} turns`);
    root.children.sort((a, b) => a.turnRange[0] - b.turnRange[0] || a.turnRange[1] - b.turnRange[1]);
    /** @type {TopicNode[]} */
    const kept = [];
    for (const c of root.children) {
      const prev = kept.at(-1);
      const prevEnd = prev ? prev.turnRange[1] : 0;
      if (c.turnRange[1] <= prevEnd) {
        warnings.push(`"${c.topic}" ${fmt(c.turnRange)} dropped: its turns are already covered by "${prev?.topic}".`);
        continue;
      }
      if (c.turnRange[0] <= prevEnd) {
        warnings.push(`"${c.topic}" overlapped "${prev?.topic}": now starts at turn ${prevEnd + 1}.`);
        c.turnRange = [prevEnd + 1, c.turnRange[1]];
      } else if (c.turnRange[0] > prevEnd + 1) {
        if (prev) {
          warnings.push(`Gap at turns ${prevEnd + 1}-${c.turnRange[0] - 1}: "${prev.topic}" now ends at turn ${c.turnRange[0] - 1}.`);
          prev.turnRange = [prev.turnRange[0], c.turnRange[0] - 1];
        } else {
          warnings.push(`"${c.topic}" now starts at turn 1 (turns 1-${c.turnRange[0] - 1} were not covered).`);
          c.turnRange = [1, c.turnRange[1]];
        }
      }
      kept.push(c);
    }
    const last = kept.at(-1);
    if (last && last.turnRange[1] < n) {
      warnings.push(`"${last.topic}" now ends at turn ${n} (turns ${last.turnRange[1] + 1}-${n} were not covered).`);
      last.turnRange = [last.turnRange[0], n];
    }
    root.children = kept;
  }

  /** Children within the parent; merge splits that don't cover different turns. */
  const walk = (/** @type {TopicNode} */ node) => {
    for (const c of node.children) clamp(c, node.turnRange[0], node.turnRange[1], `outside "${node.topic}"`);
    const single = node.turnRange[0] === node.turnRange[1];
    const same = node.children.length > 1 && node.children.every((c) => fmt(c.turnRange) === fmt(node.children[0].turnRange));
    if (node !== root && node.children.length && (single || same)) {
      warnings.push(`Sub-topics of "${node.topic}" merged into it: they ${single ? 'sit inside a single turn' : 'all cover the same turns'}.`);
      node.children = [];
    }
    for (const c of node.children) walk(c);
  };
  walk(root);
  return { tree: root, warnings };
}

/**
 * Topics in display order (depth first), each with the turn to scroll to (the start of its range).
 * @param {TopicNode} tree
 * @returns {{ topic: string, depth: number, turn: number }[]}
 */
export function topicTargets(tree) {
  const out = [];
  const walk = (/** @type {TopicNode} */ n, depth) => {
    out.push({ topic: n.topic, depth, turn: Math.max(1, n.turnRange[0]) });
    for (const c of n.children) walk(c, depth + 1);
  };
  walk(tree, 0);
  return out;
}

/** The text Mermaid shows for a topic (same cleaning as treeToMermaid), for matching rendered nodes. */
export function mermaidLabel(s) {
  return mermaidText(s);
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
