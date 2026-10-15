import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CircuitBreaker } from '../src/circuit-breaker';
import { Cipher } from '../src/crypto';
import { AppError, AuthExpiredError } from '../src/errors';
import { EventBus, type ArattaiEvent } from '../src/events/bus';
import { InboundPoller } from '../src/events/poller';
import { FileKeyValueStore, MemoryKeyValueStore, type KeyValueStore } from '../src/kv';
import { createSilentLogger } from '../src/logger';
import { Metrics } from '../src/metrics';
import { ConnectionManager, type ConnectionTimings } from '../src/session/connection-manager';
import { SessionStore } from '../src/session/session-store';
import type { ConnectionState } from '../src/session/status';
import { chat, FakeGateway, message } from './helpers/fake-gateway';
import { tempDir, waitUntil } from './helpers/env';

const logger = createSilentLogger();
const cipher = new Cipher(crypto.randomBytes(32).toString('hex'));
const timings: ConnectionTimings = {
  heartbeatIntervalMs: 20,
  heartbeatTimeoutMs: 200,
  heartbeatFailureThreshold: 2,
  reconnectBaseMs: 5,
  reconnectMaxMs: 20,
  qrTimeoutMs: 400,
  qrPollIntervalMs: 5,
  qrStartWaitMs: 1000,
};

function setup(opts: { kv?: KeyValueStore; timings?: Partial<ConnectionTimings> } = {}) {
  const gateway = new FakeGateway();
  const kv = opts.kv ?? new MemoryKeyValueStore();
  const bus = new EventBus('s1', logger);
  const events: ArattaiEvent[] = [];
  bus.subscribe((e) => {
    events.push(e);
  });
  const sessionStore = new SessionStore(kv, cipher, 's1', logger);
  const connection = new ConnectionManager({
    sessionId: 's1',
    gateway,
    sessionStore,
    kv,
    bus,
    breaker: new CircuitBreaker({ failureThreshold: 5, cooldownMs: 1000 }),
    logger,
    metrics: new Metrics(),
    timings: { ...timings, ...opts.timings },
  });
  const states: ConnectionState[] = [];
  connection.onStateChange((s, prev) => {
    if (s.state !== prev) states.push(s.state);
  });
  managers.push(connection);
  return { gateway, kv, bus, events, sessionStore, connection, states };
}

const managers: ConnectionManager[] = [];
afterEach(async () => {
  await Promise.all(managers.splice(0).map((m) => m.stop()));
});

const snapshot = { cookies: { fake: 1 }, userAgent: 'ua', authenticatedAt: '2026-01-01T00:00:00.000Z', savedAt: 'x' };

