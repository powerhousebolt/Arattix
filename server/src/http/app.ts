import path from 'node:path';
import express, { type Express } from 'express';
import type { Config } from '../config';
import { safeEqual } from '../crypto';
import { AppError, Errors } from '../errors';
import type { Logger } from '../logger';
import type { Metrics } from '../metrics';
import type { StatusReader } from '../session/status';
import { isPrivateAddress } from '../webhooks/url-guard';
import { adminRouter, type AdminDeps } from './admin-routes';
import { accessLog, apiKeyAuth, apiRateLimit, authFailureLimit, errorHandler, notFound, requestId } from './middleware';
import { apiRouter, type RouteDeps } from './routes';

export interface AppDeps {
  config: Config;
  logger: Logger;
  metrics: Metrics;
  status: StatusReader;
  /** Dependency checks for /health/ready: name → throws when unhealthy. */
  checks: Record<string, () => Promise<void>>;
  /** Omitted for the worker's health/metrics-only listener. */
  api?: Omit<RouteDeps, 'config' | 'status'> & { admin: Omit<AdminDeps, 'config' | 'status' | 'commands' | 'capabilities'> };
}

/** Static admin UI; resolved from src/ (tsx) and dist/ (build) alike. */
export const UI_DIR = path.join(__dirname, '..', '..', 'public');

/**
 * The UI shell is public (it holds no data); every call it makes goes to /api/v1 with the
 * operator's API key. A strict CSP keeps injected markup from running or exfiltrating.
 */
const UI_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

export function createApp(deps: AppDeps): Express {
  const { config, logger, metrics } = deps;
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);
  app.set('etag', false);

  app.use(requestId);
  app.use(accessLog(logger, metrics));

  app.get('/health/live', (_req, res) => {
    res.json({ status: 'ok' });
  });

  app.get('/health/ready', async (req, res) => {
    const checks: Record<string, string> = {};
    let healthy = true;
    for (const [name, check] of Object.entries(deps.checks)) {
      try {
        await check();
        checks[name] = 'ok';
      } catch (err) {
        healthy = false;
        checks[name] = (err as Error).message || 'failed';
      }
    }
    const session = await deps.status.read().catch(() => null);
    const requireSession = req.query.requireSession === 'true';
    if (requireSession && session?.state !== 'READY') healthy = false;
    res.status(healthy ? 200 : 503).json({
      status: healthy ? 'ok' : 'unavailable',
      checks,
      session: session ? { state: session.state, reason: session.reason, workerOnline: session.workerOnline } : null,
    });
  });

  app.get('/metrics', (req, res, next) => {
    if (config.METRICS_TOKEN) {
      const header = req.get('Authorization') ?? '';
      if (!header.startsWith('Bearer ') || !safeEqual(header.slice(7), config.METRICS_TOKEN)) return next(Errors.unauthorized());
    } else if (!isPrivateAddress(req.ip ?? '')) {
      // Without a token, only loopback / private-network scrapers (Prometheus next to the
      // server) may read metrics: behind the public HTTPS proxy they would leak to anyone.
      return next(
        new AppError({
          status: 403,
          code: 'METRICS_FORBIDDEN',
          message: 'Set METRICS_TOKEN to read /metrics from a public address',
        }),
      );
    }
    res.type('text/plain; version=0.0.4').send(metrics.render());
  });

  if (deps.api) {
    app.use(
      '/api/v1',
      authFailureLimit(),
      apiKeyAuth(config.API_KEYS),
      apiRateLimit(config.HTTP_RATE_LIMIT_PER_MINUTE),
      apiRouter({ ...deps.api, config, status: deps.status }),
      adminRouter({
        ...deps.api.admin,
        config,
        status: deps.status,
        commands: deps.api.commands,
        capabilities: deps.api.capabilities,
      }),
    );

    if (config.UI_ENABLED) {
      app.get('/', (_req, res) => res.redirect(302, '/ui/'));
      app.use(
        '/ui',
        (_req, res, next) => {
          res.setHeader('Content-Security-Policy', UI_CSP);
          res.setHeader('X-Content-Type-Options', 'nosniff');
          res.setHeader('X-Frame-Options', 'DENY');
          res.setHeader('Referrer-Policy', 'no-referrer');
          res.setHeader('Cache-Control', 'no-cache');
          next();
        },
        express.static(UI_DIR, { index: 'index.html', redirect: true, dotfiles: 'ignore' }),
      );
    }
  }

  app.use(notFound);
  app.use(errorHandler(logger, config.MEDIA_MAX_BYTES));
  return app;
}
