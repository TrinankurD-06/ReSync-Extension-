// The provider layer: one interface for every AI call (bring your own provider, model and key).
// Adding a provider = one adapter file + registerAdapter (see docs/PROVIDERS.md).
import anthropic from './adapters/anthropic.js';
import openai from './adapters/openai.js';
import gemini from './adapters/gemini.js';
import openrouter from './adapters/openrouter.js';
import openaiCompatible from './adapters/openaiCompatible.js';
import { ProviderError } from './errors.js';

export { ProviderError, ERROR_KINDS, classifyHttpError } from './errors.js';
export { parseSse } from './sse.js';

/**
 * @typedef {{ role: 'user' | 'assistant', content: string }} ChatMessage
 * @typedef {{ inputTokens: number, outputTokens: number }} Usage
 * @typedef {{ text: string, usage?: Usage, model?: string, finishReason?: string }} CompletionResult
 * @typedef {{ type: 'text', text: string } | { type: 'done', usage?: Usage, finishReason?: string, model?: string }} StreamEvent
 * @typedef {{
 *   type: string,          adapter type, e.g. "anthropic"
 *   apiKey?: string,       lives only on the user's device
 *   baseUrl?: string,      defaults to the adapter's defaultBaseUrl
 *   browser?: boolean,     set by the extension's service worker
 *   [k: string]: unknown,
 * }} ProviderConfig
 * @typedef {{ model: string, messages: ChatMessage[], system?: string, maxTokens?: number }} AdapterRequest
 * @typedef {import('./http.js').HttpOptions} CallOptions
 * @typedef {{
 *   type: string,
 *   label: string,
 *   defaultBaseUrl: string,
 *   requiresKey: boolean,
 *   suggestedModels: { cheap?: string, strong?: string },
 *   hostPermissions: (cfg: ProviderConfig & { baseUrl: string }) => string[],
 *   complete: (cfg: ProviderConfig & { baseUrl: string }, req: AdapterRequest, opts?: CallOptions) => Promise<CompletionResult>,
 *   stream: (cfg: ProviderConfig & { baseUrl: string }, req: AdapterRequest, opts?: CallOptions) => AsyncIterable<StreamEvent>,
 *   listModels?: (cfg: ProviderConfig & { baseUrl: string }, opts?: CallOptions) => Promise<{ id: string, name: string }[]>,
 *   speak?: (cfg: ProviderConfig & { baseUrl: string }, req: { text: string, voice?: string, model?: string, format?: string, speed?: number }, opts?: CallOptions) => Promise<{ audio: ArrayBuffer, mimeType: string }>,
 * }} Adapter
 */

/** @type {Map<string, Adapter>} */
const registry = new Map();

/** Register (or replace) an adapter. @param {Adapter} adapter */
export function registerAdapter(adapter) {
  for (const k of ['type', 'label', 'defaultBaseUrl', 'complete', 'stream', 'hostPermissions']) {
    if (!(k in adapter)) throw new Error(`Adapter is missing "${k}"`);
  }
  registry.set(adapter.type, adapter);
}

for (const a of [anthropic, openai, gemini, openrouter, openaiCompatible]) registerAdapter(a);

/** @param {string} type */
export function getAdapter(type) {
  const a = registry.get(type);
  if (!a) throw new ProviderError({ kind: 'unknown', provider: type, message: `Unknown provider type "${type}". Known: ${[...registry.keys()].join(', ')}` });
  return a;
}

export function listAdapters() {
  return [...registry.values()].map((a) => ({ type: a.type, label: a.label, defaultBaseUrl: a.defaultBaseUrl, requiresKey: a.requiresKey, suggestedModels: a.suggestedModels, canSpeak: typeof a.speak === 'function', canListModels: typeof a.listModels === 'function' }));
}

/** @param {ProviderConfig} provider */
function prepare(provider) {
  if (!provider?.type) throw new ProviderError({ kind: 'unknown', provider: 'unknown', message: 'No provider given. API mode needs a provider; in-chat mode needs none.' });
  const adapter = getAdapter(provider.type);
  if (adapter.requiresKey && !provider.apiKey) {
    throw new ProviderError({ kind: 'auth', provider: adapter.type, message: `${adapter.type}: no API key set. Add one with \`resync keys set ${adapter.type}\` (CLI) or in Settings (extension).` });
  }
  return { adapter, cfg: { ...provider, baseUrl: provider.baseUrl || adapter.defaultBaseUrl } };
}

/**
 * Wrap an adapter event stream: iterate it for text deltas; `result` resolves when it ends.
 * @param {AsyncIterable<StreamEvent>} events
 */
