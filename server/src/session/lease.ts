import crypto from 'node:crypto';
import type { Redis } from 'ioredis';
import type { Logger } from '../logger';
import { sleep } from '../util';

const RENEW = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end`;
const RELEASE = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`;

/**
 * Redis lease guaranteeing a single session owner across worker processes.
 *
 * Two processes driving one Arattai account would race CSRF tokens, double-poll inbound
 * messages and double-deliver webhooks. Standby workers wait for the lease; the owner renews
 * it every ttl/3 and calls `onLost` if a renewal fails, at which point it must stop work
 * immediately (the process exits and is restarted by its supervisor).
 */
export class Lease {
  readonly token = `${process.pid}:${crypto.randomBytes(6).toString('hex')}`;
  private renewTimer: NodeJS.Timeout | null = null;
  private held = false;

  constructor(
    private readonly redis: Redis,
    private readonly key: string,
    private readonly ttlMs: number,
    private readonly logger: Logger,
  ) {}

  async tryAcquire(): Promise<boolean> {
    const ok = await this.redis.set(this.key, this.token, 'PX', this.ttlMs, 'NX');
    this.held = ok === 'OK';
    return this.held;
  }

  /** Poll until acquired; rejects with AbortedError when the signal aborts. */
  async acquire(signal: AbortSignal, retryMs = Math.max(1000, Math.floor(this.ttlMs / 3))): Promise<void> {
    let logged = false;
    while (!signal.aborted) {
      if (await this.tryAcquire()) return;
      if (!logged) {
        this.logger.info('Session lease held by another worker; standing by', {
          component: 'lease',
          holder: await this.holder(),
        });
        logged = true;
      }
      await sleep(retryMs, signal);
    }
    throw new Error('Lease acquisition aborted');
  }

  startRenewal(onLost: () => void): void {
    const interval = Math.max(500, Math.floor(this.ttlMs / 3));
    this.renewTimer = setInterval(async () => {
      try {
        const ok = await this.redis.eval(RENEW, 1, this.key, this.token, String(this.ttlMs));
        if (ok !== 1) throw new Error('lease taken over');
      } catch (err) {
        this.stopRenewal();
        this.held = false;
        this.logger.error('Session lease lost', { component: 'lease', error: (err as Error).message });
        onLost();
      }
    }, interval);
    this.renewTimer.unref();
  }

  stopRenewal(): void {
    if (this.renewTimer) clearInterval(this.renewTimer);
    this.renewTimer = null;
  }

  async release(): Promise<void> {
    this.stopRenewal();
    if (!this.held) return;
    this.held = false;
    await this.redis.eval(RELEASE, 1, this.key, this.token).catch(() => undefined);
  }

  async holder(): Promise<string | null> {
    return this.redis.get(this.key);
  }
}
