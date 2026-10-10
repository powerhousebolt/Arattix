import winston from 'winston';

export type Logger = winston.Logger;

/** Keys whose values must never reach a log sink (cookies, tickets, signing secrets, QR login data). */
const SENSITIVE_KEY = /^(authorization|cookie|set-cookie|x-zcsrf-token|z-authorization|x-api-key|secret|secretenc|password|token|qr|qrdata|dataurl|cookies|master_key|api_keys)$/i;

function redact(value: unknown, depth = 0): unknown {
  if (depth > 6 || value === null || typeof value !== 'object') return value;
  if (value instanceof Error) return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SENSITIVE_KEY.test(k) ? '[REDACTED]' : redact(v, depth + 1);
  }
  return out;
}

const redactFormat = winston.format((info) => {
  for (const key of Object.keys(info)) {
    if (SENSITIVE_KEY.test(key)) {
      info[key] = '[REDACTED]';
    } else if (key !== 'message' && key !== 'level') {
      info[key] = redact(info[key]);
    }
  }
  return info;
});

export function createLogger(opts: { level: string; format: 'json' | 'pretty'; role: string; sessionId: string }): Logger {
  const base = [winston.format.timestamp(), winston.format.errors({ stack: true }), redactFormat()];
  const format =
    opts.format === 'json'
      ? winston.format.combine(...base, winston.format.json())
      : winston.format.combine(
          ...base,
          winston.format.colorize(),
          winston.format.printf(({ timestamp, level, message, component, stack, ...rest }) => {
            delete rest.role;
            delete rest.sessionId;
            delete rest.pid;
            const extra = Object.keys(rest).length ? ` ${JSON.stringify(rest)}` : '';
            return `${timestamp} ${level} [${component ?? 'app'}] ${message}${extra}${stack ? `\n${stack}` : ''}`;
          }),
        );

  return winston.createLogger({
    level: opts.level,
    format,
    defaultMeta: { role: opts.role, sessionId: opts.sessionId, pid: process.pid },
    transports: [new winston.transports.Console({ stderrLevels: ['error'] })],
  });
}

/** Logger that discards everything; used by tests. */
export function createSilentLogger(): Logger {
  return winston.createLogger({ silent: true, transports: [new winston.transports.Console({ silent: true })] });
}
