import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Redis } from 'ioredis';

/**
 * Small JSON key-value abstraction behind every persistent piece of state
 * (session snapshot, connection status, poller cursors, webhook subscriptions).
 */
export interface KeyValueStore {
  get<T>(key: string): Promise<T | null>;
  set(key: string, value: unknown, ttlMs?: number): Promise<void>;
  del(key: string): Promise<void>;
  /** Keys starting with `prefix` (unordered). */
  keys(prefix: string): Promise<string[]>;
  ping(): Promise<void>;
  close(): Promise<void>;
}

interface Envelope {
  v: unknown;
  exp?: number;
}

export class MemoryKeyValueStore implements KeyValueStore {
  private readonly map = new Map<string, Envelope>();

  async get<T>(key: string): Promise<T | null> {
    const e = this.map.get(key);
    if (!e) return null;
    if (e.exp !== undefined && e.exp <= Date.now()) {
      this.map.delete(key);
      return null;
    }
    return structuredClone(e.v) as T;
  }

  async set(key: string, value: unknown, ttlMs?: number): Promise<void> {
    this.map.set(key, { v: structuredClone(value), ...(ttlMs ? { exp: Date.now() + ttlMs } : {}) });
  }

  async del(key: string): Promise<void> {
    this.map.delete(key);
  }

  async keys(prefix: string): Promise<string[]> {
    return [...this.map.keys()].filter((k) => k.startsWith(prefix));
  }

  async ping(): Promise<void> {}
  async close(): Promise<void> {}
}

/**
 * One file per key under `dir`, written atomically (temp file + rename) with mode 0600.
 * Writes to the same key are serialised in-process. Only one process may own a directory;
 * use the Redis store for multi-process deployments.
 */
export class FileKeyValueStore implements KeyValueStore {
  private readonly chains = new Map<string, Promise<unknown>>();

  constructor(private readonly dir: string) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  private file(key: string): string {
    return path.join(this.dir, `${encodeURIComponent(key)}.json`);
  }

  private serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const settled = next.catch(() => undefined);
    this.chains.set(key, settled);
    void settled.then(() => {
      if (this.chains.get(key) === settled) this.chains.delete(key);
    });
    return next;
  }

  async get<T>(key: string): Promise<T | null> {
    let raw: string;
    try {
      raw = await fs.promises.readFile(this.file(key), 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
    const e = JSON.parse(raw) as Envelope;
    if (e.exp !== undefined && e.exp <= Date.now()) {
      await this.del(key);
      return null;
    }
    return e.v as T;
  }

  set(key: string, value: unknown, ttlMs?: number): Promise<void> {
    return this.serial(key, async () => {
      const target = this.file(key);
      const tmp = `${target}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
      const body = JSON.stringify({ v: value, ...(ttlMs ? { exp: Date.now() + ttlMs } : {}) });
      const handle = await fs.promises.open(tmp, 'w', 0o600);
      try {
        await handle.writeFile(body, 'utf8');
        await handle.sync(); // survive power loss between write and rename
      } finally {
        await handle.close();
      }
      try {
        await fs.promises.rename(tmp, target);
      } catch (err) {
        await fs.promises.rm(tmp, { force: true });
        throw err;
      }
    });
  }

  del(key: string): Promise<void> {
    return this.serial(key, () => fs.promises.rm(this.file(key), { force: true }));
  }

  async keys(prefix: string): Promise<string[]> {
    const names = await fs.promises.readdir(this.dir);
    return names
      .filter((n) => n.endsWith('.json'))
      .map((n) => decodeURIComponent(n.slice(0, -'.json'.length)))
      .filter((k) => k.startsWith(prefix));
  }

  async ping(): Promise<void> {
    await fs.promises.access(this.dir, fs.constants.W_OK);
  }

  async close(): Promise<void> {
    await Promise.allSettled([...this.chains.values()]);
  }
}

export class RedisKeyValueStore implements KeyValueStore {
  constructor(
    private readonly redis: Redis,
    private readonly namespace: string,
  ) {}

  private k(key: string): string {
    return `${this.namespace}:kv:${key}`;
  }

  async get<T>(key: string): Promise<T | null> {
    const raw = await this.redis.get(this.k(key));
    return raw === null ? null : (JSON.parse(raw) as T);
  }

  async set(key: string, value: unknown, ttlMs?: number): Promise<void> {
    const raw = JSON.stringify(value);
    if (ttlMs) await this.redis.set(this.k(key), raw, 'PX', ttlMs);
    else await this.redis.set(this.k(key), raw);
  }

  async del(key: string): Promise<void> {
    await this.redis.del(this.k(key));
  }

  async keys(prefix: string): Promise<string[]> {
    const base = this.k('');
    const pattern = `${base}${prefix.replace(/[*?[\]\\]/g, '\\$&')}*`;
    const found = new Set<string>();
    let cursor = '0';
    do {
      const [next, batch] = await this.redis.scan(cursor, 'MATCH', pattern, 'COUNT', 200);
      cursor = next;
      for (const key of batch) found.add(key.slice(base.length));
    } while (cursor !== '0');
    return [...found];
  }

  async ping(): Promise<void> {
    await this.redis.ping();
  }

  async close(): Promise<void> {
    // The Redis connection is owned and closed by the runtime.
  }
}
