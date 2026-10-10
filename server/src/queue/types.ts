import type { WireError } from '../errors';

export type JobState = 'waiting' | 'delayed' | 'active' | 'completed' | 'failed' | 'unknown';

export interface JobOptions {
  /** Deterministic id: adding a job whose id already exists returns the existing job. */
  jobId?: string;
  attempts?: number;
  /** Base delay for exponential retry backoff. */
  backoffMs?: number;
  delayMs?: number;
}

export interface JobRecord {
  id: string;
  name: string;
  state: JobState;
  progress: unknown;
  result?: unknown;
  error?: WireError;
  attemptsMade: number;
  createdAt: string;
  finishedAt: string | null;
}

export interface JobContext<D = unknown> {
  id: string;
  name: string;
  data: D;
  /** Attempts already made before this one. */
  attemptsMade: number;
  /** Maximum attempts for this job. */
  attempts: number;
  updateProgress(progress: unknown): Promise<void>;
}

export type JobHandler = (job: JobContext<any>) => Promise<unknown>;

export type JobCounts = Record<'waiting' | 'active' | 'delayed' | 'completed' | 'failed', number>;

/**
 * Queue contract implemented in memory (single process) and on BullMQ (Redis).
 * Handlers signal "do not retry" by throwing an AppError with retryable=false.
 */
export interface JobQueue {
  readonly name: string;
  add(name: string, data: unknown, opts?: JobOptions): Promise<{ id: string; deduplicated: boolean }>;
  /** Resolves with the job's return value, rejects with its AppError, or JobWaitTimeoutError. */
  waitForResult(id: string, timeoutMs: number): Promise<unknown>;
  getJob(id: string): Promise<JobRecord | null>;
  process(handler: JobHandler, concurrency: number): void;
  counts(): Promise<JobCounts>;
  close(): Promise<void>;
}

export class JobWaitTimeoutError extends Error {
  constructor(readonly jobId: string) {
    super(`Job ${jobId} did not finish in time`);
    this.name = 'JobWaitTimeoutError';
  }
}
