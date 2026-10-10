import express, { type Express } from 'express';
import type { Config } from '../config';
import { safeEqual } from '../crypto';
import { Errors } from '../errors';
import type { Logger } from '../logger';
import type { Metrics } from '../metrics';
import type { StatusReader } from '../session/status';
import { accessLog, apiKeyAuth, apiRateLimit, errorHandler, notFound, requestId } from './middleware';
import { apiRouter, type RouteDeps } from './routes';

export interface AppDeps {
  config: Config;
  logger: Logger;
  metrics: Metrics;
  status: StatusReader;
  /** Dependency checks for /health/ready: name → throws when unhealthy. */
  checks: Record<string, () => Promise<void>>;
  /** Omitted for the worker's health/metrics-only listener. */
  api?: Omit<RouteDeps, 'config' | 'status'>;
}

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
    }
    res.type('text/plain; version=0.0.4').send(metrics.render());
  });

  if (deps.api) {
    app.use(
      '/api/v1',
      apiKeyAuth(config.API_KEYS),
      apiRateLimit(config.HTTP_RATE_LIMIT_PER_MINUTE),
      apiRouter({ ...deps.api, config, status: deps.status }),
    );
  }

  app.use(notFound);
  app.use(errorHandler(logger, config.MEDIA_MAX_BYTES));
  return app;
}
