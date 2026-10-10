import crypto from 'node:crypto';
import path from 'node:path';
import type { ErrorRequestHandler, NextFunction, Request, RequestHandler, Response } from 'express';
import multer from 'multer';
import { rateLimit } from 'express-rate-limit';
import type { z } from 'zod';
import { safeEqual, sha256Hex } from '../crypto';
import { AppError, Errors, toAppError } from '../errors';
import type { Logger } from '../logger';
import type { Metrics } from '../metrics';
import { idempotencyKeyHeader } from './schemas';

declare module 'express-serve-static-core' {
  interface Locals {
    requestId: string;
    apiKeyId?: string;
  }
}

/** Validate `value` with a Zod schema; failures become a 400 with per-field issues. */
export function parse<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw Errors.validation(
      result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message, code: i.code })),
    );
  }
  return result.data;
}

export function idempotencyKey(req: Request): string | undefined {
  return parse(idempotencyKeyHeader, req.get('Idempotency-Key'));
}

export const requestId: RequestHandler = (req, res, next) => {
  const incoming = req.get('X-Request-Id');
  const id = incoming && /^[A-Za-z0-9_.-]{8,128}$/.test(incoming) ? incoming : crypto.randomUUID();
  res.locals.requestId = id;
  res.setHeader('X-Request-Id', id);
  next();
};

export function accessLog(logger: Logger, metrics: Metrics): RequestHandler {
  return (req, res, next) => {
    const start = process.hrtime.bigint();
    res.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      const route = req.route?.path ? `${req.baseUrl}${req.route.path}` : 'unmatched';
      metrics.inc('http_requests_total', 'HTTP requests by route and status.', {
        method: req.method,
        route,
        status: res.statusCode,
      });
      metrics.inc('http_request_duration_ms_sum', 'Total HTTP request time by route.', { route }, ms);
      const level = res.statusCode >= 500 ? 'error' : route.startsWith('/health') ? 'debug' : 'http';
      logger.log(level, `${req.method} ${req.originalUrl} ${res.statusCode}`, {
        component: 'http',
        requestId: res.locals.requestId,
        durationMs: Math.round(ms),
        apiKeyId: res.locals.apiKeyId,
      });
    });
    next();
  };
}

/**
 * API key auth: `Authorization: Bearer <key>` or `X-API-Key: <key>`.
 * Keys are compared in constant time; logs only ever see a short hash of the key.
 */
export function apiKeyAuth(keys: string[]): RequestHandler {
  return (req, res, next) => {
    const header = req.get('Authorization');
    const presented = header?.startsWith('Bearer ') ? header.slice(7).trim() : req.get('X-API-Key')?.trim();
    if (!presented) return next(Errors.unauthorized());
    const match = keys.find((k) => safeEqual(k, presented));
    if (!match) return next(Errors.unauthorized());
    res.locals.apiKeyId = sha256Hex(match).slice(0, 12);
    next();
  };
}

export function apiRateLimit(perMinute: number): RequestHandler {
  return rateLimit({
    windowMs: 60_000,
    limit: perMinute,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: (_req, res) => res.locals.apiKeyId ?? 'anonymous',
    handler: (_req, _res, next, options) => next(Errors.rateLimited(options.windowMs)),
  });
}

export function uploadSingle(spoolDir: string, maxBytes: number): RequestHandler {
  return multer({
    storage: multer.diskStorage({
      destination: spoolDir,
      filename: (_req, _file, cb) => cb(null, `up-${crypto.randomUUID()}`),
    }),
    limits: { fileSize: maxBytes, files: 1, fields: 10, fieldSize: 16 * 1024, parts: 12 },
    defParamCharset: 'utf8',
  }).single('file');
}

/** Strip directories, control characters and quoting from a client-supplied file name. */
export function sanitizeFileName(name: string | undefined): string {
  const base = path.basename(String(name ?? '')).replace(/[\u0000-\u001f\u007f"\\/<>:|?*]/g, '_').trim();
  return (base.length > 0 ? base : 'file').slice(0, 200);
}

export const notFound: RequestHandler = (req, _res, next) => next(Errors.routeNotFound(req.method, req.path));

export function errorHandler(logger: Logger, maxUploadBytes: number): ErrorRequestHandler {
  return (err: unknown, req: Request, res: Response, _next: NextFunction) => {
    let e: AppError;
    const any = err as { type?: string; name?: string; code?: string; status?: number };
    if (any?.type === 'entity.parse.failed') e = Errors.invalidJson();
    else if (any?.type === 'entity.too.large') e = Errors.payloadTooLarge(Number((err as { limit?: number }).limit ?? 0));
    else if (any?.name === 'MulterError') {
      e =
        any.code === 'LIMIT_FILE_SIZE'
          ? Errors.payloadTooLarge(maxUploadBytes)
          : new AppError({ status: 400, code: 'UPLOAD_INVALID', message: (err as Error).message, details: { reason: any.code } });
    } else e = toAppError(err);

    if (e.status >= 500 && e.code === 'INTERNAL') {
      logger.error('Unhandled request error', { component: 'http', requestId: res.locals.requestId, err });
    }
    if (res.headersSent) return;
    if (e.retryAfterMs !== undefined) res.setHeader('Retry-After', String(Math.ceil(e.retryAfterMs / 1000)));
    res.status(e.status).json({
      error: {
        code: e.code,
        message: e.message,
        ...(e.details !== undefined ? { details: e.details } : {}),
      },
      requestId: res.locals.requestId,
    });
  };
}
