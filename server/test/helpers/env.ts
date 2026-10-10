import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, type Config } from '../../src/config';

export const API_KEY = 'test-api-key-0123456789abcdef';
export const MASTER_KEY = crypto.randomBytes(32).toString('hex');

export function tempDir(prefix = 'arattix-test-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Fast timings so lifecycle tests run in milliseconds. */
export function testConfig(overrides: Record<string, string> = {}): Config {
  return loadConfig({
    NODE_ENV: 'test',
    API_KEYS: API_KEY,
    MASTER_KEY,
    DATA_DIR: tempDir(),
    HOST: '127.0.0.1',
    PORT: '0',
    WORKER_PORT: '0',
    LOG_LEVEL: 'error',
    HEARTBEAT_INTERVAL_MS: '60000',
    RECONNECT_BASE_MS: '10',
    RECONNECT_MAX_MS: '100',
    QR_POLL_INTERVAL_MS: '10',
    QR_TIMEOUT_MS: '5000',
    SEND_RATE_PER_MINUTE: '6000',
    SEND_BURST: '100',
    SEND_PER_CHAT_INTERVAL_MS: '0',
    SEND_JITTER_MS: '0',
    JOB_BACKOFF_MS: '10',
    SYNC_WAIT_TIMEOUT_MS: '3000',
    BROADCAST_MIN_CHUNK_DELAY_MS: '0',
    POLL_ENABLED: 'false',
    WEBHOOK_ALLOW_HTTP: 'true',
    WEBHOOK_ALLOW_PRIVATE: 'true',
    WEBHOOK_BACKOFF_MS: '10',
    ...overrides,
  });
}

export async function waitUntil(predicate: () => boolean | Promise<boolean>, timeoutMs = 5000, stepMs = 10): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  throw new Error('waitUntil timed out');
}
