import request from 'supertest';
import winston from 'winston';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRecentFeed } from '../src/activity/recent';
import { toLogRecord } from '../src/activity/activity';
import { loadConfig } from '../src/config';
import { AppError } from '../src/errors';
import { createSilentLogger } from '../src/logger';
import { MemoryJobQueue } from '../src/queue/memory-queue';
import { createRuntime, type Runtime } from '../src/runtime';
import { readStoredOverrides } from '../src/settings';
import { API_KEY, testConfig, waitUntil } from './helpers/env';
import { FakeGateway } from './helpers/fake-gateway';

const auth = { Authorization: `Bearer ${API_KEY}` };
const runtimes: Runtime[] = [];

/** A real winston logger with no console output, so the admin log feed receives records. */
function quietLogger(level = 'debug') {
  return winston.createLogger({ level, format: winston.format.combine(winston.format.timestamp()), transports: [] });
}

async function boot(env: Record<string, string> = {}, opts: { logger?: winston.Logger; onRestart?: () => void } = {}) {
  const gateway = new FakeGateway();
  const runtime = createRuntime(testConfig(env), {
    gateway,
    logger: opts.logger ?? createSilentLogger(),
    ...(opts.onRestart ? { onRestart: opts.onRestart } : {}),
  });
  runtimes.push(runtime);
  await runtime.start();
  return { runtime, gateway, api: request(runtime.app) };
}

async function bootReady(env: Record<string, string> = {}, opts: Parameters<typeof boot>[1] = {}) {
  const ctx = await boot(env, opts);
  ctx.gateway.qrScript = ['authenticated'];
  await ctx.api.post('/api/v1/auth/session').set(auth).send({}).expect(200);
  await waitUntil(() => ctx.runtime.worker!.connection.isReady());
  return ctx;
}

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((r) => r.stop()));
});

describe('admin UI hosting', () => {
  it('serves the UI shell with a strict CSP and redirects / to it', async () => {
    const { api } = await boot();
    const page = await api.get('/ui/').expect(200);
    expect(page.headers['content-type']).toMatch(/text\/html/);
    expect(page.text).toContain('<script type="module" src="app.js">');
    expect(page.headers['content-security-policy']).toContain("script-src 'self'");
    expect(page.headers['x-frame-options']).toBe('DENY');
    await api.get('/ui/app.js').expect(200).expect('Content-Type', /javascript/);
    await api.get('/ui/app.css').expect(200);
    await api.get('/').expect(302).expect('Location', '/ui/');
  });

  it('keeps the data behind the API key: the UI holds none of its own', async () => {
    const { api } = await boot();
    await api.get('/api/v1/system').expect(401);
    await api.get('/api/v1/logs').expect(401);
    await api.get('/api/v1/settings').expect(401);
  });

  it('can be switched off', async () => {
    const { api } = await boot({ UI_ENABLED: 'false' });
    await api.get('/ui/').expect(404);
    await api.get('/').expect(404);
  });
});

describe('system', () => {
  it('reports version, topology, session and queue counts', async () => {
    const { api } = await bootReady();
    const res = await api.get('/api/v1/system').set(auth).expect(200);
    expect(res.body.data).toMatchObject({
      version: expect.any(String),
      role: 'all',
      storeDriver: 'file',
      queueDriver: 'memory',
      session: { state: 'READY', workerOnline: true },
      capabilities: { 'messages.text': true },
      queues: { control: expect.objectContaining({ completed: expect.any(Number) }), outbound: expect.any(Object) },
    });
    expect(res.body.data.version).not.toBe('unknown');
  });

  it('restarts through the supervisor hook after answering', async () => {
    const onRestart = vi.fn();
    const { api } = await boot({}, { onRestart });
    const res = await api.post('/api/v1/system/restart').set(auth).expect(202);
    expect(res.body.data.restarting).toBe(true);
    await waitUntil(() => onRestart.mock.calls.length === 1);
  });
});

