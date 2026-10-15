// Library unit tests (no network). Run with `npm run test:lib` (node:test, no dependencies).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { describe, it } = require('node:test');
const { ArattixBot, Bot, ChatManager, Defaults, SessionManager } = require('..');

describe('Defaults', () => {
  it('encodes ids so they cannot change the request path', () => {
    assert.equal(Defaults.MESSAGES_API('a/b?c#d'), 'https://web.arattai.in/v2/chats/a%2Fb%3Fc%23d/messages');
    assert.equal(Defaults.ATTACHMENTS_URL('x/../y'), 'https://web.arattai.in/v1/attachments/x%2F..%2Fy');
  });
});

describe('ArattixBot', () => {
  it('creates a cookie-jar session with a request timeout', () => {
    const client = new ArattixBot({ isShowQr: false });
    assert.equal(client.session.defaults.timeout, Defaults.DEFAULT_TIMEOUT);
    assert.ok(client.session.defaults.jar);
  });

  it('rejects the unsupported proxy option with a clear message', () => {
    assert.throws(() => new ArattixBot({ proxy: 'http://127.0.0.1:8080' }), /"proxy" option is not supported/);
  });
});

describe('Bot.parseContentDispositionFileName', () => {
  const parse = Bot.parseContentDispositionFileName;
  it('reads quoted, bare and RFC 5987 file names', () => {
    assert.equal(parse('attachment; filename="a b.jpg"'), 'a b.jpg');
    assert.equal(parse('inline; filename=plain.txt'), 'plain.txt');
    assert.equal(parse("attachment; filename*=UTF-8''na%C3%AFve.png; filename=\"x.png\""), 'naïve.png');
    assert.equal(parse("attachment; filename*=iso-8859-1''caf%E9.txt"), 'café.txt');
  });

  it('returns null without a file name', () => {
    assert.equal(parse('attachment'), null);
    assert.equal(parse(undefined), null);
  });
});

describe('ChatManager', () => {
  it('parses string-encoded fields and skips malformed rows instead of stopping', () => {
    const errors = [];
    const original = console.error;
    console.error = (...args) => errors.push(args);
    try {
      const chats = new ChatManager({
        data: {
          chats: [
            {
              chatid: '1',
              title: 'First',
              owner: { name: 'Owner', id: '9' },
              recipants: '[{"dname":"Ann","zuid":"2"}]',
              lastmsginfo: '{"msguid":"m1","msg":"hi"}',
            },
            { chatid: '2', recipants: '{broken' },
            { chatid: '3', title: 'No owner' },
            { title: 'No id' },
          ],
        },
      }).parseChatData();
      assert.deepEqual(Object.keys(chats), ['1', '3']);
      assert.equal(chats['1'].getParticipants()[0].getDname(), 'Ann');
      assert.equal(chats['1'].getLastmsguid(), 'm1');
      assert.equal(chats['3'].getOwner().getDname(), null);
      assert.equal(errors.length, 1);
    } finally {
      console.error = original;
    }
  });

  it('returns no chats for an unrecognised envelope', () => {
    const original = console.error;
    console.error = () => {};
    try {
      assert.deepEqual(new ChatManager({ data: {} }).parseChatData(), {});
    } finally {
      console.error = original;
    }
  });
});

