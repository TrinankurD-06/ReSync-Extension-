// Structured logs that never contain prompt bodies, conversation text, API keys or tokens.
import pino from 'pino';

/** @param {{ level?: string, destination?: import('pino').DestinationStream }} [o] */
export function createLogger(o = {}) {
  return pino(
    {
      level: o.level ?? 'info',
      base: { service: 'resync-server' },
      // Defence in depth: if any of these keys ever reach a log call, they are removed.
      redact: {
        paths: ['req.headers.authorization', 'req.headers.cookie', 'headers.authorization', 'headers.cookie', '*.token', '*.password', '*.body', '*.content', '*.apiKey', 'token', 'body', 'content'],
        remove: true,
      },
    },
    o.destination,
  );
}

/**
 * Request log middleware: method, path (no query string), status, duration, user id. Nothing else.
 * @param {import('pino').Logger} logger
 */
export function requestLogger(logger) {
  return (req, res, next) => {
    const start = process.hrtime.bigint();
    res.on('finish', () => {
      logger.info({
        method: req.method,
        path: req.baseUrl + (req.route?.path ?? req.path),
        status: res.statusCode,
        ms: Number((process.hrtime.bigint() - start) / 1_000_000n),
        user: req.user?._id?.toString(),
        client: req.get('x-resync-client') || undefined,
      }, 'request');
    });
    next();
  };
}
