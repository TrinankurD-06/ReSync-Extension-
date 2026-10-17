import { describe, it, expect, beforeEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { isolateHome, makeRepo, tempDir } from './helpers.js';
import { loadConfig, saveConfig, setPath, getPath, DEFAULT_LIMIT_PATTERNS } from '../src/config.js';
import { setKeyStore, setKey, getKey, listKeys, removeKey, envNamesFor } from '../src/keys.js';
import { usageReport, todayTotals, table } from '../src/usageTables.js';
import { appendUsage, readUsage } from '../src/usageLog.js';
import { parseTranscript, projectDirName, findTranscript } from '../src/transcript.js';
import { runApiFeature } from '../src/aiFeatures.js';
import { buildProgram, splitTools } from '../src/cli.js';
import { PASSPORT_SECTIONS } from '@resync/shared/templates';

/** In-memory keychain so tests never touch the real OS keychain. */
function memoryStore() {
  const m = new Map();
  return { available: async () => true, get: async (a) => m.get(a) ?? null, set: async (a, v) => void m.set(a, v), delete: async (a) => m.delete(a), m };
}

let home;
let store;
beforeEach(async () => {
  home = await isolateHome();
  store = memoryStore();
  setKeyStore(store);
  for (const k of Object.keys(process.env)) if (/_API_KEY$/.test(k)) delete process.env[k];
});

function run(args, extra = {}) {
  const lines = [];
  const errs = [];
  let streamed = '';
  const program = buildProgram({ out: (s) => lines.push(s), err: (s) => errs.push(s), write: (s) => (streamed += s), ...extra });
  program.exitOverride();
  return program.parseAsync(['node', 'resync', ...args]).then(() => ({ out: lines.join('\n'), err: errs.join('\n'), streamed }));
}

describe('config', () => {
  it('defaults: no server, no providers, in-chat everywhere, limit patterns in config', async () => {
    const cfg = await loadConfig();
    expect(cfg.serverUrl).toBe('');
    expect(cfg.ai.providers).toEqual({});
    expect(cfg.ai.features.passport).toEqual({ mode: 'in-chat' });
    expect(cfg.queue.limitPatterns).toEqual(DEFAULT_LIMIT_PATTERNS);
    expect(cfg.queue.backoff).toEqual({ initialMinutes: 15, maxMinutes: 120 });
  });
  it('round-trips and merges user changes with defaults', async () => {
    const cfg = await loadConfig();
    setPath(cfg, 'queue.backoff.initialMinutes', '5');
    await saveConfig(cfg);
    const again = await loadConfig();
    expect(getPath(again, 'queue.backoff')).toEqual({ initialMinutes: 5, maxMinutes: 120 });
    const raw = JSON.parse(await fs.readFile(path.join(home, 'config.json'), 'utf8'));
    expect(JSON.stringify(raw)).not.toMatch(/apiKey/);
  });
});

describe('keys', () => {
  it('stores keys in the keychain, lists providers only, falls back to env', async () => {
    await setKey('anthropic', '  sk-ant-secret-value  ');
    expect(store.m.get('anthropic')).toBe('sk-ant-secret-value');
    expect(await getKey('anthropic')).toEqual({ key: 'sk-ant-secret-value', source: 'keychain' });
    const cfgText = await fs.readFile(path.join(home, 'config.json'), 'utf8');
    expect(cfgText).not.toContain('sk-ant-secret-value');
    process.env.OPENAI_API_KEY = 'sk-from-env';
    expect(await getKey('openai')).toMatchObject({ source: 'env', envName: 'OPENAI_API_KEY' });
    const list = await listKeys();
    expect(JSON.stringify(list)).not.toContain('sk-');
    expect(list).toEqual([{ provider: 'anthropic', source: 'OS keychain' }]);
    expect(await removeKey('anthropic')).toBe(true);
    expect(await getKey('anthropic')).toBeNull();
    expect(envNamesFor('my-local')).toEqual(['RESYNC_MY_LOCAL_API_KEY']);
    await expect(setKey('x', '   ')).rejects.toThrow(/Empty/);
  });
});

describe('resync command', () => {
  it('works with no keys at all', async () => {
    expect((await run(['keys', 'list'])).out).toMatch(/No API keys set. That is fine/);
    expect((await run(['keys', 'test'])).out).toMatch(/nothing to test/);
    expect((await run(['passport'])).out).toMatch(/run \/resync:passport inside Claude Code/);
    const r = await run(['passport', '--api']);
    expect(r.err).toMatch(/API mode is off/);
    process.exitCode = 0;
  });

  it('adds a provider and routes a feature to it', async () => {
    await run(['provider', 'add', 'local', '--type', 'openai-compatible', '--base-url', 'http://localhost:11434/v1', '--model', 'qwen2.5-coder:7b']);
    await run(['feature', 'summary', '--mode', 'api', '--provider', 'local']);
    const cfg = await loadConfig();
    expect(cfg.ai.providers.local).toEqual({ type: 'openai-compatible', baseUrl: 'http://localhost:11434/v1', defaultModel: 'qwen2.5-coder:7b' });
    expect(cfg.ai.features.summary).toEqual({ mode: 'api', provider: 'local' });
    expect((await run(['provider', 'list'])).out).toMatch(/summary\s+api\s+local/);
  });

  it('keys test reports OK and FAIL per provider using mocked HTTP', async () => {
    await run(['provider', 'add', 'local', '--type', 'openai-compatible', '--base-url', 'http://local.test/v1']);
    await run(['provider', 'add', 'openai', '--type', 'openai']);
    await setKey('openai', 'sk-bad-key-123456');
    const fetch = async (url) => (String(url).startsWith('http://local.test')
      ? new Response(JSON.stringify({ data: [{ id: 'qwen' }] }), { status: 200 })
      : new Response(JSON.stringify({ error: { message: 'Incorrect API key provided', code: 'invalid_api_key' } }), { status: 401 }));
    const r = await run(['keys', 'test'], { fetch });
    expect(r.out).toMatch(/OK {4}local: 1 model\(s\) available/);
    expect(r.out).toMatch(/FAIL {2}openai: \[auth\]/);
    expect(r.out).not.toContain('sk-bad-key');
    process.exitCode = 0;
  });

  it('refuses to put secrets in config', async () => {
    await expect(run(['config', 'set', 'openaiApiKey', 'x'])).rejects.toThrow(/Secrets do not belong/);
  });

  it('queues tasks with the default allowlist and warns for skip-permissions', async () => {
    const repo = await makeRepo();
    const a = await run(['queue', 'add', 'fix the tests', '--repo', repo.dir]);
    expect(a.out).toMatch(/Queued .*\n {2}tools: Read, Glob, Grep, Edit, Write, Bash\(npm test \*\)/);
    const b = await run(['queue', 'add', 'risky', '--repo', repo.dir, '--skip-permissions', '--tools', 'Read,Bash(npm test *)']);
    expect(b.err).toMatch(/WARNING: --skip-permissions/);
    const list = await run(['queue', 'list']);
    expect(list.out).toMatch(/pending\s+fix the tests/);
    await expect(run(['queue', 'add', 'x', '--repo', await tempDir()])).rejects.toThrow(/not inside a git repository/);
  });

  it('splits tool allowlists without breaking parentheses', () => {
    expect(splitTools('Read, Bash(npm test *),Bash(git diff *) ,Edit')).toEqual(['Read', 'Bash(npm test *)', 'Bash(git diff *)', 'Edit']);
  });
});

describe('usage', () => {
  const rec = (o) => ({ user: 'tester', project: 'resync', sessionId: 's1', date: '2026-10-17', source: 'plugin', ...o });
  it('prints per-day and per-project tables labelled as estimates', async () => {
    await appendUsage(rec({ inputTokens: 12000, outputTokens: 3000, costUsd: 0.42 }));
    await appendUsage(rec({ sessionId: 's2', project: 'site', inputTokens: 500, costUsd: 0.01 }));
    await appendUsage(rec({ sessionId: 's3', date: '2026-10-16', inputTokens: 100 }));
    await fs.appendFile(path.join(home, 'usage.jsonl'), 'garbage line\n');
    const { records, skipped } = await readUsage();
    expect(records).toHaveLength(3);
    expect(skipped).toBe(1);
    const text = usageReport(records, { today: new Date(2026, 9, 17) });
    expect(text).toMatch(/ESTIMATE/);
    expect(text).toMatch(/2026-10-17\s+2\s+15\.5k\s+\$0\.43/);
    expect(text).toMatch(/Total\s+3/);
    expect(text).toMatch(/Per project[\s\S]*resync\s+2[\s\S]*site\s+1/);
    expect(todayTotals(records, new Date(2026, 9, 17))).toEqual({ tokens: 15500, costUsd: 0.43, sessions: 2 });
    expect(usageReport([], {})).toMatch(/No usage recorded/);
  });
  it('rejects records carrying content', async () => {
    await expect(appendUsage(rec({ prompt: 'secret' }))).rejects.toThrow(/Invalid usage record/);
  });
  it('renders aligned tables', () => {
    expect(table(['A', 'Num'], [['x', 1], ['long', 22]], ['left', 'right'])).toBe('A     Num\n----  ---\nx       1\nlong   22');
  });
});

const TRANSCRIPT = [
  { type: 'user', message: { role: 'user', content: 'Build the login page' } },
  { type: 'assistant', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'secret thoughts' }, { type: 'text', text: 'I will start with the form.' }, { type: 'tool_use', name: 'Edit', input: {} }] } },
  { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] } },
  { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Form done.' }] } },
  { type: 'user', isMeta: true, message: { role: 'user', content: 'meta' } },
  { type: 'user', message: { role: 'user', content: '<command-name>/clear</command-name>' } },
  { type: 'summary', summary: 'x' },
].map((x) => JSON.stringify(x)).join('\n') + '\nnot json\n';