describe('tasks', () => {
  it('lists jobs across queues, newest first, with filters and without spool paths', async () => {
    const { api } = await bootReady();
    await api.post('/api/v1/messages/send').set(auth).send({ chatId: 'CT_1', text: 'one' }).expect(200);
    await api.post('/api/v1/messages/send').set(auth).send({ chatId: 'CT_2', text: 'two' }).expect(200);
    await api.post('/api/v1/messages/media').set(auth).field('chatId', 'CT_1').attach('file', Buffer.from('x'), 'a.txt').expect(200);

    const all = (await api.get('/api/v1/jobs').set(auth).expect(200)).body.data;
    expect(all.map((j: { name: string }) => j.name)).toEqual(['message.media', 'message.text', 'message.text', 'auth.start']);
    expect(all[0]).toMatchObject({ id: expect.stringMatching(/^out_/), queue: 'outbound', state: 'completed', data: { chatId: 'CT_1', fileName: 'a.txt' } });
    expect(all[0].data).not.toHaveProperty('spoolPath');

    const texts = (await api.get('/api/v1/jobs?queue=outbound&name=message.text').set(auth).expect(200)).body.data;
    expect(texts.map((j: { data: { text: string } }) => j.data.text)).toEqual(['two', 'one']);
    expect((await api.get('/api/v1/jobs?queue=control&state=failed').set(auth).expect(200)).body.data).toEqual([]);
    await api.get('/api/v1/jobs?state=bogus').set(auth).expect(400);

    const queues = (await api.get('/api/v1/queues').set(auth).expect(200)).body.data;
    expect(queues.find((q: { queue: string }) => q.queue === 'outbound').counts.completed).toBe(3);
  });

  it('retries a failed job and cancels one that has not started', async () => {
    const { api, gateway, runtime } = await bootReady();
    let fail = true;
    gateway.sendImpl = async () => {
      if (fail) throw new AppError({ status: 502, code: 'UPSTREAM_REJECTED', message: 'nope' });
      return { ok: true };
    };
    const failed = await api.post('/api/v1/messages/send').set(auth).send({ chatId: 'CT_1', text: 'x' }).expect(502);
    const jobId = (await api.get('/api/v1/jobs?state=failed').set(auth)).body.data[0].id;
    expect(failed.body.error.code).toBe('UPSTREAM_REJECTED');

    fail = false;
    await api.post(`/api/v1/jobs/${jobId}/retry`).set(auth).expect(202);
    await waitUntil(async () => (await api.get(`/api/v1/jobs/${jobId}`).set(auth)).body.data.state === 'completed');
    expect((await api.post(`/api/v1/jobs/${jobId}/retry`).set(auth).expect(409)).body.error.code).toBe('JOB_NOT_RETRYABLE');

    const delayed = await runtime.queues.outbound.add('message.text', { chatId: 'CT_9', text: 'later', expiresAt: Date.now() + 60_000 }, { delayMs: 60_000 });
    const delayedId = `out_${delayed.id}`;
    expect((await api.get(`/api/v1/jobs/${delayedId}`).set(auth)).body.data.state).toBe('delayed');
    await api.delete(`/api/v1/jobs/${delayedId}`).set(auth).expect(200);
    const cancelled = (await api.get(`/api/v1/jobs/${delayedId}`).set(auth)).body.data;
    expect(cancelled).toMatchObject({ state: 'failed', error: { code: 'JOB_CANCELLED' } });
    expect((await api.delete(`/api/v1/jobs/${delayedId}`).set(auth).expect(409)).body.error.code).toBe('JOB_NOT_CANCELLABLE');
    await api.delete('/api/v1/jobs/out_missing').set(auth).expect(404);
    await api.post('/api/v1/jobs/nope/retry').set(auth).expect(404);
  });
});

