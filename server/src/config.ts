import path from 'node:path';
import { z } from 'zod';

/** Env vars are strings; accept the usual spellings of true/false. */
const bool = (fallback: boolean) =>
  z
    .enum(['true', 'false', '1', '0', 'yes', 'no'])
    .optional()
    .transform((v) => (v === undefined ? fallback : ['true', '1', 'yes'].includes(v)));

const int = (fallback: number, min = 0, max = Number.MAX_SAFE_INTEGER) =>
  z.coerce.number().int().min(min).max(max).default(fallback);

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    /** all = API + session worker in one process; api / worker = split deployment over Redis. */
    ROLE: z.enum(['all', 'api', 'worker']).default('all'),
    HOST: z.string().default('0.0.0.0'),
    PORT: int(3000, 0, 65535),
    /** Health/metrics listener used when ROLE=worker. */
    WORKER_PORT: int(3001, 0, 65535),
    TRUST_PROXY: z.string().default('false'),

    API_KEYS: z
      .string()
      .min(1, 'API_KEYS is required')
      .transform((s) => s.split(',').map((k) => k.trim()).filter(Boolean))
      .refine((keys) => keys.length > 0 && keys.every((k) => k.length >= 24), {
        message: 'API_KEYS must be a comma-separated list of keys, each at least 24 characters',
      }),
    METRICS_TOKEN: z.string().min(16).optional(),

    /** 32-byte key, hex (64 chars) or base64. Encrypts session cookies and webhook secrets at rest. */
    MASTER_KEY: z.string().min(1, 'MASTER_KEY is required'),
    /** Previous MASTER_KEY, accepted for decryption only during a key rotation. */
    MASTER_KEY_PREVIOUS: z.string().optional(),

    SESSION_ID: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,64}$/, 'SESSION_ID may only contain letters, digits, _ and -')
      .default('default'),

    STORE_DRIVER: z.enum(['file', 'redis']).default('file'),
    QUEUE_DRIVER: z.enum(['memory', 'bullmq']).default('memory'),
    DATA_DIR: z.string().default('./data'),
    REDIS_URL: z.string().optional(),
    REDIS_PREFIX: z.string().default('arattix'),
    LEASE_TTL_MS: int(30_000, 5_000),

    LOG_LEVEL: z.enum(['error', 'warn', 'info', 'http', 'verbose', 'debug', 'silly']).default('info'),
    LOG_FORMAT: z.enum(['json', 'pretty']).optional(),

    HEARTBEAT_INTERVAL_MS: int(60_000, 1_000),
    HEARTBEAT_TIMEOUT_MS: int(15_000, 1_000),
    HEARTBEAT_FAILURE_THRESHOLD: int(3, 1),
    RECONNECT_BASE_MS: int(2_000, 10),
    RECONNECT_MAX_MS: int(300_000, 100),
    CIRCUIT_FAILURE_THRESHOLD: int(5, 1),
    CIRCUIT_COOLDOWN_MS: int(30_000, 100),
    QR_TIMEOUT_MS: int(180_000, 1_000),
    QR_POLL_INTERVAL_MS: int(5_000, 10),

    SEND_RATE_PER_MINUTE: int(20, 1),
    SEND_BURST: int(5, 1),
    SEND_PER_CHAT_INTERVAL_MS: int(1_500, 0),
    SEND_JITTER_MS: int(750, 0),
    MESSAGE_TTL_MS: int(600_000, 1_000),
    JOB_ATTEMPTS: int(3, 1, 20),
    JOB_BACKOFF_MS: int(2_000, 10),
    QUEUE_MAX_PENDING: int(5_000, 1),
    SYNC_WAIT_TIMEOUT_MS: int(25_000, 100),

    MEDIA_MAX_BYTES: int(64 * 1024 * 1024, 1),
    SPOOL_MAX_AGE_MS: int(24 * 60 * 60 * 1000, 60_000),

    BROADCAST_MAX_RECIPIENTS: int(1_000, 1),
    BROADCAST_MIN_CHUNK_DELAY_MS: int(5_000, 0),

    POLL_ENABLED: bool(true),
    POLL_INTERVAL_MS: int(5_000, 100),
    POLL_MAX_INTERVAL_MS: int(60_000, 100),
    POLL_CHAT_LIMIT: int(30, 1, 200),
    POLL_CHATS_PER_TICK: int(5, 1, 50),
    POLL_CHATLIST_EVERY: int(3, 1),
    POLL_MESSAGE_LIMIT: int(20, 1, 100),
    SELF_USER_ID: z.string().optional(),
    POLL_EMIT_SELF: bool(false),

    WEBHOOK_TIMEOUT_MS: int(10_000, 100),
    WEBHOOK_MAX_ATTEMPTS: int(8, 1, 25),
    WEBHOOK_BACKOFF_MS: int(5_000, 10),
    WEBHOOK_ALLOW_HTTP: bool(false),
    WEBHOOK_ALLOW_PRIVATE: bool(false),
    WEBHOOK_MAX_CONSECUTIVE_FAILURES: int(50, 1),

    HTTP_RATE_LIMIT_PER_MINUTE: int(300, 1),
    /** Serve the admin web UI at /ui (its API calls still need an API key). */
    UI_ENABLED: bool(true),
    /** Log records and events kept for the admin UI (shared through Redis when STORE_DRIVER=redis). */
    LOG_BUFFER_SIZE: int(2_000, 0, 100_000),
    EVENT_BUFFER_SIZE: int(500, 0, 100_000),
    SHUTDOWN_TIMEOUT_MS: int(25_000, 1_000),

    /** JSON object overriding arattix Defaults keys, for hot-fixing a moved endpoint without a release. */
    ARATTAI_ENDPOINT_OVERRIDES: z.string().optional(),
    ARATTAI_USER_AGENT: z.string().optional(),
  })
  .superRefine((env, ctx) => {
    if (env.ROLE !== 'all' && (env.QUEUE_DRIVER !== 'bullmq' || env.STORE_DRIVER !== 'redis')) {
      ctx.addIssue({
        code: 'custom',
        path: ['ROLE'],
        message: 'ROLE=api/worker requires QUEUE_DRIVER=bullmq and STORE_DRIVER=redis (processes coordinate through Redis)',
      });
    }
    if ((env.QUEUE_DRIVER === 'bullmq' || env.STORE_DRIVER === 'redis') && !env.REDIS_URL) {
      ctx.addIssue({ code: 'custom', path: ['REDIS_URL'], message: 'REDIS_URL is required for redis/bullmq drivers' });
    }
    if (env.RECONNECT_MAX_MS < env.RECONNECT_BASE_MS) {
      ctx.addIssue({ code: 'custom', path: ['RECONNECT_MAX_MS'], message: 'must be >= RECONNECT_BASE_MS' });
    }
    if (env.POLL_MAX_INTERVAL_MS < env.POLL_INTERVAL_MS) {
      ctx.addIssue({ code: 'custom', path: ['POLL_MAX_INTERVAL_MS'], message: 'must be >= POLL_INTERVAL_MS' });
    }
  });

