/**
 * Integration tests for the Redis-backed deployment (BullMQ queues, Redis store, session lease,
 * split API/worker roles). Skipped unless REDIS_URL points at a disposable Redis.
 *   REDIS_URL=redis://127.0.0.1:6379 npm test
 */
import crypto from 'node:crypto';
import { Redis } from 'ioredis';
import request from 'supertest';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import winston from 'winston';
import { RedisRecentFeed } from '../src/activity/recent';
import { AppError } from '../src/errors';
import { RedisKeyValueStore } from '../src/kv';
import { createSilentLogger } from '../src/logger';
import { BullJobQueue } from '../src/queue/bullmq-queue';
import { JobWaitTimeoutError } from '../src/queue/types';
import { createRuntime, type Runtime } from '../src/runtime';
import { Lease } from '../src/session/lease';
import { readStoredOverrides } from '../src/settings';
import { API_KEY, tempDir, testConfig, waitUntil } from './helpers/env';
import { FakeGateway } from './helpers/fake-gateway';

const REDIS_URL = process.env.REDIS_URL;
const logger = createSilentLogger();
const clients: Redis[] = [];
const closers: Array<() => Promise<unknown>> = [];

function redis(): Redis {
  const c = new Redis(REDIS_URL!, { maxRetriesPerRequest: null });
  clients.push(c);
  return c;
}
const prefix = () => `t${crypto.randomBytes(4).toString('hex')}`;

afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close().catch(() => undefined);
});
afterAll(async () => {
  await Promise.all(clients.map((c) => c.quit().catch(() => undefined)));
});

describe.skipIf(!REDIS_URL)('BullJobQueue', () => {
  function queue(maxPending = 100) {
    const q = new BullJobQueue(`q-${prefix()}`, { prefix: prefix(), maxPending, connect: redis }, logger);
    closers.push(() => q.close());
    return q;
  }

  it('processes jobs and returns results to waiters across connections', async () => {
    const q = queue();
    q.process(async (job) => ({ doubled: (job.data as number) * 2 }), 2);
    const { id } = await q.add('double', 21);
    await expect(q.waitForResult(id, 5000)).resolves.toEqual({ doubled: 42 });
    expect(await q.getJob(id)).toMatchObject({ state: 'completed', result: { doubled: 42 }, attemptsMade: 1 });
  });

  it('retries retryable AppErrors and carries non-retryable ones across Redis intact', async () => {
    const q = queue();
    let calls = 0;
    q.process(async (job) => {
      if (job.name === 'flaky' && ++calls < 3) throw new AppError({ status: 503, code: 'TRANSIENT', message: 't', retryable: true });
      if (job.name === 'fatal') throw new AppError({ status: 409, code: 'SESSION_NOT_READY', message: 'nope', details: { state: 'QR_READY' } });
      return 'ok';
    }, 1);

    const flaky = await q.add('flaky', null, { attempts: 5, backoffMs: 10 });
    await expect(q.waitForResult(flaky.id, 5000)).resolves.toBe('ok');

    const fatal = await q.add('fatal', null, { attempts: 5, backoffMs: 10 });
    const err = await q.waitForResult(fatal.id, 5000).catch((e) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err).toMatchObject({ status: 409, code: 'SESSION_NOT_READY', details: { state: 'QR_READY' } });
    expect(await q.getJob(fatal.id)).toMatchObject({ state: 'failed', attemptsMade: 1, error: { code: 'SESSION_NOT_READY' } });
  });

  it('dedupes by job id, times out waiters and applies backpressure', async () => {
    const q = queue(1);
    const a = await q.add('n', 1, { jobId: 'fixed-id' });
    expect(await q.add('n', 1, { jobId: 'fixed-id' })).toEqual({ id: a.id, deduplicated: true });
    await expect(q.waitForResult(a.id, 200)).rejects.toBeInstanceOf(JobWaitTimeoutError);
    await expect(q.add('n', 2)).rejects.toMatchObject({ code: 'QUEUE_FULL' });
  });
});

