import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { classifyUpstreamError, countsAgainstCircuit, looksLikeLoginPage } from '../src/arattai/classify';
import { parseChatList, parseMessages } from '../src/arattai/normalize';
import { CircuitBreaker } from '../src/circuit-breaker';
import { Cipher, parseMasterKey } from '../src/crypto';
import { AppError, AuthExpiredError, fromWireMessage, toAppError, toWireMessage } from '../src/errors';
import { createSilentLogger } from '../src/logger';
import { SendThrottle } from '../src/outbound/throttle';
import { MemoryJobQueue } from '../src/queue/memory-queue';
import { JobWaitTimeoutError } from '../src/queue/types';
import { backoffDelay } from '../src/util';
import { signPayload, verifySignature } from '../src/webhooks/signature';
import { assertWebhookUrl, isPrivateAddress } from '../src/webhooks/url-guard';
import { loadConfig } from '../src/config';

const key = () => crypto.randomBytes(32).toString('hex');

describe('Cipher', () => {
  it('round-trips and binds ciphertext to its context', () => {
    const c = new Cipher(key());
    const enc = c.encrypt('secret cookies', 'session:a');
    expect(c.decrypt(enc, 'session:a')).toBe('secret cookies');
    expect(() => c.decrypt(enc, 'session:b')).toThrow();
  });

  it('rejects tampered ciphertext', () => {
    const c = new Cipher(key());
    const enc = c.encrypt('x', 'ctx');
    const raw = Buffer.from(enc.split('.')[2]!, 'base64');
    raw[raw.length - 1]! ^= 0xff;
    expect(() => c.decrypt(`v1.${enc.split('.')[1]}.${raw.toString('base64')}`, 'ctx')).toThrow();
  });

  it('decrypts with MASTER_KEY_PREVIOUS during rotation and flags it', () => {
    const oldKey = key();
    const enc = new Cipher(oldKey).encrypt('payload', 'ctx');
    const rotated = new Cipher(key(), oldKey);
    expect(rotated.decrypt(enc, 'ctx')).toBe('payload');
    expect(rotated.needsRotation(enc)).toBe(true);
    expect(rotated.needsRotation(rotated.encrypt('p', 'ctx'))).toBe(false);
    expect(() => new Cipher(key()).decrypt(enc, 'ctx')).toThrow(/unknown key/);
  });

  it('accepts hex or base64 keys of exactly 32 bytes', () => {
    expect(parseMasterKey(crypto.randomBytes(32).toString('base64'))).toHaveLength(32);
    expect(() => parseMasterKey('abcd')).toThrow(/32 bytes/);
  });
});

describe('webhook signatures', () => {
  it('verifies a valid signature and rejects tampering, wrong secret and replays', () => {
    const body = JSON.stringify({ hello: 'world' });
    const now = 1_800_000_000;
    const header = signPayload('s3cret-s3cret-s3cret', body, now);
    expect(header).toMatch(/^t=1800000000,v1=[0-9a-f]{64}$/);
    expect(verifySignature('s3cret-s3cret-s3cret', header, body, { nowSec: now })).toBe(true);
    expect(verifySignature('s3cret-s3cret-s3cret', header, body + ' ', { nowSec: now })).toBe(false);
    expect(verifySignature('other-secret-value', header, body, { nowSec: now })).toBe(false);
    expect(verifySignature('s3cret-s3cret-s3cret', header, body, { nowSec: now + 301 })).toBe(false);
    expect(verifySignature('s3cret-s3cret-s3cret', undefined, body)).toBe(false);
  });
});

describe('backoffDelay', () => {
  it('grows exponentially, stays within [ceiling/2, ceiling] and respects the cap', () => {
    expect(backoffDelay(0, 100, 10_000, () => 0)).toBe(50);
    expect(backoffDelay(3, 100, 10_000, () => 1)).toBe(800);
    expect(backoffDelay(50, 100, 10_000, () => 1)).toBe(10_000);
  });
});

describe('CircuitBreaker', () => {
  it('opens after the threshold, fails fast, half-opens after cooldown and closes on success', async () => {
    let now = 0;
    const transitions: string[] = [];
    const cb = new CircuitBreaker({ failureThreshold: 2, cooldownMs: 1000, now: () => now, onStateChange: (f, t) => transitions.push(`${f}>${t}`) });
    const fail = () => Promise.reject(new Error('boom'));
    await expect(cb.exec(fail, () => true)).rejects.toThrow('boom');
    await expect(cb.exec(fail, () => true)).rejects.toThrow('boom');
    expect(cb.getState()).toBe('OPEN');
    await expect(cb.exec(async () => 'x', () => true)).rejects.toMatchObject({ code: 'UPSTREAM_CIRCUIT_OPEN' });
    now = 1000;
    expect(await cb.exec(async () => 'ok', () => true)).toBe('ok');
    expect(cb.getState()).toBe('CLOSED');
    expect(transitions).toEqual(['CLOSED>OPEN', 'OPEN>HALF_OPEN', 'HALF_OPEN>CLOSED']);
  });

  it('ignores errors that do not count against upstream health', async () => {
    const cb = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 1000 });
    await expect(cb.exec(() => Promise.reject(new AuthExpiredError()), countsAgainstCircuit)).rejects.toBeInstanceOf(AuthExpiredError);
    expect(cb.getState()).toBe('CLOSED');
  });
});