function toCompletionStream(events) {
  /** @type {(v: CompletionResult) => void} */
  let resolve = () => {};
  /** @type {(e: unknown) => void} */
  let reject = () => {};
  /** @type {Promise<CompletionResult>} */
  const result = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  result.catch(() => {}); // callers may only iterate; avoid unhandled rejections
  let text = '';
  async function* run() {
    let done = false;
    try {
      for await (const ev of events) {
        if (ev.type === 'text') {
          text += ev.text;
          yield ev.text;
        } else if (ev.type === 'done') {
          done = true;
          resolve({ text, usage: ev.usage, model: ev.model, finishReason: ev.finishReason });
        }
      }
      if (!done) resolve({ text });
    } catch (e) {
      reject(e);
      throw e;
    }
  }
  const it = run();
  return {
    [Symbol.asyncIterator]: () => it,
    result,
    /** Drain the stream and return the full text. */
    async text() {
      for await (const _ of it) {
        /* drain */
      }
      return (await result).text;
    },
  };
}

/**
 * Complete a chat with any provider.
 * - stream false (default): resolves to { text, usage, model, finishReason }.
 * - stream true: resolves to an async iterable of text deltas with a `result` promise and a `text()` helper.
 * @template {boolean} [S=false]
 * @param {{ provider: ProviderConfig, model: string, messages: ChatMessage[], system?: string, maxTokens?: number, stream?: S }} req
 * @param {CallOptions} [opts]
 * @returns {Promise<S extends true ? AsyncIterable<string> & { result: Promise<CompletionResult>, text(): Promise<string> } : CompletionResult>}
 */
export async function complete(req, opts) {
  const { adapter, cfg } = prepare(req.provider);
  if (!req.model) throw new ProviderError({ kind: 'unknown', provider: adapter.type, message: `${adapter.type}: no model chosen` });
  if (!Array.isArray(req.messages) || req.messages.length === 0) {
    throw new ProviderError({ kind: 'unknown', provider: adapter.type, message: `${adapter.type}: messages must be a non-empty array` });
  }
  const areq = { model: req.model, messages: req.messages, system: req.system, maxTokens: req.maxTokens };
  if (req.stream) return /** @type {any} */ (toCompletionStream(adapter.stream(cfg, areq, opts)));
  return /** @type {any} */ (await adapter.complete(cfg, areq, opts));
}

/**
 * List models where the provider supports it.
 * @param {ProviderConfig} provider
 * @param {CallOptions} [opts]
 */
export async function listModels(provider, opts) {
  const { adapter, cfg } = prepare(provider);
  if (!adapter.listModels) return [];
  return adapter.listModels(cfg, opts);
}

/**
 * Check that the provider is reachable and the key works. Never throws.
 * Uses the model list when available (free), else a tiny completion with `model`.
 * @param {ProviderConfig} provider
 * @param {{ model?: string } & CallOptions} [opts]
 * @returns {Promise<{ ok: true, provider: string, detail: string, latencyMs: number } | { ok: false, provider: string, error: ReturnType<ProviderError['toJSON']> }>}
 */
export async function testConnection(provider, opts = {}) {
  const started = Date.now();
  const type = provider?.type ?? 'unknown';
  try {
    const { adapter } = prepare(provider);
    let detail;
    if (adapter.listModels && !opts.model) {
      const models = await listModels(provider, opts);
      detail = `${models.length} model(s) available`;
    } else {
      const model = opts.model ?? adapter.suggestedModels.cheap;
      if (!model) throw new ProviderError({ kind: 'unknown', provider: type, message: `${type}: pass a model to test with` });
      const r = await complete({ provider, model, messages: [{ role: 'user', content: 'Reply with the word OK.' }], maxTokens: 16 }, opts);
      detail = `model ${model} replied (${r.text.trim().slice(0, 20) || 'empty reply'})`;
    }
    return { ok: true, provider: type, detail, latencyMs: Date.now() - started };
  } catch (e) {
    const err = e instanceof ProviderError ? e : new ProviderError({ kind: 'unknown', provider: type, message: String(/** @type {any} */ (e)?.message ?? e) });
    return { ok: false, provider: type, error: err.toJSON() };
  }
}

/**
 * Optional provider text-to-speech.
 * @param {ProviderConfig} provider
 * @param {{ text: string, voice?: string, model?: string, format?: string, speed?: number }} req
 * @param {CallOptions} [opts]
 */
export async function speak(provider, req, opts) {
  const { adapter, cfg } = prepare(provider);
  if (!adapter.speak) throw new ProviderError({ kind: 'unknown', provider: adapter.type, message: `${adapter.type}: text to speech is not supported by this adapter` });
  return adapter.speak(cfg, req, opts);
}

/**
 * Host permission patterns the extension must request for a provider (optional permissions).
 * @param {ProviderConfig} provider
 */
export function hostPermissionsFor(provider) {
  const adapter = getAdapter(provider.type);
  return adapter.hostPermissions({ ...provider, baseUrl: provider.baseUrl || adapter.defaultBaseUrl });
}
