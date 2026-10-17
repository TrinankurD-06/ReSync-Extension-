// Shared core for OpenAI-style /chat/completions APIs (OpenAI, OpenRouter, Ollama, LM Studio, other hosts).
// Differences are passed in as options so each adapter file stays small.
import { requestJson, joinUrl } from './http.js';
import { parseSse } from './sse.js';
import { classifyHttpError, ProviderError } from './errors.js';

/**
 * @typedef {{
 *   name: string,                     provider name for errors
 *   systemRole: 'system' | 'developer',
 *   maxTokensField: 'max_tokens' | 'max_completion_tokens',
 *   headers: (cfg: any) => Record<string, string>,
 *   includeUsageOption?: boolean,     send stream_options.include_usage
 * }} ChatFlavor
 */

/**
 * @param {ChatFlavor} flavor
 * @param {{ model: string, messages: { role: string, content: string }[], system?: string, maxTokens?: number }} req
 * @param {boolean} stream
 */
function buildBody(flavor, req, stream) {
  const messages = [];
  if (req.system) messages.push({ role: flavor.systemRole, content: req.system });
  for (const m of req.messages) messages.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content });
  /** @type {Record<string, unknown>} */
  const body = { model: req.model, messages };
  if (req.maxTokens) body[flavor.maxTokensField] = req.maxTokens;
  if (stream) {
    body.stream = true;
    if (flavor.includeUsageOption) body.stream_options = { include_usage: true };
  }
  return body;
}

/** @param {any} u */
function mapUsage(u) {
  if (!u) return undefined;
  return { inputTokens: u.prompt_tokens ?? 0, outputTokens: u.completion_tokens ?? 0 };
}

/**
 * Non-streaming completion.
 * @param {ChatFlavor} flavor
 * @param {{ baseUrl: string, apiKey?: string }} cfg
 * @param {any} req
 * @param {import('./http.js').HttpOptions} [opts]
 */
export async function chatComplete(flavor, cfg, req, opts) {
  const res = await requestJson(flavor.name, joinUrl(cfg.baseUrl, 'chat/completions'), { headers: flavor.headers(cfg), body: buildBody(flavor, req, false) }, opts);
  const json = await res.json();
  // OpenRouter can return an error object with HTTP 200.
  if (json?.error) throw classifyHttpError({ provider: flavor.name, status: Number(json.error.code) || 500, body: json });
  const choice = json?.choices?.[0];
  const content = choice?.message?.content;
  const text = Array.isArray(content) ? content.map((p) => p?.text ?? '').join('') : String(content ?? '');
  return { text, usage: mapUsage(json.usage), model: json.model ?? req.model, finishReason: choice?.finish_reason ?? undefined };
}

/**
 * Streaming completion: yields text deltas, then a final { done } item.
 * @param {ChatFlavor} flavor
 * @param {{ baseUrl: string, apiKey?: string }} cfg
 * @param {any} req
 * @param {import('./http.js').HttpOptions} [opts]
 * @returns {AsyncGenerator<{ type: 'text', text: string } | { type: 'done', usage?: { inputTokens: number, outputTokens: number }, finishReason?: string, model?: string }>}
 */
export async function* chatStream(flavor, cfg, req, opts) {
  const res = await requestJson(flavor.name, joinUrl(cfg.baseUrl, 'chat/completions'), { headers: flavor.headers(cfg), body: buildBody(flavor, req, true) }, opts);
  let usage;
  let finishReason;
  let model;
  for await (const ev of parseSse(res.body)) {
    if (ev.data === '[DONE]') break;
    let chunk;
    try {
      chunk = JSON.parse(ev.data);
    } catch {
      continue;
    }
    if (chunk.error) {
      // Mid-stream error with HTTP 200 (documented for OpenRouter).
      const status = Number(chunk.error.code) || 500;
      throw classifyHttpError({ provider: flavor.name, status, body: chunk });
    }
    model ??= chunk.model;
    if (chunk.usage) usage = mapUsage(chunk.usage);
    const choice = chunk.choices?.[0];
    if (choice?.finish_reason) finishReason = choice.finish_reason;
    const delta = choice?.delta?.content;
    if (typeof delta === 'string' && delta) yield { type: 'text', text: delta };
  }
  yield { type: 'done', usage, finishReason, model };
}

/**
 * GET /models.
 * @param {ChatFlavor} flavor
 * @param {{ baseUrl: string, apiKey?: string }} cfg
 * @param {import('./http.js').HttpOptions} [opts]
 * @returns {Promise<{ id: string, name: string }[]>}
 */
export async function chatListModels(flavor, cfg, opts) {
  const res = await requestJson(flavor.name, joinUrl(cfg.baseUrl, 'models'), { headers: flavor.headers(cfg) }, opts);
  const json = await res.json();
  const data = Array.isArray(json?.data) ? json.data : Array.isArray(json) ? json : null;
  if (!data) throw new ProviderError({ kind: 'unknown', provider: flavor.name, message: `${flavor.name}: unexpected /models response` });
  return data.map((m) => ({ id: String(m.id), name: String(m.name ?? m.id) }));
}

/** Bearer auth header when a key is set. */
export function bearer(apiKey) {
  return apiKey ? { authorization: `Bearer ${apiKey}` } : {};
}
