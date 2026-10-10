import { EventEmitter } from 'node:events';
import QRCode from 'qrcode';
import type { ArattaiGateway, QrChallenge } from '../arattai/gateway';
import type { CircuitBreaker } from '../circuit-breaker';
import { sha256Hex } from '../crypto';
import { AppError, Errors, toAppError } from '../errors';
import type { EventBus } from '../events/bus';
import type { KeyValueStore } from '../kv';
import type { Logger } from '../logger';
import type { Metrics } from '../metrics';
import { AbortedError, backoffDelay, sleep, TimeoutError, withTimeout } from '../util';
import type { SessionStore } from './session-store';
import {
  CONNECTION_STATES,
  initialStatus,
  statusKey,
  type ConnectionState,
  type ConnectionStatus,
  type QrStatus,
  type StatusReader,
} from './status';

export interface ConnectionTimings {
  heartbeatIntervalMs: number;
  heartbeatTimeoutMs: number;
  heartbeatFailureThreshold: number;
  reconnectBaseMs: number;
  reconnectMaxMs: number;
  qrTimeoutMs: number;
  qrPollIntervalMs: number;
  /** How long POST /auth/session waits for the QR code before answering. */
  qrStartWaitMs?: number;
}

export interface ConnectionManagerDeps {
  sessionId: string;
  gateway: ArattaiGateway;
  sessionStore: SessionStore;
  kv: KeyValueStore;
  bus: EventBus;
  breaker: CircuitBreaker;
  logger: Logger;
  metrics: Metrics;
  timings: ConnectionTimings;
}

interface StateUpdate {
  reason?: string | null;
  error?: AppError;
  qr?: QrStatus;
  reconnect?: ConnectionStatus['reconnect'];
}

type Flow = 'restore' | 'qr' | null;

const isSessionGone = (e: AppError) => e.code === 'SESSION_EXPIRED' || e.code === 'SESSION_CORRUPT';

/**
 * Owns the Arattai session for one account and drives it through
 *   DISCONNECTED → CONNECTING → (QR_READY →) AUTHENTICATED → SYNCING → READY.
 *
 * Every long-running flow (restore, QR login, reconnect) runs under a generation number.
 * Starting a new flow aborts the previous one, and a flow whose generation is stale stops
 * touching state after its next await. That is what makes "force a new QR while a reconnect
 * is sleeping" or "logout during QR polling" safe.
 */
export class ConnectionManager implements StatusReader {
  private status: ConnectionStatus;
  private generation = 0;
  private controller = new AbortController();
  private flow: Flow = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private heartbeatRunning = false;
  private heartbeatFailures = 0;
  private lastForcedCheck = 0;
  private lastCookieHash: string | null = null;
  private stopped = false;
  private readonly syncHooks: Array<() => Promise<void>> = [];
  private readonly emitter = new EventEmitter();
  private readonly log: Logger;

  constructor(private readonly deps: ConnectionManagerDeps) {
    this.status = { ...initialStatus(deps.sessionId, 'NOT_STARTED'), workerOnline: true };
    this.log = deps.logger.child({ component: 'connection' });
    this.emitter.setMaxListeners(50);
  }

  // ─── public API ─────────────────────────────────────────────────────

  /** Restore the stored session in the background. Resolves immediately. */
  start(): void {
    const { gen, signal } = this.newGeneration('restore');
    this.launch(gen, () => this.connectFromStore(gen, signal));
  }

  getStatus(): ConnectionStatus {
    return { ...this.status, circuit: this.deps.breaker.getState(), workerOnline: !this.stopped };
  }

  async read(): Promise<ConnectionStatus> {
    return this.getStatus();
  }

  isReady(): boolean {
    return this.status.state === 'READY';
  }

  assertReady(): void {
    if (!this.isReady()) throw Errors.sessionNotReady(this.status.state, this.status.reason);
  }

  onStateChange(listener: (status: ConnectionStatus, previous: ConnectionState) => void): () => void {
    this.emitter.on('state', listener);
    return () => this.emitter.off('state', listener);
  }

  /** Work to run while SYNCING (e.g. priming inbound cursors). Failures are logged, not fatal. */
  addSyncHook(hook: () => Promise<void>): void {
    this.syncHooks.push(hook);
  }

  /**
   * Begin a QR login and wait (bounded) until the QR code is available.
   * Idempotent unless `force`: an in-flight login or a READY session is returned as is.
   */
  async startQrLogin(force = false): Promise<ConnectionStatus> {
    if (this.stopped) throw Errors.shuttingDown();
    const state = this.status.state;
    if (!force && state === 'READY') return this.getStatus();
    if (!force && this.flow !== null && state !== 'DISCONNECTED') {
      // A concurrent caller joins the login in progress and gets the same QR once it exists.
      if (this.flow === 'qr' && state === 'CONNECTING') {
        await this.waitForState((s) => s !== 'CONNECTING', this.deps.timings.qrStartWaitMs ?? 20_000);
      }
      return this.getStatus();
    }

    const { gen, signal } = this.newGeneration('qr');
    const settled = this.waitForState((s) => s !== 'CONNECTING', this.deps.timings.qrStartWaitMs ?? 20_000);
    this.launch(gen, () => this.runQrLogin(gen, signal));
    await settled;
    return this.getStatus();
  }

