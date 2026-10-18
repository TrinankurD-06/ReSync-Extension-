// `resync passport|tree|summary --api`: generate from a session transcript through the provider layer.
// In-chat mode (the default, no key needed) lives in the Claude Code plugin commands instead.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { complete } from '@resync/shared/providers';
import { resolveFeature } from '@resync/shared/models';
import { buildApiRequest, parsePassport, renderPassport, parseTreeResponse, parseSummary, passportRepairPrompt, passportLengthWarnings, summaryAudience } from '@resync/shared/templates';
import { treeToMermaid } from '@resync/shared/tree';
import { providerConfig } from './keys.js';
import { findTranscript, loadTranscript } from './transcript.js';

const MAX_TOKENS = { passport: 4000, tree: 3000, summary: 800 };

/** @param {Date} d */
function stamp(d) {
  return d.toISOString().replace(/[:T]/g, '-').replace(/\..*$/, '');
}

/**
 * @param {'passport' | 'tree' | 'summary'} feature
 * @param {{
 *   config: import('./config.js').ReSyncConfig,
 *   cwd: string,
 *   transcript?: string, sessionId?: string,
 *   provider?: string, model?: string,
 *   audience?: string,                    summary audience: recap | slack | memory
 *   out?: (s: string) => void, err?: (s: string) => void,
 *   write?: (s: string) => void,          streaming output
 *   fetch?: typeof fetch,
 *   now?: Date,
 * }} o
 */
export async function runApiFeature(feature, o) {
  const out = o.out ?? console.log;
  const err = o.err ?? console.error;
  const now = o.now ?? new Date();

  // Throws ApiModeOffError (with instructions) if no provider is set up.
  const route = resolveFeature(o.config.ai, feature, { forceApi: true, provider: o.provider, model: o.model });
  if (route.mode !== 'api') throw new Error('unreachable');
  const provider = await providerConfig(o.config, route.providerId);

  const file = o.transcript ?? (await findTranscript({ cwd: o.cwd, sessionId: o.sessionId }));
  if (!file) {
    throw new Error(`No Claude Code transcript found for ${o.cwd}. Pass --transcript <file> (a session .jsonl, or a conversation exported with /export).`);
  }
  const messages = await loadTranscript(file);

  // Privacy: API mode sends the conversation text to the provider. Say so every time.
  err(`[resync] API mode: sending this conversation (${messages.length} turns from ${path.basename(file)}) to ${route.providerId} (${provider.baseUrl ?? provider.type}), model ${route.model}.`);

  const audience = summaryAudience(o.audience);
  if (feature === 'summary' && o.audience && audience !== o.audience) err(`[resync] unknown audience "${o.audience}"; using recap (choices: recap, slack, memory)`);
  const project = path.basename(o.cwd);
  const sessionId = path.basename(file, '.jsonl');
  // Meta comes from ReSync (date, project, transcript), not from the model.
  const req = buildApiRequest(feature, messages, { meta: { project, source: `Claude Code session ${sessionId}` }, audience });
  const stream = await complete({ provider, model: route.model, system: req.system, messages: /** @type {any} */ (req.messages), maxTokens: MAX_TOKENS[feature], stream: true }, { fetch: o.fetch });
  let text = '';
  for await (const delta of stream) {
    text += delta;
    if (feature !== 'tree') o.write?.(delta);
  }
  if (feature !== 'tree') o.write?.('\n');
  const result = await stream.result;

  const baseDir = path.join(o.cwd, '.resync');
  if (feature === 'passport') {
    let p = parsePassport(text);
    if (!p.ok) {
      // Smaller models sometimes drop or rename a heading: ask once for a corrected version.
      err(`[resync] the reply is missing sections (${p.missing.join(', ')}); asking the model to fix it once`);
      const fix = await complete({
        provider, model: route.model, system: req.system, maxTokens: MAX_TOKENS.passport,
        messages: [...(/** @type {any} */ (req.messages)), { role: 'assistant', content: text }, { role: 'user', content: passportRepairPrompt(p.missing) }],
      }, { fetch: o.fetch });
      const fixed = parsePassport(fix.text);
      if (fixed.missing.length < p.missing.length) {
        text = fix.text;
        p = fixed;
      }
      if (!p.ok) err(`[resync] warning: still missing sections: ${p.missing.join(', ')} (saved with "None")`);
    }
    for (const w of passportLengthWarnings(p.sections)) err(`[resync] note: over the length cap: ${w}`);
    const md = renderPassport(p.sections, { createdAt: now, project, source: `Claude Code session ${sessionId}`, mode: `API mode: ${route.providerId}/${route.model}` });
    const dir = path.join(baseDir, 'passports');
    await fs.mkdir(dir, { recursive: true });
    const f = path.join(dir, `${stamp(now)}.md`);
    await fs.writeFile(f, md, 'utf8');
    out(`Saved passport: ${f}`);
    return { file: f, usage: result.usage, ok: p.ok, missing: p.missing, text };
  }
  if (feature === 'tree') {
    const t = parseTreeResponse(text, { turns: messages.length });
    if (!t.ok) throw new Error(`The model's topic tree was not valid: ${t.errors.join('; ')}`);
    for (const w of t.warnings) err(`[resync] fixed: ${w}`);
    const dir = path.join(baseDir, 'trees');
    await fs.mkdir(dir, { recursive: true });
    const base = path.join(dir, stamp(now));
    const mermaid = treeToMermaid(t.tree);
    await fs.writeFile(`${base}.json`, JSON.stringify(t.tree, null, 2) + '\n', 'utf8');
    await fs.writeFile(`${base}.mmd`, mermaid + '\n', 'utf8');
    o.write?.(mermaid + '\n');
    out(`Saved topic tree: ${base}.json and ${base}.mmd`);
    return { file: `${base}.json`, usage: result.usage, ok: true };
  }
  const s = parseSummary(text, { audience });
  if (s.warning) err(`[resync] note: ${s.warning}`);
  const dir = path.join(baseDir, 'summaries');
  await fs.mkdir(dir, { recursive: true });
  const f = path.join(dir, `${stamp(now)}.md`);
  await fs.writeFile(f, s.lines.join('\n') + '\n', 'utf8');
  out(`Saved summary: ${f}`);
  return { file: f, usage: result.usage, ok: s.ok };
}
