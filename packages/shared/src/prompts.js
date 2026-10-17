// Prompt library format: Markdown files with YAML frontmatter.
// Works in Node and in the browser (no fs access here; callers pass text in).
import YAML from 'yaml';
import { z } from 'zod';

/**
 * @typedef {{ name: string, description?: string, default?: string }} PromptVariable
 * @typedef {{ text: string, waitFor: 'response' | 'timer', delaySeconds: number }} PromptStep
 * @typedef {{
 *   slug: string,
 *   title: string,
 *   category: string,
 *   tags: string[],
 *   description: string,
 *   scope: 'personal' | 'team',
 *   variables: PromptVariable[],
 *   steps: PromptStep[],
 *   body: string,
 * }} Prompt
 */

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const VAR_RE = /\{\{\s*([A-Za-z_][A-Za-z0-9_-]*)\s*\}\}/g;
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/;

const variableSchema = z.object({
  name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_-]*$/, 'variable names use letters, digits, _ or -'),
  description: z.string().optional(),
  default: z.string().optional(),
});

const stepSchema = z.object({
  text: z.string().min(1, 'step text is required'),
  // "response": send after the previous reply finishes. "timer": also wait delaySeconds after it finishes.
  waitFor: z.enum(['response', 'timer']),
  delaySeconds: z.number().int().min(0).max(24 * 3600),
});

export const promptSchema = z
  .object({
    slug: z.string().regex(SLUG_RE, 'slug must be lowercase-kebab-case'),
    title: z.string().min(1, 'title is required').max(200),
    category: z.string().regex(SLUG_RE, 'category must be lowercase-kebab-case'),
    tags: z.array(z.string().min(1).max(50)).max(30),
    description: z.string().max(1000),
    scope: z.enum(['personal', 'team']),
    variables: z.array(variableSchema),
    steps: z.array(stepSchema),
    body: z.string(),
  })
  .superRefine((p, ctx) => {
    if (!p.body.trim() && p.steps.length === 0) {
      ctx.addIssue({ code: 'custom', message: 'a prompt needs a body or at least one step', path: ['body'] });
    }
    const declared = new Set(p.variables.map((v) => v.name));
    const used = extractVariables([p.body, ...p.steps.map((s) => s.text)].join('\n'));
    for (const name of used) {
      if (!declared.has(name)) {
        ctx.addIssue({ code: 'custom', message: `variable {{${name}}} is used but not declared`, path: ['variables'] });
      }
    }
  });

/**
 * Turn "My Prompt Title" or a file name into a slug.
 * @param {string} s
 */
