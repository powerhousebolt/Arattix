import fs from 'node:fs';
import path from 'node:path';
import express, { type Response, Router } from 'express';
import { z } from 'zod';
import { atLeast, LOG_LEVELS, type EventRecord, type LogRecord } from '../activity/activity';
import type { RecentFeed } from '../activity/recent';
import type { Capabilities } from '../arattai/gateway';
import type { Config } from '../config';
import { AppError, Errors } from '../errors';
import { EVENT_TYPES } from '../events/bus';
import type { CommandBus } from '../jobs/commands';
import { parsePublicJobId, QUEUE_KINDS, toPublicJobId, type QueueKind } from '../jobs/contracts';
import type { Logger } from '../logger';
import { LISTABLE_STATES, type JobCounts, type JobRecord } from '../queue/types';
import type { StatusReader } from '../session/status';
import { describeSettings, type SettingsStore } from '../settings';
import { jobIdParams } from './schemas';
import { parse } from './middleware';

export interface AdminDeps {
  config: Config;
  logger: Logger;
  commands: CommandBus;
  status: StatusReader;
  capabilities: Capabilities;
  logs: RecentFeed<LogRecord>;
  events: RecentFeed<EventRecord>;
  settings: SettingsStore;
  /** Ask the process supervisor for a restart (graceful shutdown, then exit). */
  restart: () => void;
  startedAt: Date;
}

function send(res: Response, status: number, data: unknown): void {
  res.status(status).json({ data, requestId: res.locals.requestId });
}

const csv = <T extends string>(values: readonly [T, ...T[]]) =>
  z
    .string()
    .optional()
    .transform((s) => (s ? s.split(',').map((v) => v.trim()).filter(Boolean) : []))
    .pipe(z.array(z.enum(values)));

const afterSeq = z.coerce.number().int().min(0).optional();

const logsQuery = z.object({
  after: afterSeq,
  limit: z.coerce.number().int().min(1).max(1000).default(200),
  /** Minimum severity: "warn" returns warn and error. */
  level: z.enum(LOG_LEVELS).optional(),
  component: z.string().max(64).optional(),
  q: z.string().max(200).optional(),
});

const eventsQuery = z.object({
  after: afterSeq,
  limit: z.coerce.number().int().min(1).max(500).default(100),
  type: csv(EVENT_TYPES as unknown as readonly [string, ...string[]]),
});