describe('SessionManager', () => {
  it('writes cookies.json and headers.json readable by the owner only, and reads them back', async (t) => {
    if (process.platform === 'win32') return t.skip('POSIX permissions only');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arattix-lib-'));
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      // A world-readable file from an older version is tightened on the next save.
      fs.writeFileSync('headers.json', '{}', { mode: 0o644 });
      const source = new ArattixBot({ isShowQr: false }).session;
      await source.defaults.jar.setCookie('JSESSIONID=abc; Domain=web.arattai.in; Path=/; Secure', 'https://web.arattai.in/');
      source.defaults.headers.common['X-ZCSRF-TOKEN'] = 'zchat_csrparam=t';
      await new SessionManager(source).saveSession();
      for (const file of ['cookies.json', 'headers.json']) {
        assert.equal(fs.statSync(file).mode & 0o777, 0o600, file);
      }

      const target = new ArattixBot({ isShowQr: false }).session;
      await new SessionManager(target).loadSession();
      const cookies = await target.defaults.jar.getCookies('https://web.arattai.in/');
      assert.equal(cookies.find((c) => c.key === 'JSESSIONID').value, 'abc');
      assert.equal(target.defaults.headers.common['X-ZCSRF-TOKEN'], 'zchat_csrparam=t');
    } finally {
      process.chdir(cwd);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─── Login flow against a local mock of Arattai ─────────────────────────────
// The mock rejects (HTTP 400) any request that still carries the one-time QR ticket after the
// QR poll that it belongs to. That is the failure reported from Docker: after scanning, every
// start died with "Request failed with status code 400" before printing a new QR code.
describe('QR login and session restore', () => {
  const http = require('node:http');
  const crypto = require('node:crypto');
  const { before, after, beforeEach } = require('node:test');

  const state = { valid: new Set(), qrRequests: 0, ticketRejections: 0 };
  const saved = { ...Defaults };
  let server;
  let base;
  let dir;
  let cwd;

  const cookieOf = (req, name) =>
    (req.headers.cookie || '').split(';').map((c) => c.trim().split('=')).find(([k]) => k === name)?.[1];

  before(async () => {
    server = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        const url = new URL(req.url, base);
        const json = (status, body, headers = {}) => {
          res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
          res.end(JSON.stringify(body));
        };
        const isQrPoll = url.pathname === '/accounts/signin/v2/qrcode' && req.method === 'PUT';
        if (req.headers['z-authorization'] && !isQrPoll) {
          state.ticketRejections += 1;
          return json(400, { error: 'stale ticket' });
        }
        const authed = state.valid.has(cookieOf(req, 'sess'));

        if (url.pathname === '/accounts') {
          res.writeHead(200, { 'Set-Cookie': 'iamcsr=csr1; Path=/' });
          return res.end('accounts');
        }
        if (url.pathname === '/accounts/signin') {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          return res.end('<html>sign in</html>');
        }
        if (url.pathname === '/accounts/signin/v2/qrcode' && req.method === 'POST') {
          if (req.headers['x-zcsrf-token'] !== 'iamcsrcoo=csr1') return json(400, { error: 'csrf' });
          state.qrRequests += 1;
          return json(200, { qrcodeauth: { token: 'tok1', oneauth_url: 'https://oneauth.example/abc' } });
        }
        if (isQrPoll) {
          if (req.headers['z-authorization'] !== 'Zoho-ticket tok1') return json(200, { status_code: 401 });
          const sess = crypto.randomBytes(6).toString('hex');
          state.valid.add(sess);
          return json(200, { status_code: 200 }, { 'Set-Cookie': `sess=${sess}; Path=/` });
        }
        if (url.pathname === '/web/') {
          if (!authed) {
            res.writeHead(302, { Location: `${base}/accounts/signin` });
            return res.end();
          }
          res.writeHead(200, { 'Set-Cookie': 'CT_CSRF_TOKEN=csrf-web; Path=/', 'Content-Type': 'text/html' });
          return res.end('<html>app</html>');
        }
        if (url.pathname === '/web/v1/chats') {
          if (!authed) return json(401, { error: 'login' });
          return json(200, { data: { chats: [{ chatid: 'CT_1', title: 'Team', owner: { name: 'Bob', id: '7' } }] } });
        }
        json(404, { error: 'not found' });
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
    Object.assign(Defaults, {
      WEB_BASE_URL: `${base}/web`,
      ACCOUNTS_BASE_URL: `${base}/accounts`,
      CHAT_API: `${base}/web/v1/chats`,
      QR_AUTH_URL: `${base}/accounts/signin/v2/qrcode`,
    });
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arattix-login-'));
    cwd = process.cwd();
    process.chdir(dir);
  });

  after(async () => {
    process.chdir(cwd);
    fs.rmSync(dir, { recursive: true, force: true });
    Object.assign(Defaults, saved);
    await new Promise((resolve) => server.close(resolve));
  });

  beforeEach(() => {
    state.qrRequests = 0;
    state.ticketRejections = 0;
  });

  const quietly = async (fn) => {
    const original = console.log;
    console.log = () => {};
    try {
      return await fn();
    } finally {
      console.log = original;
    }
  };

  it('logs in by QR, sets up CSRF and never saves the one-time QR ticket', async () => {
    const bot = await quietly(() => new ArattixBot({ isShowQr: false }).loginWithQr());
    await bot.setupCsrf();
    const chats = await bot.fetchChatsRaw({ limit: 5 });
    assert.equal(chats.data.chats[0].chatid, 'CT_1');
    assert.equal(state.qrRequests, 1);
    assert.equal(state.ticketRejections, 0);

    const headers = JSON.parse(fs.readFileSync('headers.json', 'utf-8'));
    const keys = Object.keys(headers).map((k) => k.toLowerCase());
    assert.ok(!keys.includes('z-authorization'), 'QR ticket must not be persisted');
    assert.ok(!String(headers['X-ZCSRF-TOKEN'] || '').startsWith('iamcsrcoo='), 'login-only CSRF header must not be persisted');
  });

  it('restores the session without a new QR even if headers.json still holds an old ticket', async () => {
    // headers.json as written by earlier versions: ticket and accounts CSRF header included.
    fs.writeFileSync(
      'headers.json',
      JSON.stringify({ 'User-Agent': 'x', 'X-ZCSRF-TOKEN': 'iamcsrcoo=csr1', 'Z-Authorization': 'Zoho-ticket tok1' }),
    );
    const bot = await quietly(() => new ArattixBot({ isShowQr: false }).loginWithQr());
    await bot.setupCsrf();
    await bot.fetchChatsRaw({ limit: 5 });
    assert.equal(state.qrRequests, 0, 'a valid stored session needs no new QR');
    assert.equal(state.ticketRejections, 0);
  });

  it('starts a clean QR login when the stored session has expired', async () => {
    state.valid.clear(); // Arattai ended the session
    fs.writeFileSync('headers.json', JSON.stringify({ 'Z-Authorization': 'Zoho-ticket tok1' }));
    const bot = await quietly(() => new ArattixBot({ isShowQr: false }).loginWithQr());
    await bot.setupCsrf();
    await bot.fetchChatsRaw({ limit: 5 });
    assert.equal(state.qrRequests, 1);
    assert.equal(state.ticketRejections, 0);
  });
});
