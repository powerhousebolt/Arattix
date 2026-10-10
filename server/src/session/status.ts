import type { CircuitState } from '../circuit-breaker';
import type { KeyValueStore } from '../kv';
import type { Lease } from './lease';

export const CONNECTION_STATES = ['DISCONNECTED', 'CONNECTING', 'QR_READY', 'AUTHENTICATED', 'SYNCING', 'READY'] as const;
export type ConnectionState = (typeof CONNECTION_STATES)[number];

export interface QrStatus {
  /** QR payload string. A login credential: only ever returned to authenticated API callers. */
  data: string;
  /** PNG data URL of the same payload, for direct display. */
  dataUrl: string;
  issuedAt: string;
  /** When the whole QR login attempt gives up (QR_TIMEOUT_MS after it started). */
  expiresAt: string;
  refreshCount: number;
}

export interface ConnectionStatus {
  sessionId: string;
  state: ConnectionState;
  /** Machine-readable cause of the current state, e.g. SESSION_EXPIRED, QR_TIMEOUT, NO_SESSION. */
  reason: string | null;
  since: string;
  updatedAt: string;
  qr: QrStatus | null;
  lastError: { code: string; message: string; at: string } | null;
  reconnect: { attempt: number; nextRetryAt: string | null } | null;
  authenticatedAt: string | null;
  lastHeartbeatAt: string | null;
  circuit: CircuitState;
  /** False when no worker currently owns the session (split deployments only). */
  workerOnline: boolean;
}

export function statusKey(sessionId: string): string {
  return `status:${sessionId}`;
}

export interface StatusReader {
  read(): Promise<ConnectionStatus>;
}

export function initialStatus(sessionId: string, reason: string | null): ConnectionStatus {
  const now = new Date().toISOString();
  return {
    sessionId,
    state: 'DISCONNECTED',
    reason,
    since: now,
    updatedAt: now,
    qr: null,
    lastError: null,
    reconnect: null,
    authenticatedAt: null,
    lastHeartbeatAt: null,
    circuit: 'CLOSED',
    workerOnline: false,
  };
}

/** Reads the status the worker publishes; used by API processes that do not own the session. */
export class StoredStatusReader implements StatusReader {
  constructor(
    private readonly kv: KeyValueStore,
    private readonly sessionId: string,
    private readonly lease: Lease | null,
  ) {}

  async read(): Promise<ConnectionStatus> {
    const stored = await this.kv.get<ConnectionStatus>(statusKey(this.sessionId));
    const status = stored ?? initialStatus(this.sessionId, 'WORKER_NOT_STARTED');
    const workerOnline = this.lease ? (await this.lease.holder()) !== null : stored !== null;
    return { ...status, workerOnline };
  }
}
