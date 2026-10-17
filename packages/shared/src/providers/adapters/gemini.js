// Google Gemini (generateContent) adapter. Facts: docs/VERIFIED.md, section "Google Gemini API".
import { requestJson, joinUrl } from '../http.js';
import { parseSse } from '../sse.js';
import { ProviderError } from '../errors.js';
import { originPattern } from './openai.js';

/** @param {any} cfg */
function headers(cfg) {
  // Header auth keeps the key out of URLs (and out of any logs of URLs).
  return { 'x-goog-api-key': cfg.apiKey ?? '' };
}

/** @param {string} model */
function modelPath(model) {
  return `models/${encodeURIComponent(String(model).replace(/^models\//, ''))}`;
}

/** @param {any} req */
function body(req) {
  return {
    ...(req.system ? { systemInstruction: { parts: [{ text: req.system }] } } : {}),
    contents: req.messages.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
    ...(req.maxTokens ? { generationConfig: { maxOutputTokens: req.maxTokens } } : {}),
  };
}

/** Text of a response chunk, skipping thought parts. @param {any} json */
function chunkText(json) {
  const parts = json?.candidates?.[0]?.content?.parts ?? [];
  return parts.filter((p) => !p.thought && typeof p.text === 'string').map((p) => p.text).join('');
}

/** @param {any} u */
function mapUsage(u) {
  if (!u) return undefined;
  return { inputTokens: u.promptTokenCount ?? 0, outputTokens: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0) };
}

/** @param {any} json */
function checkBlocked(json) {
  if (json?.promptFeedback?.blockReason && !json?.candidates?.length) {
    throw new ProviderError({ kind: 'unknown', provider: 'gemini', message: `gemini: prompt blocked (${json.promptFeedback.blockReason})` });
  }
}

/** @type {import('../index.js').Adapter} */
export default {
  type: 'gemini',
  label: 'Google Gemini',
  defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta',
  requiresKey: true,
  suggestedModels: { cheap: 'gemini-3.5-flash-lite', strong: 'gemini-3.8-flash' },
  hostPermissions: (cfg) => [originPattern(cfg.baseUrl)],

  async complete(cfg, req, opts) {
    const url = joinUrl(cfg.baseUrl, `${modelPath(req.model)}:generateContent`);
    const res = await requestJson('gemini', url, { headers: headers(cfg), body: body(req) }, opts);
    const json = await res.json();
    checkBlocked(json);
    return { text: chunkText(json), usage: mapUsage(json.usageMetadata), model: req.model, finishReason: json.candidates?.[0]?.finishReason };
  },

  async *stream(cfg, req, opts) {
    const url = joinUrl(cfg.baseUrl, `${modelPath(req.model)}:streamGenerateContent?alt=sse`);
    const res = await requestJson('gemini', url, { headers: headers(cfg), body: body(req) }, opts);
    let usage;
    let finishReason;
    // Each data line is a full GenerateContentResponse chunk; the stream simply ends.
    for await (const ev of parseSse(res.body)) {
      let json;
      try {
        json = JSON.parse(ev.data);
      } catch {
        continue;
      }
      checkBlocked(json);
      const t = chunkText(json);
      if (t) yield { type: 'text', text: t };
      if (json.usageMetadata) usage = mapUsage(json.usageMetadata);
      finishReason = json.candidates?.[0]?.finishReason ?? finishReason;
    }
    yield { type: 'done', usage, finishReason, model: req.model };
  },

  async listModels(cfg, opts) {
    const out = [];
    let token = '';
    for (let page = 0; page < 10; page++) {
      const q = `models?pageSize=1000${token ? `&pageToken=${encodeURIComponent(token)}` : ''}`;
      const res = await requestJson('gemini', joinUrl(cfg.baseUrl, q), { headers: headers(cfg) }, opts);
      const json = await res.json();
      for (const m of json.models ?? []) {
        if (!(m.supportedGenerationMethods ?? []).includes('generateContent')) continue;
        out.push({ id: String(m.name).replace(/^models\//, ''), name: m.displayName ?? m.name });
      }
      token = json.nextPageToken;
      if (!token) break;
    }
    return out;
  },
};