describe('classifyUpstreamError', () => {
  it('maps auth, rate limit, 5xx and 4xx responses', () => {
    expect(classifyUpstreamError({ response: { status: 401 } }, 'op', true)).toBeInstanceOf(AuthExpiredError);
    const rl = classifyUpstreamError({ response: { status: 429, headers: { 'retry-after': '7' } } }, 'op', false);
    expect(rl).toMatchObject({ code: 'UPSTREAM_RATE_LIMITED', retryable: true, retryAfterMs: 7000 });
    expect(classifyUpstreamError({ response: { status: 503 } }, 'op', true)).toMatchObject({ code: 'UPSTREAM_ERROR', retryable: true });
    expect(classifyUpstreamError({ response: { status: 503 } }, 'op', false)).toMatchObject({ retryable: false });
    expect(classifyUpstreamError({ response: { status: 400 } }, 'op', true)).toMatchObject({ code: 'UPSTREAM_REJECTED', retryable: false });
  });

  it('never retries a non-idempotent call whose outcome is ambiguous', () => {
    expect(classifyUpstreamError({ code: 'ECONNREFUSED' }, 'send', false)).toMatchObject({ code: 'UPSTREAM_UNREACHABLE', retryable: true });
    expect(classifyUpstreamError({ code: 'ECONNABORTED', message: 'timeout of 10000ms exceeded' }, 'send', false)).toMatchObject({
      code: 'UPSTREAM_TIMEOUT_AMBIGUOUS',
      retryable: false,
    });
    expect(classifyUpstreamError({ code: 'ECONNRESET' }, 'read', true)).toMatchObject({ code: 'UPSTREAM_TIMEOUT', retryable: true });
  });

  it('detects login pages', () => {
    expect(looksLikeLoginPage('<!DOCTYPE html><html>sign in</html>')).toBe(true);
    expect(looksLikeLoginPage({ data: [] })).toBe(false);
  });
});

describe('normalize', () => {
  it('parses v1 chat lists with string-encoded fields and skips malformed rows', () => {
    const chats = parseChatList({
      data: {
        chats: [
          {
            chatid: 'CT_1',
            title: 'Team',
            recipants: JSON.stringify([{ dname: 'Alice', zuid: '11' }]),
            lastmsginfo: JSON.stringify({ msguid: 'm9', msg: 'hi' }),
            owner: { name: 'Bob', id: '22' },
          },
          { title: 'no id' },
          'garbage',
        ],
      },
    });
    expect(chats).toEqual([
      {
        chatId: 'CT_1',
        title: 'Team',
        lastMessageId: 'm9',
        lastMessagePreview: 'hi',
        owner: { id: '22', name: 'Bob' },
        participants: [{ id: '11', name: 'Alice' }],
      },
    ]);
  });

  it('raises a contract error when the envelope changes', () => {
    expect(() => parseChatList({ chats: [] })).toThrow(expect.objectContaining({ code: 'UPSTREAM_CONTRACT_CHANGED' }));
    expect(() => parseMessages({ messages: [] })).toThrow(expect.objectContaining({ code: 'UPSTREAM_CONTRACT_CHANGED' }));
  });

  it('parses v2 messages including media and second-precision timestamps', () => {
    const [m] = parseMessages({
      data: [
        {
          id: 42,
          type: 'file',
          time: '1800000000',
          sender: { id: 'u1', name: 'Al' },
          content: { file: { id: 'f1', name: 'a.png', type: 'image/png', dimensions: { size: 10 } } },
        },
      ],
    });
    expect(m).toMatchObject({ id: '42', timestamp: 1_800_000_000_000, media: { fileId: 'f1', mimeType: 'image/png', size: 10 } });
  });
});

describe('webhook URL guard', () => {
  const strict = { allowHttp: false, allowPrivate: false };
  it('classifies private addresses', () => {
    for (const a of ['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.1', '169.254.169.254', '::1', 'fd00::1', '::ffff:127.0.0.1']) {
      expect(isPrivateAddress(a), a).toBe(true);
    }
    for (const a of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) expect(isPrivateAddress(a), a).toBe(false);
  });

  it('rejects http, credentials, local hosts and private literals', () => {
    expect(() => assertWebhookUrl('http://example.com/h', strict)).toThrow(/https/);
    expect(() => assertWebhookUrl('https://u:p@example.com/h', strict)).toThrow(/credentials/);
    expect(() => assertWebhookUrl('https://localhost/h', strict)).toThrow(/local/);
    expect(() => assertWebhookUrl('https://169.254.169.254/latest', strict)).toThrow(/private/);
    expect(() => assertWebhookUrl('https://[::1]/h', strict)).toThrow(/private/);
    expect(assertWebhookUrl('https://example.com/h', strict).hostname).toBe('example.com');
  });
});

