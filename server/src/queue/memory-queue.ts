import crypto from 'node:crypto';
import { AppError, Errors, toAppError } from '../errors';
import type { Logger } from '../logger';
import {
  JobWaitTimeoutError,
  type JobCounts,
  type JobHandler,
  type JobOptions,
  type JobQueue,
  type JobRecord,
  type ListableState,
} from './types';

interface InternalJob {
  record: JobRecord;
  data: unknown;
  attempts: number;
  backoffMs: number;
  timer: NodeJS.Timeout | null;
  waiters: Array<{ resolve: (v: unknown) => void; reject: (e: unknown) => void }>;
}

export interface MemoryQueueOptions {
  maxPending: number;
  /** Finished jobs kept for status lookups / idempotency. */
  retainFinished?: number;
  retainFinishedMs?: number;
}

/**
 * Single-process queue with the same semantics as the BullMQ adapter: deterministic job ids,
 * retries with exponential backoff, bounded backlog and result retention.
 * Pending jobs do not survive a restart; use QUEUE_DRIVER=bullmq when that matters.
 */
export class MemoryJobQueue implements JobQueue {
  private readonly jobs = new Map<string, InternalJob>();
  private readonly waiting: string[] = [];
  private readonly finished: string[] = [];
  private handler: JobHandler | null = null;
  private concurrency = 1;
  private active = 0;
  private closed = false;
  private readonly idle: Array<() => void> = [];

  constructor(
    readonly name: string,
    private readonly opts: MemoryQueueOptions,
    private readonly logger: Logger,
  ) {}

  async add(name: string, data: unknown, opts: JobOptions = {}): Promise<{ id: string; deduplicated: boolean }> {
    if (this.closed) throw Errors.shuttingDown();
    if (opts.jobId && this.jobs.has(opts.jobId)) return { id: opts.jobId, deduplicated: true };
    if (this.pendingCount() >= this.opts.maxPending) throw Errors.queueFull();

    const id = opts.jobId ?? crypto.randomUUID();
    const job: InternalJob = {
      record: {
        id,
        name,
        state: 'waiting',
        progress: null,
        attemptsMade: 0,
        createdAt: new Date().toISOString(),
        finishedAt: null,
      },
      data: structuredClone(data),
      attempts: Math.max(1, opts.attempts ?? 1),
      backoffMs: opts.backoffMs ?? 1000,
      timer: null,
      waiters: [],
    };
    this.jobs.set(id, job);
    if (opts.delayMs && opts.delayMs > 0) this.delay(job, opts.delayMs);
    else this.enqueue(job);
    return { id, deduplicated: false };
  }