export function slugify(s) {
  return String(s)
    .toLowerCase()
    .replace(/\.md$/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Names of all {{variables}} in a text, in first-use order.
 * @param {string} text
 * @returns {string[]}
 */
export function extractVariables(text) {
  const names = [];
  for (const m of String(text).matchAll(VAR_RE)) {
    if (!names.includes(m[1])) names.push(m[1]);
  }
  return names;
}

/** @param {unknown} v @returns {PromptVariable[]} */
function normaliseVariables(v) {
  if (!Array.isArray(v)) return [];
  return v.map((item) => {
    if (typeof item === 'string') return { name: item.replace(/^\{\{\s*|\s*\}\}$/g, '') };
    return /** @type {PromptVariable} */ (item);
  });
}

/** @param {unknown} s @returns {PromptStep[]} */
function normaliseSteps(s) {
  if (!Array.isArray(s)) return [];
  return s.map((step) => {
    if (typeof step === 'string') return { text: step, waitFor: 'response', delaySeconds: 0 };
    const st = /** @type {any} */ (step);
    return {
      text: st.text,
      waitFor: st.waitFor ?? (st.delaySeconds ? 'timer' : 'response'),
      delaySeconds: Number(st.delaySeconds ?? 0),
    };
  });
}

/**
 * Parse a prompt Markdown file. Does not validate; call validatePrompt for that.
 * @param {string} markdown
 * @param {{ path?: string, slug?: string, category?: string }} [opts]
 *   path like "prompts/dev/code-review.md" fills slug and category when frontmatter omits them.
 * @returns {Prompt}
 */
export function parsePrompt(markdown, opts = {}) {
  let src = String(markdown);
  if (src.charCodeAt(0) === 0xfeff) src = src.slice(1); // strip a byte-order mark
  const m = FRONTMATTER_RE.exec(src);
  /** @type {Record<string, any>} */
  let meta = {};
  let body = src;
  if (m) {
    const parsed = YAML.parse(m[1]);
    if (parsed && typeof parsed === 'object') meta = parsed;
    body = m[2];
  }
  const parts = (opts.path ?? '').split(/[\\/]/).filter(Boolean);
  const fileSlug = parts.length ? slugify(parts[parts.length - 1]) : '';
  const dirCategory = parts.length >= 2 ? slugify(parts[parts.length - 2]) : '';

  return {
    slug: opts.slug ?? meta.slug ?? (fileSlug || slugify(meta.title ?? '')),
    title: meta.title ?? '',
    category: meta.category ?? opts.category ?? dirCategory,
    tags: Array.isArray(meta.tags) ? meta.tags.map(String) : typeof meta.tags === 'string' ? meta.tags.split(',').map((t) => t.trim()).filter(Boolean) : [],
    description: meta.description ?? '',
    scope: meta.scope ?? 'personal',
    variables: normaliseVariables(meta.variables),
    steps: normaliseSteps(meta.steps),
    body: body.replace(/^\r?\n/, '').replace(/\s+$/, '') + (body.trim() ? '\n' : ''),
  };
}

/**
 * Validate a parsed prompt.
 * @param {unknown} prompt
 * @returns {{ ok: true, prompt: Prompt, errors: [] } | { ok: false, errors: string[] }}
 */
export function validatePrompt(prompt) {
  const r = promptSchema.safeParse(prompt);
  if (r.success) return { ok: true, prompt: /** @type {Prompt} */ (r.data), errors: [] };
  return {
    ok: false,
    errors: r.error.issues.map((i) => `${i.path.length ? i.path.join('.') + ': ' : ''}${i.message}`),
  };
}

/**
 * Replace {{variables}} with values. Missing values fall back to defaults, then are left as-is
 * (or throw when `strict`).
 * @param {string} text
 * @param {Record<string, string>} values
 * @param {{ defaults?: PromptVariable[], strict?: boolean }} [opts]
 */
export function renderVariables(text, values = {}, opts = {}) {
  const defaults = Object.fromEntries((opts.defaults ?? []).filter((v) => v.default != null).map((v) => [v.name, v.default]));
  const missing = [];
  const out = String(text).replace(VAR_RE, (whole, name) => {
    if (values[name] != null && values[name] !== '') return String(values[name]);
    if (defaults[name] != null) return String(defaults[name]);
    missing.push(name);
    return whole;
  });
  if (opts.strict && missing.length) {
    throw new Error(`Missing values for: ${[...new Set(missing)].join(', ')}`);
  }
  return out;
}

/**
 * Serialise a prompt back to Markdown with frontmatter.
 * @param {Prompt} p
 */
export function serializePrompt(p) {
  /** @type {Record<string, any>} */
  const meta = {
    title: p.title,
    category: p.category,
    tags: p.tags,
    description: p.description,
    scope: p.scope,
  };
  if (p.variables.length) meta.variables = p.variables.map((v) => (v.description || v.default ? v : v.name));
  if (p.steps.length) meta.steps = p.steps;
  return `---\n${YAML.stringify(meta).trimEnd()}\n---\n\n${p.body.trimEnd()}\n`;
}

/**
 * Pack prompts into a portable JSON library (used by sync and export).
 * @param {Prompt[]} prompts
 */
export function libraryToJson(prompts) {
  return {
    format: 'resync-prompt-library',
    version: 1,
    prompts: prompts.map((p) => ({ ...p })),
  };
}

/**
 * Unpack a JSON library. Invalid prompts are reported, not thrown.
 * @param {unknown} json object or JSON string
 * @returns {{ prompts: Prompt[], errors: { slug: string, errors: string[] }[] }}
 */
export function jsonToLibrary(json) {
  const data = typeof json === 'string' ? JSON.parse(json) : json;
  const list = Array.isArray(data) ? data : /** @type {any} */ (data)?.prompts;
  if (!Array.isArray(list)) throw new Error('Not a ReSync prompt library: expected { prompts: [...] }');
  /** @type {Prompt[]} */
  const prompts = [];
  const errors = [];
  for (const raw of list) {
    const candidate = {
      tags: [],
      description: '',
      scope: 'personal',
      body: '',
      ...raw,
      variables: normaliseVariables(raw?.variables ?? []),
      steps: normaliseSteps(raw?.steps ?? []),
    };
    const r = validatePrompt(candidate);
    if (r.ok) prompts.push(r.prompt);
    else errors.push({ slug: String(raw?.slug ?? '?'), errors: r.errors });
  }
  return { prompts, errors };
}

/**
 * Text of a prompt for one-shot use: the body, or the first step for chains.
 * @param {Prompt} p
 */
export function promptText(p) {
  return p.body.trim() ? p.body : (p.steps[0]?.text ?? '');
}
