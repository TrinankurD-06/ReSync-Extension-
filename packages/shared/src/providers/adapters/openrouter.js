// OpenRouter adapter (OpenAI-style API). Facts: docs/VERIFIED.md, section "OpenRouter".
import { chatComplete, chatStream, chatListModels, bearer } from '../openaiChat.js';
import { originPattern } from './openai.js';

/** @type {import('../openaiChat.js').ChatFlavor} */
const flavor = {
  name: 'openrouter',
  systemRole: 'system',
  maxTokensField: 'max_completion_tokens',
  // Usage is always included in OpenRouter streams; stream_options is deprecated there.
  includeUsageOption: false,
  headers: (cfg) => ({
    ...bearer(cfg.apiKey),
    // Optional attribution headers. Values come from config, never hardcoded URLs.
    ...(cfg.appUrl ? { 'HTTP-Referer': cfg.appUrl } : {}),
    'X-OpenRouter-Title': cfg.appTitle ?? 'ReSync',
  }),
};

/** @type {import('../index.js').Adapter} */
export default {
  type: 'openrouter',
  label: 'OpenRouter',
  defaultBaseUrl: 'https://openrouter.ai/api/v1',
  requiresKey: true,
  suggestedModels: { cheap: 'openrouter/free', strong: 'openrouter/auto' },
  hostPermissions: (cfg) => [originPattern(cfg.baseUrl)],
  complete: (cfg, req, opts) => chatComplete(flavor, cfg, req, opts),
  stream: (cfg, req, opts) => chatStream(flavor, cfg, req, opts),
  listModels: (cfg, opts) => chatListModels(flavor, cfg, opts),
};
