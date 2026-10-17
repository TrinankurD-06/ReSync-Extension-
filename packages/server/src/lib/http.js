// HTTP helpers: one error shape { error: { code, message } } and zod-based validation.
import { z } from 'zod';

export class HttpError extends Error {
  /** @param {number} status @param {string} code @param {string} message */
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const badRequest = (msg, code = 'bad_request') => new HttpError(400, code, msg);
export const unauthorized = (msg = 'Sign in first.') => new HttpError(401, 'unauthorized', msg);
export const forbidden = (msg = 'You do not have access to this.') => new HttpError(403, 'forbidden', msg);
export const notFound = (msg = 'Not found.') => new HttpError(404, 'not_found', msg);
export const conflict = (msg) => new HttpError(409, 'conflict', msg);

/**
 * Parse input with a zod schema or throw a 400 with readable messages.
 * @template T
 * @param {z.ZodType<T>} schema
 * @param {unknown} data
 * @returns {T}
 */
export function validate(schema, data) {
  const r = schema.safeParse(data);
  if (!r.success) {
    const msg = r.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ');
    throw badRequest(msg, 'validation_error');
  }
  return r.data;
}

/** A 24-hex MongoDB id. */
export const objectId = z.string().regex(/^[a-f0-9]{24}$/, 'must be an id');

/**
 * Final error handler: known errors keep their status and message; anything else is a 500 without details.
 * @param {import('pino').Logger} logger
 */
export function errorHandler(logger) {
  // Express recognises error handlers by their four parameters, so _next must stay.
  return (err, req, res, _next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: { code: err.code, message: err.message } });
    if (err?.type === 'entity.too.large') return res.status(413).json({ error: { code: 'too_large', message: 'Request body is too large.' } });
    if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: { code: 'bad_json', message: 'Request body is not valid JSON.' } });
    if (err?.code === 11000) return res.status(409).json({ error: { code: 'conflict', message: 'That already exists.' } });
    logger.error({ err: { message: err?.message, name: err?.name, stack: err?.stack } }, 'unhandled error');
    res.status(500).json({ error: { code: 'server_error', message: 'Something went wrong on the server.' } });
  };
}
