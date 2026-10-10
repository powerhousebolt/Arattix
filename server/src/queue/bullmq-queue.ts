import { Job, Queue, QueueEvents, UnrecoverableError, Worker } from 'bullmq';
import type { Redis } from 'ioredis';
import { AppError, Errors, fromWireMessage, toAppError, toWireMessage } from '../errors';
import type { Logger } from '../logger';
import { JobWaitTimeoutError, type JobCounts, type JobHandler, type JobOptions, type JobQueue, type JobRecord, type JobState } from './types';

export interface BullQueueOptions {
  prefix: string;
  maxPending: number;
  /** Creates a dedicated Redis connection (BullMQ workers and event listeners block their connection). */
  connect: () => Redis;
}

/**
 * BullMQ-backed queue. Jobs survive restarts, can be produced by API processes and consumed by
 * the single session-owning worker, and are retried with exponential backoff.
 *
 * Errors travel through Redis as strings, so AppErrors are encoded with toWireMessage() and
 * non-retryable ones are raised as UnrecoverableError to stop BullMQ from retrying them.
 */
export class BullJobQueue implements JobQueue {
  private readonly queue: Queue;
  private events: QueueEvents | null = null;
  private eventsReady: Promise<void> | null = null;
  private worker: Worker | null = null;
  private readonly connections: Redis[] = [];

  constructor(
    readonly name: string,
    private readonly opts: BullQueueOptions,
    private readonly logger: Logger,
  ) {
    this.queue = new Queue(name, {
      connection: this.connection(),
      prefix: opts.prefix,
      defaultJobOptions: {
        removeOnComplete: { age: 24 * 60 * 60, count: 10_000 },
        removeOnFail: { age: 7 * 24 * 60 * 60, count: 10_000 },
      },
    });
    this.queue.on('error', (err) => this.logger.error('Queue error', { component: 'queue', queue: name, error: err.message }));
  }

  async add(name: string, data: unknown, opts: JobOptions = {}): Promise<{ id: string; deduplicated: boolean }> {
    if (opts.jobId) {
      const existing = await this.queue.getJob(opts.jobId);
      if (existing) return { id: opts.jobId, deduplicated: true };
    }
    const counts = await this.queue.getJobCounts('waiting', 'delayed', 'prioritized', 'paused');
    const pending = Object.values(counts).reduce((a, b) => a + b, 0);
    if (pending >= this.opts.maxPending) throw Errors.queueFull();

    const attempts = Math.max(1, opts.attempts ?? 1);
    const job = await this.queue.add(name, data, {
      ...(opts.jobId ? { jobId: opts.jobId } : {}),
      attempts,
      ...(attempts > 1 ? { backoff: { type: 'exponential', delay: opts.backoffMs ?? 1000 } } : {}),
      ...(opts.delayMs ? { delay: opts.delayMs } : {}),
    });
    return { id: String(job.id), deduplicated: false };
  }

  /**
   * Waits in short slices. QueueEvents can miss a completion that lands between its "ready"
   * and its first XREAD (or during a reconnect); every slice re-checks the job's finished
   * state, so a missed event costs at most one slice instead of the whole timeout.
   */
  async waitForResult(id: string, timeoutMs: number): Promise<unknown> {
    const events = await this.queueEvents();
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const job = await Job.fromId(this.queue, id);
      if (!job) throw Errors.notFound('Job');
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new JobWaitTimeoutError(id);
      try {
        return await job.waitUntilFinished(events, Math.min(remaining, 1_000));
      } catch (err) {
        const message = (err as Error)?.message ?? '';
        if (!/timed out before finishing/i.test(message)) throw toAppError(err);
      }
    }
  }

  async getJob(id: string): Promise<JobRecord | null> {
    const job = await Job.fromId(this.queue, id);
    if (!job) return null;
    const state = mapState(await job.getState());
    // failedReason is also set on a job waiting to retry: it is the last attempt's error.
    const error = job.failedReason
      ? (fromWireMessage(job.failedReason) ?? new AppError({ status: 500, code: 'INTERNAL', message: job.failedReason }))
      : null;
    return {
      id: String(job.id),
      name: job.name,
      state,
      progress: job.progress ?? null,
      ...(state === 'completed' ? { result: job.returnvalue } : {}),
      ...(error ? { error: error.toJSON() } : {}),
      attemptsMade: job.attemptsMade,
      createdAt: new Date(job.timestamp).toISOString(),
      finishedAt: job.finishedOn ? new Date(job.finishedOn).toISOString() : null,
    };
  }

  process(handler: JobHandler, concurrency: number): void {
    if (this.worker) throw new Error(`Queue ${this.name} already has a processor`);
    this.worker = new Worker(
      this.name,
      async (job) => {
        try {
          return await handler({
            id: String(job.id),
            name: job.name,
            data: job.data,
            attemptsMade: job.attemptsMade,
            attempts: job.opts.attempts ?? 1,
            updateProgress: (p) => job.updateProgress(p as object),
          });
        } catch (err) {
          const e = toAppError(err);
          if (e.code === 'INTERNAL') this.logger.error('Job handler crashed', { component: 'queue', queue: this.name, job: job.name, err });
          throw e.retryable ? new Error(toWireMessage(e)) : new UnrecoverableError(toWireMessage(e));
        }
      },
      { connection: this.connection(), prefix: this.opts.prefix, concurrency: Math.max(1, concurrency) },
    );
    this.worker.on('error', (err) => this.logger.error('Worker error', { component: 'queue', queue: this.name, error: err.message }));
  }

  async counts(): Promise<JobCounts> {
    const c = await this.queue.getJobCounts('waiting', 'prioritized', 'active', 'delayed', 'completed', 'failed');
    return {
      waiting: (c.waiting ?? 0) + (c.prioritized ?? 0),
      active: c.active ?? 0,
      delayed: c.delayed ?? 0,
      completed: c.completed ?? 0,
      failed: c.failed ?? 0,
    };
  }

  /** Waits for active jobs to finish (BullMQ semantics) before closing connections. */
  async close(): Promise<void> {
    await this.worker?.close();
    await this.events?.close();
    await this.queue.close();
    await Promise.allSettled(this.connections.map((c) => c.quit()));
  }

  private connection(): Redis {
    const c = this.opts.connect();
    this.connections.push(c);
    return c;
  }

  private async queueEvents(): Promise<QueueEvents> {
    if (!this.events) {
      this.events = new QueueEvents(this.name, { connection: this.connection(), prefix: this.opts.prefix });
      this.events.on('error', (err) => this.logger.error('QueueEvents error', { component: 'queue', queue: this.name, error: err.message }));
      this.eventsReady = this.events.waitUntilReady().then(() => undefined);
    }
    await this.eventsReady;
    return this.events;
  }
}

function mapState(state: string): JobState {
  switch (state) {
    case 'completed':
    case 'failed':
    case 'delayed':
    case 'active':
      return state;
    case 'waiting':
    case 'prioritized':
    case 'waiting-children':
    case 'paused':
      return 'waiting';
    default:
      return 'unknown';
  }
}

