import path from 'node:path';
import { Redis } from 'ioredis';
import { ConfigError, CONFIG_KEYS, loadConfig, type Config, type ConfigKey } from './config';
import { AppError } from './errors';
import { FileKeyValueStore, type KeyValueStore } from './kv';
import type { Logger } from './logger';

/**
 * Settings editable from the admin UI. Overrides are stored in the key-value store and applied
 * on top of the environment at the next start; `live` ones also take effect immediately in the
 * process that handles the change. Secrets, storage and topology stay environment-only: a UI
 * edit there could lock the operator out or orphan data.
 */
export type SettingGroup =
  | 'Security'
  | 'Topology'
  | 'HTTP'
  | 'Logging'
  | 'Connection'
  | 'Outbound pacing'
  | 'Jobs'
  | 'Media'
  | 'Broadcasts'
  | 'Inbound polling'
  | 'Webhooks'
  | 'Arattai';

interface SettingMeta {
  group: SettingGroup;
  description: string;
  editable?: boolean;
  live?: boolean;
  secret?: boolean;
}

export const SETTINGS: Record<ConfigKey, SettingMeta> = {
  API_KEYS: { group: 'Security', description: 'Comma-separated API keys (each ≥ 24 chars).', secret: true },
  METRICS_TOKEN: { group: 'Security', description: 'Bearer token protecting /metrics.', secret: true },
  MASTER_KEY: { group: 'Security', description: 'Encrypts session cookies and webhook secrets at rest.', secret: true },
  MASTER_KEY_PREVIOUS: { group: 'Security', description: 'Previous master key, decrypt-only during rotation.', secret: true },

  NODE_ENV: { group: 'Topology', description: 'Runtime environment.' },
  ROLE: { group: 'Topology', description: 'all = API + worker in one process; api / worker = split deployment.' },
  SESSION_ID: { group: 'Topology', description: 'Identifies the Arattai account; namespaces keys and queues.' },
  STORE_DRIVER: { group: 'Topology', description: 'Where state lives: file or redis.' },
  QUEUE_DRIVER: { group: 'Topology', description: 'Job queue: memory or bullmq.' },
  DATA_DIR: { group: 'Topology', description: 'Directory for file state and the media spool.' },
  REDIS_URL: { group: 'Topology', description: 'Redis connection URL.', secret: true },
  REDIS_PREFIX: { group: 'Topology', description: 'Prefix for Redis keys and queues.' },
  LEASE_TTL_MS: { group: 'Topology', description: 'Session lease TTL for split deployments.' },

  HOST: { group: 'HTTP', description: 'Listen address.' },
  PORT: { group: 'HTTP', description: 'API port.' },
  WORKER_PORT: { group: 'HTTP', description: 'Health/metrics port for ROLE=worker.' },
  TRUST_PROXY: { group: 'HTTP', description: 'Express trust proxy setting.' },
  HTTP_RATE_LIMIT_PER_MINUTE: { group: 'HTTP', description: 'Requests per minute per API key.', editable: true },
  SHUTDOWN_TIMEOUT_MS: { group: 'HTTP', description: 'Graceful shutdown deadline.', editable: true },
  UI_ENABLED: { group: 'HTTP', description: 'Serve the admin web UI at /ui.' },

  LOG_LEVEL: { group: 'Logging', description: 'error, warn, info, http (access logs), verbose, debug.', editable: true, live: true },
  LOG_FORMAT: { group: 'Logging', description: 'json or pretty console output.' },
  LOG_BUFFER_SIZE: { group: 'Logging', description: 'Log records kept for the admin UI.', editable: true },
  EVENT_BUFFER_SIZE: { group: 'Logging', description: 'Events kept for the admin UI.', editable: true },

  HEARTBEAT_INTERVAL_MS: { group: 'Connection', description: 'Session validation interval.', editable: true },
  HEARTBEAT_TIMEOUT_MS: { group: 'Connection', description: 'Timeout of one heartbeat.', editable: true },
  HEARTBEAT_FAILURE_THRESHOLD: { group: 'Connection', description: 'Failed heartbeats before reconnecting.', editable: true },
  RECONNECT_BASE_MS: { group: 'Connection', description: 'First reconnect delay.', editable: true },
  RECONNECT_MAX_MS: { group: 'Connection', description: 'Maximum reconnect delay.', editable: true },
  CIRCUIT_FAILURE_THRESHOLD: { group: 'Connection', description: 'Upstream failures that open the circuit.', editable: true },
  CIRCUIT_COOLDOWN_MS: { group: 'Connection', description: 'How long the circuit stays open.', editable: true },
  QR_TIMEOUT_MS: { group: 'Connection', description: 'How long a QR login attempt may take.', editable: true },
  QR_POLL_INTERVAL_MS: { group: 'Connection', description: 'QR approval polling interval.', editable: true },

  SEND_RATE_PER_MINUTE: { group: 'Outbound pacing', description: 'Sustained sends per minute.', editable: true },
  SEND_BURST: { group: 'Outbound pacing', description: 'Back-to-back sends allowed.', editable: true },
  SEND_PER_CHAT_INTERVAL_MS: { group: 'Outbound pacing', description: 'Minimum gap between sends to one chat.', editable: true },
  SEND_JITTER_MS: { group: 'Outbound pacing', description: 'Random delay added to each send.', editable: true },
  MESSAGE_TTL_MS: { group: 'Outbound pacing', description: 'Drop queued sends older than this.', editable: true },

  JOB_ATTEMPTS: { group: 'Jobs', description: 'Attempts per outbound job.', editable: true },
  JOB_BACKOFF_MS: { group: 'Jobs', description: 'Base retry backoff.', editable: true },
  QUEUE_MAX_PENDING: { group: 'Jobs', description: 'Pending jobs per queue before 503 QUEUE_FULL.', editable: true },
  SYNC_WAIT_TIMEOUT_MS: { group: 'Jobs', description: 'How long a synchronous request waits before 202.', editable: true },

  MEDIA_MAX_BYTES: { group: 'Media', description: 'Largest accepted upload.', editable: true },
  SPOOL_MAX_AGE_MS: { group: 'Media', description: 'Spooled files older than this are swept.', editable: true },

  BROADCAST_MAX_RECIPIENTS: { group: 'Broadcasts', description: 'Recipients per broadcast.', editable: true },
  BROADCAST_MIN_CHUNK_DELAY_MS: { group: 'Broadcasts', description: 'Smallest allowed delay between chunks.', editable: true },

  POLL_ENABLED: { group: 'Inbound polling', description: 'Poll Arattai for incoming messages.', editable: true },
  POLL_INTERVAL_MS: { group: 'Inbound polling', description: 'Base polling interval.', editable: true },
  POLL_MAX_INTERVAL_MS: { group: 'Inbound polling', description: 'Polling interval ceiling when idle or failing.', editable: true },
  POLL_CHAT_LIMIT: { group: 'Inbound polling', description: 'Chats tracked.', editable: true },
  POLL_CHATS_PER_TICK: { group: 'Inbound polling', description: 'Chats checked per tick.', editable: true },
  POLL_CHATLIST_EVERY: { group: 'Inbound polling', description: 'Refresh the chat list every N ticks.', editable: true },
  POLL_MESSAGE_LIMIT: { group: 'Inbound polling', description: 'Messages fetched per chat.', editable: true },
  SELF_USER_ID: { group: 'Inbound polling', description: 'Your Arattai user id, to filter your own messages.', editable: true },
  POLL_EMIT_SELF: { group: 'Inbound polling', description: 'Emit events for your own messages.', editable: true },

  WEBHOOK_TIMEOUT_MS: { group: 'Webhooks', description: 'Delivery request timeout.', editable: true },
  WEBHOOK_MAX_ATTEMPTS: { group: 'Webhooks', description: 'Delivery attempts.', editable: true },
  WEBHOOK_BACKOFF_MS: { group: 'Webhooks', description: 'Base delivery retry backoff.', editable: true },
  WEBHOOK_ALLOW_HTTP: { group: 'Webhooks', description: 'Allow http:// receivers (development only).' },
  WEBHOOK_ALLOW_PRIVATE: { group: 'Webhooks', description: 'Allow private/loopback receivers (development only).' },
  WEBHOOK_MAX_CONSECUTIVE_FAILURES: { group: 'Webhooks', description: 'Failures before a subscription is disabled.', editable: true },

  // Env-only: re-pointing endpoints would send the session cookies wherever the API caller says.
  ARATTAI_ENDPOINT_OVERRIDES: { group: 'Arattai', description: 'JSON object re-pointing library endpoints.' },
  ARATTAI_USER_AGENT: { group: 'Arattai', description: 'User agent sent to Arattai.', editable: true },
};