export type Env = z.infer<typeof schema>;
export type ConfigKey = keyof Env;
export const CONFIG_KEYS = Object.keys(schema.shape) as ConfigKey[];

export interface Config extends Env {
  dataDir: string;
  spoolDir: string;
  trustProxy: boolean | number | string;
  logFormat: 'json' | 'pretty';
  /** Raw environment values for the config keys (before overrides), kept to re-validate settings edits. */
  sourceEnv: Partial<Record<ConfigKey, string>>;
  /** Settings saved from the admin UI that were applied on top of the environment at startup. */
  appliedOverrides: Partial<Record<ConfigKey, string>>;
}

export class ConfigError extends Error {
  constructor(readonly issues: Array<{ path: string; message: string }>) {
    super(`Invalid configuration:\n${issues.map((i) => `  - ${i.path}: ${i.message}`).join('\n')}`);
    this.name = 'ConfigError';
  }
}

/** Parse the environment, with stored admin overrides (if any) taking precedence over it. */
export function loadConfig(source: NodeJS.ProcessEnv = process.env, overrides: Partial<Record<ConfigKey, string>> = {}): Config {
  const sourceEnv: Partial<Record<ConfigKey, string>> = {};
  for (const key of CONFIG_KEYS) {
    const v = source[key];
    if (v !== undefined) sourceEnv[key] = v;
  }
  const parsed = schema.safeParse({ ...sourceEnv, ...overrides });
  if (!parsed.success) {
    throw new ConfigError(parsed.error.issues.map((i) => ({ path: i.path.join('.') || '(root)', message: i.message })));
  }
  const env = parsed.data;
  const dataDir = path.resolve(env.DATA_DIR);
  return {
    ...env,
    dataDir,
    spoolDir: path.join(dataDir, 'spool'),
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
    logFormat: env.LOG_FORMAT ?? (env.NODE_ENV === 'production' ? 'json' : 'pretty'),
    sourceEnv,
    appliedOverrides: { ...overrides },
  };
}

function parseTrustProxy(value: string): boolean | number | string {
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^\d+$/.test(value)) return Number(value);
  return value; // e.g. "loopback, 10.0.0.0/8"
}
