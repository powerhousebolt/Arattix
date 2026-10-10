import http from 'node:http';
import path from 'node:path';
import type { Express } from 'express';
import { Redis } from 'ioredis';
import { applyEndpointOverrides, ARATTIX_CAPABILITIES, ArattixGateway } from './arattai/arattix-gateway';
import type { ArattaiGateway } from './arattai/gateway';
import { CircuitBreaker } from './circuit-breaker';
import type { Config } from './config';
import { Cipher } from './crypto';
import { EventBus } from './events/bus';
import { InboundPoller } from './events/poller';
import { createApp } from './http/app';
import { CommandBus } from './jobs/commands';
import { QUEUE_KINDS, type QueueKind } from './jobs/contracts';
import { startWorkerHandlers } from './jobs/handlers';
import { FileKeyValueStore, RedisKeyValueStore, type KeyValueStore } from './kv';
import { createLogger, type Logger } from './logger';
import { MediaSpool } from './media/spool';
import { Metrics } from './metrics';
import { SendThrottle } from './outbound/throttle';
import { BullJobQueue } from './queue/bullmq-queue';
import { MemoryJobQueue } from './queue/memory-queue';
import type { JobQueue } from './queue/types';
import { ConnectionManager } from './session/connection-manager';
import { Lease } from './session/lease';
import { SessionStore } from './session/session-store';
import { StoredStatusReader, type StatusReader } from './session/status';
import { AbortedError } from './util';
import { WebhookDispatcher } from './webhooks/dispatcher';
import { WebhookStore } from './webhooks/store';

export interface RuntimeOverrides {
  gateway?: ArattaiGateway;
  logger?: Logger;
  /** Called when the process must die (lost session lease). Defaults to process.exit(1). */
  onFatal?: (reason: string) => void;
}

export interface Runtime {
  config: Config;
  logger: Logger;
  metrics: Metrics;
  kv: KeyValueStore;
  queues: Record<QueueKind, JobQueue>;
  commands: CommandBus;
  status: StatusReader;
  webhooks: WebhookStore;
  spool: MediaSpool;
  /** Present when this process runs the session (ROLE=all|worker). */
  worker: {
    connection: ConnectionManager;
    gateway: ArattaiGateway;
    bus: EventBus;
    poller: InboundPoller | null;
    dispatcher: WebhookDispatcher;
    breaker: CircuitBreaker;
  } | null;
  /** The API app (ROLE=all|api) or the health/metrics app (ROLE=worker). */
  app: Express;
  /** Listen, then (worker roles) take the session lease and start consuming jobs. */
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Whether this process currently owns the session (worker roles). */
  isActive(): boolean;
  /** Resolves once the worker owns the session; for tests and tooling. */
  whenActive(): Promise<void>;
  /** Bound HTTP address after start(), useful when PORT=0. */
  address(): { port: number } | null;
}

