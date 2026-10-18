import { describe, it, expect, beforeEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { isolateHome, tempDir } from './helpers.js';
import { generateCommands, promptToCommand, escapeDollars, commandName } from '../src/plugin/generate.js';
import { writeCommands, loadMergedLibrary, buildLocalPlugin, pluginSourceDir, seedPromptsDir } from '../src/plugin/build.js';
import { validateTopicTree, treeToMermaid } from '@resync/shared/tree';
import { parsePrompt, validatePrompt, serializePrompt } from '@resync/shared/prompts';
import { check, checkRanges, toMermaid } from '../../plugin/scripts/tree.mjs';
import { hasSharedRules } from '@resync/shared/rules';

beforeEach(async () => {
  await isolateHome();
});

const frontmatter = (text) => /^---\n([\s\S]*?)\n---\n/.exec(text)?.[1] ?? '';

describe('generated plugin commands', () => {
  it('the committed commands/ folder matches the generator (run `resync plugin generate` after changing prompts or templates)', async () => {
    const { prompts } = await loadMergedLibrary([seedPromptsDir()]);
    const expected = generateCommands(prompts);
    const dir = path.join(pluginSourceDir(), 'commands');
    const actual = Object.fromEntries(await Promise.all((await fs.readdir(dir)).map(async (f) => [f, (await fs.readFile(dir + '/' + f, 'utf8')).replace(/\r\n/g, '\n')])));
    expect(Object.keys(actual).sort()).toEqual(Object.keys(expected).sort());
    for (const [f, text] of Object.entries(expected)) expect(actual[f], f).toBe(text);
  });

  it('has the core commands plus one per saved prompt, all with a description', async () => {
    const { prompts } = await loadMergedLibrary([seedPromptsDir()]);
    const files = generateCommands(prompts);
    for (const core of ['passport', 'resume', 'tree', 'summary', 'prompts']) expect(files).toHaveProperty(`${core}.md`);
    for (const p of prompts) expect(files).toHaveProperty(`${commandName(p)}.md`);
    for (const [f, text] of Object.entries(files)) expect(frontmatter(text), f).toMatch(/^description: ".+"/m);
  });

  it('passport asks for every section and saves under .resync/passports with the session id', () => {
    const { 'passport.md': p, 'resume.md': r, 'tree.md': t } = generateCommands([]);
    for (const s of ['## Goal', '## Current state', '## Decisions made (and why)', '## Open questions', '## Dead ends', '## Next 3 steps', '## Key files']) expect(p).toContain(s);
    expect(p).toContain('.resync/passports/');
    expect(p).toContain('${CLAUDE_SESSION_ID}');
    expect(r).toContain('$ARGUMENTS');
    expect(r).toContain('.resync/passports/');
    expect(t).toContain('"${CLAUDE_PLUGIN_ROOT}/scripts/tree.mjs"');
    expect(frontmatter(t)).toContain('allowed-tools: Bash(node *)');
    // Meta first, filled with the session id; every core command ends its instructions with the shared rules.
    expect(p.indexOf('## Meta')).toBeLessThan(p.indexOf('## Goal'));
    expect(p).toContain('- Source: Claude Code session ${CLAUDE_SESSION_ID}');
    const { 'summary.md': sum } = generateCommands([]);
    for (const text of [p, t, sum]) expect(text).toContain('Rules for every answer:');
    expect(sum).toContain('Status update for Slack');
  });

  it('maps variables to arguments and renders chains as ordered steps', async () => {
    const { prompts } = await loadMergedLibrary([seedPromptsDir()]);
    const chain = prompts.find((p) => p.slug === 'launch-chain');
    const text = promptToCommand(chain);
    // Chains: intake first, then the steps, the success-criteria step (planning chain) and the shared rules.
    expect(text).toContain('Before step 1 (intake)');
    expect(text).toContain('ask me at most 3 short questions');
    expect(text).toContain('## Step 4');
    expect(hasSharedRules(text.trim())).toBe(true);
    expect(frontmatter(text)).toContain('argument-hint: "[product]"');
    expect(text).toContain('## Step 1');
    expect(text).toContain('## Step 3');
    expect(text).toContain('Fill them from these arguments, in order: $ARGUMENTS');
  });

  it('escapes $ sequences inside prompt text so Claude Code does not substitute them', () => {
    expect(escapeDollars('costs $1.00 and $ARGUMENTS and ${X} but $ alone')).toBe('costs \\$1.00 and \\$ARGUMENTS and \\${X} but $ alone');
    const p = validatePrompt(parsePrompt('---\ntitle: Price\ncategory: dev\n---\nCharge $5 per seat', { path: 'dev/price.md' }));
    expect(promptToCommand(p.prompt)).toContain('Charge \\$5 per seat');
  });

  it('removes stale generated commands but keeps hand-written ones', async () => {
    const dir = await tempDir('cmds-');
    await fs.writeFile(path.join(dir, 'mine.md'), '---\ndescription: mine\n---\nhand written');
    await writeCommands(dir, (await loadMergedLibrary([seedPromptsDir()])).prompts);
    expect(await fs.readdir(dir)).toContain('dev-code-review.md');
    const r = await writeCommands(dir, []);
    expect(r.removed).toContain('dev-code-review.md');
    expect(await fs.readdir(dir)).toContain('mine.md');
  });
});

describe('local plugin build (used by resync sync)', () => {
  it('builds a valid local marketplace with synced prompts overriding seeds', async () => {
    const lib = path.join(process.env.RESYNC_HOME, 'library', 'team');
    await fs.mkdir(lib, { recursive: true });
    const p = validatePrompt(parsePrompt('---\ntitle: Standup\ncategory: team\nscope: team\n---\nWrite my standup.', { path: 'team/standup.md' })).prompt;
    await fs.writeFile(path.join(lib, 'standup.md'), serializePrompt(p));
    const r = await buildLocalPlugin();
    const cmds = await fs.readdir(path.join(r.pluginDir, 'commands'));
    expect(cmds).toContain('team-standup.md');
    expect(cmds).toContain('dev-code-review.md');
    expect(JSON.parse(await fs.readFile(path.join(r.root, '.claude-plugin', 'marketplace.json'), 'utf8')).plugins[0].source).toBe('./resync');
    await fs.access(path.join(r.pluginDir, 'scripts', 'tree.mjs'));
    await fs.access(path.join(r.pluginDir, '.claude-plugin', 'plugin.json'));
  });
});

describe('plugin tree.mjs (dependency-free)', () => {
  const TREE = { topic: 'Build (v2)', turnRange: [1, 9], children: [{ topic: 'Auth', turnRange: [2, 4], children: [] }] };
  const BAD = [
    { topic: '', turnRange: [1, 2], children: [] },
    { topic: 'x', turnRange: [3, 1], children: [] },
    { topic: 'x', turnRange: [1], children: [] },
    { topic: 'x', turnRange: [1, 2] },
    { topic: 'x', turnRange: [1.5, 2], children: [] },
  ];

  it('agrees with the shared validator and Mermaid renderer', () => {
    expect(check(TREE, 'root', [])).toEqual([]);
    expect(validateTopicTree(TREE).ok).toBe(true);
    expect(toMermaid(TREE)).toBe(treeToMermaid(TREE));
    for (const b of BAD) {
      expect(check(b, 'root', []).length, JSON.stringify(b)).toBeGreaterThan(0);
      expect(validateTopicTree(b).ok, JSON.stringify(b)).toBe(false);
    }
  });

  it('reports range-rule violations so Claude fixes the JSON (children inside parents, no top-level overlap)', () => {
    expect(checkRanges(TREE, [])).toEqual([]);
    const outside = { topic: 'r', turnRange: [1, 4], children: [{ topic: 'a', turnRange: [1, 2], children: [{ topic: 'deep', turnRange: [2, 3], children: [] }] }, { topic: 'b', turnRange: [2, 4], children: [] }] };
    const errs = checkRanges(outside, []);
    expect(errs.join('\n')).toMatch(/must lie within its parent's \[1,2\]/);
    expect(errs.join('\n')).toMatch(/"a" and "b" overlap/);
    expect(checkRanges({ topic: 'r', turnRange: [1, 6], children: [{ topic: 'a', turnRange: [2, 3], children: [] }] }, [], 6)[0]).toMatch(/cover turns 1 to 6/);
  });

  it('runs as a script: writes the .mmd file, exits 1 on invalid input', async () => {
    const dir = await tempDir('tree-');
    const script = path.join(pluginSourceDir(), 'scripts', 'tree.mjs');
    const good = path.join(dir, 'a.json');
    await fs.writeFile(good, JSON.stringify(TREE));
    const stdout = execFileSync(process.execPath, [script, good]).toString();
    expect(stdout).toContain('root((Build v2))');
    expect(await fs.readFile(path.join(dir, 'a.mmd'), 'utf8')).toBe(treeToMermaid(TREE) + '\n');
    const bad = path.join(dir, 'b.json');
    await fs.writeFile(bad, JSON.stringify(BAD[1]));
    let code = 0;
    try {
      execFileSync(process.execPath, [script, bad], { stdio: 'pipe' });
    } catch (e) {
      code = e.status;
      expect(e.stderr.toString()).toContain('start must be <= end');
    }
    expect(code).toBe(1);
  });
});
