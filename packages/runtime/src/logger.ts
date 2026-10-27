import { pino, type Logger } from 'pino';

export type { Logger } from 'pino';

/**
 * Structured JSON logs. Never log PHI: no note text, no patient names, no
 * request bodies; ids and counts only. Secrets in headers are redacted.
 */
export function createLogger(options: {
  readonly level: string;
  readonly service: string;
}): Logger {
  return pino({
    level: options.level,
    base: { service: options.service },
    redact: {
      paths: ['req.headers.authorization', 'headers.authorization', '*.apiKey', '*.secret'],
      censor: '[redacted]',
    },
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}