export function createRuntime(config: Config, overrides: RuntimeOverrides = {}): Runtime {
  const logger = overrides.logger ?? createLogger({ level: config.LOG_LEVEL, format: config.logFormat, role: config.ROLE, sessionId: config.SESSION_ID });
  const metrics = new Metrics();
  const cipher = new Cipher(config.MASTER_KEY, config.MASTER_KEY_PREVIOUS);
  const runsWorker = config.ROLE !== 'api';
  const runsApi = config.ROLE !== 'worker';
  const redisPrefix = `${config.REDIS_PREFIX}:${config.SESSION_ID}`;

  const redisConnections: Redis[] = [];
  const connectRedis = (forBlocking: boolean): Redis => {
    const client = new Redis(config.REDIS_URL!, {
      // BullMQ blocking connections must never give up on a command.
      maxRetriesPerRequest: forBlocking ? null : 20,
      enableReadyCheck: true,
      lazyConnect: false,
    });
    client.on('error', (err) => logger.error('Redis error', { component: 'redis', error: err.message }));
    redisConnections.push(client);
    return client;
  };
  const redis = config.STORE_DRIVER === 'redis' || config.QUEUE_DRIVER === 'bullmq' ? connectRedis(false) : null;

  const kv: KeyValueStore =
    config.STORE_DRIVER === 'redis' ? new RedisKeyValueStore(redis!, redisPrefix) : new FileKeyValueStore(path.join(config.dataDir, 'state'));

  const queues = Object.fromEntries(
    QUEUE_KINDS.map((kind) => {
      const name = `${config.SESSION_ID}-${kind}`;
      const queue: JobQueue =
        config.QUEUE_DRIVER === 'bullmq'
          ? new BullJobQueue(name, { prefix: config.REDIS_PREFIX, maxPending: config.QUEUE_MAX_PENDING, connect: () => connectRedis(true) }, logger)
          : new MemoryJobQueue(name, { maxPending: config.QUEUE_MAX_PENDING }, logger);
      return [kind, queue];
    }),
  ) as Record<QueueKind, JobQueue>;

  const commands = new CommandBus(queues, config.SYNC_WAIT_TIMEOUT_MS);
  const webhooks = new WebhookStore(kv, cipher);
  const spool = new MediaSpool(config.spoolDir, logger);
  const lease = config.ROLE !== 'all' && redis ? new Lease(redis, `${redisPrefix}:lease`, config.LEASE_TTL_MS, logger) : null;

  let worker: Runtime['worker'] = null;
  if (runsWorker) {
    applyEndpointOverrides(config.ARATTAI_ENDPOINT_OVERRIDES, logger);
    const bus = new EventBus(config.SESSION_ID, logger);
    const breaker = new CircuitBreaker({
      failureThreshold: config.CIRCUIT_FAILURE_THRESHOLD,
      cooldownMs: config.CIRCUIT_COOLDOWN_MS,
      onStateChange: (from, to) => {
        logger.warn(`Circuit breaker ${from} → ${to}`, { component: 'circuit' });
        metrics.set('arattai_circuit_open', 'Whether the Arattai circuit breaker is open (1) or not (0).', to === 'CLOSED' ? 0 : 1);
      },
    });
    const gateway =
      overrides.gateway ??
      new ArattixGateway({ breaker, logger, metrics, ...(config.ARATTAI_USER_AGENT ? { userAgent: config.ARATTAI_USER_AGENT } : {}) });
    const connection = new ConnectionManager({
      sessionId: config.SESSION_ID,
      gateway,
      sessionStore: new SessionStore(kv, cipher, config.SESSION_ID, logger),
      kv,
      bus,
      breaker,
      logger,
      metrics,
      timings: {
        heartbeatIntervalMs: config.HEARTBEAT_INTERVAL_MS,
        heartbeatTimeoutMs: config.HEARTBEAT_TIMEOUT_MS,
        heartbeatFailureThreshold: config.HEARTBEAT_FAILURE_THRESHOLD,
        reconnectBaseMs: config.RECONNECT_BASE_MS,
        reconnectMaxMs: config.RECONNECT_MAX_MS,
        qrTimeoutMs: config.QR_TIMEOUT_MS,
        qrPollIntervalMs: config.QR_POLL_INTERVAL_MS,
        qrStartWaitMs: Math.min(20_000, config.SYNC_WAIT_TIMEOUT_MS - 1_000),
      },
    });
    const poller =
      config.POLL_ENABLED && gateway.capabilities['events.polling']
        ? new InboundPoller({
            sessionId: config.SESSION_ID,
            gateway,
            connection,
            kv,
            bus,
            logger,
            metrics,
            options: {
              intervalMs: config.POLL_INTERVAL_MS,
              maxIntervalMs: config.POLL_MAX_INTERVAL_MS,
              chatLimit: config.POLL_CHAT_LIMIT,
              chatsPerTick: config.POLL_CHATS_PER_TICK,
              chatListEvery: config.POLL_CHATLIST_EVERY,
              messageLimit: config.POLL_MESSAGE_LIMIT,
              emitSelf: config.POLL_EMIT_SELF,
              ...(config.SELF_USER_ID ? { selfUserId: config.SELF_USER_ID } : {}),
            },
          })
        : null;
    poller?.attach();
    const dispatcher = new WebhookDispatcher({
      store: webhooks,
      queue: queues.webhooks,
      bus,
      logger,
      metrics,
      config: {
        timeoutMs: config.WEBHOOK_TIMEOUT_MS,
        maxAttempts: config.WEBHOOK_MAX_ATTEMPTS,
        backoffMs: config.WEBHOOK_BACKOFF_MS,
        allowHttp: config.WEBHOOK_ALLOW_HTTP,
        allowPrivate: config.WEBHOOK_ALLOW_PRIVATE,
        maxConsecutiveFailures: config.WEBHOOK_MAX_CONSECUTIVE_FAILURES,
      },
    });
    dispatcher.attach();
    worker = { connection, gateway, bus, poller, dispatcher, breaker };
  }

  const status: StatusReader = worker ? worker.connection : new StoredStatusReader(kv, config.SESSION_ID, lease);
  const checks: Record<string, () => Promise<void>> = {
    store: () => kv.ping(),
    queue: async () => {
      await queues.outbound.counts();
    },
    ...(runsWorker
      ? {
          lease: async () => {
            if (!active) throw new Error('standby: another worker owns the session');
          },
        }
      : {}),
  };
  const app = createApp({
    config,
    logger,
    metrics,
    status,
    checks,
    ...(runsApi ? { api: { commands, webhooks, spool, capabilities: worker?.gateway.capabilities ?? ARATTIX_CAPABILITIES } } : {}),
  });

  let server: http.Server | null = null;
  let stopSweeper: (() => void) | null = null;
  const startup = new AbortController();
  let stopping = false;
  /** True once this process owns the session and consumes jobs (always true for ROLE=all). */
  let active = false;
  let activation: Promise<void> = Promise.resolve();

  const activateWorker = (w: NonNullable<Runtime['worker']>) => {
    if (stopping) return;
    startWorkerHandlers({
      queues,
      connection: w.connection,
      gateway: w.gateway,
      throttle: new SendThrottle({
        ratePerMinute: config.SEND_RATE_PER_MINUTE,
        burst: config.SEND_BURST,
        perChatIntervalMs: config.SEND_PER_CHAT_INTERVAL_MS,
        jitterMs: config.SEND_JITTER_MS,
      }),
      spool,
      bus: w.bus,
      dispatcher: w.dispatcher,
      metrics,
      logger,
      outboundAttempts: config.JOB_ATTEMPTS,
      outboundBackoffMs: config.JOB_BACKOFF_MS,
      messageTtlMs: config.MESSAGE_TTL_MS,
    });
    w.connection.start();
    void spool.sweep(config.SPOOL_MAX_AGE_MS).catch(() => undefined);
    stopSweeper = spool.startSweeper(config.SPOOL_MAX_AGE_MS);
    active = true;
  };

  const runtime: Runtime = {
    config,
    logger,
    metrics,
    kv,
    queues,
    commands,
    status,
    webhooks,
    spool,
    worker,
    app,

    async start() {
      const port = config.ROLE === 'worker' ? config.WORKER_PORT : config.PORT;
      server = http.createServer(app);
      // Slow-client protection; uploads get the full requestTimeout.
      server.headersTimeout = 30_000;
      server.requestTimeout = 10 * 60_000;
      server.keepAliveTimeout = 65_000; // above common load balancer idle timeouts
      await new Promise<void>((resolve, reject) => {
        server!.once('error', reject);
        server!.listen(port, config.HOST, () => resolve());
      });
      logger.info(`Listening on ${config.HOST}:${runtime.address()?.port}`, { component: 'http', role: config.ROLE });

      if (!worker) return;
      if (!lease) {
        activateWorker(worker);
        return;
      }
      // Listen first so a standby worker still answers liveness probes while it waits.
      activation = lease
        .acquire(startup.signal)
        .then(() => {
          logger.info('Session lease acquired', { component: 'lease' });
          lease.startRenewal(() => (overrides.onFatal ?? defaultFatal)('session lease lost'));
          activateWorker(worker);
        })
        .catch((err) => {
          if (err instanceof AbortedError) return;
          logger.error('Lease acquisition failed', { component: 'lease', err });
          (overrides.onFatal ?? defaultFatal)('lease acquisition failed');
        });
    },

    isActive() {
      return active;
    },

    async whenActive() {
      await activation;
      if (!active) throw new Error('Worker did not become active');
    },

    async stop() {
      if (stopping) return;
      stopping = true;
      startup.abort();
      if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
      stopSweeper?.();
      worker?.poller?.stop();
      // Drain queues while the session is still READY: a job picked up after the session
      // stopped would fail permanently with SESSION_NOT_READY.
      await Promise.allSettled(Object.values(queues).map((q) => q.close()));
      await worker?.connection.stop();
      await lease?.release();
      await kv.close();
      await Promise.allSettled(redisConnections.map((c) => c.quit()));
    },

    address() {
      const addr = server?.address();
      return addr && typeof addr === 'object' ? { port: addr.port } : null;
    },
  };
  return runtime;
}

function defaultFatal(reason: string): void {
  // Crash-only: the supervisor (PM2 / Docker / Kubernetes) restarts the process into standby.
  process.stderr.write(`FATAL: ${reason}\n`);
  process.exit(1);
}
