import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ArattaiGateway } from '../arattai/gateway';
import { sha256Hex } from '../crypto';
import { AppError, Errors, toAppError } from '../errors';
import type { EventBus } from '../events/bus';
import type { Logger } from '../logger';
import type { MediaSpool } from '../media/spool';
import type { Metrics } from '../metrics';
import type { SendThrottle } from '../outbound/throttle';
import { JobWaitTimeoutError, type JobContext, type JobQueue } from '../queue/types';
import type { ConnectionManager } from '../session/connection-manager';
import { chunk, safeId, sleep } from '../util';
import type { WebhookDispatcher } from '../webhooks/dispatcher';
import {
  toPublicJobId,
  type AuthStartJob,
  type BroadcastJob,
  type BroadcastProgress,
  type BroadcastResult,
  type ChatsListJob,
  type GroupCreateJob,
  type GroupMembersJob,
  type MediaDownloadJob,
  type MediaDownloadResult,
  type MessagesListJob,
  type QueueKind,
  type ReactionJob,
  type SendMediaJob,
  type SendTextJob,
} from './contracts';

export interface WorkerDeps {
  queues: Record<QueueKind, JobQueue>;
  connection: ConnectionManager;
  gateway: ArattaiGateway;
  throttle: SendThrottle;
  spool: MediaSpool;
  bus: EventBus;
  dispatcher: WebhookDispatcher;
  metrics: Metrics;
  logger: Logger;
  outboundAttempts: number;
  outboundBackoffMs: number;
  messageTtlMs: number;
}

/** States the session passes through on its own (reconnect); outbound jobs wait these out. */
const TRANSIENT_STATES = new Set(['CONNECTING', 'AUTHENTICATED', 'SYNCING']);

/** Start consuming every queue. Called only by the process that owns the session. */
export function startWorkerHandlers(deps: WorkerDeps): void {
  deps.queues.control.process((job) => handleControl(deps, job), 4);
  // Concurrency 1: sends are paced by the throttle anyway, and ordering per chat is preserved.
  deps.queues.outbound.process((job) => handleOutbound(deps, job), 1);
  deps.queues.broadcast.process((job) => handleBroadcast(deps, job as JobContext<BroadcastJob>), 2);
  deps.queues.webhooks.process((job) => deps.dispatcher.deliver(job as never), 10);
}

// ─── control ──────────────────────────────────────────────────────────

async function handleControl(deps: WorkerDeps, job: JobContext): Promise<unknown> {
  const { connection, gateway } = deps;
  switch (job.name) {
    case 'auth.start':
      return connection.startQrLogin((job.data as AuthStartJob).force);
    case 'auth.logout':
      return connection.logout();
    case 'chats.list':
      connection.assertReady();
      return gateway.listChats((job.data as ChatsListJob).limit);
    case 'messages.list': {
      connection.assertReady();
      const d = job.data as MessagesListJob;
      return (await gateway.fetchMessages(d.chatId, d.limit)).map(({ raw: _raw, ...m }) => m);
    }
    case 'media.download': {
      connection.assertReady();
      const d = job.data as MediaDownloadJob;
      const media = await gateway.downloadMedia(d.fileId, d.chatId, d.thumbnail);
      const spoolPath = path.join(deps.spool.dir, `dl-${crypto.randomUUID()}`);
      await fs.promises.writeFile(spoolPath, media.data, { mode: 0o600 });
      return {
        spoolPath,
        contentType: media.contentType,
        fileName: media.fileName,
        size: media.data.length,
      } satisfies MediaDownloadResult;
    }
    default:
      throw new AppError({ status: 400, code: 'UNKNOWN_JOB', message: `Unknown control job ${job.name}` });
  }
}

// ─── outbound ─────────────────────────────────────────────────────────