describe('logs and events', () => {
  it('keeps redacted log records and filters them by level, component, text and cursor', async () => {
    const logger = quietLogger();
    const { api, runtime } = await bootReady({ LOG_LEVEL: 'debug' }, { logger });
    runtime.logger.warn('Disk is getting full', { component: 'spool', password: 'hunter2' });
    runtime.logger.error('Upstream exploded', { component: 'gateway', err: new Error('boom') });

    const all = (await api.get('/api/v1/logs?limit=1000').set(auth).expect(200)).body.data;
    expect(all.entries.length).toBeGreaterThan(2);
    const warn = all.entries.find((e: { message: string }) => e.message === 'Disk is getting full');
    expect(warn).toMatchObject({ level: 'warn', component: 'spool', meta: { password: '[REDACTED]' } });

    const problems = (await api.get('/api/v1/logs?level=warn').set(auth).expect(200)).body.data.entries;
    expect(problems.map((e: { level: string }) => e.level).every((l: string) => l === 'warn' || l === 'error')).toBe(true);
    expect(problems.at(-1)).toMatchObject({ message: 'Upstream exploded', meta: { err: { message: 'boom' } } });

    expect((await api.get('/api/v1/logs?component=gateway').set(auth)).body.data.entries).toHaveLength(1);
    expect((await api.get('/api/v1/logs?q=disk%20is').set(auth)).body.data.entries).toHaveLength(1);

    const cursor = all.cursor;
    runtime.logger.info('After the cursor', { component: 'test' });
    const tail = (await api.get(`/api/v1/logs?after=${cursor}`).set(auth)).body.data;
    expect(tail.entries.map((e: { message: string }) => e.message)).toContain('After the cursor');
    expect(tail.entries.every((e: { seq: number }) => e.seq > cursor)).toBe(true);

    await api.delete('/api/v1/logs').set(auth).expect(200);
    expect((await api.get('/api/v1/logs?component=spool').set(auth)).body.data.entries).toEqual([]);
  });

  it('records events and strips login material', async () => {
    const { api } = await bootReady();
    await api.post('/api/v1/messages/send').set(auth).send({ chatId: 'CT_1', text: 'hi' }).expect(200);
    const events = (await api.get('/api/v1/events').set(auth).expect(200)).body.data.entries;
    const types = events.map((e: { type: string }) => e.type);
    expect(types).toEqual(expect.arrayContaining(['session.qr', 'session.state_changed', 'message.sent']));
    expect(events.find((e: { type: string }) => e.type === 'session.qr').data).toEqual({ redacted: true });
    expect(JSON.stringify(events)).not.toContain('oneauth.example');

    const sent = (await api.get('/api/v1/events?type=message.sent').set(auth)).body.data.entries;
    expect(sent).toHaveLength(1);
    expect(sent[0].data).toMatchObject({ chatId: 'CT_1', kind: 'text' });
  });
});

describe('settings', () => {
  it('describes every setting with its source and masks secrets', async () => {
    const { api } = await boot({ SEND_BURST: '7' });
    const { settings, restartRequired } = (await api.get('/api/v1/settings').set(auth).expect(200)).body.data;
    const byKey = Object.fromEntries(settings.map((s: { key: string }) => [s.key, s]));
    expect(restartRequired).toBe(false);
    expect(byKey.SEND_BURST).toMatchObject({ value: '7', source: 'env', editable: true, pending: null });
    expect(byKey.JOB_ATTEMPTS).toMatchObject({ value: '3', source: 'default' });
    expect(byKey.API_KEYS).toMatchObject({ value: '1 key configured', secret: true, editable: false });
    expect(byKey.MASTER_KEY.value).toBe('configured');
    expect(JSON.stringify(settings)).not.toContain(API_KEY);
  });

  it('validates edits, applies live ones now and the rest on the next start', async () => {
    const logger = quietLogger('info');
    const { api, runtime } = await boot({}, { logger });

    expect((await api.put('/api/v1/settings').set(auth).send({ values: { API_KEYS: 'x'.repeat(30) } }).expect(400)).body.error.code).toBe('SETTING_NOT_EDITABLE');
    await api.put('/api/v1/settings').set(auth).send({ values: { ARATTAI_ENDPOINT_OVERRIDES: '{"X":"https://evil.example"}' } }).expect(400);
    const bad = await api.put('/api/v1/settings').set(auth).send({ values: { SEND_RATE_PER_MINUTE: '0' } }).expect(400);
    expect(bad.body.error.details[0].path).toBe('SEND_RATE_PER_MINUTE');
    const cross = await api.put('/api/v1/settings').set(auth).send({ values: { RECONNECT_BASE_MS: '50000' } }).expect(400);
    expect(cross.body.error.details[0]).toMatchObject({ path: 'RECONNECT_MAX_MS', message: expect.stringMatching(/RECONNECT_BASE_MS/) });

    const saved = (await api.put('/api/v1/settings').set(auth).send({ values: { LOG_LEVEL: 'debug', SEND_RATE_PER_MINUTE: 42 } }).expect(200)).body.data;
    expect(logger.level).toBe('debug');
    const byKey = Object.fromEntries(saved.settings.map((s: { key: string }) => [s.key, s]));
    expect(byKey.LOG_LEVEL).toMatchObject({ value: 'debug', source: 'override', pending: null, live: true });
    expect(byKey.SEND_RATE_PER_MINUTE).toMatchObject({ value: '6000', pending: '42' });
    expect(saved.restartRequired).toBe(true);

    // What the next start sees.
    const stored = await readStoredOverrides(runtime.config);
    expect(stored).toEqual({ LOG_LEVEL: 'debug', SEND_RATE_PER_MINUTE: '42' });
    const next = loadConfig(runtime.config.sourceEnv, stored);
    expect(next).toMatchObject({ SEND_RATE_PER_MINUTE: 42, LOG_LEVEL: 'debug', appliedOverrides: stored });

    // Removing an override.
    const reset = (await api.put('/api/v1/settings').set(auth).send({ values: { LOG_LEVEL: null } }).expect(200)).body.data;
    expect(logger.level).toBe('error'); // the test environment's LOG_LEVEL
    expect(reset.settings.find((s: { key: string }) => s.key === 'LOG_LEVEL')).toMatchObject({ source: 'env', pending: null });
  });
});

