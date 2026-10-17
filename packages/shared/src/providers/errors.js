// One error shape for every provider. Never include API keys or request bodies in messages.

export const ERROR_KINDS = /** @type {const} */ (['auth', 'rate_limit', 'quota', 'context_too_long', 'network', 'unknown']);

/** @typedef {typeof ERROR_KINDS[number]} ErrorKind */

const HINTS = {
  auth: 'The API key was rejected. Check it with `resync keys test` or re-enter it in Settings.',
  rate_limit: 'The provider is rate limiting or overloaded. Wait a little and try again.',
  quota: 'The account is out of credits or over a spend/usage limit. Retrying will not help until that is fixed.',
  context_too_long: 'The conversation is too long for this model. Use a model with a bigger context window or a shorter transcript.',
  network: 'Could not reach the provider. Check your connection or the base URL.',
  unknown: 'The provider returned an unexpected error.',
};

export class ProviderError extends Error {
  /**
   * @param {{ kind: ErrorKind, message: string, provider?: string, status?: number, code?: string, retryAfterSeconds?: number, cause?: unknown }} o
   */
  constructor(o) {
    super(o.message);
    this.name = 'ProviderError';
    /** @type {ErrorKind} */
    this.kind = o.kind;
    this.provider = o.provider;
    this.status = o.status;
    this.code = o.code;
    this.retryAfterSeconds = o.retryAfterSeconds;
    this.hint = HINTS[o.kind];
    if (o.cause) this.cause = o.cause;
  }

  /** Plain object, safe to send over extension messaging or print as JSON. */
  toJSON() {
    return { kind: this.kind, message: this.message, provider: this.provider, status: this.status, code: this.code, retryAfterSeconds: this.retryAfterSeconds, hint: this.hint };
  }
}

const CONTEXT_RE = /prompt is too long|context[ _-]?length|context window|maximum context|too many tokens|input token count|exceeds the (?:maximum|model)/i;
const QUOTA_CODES = /insufficient_quota|credit_balance|spend_limit|usage_limit|billing|payment_required|quota_exceeded|credits?/i;

/**
 * Classify an HTTP error response into a ProviderError.
 * @param {{ provider: string, status: number, body: any, headers?: { get(name: string): string | null } }} r
 *   body is the parsed JSON error body when available, else text.
 */
export function classifyHttpError({ provider, status, body, headers }) {
  const err = body?.error ?? body;
  const message = String(
    (typeof err === 'object' ? err?.message : null) ?? (typeof body === 'string' ? body.slice(0, 300) : '') ?? '',
  ) || `HTTP ${status}`;
  const code = String(
    err?.metadata?.error_type ?? err?.code ?? err?.type ?? err?.status ?? err?.details?.find?.((d) => d?.reason)?.reason ?? '',
  );
  const reasons = Array.isArray(err?.details) ? err.details.map((d) => d?.reason).filter(Boolean).join(' ') : '';
  const retryRaw = headers?.get?.('retry-after');
  const retryAfterSeconds = retryRaw && /^\d+$/.test(retryRaw) ? Number(retryRaw) : undefined;
  const base = { provider, status, code: code || undefined, retryAfterSeconds };

  /** @type {ErrorKind} */
  let kind = 'unknown';
  if (code === 'context_length_exceeded' || CONTEXT_RE.test(message)) kind = 'context_too_long';
  else if (status === 401 || /API_KEY_INVALID|invalid_api_key|authentication/i.test(code + ' ' + reasons)) kind = 'auth';
  else if (status === 402 || (QUOTA_CODES.test(code) && status !== 401)) kind = 'quota';
  else if (status === 403) {
    // OpenRouter uses 403 when a key's budget is spent; others mean permission/auth.
    kind = /budget|used; resets|limit/i.test(message) ? 'quota' : 'auth';
  } else if (status === 429) {
    kind = /spend|billing|credit|quota/i.test(message) ? 'quota' : 'rate_limit';
  } else if (status === 529 || status === 503 || /overloaded/i.test(code)) kind = 'rate_limit';
  else if (status === 413) kind = 'context_too_long';

  return new ProviderError({ ...base, kind, message: `${provider}: ${message}` });
}

/**
 * Wrap a thrown fetch error (DNS, refused connection, timeout, abort).
 * @param {string} provider
 * @param {unknown} e
 */
export function networkError(provider, e) {
  const err = /** @type {any} */ (e);
  if (err instanceof ProviderError) return err;
  const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
  const detail = err?.cause?.code ?? err?.message ?? String(e);
  return new ProviderError({
    kind: 'network',
    provider,
    message: `${provider}: ${timedOut ? 'request timed out or was cancelled' : `network error (${detail})`}`,
    cause: e,
  });
}