async function handleOutbound(deps: WorkerDeps, job: JobContext): Promise<unknown> {
  const { connection, gateway, throttle, spool, bus, metrics } = deps;
  const data = job.data as { expiresAt: number; chatId?: string };
  const isMedia = job.name === 'message.media';
  const media = isMedia ? (job.data as SendMediaJob) : null;
  const publicId = toPublicJobId('outbound', job.id);
  let finalAttempt = true;

  try {
    if (Date.now() > data.expiresAt) throw Errors.jobExpired();
    if (!connection.isReady()) {
      const { state, reason } = connection.getStatus();
      // A reconnect in progress usually finishes within seconds: let the queue retry.
      if (TRANSIENT_STATES.has(state)) {
        throw new AppError({ ...Errors.sessionNotReady(state, reason).toJSON(), retryable: true, retryAfterMs: 10_000 });
      }
      throw Errors.sessionNotReady(state, reason);
    }

    await throttle.acquire(data.chatId ?? '*');
    let upstream: unknown;
    switch (job.name) {
      case 'message.text': {
        const d = job.data as SendTextJob;
        upstream = await gateway.sendText(d.chatId, d.text, d.displayName);
        break;
      }
      case 'message.media':
        upstream = await gateway.sendMedia({ ...media!, filePath: spool.resolve(media!.spoolPath) });
        break;
      case 'message.reaction': {
        const d = job.data as ReactionJob;
        upstream = await gateway.react(d.chatId, d.messageId, d.emoji);
        break;
      }
      case 'groups.create': {
        const d = job.data as GroupCreateJob;
        upstream = await gateway.createGroup(d.name, d.participants, d.description);
        break;
      }
      case 'groups.members': {
        const d = job.data as GroupMembersJob;
        upstream = await gateway.updateGroupMembers(d.groupId, d.action, d.userIds);
        break;
      }
      default:
        throw new AppError({ status: 400, code: 'UNKNOWN_JOB', message: `Unknown outbound job ${job.name}` });
    }

    metrics.inc('arattai_outbound_total', 'Outbound operations by job and result.', { job: job.name, result: 'ok' });
    if (job.name.startsWith('message.')) {
      bus.publish('message.sent', { jobId: publicId, kind: job.name.slice('message.'.length), chatId: data.chatId, upstream });
    }
    return { chatId: data.chatId ?? null, upstream };
  } catch (err) {
    const e = toAppError(err);
    finalAttempt = !e.retryable || job.attemptsMade + 1 >= job.attempts;
    metrics.inc('arattai_outbound_total', 'Outbound operations by job and result.', { job: job.name, result: e.code });
    if (e.code === 'SESSION_EXPIRED') connection.reportAuthFailure(`outbound:${job.name}`);
    if (finalAttempt && job.name.startsWith('message.')) {
      bus.publish('message.failed', {
        jobId: publicId,
        kind: job.name.slice('message.'.length),
        chatId: data.chatId,
        error: { code: e.code, message: e.message },
      });
    }
    throw e;
  } finally {
    // Keep the spooled file while a retry is still coming.
    if (media && finalAttempt) await spool.remove(path.join(spool.dir, path.basename(media.spoolPath)));
  }
}

// ─── broadcast ────────────────────────────────────────────────────────

/**
 * Deterministic outbound job id for one broadcast recipient. Ids that are already safe stay
 * readable; others are hashed, because safeId() maps "a.b" and "a_b" to the same id and the
 * second recipient would silently be deduplicated into the first one's job.
 */
export function broadcastChildId(broadcastJobId: string, chatId: string): string {
  const readable = `${broadcastJobId}-${chatId}`;
  return safeId(readable) === readable ? readable : `${safeId(broadcastJobId).slice(0, 80)}-h${sha256Hex(chatId).slice(0, 40)}`;
}

async function handleBroadcast(deps: WorkerDeps, job: JobContext<BroadcastJob>): Promise<BroadcastResult> {
  const { recipients, text, displayName, chunkSize, chunkDelayMs } = job.data;
  const chunks = chunk(recipients, chunkSize);
  const results = new Map<string, BroadcastResult['results'][number]>();
  let chunksDone = 0;
  const progress = (): BroadcastProgress => {
    const counts = { sent: 0, failed: 0, aborted: 0, unknown: 0 };
    for (const r of results.values()) counts[r.status] += 1;
    return { total: recipients.length, ...counts, chunksDone, chunks: chunks.length };
  };
  const log = deps.logger.child({ component: 'broadcast', broadcastId: job.id });

  for (const [index, group] of chunks.entries()) {
    if (index > 0) await sleep(chunkDelayMs);
    if (!deps.connection.isReady()) {
      const { state } = deps.connection.getStatus();
      log.warn('Session not ready; aborting the rest of the broadcast', { state, remaining: recipients.length - results.size });
      for (const chatId of recipients) {
        if (!results.has(chatId)) {
          results.set(chatId, { chatId, status: 'aborted', error: { code: 'SESSION_NOT_READY', message: `Session is ${state}` } });
        }
      }
      break;
    }

    // Deterministic child ids: if this broadcast job is retried after a crash, recipients
    // already handled map to their existing jobs instead of being messaged twice.
    const children = await Promise.all(
      group.map(async (chatId) => {
        const { id } = await deps.queues.outbound.add(
          'message.text',
          { chatId, text, displayName, broadcastId: job.id, expiresAt: Date.now() + deps.messageTtlMs } satisfies SendTextJob,
          { jobId: broadcastChildId(job.id, chatId), attempts: deps.outboundAttempts, backoffMs: deps.outboundBackoffMs },
        );
        return { chatId, id };
      }),
    );

    // Throttled sends take a while; allow a generous minute per message in the chunk.
    const waitMs = Math.max(5 * 60_000, group.length * 60_000);
    await Promise.all(
      children.map(async ({ chatId, id }) => {
        const jobId = toPublicJobId('outbound', id);
        try {
          await deps.queues.outbound.waitForResult(id, waitMs);
          results.set(chatId, { chatId, status: 'sent', jobId });
        } catch (err) {
          if (err instanceof JobWaitTimeoutError) {
            results.set(chatId, { chatId, status: 'unknown', jobId, error: { code: 'WAIT_TIMEOUT', message: err.message } });
          } else {
            const e = toAppError(err);
            results.set(chatId, { chatId, status: 'failed', jobId, error: { code: e.code, message: e.message } });
          }
        }
      }),
    );
    chunksDone = index + 1;
    await job.updateProgress(progress());
  }

  const summary: BroadcastResult = { ...progress(), results: recipients.map((chatId) => results.get(chatId)!).filter(Boolean) };
  deps.bus.publish('broadcast.completed', { broadcastId: toPublicJobId('broadcast', job.id), ...progress() });
  log.info('Broadcast finished', progress());
  return summary;
}