const jobsQuery = z.object({
  queue: csv(QUEUE_KINDS),
  state: csv(LISTABLE_STATES as unknown as readonly ['waiting', 'delayed', 'active', 'completed', 'failed']),
  name: z.string().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const settingsBody = z.object({
  values: z.record(z.string(), z.union([z.string().max(4_000), z.number(), z.boolean(), z.null()])),
});

/** Strip worker-internal fields (spool paths) from job payloads shown to clients. */
function publicData(data: unknown): unknown {
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const { spoolPath: _p, ...rest } = data as Record<string, unknown>;
    return rest;
  }
  return data;
}

function publicJob(kind: QueueKind, job: JobRecord): JobRecord & { queue: QueueKind } {
  const out: JobRecord & { queue: QueueKind } = { ...job, id: toPublicJobId(kind, job.id), queue: kind };
  if ('data' in job) out.data = publicData(job.data);
  if ('result' in job) out.result = publicData(job.result);
  return out;
}

function readVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')) as { version?: string };
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Operator endpoints behind the admin UI: system overview, task (job) management, log and
 * event feeds, and runtime settings. Mounted under /api/v1 with the same API key auth.
 */
export function adminRouter(deps: AdminDeps): Router {
  const { config, commands, status } = deps;
  const router = Router();
  const json = express.json({ limit: '64kb', strict: true });
  const version = readVersion();

  // ─── system ─────────────────────────────────────────────────────────
  router.get('/system', async (_req, res) => {
    const queues = {} as Record<QueueKind, JobCounts | { error: string }>;
    await Promise.all(
      QUEUE_KINDS.map(async (kind) => {
        queues[kind] = await commands
          .queue(kind)
          .counts()
          .catch((err: Error) => ({ error: err.message }));
      }),
    );
    const mem = process.memoryUsage();
    send(res, 200, {
      version,
      node: process.version,
      pid: process.pid,
      role: config.ROLE,
      sessionId: config.SESSION_ID,
      storeDriver: config.STORE_DRIVER,
      queueDriver: config.QUEUE_DRIVER,
      startedAt: deps.startedAt.toISOString(),
      uptimeSeconds: Math.round(process.uptime()),
      memory: { rss: mem.rss, heapUsed: mem.heapUsed, heapTotal: mem.heapTotal },
      logLevel: deps.logger.level,
      session: await status.read(),
      capabilities: deps.capabilities,
      queues,
    });
  });

  router.post('/system/restart', (_req, res) => {
    deps.logger.warn('Restart requested through the API', { component: 'admin', apiKeyId: res.locals.apiKeyId });
    send(res, 202, {
      restarting: true,
      role: config.ROLE,
      note: 'The process shuts down gracefully; a supervisor (Docker, PM2, systemd) must start it again.',
    });
    res.on('finish', () => setImmediate(deps.restart));
  });

  // ─── tasks (jobs) ───────────────────────────────────────────────────
  router.get('/queues', async (_req, res) => {
    const out = await Promise.all(QUEUE_KINDS.map(async (kind) => ({ queue: kind, counts: await commands.queue(kind).counts() })));
    send(res, 200, out);
  });

  router.get('/jobs', async (req, res) => {
    const q = parse(jobsQuery, req.query);
    const kinds = q.queue.length > 0 ? q.queue : [...QUEUE_KINDS];
    const states = q.state.length > 0 ? q.state : LISTABLE_STATES;
    // Over-fetch when filtering by name so the filter does not starve the page.
    const fetch = q.name ? Math.min(q.limit * 5, 1000) : q.limit;
    const lists = await Promise.all(
      kinds.map(async (kind) => (await commands.queue(kind).list(states, fetch)).map((j) => publicJob(kind, j))),
    );
    const jobs = lists
      .flat()
      .filter((j) => !q.name || j.name === q.name)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, q.limit);
    send(res, 200, jobs);
  });

  router.post('/jobs/:id/retry', async (req, res) => {
    const { id } = parse(jobIdParams, req.params);
    const parsed = parsePublicJobId(id);
    if (!parsed) throw Errors.notFound('Job');
    const queue = commands.queue(parsed.kind);
    const job = await queue.getJob(parsed.rawId);
    if (!job) throw Errors.notFound('Job');
    if (!(await queue.retry(parsed.rawId))) {
      throw new AppError({ status: 409, code: 'JOB_NOT_RETRYABLE', message: `Only failed jobs can be retried; this one is ${job.state}` });
    }
    deps.logger.info('Job retried through the API', { component: 'admin', jobId: id });
    send(res, 202, { id, retried: true, statusUrl: `/api/v1/jobs/${id}` });
  });

  router.delete('/jobs/:id', async (req, res) => {
    const { id } = parse(jobIdParams, req.params);
    const parsed = parsePublicJobId(id);
    if (!parsed) throw Errors.notFound('Job');
    const queue = commands.queue(parsed.kind);
    const job = await queue.getJob(parsed.rawId);
    if (!job) throw Errors.notFound('Job');
    if (!(await queue.cancel(parsed.rawId))) {
      throw new AppError({ status: 409, code: 'JOB_NOT_CANCELLABLE', message: `Only waiting or delayed jobs can be cancelled; this one is ${job.state}` });
    }
    deps.logger.info('Job cancelled through the API', { component: 'admin', jobId: id });
    send(res, 200, { id, cancelled: true });
  });

  // ─── logs & events ──────────────────────────────────────────────────
  router.get('/logs', async (req, res) => {
    const q = parse(logsQuery, req.query);
    const needle = q.q?.toLowerCase();
    const entries = await deps.logs.list({ limit: q.limit, ...(q.after !== undefined ? { after: q.after } : {}) }, (e) => {
      if (q.level && !atLeast(e.level, q.level)) return false;
      if (q.component && e.component !== q.component) return false;
      if (needle && !`${e.message} ${JSON.stringify(e.meta)}`.toLowerCase().includes(needle)) return false;
      return true;
    });
    send(res, 200, { entries, cursor: entries.at(-1)?.seq ?? q.after ?? 0, bufferSize: config.LOG_BUFFER_SIZE });
  });

  router.delete('/logs', async (_req, res) => {
    await deps.logs.clear();
    send(res, 200, { cleared: true });
  });

  router.get('/events', async (req, res) => {
    const q = parse(eventsQuery, req.query);
    const entries = await deps.events.list(
      { limit: q.limit, ...(q.after !== undefined ? { after: q.after } : {}) },
      (e) => q.type.length === 0 || q.type.includes(e.type),
    );
    send(res, 200, { entries, cursor: entries.at(-1)?.seq ?? q.after ?? 0 });
  });

  // ─── settings ───────────────────────────────────────────────────────
  router.get('/settings', async (_req, res) => {
    const stored = await deps.settings.read();
    const settings = describeSettings(config, stored);
    send(res, 200, { settings, restartRequired: settings.some((s) => s.pending !== null && !s.live) });
  });

  router.put('/settings', json, async (req, res) => {
    const body = parse(settingsBody, req.body);
    const values = Object.fromEntries(Object.entries(body.values).map(([k, v]) => [k, v === null ? null : String(v)]));
    const stored = await deps.settings.update(values);
    // Live settings take effect in this process right away.
    if ('LOG_LEVEL' in values) {
      deps.logger.level = stored.LOG_LEVEL ?? config.sourceEnv.LOG_LEVEL ?? 'info';
      config.appliedOverrides = { ...config.appliedOverrides };
      if (stored.LOG_LEVEL) config.appliedOverrides.LOG_LEVEL = stored.LOG_LEVEL;
      else delete config.appliedOverrides.LOG_LEVEL;
      config.LOG_LEVEL = deps.logger.level as Config['LOG_LEVEL'];
    }
    const settings = describeSettings(config, stored);
    send(res, 200, { settings, restartRequired: settings.some((s) => s.pending !== null && !s.live) });
  });

  return router;
}
