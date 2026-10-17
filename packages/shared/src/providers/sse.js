// Minimal Server-Sent Events parser for fetch() response bodies (Node 18+ and browsers).

/**
 * @typedef {{ event: string, data: string }} SseEvent
 */

/**
 * Turn a byte stream into SSE events. Comment lines (starting with ":") are skipped, multi-line
 * data fields are joined with "\n", and both LF and CRLF line endings work.
 * @param {ReadableStream<Uint8Array> | AsyncIterable<Uint8Array | string>} body
 * @returns {AsyncGenerator<SseEvent>}
 */
export async function* parseSse(body) {
  const decoder = new TextDecoder();
  let buffer = '';
  let event = '';
  let data = [];

  const flush = function* () {
    if (data.length) yield { event: event || 'message', data: data.join('\n') };
    event = '';
    data = [];
  };

  for await (const chunk of iterate(body)) {
    buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    let idx;
    while ((idx = buffer.search(/\r?\n|\r/)) !== -1) {
      const line = buffer.slice(0, idx);
      const nl = buffer[idx] === '\r' && buffer[idx + 1] === '\n' ? 2 : 1;
      buffer = buffer.slice(idx + nl);
      if (line === '') {
        yield* flush();
        continue;
      }
      if (line.startsWith(':')) continue;
      const colon = line.indexOf(':');
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? '' : line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'event') event = value;
      else if (field === 'data') data.push(value);
    }
  }
  buffer += decoder.decode();
  if (buffer && !buffer.startsWith(':')) {
    const m = /^data: ?(.*)$/.exec(buffer);
    if (m) data.push(m[1]);
  }
  yield* flush();
}

/**
 * @param {ReadableStream<Uint8Array> | AsyncIterable<Uint8Array | string> | Iterable<Uint8Array | string>} body
 * @returns {AsyncIterable<Uint8Array | string> | Iterable<Uint8Array | string>}
 */
function iterate(body) {
  const b = /** @type {any} */ (body);
  if (b && (typeof b[Symbol.asyncIterator] === 'function' || typeof b[Symbol.iterator] === 'function')) return b;
  const reader = /** @type {ReadableStream<Uint8Array>} */ (body).getReader();
  return {
    async *[Symbol.asyncIterator]() {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) return;
          yield value;
        }
      } finally {
        reader.releaseLock();
      }
    },
  };
}
