// OpenAI adapter. Facts: docs/VERIFIED.md, section "OpenAI".
import { chatComplete, chatStream, chatListModels, bearer } from '../openaiChat.js';
import { requestJson, joinUrl } from '../http.js';

/** @type {import('../openaiChat.js').ChatFlavor} */
const flavor = {
  name: 'openai',
  systemRole: 'developer',
  maxTokensField: 'max_completion_tokens',
  includeUsageOption: true,
  headers: (cfg) => bearer(cfg.apiKey),
};

/** @type {import('../index.js').Adapter} */
export default {
  type: 'openai',
  label: 'OpenAI',
  defaultBaseUrl: 'https://api.openai.com/v1',
  requiresKey: true,
  suggestedModels: { cheap: 'gpt-6-luna', strong: 'gpt-6-astra' },
  hostPermissions: (cfg) => [originPattern(cfg.baseUrl)],
  complete: (cfg, req, opts) => chatComplete(flavor, cfg, req, opts),
  stream: (cfg, req, opts) => chatStream(flavor, cfg, req, opts),
  async listModels(cfg, opts) {
    // /models includes TTS, embedding and image models; keep likely chat models.
    const all = await chatListModels(flavor, cfg, opts);
    return all.filter((m) => !/tts|whisper|embedding|dall-e|image|moderation|audio|realtime|transcribe/i.test(m.id));
  },
  /**
   * Text to speech. Returns audio bytes (mp3 by default).
   * @param {any} cfg
   * @param {{ text: string, voice?: string, model?: string, format?: string, speed?: number }} req
   * @param {import('../http.js').HttpOptions} [opts]
   */
  async speak(cfg, req, opts) {
    const res = await requestJson(
      'openai',
      joinUrl(cfg.baseUrl, 'audio/speech'),
      {
        headers: bearer(cfg.apiKey),
        body: {
          model: req.model ?? 'gpt-4o-mini-tts',
          voice: req.voice ?? 'marin',
          input: String(req.text).slice(0, 4096),
          response_format: req.format ?? 'mp3',
          ...(req.speed ? { speed: req.speed } : {}),
        },
      },
      opts,
    );
    return { audio: await res.arrayBuffer(), mimeType: `audio/${req.format === 'wav' ? 'wav' : req.format ?? 'mpeg'}` };
  },
};

/** @param {string} url */
export function originPattern(url) {
  const u = new URL(url);
  return `${u.protocol}//${u.hostname}/*`;
}
