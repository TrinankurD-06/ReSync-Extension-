// Click-to-scroll on the rendered mindmap: nodes are matched to topics and tagged with the turn to scroll to.
import { describe, it, expect } from 'vitest';
import { tagMindmapNodes, turnFromEvent } from '../src/sidepanel/mindmap.js';

const TREE = {
  topic: 'Chat', turnRange: [1, 8], children: [
    { topic: 'Setup (v2)', turnRange: [1, 4], children: [{ topic: 'Tests', turnRange: [3, 4], children: [] }] },
    { topic: 'Tests', turnRange: [5, 8], children: [] }, // same label as a sub-topic: matched in tree order
  ],
};

/** Roughly what Mermaid draws: one group per node, labels cleaned of brackets. */
const SVG = `<svg>
  <g class="mindmap-node section-root"><text>Chat</text></g>
  <g class="mindmap-node section-0"><g><text>Setup v2</text></g></g>
  <g class="mindmap-node section-0"><text>Tests</text></g>
  <g class="mindmap-node section-1"><text>Tests</text></g>
</svg>`;

describe('mindmap click-to-scroll', () => {
  it('tags each rendered node with the start of its topic\'s turnRange', () => {
    const root = document.createElement('div');
    root.innerHTML = SVG;
    expect(tagMindmapNodes(root, TREE)).toBe(4);
    const turns = [...root.querySelectorAll('g.mindmap-node')].map((g) => g.getAttribute('data-turn'));
    expect(turns).toEqual(['1', '1', '3', '5']);
    expect(root.querySelector('g.section-1').getAttribute('aria-label')).toBe('Tests: go to turn 5');
  });

  it('finds the turn from a click on a node\'s label', () => {
    const root = document.createElement('div');
    root.innerHTML = SVG;
    tagMindmapNodes(root, TREE);
    expect(turnFromEvent(root.querySelector('g.section-1 text'))).toBe(5);
    expect(turnFromEvent(root.querySelector('svg'))).toBeNull();
  });
});
