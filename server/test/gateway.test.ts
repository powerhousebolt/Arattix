import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { Defaults } from 'arattix';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { applyEndpointOverrides, ArattixGateway } from '../src/arattai/arattix-gateway';
import { CircuitBreaker } from '../src/circuit-breaker';
import { AuthExpiredError } from '../src/errors';
import { createSilentLogger } from '../src/logger';
import { Metrics } from '../src/metrics';
import { tempDir } from './helpers/env';

/**
 * A miniature Arattai: accounts (QR login) + web app (CSRF, chats, messages, send) + files.
 * Exercises the real arattix library code paths through the gateway.
 */
const mock = {
  validSessions: new Set<string>(),
  qrPolls: 0,
  chatsBody: null as unknown,
  chatsStatus: 200,
  sent: [] as Array<{ csrf: string | undefined; form: Record<string, string> }>,
  uploads: [] as Array<{ bytes: number; contentLength: string | undefined; chatId: string | undefined; fileName: string | undefined }>,
};
let server: http.Server;
let base: string;
const originalDefaults = { ...Defaults };
const logger = createSilentLogger();

function cookie(req: http.IncomingMessage, name: string): string | undefined {
  return (req.headers.cookie ?? '')
    .split(';')
    .map((c) => c.trim().split('='))
    .find(([k]) => k === name)?.[1];
}

function handle(req: http.IncomingMessage, res: http.ServerResponse, body: Buffer) {
  const url = new URL(req.url!, base);
  const p = url.pathname;
  // Like Arattai: a request that still carries the one-time QR ticket outside the QR poll is rejected.
  if (req.headers['z-authorization'] && !(p === '/accounts/signin/v2/qrcode' && req.method === 'PUT')) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'stale ticket' }));
  }
  const authed = mock.validSessions.has(cookie(req, 'sess') ?? '');
  const json = (status: number, data: unknown, headers: Record<string, string | string[]> = {}) => {
    res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
    res.end(JSON.stringify(data));
  };
  const toLogin = () => {
    res.writeHead(302, { Location: `${base}/accounts/signin?serviceurl=web` });
    res.end();
  };

  if (p === '/accounts' && req.method === 'GET') {
    res.writeHead(200, { 'Set-Cookie': 'iamcsr=csr1; Path=/' });
    return res.end('accounts');
  }
  if (p === '/accounts/signin' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end('<!DOCTYPE html><html><body>Sign in</body></html>');
  }
  if (p === '/accounts/signin/v2/qrcode' && req.method === 'POST') {
    if (req.headers['x-zcsrf-token'] !== 'iamcsrcoo=csr1') return json(400, { error: 'csrf' });
    return json(200, { qrcodeauth: { token: 'tok1', oneauth_url: 'https://oneauth.example/abc' } });
  }
  if (p === '/accounts/signin/v2/qrcode' && req.method === 'PUT') {
    if (req.headers['z-authorization'] !== 'Zoho-ticket tok1') return json(200, { status_code: 401 });
    mock.qrPolls += 1;
    if (mock.qrPolls < 2) return json(200, { status_code: 100 });
    const sess = crypto.randomBytes(8).toString('hex');
    mock.validSessions.add(sess);
    return json(200, { status_code: 200 }, { 'Set-Cookie': `sess=${sess}; Path=/; HttpOnly` });
  }

  if (p === '/web/' && req.method === 'GET') {
    if (!authed) return toLogin();
    res.writeHead(200, { 'Set-Cookie': 'CT_CSRF_TOKEN=csrf-web; Path=/', 'Content-Type': 'text/html' });
    return res.end('<html>app</html>');
  }
  if (p === '/web/v1/chats') {
    if (!authed) return toLogin();
    return json(mock.chatsStatus, mock.chatsBody ?? {
      data: { chats: [{ chatid: 'CT_1', title: 'Team', lastmsginfo: JSON.stringify({ msguid: 'm2', msg: 'yo' }), owner: { name: 'Bob', id: '7' } }] },
    });
  }
  if (p.startsWith('/web/v2/chats/') && p.endsWith('/messages')) {
    if (!authed) return toLogin();
    return json(200, { data: [{ id: 'm1', type: 'text', content: { text: 'hello' }, sender: { id: '7', name: 'Bob' } }] });
  }
  if (p === '/web/sendofficechatmessage.do' && req.method === 'POST') {
    if (!authed) return toLogin();
    const form = Object.fromEntries(new URLSearchParams(body.toString()));
    mock.sent.push({ csrf: req.headers['x-zcsrf-token'] as string | undefined, form });
    return json(200, { status: 'sent' });
  }
  if (p === '/files/webupload' && req.method === 'POST') {
    if (!authed) return toLogin();
    mock.uploads.push({
      bytes: body.length,
      contentLength: req.headers['content-length'],
      chatId: req.headers['x-cliq-id'] as string | undefined,
      fileName: req.headers['file-name'] as string | undefined,
    });
    return json(200, { uploaded: true });
  }
  if (p === '/files/webdownload') {
    if (!authed) return toLogin();
    res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Disposition': 'attachment; filename="pic.png"' });
    return res.end(Buffer.from('PNG!'));
  }
  json(404, { error: 'not found' });
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => handle(req, res, Buffer.concat(chunks)));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  Object.assign(Defaults, {
    WEB_BASE_URL: `${base}/web`,
    ACCOUNTS_BASE_URL: `${base}/accounts`,
    CHAT_API: `${base}/web/v1/chats`,
    MESSAGES_API: (chatId: string) => `${base}/web/v2/chats/${chatId}/messages`,
    SEND_MESSAGE_URL: `${base}/web/sendofficechatmessage.do`,
    FILE_UPLOAD_URL: `${base}/files/webupload`,
    FILE_DOWNLOAD_URL: `${base}/files/webdownload`,
    QR_AUTH_URL: `${base}/accounts/signin/v2/qrcode`,
  });
});

