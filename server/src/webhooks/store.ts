import crypto from 'node:crypto';
import type { Cipher } from '../crypto';
import { randomToken } from '../crypto';
import type { KeyValueStore } from '../kv';

export interface WebhookSubscription {
  id: string;
  url: string;
  /** Event types, or "*" for every non-sensitive event. */
  events: string[];
  description: string | null;
  active: boolean;
  disabledReason: string | null;
  createdAt: string;
  updatedAt: string;
  consecutiveFailures: number;
  lastDeliveryAt: string | null;
  lastStatus: number | null;
  lastError: string | null;
  /** Signing secret, encrypted at rest. Never returned by the API after creation. */
  secretEnc: string;
}

export type PublicSubscription = Omit<WebhookSubscription, 'secretEnc'>;

export function toPublic(sub: WebhookSubscription): PublicSubscription {
  const { secretEnc: _secret, ...rest } = sub;
  return rest;
}

const PREFIX = 'webhook:';
const CACHE_MS = 5_000;

export class WebhookStore {
  private cache: { at: number; subs: WebhookSubscription[] } | null = null;

  constructor(
    private readonly kv: KeyValueStore,
    private readonly cipher: Cipher,
  ) {}

  async create(input: { url: string; events: string[]; description?: string; secret?: string }): Promise<{
    subscription: WebhookSubscription;
    secret: string;
  }> {
    const id = `wh_${crypto.randomUUID().replace(/-/g, '')}`;
    const secret = input.secret ?? `whsec_${randomToken(24)}`;
    const now = new Date().toISOString();
    const subscription: WebhookSubscription = {
      id,
      url: input.url,
      events: [...new Set(input.events)],
      description: input.description ?? null,
      active: true,
      disabledReason: null,
      createdAt: now,
      updatedAt: now,
      consecutiveFailures: 0,
      lastDeliveryAt: null,
      lastStatus: null,
      lastError: null,
      secretEnc: this.cipher.encrypt(secret, this.context(id)),
    };
    await this.kv.set(PREFIX + id, subscription);
    this.cache = null;
    return { subscription, secret };
  }

  get(id: string): Promise<WebhookSubscription | null> {
    return this.kv.get<WebhookSubscription>(PREFIX + id);
  }

  async list(): Promise<WebhookSubscription[]> {
    const keys = await this.kv.keys(PREFIX);
    const subs = await Promise.all(keys.map((k) => this.kv.get<WebhookSubscription>(k)));
    return subs.filter((s): s is WebhookSubscription => s !== null).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /** Active subscriptions, cached briefly because fan-out runs for every event. */
  async listActive(): Promise<WebhookSubscription[]> {
    if (this.cache && Date.now() - this.cache.at < CACHE_MS) return this.cache.subs;
    const subs = (await this.list()).filter((s) => s.active);
    this.cache = { at: Date.now(), subs };
    return subs;
  }

  async delete(id: string): Promise<boolean> {
    const existing = await this.get(id);
    if (!existing) return false;
    await this.kv.del(PREFIX + id);
    this.cache = null;
    return true;
  }

  secretOf(sub: WebhookSubscription): string {
    return this.cipher.decrypt(sub.secretEnc, this.context(sub.id));
  }

  /**
   * Record a delivery attempt. Read-modify-write without a lock: under concurrent deliveries
   * the failure counter is approximate, which is fine for an auto-disable threshold.
   */
  async recordAttempt(
    id: string,
    outcome: { ok: boolean; status: number | null; error: string | null },
    maxConsecutiveFailures: number,
  ): Promise<WebhookSubscription | null> {
    const sub = await this.get(id);
    if (!sub) return null;
    const now = new Date().toISOString();
    sub.lastDeliveryAt = now;
    sub.lastStatus = outcome.status;
    sub.lastError = outcome.error;
    sub.updatedAt = now;
    sub.consecutiveFailures = outcome.ok ? 0 : sub.consecutiveFailures + 1;
    if (!outcome.ok && sub.active && sub.consecutiveFailures >= maxConsecutiveFailures) {
      sub.active = false;
      sub.disabledReason = `Disabled after ${sub.consecutiveFailures} consecutive failed deliveries`;
    }
    await this.kv.set(PREFIX + id, sub);
    this.cache = null;
    return sub;
  }

  async deactivate(id: string, reason: string): Promise<void> {
    const sub = await this.get(id);
    if (!sub) return;
    sub.active = false;
    sub.disabledReason = reason;
    sub.updatedAt = new Date().toISOString();
    await this.kv.set(PREFIX + id, sub);
    this.cache = null;
  }

  private context(id: string): string {
    return `webhook-secret:${id}`;
  }
}
