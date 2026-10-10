/**
 * Error model shared by the HTTP layer, the job queues and the Arattai gateway.
 *
 * `retryable` drives queue retries. It must be false for anything whose outcome is ambiguous
 * (for example a send that timed out after the request left the process), because retrying
 * those can deliver the same message twice.
 */
export interface AppErrorOptions {
  status: number;
  code: string;
  message: string;
  details?: unknown;
  retryable?: boolean;
  retryAfterMs?: number;
  cause?: unknown;
}

export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;

  constructor(opts: AppErrorOptions) {
    super(opts.message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = 'AppError';
    this.status = opts.status;
    this.code = opts.code;
    this.details = opts.details;
    this.retryable = opts.retryable ?? false;
    this.retryAfterMs = opts.retryAfterMs;
  }

  toJSON(): WireError {
    return {
      status: this.status,
      code: this.code,
      message: this.message,
      ...(this.details !== undefined ? { details: this.details } : {}),
      retryable: this.retryable,
      ...(this.retryAfterMs !== undefined ? { retryAfterMs: this.retryAfterMs } : {}),
    };
  }
}

/** Serializable form of an AppError, used to carry errors across the job queue boundary. */
export interface WireError {
  status: number;
  code: string;
  message: string;
  details?: unknown;
  retryable: boolean;
  retryAfterMs?: number;
}

const WIRE_PREFIX = 'ARATTIX_ERR:';

export function toAppError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  if (err instanceof Error) {
    const fromWire = fromWireMessage(err.message);
    if (fromWire) return fromWire;
    return new AppError({ status: 500, code: 'INTERNAL', message: 'Internal error', cause: err, retryable: false });
  }
  return new AppError({ status: 500, code: 'INTERNAL', message: 'Internal error', retryable: false });
}

export function toWireMessage(err: AppError): string {
  return WIRE_PREFIX + JSON.stringify(err.toJSON());
}

export function fromWireMessage(message: string | undefined): AppError | null {
  if (!message || !message.startsWith(WIRE_PREFIX)) return null;
  try {
    const w = JSON.parse(message.slice(WIRE_PREFIX.length)) as WireError;
    return new AppError(w);
  } catch {
    return null;
  }
}

export const Errors = {
  validation: (details: unknown) =>
    new AppError({ status: 400, code: 'VALIDATION_FAILED', message: 'Request validation failed', details }),
  invalidJson: () => new AppError({ status: 400, code: 'INVALID_JSON', message: 'Request body is not valid JSON' }),
  unauthorized: () =>
    new AppError({ status: 401, code: 'UNAUTHORIZED', message: 'Missing or invalid API key' }),
  notFound: (what: string) => new AppError({ status: 404, code: 'NOT_FOUND', message: `${what} not found` }),
  routeNotFound: (method: string, path: string) =>
    new AppError({ status: 404, code: 'ROUTE_NOT_FOUND', message: `No route for ${method} ${path}` }),
  sessionNotReady: (state: string, reason?: string | null) =>
    new AppError({
      status: 409,
      code: 'SESSION_NOT_READY',
      message: `Arattai session is ${state}; it must be READY for this operation`,
      details: { state, reason: reason ?? null },
    }),
  payloadTooLarge: (limit: number) =>
    new AppError({ status: 413, code: 'PAYLOAD_TOO_LARGE', message: `Payload exceeds the ${limit}-byte limit` }),
  rateLimited: (retryAfterMs: number) =>
    new AppError({ status: 429, code: 'RATE_LIMITED', message: 'Too many requests', retryAfterMs }),
  capabilityUnavailable: (capability: string) =>
    new AppError({
      status: 501,
      code: 'CAPABILITY_UNAVAILABLE',
      message: `"${capability}" is not supported by the arattix fork yet: no verified Arattai endpoint exists for it`,
      details: { capability },
    }),
  queueFull: () =>
    new AppError({
      status: 503,
      code: 'QUEUE_FULL',
      message: 'Outbound queue is full; retry later',
      retryable: true,
      retryAfterMs: 30_000,
    }),
  circuitOpen: (retryAfterMs: number) =>
    new AppError({
      status: 503,
      code: 'UPSTREAM_CIRCUIT_OPEN',
      message: 'Arattai is failing; requests are paused until the circuit breaker cools down',
      retryable: true,
      retryAfterMs,
    }),
  jobExpired: () =>
    new AppError({ status: 410, code: 'JOB_EXPIRED', message: 'Job expired before it could be executed' }),
  shuttingDown: () =>
    new AppError({ status: 503, code: 'SHUTTING_DOWN', message: 'Server is shutting down', retryable: true, retryAfterMs: 5_000 }),
  internal: (cause?: unknown) => new AppError({ status: 500, code: 'INTERNAL', message: 'Internal error', cause }),
};

/** Internal signal: the stored Arattai session is no longer accepted by the server. */
export class AuthExpiredError extends AppError {
  constructor(message = 'Arattai session expired or was revoked', details?: unknown) {
    super({ status: 409, code: 'SESSION_EXPIRED', message, details, retryable: false });
    this.name = 'AuthExpiredError';
  }
}

/** Upstream answered with a shape we do not recognise: the web client contract probably changed. */
export class UpstreamContractError extends AppError {
  constructor(operation: string, detail: string) {
    super({
      status: 502,
      code: 'UPSTREAM_CONTRACT_CHANGED',
      message: `Arattai returned an unexpected response for ${operation}`,
      details: { operation, detail },
      retryable: false,
    });
    this.name = 'UpstreamContractError';
  }
}