describe('error wire format', () => {
  it('round-trips AppErrors through a string (BullMQ failedReason)', () => {
    const e = new AppError({ status: 409, code: 'X', message: 'm', details: { a: 1 }, retryable: true, retryAfterMs: 5 });
    expect(fromWireMessage(toWireMessage(e))?.toJSON()).toEqual(e.toJSON());
    expect(toAppError(new Error('plain')).code).toBe('INTERNAL');
  });
});

describe('SendThrottle', () => {
  it('enforces burst + sustained rate and per-chat spacing', async () => {
    let now = 0;
    const t = new SendThrottle({ ratePerMinute: 60_000, burst: 2, perChatIntervalMs: 0, jitterMs: 0, now: () => now });
    await t.acquire('a');
    await t.acquire('b');
    const started = Date.now();
    const third = t.acquire('c');
    setTimeout(() => (now += 1), 5);
    await third;
    expect(Date.now() - started).toBeGreaterThanOrEqual(1);

    const chat = new SendThrottle({ ratePerMinute: 60_000, burst: 10, perChatIntervalMs: 60, jitterMs: 0 });
    await chat.acquire('same');
    const s = Date.now();
    await chat.acquire('same');
    expect(Date.now() - s).toBeGreaterThanOrEqual(50);
  });
});

describe('MemoryJobQueue', () => {
  const logger = createSilentLogger();

  it('retries retryable failures with backoff and stops on non-retryable ones', async () => {
    const q = new MemoryJobQueue('t', { maxPending: 10 }, logger);
    let calls = 0;
    q.process(async (job) => {
      calls += 1;
      if (job.name === 'flaky' && calls < 3) throw new AppError({ status: 503, code: 'TRANSIENT', message: 'x', retryable: true });
      if (job.name === 'fatal') throw new AppError({ status: 400, code: 'FATAL', message: 'no', retryable: false });
      return { ok: job.data };
    }, 1);

    const { id } = await q.add('flaky', 1, { attempts: 5, backoffMs: 5 });
    await expect(q.waitForResult(id, 2000)).resolves.toEqual({ ok: 1 });
    expect((await q.getJob(id))?.attemptsMade).toBe(3);

    calls = 0;
    const fatal = await q.add('fatal', 2, { attempts: 5, backoffMs: 5 });
    await expect(q.waitForResult(fatal.id, 2000)).rejects.toMatchObject({ code: 'FATAL' });
    expect(calls).toBe(1);
    await expect(q.waitForResult(fatal.id, 10)).rejects.toMatchObject({ code: 'FATAL' }); // already finished
    await q.close();
  });

  it('dedupes by job id, times out waiters, and enforces the backlog limit', async () => {
    const q = new MemoryJobQueue('t', { maxPending: 2 }, logger);
    const a = await q.add('n', {}, { jobId: 'same' });
    const b = await q.add('n', {}, { jobId: 'same' });
    expect(b).toEqual({ id: a.id, deduplicated: true });
    await expect(q.waitForResult(a.id, 20)).rejects.toBeInstanceOf(JobWaitTimeoutError);
    await q.add('n', {});
    await expect(q.add('n', {})).rejects.toMatchObject({ code: 'QUEUE_FULL' });
    await q.close();
  });

  it('runs at most `concurrency` jobs at once', async () => {
    const q = new MemoryJobQueue('t', { maxPending: 100 }, logger);
    let active = 0;
    let peak = 0;
    q.process(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 10));
      active -= 1;
    }, 2);
    const ids = await Promise.all(Array.from({ length: 6 }, () => q.add('n', {})));
    await Promise.all(ids.map(({ id }) => q.waitForResult(id, 2000)));
    expect(peak).toBe(2);
    await q.close();
  });
});

describe('config', () => {
  const base = { API_KEYS: 'x'.repeat(24), MASTER_KEY: key() };
  it('requires Redis for split roles and validates keys', () => {
    expect(() => loadConfig({ ...base, ROLE: 'worker' })).toThrow(/ROLE=api\/worker requires/);
    expect(() => loadConfig({ ...base, API_KEYS: 'short' })).toThrow(/at least 24/);
    expect(loadConfig(base).ROLE).toBe('all');
    expect(loadConfig({ ...base, POLL_ENABLED: 'false' }).POLL_ENABLED).toBe(false);
  });
});
