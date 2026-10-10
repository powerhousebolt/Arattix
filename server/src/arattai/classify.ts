import { AppError, AuthExpiredError } from '../errors';

/** Network failures where the request provably never reached Arattai. Always safe to retry. */
const NOT_SENT_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'ERR_SOCKET_CONNECTION_TIMEOUT']);
/** Failures after the request may have been received. Retrying a non-idempotent call can duplicate it. */
const AMBIGUOUS_CODES = new Set(['ECONNABORTED', 'ETIMEDOUT', 'ECONNRESET', 'EPIPE', 'ERR_CANCELED', 'ERR_STREAM_PREMATURE_CLOSE']);

interface AxiosLikeError {
  isAxiosError?: boolean;
  code?: string;
  message?: string;
  response?: { status: number; headers?: Record<string, unknown>; data?: unknown };
}

function retryAfterMs(headers: Record<string, unknown> | undefined): number | undefined {
  const value = headers?.['retry-after'];
  if (typeof value !== 'string') return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

/**
 * Map an error thrown by the arattix library (axios underneath) to an AppError.
 * @param idempotent whether repeating the operation is harmless (reads) or not (sends).
 */
export function classifyUpstreamError(err: unknown, operation: string, idempotent: boolean): AppError {
  if (err instanceof AppError) return err;
  const e = (err ?? {}) as AxiosLikeError;

  if (e.response) {
    const { status, headers } = e.response;
    if (status === 401 || status === 403) {
      return new AuthExpiredError(`Arattai rejected the session (HTTP ${status}) during ${operation}`);
    }
    if (status === 429) {
      return new AppError({
        status: 503,
        code: 'UPSTREAM_RATE_LIMITED',
        message: `Arattai rate-limited ${operation}`,
        retryable: true,
        retryAfterMs: retryAfterMs(headers) ?? 60_000,
        details: { upstreamStatus: status },
      });
    }
    if (status >= 500) {
      return new AppError({
        status: 502,
        code: 'UPSTREAM_ERROR',
        message: `Arattai failed ${operation} (HTTP ${status})`,
        retryable: idempotent,
        details: { upstreamStatus: status },
      });
    }
    return new AppError({
      status: 502,
      code: 'UPSTREAM_REJECTED',
      message: `Arattai rejected ${operation} (HTTP ${status})`,
      retryable: false,
      details: { upstreamStatus: status },
    });
  }

  const code = e.code ?? '';
  if (NOT_SENT_CODES.has(code)) {
    return new AppError({
      status: 503,
      code: 'UPSTREAM_UNREACHABLE',
      message: `Could not reach Arattai for ${operation} (${code})`,
      retryable: true,
      details: { networkCode: code },
    });
  }
  if (AMBIGUOUS_CODES.has(code) || /timeout/i.test(e.message ?? '')) {
    return new AppError({
      status: 504,
      code: idempotent ? 'UPSTREAM_TIMEOUT' : 'UPSTREAM_TIMEOUT_AMBIGUOUS',
      message: idempotent
        ? `Arattai timed out during ${operation}`
        : `Arattai timed out during ${operation}; it may or may not have been applied, so it is not retried automatically`,
      retryable: idempotent,
      details: { networkCode: code || null },
    });
  }

  return new AppError({
    status: 502,
    code: 'UPSTREAM_FAILURE',
    message: `Unexpected failure during ${operation}: ${e.message ?? String(err)}`,
    retryable: false,
    cause: err,
  });
}

/** Failures that say something about Arattai's health and should count towards the circuit breaker. */
export function countsAgainstCircuit(err: unknown): boolean {
  if (!(err instanceof AppError)) return false;
  return ['UPSTREAM_ERROR', 'UPSTREAM_UNREACHABLE', 'UPSTREAM_TIMEOUT', 'UPSTREAM_TIMEOUT_AMBIGUOUS', 'UPSTREAM_RATE_LIMITED'].includes(
    err.code,
  );
}

/** A 2xx response whose body is an HTML page means axios followed a redirect to the login page. */
export function looksLikeLoginPage(body: unknown): boolean {
  return typeof body === 'string' && /<html|<!doctype html/i.test(body.slice(0, 2048));
}