  /**
   * Forget the session locally and delete it from storage.
   * Arattai has no logout endpoint in the library, so the server-side session stays valid
   * until it expires; revoke it from the Arattai app for a hard logout.
   */
  async logout(): Promise<ConnectionStatus> {
    this.newGeneration(null);
    this.deps.gateway.reset();
    this.lastCookieHash = null;
    await this.deps.sessionStore.clear();
    this.setState('DISCONNECTED', { reason: 'LOGGED_OUT' });
    return this.getStatus();
  }

  /**
   * A job or the poller saw an auth failure. Verify with an immediate heartbeat rather than
   * dropping the session on one odd response.
   */
  reportAuthFailure(source: string): void {
    if (this.status.state !== 'READY') return;
    const now = Date.now();
    if (now - this.lastForcedCheck < 5_000) return;
    this.lastForcedCheck = now;
    this.log.warn('Auth failure reported; verifying session now', { source });
    this.scheduleHeartbeat(this.generation, 0);
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    const wasReady = this.status.state === 'READY';
    this.newGeneration(null);
    if (wasReady) await this.persistSession(true);
    this.setState('DISCONNECTED', { reason: 'SHUTDOWN' });
    this.stopped = true;
    await this.publishStatus();
  }

  // ─── flows ──────────────────────────────────────────────────────────

  private async connectFromStore(gen: number, signal: AbortSignal): Promise<void> {
    let attempt = 0;
    while (this.isCurrent(gen)) {
      this.setState('CONNECTING', {
        reason: attempt === 0 ? 'RESTORING' : 'RECONNECTING',
        reconnect: { attempt, nextRetryAt: null },
      });
      try {
        // Inside the try: a storage blip (Redis failover, disk hiccup) is retried like a network error.
        const snapshot = await this.deps.sessionStore.load();
        if (!this.isCurrent(gen)) return;
        if (!snapshot) {
          this.setState('DISCONNECTED', { reason: 'NO_SESSION' });
          this.flow = null;
          return;
        }
        await this.deps.gateway.restore(snapshot);
        await this.deps.gateway.validate();
        if (!this.isCurrent(gen)) return;
        this.lastCookieHash = null;
        await this.goReady(gen, attempt === 0 ? 'RESTORED' : 'RECONNECTED');
        return;
      } catch (err) {
        if (err instanceof AbortedError) throw err;
        if (!this.isCurrent(gen)) return;
        const e = toAppError(err);
        if (isSessionGone(e)) {
          this.deps.gateway.reset();
          this.setState('DISCONNECTED', { reason: e.code, error: e });
          this.flow = null;
          return;
        }
        // Network trouble, 5xx, open circuit, contract drift: keep trying with backoff.
        const delay = Math.min(
          this.deps.timings.reconnectMaxMs,
          e.retryAfterMs ?? backoffDelay(attempt, this.deps.timings.reconnectBaseMs, this.deps.timings.reconnectMaxMs),
        );
        attempt += 1;
        this.log.warn('Session restore failed; retrying', { attempt, delayMs: delay, code: e.code });
        this.setState('CONNECTING', {
          reason: 'RETRY_BACKOFF',
          error: e,
          reconnect: { attempt, nextRetryAt: new Date(Date.now() + delay).toISOString() },
        });
        await sleep(delay, signal);
      }
    }
  }

  private async runQrLogin(gen: number, signal: AbortSignal): Promise<void> {
    const t = this.deps.timings;
    this.setState('CONNECTING', { reason: 'QR_REQUESTED' });

    let challenge: QrChallenge | null = null;
    for (let attempt = 0; attempt < 3 && !challenge; attempt++) {
      try {
        challenge = await this.deps.gateway.startQr();
      } catch (err) {
        if (err instanceof AbortedError) throw err;
        if (!this.isCurrent(gen)) return;
        const e = toAppError(err);
        if (attempt === 2) {
          this.deps.gateway.reset();
          this.setState('DISCONNECTED', { reason: 'QR_INIT_FAILED', error: e });
          this.flow = null;
          return;
        }
        await sleep(backoffDelay(attempt, t.reconnectBaseMs, t.reconnectMaxMs), signal);
      }
    }
    if (!challenge || !this.isCurrent(gen)) return;

    const deadline = Date.now() + t.qrTimeoutMs;
    let refreshCount = 0;
    await this.showQr(gen, challenge, deadline, refreshCount);

    let consecutiveErrors = 0;
    while (this.isCurrent(gen)) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        this.deps.gateway.reset();
        this.setState('DISCONNECTED', { reason: 'QR_TIMEOUT' });
        this.flow = null;
        return;
      }
      await sleep(Math.min(t.qrPollIntervalMs, remaining), signal);
      if (Date.now() >= deadline) continue;

