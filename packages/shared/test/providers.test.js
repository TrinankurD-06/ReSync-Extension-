// Provider adapters against mocked HTTP. Request and response shapes follow docs/VERIFIED.md.
import { describe, it, expect } from 'vitest';
import { complete, listModels, testConnection, speak, hostPermissionsFor, listAdapters, registerAdapter, ProviderError, parseSse } from '../src/providers/index.js';
import { classifyHttpError } from '../src/providers/errors.js';

/** Build a fetch mock that records calls and replies via a handler. */
function mockFetch(handler) {
  const calls = [];
  const f = async (url, init = {}) => {
    const call = { url: String(url), method: init.method, headers: init.headers ?? {}, body: init.body ? JSON.parse(init.body) : undefined };
    calls.push(call);
    return handler(call);
  };
  f.calls = calls;
  return f;
}

const json = (obj, status = 200, headers = {}) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json', ...headers } });

/** SSE response delivered in awkward chunk sizes to exercise the parser. */
function sse(text, chunkSize = 7) {
  const bytes = new TextEncoder().encode(text);
  const stream = new ReadableStream({
    start(c) {
      for (let i = 0; i < bytes.length; i += chunkSize) c.enqueue(bytes.slice(i, i + chunkSize));
      c.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

const MSGS = [{ role: 'user', content: 'Hello' }];

async function collect(stream) {
  let s = '';
  for await (const t of stream) s += t;
  return { text: s, result: await stream.result };
}

describe('SSE parser', () => {
  it('handles CRLF, comments, multi-line data and a trailing event without blank line', async () => {
    const enc = new TextEncoder();
    const body = [enc.encode(': keep-alive\r\nevent: a\r\ndata: 1\r\ndata: 2\r\n\r\n'), enc.encode('data: last')];
    const out = [];
    for await (const ev of parseSse(body)) out.push(ev);
    expect(out).toEqual([{ event: 'a', data: '1\n2' }, { event: 'message', data: 'last' }]);
  });
});

describe('Anthropic adapter', () => {
  const provider = { type: 'anthropic', apiKey: 'sk-ant-test' };

  it('sends verified headers and body, returns only text blocks', async () => {
    const f = mockFetch(() => json({
      content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: 'Hi there' }],
      model: 'claude-haiku-5-5', stop_reason: 'end_turn', usage: { input_tokens: 12, output_tokens: 6 },
    }));
    const r = await complete({ provider, model: 'claude-haiku-5-5', messages: MSGS, system: 'Be brief', maxTokens: 100 }, { fetch: f });
    expect(r).toEqual({ text: 'Hi there', usage: { inputTokens: 12, outputTokens: 6 }, model: 'claude-haiku-5-5', finishReason: 'end_turn' });
    const c = f.calls[0];
    expect(c.url).toBe('https://api.anthropic.com/v1/messages');
    expect(c.headers['x-api-key']).toBe('sk-ant-test');
    expect(c.headers['anthropic-version']).toBe('2023-06-01');
    expect(c.headers['anthropic-dangerous-direct-browser-access']).toBeUndefined();
    expect(c.body).toEqual({ model: 'claude-haiku-5-5', max_tokens: 100, system: 'Be brief', messages: [{ role: 'user', content: 'Hello' }] });
    expect(c.body).not.toHaveProperty('temperature');
  });

  it('adds the browser header when called from the extension and defaults max_tokens', async () => {
    const f = mockFetch(() => json({ content: [{ type: 'text', text: 'x' }] }));
    await complete({ provider: { ...provider, browser: true }, model: 'm', messages: MSGS }, { fetch: f });
    expect(f.calls[0].headers['anthropic-dangerous-direct-browser-access']).toBe('true');
    expect(f.calls[0].body.max_tokens).toBe(4096);
  });

  it('streams text deltas and cumulative usage, ignoring pings and thinking', async () => {
    const f = mockFetch(() => sse([
      'event: message_start', 'data: {"type":"message_start","message":{"model":"claude-haiku-5-5","usage":{"input_tokens":10,"output_tokens":1}}}', '',
      'event: ping', 'data: {"type":"ping"}', '',
      'event: content_block_delta', 'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"..."}}', '',
      'event: content_block_delta', 'data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Hel"}}', '',
      'event: content_block_delta', 'data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"lo"}}', '',
      'event: message_delta', 'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":15}}', '',
      'event: message_stop', 'data: {"type":"message_stop"}', '', '',
    ].join('\n')));
    const s = await complete({ provider, model: 'claude-haiku-5-5', messages: MSGS, stream: true }, { fetch: f });
    const { text, result } = await collect(s);
    expect(text).toBe('Hello');
    expect(result).toEqual({ text: 'Hello', usage: { inputTokens: 10, outputTokens: 15 }, model: 'claude-haiku-5-5', finishReason: 'end_turn' });
    expect(f.calls[0].body.stream).toBe(true);
  });

  it('turns a mid-stream error event into a ProviderError', async () => {
    const f = mockFetch(() => sse('event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n'));
    const s = await complete({ provider, model: 'm', messages: MSGS, stream: true }, { fetch: f });
    await expect(collect(s)).rejects.toMatchObject({ kind: 'rate_limit' });
    await expect(s.result).rejects.toBeInstanceOf(ProviderError);
  });

  it('maps documented errors', async () => {
    const cases = [
      [401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }, 'auth'],
      [402, { type: 'error', error: { type: 'billing_error', message: 'Your credit balance is too low' } }, 'quota'],
      [429, { type: 'error', error: { type: 'rate_limit_error', message: 'Number of requests has exceeded your rate limit' } }, 'rate_limit'],
      [529, { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }, 'rate_limit'],
      [400, { type: 'error', error: { type: 'invalid_request_error', message: 'prompt is too long: 250000 tokens > 200000 maximum' } }, 'context_too_long'],
      [500, { type: 'error', error: { type: 'api_error', message: 'Internal' } }, 'unknown'],
    ];
    for (const [status, body, kind] of cases) {
      const f = mockFetch(() => json(body, status, status === 429 ? { 'retry-after': '30' } : {}));
      const err = await complete({ provider, model: 'm', messages: MSGS }, { fetch: f }).catch((e) => e);
      expect(err, `HTTP ${status}`).toBeInstanceOf(ProviderError);
      expect(err.kind, `HTTP ${status}`).toBe(kind);
      if (status === 429) expect(err.retryAfterSeconds).toBe(30);
    }
  });

  it('lists models', async () => {
    const f = mockFetch(() => json({ data: [{ type: 'model', id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5' }], has_more: false }));
    expect(await listModels(provider, { fetch: f })).toEqual([{ id: 'claude-opus-5-5', name: 'Claude Opus 5.5' }]);
    expect(f.calls[0].url).toBe('https://api.anthropic.com/v1/models?limit=1000');
  });
});

describe('OpenAI adapter', () => {
  const provider = { type: 'openai', apiKey: 'sk-test' };

  it('uses Bearer auth, the developer role and max_completion_tokens', async () => {
    const f = mockFetch(() => json({
      model: 'gpt-6-luna', choices: [{ index: 0, message: { role: 'assistant', content: 'Hi!' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 19, completion_tokens: 10, total_tokens: 29 },
    }));
    const r = await complete({ provider, model: 'gpt-6-luna', messages: MSGS, system: 'Be brief', maxTokens: 50 }, { fetch: f });
    expect(r).toEqual({ text: 'Hi!', usage: { inputTokens: 19, outputTokens: 10 }, model: 'gpt-6-luna', finishReason: 'stop' });
    const c = f.calls[0];
    expect(c.url).toBe('https://api.openai.com/v1/chat/completions');
    expect(c.headers.authorization).toBe('Bearer sk-test');
    expect(c.body.messages[0]).toEqual({ role: 'developer', content: 'Be brief' });
    expect(c.body.max_completion_tokens).toBe(50);
    expect(c.body).not.toHaveProperty('max_tokens');
  });

  it('streams until [DONE] and reads the usage chunk', async () => {
    const f = mockFetch(() => sse([
      'data: {"model":"gpt-6-luna","choices":[{"index":0,"delta":{"content":"Hel"},"finish_reason":null}]}', '',
      'data: {"choices":[{"index":0,"delta":{"content":"lo"},"finish_reason":null}]}', '',
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}', '',
      'data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":2}}', '',
      'data: [DONE]', '', '',
    ].join('\n')));
    const { text, result } = await collect(await complete({ provider, model: 'gpt-6-luna', messages: MSGS, stream: true }, { fetch: f }));
    expect(text).toBe('Hello');
    expect(result).toMatchObject({ usage: { inputTokens: 5, outputTokens: 2 }, finishReason: 'stop' });
    expect(f.calls[0].body.stream_options).toEqual({ include_usage: true });
  });

  it('maps documented errors, including billing codes on 429', async () => {
    const cases = [
      [401, { error: { message: 'Incorrect API key provided', type: 'invalid_request_error', code: 'invalid_api_key' } }, 'auth'],
      [429, { error: { message: 'Rate limit reached', type: 'requests', code: 'rate_limit_exceeded' } }, 'rate_limit'],
      [429, { error: { message: 'You exceeded your current quota', type: 'insufficient_quota', code: 'credit_balance_exhausted' } }, 'quota'],
      [400, { error: { message: "This model's maximum context length is 1050000 tokens", code: 'context_length_exceeded' } }, 'context_too_long'],
      [403, { error: { message: 'Country, region, or territory not supported' } }, 'auth'],
    ];
    for (const [status, body, kind] of cases) {
      const err = await complete({ provider, model: 'm', messages: MSGS }, { fetch: mockFetch(() => json(body, status)) }).catch((e) => e);
      expect(err.kind, JSON.stringify(body)).toBe(kind);
    }
  });

  it('lists chat models without TTS/embeddings and speaks via /audio/speech', async () => {
    const f = mockFetch((c) => c.url.endsWith('/models')
      ? json({ object: 'list', data: [{ id: 'gpt-6-luna' }, { id: 'gpt-4o-mini-tts' }, { id: 'text-embedding-3-small' }] })
      : new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': 'audio/mpeg' } }));
    expect((await listModels(provider, { fetch: f })).map((m) => m.id)).toEqual(['gpt-6-luna']);
    const audio = await speak(provider, { text: 'x'.repeat(5000) }, { fetch: f });
    expect(audio.audio.byteLength).toBe(3);
    expect(audio.mimeType).toBe('audio/mpeg');
    const body = f.calls[1].body;
    expect(f.calls[1].url).toBe('https://api.openai.com/v1/audio/speech');
    expect(body).toMatchObject({ model: 'gpt-4o-mini-tts', voice: 'marin', response_format: 'mp3' });
    expect(body.input).toHaveLength(4096);
  });
});

describe('Gemini adapter', () => {
  const provider = { type: 'gemini', apiKey: 'AIza-test' };

  it('uses x-goog-api-key, user/model roles, systemInstruction, and skips thought parts', async () => {
    const f = mockFetch(() => json({
      candidates: [{ content: { role: 'model', parts: [{ text: 'thinking', thought: true }, { text: 'Hi' }, { text: '!' }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 2, thoughtsTokenCount: 3, totalTokenCount: 9 },
    }));
    const r = await complete({
      provider, model: 'gemini-3.5-flash-lite', system: 'Be brief', maxTokens: 64,
      messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }, { role: 'user', content: 'c' }],
    }, { fetch: f });
    expect(r).toEqual({ text: 'Hi!', usage: { inputTokens: 4, outputTokens: 5 }, model: 'gemini-3.5-flash-lite', finishReason: 'STOP' });
    const c = f.calls[0];
    expect(c.url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent');
    expect(c.url).not.toContain('key=');
    expect(c.headers['x-goog-api-key']).toBe('AIza-test');
    expect(c.body.systemInstruction).toEqual({ parts: [{ text: 'Be brief' }] });
    expect(c.body.contents.map((m) => m.role)).toEqual(['user', 'model', 'user']);
    expect(c.body.generationConfig).toEqual({ maxOutputTokens: 64 });
  });

  it('streams with alt=sse until the stream closes', async () => {
    const f = mockFetch(() => sse([
      'data: {"candidates":[{"content":{"parts":[{"text":"Hel"}]}}]}', '',
      'data: {"candidates":[{"content":{"parts":[{"text":"lo"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":3,"candidatesTokenCount":2}}', '', '',
    ].join('\r\n')));
    const { text, result } = await collect(await complete({ provider, model: 'gemini-3.8-flash', messages: MSGS, stream: true }, { fetch: f }));
    expect(text).toBe('Hello');
    expect(result.usage).toEqual({ inputTokens: 3, outputTokens: 2 });
    expect(f.calls[0].url).toContain(':streamGenerateContent?alt=sse');
  });

  it('maps an invalid key (HTTP 400 API_KEY_INVALID) to auth, and 402/429 to quota/rate_limit', async () => {
    const invalidKey = { error: { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT', details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'API_KEY_INVALID' }] } };
    const cases = [
      [400, invalidKey, 'auth'],
      [402, { error: { code: 'payment_required', message: 'Prepay credit balance is depleted' } }, 'quota'],
      [429, { error: { code: 429, message: 'Resource has been exhausted (e.g. check quota).', status: 'RESOURCE_EXHAUSTED' } }, 'quota'],
      [429, { error: { code: 429, message: 'Too many requests', status: 'RESOURCE_EXHAUSTED' } }, 'rate_limit'],
      [400, { error: { code: 400, message: 'The input token count (2000000) exceeds the maximum number of tokens allowed (1048576).', status: 'INVALID_ARGUMENT' } }, 'context_too_long'],
    ];
    for (const [status, body, kind] of cases) {
      const err = await complete({ provider, model: 'm', messages: MSGS }, { fetch: mockFetch(() => json(body, status)) }).catch((e) => e);
      expect(err.kind, JSON.stringify(body)).toBe(kind);
    }
  });

  it('reports a blocked prompt and lists generateContent models across pages', async () => {
    const blocked = mockFetch(() => json({ promptFeedback: { blockReason: 'SAFETY' } }));
    await expect(complete({ provider, model: 'm', messages: MSGS }, { fetch: blocked })).rejects.toThrow(/blocked/);
    let page = 0;
    const f = mockFetch(() => json(page++ === 0
      ? { models: [{ name: 'models/gemini-3.8-flash', displayName: 'Gemini 3.8 Flash', supportedGenerationMethods: ['generateContent'] }], nextPageToken: 'p2' }
      : { models: [{ name: 'models/text-embedding', supportedGenerationMethods: ['embedContent'] }] }));
    expect(await listModels(provider, { fetch: f })).toEqual([{ id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash' }]);
    expect(f.calls[1].url).toContain('pageToken=p2');
  });
});

describe('OpenRouter adapter', () => {
  const provider = { type: 'openrouter', apiKey: 'sk-or-test', appUrl: 'https://example.test' };

  it('sends Bearer + attribution headers and the system role', async () => {
    const f = mockFetch(() => json({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }));
    await complete({ provider, model: 'openrouter/auto', messages: MSGS, system: 's', maxTokens: 20 }, { fetch: f });
    const c = f.calls[0];
    expect(c.url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(c.headers).toMatchObject({ authorization: 'Bearer sk-or-test', 'HTTP-Referer': 'https://example.test', 'X-OpenRouter-Title': 'ReSync' });
    expect(c.body.messages[0].role).toBe('system');
    expect(c.body.max_completion_tokens).toBe(20);
  });

  it('skips keep-alive comments and surfaces mid-stream errors sent with HTTP 200', async () => {
    const ok = mockFetch(() => sse(': OPENROUTER PROCESSING\n\ndata: {"choices":[{"delta":{"content":"Hi"}}]}\n\n: OPENROUTER PROCESSING\n\ndata: {"choices":[],"usage":{"prompt_tokens":1,"completion_tokens":1}}\n\ndata: [DONE]\n\n'));
    expect((await collect(await complete({ provider, model: 'm', messages: MSGS, stream: true }, { fetch: ok }))).text).toBe('Hi');
    const bad = mockFetch(() => sse('data: {"choices":[{"delta":{"content":"Hi"}}]}\n\ndata: {"error":{"code":429,"message":"Rate limit exceeded","metadata":{"error_type":"rate_limit_exceeded"}},"choices":[]}\n\n'));
    const s = await complete({ provider, model: 'm', messages: MSGS, stream: true }, { fetch: bad });
    await expect(collect(s)).rejects.toMatchObject({ kind: 'rate_limit' });
  });

  it('maps 402 credits, 403 budget, and context_length_exceeded metadata', async () => {
    const cases = [
      [402, { error: { code: 402, message: 'Insufficient credits' } }, 'quota'],
      [403, { error: { code: 403, message: 'Key limit exceeded: $5 of $5 used; resets in 3 days' } }, 'quota'],
      [403, { error: { code: 403, message: 'Input flagged by moderation' } }, 'auth'],
      [400, { error: { code: 400, message: 'too big', metadata: { error_type: 'context_length_exceeded' } } }, 'context_too_long'],
      [401, { error: { code: 401, message: 'Missing Authentication header' } }, 'auth'],
    ];
    for (const [status, body, kind] of cases) {
      const err = await complete({ provider, model: 'm', messages: MSGS }, { fetch: mockFetch(() => json(body, status)) }).catch((e) => e);
      expect(err.kind, JSON.stringify(body)).toBe(kind);
    }
  });

  it('treats an error body returned with HTTP 200 as an error', async () => {
    const f = mockFetch(() => json({ error: { code: 402, message: 'Insufficient credits' } }));
    await expect(complete({ provider, model: 'm', messages: MSGS }, { fetch: f })).rejects.toMatchObject({ kind: 'quota' });
  });
});

describe('OpenAI-compatible adapter (Ollama, LM Studio)', () => {
  const provider = { type: 'openai-compatible', baseUrl: 'http://localhost:11434/v1/' };

  it('needs no key, uses the custom base URL, system role and max_tokens', async () => {
    const f = mockFetch(() => json({ choices: [{ message: { content: 'local' } }] }));
    const r = await complete({ provider, model: 'qwen2.5-coder:7b', messages: MSGS, system: 's', maxTokens: 10 }, { fetch: f });
    expect(r.text).toBe('local');
    const c = f.calls[0];
    expect(c.url).toBe('http://localhost:11434/v1/chat/completions');
    expect(c.headers.authorization).toBeUndefined();
    expect(c.body.messages[0].role).toBe('system');
    expect(c.body.max_tokens).toBe(10);
  });

  it('sends a Bearer token when given (LM Studio auth, other hosts)', async () => {
    const f = mockFetch(() => json({ choices: [{ message: { content: 'x' } }] }));
    await complete({ provider: { ...provider, apiKey: 'lm-token' }, model: 'm', messages: MSGS }, { fetch: f });
    expect(f.calls[0].headers.authorization).toBe('Bearer lm-token');
  });

  it('turns connection failures into network errors', async () => {
    const refused = async () => {
      throw new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } });
    };
    const err = await complete({ provider, model: 'm', messages: MSGS }, { fetch: refused }).catch((e) => e);
    expect(err.kind).toBe('network');
    expect(err.message).toContain('ECONNREFUSED');
  });

  it('times out as a network error', async () => {
    const hang = (_u, init) => new Promise((_r, rej) => init.signal.addEventListener('abort', () => rej(init.signal.reason)));
    const err = await complete({ provider, model: 'm', messages: MSGS }, { fetch: hang, timeoutMs: 20 }).catch((e) => e);
    expect(err.kind).toBe('network');
  });

  it('requests host permissions for both localhost spellings', () => {
    expect(hostPermissionsFor(provider)).toEqual(['http://localhost/*', 'http://127.0.0.1/*']);
    expect(hostPermissionsFor({ type: 'anthropic' })).toEqual(['https://api.anthropic.com/*']);
  });

  it('falls back to the default Ollama base URL when none is set', async () => {
    const f = mockFetch(() => json({ choices: [{ message: { content: 'x' } }] }));
    await complete({ provider: { type: 'openai-compatible', baseUrl: '' }, model: 'm', messages: MSGS }, { fetch: f });
    expect(f.calls[0].url).toBe('http://localhost:11434/v1/chat/completions');
  });
});

describe('layer behaviour', () => {
  it('refuses keyed providers without a key, with a helpful message (no key is ever required for in-chat mode)', async () => {
    const err = await complete({ provider: { type: 'anthropic' }, model: 'm', messages: MSGS }).catch((e) => e);
    expect(err.kind).toBe('auth');
    expect(err.message).toMatch(/resync keys set anthropic/);
  });

  it('testConnection never throws and reports the error kind', async () => {
    const good = await testConnection({ type: 'openai', apiKey: 'k' }, { fetch: mockFetch(() => json({ data: [{ id: 'a' }, { id: 'b' }] })) });
    expect(good).toMatchObject({ ok: true, provider: 'openai', detail: '2 model(s) available' });
    const bad = await testConnection({ type: 'openai', apiKey: 'k' }, { fetch: mockFetch(() => json({ error: { message: 'bad key' } }, 401)) });
    expect(bad).toMatchObject({ ok: false, error: { kind: 'auth' } });
    const viaModel = await testConnection({ type: 'openai-compatible', baseUrl: 'http://x/v1' }, { model: 'm', fetch: mockFetch(() => json({ choices: [{ message: { content: 'OK' } }] })) });
    expect(viaModel).toMatchObject({ ok: true, detail: 'model m replied (OK)' });
    expect(await testConnection(undefined)).toMatchObject({ ok: false });
  });

  it('ProviderError JSON never contains the key', async () => {
    const err = await complete({ provider: { type: 'openai', apiKey: 'sk-secret-123' }, model: 'm', messages: MSGS }, { fetch: mockFetch(() => json({ error: { message: 'nope' } }, 401)) }).catch((e) => e);
    expect(JSON.stringify(err.toJSON())).not.toContain('sk-secret-123');
  });

  it('lists adapters and accepts a contributor adapter in one registration', async () => {
    expect(listAdapters().map((a) => a.type)).toEqual(['anthropic', 'openai', 'gemini', 'openrouter', 'openai-compatible']);
    registerAdapter({
      type: 'echo', label: 'Echo', defaultBaseUrl: 'http://echo', requiresKey: false, suggestedModels: {},
      hostPermissions: () => [],
      complete: async (_cfg, req) => ({ text: req.messages.at(-1).content }),
      async *stream(_cfg, req) { yield { type: 'text', text: req.messages.at(-1).content }; yield { type: 'done' }; },
    });
    expect((await complete({ provider: { type: 'echo' }, model: 'x', messages: MSGS })).text).toBe('Hello');
    expect(await (await complete({ provider: { type: 'echo' }, model: 'x', messages: MSGS, stream: true })).text()).toBe('Hello');
    expect(() => registerAdapter({ type: 'broken' })).toThrow(/missing/);
  });

  it('classifyHttpError handles non-JSON bodies', () => {
    expect(classifyHttpError({ provider: 'p', status: 502, body: '<html>Bad gateway</html>' }).kind).toBe('unknown');
  });
});
