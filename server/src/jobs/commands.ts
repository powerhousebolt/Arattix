import { sha256Hex } from '../crypto';
import { Errors } from '../errors';
import { JobWaitTimeoutError, type JobOptions, type JobQueue, type JobRecord } from '../queue/types';
import { parsePublicJobId, toPublicJobId, type QueueKind } from './contracts';

export type CommandOutcome =
  | { jobId: string; status: 'completed'; result: unknown; deduplicated: boolean }
  | { jobId: string; status: 'accepted'; deduplicated: boolean };

export interface SubmitOptions extends Omit<JobOptions, 'jobId'> {
  /** Wait up to the sync timeout for the result; otherwise answer "accepted" right away. */
  wait: boolean;
  /** Client-supplied Idempotency-Key: the same key always maps to the same job. */
  idempotencyKey?: string;
  /** Fixed raw job id (used by broadcasts for per-recipient dedupe). */
  jobId?: string;
}

/** API-side entry point: turns HTTP requests into queued jobs and (optionally) waits for them. */
export class CommandBus {
  constructor(
    private readonly queues: Record<QueueKind, JobQueue>,
    private readonly syncWaitMs: number,
  ) {}

  queue(kind: QueueKind): JobQueue {
    return this.queues[kind];
  }

  async submit(kind: QueueKind, name: string, data: unknown, opts: SubmitOptions): Promise<CommandOutcome> {
    const { wait, idempotencyKey, jobId, ...jobOpts } = opts;
    const rawId = jobId ?? (idempotencyKey ? `idem-${sha256Hex(`${kind}\n${name}\n${idempotencyKey}`).slice(0, 40)}` : undefined);
    const queue = this.queues[kind];
    const added = await queue.add(name, data, { ...jobOpts, ...(rawId ? { jobId: rawId } : {}) });
    const publicId = toPublicJobId(kind, added.id);
    if (!wait) return { jobId: publicId, status: 'accepted', deduplicated: added.deduplicated };
    try {
      const result = await queue.waitForResult(added.id, this.syncWaitMs);
      return { jobId: publicId, status: 'completed', result, deduplicated: added.deduplicated };
    } catch (err) {
      if (err instanceof JobWaitTimeoutError) return { jobId: publicId, status: 'accepted', deduplicated: added.deduplicated };
      throw err;
    }
  }

  async getJob(publicId: string): Promise<(JobRecord & { queue: QueueKind }) | null> {
    const parsed = parsePublicJobId(publicId);
    if (!parsed) throw Errors.notFound('Job');
    const record = await this.queues[parsed.kind].getJob(parsed.rawId);
    return record ? { ...record, id: publicId, queue: parsed.kind } : null;
  }
}
