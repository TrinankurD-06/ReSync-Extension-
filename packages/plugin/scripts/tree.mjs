#!/usr/bin/env node
// Validate a topic-tree JSON file and write a Mermaid mindmap next to it (<file>.mmd).
// Dependency-free on purpose: the installed plugin is copied without node_modules.
// Rules mirror packages/shared/src/tree.js (a test keeps them in sync).
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** @param {any} n @param {string} at @param {string[]} errors @param {number} depth */
export function check(n, at, errors, depth = 1) {
  if (!n || typeof n !== 'object' || Array.isArray(n)) return errors.push(`${at}: must be an object`);
  if (typeof n.topic !== 'string' || !n.topic.trim()) errors.push(`${at}.topic: must be a non-empty string`);
  else if (n.topic.length > 200) errors.push(`${at}.topic: at most 200 characters`);
  const r = n.turnRange;
  if (!Array.isArray(r) || r.length !== 2 || !r.every((x) => Number.isInteger(x) && x >= 0)) errors.push(`${at}.turnRange: must be [firstTurn, lastTurn] (whole numbers)`);
  else if (r[0] > r[1]) errors.push(`${at}.turnRange: start must be <= end`);
  if (!Array.isArray(n.children)) errors.push(`${at}.children: must be an array (use [] for none)`);
  else {
    if (n.children.length > 50) errors.push(`${at}.children: at most 50`);
    if (depth >= 8 && n.children.length) errors.push(`${at}: tree is too deep (max 8 levels)`);
    n.children.forEach((c, i) => check(c, `${at}.children[${i}]`, errors, depth + 1));
  }
  return errors;
}

/** @param {string} s */
const text = (s) => String(s).replace(/[()[\]{}<>"`]/g, ' ').replace(/\s+/g, ' ').trim() || '-';

/** @param {any} tree */
export function toMermaid(tree) {
  const lines = ['mindmap'];
  const walk = (n, d) => {
    const indent = '  '.repeat(d + 1);
    lines.push(d === 0 ? `${indent}root((${text(n.topic)}))` : `${indent}${text(n.topic)}`);
    for (const c of n.children) walk(c, d + 1);
  };
  walk(tree, 0);
  return lines.join('\n');
}

function main() {
  const file = process.argv[2];
  if (!file) {
    console.error('Usage: node tree.mjs <tree.json>');
    process.exit(2);
  }
  let data;
  try {
    data = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    console.error(`Not valid JSON: ${e.message}`);
    process.exit(1);
  }
  const errors = check(data, 'root', []);
  if (errors.length) {
    console.error(`Topic tree is invalid:\n- ${errors.join('\n- ')}`);
    process.exit(1);
  }
  const mermaid = toMermaid(data);
  const out = file.replace(/\.json$/i, '') + '.mmd';
  writeFileSync(out, mermaid + '\n');
  console.log(mermaid);
  console.log(`\nValid. Wrote ${out}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