describe('primitives', () => {
  it('recent feed keeps the newest entries and tails by cursor', async () => {
    const feed = new MemoryRecentFeed<{ n: number }>(3);
    for (let n = 1; n <= 5; n += 1) feed.push({ n });
    expect((await feed.list({ limit: 10 })).map((e) => e.n)).toEqual([3, 4, 5]);
    expect((await feed.list({ limit: 2 })).map((e) => e.seq)).toEqual([4, 5]);
    expect((await feed.list({ limit: 10, after: 4 })).map((e) => e.n)).toEqual([5]);
    expect((await feed.list({ limit: 10 }, (e) => e.n % 2 === 1)).map((e) => e.n)).toEqual([3, 5]);
    const off = new MemoryRecentFeed<{ n: number }>(0);
    off.push({ n: 1 });
    expect(await off.list({ limit: 10 })).toEqual([]);
  });

  it('log records carry structured fields and cap their size', () => {
    const r = toLogRecord({ level: 'info', message: 'm', component: 'c', timestamp: '2026-01-01T00:00:00.000Z', pid: 1, blob: 'x'.repeat(20_000) });
    expect(r).toMatchObject({ level: 'info', message: 'm', component: 'c', at: '2026-01-01T00:00:00.000Z', pid: 1, meta: { truncated: true } });
  });

  it('memory queue lists newest first and supports retry and cancel', async () => {
    const q = new MemoryJobQueue('t', { maxPending: 100 }, createSilentLogger());
    let fail = true;
    q.process(async (job) => {
      if (job.name === 'boom' && fail) throw new AppError({ status: 400, code: 'NOPE', message: 'no' });
      return job.data;
    }, 1);
    const a = await q.add('ok', 1);
    await q.waitForResult(a.id, 1000);
    const b = await q.add('boom', 2);
    await expect(q.waitForResult(b.id, 1000)).rejects.toMatchObject({ code: 'NOPE' });
    const c = await q.add('ok', 3, { delayMs: 60_000 });

    expect((await q.list(['completed', 'failed', 'delayed'], 10)).map((j) => j.id)).toEqual([c.id, b.id, a.id]);
    expect((await q.list(['failed'], 10))[0]).toMatchObject({ id: b.id, data: 2, error: { code: 'NOPE' } });

    fail = false;
    expect(await q.retry(a.id)).toBe(false);
    expect(await q.retry(b.id)).toBe(true);
    await expect(q.waitForResult(b.id, 1000)).resolves.toBe(2);
    expect(await q.getJob(b.id)).toMatchObject({ state: 'completed', attemptsMade: 1 });

    const waiter = q.waitForResult(c.id, 1000).catch((e) => e);
    expect(await q.cancel(c.id)).toBe(true);
    expect(await waiter).toMatchObject({ code: 'JOB_CANCELLED' });
    expect(await q.cancel(c.id)).toBe(false);
    await q.close();
  });
});
