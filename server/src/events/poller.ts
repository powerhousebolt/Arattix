import type { ArattaiGateway, ArattaiMessage, ChatSummary } from '../arattai/gateway';
import { toAppError } from '../errors';
import type { KeyValueStore } from '../kv';
import type { Logger } from '../logger';
import type { Metrics } from '../metrics';
import type { ConnectionManager } from '../session/connection-manager';
import type { EventBus } from './bus';

export interface PollerOptions {
  intervalMs: number;
  maxIntervalMs: number;
  chatLimit: number;
  chatsPerTick: number;
  chatListEvery: number;
  messageLimit: number;
  selfUserId?: string;
  emitSelf: boolean;
}

interface ChatCursor {
  /** Last v1 `lastmsguid` seen for the chat; used only to detect change. */
  last: string | null;
  /** Recent v2 message ids already emitted (or seeded), newest last. */
  seen: string[];
  updatedAt: number;
}

interface CursorState {
  bootstrappedAt: string | null;
  /** Start time of the last fully successful tick (epoch ms). */
  watermark: number | null;
  chats: Record<string, ChatCursor>;
}

const SEEN_PER_CHAT = 200;
const MAX_TRACKED_CHATS = 1_000;

export interface MessageReceivedData {
  chatId: string;
  chatTitle: string | null;
  message: Omit<ArattaiMessage, 'raw'> & { fromSelf: boolean | null };
  /** True when more messages arrived between two polls than one fetch returns: some may be missing. */
  gapDetected: boolean;
  raw: unknown;
}

/**
 * Inbound event source. The arattix library has no push channel (no WebSocket), so inbound
 * messages are discovered by polling, at a bounded request rate:
 *
 *  - the chat list is refreshed every `chatListEvery` ticks,
 *  - each tick fetches messages for at most `chatsPerTick` chats: chats whose last message
 *    changed first, then a round-robin over the rest (v1 chat data can be cached server-side,
 *    so change detection alone is not trusted),
 *  - message ids already seen are kept per chat and persisted, so restarts neither replay
 *    old messages nor lose ones that arrived while down (up to `messageLimit` per chat).
 */
export class InboundPoller {
  private state: CursorState = { bootstrappedAt: null, watermark: null, chats: {} };
  private loaded = false;
  private dirty = false;
  private chats: ChatSummary[] = [];
  private tick = 0;
  private roundRobin = 0;
  private failures = 0;
  private timer: NodeJS.Timeout | null = null;
  /** Bumped by start()/stop(): a tick from an older run must not schedule another one. */
  private loop = 0;
  private running = false;
  private active = false;
  private stopRequested = false;
  private readonly key: string;
  private readonly log: Logger;

  constructor(
    private readonly deps: {
      sessionId: string;
      gateway: ArattaiGateway;
      connection: ConnectionManager;
      kv: KeyValueStore;
      bus: EventBus;
      logger: Logger;
      metrics: Metrics;
      options: PollerOptions;
    },
  ) {
    this.key = `cursors:${deps.sessionId}`;
    this.log = deps.logger.child({ component: 'poller' });
  }

  /** Wire into the connection lifecycle: prime while SYNCING, run only while READY. */
  attach(): void {
    this.deps.connection.addSyncHook(() => this.prime());
    this.deps.connection.onStateChange((status) => {
      if (status.state === 'READY') this.start();
      else this.stop();
    });
  }

  start(): void {
    if (this.active) return;
    this.active = true;
    this.loop += 1;
    this.stopRequested = false;
    this.failures = 0;
    this.tick = 0;
    this.schedule(this.deps.options.intervalMs);
  }