describe('SessionStore + FileKeyValueStore', () => {
  it('persists encrypted session state atomically with 0600 permissions', async () => {
    const dir = tempDir();
    const kv = new FileKeyValueStore(dir);
    const store = new SessionStore(kv, cipher, 'acct', logger);
    await store.save(snapshot);
    const [file] = fs.readdirSync(dir);
    const raw = fs.readFileSync(path.join(dir, file!), 'utf8');
    expect(raw).not.toContain('"fake"'); // encrypted at rest
    expect(fs.statSync(path.join(dir, file!)).mode & 0o777).toBe(0o600);
    expect(await store.load()).toEqual(snapshot);
    expect(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('returns null (and keeps the blob) when the key changed', async () => {
    const kv = new MemoryKeyValueStore();
    await new SessionStore(kv, cipher, 'acct', logger).save(snapshot);
    const other = new SessionStore(kv, new Cipher(crypto.randomBytes(32).toString('hex')), 'acct', logger);
    expect(await other.load()).toBeNull();
    expect(await kv.get('session:acct')).not.toBeNull();
  });

  it('expires TTL entries and lists keys by prefix', async () => {
    const kv = new FileKeyValueStore(tempDir());
    await kv.set('a:1', { v: 1 }, 20);
    await kv.set('a:2', { v: 2 });
    await kv.set('b:1', { v: 3 });
    expect((await kv.keys('a:')).sort()).toEqual(['a:1', 'a:2']);
    await new Promise((r) => setTimeout(r, 30));
    expect(await kv.get('a:1')).toBeNull();
  });
});

describe('ConnectionManager', () => {
  it('stays DISCONNECTED(NO_SESSION) when nothing is stored', async () => {
    const { connection } = setup();
    connection.start();
    await waitUntil(() => connection.getStatus().reason === 'NO_SESSION');
    expect(connection.getStatus().state).toBe('DISCONNECTED');
  });

  it('restores a stored session through AUTHENTICATED → SYNCING → READY', async () => {
    const { connection, sessionStore, states, gateway } = setup();
    await sessionStore.save(snapshot);
    connection.start();
    await waitUntil(() => connection.isReady());
    expect(states).toEqual(['CONNECTING', 'AUTHENTICATED', 'SYNCING', 'READY']);
    expect(gateway.restoredFrom?.cookies).toEqual({ fake: 1 });
  });

  it('retries transient restore failures with backoff, then becomes READY', async () => {
    const { connection, sessionStore, gateway } = setup();
    await sessionStore.save(snapshot);
    let failures = 2;
    gateway.validateImpl = async () => {
      if (failures-- > 0) throw new AppError({ status: 503, code: 'UPSTREAM_UNREACHABLE', message: 'down', retryable: true });
    };
    connection.start();
    await waitUntil(() => connection.isReady());
    expect(gateway.validateCalls).toBeGreaterThanOrEqual(3);
  });

  it('marks an expired stored session as DISCONNECTED(SESSION_EXPIRED)', async () => {
    const { connection, sessionStore, gateway, events } = setup();
    await sessionStore.save(snapshot);
    gateway.validateImpl = async () => {
      throw new AuthExpiredError();
    };
    connection.start();
    await waitUntil(() => connection.getStatus().reason === 'SESSION_EXPIRED');
    expect(events.some((e) => e.type === 'session.state_changed' && (e.data as { to: string }).to === 'DISCONNECTED')).toBe(true);
  });

  it('runs a QR login: QR_READY, refresh, approval, persisted session, READY', async () => {
    const { connection, gateway, sessionStore, events } = setup();
    gateway.qrScript = ['pending', 'refreshed', 'pending', 'authenticated'];
    const status = await connection.startQrLogin();
    expect(status.state).toBe('QR_READY');
    expect(status.qr?.data).toBe('https://oneauth.example/qr/1');
    expect(status.qr?.dataUrl).toMatch(/^data:image\/png;base64,/);
    await waitUntil(() => connection.isReady());
    expect(events.filter((e) => e.type === 'session.qr')).toHaveLength(2);
    expect(await sessionStore.load()).toMatchObject({ cookies: { fake: 1 } });
  });

  it('gives concurrent callers the same QR', async () => {
    const { connection, gateway } = setup();
    const [a, b] = await Promise.all([connection.startQrLogin(), connection.startQrLogin()]);
    expect(a.state).toBe('QR_READY');
    expect(b.qr?.data).toBe(a.qr?.data);
    expect(gateway.qrIssued).toBe(1);
  });

  it('is idempotent while a QR login is in flight and restartable with force', async () => {
    const { connection, gateway } = setup();
    const first = await connection.startQrLogin();
    const again = await connection.startQrLogin();
    expect(again.qr?.data).toBe(first.qr?.data);
    const forced = await connection.startQrLogin(true);
    expect(forced.qr?.data).not.toBe(first.qr?.data);
    expect(gateway.qrIssued).toBe(2);
  });

  it('gives up with QR_TIMEOUT when nobody scans', async () => {
    const { connection } = setup({ timings: { qrTimeoutMs: 50 } });
    await connection.startQrLogin();
    await waitUntil(() => connection.getStatus().reason === 'QR_TIMEOUT');
    expect(connection.getStatus().state).toBe('DISCONNECTED');
  });

  it('reconnects after consecutive heartbeat failures', async () => {
    const { connection, sessionStore, gateway, states } = setup();
    await sessionStore.save(snapshot);
    connection.start();
    await waitUntil(() => connection.isReady());
    let failures = 2;
    gateway.validateImpl = async () => {
      if (failures-- > 0) throw new AppError({ status: 504, code: 'UPSTREAM_TIMEOUT', message: 't', retryable: true });
    };
    await waitUntil(() => states.filter((s) => s === 'READY').length === 2);
    expect(states.slice(-4)).toEqual(['CONNECTING', 'AUTHENTICATED', 'SYNCING', 'READY']);
  });

  it('drops to DISCONNECTED(SESSION_EXPIRED) when a heartbeat sees an expired session', async () => {
    const { connection, sessionStore, gateway } = setup();
    await sessionStore.save(snapshot);
    connection.start();
    await waitUntil(() => connection.isReady());
    gateway.validateImpl = async () => {
      throw new AuthExpiredError();
    };
    await waitUntil(() => connection.getStatus().reason === 'SESSION_EXPIRED');
  });

  it('persists rotated cookies on heartbeat and wipes them on logout', async () => {
    const { connection, sessionStore, gateway } = setup();
    await sessionStore.save(snapshot);
    connection.start();
    await waitUntil(() => connection.isReady());
    gateway.cookieVersion = 2;
    await waitUntil(async () => (await sessionStore.load())?.cookies !== undefined && ((await sessionStore.load())!.cookies as { fake: number }).fake === 2);
    const out = await connection.logout();
    expect(out).toMatchObject({ state: 'DISCONNECTED', reason: 'LOGGED_OUT' });
    expect(await sessionStore.load()).toBeNull();
  });
});

describe('InboundPoller', () => {
  async function readyPoller(opts: { selfUserId?: string } = {}) {
    const ctx = setup({ timings: { heartbeatIntervalMs: 60_000 } });
    const poller = new InboundPoller({
      sessionId: 's1',
      gateway: ctx.gateway,
      connection: ctx.connection,
      kv: ctx.kv,
      bus: ctx.bus,
      logger,
      metrics: new Metrics(),
      options: {
        intervalMs: 60_000,
        maxIntervalMs: 60_000,
        chatLimit: 10,
        chatsPerTick: 2,
        chatListEvery: 1,
        messageLimit: 3,
        emitSelf: false,
        ...opts,
      },
    });
    return { ...ctx, poller };
  }
  const received = (events: ArattaiEvent[]) =>
    events.filter((e) => e.type === 'message.received').map((e) => (e.data as { message: { id: string } }).message.id);

  it('seeds history silently on bootstrap, then emits each new message exactly once', async () => {
    const { gateway, poller, events } = await readyPoller();
    gateway.chats = [chat('A', 'v1')];
    gateway.messages.A = [message('1', 'old'), message('2', 'old')];
    await poller.prime();
    expect(received(events)).toEqual([]);

    gateway.chats = [chat('A', 'v2')];
    gateway.messages.A = [message('1', 'old'), message('2', 'old'), message('3', 'new')];
    await poller.runOnce();
    await poller.runOnce();
    expect(received(events)).toEqual(['3']);
  });

  it('resumes from persisted cursors after a restart without replaying', async () => {
    const first = await readyPoller();
    first.gateway.chats = [chat('A', 'v1')];
    first.gateway.messages.A = [message('1', 'a')];
    await first.poller.prime();

    // New process, same store: a message arrived while we were down.
    const bus = new EventBus('s1', logger);
    const events: ArattaiEvent[] = [];
    bus.subscribe((e) => {
      events.push(e);
    });
    const restarted = new InboundPoller({
      sessionId: 's1',
      gateway: first.gateway,
      connection: first.connection,
      kv: first.kv,
      bus,
      logger,
      metrics: new Metrics(),
      options: { intervalMs: 1, maxIntervalMs: 1, chatLimit: 10, chatsPerTick: 2, chatListEvery: 1, messageLimit: 3, emitSelf: false },
    });
    first.gateway.chats = [chat('A', 'v2')];
    first.gateway.messages.A = [message('1', 'a'), message('2', 'while down')];
    await restarted.prime();
    await restarted.runOnce();
    expect(received(events)).toEqual(['2']);
  });

  it('filters our own messages when SELF_USER_ID is set and flags gaps', async () => {
    const { gateway, poller, events } = await readyPoller({ selfUserId: 'me' });
    gateway.chats = [chat('A', 'v1')];
    gateway.messages.A = [message('1', 'x')];
    await poller.prime();
    gateway.chats = [chat('A', 'v2')];
    gateway.messages.A = [
      message('2', 'mine', { sender: { id: 'me', name: 'Me' } }),
      message('3', 'theirs'),
      message('4', 'theirs'),
      message('5', 'theirs'),
    ];
    await poller.runOnce();
    const got = events.filter((e) => e.type === 'message.received');
    expect(got.map((e) => (e.data as { message: { id: string } }).message.id)).toEqual(['3', '4', '5']);
    expect((got[0]!.data as { gapDetected: boolean }).gapDetected).toBe(true);
  });

  it('keeps a single polling loop when the session drops and returns mid-tick', async () => {
    vi.useFakeTimers();
    try {
      const { gateway, poller } = await readyPoller();
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      gateway.listChatsImpl = async () => {
        await gate;
        return [chat('A', 'v1')];
      };
      poller.start();
      await vi.advanceTimersByTimeAsync(60_000); // first tick starts and blocks on the chat list
      poller.stop(); // session left READY ...
      poller.start(); // ... and came back before the tick finished
      expect(vi.getTimerCount()).toBe(1);
      release();
      await vi.advanceTimersByTimeAsync(0); // the stale tick finishes
      expect(vi.getTimerCount()).toBe(1); // it must not schedule a second loop
      poller.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports auth failures to the connection manager instead of swallowing them', async () => {
    const { gateway, poller, connection, sessionStore } = await readyPoller();
    await sessionStore.save(snapshot);
    connection.start();
    await waitUntil(() => connection.isReady());
    gateway.listChatsImpl = async () => {
      throw new AuthExpiredError();
    };
    gateway.validateImpl = async () => {
      throw new AuthExpiredError();
    };
    await poller.runOnce();
    await waitUntil(() => connection.getStatus().reason === 'SESSION_EXPIRED');
  });
});
