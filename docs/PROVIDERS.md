# Providers (bring your own model and key)

ReSync works fully **without any API key**. Every AI feature (passport, topic tree, summary, prompt tools) runs **in-chat** by default: ReSync sends the prompt inside your current Claude chat or Claude Code session, so it uses the plan you already have.

**API mode** is optional and off until you add a provider. ReSync then calls that provider directly with your key. In API mode the conversation text **is sent to that provider**. ReSync says so the first time, and again per feature.

## Built-in adapters

| Type | Default base URL | Key | Notes |
|---|---|---|---|
| `anthropic` | `https://api.anthropic.com/v1` | required | Messages API, `anthropic-version: 2023-06-01`. Only text blocks are returned (thinking is skipped). |
| `openai` | `https://api.openai.com/v1` | required | Chat Completions, `developer` role, `max_completion_tokens`. Also provides text-to-speech (`/audio/speech`). |
| `gemini` | `https://generativelanguage.googleapis.com/v1beta` | required | `generateContent`, key in the `x-goog-api-key` header (never in the URL). |
| `openrouter` | `https://openrouter.ai/api/v1` | required | OpenAI-style. Mid-stream errors and keep-alive comments are handled. |
| `openai-compatible` | `http://localhost:11434/v1` (Ollama) | optional | Any OpenAI-compatible server: Ollama, LM Studio (`http://localhost:1234/v1`), vLLM, hosted gateways. |

The exact API formats each adapter follows, with sources, are in `docs/VERIFIED.md`.

### Local models (free)
- **Ollama:** run `ollama serve`, then add an `openai-compatible` provider with base URL `http://localhost:11434/v1` and a model you've pulled (e.g. `qwen2.5-coder:7b`). For the Chrome extension, start Ollama with `OLLAMA_ORIGINS=chrome-extension://*`, or it rejects the extension's requests.
- **LM Studio:** enable the local server (and "Enable CORS" for the extension), then use base URL `http://localhost:1234/v1`.

## Feature to model map
Each feature can use its own provider and model, for example cheap summaries on a local model and passports on a stronger one:

```json
{
  "providers": {
    "local":  { "type": "openai-compatible", "baseUrl": "http://localhost:11434/v1", "defaultModel": "qwen2.5-coder:7b" },
    "claude": { "type": "anthropic", "defaultModel": "claude-haiku-5-5" }
  },
  "features": {
    "summary":  { "mode": "api", "provider": "local" },
    "passport": { "mode": "api", "provider": "claude", "model": "claude-opus-5-5" },
    "tree":     { "mode": "in-chat" }
  }
}
```

The CLI keeps this in `~/.resync/config.json` under `ai`; the extension keeps it in Settings. Keys are **not** part of this file. The CLI stores them in the OS keychain, and the extension stores them in an encrypted vault.

## The interface

```js
import { complete, listModels, testConnection, speak } from '@resync/shared/providers';

const provider = { type: 'openai-compatible', baseUrl: 'http://localhost:11434/v1' };
const { text, usage } = await complete({ provider, model: 'qwen2.5-coder:7b', system: 'Be brief.', messages: [{ role: 'user', content: 'Hi' }], maxTokens: 200 });

const stream = await complete({ provider, model: 'qwen2.5-coder:7b', messages, stream: true });
for await (const delta of stream) process.stdout.write(delta);
const final = await stream.result; // { text, usage, model, finishReason }

await listModels(provider);       // [{ id, name }]
await testConnection(provider);   // { ok: true, detail, latencyMs } or { ok: false, error }; never throws
```

Every failure is a `ProviderError` with `kind` set to one of `auth`, `rate_limit`, `quota`, `context_too_long`, `network` or `unknown`. It also carries a human `hint`, and `status`, `code` and `retryAfterSeconds` when known. `toJSON()` is safe to log or send over extension messaging, and never contains the key.

## Add a provider in one file

1. Create `packages/shared/src/providers/adapters/<name>.js` that exports an adapter object:

```js
import { requestJson, joinUrl } from '../http.js';   // JSON + timeouts + error normalisation
import { parseSse } from '../sse.js';                 // if the API streams with Server-Sent Events

/** @type {import('../index.js').Adapter} */
export default {
  type: 'my-provider',                       // used in configs: { type: 'my-provider', apiKey, baseUrl }
  label: 'My Provider',
  defaultBaseUrl: 'https://api.example.com/v1',
  requiresKey: true,
  suggestedModels: { cheap: 'small-model', strong: 'big-model' },
  hostPermissions: (cfg) => [`${new URL(cfg.baseUrl).origin}/*`],   // what the extension must request

  async complete(cfg, req, opts) {
    // req = { model, messages: [{ role: 'user'|'assistant', content }], system?, maxTokens? }
    const res = await requestJson('my-provider', joinUrl(cfg.baseUrl, 'generate'),
      { headers: { authorization: `Bearer ${cfg.apiKey}` }, body: { model: req.model, /* ... */ } }, opts);
    const json = await res.json();
    return { text: json.output, usage: { inputTokens: json.in, outputTokens: json.out } };
  },

  async *stream(cfg, req, opts) {
    const res = await requestJson('my-provider', joinUrl(cfg.baseUrl, 'generate'), { headers: {/*...*/}, body: { stream: true /*...*/ } }, opts);
    for await (const ev of parseSse(res.body)) {
      const data = JSON.parse(ev.data);
      if (data.delta) yield { type: 'text', text: data.delta };
    }
    yield { type: 'done' };   // optionally with usage, finishReason, model
  },

  async listModels(cfg, opts) { /* optional: return [{ id, name }] */ },
  async speak(cfg, req, opts) { /* optional TTS: return { audio: ArrayBuffer, mimeType } */ },
};
```

2. Register it. Either add it to the list in `packages/shared/src/providers/index.js`, or register it at runtime:
   ```js
   import { registerAdapter } from '@resync/shared/providers';
   registerAdapter(myAdapter);
   ```
3. Add `my-provider` to `PROVIDER_TYPES` in `packages/shared/src/featureModels.js` so settings accept it.
4. Add tests in `packages/shared/test/providers.test.js` against a mocked `fetch`, covering request shape, response parsing, streaming and error kinds. Every adapter takes `opts.fetch`, so no network is needed. Record the API facts you relied on, with doc URLs, in `docs/VERIFIED.md`.

If the provider's API is OpenAI-compatible, you may not need a new adapter at all. Use `openai-compatible` with its base URL.