  stop(): void {
    this.active = false;
    this.loop += 1;
    this.stopRequested = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Load cursors; on the very first run, seed every chat silently so history is not replayed. */
  async prime(): Promise<void> {
    await this.load();
    if (this.state.bootstrappedAt) return;

    const opts = this.deps.options;
    this.chats = await this.deps.gateway.listChats(opts.chatLimit);
    for (const chat of this.chats) {
      try {
        const messages = await this.deps.gateway.fetchMessages(chat.chatId, opts.messageLimit);
        this.remember(chat, messages.map((m) => m.id));
      } catch (err) {
        this.log.warn('Could not seed chat during bootstrap', { chatId: chat.chatId, code: toAppError(err).code });
      }
    }
    this.state.bootstrappedAt = new Date().toISOString();
    this.state.watermark = Date.now();
    this.dirty = true;
    await this.save();
    this.log.info('Inbound cursors bootstrapped', { chats: this.chats.length });
  }

  /** One polling pass. Public for tests. */
  async runOnce(): Promise<void> {
    if (this.running) return;
    this.running = true;
    const startedAt = Date.now();
    const opts = this.deps.options;
    try {
      await this.load();
      this.tick += 1;
      if (this.chats.length === 0 || (this.tick - 1) % opts.chatListEvery === 0) {
        this.chats = await this.deps.gateway.listChats(opts.chatLimit);
      }

      for (const chat of this.pickTargets()) {
        if (this.stopRequested) return; // session left READY mid-tick
        await this.pollChat(chat);
      }
      this.state.watermark = startedAt;
      // prime() may have failed during SYNCING; the first good tick completes the bootstrap.
      this.state.bootstrappedAt ??= new Date().toISOString();
      this.dirty = true;
      this.failures = 0;
    } catch (err) {
      const e = toAppError(err);
      this.failures += 1;
      this.deps.metrics.inc('arattai_poll_errors_total', 'Inbound polling failures by error code.', { code: e.code });
      if (e.code === 'SESSION_EXPIRED') this.deps.connection.reportAuthFailure('poller');
      else this.log.warn('Poll tick failed', { code: e.code, failures: this.failures });
    } finally {
      await this.save();
      this.running = false;
    }
  }

  private pickTargets(): ChatSummary[] {
    const limit = this.deps.options.chatsPerTick;
    const changed = this.chats.filter((c) => {
      const cur = this.state.chats[c.chatId];
      return !cur || (c.lastMessageId !== null && cur.last !== c.lastMessageId);
    });
    const targets = changed.slice(0, limit);
    const rest = this.chats.filter((c) => !targets.includes(c));
    const rotating = Math.min(rest.length, limit - targets.length);
    for (let i = 0; i < rotating; i++) {
      targets.push(rest[(this.roundRobin + i) % rest.length]!);
    }
    if (rest.length > 0) this.roundRobin = (this.roundRobin + rotating) % rest.length;
    return targets;
  }

  private async pollChat(chat: ChatSummary): Promise<void> {
    const messages = await this.deps.gateway.fetchMessages(chat.chatId, this.deps.options.messageLimit);
    const cursor = this.state.chats[chat.chatId];
    let fresh: ArattaiMessage[];
    let gapDetected = false;

    if (cursor) {
      const seen = new Set(cursor.seen);
      fresh = messages.filter((m) => !seen.has(m.id));
      // Nothing we fetched overlaps what we saw before: more messages arrived than one page holds.
      gapDetected = seen.size > 0 && messages.length >= this.deps.options.messageLimit && fresh.length === messages.length;
    } else {
      // Chat not seen before (new conversation, or one that just entered the top-N list).
      // Only messages provably newer than the last successful tick are emitted; without a
      // timestamp we cannot tell old from new, so they are seeded silently.
      const watermark = this.state.watermark ?? Date.now();
      fresh = messages.filter((m) => m.timestamp !== null && m.timestamp > watermark);
    }

    if (gapDetected) {
      this.deps.metrics.inc('arattai_poll_gaps_total', 'Polls where more messages arrived than one fetch returns.');
      this.log.warn('Possible message gap; consider a lower POLL_INTERVAL_MS or higher POLL_MESSAGE_LIMIT', { chatId: chat.chatId });
    }

    let first = true;
    for (const m of fresh) {
      const fromSelf = this.deps.options.selfUserId ? m.sender?.id === this.deps.options.selfUserId : null;
      if (fromSelf && !this.deps.options.emitSelf) continue;
      const { raw, ...message } = m;
      const data: MessageReceivedData = {
        chatId: chat.chatId,
        chatTitle: chat.title,
        message: { ...message, fromSelf },
        gapDetected: gapDetected && first,
        raw,
      };
      this.deps.bus.publish('message.received', data);
      this.deps.metrics.inc('arattai_inbound_messages_total', 'Inbound messages emitted as events.');
      first = false;
    }
    this.remember(chat, messages.map((m) => m.id));
  }

  private remember(chat: ChatSummary, ids: string[]): void {
    const cur = this.state.chats[chat.chatId] ?? { last: null, seen: [], updatedAt: 0 };
    const merged = [...cur.seen.filter((id) => !ids.includes(id)), ...ids];
    this.state.chats[chat.chatId] = {
      last: chat.lastMessageId,
      seen: merged.slice(-SEEN_PER_CHAT),
      updatedAt: Date.now(),
    };
    this.dirty = true;
  }

  private schedule(delay: number): void {
    if (!this.active) return;
    const loop = this.loop;
    this.timer = setTimeout(async () => {
      await this.runOnce();
      // stop() + start() while this tick ran (a quick reconnect) already began a new loop:
      // rescheduling here too would poll twice as often from then on.
      if (loop !== this.loop) return;
      const o = this.deps.options;
      const next = this.failures === 0 ? o.intervalMs : Math.min(o.maxIntervalMs, o.intervalMs * 2 ** this.failures);
      this.schedule(next);
    }, delay);
    this.timer.unref();
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    const stored = await this.deps.kv.get<CursorState>(this.key);
    if (stored) this.state = stored;
    this.loaded = true;
  }

  private async save(): Promise<void> {
    if (!this.dirty) return;
    const entries = Object.entries(this.state.chats);
    if (entries.length > MAX_TRACKED_CHATS) {
      entries.sort((a, b) => b[1].updatedAt - a[1].updatedAt);
      this.state.chats = Object.fromEntries(entries.slice(0, MAX_TRACKED_CHATS));
    }
    try {
      await this.deps.kv.set(this.key, this.state);
      this.dirty = false;
    } catch (err) {
      this.log.error('Failed to persist inbound cursors', { error: (err as Error).message });
    }
  }
}