describe.skipIf(!REDIS_URL)('BullJobQueue admin operations', () => {
  it('lists jobs newest first per state, retries failed ones and cancels pending ones', async () => {
    const q = new BullJobQueue(`q-${prefix()}`, { prefix: prefix(), maxPending: 100, connect: redis }, logger);
    closers.push(() => q.close());
    let fail = true;
    q.process(async (job) => {
      if (job.name === 'boom' && fail) throw new AppError({ status: 400, code: 'NOPE', message: 'no' });
      return job.data;
    }, 1);
    const a = await q.add('ok', { n: 1 });
    await q.waitForResult(a.id, 5000);
    const b = await q.add('boom', { n: 2 });
    await q.waitForResult(b.id, 5000).catch(() => undefined);
    const c = await q.add('ok', { n: 3 }, { delayMs: 60_000 });

    const listed = await q.list(['completed', 'failed', 'delayed'], 10);
    expect(listed.map((j) => [j.id, j.state])).toEqual([
      [c.id, 'delayed'],
      [b.id, 'failed'],
      [a.id, 'completed'],
    ]);
    expect(listed[1]).toMatchObject({ data: { n: 2 }, error: { code: 'NOPE' } });

    fail = false;
    expect(await q.retry(a.id)).toBe(false);
    expect(await q.retry(b.id)).toBe(true);
    await waitUntil(async () => (await q.getJob(b.id))?.state === 'completed', 5000);

    expect(await q.cancel(c.id)).toBe(true);
    expect(await q.getJob(c.id)).toBeNull();
    expect(await q.cancel(a.id)).toBe(false);
  });
});

describe.skipIf(!REDIS_URL)('RedisRecentFeed', () => {
  it('shares a capped feed with sequence numbers across connections', async () => {
    const key = `${prefix()}:recent:test`;
    const conns = [redis(), redis()];
    const writer = new RedisRecentFeed<{ n: number }>(conns[0]!, key, 3);
    const reader = new RedisRecentFeed<{ n: number }>(conns[1]!, key, 3);
    await waitUntil(() => conns.every((c) => c.status === 'ready'));
    for (let n = 1; n <= 5; n += 1) writer.push({ n });
    await waitUntil(async () => (await reader.list({ limit: 10 })).at(-1)?.n === 5);
    expect((await reader.list({ limit: 10 })).map((e) => [e.n, e.seq])).toEqual([
      [3, 3],
      [4, 4],
      [5, 5],
    ]);
    expect((await reader.list({ limit: 10, after: 4 })).map((e) => e.n)).toEqual([5]);
    await reader.clear();
    expect(await reader.list({ limit: 10 })).toEqual([]);
  });
});

describe.skipIf(!REDIS_URL)('RedisKeyValueStore and Lease', () => {
  it('stores JSON with TTL and scans keys by prefix, escaping glob characters', async () => {
    const kv = new RedisKeyValueStore(redis(), prefix());
    await kv.set('webhook:a*', { v: 1 });
    await kv.set('webhook:b', { v: 2 }, 50);
    await kv.set('other:c', { v: 3 });
    expect((await kv.keys('webhook:')).sort()).toEqual(['webhook:a*', 'webhook:b']);
    expect(await kv.keys('webhook:a*')).toEqual(['webhook:a*']);
    await new Promise((r) => setTimeout(r, 80));
    expect(await kv.get('webhook:b')).toBeNull();
  });

  it('grants the session to one worker at a time and reports takeover', async () => {
    const key = `${prefix()}:lease`;
    const a = new Lease(redis(), key, 600, logger);
    const b = new Lease(redis(), key, 600, logger);
    expect(await a.tryAcquire()).toBe(true);
    expect(await b.tryAcquire()).toBe(false);

    let lost = false;
    a.startRenewal(() => (lost = true));
    await redis().set(key, 'intruder');
    await waitUntil(() => lost, 2000);
    await a.release();
    expect(await redis().get(key)).toBe('intruder'); // release never deletes someone else's lease
  });
});

