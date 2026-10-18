// Mindmap rendering for the topic tree. Mermaid ships inside the extension (vendor/mermaid.min.js, copied at build
// time): extension pages can't load remote scripts. It is loaded on first use only.
import { topicTargets, mermaidLabel } from '@resync/shared/tree';

let loading = null;

/** @returns {Promise<any>} the global mermaid object */
export function loadMermaid(src = 'vendor/mermaid.min.js') {
  const g = /** @type {any} */ (globalThis);
  if (g.mermaid) return Promise.resolve(g.mermaid);
  loading ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = () => {
      const dark = matchMedia?.('(prefers-color-scheme: dark)').matches;
      g.mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: dark ? 'dark' : 'default' });
      resolve(g.mermaid);
    };
    s.onerror = () => {
      loading = null;
      reject(new Error('Could not load the bundled Mermaid renderer.'));
    };
    document.head.append(s);
  });
  return loading;
}

let seq = 0;

/**
 * Render Mermaid source to an SVG string.
 * @param {string} source
 */
export async function renderMermaid(source) {
  const mermaid = await loadMermaid();
  const { svg } = await mermaid.render(`resync-mindmap-${++seq}`, source);
  return svg;
}

/**
 * Make the rendered mindmap's nodes clickable: each node gets data-turn (the start of its topic's turnRange).
 * Rendered nodes are matched to topics by their label, in tree order (the same order the Mermaid source lists
 * them), so repeated labels still map to the right topic.
 * @param {ParentNode} root element holding the rendered SVG
 * @param {import('@resync/shared/tree').TopicNode} tree
 * @returns {number} how many nodes were mapped
 */
export function tagMindmapNodes(root, tree) {
  const norm = (s) => String(s).replace(/\s+/g, ' ').trim().toLowerCase();
  const targets = topicTargets(tree).map((t) => ({ ...t, label: norm(mermaidLabel(t.topic)), used: false }));
  // Mermaid draws each topic as a group of class "mindmap-node" (older versions: "node"). Keep the outermost.
  const groups = [...root.querySelectorAll('g.mindmap-node, g.node')].filter((g, _, all) => !all.some((o) => o !== g && o.contains(g)));
  let mapped = 0;
  for (const g of groups) {
    const text = norm(g.textContent);
    const t = targets.find((x) => !x.used && x.label === text) ?? targets.find((x) => !x.used && text && (text.includes(x.label) || x.label.includes(text)));
    if (!t) continue;
    t.used = true;
    g.setAttribute('data-turn', String(t.turn));
    g.setAttribute('role', 'button');
    g.setAttribute('tabindex', '0');
    g.setAttribute('aria-label', `${t.topic}: go to turn ${t.turn}`);
    mapped++;
  }
  return mapped;
}

/**
 * The turn a click inside the mindmap should scroll to, or null.
 * @param {EventTarget | null} target
 */
export function turnFromEvent(target) {
  const el = /** @type {Element | null} */ (target instanceof Element ? target.closest('[data-turn]') : null);
  const n = el ? Number(el.getAttribute('data-turn')) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}
