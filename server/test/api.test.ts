import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { classifyUpstreamError } from '../src/arattai/classify';
import { AppError } from '../src/errors';
import { AUTH_FAILURE_LIMIT } from '../src/http/middleware';
import { createSilentLogger } from '../src/logger';
import { createRuntime, type Runtime } from '../src/runtime';
import { verifySignature } from '../src/webhooks/signature';
import { API_KEY, testConfig, waitUntil } from './helpers/env';
import { chat, FakeGateway } from './helpers/fake-gateway';

const auth = { Authorization: `Bearer ${API_KEY}` };
const runtimes: Runtime[] = [];

async function boot(env: Record<string, string> = {}, gateway = new FakeGateway()) {
  const runtime = createRuntime(testConfig(env), { gateway, logger: createSilentLogger() });
  runtimes.push(runtime);
  await runtime.start();
  return { runtime, gateway, api: request(runtime.app) };
}

/** Boot and complete a QR login so the session is READY. */
async function bootReady(env: Record<string, string> = {}) {
  const ctx = await boot(env);
  ctx.gateway.qrScript = ['authenticated'];
  await ctx.api.post('/api/v1/auth/session').set(auth).send({}).expect(200);
  await waitUntil(() => ctx.runtime.worker!.connection.isReady());
  return ctx;
}

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((r) => r.stop()));
});

describe('auth & errors', () => {
  it('rejects missing and wrong API keys with the unified error shape', async () => {
    const { api } = await boot();
    const res = await api.get('/api/v1/auth/status').expect(401);
    expect(res.body).toEqual({ error: { code: 'UNAUTHORIZED', message: 'Missing or invalid API key' }, requestId: expect.any(String) });
    await api.get('/api/v1/auth/status').set('X-API-Key', 'wrong-key-wrong-key-wrong').expect(401);
    await api.get('/api/v1/auth/status').set('X-API-Key', API_KEY).expect(200);
  });

  it('locks out a client IP after repeated wrong API keys; accepted keys never count', async () => {
    const { api } = await boot();
    for (let i = 0; i < AUTH_FAILURE_LIMIT + 5; i++) await api.get('/api/v1/auth/status').set(auth).expect(200);
    for (let i = 0; i < AUTH_FAILURE_LIMIT; i++) {
      await api.get('/api/v1/auth/status').set('X-API-Key', 'wrong-key-wrong-key-wrong').expect(401);
    }
    const locked = await api.get('/api/v1/auth/status').set('X-API-Key', 'wrong-key-wrong-key-wrong').expect(429);
    expect(locked.body.error.code).toBe('RATE_LIMITED');
    expect(locked.headers['retry-after']).toBe('900');
    // The lockout is per IP, so it holds even for a valid key until the window passes.
    await api.get('/api/v1/auth/status').set(auth).expect(429);
    await api.get('/health/live').expect(200);
  });

  it('returns 404 for unknown routes, 400 for malformed JSON', async () => {
    const { api } = await boot();
    expect((await api.get('/api/v1/nope').set(auth).expect(404)).body.error.code).toBe('ROUTE_NOT_FOUND');
    const bad = await api.post('/api/v1/messages/send').set(auth).set('Content-Type', 'application/json').send('{"chatId":').expect(400);
    expect(bad.body.error.code).toBe('INVALID_JSON');
  });

  it('runs the QR flow: POST returns the QR, status reports READY after approval', async () => {
    const { api, gateway, runtime } = await boot();
    gateway.qrScript = ['pending', 'pending', 'authenticated'];
    const started = await api.post('/api/v1/auth/session').set(auth).send({}).expect(200);
    expect(started.body.data.status).toBe('completed');
    expect(started.body.data.result).toMatchObject({ state: 'QR_READY', qr: { data: 'https://oneauth.example/qr/1' } });
    await waitUntil(() => runtime.worker!.connection.isReady());
    const status = await api.get('/api/v1/auth/status').set(auth).expect(200);
    expect(status.body.data).toMatchObject({ state: 'READY', qr: null, workerOnline: true });
  });

  it('logs out and wipes the stored session', async () => {
    const { api } = await bootReady();
    const res = await api.delete('/api/v1/auth/session').set(auth).expect(200);
    expect(res.body.data.result).toMatchObject({ state: 'DISCONNECTED', reason: 'LOGGED_OUT' });
  });

  it('restores the session on restart without a new QR scan', async () => {
    const { runtime } = await bootReady();
    const env = { DATA_DIR: runtime.config.dataDir };
    await runtime.stop();
    const second = await boot(env);
    await waitUntil(() => second.runtime.worker!.connection.isReady());
    expect(second.gateway.qrIssued).toBe(0);
  });
});