describe('transcripts', () => {
  it('keeps only user/assistant text, merging consecutive turns', () => {
    expect(parseTranscript(TRANSCRIPT)).toEqual([
      { role: 'user', content: 'Build the login page' },
      { role: 'assistant', content: 'I will start with the form.\n\nForm done.' },
    ]);
  });
  it('finds the newest transcript for a folder', async () => {
    const claudeDir = await tempDir('claude-cfg-');
    process.env.CLAUDE_CONFIG_DIR = claudeDir;
    const proj = path.join(claudeDir, 'projects', projectDirName('C:\\work\\my app'));
    await fs.mkdir(proj, { recursive: true });
    await fs.writeFile(path.join(proj, 'old.jsonl'), '');
    await new Promise((r) => setTimeout(r, 20));
    await fs.writeFile(path.join(proj, 'new.jsonl'), '');
    expect(path.basename(await findTranscript({ cwd: 'C:\\work\\my app' }))).toBe('new.jsonl');
    expect(path.basename(await findTranscript({ cwd: 'C:\\elsewhere', sessionId: 'old' }))).toBe('old.jsonl');
    delete process.env.CLAUDE_CONFIG_DIR;
  });
});

describe('resync passport|tree|summary --api (mocked provider)', () => {
  /** OpenAI-compatible streaming reply with the given text. */
  const streamingFetch = (text, calls = []) => async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    const chunks = text.match(/[\s\S]{1,25}/g).map((c) => `data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}\n\n`);
    return new Response(chunks.join('') + 'data: [DONE]\n\n', { status: 200 });
  };

  async function setup() {
    const cwd = await tempDir('proj-');
    const transcript = path.join(cwd, 'session.jsonl');
    await fs.writeFile(transcript, TRANSCRIPT);
    const cfg = await loadConfig();
    cfg.ai.providers.local = { type: 'openai-compatible', baseUrl: 'http://local.test/v1', defaultModel: 'qwen' };
    await saveConfig(cfg);
    return { cwd, transcript, cfg: await loadConfig() };
  }

  it('writes a passport with every section and says the text is sent to the provider', async () => {
    const { cwd, transcript, cfg } = await setup();
    const reply = PASSPORT_SECTIONS.map((s) => `## ${s}\n${s} details`).join('\n\n');
    const calls = [];
    const errs = [];
    const r = await runApiFeature('passport', { config: cfg, cwd, transcript, out: () => {}, err: (s) => errs.push(s), write: () => {}, fetch: streamingFetch(reply, calls), now: new Date('2026-10-17T10:00:00Z') });
    expect(r.ok).toBe(true);
    const md = await fs.readFile(r.file, 'utf8');
    expect(md).toContain('## Next 3 steps\n\nNext 3 steps details');
    expect(r.file).toContain(path.join('.resync', 'passports'));
    expect(errs.join()).toMatch(/API mode: sending this conversation .* to local/);
    const sent = calls[0].body.messages.at(-1).content;
    expect(sent).toContain('Build the login page');
    expect(sent).not.toContain('secret thoughts');
    expect(calls[0].body.model).toBe('qwen');
  });

  it('asks the model once to repair a passport with missing sections', async () => {
    const { cwd, transcript, cfg } = await setup();
    const complete7 = PASSPORT_SECTIONS.map((s) => `## ${s}\nfixed ${s}`).join('\n\n');
    const calls = [];
    const fetch = async (url, init) => {
      const body = JSON.parse(init.body);
      calls.push(body);
      if (body.stream) {
        return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: '## Goal\nonly a goal' } }] })}\n\ndata: [DONE]\n\n`, { status: 200 });
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: complete7 } }] }), { status: 200 });
    };
    const errs = [];
    const r = await runApiFeature('passport', { config: cfg, cwd, transcript, out: () => {}, err: (s) => errs.push(s), write: () => {}, fetch });
    expect(calls).toHaveLength(2);
    expect(calls[1].messages.at(-1).content).toMatch(/missing these sections: Current state/);
    expect(r.ok).toBe(true);
    expect(await fs.readFile(r.file, 'utf8')).toContain('fixed Dead ends');
    expect(errs.join()).toMatch(/asking the model to fix it once/);
  });

  it('writes a validated tree as JSON plus a Mermaid mindmap', async () => {
    const { cwd, transcript, cfg } = await setup();
    const tree = { topic: 'Login page', turnRange: [1, 2], children: [{ topic: 'Form', turnRange: [2, 2], children: [] }] };
    const r = await runApiFeature('tree', { config: cfg, cwd, transcript, out: () => {}, err: () => {}, write: () => {}, fetch: streamingFetch('```json\n' + JSON.stringify(tree) + '\n```') });
    expect(JSON.parse(await fs.readFile(r.file, 'utf8'))).toEqual(tree);
    expect(await fs.readFile(r.file.replace(/\.json$/, '.mmd'), 'utf8')).toMatch(/^mindmap\n {2}root\(\(Login page\)\)/);
  });

  it('rejects an invalid tree reply and writes a summary of 5 to 10 lines', async () => {
    const { cwd, transcript, cfg } = await setup();
    await expect(runApiFeature('tree', { config: cfg, cwd, transcript, out: () => {}, err: () => {}, fetch: streamingFetch('no json here') })).rejects.toThrow(/not valid/);
    const r = await runApiFeature('summary', { config: cfg, cwd, transcript, out: () => {}, err: () => {}, write: () => {}, fetch: streamingFetch('- a\n- b\n- c\n- d\n- e\n- f') });
    expect((await fs.readFile(r.file, 'utf8')).trim().split('\n')).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
  });

  it('explains how to proceed when no transcript can be found', async () => {
    const { cwd, cfg } = await setup();
    process.env.CLAUDE_CONFIG_DIR = await tempDir('empty-claude-');
    await expect(runApiFeature('summary', { config: cfg, cwd, out: () => {}, err: () => {} })).rejects.toThrow(/--transcript/);
    delete process.env.CLAUDE_CONFIG_DIR;
  });
});