  waitForResult(id: string, timeoutMs: number): Promise<unknown> {
    const job = this.jobs.get(id);
    if (!job) return Promise.reject(Errors.notFound('Job'));
    if (job.record.state === 'completed') return Promise.resolve(job.record.result);
    if (job.record.state === 'failed') {
      return Promise.reject(new AppError(job.record.error ?? { status: 500, code: 'INTERNAL', message: 'Job failed' }));
    }

    return new Promise((resolve, reject) => {
      const waiter = {
        resolve: (v: unknown) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e: unknown) => {
          clearTimeout(timer);
          reject(e);
        },
      };
      const timer = setTimeout(() => {
        job.waiters = job.waiters.filter((w) => w !== waiter);
        reject(new JobWaitTimeoutError(id));
      }, timeoutMs);
      job.waiters.push(waiter);
    });
  }

  async getJob(id: string): Promise<JobRecord | null> {
    const job = this.jobs.get(id);
    return job ? structuredClone(job.record) : null;
  }

  process(handler: JobHandler, concurrency: number): void {
    this.handler = handler;
    this.concurrency = Math.max(1, concurrency);
    this.pump();
  }

  async counts(): Promise<JobCounts> {
    const c: JobCounts = { waiting: 0, active: 0, delayed: 0, completed: 0, failed: 0 };
    for (const { record } of this.jobs.values()) {
      if (record.state in c) c[record.state as keyof JobCounts] += 1;
    }
    return c;
  }

  async list(states: readonly ListableState[], limit: number): Promise<JobRecord[]> {
    const wanted = new Set<string>(states);
    const out: JobRecord[] = [];
    // Map iteration is insertion order: walk it backwards for newest first.
    const all = [...this.jobs.values()];
    for (let i = all.length - 1; i >= 0 && out.length < limit; i -= 1) {
      const job = all[i]!;
      if (wanted.has(job.record.state)) out.push({ ...structuredClone(job.record), data: structuredClone(job.data) });
    }
    return out;
  }

  async retry(id: string): Promise<boolean> {
    const job = this.jobs.get(id);
    if (!job || job.record.state !== 'failed' || this.closed) return false;
    const i = this.finished.indexOf(id);
    if (i >= 0) this.finished.splice(i, 1);
    job.record.attemptsMade = 0;
    job.record.finishedAt = null;
    delete job.record.error;
    // Keep insertion order meaningful for list(): a retried job is "new" again.
    this.jobs.delete(id);
    this.jobs.set(id, job);
    this.enqueue(job);
    return true;
  }

  async cancel(id: string): Promise<boolean> {
    const job = this.jobs.get(id);
    if (!job || (job.record.state !== 'waiting' && job.record.state !== 'delayed')) return false;
    if (job.timer) clearTimeout(job.timer);
    job.timer = null;
    const i = this.waiting.indexOf(id);
    if (i >= 0) this.waiting.splice(i, 1);
    const e = Errors.cancelled();
    job.record.error = e.toJSON();
    for (const w of this.finish(job, 'failed')) w.reject(e);
    return true;
  }

  /** Stop taking work, let active jobs finish, drop timers. Unstarted jobs are lost (logged). */
  async close(): Promise<void> {
    this.closed = true;
    for (const job of this.jobs.values()) if (job.timer) clearTimeout(job.timer);
    if (this.active > 0) await new Promise<void>((resolve) => this.idle.push(resolve));
    const lost = this.pendingCount();
    if (lost > 0) this.logger.warn('Memory queue closed with unprocessed jobs', { component: 'queue', queue: this.name, lost });
  }

  // ─── internals ──────────────────────────────────────────────────────

  private pendingCount(): number {
    let n = 0;
    for (const { record } of this.jobs.values()) if (record.state === 'waiting' || record.state === 'delayed') n += 1;
    return n;
  }

  private enqueue(job: InternalJob): void {
    job.record.state = 'waiting';
    this.waiting.push(job.record.id);
    this.pump();
  }

  private delay(job: InternalJob, ms: number): void {
    job.record.state = 'delayed';
    job.timer = setTimeout(() => {
      job.timer = null;
      if (!this.closed) this.enqueue(job);
    }, ms);
  }

  private pump(): void {
    while (!this.closed && this.handler && this.active < this.concurrency && this.waiting.length > 0) {
      const id = this.waiting.shift()!;
      const job = this.jobs.get(id);
      if (job && job.record.state === 'waiting') void this.run(job, this.handler);
    }
  }

  private async run(job: InternalJob, handler: JobHandler): Promise<void> {
    this.active += 1;
    job.record.state = 'active';
    try {
      const result = await handler({
        id: job.record.id,
        name: job.record.name,
        data: job.data,
        attemptsMade: job.record.attemptsMade,
        attempts: job.attempts,
        updateProgress: async (p) => {
          job.record.progress = structuredClone(p);
        },
      });
      job.record.attemptsMade += 1;
      job.record.result = result;
      for (const w of this.finish(job, 'completed')) w.resolve(result);
    } catch (err) {
      job.record.attemptsMade += 1;
      const e = toAppError(err);
      job.record.error = e.toJSON();
      if (e.retryable && job.record.attemptsMade < job.attempts && !this.closed) {
        this.delay(job, e.retryAfterMs ?? job.backoffMs * 2 ** (job.record.attemptsMade - 1));
      } else {
        for (const w of this.finish(job, 'failed')) w.reject(e);
      }
    } finally {
      this.active -= 1;
      if (this.active === 0) this.idle.splice(0).forEach((r) => r());
      this.pump();
    }
  }

  /** Mark the job finished and hand back (and detach) whoever was waiting on it. */
  private finish(job: InternalJob, state: 'completed' | 'failed'): InternalJob['waiters'] {
    job.record.state = state;
    job.record.finishedAt = new Date().toISOString();
    const waiters = job.waiters;
    job.waiters = [];
    this.finished.push(job.record.id);
    this.prune();
    return waiters;
  }

  private prune(): void {
    const max = this.opts.retainFinished ?? 10_000;
    const maxAge = this.opts.retainFinishedMs ?? 24 * 60 * 60 * 1000;
    const cutoff = Date.now() - maxAge;
    while (this.finished.length > 0) {
      const oldest = this.jobs.get(this.finished[0]!);
      const tooOld = oldest?.record.finishedAt && Date.parse(oldest.record.finishedAt) < cutoff;
      if (this.finished.length <= max && !tooOld && oldest) break;
      this.jobs.delete(this.finished.shift()!);
    }
  }
}
