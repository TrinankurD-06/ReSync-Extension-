// Generic OpenAI-compatible adapter with a custom base URL.
// Covers local models (Ollama http://localhost:11434/v1, LM Studio http://localhost:1234/v1) and other hosts.
// Facts: docs/VERIFIED.md, sections "Ollama" and "LM Studio".
import { chatComplete, chatStream, chatListModels, bearer } from '../openaiChat.js';
import { ProviderError } from '../errors.js';

/** @type {import('../openaiChat.js').ChatFlavor} */
const flavor = {
  name: 'openai-compatible',
  // "system" and max_tokens are the most widely supported spellings across compatible servers.
  systemRole: 'system',
  maxTokensField: 'max_tokens',
  includeUsageOption: true,
  headers: (cfg) => ({ ...bearer(cfg.apiKey), ...(cfg.headers ?? {}) }),
};

/** @param {any} cfg */
function requireBaseUrl(cfg) {
  if (!cfg.baseUrl) {
    throw new ProviderError({ kind: 'unknown', provider: 'openai-compatible', message: 'openai-compatible: a base URL is required (e.g. http://localhost:11434/v1 for Ollama).' });
  }
  return cfg;
}

/** @type {import('../index.js').Adapter} */
export default {
  type: 'openai-compatible',
  label: 'OpenAI-compatible (Ollama, LM Studio, other hosts)',
  defaultBaseUrl: 'http://localhost:11434/v1',
  requiresKey: false,
  suggestedModels: {},
  hostPermissions(cfg) {
    const u = new URL(requireBaseUrl(cfg).baseUrl);
    const pats = [`${u.protocol}//${u.hostname}/*`];
    // localhost and 127.0.0.1 are different origins to Chrome; request both for local servers.
    if (u.hostname === 'localhost') pats.push(`${u.protocol}//127.0.0.1/*`);
    if (u.hostname === '127.0.0.1') pats.push(`${u.protocol}//localhost/*`);
    return pats;
  },
  complete: (cfg, req, opts) => chatComplete(flavor, requireBaseUrl(cfg), req, opts),
  stream: (cfg, req, opts) => chatStream(flavor, requireBaseUrl(cfg), req, opts),
  listModels: (cfg, opts) => chatListModels(flavor, requireBaseUrl(cfg), opts),
};