afterAll(async () => {
  Object.assign(Defaults, originalDefaults);
  await new Promise<void>((r) => server.close(() => r()));
});

beforeEach(() => {
  mock.validSessions.clear();
  mock.qrPolls = 0;
  mock.chatsBody = null;
  mock.chatsStatus = 200;
  mock.sent = [];
  mock.uploads = [];
});

function gateway(threshold = 5) {
  const breaker = new CircuitBreaker({ failureThreshold: threshold, cooldownMs: 60_000 });
  return { gw: new ArattixGateway({ breaker, logger, metrics: new Metrics() }), breaker };
}

async function login() {
  const { gw, breaker } = gateway();
  const challenge = await gw.startQr();
  expect(challenge.data).toBe('https://oneauth.example/abc');
  expect((await gw.pollQr()).status).toBe('pending');
  expect((await gw.pollQr()).status).toBe('authenticated');
  await gw.completeLogin();
  return { gw, breaker };
}

describe('ArattixGateway against a mock Arattai', () => {
  it('logs in by QR, binds the web CSRF token and performs reads and sends', async () => {
    const { gw } = await login();

    expect(await gw.listChats(10)).toEqual([
      expect.objectContaining({ chatId: 'CT_1', title: 'Team', lastMessageId: 'm2', owner: { id: '7', name: 'Bob' } }),
    ]);
    expect(await gw.fetchMessages('CT_1', 5)).toEqual([
      expect.objectContaining({ id: 'm1', text: 'hello', sender: { id: '7', name: 'Bob' } }),
    ]);

    await gw.sendText('CT_1', 'hi there', 'Bot');
    expect(mock.sent[0]).toMatchObject({ csrf: 'zchat_csrparam=csrf-web', form: { chid: 'CT_1', msg: 'hi there', dname: 'Bot' } });
    // Concurrent sends start in the same millisecond; they must still get distinct msgids.
    await Promise.all([1, 2, 3].map((n) => gw.sendText('CT_1', `burst ${n}`)));
    expect(new Set(mock.sent.slice(1).map((s) => s.form.msgid)).size).toBe(3);

    const file = path.join(tempDir(), 'big.bin');
    fs.writeFileSync(file, Buffer.alloc(11 * 1024 * 1024, 1));
    await gw.sendMedia({ chatId: 'CT_1', filePath: file, fileName: 'big.bin', mimeType: 'application/octet-stream', size: 11 * 1024 * 1024 });
    expect(mock.uploads[0]).toEqual({ bytes: 11 * 1024 * 1024, contentLength: String(11 * 1024 * 1024), chatId: 'CT_1', fileName: 'big.bin' });

    const media = await gw.downloadMedia('f1', 'CT_1', false);
    expect(media).toMatchObject({ contentType: 'image/png', fileName: 'pic.png' });
    expect(media.data.toString()).toBe('PNG!');
  });

  it('survives a restart: a serialised snapshot restores into a fresh gateway', async () => {
    const { gw } = await login();
    const snapshot = JSON.parse(JSON.stringify(gw.snapshot())); // as it would round-trip through storage
    const { gw: fresh } = gateway();
    await fresh.restore(snapshot);
    await fresh.validate();
    await fresh.sendText('CT_1', 'after restart');
    expect(mock.sent.at(-1)).toMatchObject({ csrf: 'zchat_csrparam=csrf-web', form: { msg: 'after restart' } });
  });

  it('detects an expired session on every path instead of failing silently', async () => {
    const { gw } = await login();
    mock.validSessions.clear(); // server-side logout
    await expect(gw.validate()).rejects.toBeInstanceOf(AuthExpiredError);
    await expect(gw.listChats(5)).rejects.toMatchObject({ code: 'SESSION_EXPIRED' });
    await expect(gw.fetchMessages('CT_1', 5)).rejects.toMatchObject({ code: 'SESSION_EXPIRED' });
    await expect(gw.sendText('CT_1', 'x')).rejects.toMatchObject({ code: 'SESSION_EXPIRED' });
  });

  it('reports contract drift distinctly from expiry', async () => {
    const { gw } = await login();
    mock.chatsBody = { data: { items: [] } };
    await expect(gw.validate()).rejects.toMatchObject({ code: 'UPSTREAM_CONTRACT_CHANGED' });
  });

  it('opens the circuit after repeated upstream 5xx', async () => {
    const { gw: g1 } = await login();
    const snapshot = g1.snapshot();
    const { gw, breaker } = gateway(2);
    await gw.restore(snapshot);
    mock.chatsStatus = 503;
    mock.chatsBody = { error: 'down' };
    await expect(gw.listChats(5)).rejects.toMatchObject({ code: 'UPSTREAM_ERROR' });
    await expect(gw.listChats(5)).rejects.toMatchObject({ code: 'UPSTREAM_ERROR' });
    expect(breaker.getState()).toBe('OPEN');
    await expect(gw.listChats(5)).rejects.toMatchObject({ code: 'UPSTREAM_CIRCUIT_OPEN' });
  });

  it('answers CAPABILITY_UNAVAILABLE for operations without a verified endpoint', async () => {
    const { gw } = gateway();
    await expect(gw.react()).rejects.toMatchObject({ status: 501, code: 'CAPABILITY_UNAVAILABLE' });
    await expect(gw.createGroup()).rejects.toMatchObject({ status: 501 });
    await expect(gw.updateGroupMembers('g', 'add')).rejects.toMatchObject({ status: 501 });
    expect(gw.capabilities['groups.members']).toBe(false);
  });

  it('applies endpoint overrides, including URL templates for function-valued keys', () => {
    const saved = { MESSAGES_API: Defaults.MESSAGES_API, SEND_MESSAGE_URL: Defaults.SEND_MESSAGE_URL };
    try {
      applyEndpointOverrides(
        JSON.stringify({ SEND_MESSAGE_URL: 'https://x.example/send', MESSAGES_API: 'https://x.example/v3/{chatId}/msgs' }),
        logger,
      );
      expect(Defaults.SEND_MESSAGE_URL).toBe('https://x.example/send');
      expect(Defaults.MESSAGES_API('CT 1')).toBe('https://x.example/v3/CT%201/msgs');
      expect(() => applyEndpointOverrides('{"NOPE":"x"}', logger)).toThrow(/unknown key/);
      expect(() => applyEndpointOverrides('{"DEFAULT_TIMEOUT":"x"}', logger)).toThrow(/must be a number/);
    } finally {
      Object.assign(Defaults, saved);
    }
  });
});
