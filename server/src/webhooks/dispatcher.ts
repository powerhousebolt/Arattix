import { AppError } from '../errors';
import { SENSITIVE_EVENTS, type ArattaiEvent, type EventBus, type EventType } from '../events/bus';
import type { Logger } from '../logger';
import type { Metrics } from '../metrics';
import type { JobContext, JobQueue } from '../queue/types';
import { safeId } from '../util';
import { postJson } from './http-post';
import { signPayload, SIGNATURE_HEADER } from './signature';
import type { WebhookStore, WebhookSubscription } from './store';
import { assertWebhookUrl } from './url-guard';

export interface WebhookConfig {
  timeoutMs: number;
  maxAttempts: number;
  backoffMs: number;
  allowHttp: boolean;
  allowPrivate: boolean;
  maxConsecutiveFailures: number;
}

export interface DeliveryJob {
  subscriptionId: string;
  event: ArattaiEvent;
}

export function subscriptionMatches(sub: Pick<WebhookSubscription, 'events'>, type: EventType): boolean {
  if (sub.events.includes(type)) return true;
  return sub.events.includes('*') && !SENSITIVE_EVENTS.has(type);
}

/**
 * Fans every bus event out to matching subscriptions as one queued delivery job each, and
 * performs those deliveries: signed POST, retries with exponential backoff on 5xx/429/network
 * errors, no retry on other 4xx, auto-disable on 410 Gone or too many consecutive failures.
 * Delivery is at-least-once: receivers should dedupe on X-Arattai-Delivery.
 */
export class WebhookDispatcher {
  private readonly log: Logger;

  constructor(
    private readonly deps: {
      store: WebhookStore;
      queue: JobQueue;
      bus: EventBus;
      logger: Logger;
      metrics: Metrics;
      config: WebhookConfig;
    },
  ) {
    this.log = deps.logger.child({ component: 'webhooks' });
  }

  attach(): () => void {
    return this.deps.bus.subscribe((event) => this.fanOut(event));
  }

  async fanOut(event: ArattaiEvent): Promise<void> {
    const subs = await this.deps.store.listActive();
    await Promise.all(subs.filter((s) => subscriptionMatches(s, event.type)).map((s) => this.enqueue(s.id, event)));
  }

  async enqueue(subscriptionId: string, event: ArattaiEvent): Promise<string> {
    const { id } = await this.deps.queue.add('deliver', { subscriptionId, event } satisfies DeliveryJob, {
      jobId: safeId(`${event.id}-${subscriptionId}`),
      attempts: this.deps.config.maxAttempts,
      backoffMs: this.deps.config.backoffMs,
    });
    return id;
  }

  /** Queue handler for 'deliver' jobs. */
  async deliver(job: JobContext<DeliveryJob>): Promise<{ status: number; skipped?: string }> {
    const { subscriptionId, event } = job.data;
    const cfg = this.deps.config;
    const sub = await this.deps.store.get(subscriptionId);
    if (!sub) return { status: 0, skipped: 'subscription_deleted' };
    if (!sub.active) return { status: 0, skipped: 'subscription_inactive' };

    let url: URL;
    try {
      url = assertWebhookUrl(sub.url, { allowHttp: cfg.allowHttp, allowPrivate: cfg.allowPrivate });
    } catch (err) {
      await this.deps.store.deactivate(sub.id, (err as Error).message);
      return { status: 0, skipped: 'url_rejected' };
    }

    const body = JSON.stringify(event);
    const headers = {
      [SIGNATURE_HEADER]: signPayload(this.deps.store.secretOf(sub), body),
      'X-Arattai-Event': event.type,
      'X-Arattai-Delivery': event.id,
      'X-Arattai-Attempt': String(job.attemptsMade + 1),
      'User-Agent': 'arattix-server-webhooks/1.0',
    };

    let status: number | null = null;
    let failure: AppError | null = null;
    try {
      const res = await postJson(url, body, headers, { timeoutMs: cfg.timeoutMs, allowPrivate: cfg.allowPrivate });
      status = res.status;
      if (status >= 200 && status < 300) {
        await this.deps.store.recordAttempt(sub.id, { ok: true, status, error: null }, cfg.maxConsecutiveFailures);
        this.deps.metrics.inc('webhook_deliveries_total', 'Webhook delivery attempts by outcome.', { result: 'success' });
        return { status };
      }
      if (status === 410) {
        await this.deps.store.deactivate(sub.id, 'Receiver answered 410 Gone');
        this.deps.metrics.inc('webhook_deliveries_total', 'Webhook delivery attempts by outcome.', { result: 'gone' });
        return { status, skipped: 'gone' };
      }
      const retryable = status >= 500 || status === 408 || status === 429;
      failure = new AppError({
        status: 502,
        code: 'WEBHOOK_HTTP_ERROR',
        message: `Receiver answered HTTP ${status}`,
        retryable,
        details: { receiverStatus: status, body: res.bodySnippet.slice(0, 256) },
      });
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      const blocked = e.code === 'EWEBHOOKPRIVATE';
      failure = new AppError({
        status: 502,
        code: blocked ? 'WEBHOOK_URL_REJECTED' : 'WEBHOOK_NETWORK_ERROR',
        message: e.message,
        retryable: !blocked,
      });
    }

    const updated = await this.deps.store.recordAttempt(
      sub.id,
      { ok: false, status, error: failure.message },
      cfg.maxConsecutiveFailures,
    );
    this.deps.metrics.inc('webhook_deliveries_total', 'Webhook delivery attempts by outcome.', { result: 'failure' });
    this.log.warn('Webhook delivery failed', {
      subscriptionId: sub.id,
      eventType: event.type,
      attempt: job.attemptsMade + 1,
      status,
      code: failure.code,
      disabled: updated ? !updated.active : false,
    });
    throw failure;
  }
}