describe.skipIf(!REDIS_URL)('split deployment (ROLE=api + ROLE=worker)', () => {
  const runtimes: Runtime[] = [];
  afterEach(async () => {
    await Promise.all(runtimes.splice(0).map((r) => r.stop()));
  });

  function split() {
    const shared = {
      REDIS_URL: REDIS_URL!,
      REDIS_PREFIX: prefix(),
      STORE_DRIVER: 'redis',
      QUEUE_DRIVER: 'bullmq',
      DATA_DIR: tempDir(), // spool shared by API and worker, as on one PM2 host
      LEASE_TTL_MS: '5000',
    };
    const gateway = new FakeGateway();
    const worker = createRuntime(testConfig({ ...shared, ROLE: 'worker' }), { gateway, logger, onFatal: () => undefined });
    const api = createRuntime(testConfig({ ...shared, ROLE: 'api' }), { logger });
    runtimes.push(api, worker);
    return { shared, gateway, worker, api };
  }

  it('drives QR login and sends through the API while only the worker touches Arattai', async () => {
    const { gateway, worker, api } = split();
    await Promise.all([worker.start(), api.start()]);
    await worker.whenActive();
    const http = request(api.app);
    const auth = { Authorization: `Bearer ${API_KEY}` };

    expect(api.worker).toBeNull(); // the API process has no gateway at all
    gateway.qrScript = ['authenticated'];
    const started = await http.post('/api/v1/auth/session').set(auth).send({}).expect(200);
    expect(started.body.data.result.state).toBe('QR_READY');

    await waitUntil(async () => (await http.get('/api/v1/auth/status').set(auth)).body.data.state === 'READY', 5000);
    const status = await http.get('/api/v1/auth/status').set(auth).expect(200);
    expect(status.body.data.workerOnline).toBe(true);

    await http.post('/api/v1/messages/send').set(auth).send({ chatId: 'CT_1', text: 'via redis' }).expect(200);
    expect(gateway.sent).toEqual([{ chatId: 'CT_1', text: 'via redis' }]);

    await http.post('/api/v1/messages/media').set(auth).field('chatId', 'CT_1').attach('file', Buffer.from('abc'), 'a.txt').expect(200);
    expect(gateway.media[0]).toMatchObject({ fileName: 'a.txt', bytes: 3 });

    // Worker goes away: the API notices instead of silently queueing into the void.
    await worker.stop();
    const offline = await http.post('/api/v1/messages/send').set(auth).send({ chatId: 'CT_1', text: 'x' }).expect(503);
    expect(offline.body.error.code).toBe('WORKER_UNAVAILABLE');
  });

  it('shows the worker\'s logs, events and tasks through the API process, and shares settings', async () => {
    const shared = {
      REDIS_URL: REDIS_URL!,
      REDIS_PREFIX: prefix(),
      STORE_DRIVER: 'redis',
      QUEUE_DRIVER: 'bullmq',
      DATA_DIR: tempDir(),
      LEASE_TTL_MS: '5000',
      LOG_LEVEL: 'info',
      HTTP_RATE_LIMIT_PER_MINUTE: '10000',
    };
    const gateway = new FakeGateway();
    const workerLogger = winston.createLogger({ level: 'info', format: winston.format.timestamp(), defaultMeta: { role: 'worker' }, transports: [] });
    const worker = createRuntime(testConfig({ ...shared, ROLE: 'worker' }), { gateway, logger: workerLogger, onFatal: () => undefined });
    const api = createRuntime(testConfig({ ...shared, ROLE: 'api' }), { logger });
    runtimes.push(api, worker);
    await Promise.all([worker.start(), api.start()]);
    await worker.whenActive();
    const http = request(api.app);
    const auth = { Authorization: `Bearer ${API_KEY}` };

    gateway.qrScript = ['authenticated'];
    await http.post('/api/v1/auth/session').set(auth).send({}).expect(200);
    await waitUntil(async () => (await http.get('/api/v1/auth/status').set(auth)).body.data.state === 'READY', 5000);
    await http.post('/api/v1/messages/send').set(auth).send({ chatId: 'CT_1', text: 'hello' }).expect(200);

    await waitUntil(async () => {
      const logs = (await http.get('/api/v1/logs?component=connection').set(auth).expect(200)).body.data.entries;
      return logs.some((l: { role: string; message: string }) => l.role === 'worker' && /READY/.test(l.message));
    }, 5000, 100);
    await waitUntil(async () => {
      const events = (await http.get('/api/v1/events?type=message.sent').set(auth).expect(200)).body.data.entries;
      return events.length === 1;
    }, 5000, 100);
    const jobs = (await http.get('/api/v1/jobs?queue=outbound').set(auth).expect(200)).body.data;
    expect(jobs[0]).toMatchObject({ name: 'message.text', state: 'completed', data: { chatId: 'CT_1', text: 'hello' } });

    await http.put('/api/v1/settings').set(auth).send({ values: { SEND_BURST: '9' } }).expect(200);
    expect(await readStoredOverrides(worker.config)).toEqual({ SEND_BURST: '9' });
  });

  it('keeps a second worker on standby (alive, not ready) until the lease is free', async () => {
    const { shared } = split();
    const first = runtimes[1]!;
    await first.start();
    await first.whenActive();
    const standby = createRuntime(testConfig({ ...shared, ROLE: 'worker' }), { gateway: new FakeGateway(), logger, onFatal: () => undefined });
    runtimes.push(standby);
    await standby.start();
    expect(standby.isActive()).toBe(false);
    await request(standby.app).get('/health/live').expect(200);
    const notReady = await request(standby.app).get('/health/ready').expect(503);
    expect(notReady.body.checks.lease).toMatch(/standby/);

    await first.stop(); // releases the lease
    await standby.whenActive();
    await request(standby.app).get('/health/ready').expect(200);
  });
});
