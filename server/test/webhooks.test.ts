import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Cipher } from '../src/crypto';
import { EventBus } from '../src/events/bus';
import { MemoryKeyValueStore } from '../src/kv';
import { createSilentLogger } from '../src/logger';
import { Metrics } from '../src/metrics';
import { MemoryJobQueue } from '../src/queue/memory-queue';
import { subscriptionMatches, WebhookDispatcher, type WebhookConfig } from '../src/webhooks/dispatcher';
import { verifySignature } from '../src/webhooks/signature';
import { WebhookStore } from '../src/webhooks/store';
import { waitUntil } from './helpers/env';

const logger = createSilentLogger();

interface Received {
  headers: http.IncomingHttpHeaders;
  body: string;
}

let server: http.Server;
let base: string;
const received: Received[] = [];
/** Status codes the receiver answers with, consumed per request; 200 once empty. */
let script: number[] = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received.push({ headers: req.headers, body });
      res.statusCode = script.shift() ?? 200;
      res.end('ok');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

function setup(overrides: Partial<WebhookConfig> = {}) {
  received.length = 0;
  script = [];
  const store = new WebhookStore(new MemoryKeyValueStore(), new Cipher(crypto.randomBytes(32).toString('hex')));
  const queue = new MemoryJobQueue('webhooks', { maxPending: 100 }, logger);
  const bus = new EventBus('s1', logger);
  const dispatcher = new WebhookDispatcher({
    store,
    queue,
    bus,
    logger,
    metrics: new Metrics(),
    config: { timeoutMs: 2000, maxAttempts: 4, backoffMs: 5, allowHttp: true, allowPrivate: true, maxConsecutiveFailures: 50, ...overrides },
  });
  dispatcher.attach();
  queue.process((job) => dispatcher.deliver(job as never), 4);
  return { store, queue, bus, dispatcher };
}

describe('webhook dispatcher', () => {
  it('delivers matching events with a verifiable signature and delivery headers', async () => {
    const { store, bus } = setup();
    const { secret } = await store.create({ url: `${base}/hook`, events: ['message.received'] });
    await store.create({ url: `${base}/other`, events: ['broadcast.completed'] });

    const event = bus.publish('message.received', { chatId: 'CT_1', message: { id: 'm1' } });
    await waitUntil(() => received.length === 1);
    await new Promise((r) => setTimeout(r, 30));
    expect(received).toHaveLength(1); // the non-matching subscription got nothing

    const [r] = received;
    expect(JSON.parse(r!.body)).toMatchObject({ id: event.id, type: 'message.received', data: { chatId: 'CT_1' } });
    expect(r!.headers['x-arattai-event']).toBe('message.received');
    expect(r!.headers['x-arattai-delivery']).toBe(event.id);
    expect(verifySignature(secret, r!.headers['x-arattai-signature'] as string, r!.body)).toBe(true);
  });

  it('retries 5xx with backoff and records success', async () => {
    const { store, bus } = setup();
    const { subscription } = await store.create({ url: `${base}/hook`, events: ['*'] });
    script = [500, 503];
    bus.publish('message.sent', { chatId: 'CT_1' });
    await waitUntil(() => received.length === 3);
    expect(received.map((r) => r.headers['x-arattai-attempt'])).toEqual(['1', '2', '3']);
    await waitUntil(async () => (await store.get(subscription.id))?.lastStatus === 200);
    expect((await store.get(subscription.id))?.consecutiveFailures).toBe(0);
  });

  it('does not retry other 4xx and disables the subscription on 410 Gone', async () => {
    const { store, bus } = setup();
    const { subscription } = await store.create({ url: `${base}/hook`, events: ['*'] });
    script = [400];
    bus.publish('message.sent', {});
    await waitUntil(() => received.length === 1);
    await new Promise((r) => setTimeout(r, 50));
    expect(received).toHaveLength(1);

    script = [410];
    bus.publish('message.sent', {});
    await waitUntil(async () => (await store.get(subscription.id))?.active === false);
    expect((await store.get(subscription.id))?.disabledReason).toMatch(/410/);
  });

  it('auto-disables after too many consecutive failures', async () => {
    const { store, bus } = setup({ maxAttempts: 1, maxConsecutiveFailures: 2 });
    const { subscription } = await store.create({ url: `${base}/hook`, events: ['*'] });
    script = [500, 500, 500];
    bus.publish('message.sent', {});
    bus.publish('message.sent', {});
    await waitUntil(async () => (await store.get(subscription.id))?.active === false);
    bus.publish('message.sent', {});
    await new Promise((r) => setTimeout(r, 60));
    expect(received).toHaveLength(2);
  });

  it('blocks private destinations at connect time when not allowed', async () => {
    const { store, queue, dispatcher } = setup({ allowPrivate: false, maxAttempts: 1 });
    // Stored directly: the API would already refuse this URL at subscribe time.
    const { subscription } = await store.create({ url: `${base}/hook`, events: ['*'] });
    const id = await dispatcher.enqueue(subscription.id, {
      id: 'evt_1',
      type: 'message.sent',
      sessionId: 's1',
      occurredAt: new Date().toISOString(),
      data: {},
    });
    await queue.waitForResult(id, 2000).catch(() => undefined);
    expect(received).toHaveLength(0);
    expect((await store.get(subscription.id))?.active).toBe(false);
  });

  it('never sends sensitive events to wildcard subscriptions', () => {
    expect(subscriptionMatches({ events: ['*'] }, 'session.qr')).toBe(false);
    expect(subscriptionMatches({ events: ['*', 'session.qr'] }, 'session.qr')).toBe(true);
    expect(subscriptionMatches({ events: ['*'] }, 'message.received')).toBe(true);
  });
});
