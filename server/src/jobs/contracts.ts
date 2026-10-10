import type { GroupMemberAction } from '../arattai/gateway';

/**
 * Queues and the jobs they carry. API processes only produce jobs; the session-owning worker
 * consumes them, so it is the only process that ever talks to Arattai.
 *
 *  control    auth, reads, media download          (not throttled)
 *  outbound   sends, reactions, group changes      (throttled: SendThrottle)
 *  broadcast  long-running fan-out coordinators    (enqueue outbound jobs chunk by chunk)
 *  webhooks   signed deliveries to subscribers     (retried with backoff)
 */
export const QUEUE_KINDS = ['control', 'outbound', 'broadcast', 'webhooks'] as const;
export type QueueKind = (typeof QUEUE_KINDS)[number];

/** Public job ids carry their queue: `out_<id>`, so GET /jobs/:id knows where to look. */
export const JOB_ID_PREFIX: Record<QueueKind, string> = {
  control: 'ctl',
  outbound: 'out',
  broadcast: 'bc',
  webhooks: 'dlv',
};

export function toPublicJobId(kind: QueueKind, rawId: string): string {
  return `${JOB_ID_PREFIX[kind]}_${rawId}`;
}

export function parsePublicJobId(publicId: string): { kind: QueueKind; rawId: string } | null {
  const i = publicId.indexOf('_');
  if (i <= 0) return null;
  const prefix = publicId.slice(0, i);
  const kind = QUEUE_KINDS.find((k) => JOB_ID_PREFIX[k] === prefix);
  const rawId = publicId.slice(i + 1);
  return kind && rawId ? { kind, rawId } : null;
}

// ─── control ──────────────────────────────────────────────────────────
export interface AuthStartJob {
  force: boolean;
}
export interface ChatsListJob {
  limit: number;
}
export interface MessagesListJob {
  chatId: string;
  limit: number;
}
export interface MediaDownloadJob {
  fileId: string;
  chatId: string;
  thumbnail: boolean;
}
export interface MediaDownloadResult {
  spoolPath: string;
  contentType: string;
  fileName: string | null;
  size: number;
}

// ─── outbound ─────────────────────────────────────────────────────────
interface Expiring {
  /** Epoch ms after which the job is dropped instead of sent (stale sends are worse than none). */
  expiresAt: number;
}
export interface SendTextJob extends Expiring {
  chatId: string;
  text: string;
  displayName?: string;
  broadcastId?: string;
}
export interface SendMediaJob extends Expiring {
  chatId: string;
  spoolPath: string;
  fileName: string;
  mimeType: string;
  size: number;
  caption?: string;
}
export interface ReactionJob extends Expiring {
  chatId: string;
  messageId: string;
  emoji: string;
}
export interface GroupCreateJob extends Expiring {
  name: string;
  participants: string[];
  description?: string;
}
export interface GroupMembersJob extends Expiring {
  groupId: string;
  action: GroupMemberAction;
  userIds: string[];
}

// ─── broadcast ────────────────────────────────────────────────────────
export interface BroadcastJob {
  recipients: string[];
  text: string;
  displayName?: string;
  chunkSize: number;
  chunkDelayMs: number;
}

export type RecipientStatus = 'sent' | 'failed' | 'aborted' | 'unknown';

export interface BroadcastProgress {
  total: number;
  sent: number;
  failed: number;
  aborted: number;
  unknown: number;
  chunksDone: number;
  chunks: number;
}

export interface BroadcastResult extends BroadcastProgress {
  results: Array<{ chatId: string; status: RecipientStatus; jobId?: string; error?: { code: string; message: string } }>;
}
