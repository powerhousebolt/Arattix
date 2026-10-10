import { sleep } from '../util';

export interface ThrottleOptions {
  ratePerMinute: number;
  burst: number;
  perChatIntervalMs: number;
  jitterMs: number;
  now?: () => number;
  random?: () => number;
}

/**
 * Pacing for outbound sends, to stay under platform limits and avoid robotic patterns:
 *  - account-wide token bucket (ratePerMinute sustained, `burst` back-to-back),
 *  - minimum spacing between two sends to the same chat,
 *  - random jitter on top so sends are not perfectly periodic.
 *
 * Lives in the single session-owning worker, so in-process state is the global state.
 */
export class SendThrottle {
  private tokens: number;
  private lastRefill: number;
  private readonly perChat = new Map<string, number>();
  private readonly now: () => number;
  private readonly random: () => number;

  constructor(private readonly opts: ThrottleOptions) {
    this.now = opts.now ?? Date.now;
    this.random = opts.random ?? Math.random;
    this.tokens = opts.burst;
    this.lastRefill = this.now();
  }

  async acquire(chatId: string, signal?: AbortSignal): Promise<void> {
    const ratePerMs = this.opts.ratePerMinute / 60_000;
    for (;;) {
      this.refill(ratePerMs);
      const bucketWait = this.tokens >= 1 ? 0 : (1 - this.tokens) / ratePerMs;
      const lastSend = this.perChat.get(chatId);
      const chatWait = lastSend === undefined ? 0 : lastSend + this.opts.perChatIntervalMs - this.now();
      const wait = Math.max(bucketWait, chatWait);
      if (wait <= 0) break;
      await sleep(Math.ceil(wait), signal);
    }
    // Check-and-consume happens without an await in between, so concurrent callers cannot share a token.
    this.tokens -= 1;
    this.perChat.set(chatId, this.now());
    this.prune();
    if (this.opts.jitterMs > 0) await sleep(Math.floor(this.random() * this.opts.jitterMs), signal);
  }

  private refill(ratePerMs: number): void {
    const now = this.now();
    this.tokens = Math.min(this.opts.burst, this.tokens + (now - this.lastRefill) * ratePerMs);
    this.lastRefill = now;
  }

  private prune(): void {
    if (this.perChat.size < 10_000) return;
    const cutoff = this.now() - this.opts.perChatIntervalMs;
    for (const [chat, at] of this.perChat) if (at < cutoff) this.perChat.delete(chat);
  }
}