      let result;
      try {
        result = await this.deps.gateway.pollQr();
        consecutiveErrors = 0;
      } catch (err) {
        if (err instanceof AbortedError) throw err;
        if (!this.isCurrent(gen)) return;
        consecutiveErrors += 1;
        const e = toAppError(err);
        this.log.warn('QR status poll failed', { consecutiveErrors, code: e.code });
        if (consecutiveErrors >= 5) {
          this.deps.gateway.reset();
          this.setState('DISCONNECTED', { reason: 'QR_POLL_FAILED', error: e });
          this.flow = null;
          return;
        }
        continue;
      }
      if (!this.isCurrent(gen)) return;

      if (result.status === 'refreshed' && result.challenge) {
        refreshCount += 1;
        await this.showQr(gen, result.challenge, deadline, refreshCount);
      } else if (result.status === 'authenticated') {
        this.setState('AUTHENTICATED', { reason: 'QR_APPROVED' });
        try {
          await this.deps.gateway.completeLogin();
        } catch (err) {
          if (!this.isCurrent(gen)) return;
          this.deps.gateway.reset();
          this.setState('DISCONNECTED', { reason: 'LOGIN_FINALIZE_FAILED', error: toAppError(err) });
          this.flow = null;
          return;
        }
        if (!this.isCurrent(gen)) return;
        this.lastCookieHash = null;
        await this.goReady(gen, 'QR_APPROVED');
        return;
      }
    }
  }

  private async showQr(gen: number, challenge: QrChallenge, deadline: number, refreshCount: number): Promise<void> {
    const dataUrl = await QRCode.toDataURL(challenge.data, { errorCorrectionLevel: 'M', margin: 1, width: 320 });
    if (!this.isCurrent(gen)) return;
    const qr: QrStatus = {
      data: challenge.data,
      dataUrl,
      issuedAt: challenge.issuedAt,
      expiresAt: new Date(deadline).toISOString(),
      refreshCount,
    };
    this.setState('QR_READY', { reason: refreshCount === 0 ? 'QR_ISSUED' : 'QR_REFRESHED', qr });
    this.deps.bus.publish('session.qr', { data: qr.data, issuedAt: qr.issuedAt, expiresAt: qr.expiresAt, refreshCount });
  }

  private async goReady(gen: number, reason: string): Promise<void> {
    this.setState('AUTHENTICATED', { reason });
    await this.persistSession(true);
    if (!this.isCurrent(gen)) return;

    this.setState('SYNCING', { reason });
    for (const hook of this.syncHooks) {
      try {
        await hook();
      } catch (err) {
        this.log.warn('Sync hook failed; continuing to READY', { code: toAppError(err).code });
      }
      if (!this.isCurrent(gen)) return;
    }

    this.heartbeatFailures = 0;
    this.status.authenticatedAt = this.safeSnapshotTime();
    this.setState('READY', { reason });
    this.flow = null;
    this.scheduleHeartbeat(gen, this.deps.timings.heartbeatIntervalMs);
  }

  // ─── heartbeat ──────────────────────────────────────────────────────

  private scheduleHeartbeat(gen: number, delayMs: number): void {
    if (this.heartbeatTimer) clearTimeout(this.heartbeatTimer);
    this.heartbeatTimer = setTimeout(() => void this.heartbeat(gen), delayMs);
    this.heartbeatTimer.unref();
  }

  private async heartbeat(gen: number): Promise<void> {
    if (!this.isCurrent(gen) || this.status.state !== 'READY' || this.heartbeatRunning) return;
    this.heartbeatRunning = true;
    const t = this.deps.timings;
    try {
      await withTimeout(this.deps.gateway.validate(), t.heartbeatTimeoutMs, 'heartbeat');
      if (!this.isCurrent(gen)) return;
      this.heartbeatFailures = 0;
      this.status.lastHeartbeatAt = new Date().toISOString();
      this.deps.metrics.inc('arattai_heartbeats_total', 'Heartbeat probes by result.', { result: 'ok' });
      await this.persistSession(false); // Arattai may have rotated cookies
      await this.publishStatus();
    } catch (err) {
      if (!this.isCurrent(gen)) return;
      const e =
        err instanceof TimeoutError
          ? new AppError({ status: 504, code: 'HEARTBEAT_TIMEOUT', message: err.message, retryable: true })
          : toAppError(err);
      this.deps.metrics.inc('arattai_heartbeats_total', 'Heartbeat probes by result.', { result: e.code });

      if (isSessionGone(e)) {
        this.log.error('Session expired; a new QR login is required', { code: e.code });
        this.newGeneration(null);
        this.deps.gateway.reset();
        this.setState('DISCONNECTED', { reason: 'SESSION_EXPIRED', error: e });
        return;
      }

      this.heartbeatFailures += 1;
      this.status.lastError = { code: e.code, message: e.message, at: new Date().toISOString() };
      this.log.warn('Heartbeat failed', { failures: this.heartbeatFailures, code: e.code });
      if (this.heartbeatFailures >= t.heartbeatFailureThreshold) {
        this.log.warn('Heartbeat failure threshold reached; reconnecting');
        const next = this.newGeneration('restore');
        this.launch(next.gen, () => this.connectFromStore(next.gen, next.signal));
      } else {
        await this.publishStatus();
      }
    } finally {
      this.heartbeatRunning = false;
      if (this.isCurrent(gen) && this.status.state === 'READY') {
        this.scheduleHeartbeat(gen, t.heartbeatIntervalMs);
      }
    }
  }

  // ─── plumbing ───────────────────────────────────────────────────────

  private newGeneration(flow: Flow): { gen: number; signal: AbortSignal } {
    this.controller.abort();
    this.controller = new AbortController();
    this.generation += 1;
    this.flow = flow;
    if (this.heartbeatTimer) clearTimeout(this.heartbeatTimer);
    this.heartbeatTimer = null;
    return { gen: this.generation, signal: this.controller.signal };
  }

  private isCurrent(gen: number): boolean {
    return gen === this.generation && !this.stopped;
  }

  /** Run a flow in the background; a crash in it must leave the manager in a sane state. */
  private launch(gen: number, flow: () => Promise<void>): void {
    flow().catch((err) => {
      if (err instanceof AbortedError || !this.isCurrent(gen)) return;
      const e = toAppError(err);
      this.log.error('Connection flow crashed', { code: e.code, err });
      this.deps.gateway.reset();
      this.flow = null;
      this.setState('DISCONNECTED', { reason: 'INTERNAL_ERROR', error: e });
    });
  }

  private setState(state: ConnectionState, update: StateUpdate = {}): void {
    const previous = this.status.state;
    const now = new Date().toISOString();
    this.status = {
      ...this.status,
      state,
      reason: update.reason !== undefined ? update.reason : state === previous ? this.status.reason : null,
      since: state === previous ? this.status.since : now,
      updatedAt: now,
      qr: state === 'QR_READY' ? (update.qr ?? this.status.qr) : null,
      lastError: update.error
        ? { code: update.error.code, message: update.error.message, at: now }
        : this.status.lastError,
      reconnect: state === 'CONNECTING' ? (update.reconnect ?? null) : null,
      authenticatedAt: state === 'DISCONNECTED' ? null : this.status.authenticatedAt,
    };

    for (const s of CONNECTION_STATES) {
      this.deps.metrics.set('arattai_session_state', 'Current session state (1 = active state).', s === state ? 1 : 0, {
        state: s,
      });
    }
    void this.publishStatus();

    if (state !== previous) {
      this.log.info(`Session ${previous} → ${state}`, { reason: this.status.reason });
      this.deps.bus.publish('session.state_changed', {
        from: previous,
        to: state,
        reason: this.status.reason,
        error: this.status.lastError && update.error ? this.status.lastError : null,
      });
    }
    this.emitter.emit('state', this.getStatus(), previous);
  }

  private async publishStatus(): Promise<void> {
    try {
      await this.deps.kv.set(statusKey(this.deps.sessionId), this.getStatus());
    } catch (err) {
      this.log.error('Failed to publish session status', { error: (err as Error).message });
    }
  }

  private async persistSession(force: boolean): Promise<void> {
    try {
      const snapshot = this.deps.gateway.snapshot();
      const hash = sha256Hex(JSON.stringify(snapshot.cookies));
      if (!force && hash === this.lastCookieHash) return;
      await this.deps.sessionStore.save(snapshot);
      this.lastCookieHash = hash;
    } catch (err) {
      this.log.error('Failed to persist session', { error: (err as Error).message });
    }
  }

  private safeSnapshotTime(): string | null {
    try {
      return this.deps.gateway.snapshot().authenticatedAt;
    } catch {
      return null;
    }
  }

  private waitForState(predicate: (s: ConnectionState) => boolean, timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(done, timeoutMs);
      const off = this.onStateChange((status) => {
        if (predicate(status.state)) done();
      });
      function done() {
        clearTimeout(timer);
        off();
        resolve();
      }
    });
  }
}
