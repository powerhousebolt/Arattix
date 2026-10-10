import crypto from 'node:crypto';

/**
 * AES-256-GCM envelope encryption for data at rest (session cookies, webhook secrets).
 *
 * Ciphertext format: `v1.<keyId>.<base64(iv | tag | ciphertext)>`. The key id lets a rotation
 * decrypt with MASTER_KEY_PREVIOUS while every new write uses the current key. The `context`
 * string is bound as associated data, so a ciphertext copied into another slot fails to decrypt.
 */
export class Cipher {
  private readonly current: { id: string; key: Buffer };
  private readonly keys = new Map<string, Buffer>();

  constructor(masterKey: string, previousMasterKey?: string) {
    const key = deriveEncryptionKey(parseMasterKey(masterKey));
    this.current = { id: keyId(key), key };
    this.keys.set(this.current.id, key);
    if (previousMasterKey) {
      const prev = deriveEncryptionKey(parseMasterKey(previousMasterKey));
      this.keys.set(keyId(prev), prev);
    }
  }

  encrypt(plaintext: string, context: string): string {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.current.key, iv);
    cipher.setAAD(Buffer.from(context, 'utf8'));
    const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `v1.${this.current.id}.${Buffer.concat([iv, tag, body]).toString('base64')}`;
  }

  decrypt(payload: string, context: string): string {
    const [version, id, data] = payload.split('.');
    if (version !== 'v1' || !id || !data) throw new Error('Unrecognised ciphertext format');
    const key = this.keys.get(id);
    if (!key) throw new Error('Ciphertext was encrypted with an unknown key (MASTER_KEY changed?)');
    const raw = Buffer.from(data, 'base64');
    if (raw.length < 28) throw new Error('Ciphertext is truncated');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
    decipher.setAAD(Buffer.from(context, 'utf8'));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
  }

  /** True when the ciphertext was produced with a key other than the current one. */
  needsRotation(payload: string): boolean {
    return payload.split('.')[1] !== this.current.id;
  }
}

export function parseMasterKey(value: string): Buffer {
  const trimmed = value.trim();
  const key = /^[0-9a-fA-F]{64}$/.test(trimmed) ? Buffer.from(trimmed, 'hex') : Buffer.from(trimmed, 'base64');
  if (key.length !== 32) {
    throw new Error('MASTER_KEY must be 32 bytes, encoded as 64 hex characters or base64');
  }
  return key;
}

function deriveEncryptionKey(master: Buffer): Buffer {
  return Buffer.from(crypto.hkdfSync('sha256', master, Buffer.alloc(0), 'arattix-server/at-rest/v1', 32));
}

function keyId(key: Buffer): string {
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, 8);
}

export function sha256Hex(value: string | Buffer): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function hmacSha256Hex(secret: string, payload: string): string {
  return crypto.createHmac('sha256', secret).update(payload, 'utf8').digest('hex');
}

/** Constant-time string comparison; hashing first makes the inputs equal-length. */
export function safeEqual(a: string, b: string): boolean {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('hex');
}
