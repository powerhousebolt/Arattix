import Transport from 'winston-transport';
import { redact } from '../logger';
import { SENSITIVE_EVENTS, type ArattaiEvent, type EventBus } from '../events/bus';
import type { RecentFeed } from './recent';

export const LOG_LEVELS = ['error', 'warn', 'info', 'http', 'verbose', 'debug', 'silly'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export interface LogRecord {
  at: string;
  level: LogLevel;
  message: string;
  component: string | null;
  role: string | null;
  pid: number | null;
  /** Remaining structured fields (already redacted by the logger). */
  meta: Record<string, unknown>;
}

export interface EventRecord {
  id: string;
  type: string;
  occurredAt: string;
  /** Omitted for events that carry login material. */
  data: unknown;
}

const MAX_META_CHARS = 8_000;
const OMIT = new Set(['level', 'message', 'timestamp', 'component', 'role', 'pid', 'sessionId']);

/** Winston transport that copies every record into a RecentFeed for the admin UI. */
export class FeedTransport extends Transport {
  constructor(private readonly feed: RecentFeed<LogRecord>) {
    super();
  }

  override log(info: Record<string, unknown>, next: () => void): void {
    try {
      this.feed.push(toLogRecord(info));
    } catch {
      // Never let the admin buffer break logging.
    }
    next();
  }
}

export function toLogRecord(info: Record<string, unknown>): LogRecord {
  const fields: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(info)) {
    if (!OMIT.has(k)) fields[k] = v instanceof Error ? { name: v.name, message: v.message, stack: v.stack } : v;
  }
  // The logger already redacts; doing it again here keeps the feed safe with any logger.
  const meta = redact(fields) as Record<string, unknown>;
  let safeMeta: Record<string, unknown> = meta;
  try {
    const json = JSON.stringify(meta);
    if (json.length > MAX_META_CHARS) safeMeta = { truncated: true, preview: json.slice(0, MAX_META_CHARS) };
  } catch {
    safeMeta = { unserializable: true };
  }
  const level = String(info.level ?? 'info') as LogLevel;
  return {
    at: typeof info.timestamp === 'string' ? info.timestamp : new Date().toISOString(),
    level: LOG_LEVELS.includes(level) ? level : 'info',
    message: String(info.message ?? ''),
    component: typeof info.component === 'string' ? info.component : null,
    role: typeof info.role === 'string' ? info.role : null,
    pid: typeof info.pid === 'number' ? info.pid : null,
    meta: safeMeta,
  };
}

/** Record every bus event (login material stripped) into the events feed. */
export function recordEvents(bus: EventBus, feed: RecentFeed<EventRecord>): () => void {
  return bus.subscribe((event: ArattaiEvent) => {
    feed.push({
      id: event.id,
      type: event.type,
      occurredAt: event.occurredAt,
      data: SENSITIVE_EVENTS.has(event.type) ? { redacted: true } : withoutRaw(event.data),
    });
  });
}

/** Upstream payloads are large and already summarised by the normalised fields. */
function withoutRaw(data: unknown): unknown {
  if (data && typeof data === 'object' && !Array.isArray(data) && 'raw' in data) {
    const { raw: _raw, ...rest } = data as Record<string, unknown>;
    return rest;
  }
  return data;
}

/** True when `level` is at least as severe as `min`. */
export function atLeast(level: LogLevel, min: LogLevel): boolean {
  return LOG_LEVELS.indexOf(level) <= LOG_LEVELS.indexOf(min);
}