describe('messaging', () => {
  it('refuses to send while the session is not READY', async () => {
    const { api } = await boot();
    const res = await api.post('/api/v1/messages/send').set(auth).send({ chatId: 'CT_1', text: 'hi' }).expect(409);
    expect(res.body.error).toMatchObject({ code: 'SESSION_NOT_READY', details: { state: 'DISCONNECTED' } });
  });

  it('validates the body and reports every issue', async () => {
    const { api } = await bootReady();
    const res = await api.post('/api/v1/messages/send').set(auth).send({ chatId: 'bad id', text: '   ' }).expect(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect(res.body.error.details.map((d: { path: string }) => d.path).sort()).toEqual(['chatId', 'text']);
  });

  it('sends text synchronously, or asynchronously with a pollable job', async () => {
    const { api, gateway } = await bootReady();
    const sync = await api.post('/api/v1/messages/send').set(auth).send({ chatId: 'CT_1', text: 'hello', displayName: 'Bot' }).expect(200);
    expect(sync.body.data).toMatchObject({ status: 'completed', jobId: expect.stringMatching(/^out_/), result: { chatId: 'CT_1' } });
    expect(gateway.sent).toEqual([{ chatId: 'CT_1', text: 'hello', displayName: 'Bot' }]);

    const queued = await api.post('/api/v1/messages/send?async=true').set(auth).send({ chatId: 'CT_2', text: 'later' }).expect(202);
    expect(queued.body.data).toMatchObject({ status: 'queued', statusUrl: `/api/v1/jobs/${queued.body.data.jobId}` });
    await waitUntil(async () => (await api.get(queued.body.data.statusUrl).set(auth)).body.data.state === 'completed');
  });

  it('dedupes retried requests that carry the same Idempotency-Key', async () => {
    const { api, gateway } = await bootReady();
    const first = await api.post('/api/v1/messages/send').set(auth).set('Idempotency-Key', 'order-42').send({ chatId: 'CT_1', text: 'once' }).expect(200);
    const second = await api.post('/api/v1/messages/send').set(auth).set('Idempotency-Key', 'order-42').send({ chatId: 'CT_1', text: 'once' }).expect(200);
    expect(second.body.data).toMatchObject({ jobId: first.body.data.jobId, deduplicated: true });
    expect(gateway.sent).toHaveLength(1);
  });

  it('does not retry a send whose outcome is ambiguous, and surfaces the error', async () => {
    const { api, gateway } = await bootReady();
    let calls = 0;
    gateway.sendImpl = async () => {
      calls += 1;
      throw classifyUpstreamError({ code: 'ECONNABORTED', message: 'timeout' }, 'sendText', false);
    };
    const res = await api.post('/api/v1/messages/send').set(auth).send({ chatId: 'CT_1', text: 'x' }).expect(504);
    expect(res.body.error.code).toBe('UPSTREAM_TIMEOUT_AMBIGUOUS');
    expect(calls).toBe(1);
  });

  it('answers 501 for operations the fork cannot perform yet', async () => {
    const { api } = await bootReady();
    const r = await api.post('/api/v1/messages/send').set(auth).send({ type: 'reaction', chatId: 'CT_1', messageId: 'm1', emoji: '👍' }).expect(501);
    expect(r.body.error).toMatchObject({ code: 'CAPABILITY_UNAVAILABLE', details: { capability: 'messages.reaction' } });
    await api.post('/api/v1/groups/create').set(auth).send({ name: 'G', participants: ['u1'] }).expect(501);
    await api.put('/api/v1/groups/CT_9/members').set(auth).send({ action: 'promote', userIds: ['u1'] }).expect(501);
    const transfer = await api.put('/api/v1/groups/CT_9/members').set(auth).send({ action: 'transfer_ownership', userIds: ['u1', 'u2'] }).expect(400);
    expect(transfer.body.error.details[0].message).toMatch(/exactly one/);
    const caps = await api.get('/api/v1/capabilities').set(auth).expect(200);
    expect(caps.body.data).toMatchObject({ 'messages.text': true, 'groups.create': false });
  });
});

describe('media', () => {
  it('streams an upload through the spool, maps the content type and cleans up', async () => {
    const { api, gateway, runtime } = await bootReady();
    const res = await api
      .post('/api/v1/messages/media')
      .set(auth)
      .field('chatId', 'CT_1')
      .field('caption', 'look')
      .attach('file', Buffer.from('PNGDATA'), 'photo ünïcode.png')
      .expect(200);
    expect(res.body.data.status).toBe('completed');
    expect(gateway.media[0]).toMatchObject({ chatId: 'CT_1', fileName: 'photo ünïcode.png', mimeType: 'image/png', size: 7, bytes: 7, caption: 'look' });
    await waitUntil(() => fs.readdirSync(runtime.spool.dir).length === 0);
  });

  it('rejects oversize uploads with 413 and leaves nothing behind', async () => {
    const { api, runtime } = await bootReady({ MEDIA_MAX_BYTES: '10' });
    const res = await api.post('/api/v1/messages/media').set(auth).field('chatId', 'CT_1').attach('file', Buffer.alloc(11), 'big.bin').expect(413);
    expect(res.body.error.code).toBe('PAYLOAD_TOO_LARGE');
    expect(fs.readdirSync(runtime.spool.dir)).toEqual([]);
  });

  it('removes the spooled file when validation fails after upload', async () => {
    const { api, runtime } = await bootReady();
    await api.post('/api/v1/messages/media').set(auth).field('chatId', 'bad id').attach('file', Buffer.from('x'), 'a.txt').expect(400);
    await api.post('/api/v1/messages/media').set(auth).field('chatId', 'CT_1').expect(400);
    expect(fs.readdirSync(runtime.spool.dir)).toEqual([]);
  });

  it('downloads media as a stream with a safe Content-Disposition', async () => {
    const { api, runtime } = await bootReady();
    const res = await api.get('/api/v1/media/f123?chatId=CT_1').set(auth).expect(200);
    expect(res.headers['content-disposition']).toBe("attachment; filename*=UTF-8''f123.txt");
    expect(res.text).toBe('content-of-f123');
    expect(res.headers['content-type']).toMatch(/^text\/plain/);
    await waitUntil(() => fs.readdirSync(runtime.spool.dir).length === 0);
  });
});

describe('reads', () => {
  it('lists chats and messages through the worker', async () => {
    const { api, gateway } = await bootReady();
    gateway.chats = [chat('CT_1', 'm1', 'Team')];
    const chats = await api.get('/api/v1/chats?limit=5').set(auth).expect(200);
    expect(chats.body.data.result).toEqual([expect.objectContaining({ chatId: 'CT_1', title: 'Team' })]);
    await api.get('/api/v1/chats?limit=0').set(auth).expect(400);
  });
});

describe('broadcast', () => {
  it('sends in chunks, reports progress and per-recipient results', async () => {
    const { api, gateway } = await bootReady();
    gateway.sendImpl = async (chatId, text) => {
      if (chatId === 'CT_bad') {
        throw new AppError({ status: 502, code: 'UPSTREAM_REJECTED', message: 'nope' });
      }
      gateway.sent.push({ chatId, text });
      return { ok: true };
    };
    const res = await api
      .post('/api/v1/channels/broadcast')
      .set(auth)
      .send({ recipients: ['CT_1', 'CT_2', 'CT_bad', 'CT_1', 'CT_3'], text: 'promo', chunkSize: 2, chunkDelayMs: 10 })
      .expect(202);
    expect(res.body.data).toMatchObject({ total: 4, chunks: 2, broadcastId: expect.stringMatching(/^bc_/) });

    let job: { state: string; result: { sent: number; failed: number; results: Array<{ chatId: string; status: string }> } } | undefined;
    await waitUntil(async () => {
      job = (await api.get(res.body.data.statusUrl).set(auth)).body.data;
      return job?.state === 'completed';
    });
    expect(job!.result).toMatchObject({ total: 4, sent: 3, failed: 1, chunksDone: 2 });
    expect(job!.result.results.find((r) => r.chatId === 'CT_bad')).toMatchObject({ status: 'failed' });
    expect(gateway.sent.map((s) => s.chatId).sort()).toEqual(['CT_1', 'CT_2', 'CT_3']);
  });

  it('enforces the recipient limit and the minimum chunk delay', async () => {
    const { api } = await bootReady({ BROADCAST_MAX_RECIPIENTS: '2', BROADCAST_MIN_CHUNK_DELAY_MS: '1000' });
    await api.post('/api/v1/channels/broadcast').set(auth).send({ recipients: ['a', 'b', 'c'], text: 'x', chunkDelayMs: 1000 }).expect(400);
    await api.post('/api/v1/channels/broadcast').set(auth).send({ recipients: ['a'], text: 'x', chunkDelayMs: 10 }).expect(400);
  });
});

describe('webhooks API', () => {
  it('subscribes, delivers events end-to-end, tests, lists and unsubscribes', async () => {
    const got: Array<{ headers: http.IncomingHttpHeaders; body: string }> = [];
    const receiver = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        got.push({ headers: req.headers, body });
        res.end();
      });
    });
    await new Promise<void>((r) => receiver.listen(0, '127.0.0.1', r));
    try {
      const { api } = await bootReady();
      const url = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/hook`;
      const sub = await api.post('/api/v1/webhooks/subscribe').set(auth).send({ url, events: ['message.sent'] }).expect(201);
      expect(sub.body.data).toMatchObject({ id: expect.stringMatching(/^wh_/), active: true, secret: expect.stringMatching(/^whsec_/) });
      expect(sub.body.data.secretEnc).toBeUndefined();

      await api.post('/api/v1/messages/send').set(auth).send({ chatId: 'CT_1', text: 'hi' }).expect(200);
      await waitUntil(() => got.length === 1);
      expect(JSON.parse(got[0]!.body)).toMatchObject({ type: 'message.sent', data: { chatId: 'CT_1' } });
      expect(verifySignature(sub.body.data.secret, got[0]!.headers['x-arattai-signature'] as string, got[0]!.body)).toBe(true);

      const test = await api.post(`/api/v1/webhooks/${sub.body.data.id}/test`).set(auth).expect(200);
      expect(test.body.data).toMatchObject({ delivered: true, result: { status: 200 } });

      const list = await api.get('/api/v1/webhooks').set(auth).expect(200);
      expect(list.body.data).toHaveLength(1);
      expect(list.body.data[0].secret).toBeUndefined();
      await api.delete(`/api/v1/webhooks/${sub.body.data.id}`).set(auth).expect(200);
      await api.delete(`/api/v1/webhooks/${sub.body.data.id}`).set(auth).expect(404);
    } finally {
      await new Promise<void>((r) => receiver.close(() => r()));
    }
  });

  it('rejects private and non-https URLs under the production policy', async () => {
    const { api } = await boot({ WEBHOOK_ALLOW_HTTP: 'false', WEBHOOK_ALLOW_PRIVATE: 'false' });
    expect((await api.post('/api/v1/webhooks/subscribe').set(auth).send({ url: 'http://example.com/h' }).expect(400)).body.error.code).toBe(
      'WEBHOOK_URL_REJECTED',
    );
    await api.post('/api/v1/webhooks/subscribe').set(auth).send({ url: 'https://10.0.0.5/h' }).expect(400);
    await api.post('/api/v1/webhooks/subscribe').set(auth).send({ url: 'https://localhost/h' }).expect(400);
  });
});

describe('ops endpoints', () => {
  it('serves liveness, readiness and Prometheus metrics', async () => {
    const { api } = await boot();
    await api.get('/health/live').expect(200, { status: 'ok' });
    const ready = await api.get('/health/ready').expect(200);
    expect(ready.body).toMatchObject({ status: 'ok', checks: { store: 'ok', queue: 'ok' }, session: { state: 'DISCONNECTED' } });
    await api.get('/health/ready?requireSession=true').expect(503);
    const metrics = await api.get('/metrics').expect(200);
    expect(metrics.text).toContain('arattai_session_state{state="DISCONNECTED"} 1');
    expect(metrics.text).toContain('http_requests_total');
  });
});