export const EDITABLE_KEYS = CONFIG_KEYS.filter((k) => SETTINGS[k].editable);

export type Overrides = Partial<Record<ConfigKey, string>>;

export const OVERRIDES_KEY = 'settings:overrides';

export interface SettingView {
  key: ConfigKey;
  group: SettingGroup;
  description: string;
  /** Effective value in this process; secrets are masked. */
  value: string | null;
  source: 'override' | 'env' | 'default';
  editable: boolean;
  live: boolean;
  secret: boolean;
  /** Saved override that this process has not applied yet (needs a restart). */
  pending: string | null;
}

function display(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (Array.isArray(value)) return value.join(',');
  return String(value);
}

function mask(key: ConfigKey, value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (key === 'REDIS_URL') {
    try {
      const u = new URL(String(value));
      if (u.password) u.password = '****';
      return u.toString();
    } catch {
      return '****';
    }
  }
  if (Array.isArray(value)) return `${value.length} key${value.length === 1 ? '' : 's'} configured`;
  return 'configured';
}

export function describeSettings(config: Config, stored: Overrides): SettingView[] {
  return CONFIG_KEYS.map((key) => {
    const meta = SETTINGS[key];
    const raw = (config as unknown as Record<string, unknown>)[key];
    const source: SettingView['source'] =
      config.appliedOverrides[key] !== undefined ? 'override' : config.sourceEnv[key] !== undefined ? 'env' : 'default';
    const applied = config.appliedOverrides[key];
    return {
      key,
      group: meta.group,
      description: meta.description,
      value: meta.secret ? mask(key, raw) : display(raw),
      source,
      editable: Boolean(meta.editable),
      live: Boolean(meta.live),
      secret: Boolean(meta.secret),
      // "" means a removed override: back to the env/default value after a restart.
      pending: stored[key] === applied ? null : (stored[key] ?? ''),
    };
  });
}

