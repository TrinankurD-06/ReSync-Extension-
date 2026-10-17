// Anthropic Messages API adapter. Facts: docs/VERIFIED.md, section "Anthropic".
import { requestJson, joinUrl } from '../http.js';
import { parseSse } from '../sse.js';
import { classifyHttpError, ProviderError } from '../errors.js';
import { originPattern } from './openai.js';

const VERSION = '2023-06-01';
const DEFAULT_MAX_TOKENS = 4096; // max_tokens is required by the API.

/** @param {any} cfg */
function headers(cfg) {
  return {
    'x-api-key': cfg.apiKey ?? '',
    'anthropic-version': VERSION,
    // Needed when the request comes from a browser context (the extension's service worker).
    ...(cfg.browser ? { 'anthropic-dangerous-direct-browser-access': 'true' } : {}),
  };
}

/** @param {any} req */
function body(req, stream) {
  return {
    model: req.model,
    max_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
    ...(req.system ? { system: req.system } : {}),
    messages: req.messages.map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content })),
    // No temperature/top_p/top_k: rejected on current models (verified).
    ...(stream ? { stream: true } : {}),
  };
}

/** @param {any} u */
function mapUsage(u) {
  if (!u) return undefined;
  return {
    inputTokens: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
    outputTokens: u.output_tokens ?? 0,
  };
}

/** @type {import('../index.js').Adapter} */
export default {
  type: 'anthropic',
  label: 'Anthropic (Claude API)',
  defaultBaseUrl: 'https://api.anthropic.com/v1',
  requiresKey: true,
  suggestedModels: { cheap: 'claude-haiku-5-5', strong: 'claude-opus-5-5' },
  hostPermissions: (cfg) => [originPattern(cfg.baseUrl)],

  async complete(cfg, req, opts) {
    const res = await requestJson('anthropic', joinUrl(cfg.baseUrl, 'messages'), { headers: headers(cfg), body: body(req, false) }, opts);
    const json = await res.json();
    // Thinking blocks may precede the text; keep only text blocks.
    const text = (json.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    if (json.stop_reason === 'model_context_window_exceeded' && !text) {
      throw new ProviderError({ kind: 'context_too_long', provider: 'anthropic', message: 'anthropic: the conversation exceeds the model context window' });
    }
    return { text, usage: mapUsage(json.usage), model: json.model ?? req.model, finishReason: json.stop_reason ?? undefined };
  },

  async *stream(cfg, req, opts) {
    const res = await requestJson('anthropic', joinUrl(cfg.baseUrl, 'messages'), { headers: headers(cfg), body: body(req, true) }, opts);
    let input;
    let output = 0;
    let finishReason;
    let model;
    for await (const ev of parseSse(res.body)) {
      let data;
      try {
        data = JSON.parse(ev.data);
      } catch {
        continue;
      }
      const type = data.type ?? ev.event;
      if (type === 'message_start') {
        model = data.message?.model;
        input = mapUsage(data.message?.usage);
        output = data.message?.usage?.output_tokens ?? 0;
      } else if (type === 'content_block_delta' && data.delta?.type === 'text_delta') {
        if (data.delta.text) yield { type: 'text', text: data.delta.text };
      } else if (type === 'message_delta') {
        if (data.delta?.stop_reason) finishReason = data.delta.stop_reason;
        // message_delta usage counts are cumulative.
        if (data.usage?.output_tokens != null) output = data.usage.output_tokens;
      } else if (type === 'error') {
        const errType = data.error?.type;
        const status = errType === 'overloaded_error' ? 529 : errType === 'rate_limit_error' ? 429 : errType === 'authentication_error' ? 401 : 500;
        throw classifyHttpError({ provider: 'anthropic', status, body: data });
      } else if (type === 'message_stop') {
        break;
      }
    }
    yield { type: 'done', usage: { inputTokens: input?.inputTokens ?? 0, outputTokens: output }, finishReason, model };
  },

  async listModels(cfg, opts) {
    const res = await requestJson('anthropic', joinUrl(cfg.baseUrl, 'models?limit=1000'), { headers: headers(cfg) }, opts);
    const json = await res.json();
    return (json.data ?? []).map((m) => ({ id: m.id, name: m.display_name ?? m.id }));
  },
};
