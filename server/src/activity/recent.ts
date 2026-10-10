import type { Redis } from 'ioredis';

/**
 * Bounded, append-only feeds behind the admin UI's log and event views.
 *
 * Every entry gets a monotonically increasing `seq`, so a client can tail a feed by asking for
 * entries after the last one it has. The memory feed is per process; the Redis feed is shared,
 * so an API process can show what the session worker logged.
 */
export interface RecentEntry {
  seq: number;
}

export interface RecentQuery {
  /** Only entries with seq greater than this. */
  after?: number;
  /** Newest `limit` entries matching the filter, returned oldest first. */
  limit: number;
}

export interface RecentFeed<T extends object> {
  push(entry: T): void;
  /** Newest matching entries, oldest first. `filter` runs before `limit`. */
  list(query: RecentQuery, filter?: (entry: T & RecentEntry) => boolean): Promise<Array<T & RecentEntry>>;
  clear(): Promise<void>;
}

export class MemoryRecentFeed<T extends object> implements RecentFeed<T> {
  private readonly entries: Array<T & RecentEntry> = [];
  private seq = 0;

  constructor(private readonly capacity: number) {}

  push(entry: T): void {
    if (this.capacity <= 0) return;
    this.seq += 1;
    this.entries.push({ ...entry, seq: this.seq });
    if (this.entries.length > this.capacity) this.entries.splice(0, this.entries.length - this.capacity);
  }

  async list(query: RecentQuery, filter?: (entry: T & RecentEntry) => boolean): Promise<Array<T & RecentEntry>> {
    return select(this.entries, query, filter);
  }

  async clear(): Promise<void> {
    this.entries.length = 0;
  }
}

/**
 * Redis list (newest first) capped at `capacity`, plus a counter for seq numbers.
 * Writes are fire-and-forget and dropped while Redis is unavailable: a log sink must never
 * block or fail the code that logs, and must never log its own failures.
 */
export class RedisRecentFeed<T extends object> implements RecentFeed<T> {
  constructor(
    private readonly redis: Redis,
    private readonly key: string,
    private readonly capacity: number,
  ) {}

  push(entry: T): void {
    if (this.capacity <= 0 || this.redis.status !== 'ready') return;
    const key = this.key;
    // One round trip: assign the seq and store the entry atomically.
    this.redis
      .eval(
        `local seq = redis.call('INCR', KEYS[2])
         local entry = cjson.decode(ARGV[1])
         entry['seq'] = seq
         redis.call('LPUSH', KEYS[1], cjson.encode(entry))
         redis.call('LTRIM', KEYS[1], 0, tonumber(ARGV[2]) - 1)
         return seq`,
        2,
        `${key}:list`,
        `${key}:seq`,
        JSON.stringify(entry),
        String(this.capacity),
      )
      .catch(() => undefined);
  }

  async list(query: RecentQuery, filter?: (entry: T & RecentEntry) => boolean): Promise<Array<T & RecentEntry>> {
    const raw = await this.redis.lrange(`${this.key}:list`, 0, this.capacity - 1);
    const entries: Array<T & RecentEntry> = [];
    for (let i = raw.length - 1; i >= 0; i -= 1) {
      try {
        entries.push(JSON.parse(raw[i]!) as T & RecentEntry);
      } catch {
        // A corrupt entry is skipped, never fatal for the whole feed.
      }
    }
    return select(entries, query, filter);
  }

  async clear(): Promise<void> {
    await this.redis.del(`${this.key}:list`);
  }
}

function select<T extends RecentEntry>(entries: T[], query: RecentQuery, filter?: (entry: T) => boolean): T[] {
  const out: T[] = [];
  for (let i = entries.length - 1; i >= 0 && out.length < query.limit; i -= 1) {
    const e = entries[i]!;
    if (query.after !== undefined && e.seq <= query.after) break;
    if (!filter || filter(e)) out.push(e);
  }
  return out.reverse();
}