export class SettingsStore {
  constructor(
    private readonly kv: KeyValueStore,
    private readonly config: Config,
    private readonly logger: Logger,
  ) {}

  async read(): Promise<Overrides> {
    return sanitize((await this.kv.get<Overrides>(OVERRIDES_KEY)) ?? {});
  }

  /**
   * Merge `changes` (null removes an override) into the stored overrides after validating the
   * resulting configuration as a whole. Returns the new stored overrides.
   */
  async update(changes: Record<string, string | null>): Promise<Overrides> {
    const unknown = Object.keys(changes).filter((k) => !EDITABLE_KEYS.includes(k as ConfigKey));
    if (unknown.length > 0) {
      throw new AppError({
        status: 400,
        code: 'SETTING_NOT_EDITABLE',
        message: `Not editable from the API: ${unknown.join(', ')}`,
        details: { keys: unknown },
      });
    }
    const next: Overrides = { ...(await this.read()) };
    for (const [key, value] of Object.entries(changes)) {
      if (value === null || value === '') delete next[key as ConfigKey];
      else next[key as ConfigKey] = String(value).trim();
    }
    try {
      loadConfig(this.config.sourceEnv, next);
    } catch (err) {
      if (err instanceof ConfigError) {
        throw new AppError({ status: 400, code: 'VALIDATION_FAILED', message: 'Settings validation failed', details: err.issues });
      }
      throw err;
    }
    await this.kv.set(OVERRIDES_KEY, next);
    this.logger.info('Settings updated', { component: 'settings', keys: Object.keys(changes) });
    return next;
  }
}

function sanitize(stored: Overrides): Overrides {
  const out: Overrides = {};
  for (const key of EDITABLE_KEYS) if (typeof stored[key] === 'string') out[key] = stored[key];
  return out;
}

/**
 * Read stored overrides before the runtime exists, so they can shape its configuration.
 * Uses the same location the runtime's key-value store will use.
 */
export async function readStoredOverrides(config: Config): Promise<Overrides> {
  if (config.STORE_DRIVER === 'redis') {
    const redis = new Redis(config.REDIS_URL!, { maxRetriesPerRequest: 3, lazyConnect: true, connectTimeout: 5_000 });
    redis.on('error', () => undefined);
    try {
      await redis.connect();
      const raw = await redis.get(`${config.REDIS_PREFIX}:${config.SESSION_ID}:kv:${OVERRIDES_KEY}`);
      return raw ? sanitize(JSON.parse(raw) as Overrides) : {};
    } finally {
      redis.disconnect();
    }
  }
  const kv = new FileKeyValueStore(path.join(config.dataDir, 'state'));
  try {
    return sanitize((await kv.get<Overrides>(OVERRIDES_KEY)) ?? {});
  } finally {
    await kv.close();
  }
}
