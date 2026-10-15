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
