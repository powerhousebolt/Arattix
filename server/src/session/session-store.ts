import type { SessionSnapshot } from '../arattai/gateway';
import type { Cipher } from '../crypto';
import type { KeyValueStore } from '../kv';
import type { Logger } from '../logger';

/**
 * Persists the Arattai cookie jar encrypted at rest, so restarts do not require a new QR scan.
 * The ciphertext is bound to the session id: a blob copied to another session id will not decrypt.
 */
export class SessionStore {
  private readonly key: string;
  private readonly context: string;

  constructor(
    private readonly kv: KeyValueStore,
    private readonly cipher: Cipher,
    private readonly sessionId: string,
    private readonly logger: Logger,
  ) {
    this.key = `session:${sessionId}`;
    this.context = `arattai-session:${sessionId}`;
  }

  async save(snapshot: SessionSnapshot): Promise<void> {
    await this.kv.set(this.key, { enc: this.cipher.encrypt(JSON.stringify(snapshot), this.context) });
  }

  /**
   * Returns null when nothing is stored. An unreadable blob (wrong key, tampering) also returns
   * null but is left in place so an operator can restore MASTER_KEY instead of losing it.
   */
  async load(): Promise<SessionSnapshot | null> {
    const stored = await this.kv.get<{ enc: string }>(this.key);
    if (!stored?.enc) return null;
    try {
      const snapshot = JSON.parse(this.cipher.decrypt(stored.enc, this.context)) as SessionSnapshot;
      if (this.cipher.needsRotation(stored.enc)) {
        await this.save(snapshot);
        this.logger.info('Re-encrypted stored session with the current MASTER_KEY', { component: 'session-store' });
      }
      return snapshot;
    } catch (err) {
      this.logger.error('Stored session could not be decrypted; a new QR login is required', {
        component: 'session-store',
        error: (err as Error).message,
      });
      return null;
    }
  }

  async clear(): Promise<void> {
    await this.kv.del(this.key);
  }
}
