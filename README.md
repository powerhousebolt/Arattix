<div align="center">
  <img src="https://e.top4top.io/p_3714329231.png" alt="Arattix" width="120" height="120">
  <h1>Arattix</h1>
  <p>Node.js library and REST API server for the <strong>Arattai</strong> messaging platform: send messages and media, read chats, and build bots.</p>
</div>

This repository contains:

| Part | What it is | Docs |
|---|---|---|
| **Library** (`src/`) | `arattix` npm package: QR login, session persistence, chats, messages, text and file sending, media download | this README, [docs site](docs/index.html) |
| **REST API server** (`server/`) | Production HTTP API around the library: encrypted sessions, paced sending, broadcasts, signed webhooks, health/metrics, Docker/PM2 | [server/README.md](server/README.md), [API reference](server/API_REFERENCE.md), [library audit](server/AUDIT.md) |
| **Examples** (`Example/`) | Polling bot, command bot, Docker bot | [Examples](#examples) |

> **How it works.** Arattix talks to Arattai's web endpoints over plain HTTP (axios with a
> cookie jar). It does not drive a browser and has no WebSocket push channel, so bots find new
> messages by polling. Group management and reactions are not supported by the library yet.

## Contents

- [Installation](#installation)
- [Quick start](#quick-start)
- [Examples](#examples)
- [Docker](#docker)
- [REST API server](#rest-api-server)
- [Library API reference](#library-api-reference)
- [Defaults](#defaults)
- [Project structure](#project-structure)
- [Known limitations](#known-limitations)
- [npm scripts](#npm-scripts)

## Installation

```bash
npm install arattix
```

Requires Node.js 16 or newer (the REST API server needs Node.js 20.6+).

## Quick start

```js
const { ArattixBot } = require('arattix');

(async () => {
  const arattix = new ArattixBot({ isShowQr: true });

  // First run: prints a QR code to scan with the Arattai app.
  // Later runs: reuses cookies.json / headers.json from the working directory.
  const bot = await arattix.loginWithQr();
  await bot.setupCsrf();

  const chats = await bot.fetchChats({ limit: 20 });
  const chat = Object.values(chats)[0];

  await bot.sender.sendMessage('Hello from Arattix!', { chat });
  await bot.sender.sendFile('photo.jpg', 'My caption', { chat });
})();
```

The login session is saved to `cookies.json` and `headers.json` in the working directory.
**Treat both files as passwords**: anyone holding them can use the account. They are
git-ignored and excluded from Docker builds.

## Examples

```bash
node Example/simple-bot.js    # polling bot: /ping, /help, /echo, logs received media
node Example/command-bot.js   # class-based command bot
node Example/docker-bot.js    # env-configured bot used by the Docker image
```

## Docker

Two images are built from this repository:

| Image | Dockerfile | Runs |
|---|---|---|
| `arattix-bot` | `Dockerfile` | the library and the example bots (or your own script) |
| `arattix-server` | `server/Dockerfile` | the REST API server |

Both use `node:22-alpine`, run as the unprivileged `node` user, and keep state in a `/data`
volume. Neither contains a browser, because none is needed.

### Run the example bot

```bash
docker compose up -d bot
docker compose logs -f bot        # scan the QR code printed here, once
```

The session is stored in the `bot-data` volume (`/data/cookies.json`, `/data/headers.json`), so
`docker compose down && docker compose up -d bot` does not ask for a new scan. Use
`docker compose down -v` to log out and remove the stored session.

Settings come from environment variables (put them in `.env` next to `docker-compose.yml`):

| Variable | Default | Meaning |
|---|---|---|
| `BOT_NAME` | `Arattix Docker Bot` | display name used in replies |
| `SHOW_QR` | `true` | print the QR code to the logs |
| `POLL_INTERVAL` | `3000` | ms between polls |
| `LOG_LEVEL` | `info` | `silent`, `info`, `debug` |
| `SEND_STARTUP_MESSAGE` | `false` | announce startup in the first chat |

Without Compose:

```bash
docker build -t arattix-bot .
docker run -it --rm -v arattix-bot-data:/data arattix-bot
```

### Run your own bot script

`require('arattix')` works from any path inside the container:

```bash
docker run -it --rm \
  -v arattix-bot-data:/data \
  -v "$PWD/my-bot.js:/app/bots/my-bot.js:ro" \
  arattix-bot node /app/bots/my-bot.js
```

With Compose, uncomment the `my-bot.js` volume and the `command:` line of the `bot` service.
Files your bot writes with relative paths land in `/data`, on the volume.

### Development with live reload

```bash
docker compose --profile dev up bot-dev
```

`src/`, `Example/` and `index.js` are mounted read-only, and the bot restarts on every change
(Node's built-in `--watch`, no nodemon). Set `BOT_SCRIPT` to run a different script, e.g.
`BOT_SCRIPT=/app/Example/simple-bot.js`.

### Run the REST API server

```bash
cp server/.env.example server/.env    # set API_KEYS and MASTER_KEY (see the file)
docker compose --profile server up -d --build server
curl -s localhost:3000/health/ready
```

`SERVER_PORT=8080 docker compose --profile server up -d server` changes the published port.
For the split deployment (Redis, scalable API processes, one session worker) use
`docker compose -f server/docker-compose.yml up -d --build`. See
[server/README.md](server/README.md#deployment).

### Upgrading from the old `cookies.json` bind mount

Earlier versions mounted `./cookies.json` straight into the container. That lost `headers.json`
on every re-creation (forcing a new QR scan), and turned a missing file into a directory. To
carry an existing login into the new volume:

```bash
docker compose create bot
docker run --rm -v arattix_bot-data:/data -v "$PWD:/src:ro" alpine \
  sh -c 'cp /src/cookies.json /src/headers.json /data/ && chown 1000:1000 /data/*.json'
docker compose up -d bot
```

## REST API server

[`server/`](server/) turns the library into a service other systems can call:

| Area | Endpoints |
|---|---|
| Auth | `POST /api/v1/auth/session` (QR as text and PNG), `GET /api/v1/auth/status`, `DELETE /api/v1/auth/session` |
| Messaging | `POST /api/v1/messages/send`, `POST /api/v1/messages/media` (multipart, streamed) |
| Reads | `GET /api/v1/chats`, `GET /api/v1/chats/{id}/messages`, `GET /api/v1/media/{fileId}` |
| Broadcasts | `POST /api/v1/channels/broadcast` (chunked, delayed), `GET /api/v1/channels/broadcast/{id}` |
| Webhooks | `POST /api/v1/webhooks/subscribe` (HMAC `X-Arattai-Signature`), list, get, delete, test |
| Groups | `POST /api/v1/groups/create`, `PUT /api/v1/groups/{id}/members` (validated; `501` until the library supports them) |
| Ops | `GET /health/live`, `GET /health/ready`, `GET /metrics`, `GET /api/v1/jobs/{id}` |

Highlights: the session is encrypted at rest and restored on restart; reconnects use backoff and
a circuit breaker; outbound messages are throttled to avoid account flagging; `Idempotency-Key`
makes retries safe; inbound messages arrive as signed webhooks.

- Setup, deployment (Docker, Compose, PM2), logging, scaling and runbooks: [server/README.md](server/README.md)
- Every endpoint with cURL examples and response shapes: [server/API_REFERENCE.md](server/API_REFERENCE.md)
- Library review, failure domains and handling Arattai changes: [server/AUDIT.md](server/AUDIT.md)

## Library API reference

Full reference with every option: the [docs site](docs/index.html) (`docs/`).

### `ArattixBot`

```js
const arattix = new ArattixBot({ isShowQr: true });
const bot = await arattix.loginWithQr();   // reuses the saved session, or runs the QR flow
await bot.setupCsrf();
```

- `isShowQr: false` keeps the QR code out of the terminal and logs.
- Every request has a timeout (`Defaults.DEFAULT_TIMEOUT`; uploads `Defaults.MEDIA_TIMEOUT`).
- The `proxy` option is currently broken (see [Known limitations](#known-limitations)).

### `Bot`

#### Chats

```js
const chats = await bot.fetchChats({ limit: 20 });       // { chatId: Chat }
const raw = await bot.fetchChatsRaw({ limit: 20 });      // raw API response
const live = await bot.fetchChatsLive({ limit: 20 });    // bypasses server-side caching (new session per call)
```

#### Messages (v2: live, uncached)

```js
const messages = await bot.fetchMessages(chatId, { limit: 20 });   // oldest first
```

#### Media download

```js
const { data, contentType, fileName } = await bot.downloadMedia(fileId, chatId);
await bot.downloadMediaToFile(fileId, chatId, './photo.jpg');
const url = bot.getMediaUrl(fileId, chatId);
const thumb = await bot.downloadMedia(fileId, chatId, { thumbnail: true });
```

#### Media detection

```js
if (Bot.isMediaMessage(msg)) {
  const info = Bot.getMediaInfo(msg);
  console.log(info.fileName, info.mimeType, info.size);
  console.log(info.isImage, info.isAudio, info.isVideo);
}
```

### `MessageSender`

```js
await bot.sender.sendMessage('Hello!', { chatId });
await bot.sender.sendFile('./photo.jpg', 'caption', { chatId });
await bot.sender.sendImage('./img.png', 'caption', { chatId });
await bot.sender.sendAudio('./audio.mp3', '', { chatId });
await bot.sender.sendVideo('./video.mp4', '', { chatId });
await bot.sender.sendDocument('./doc.pdf', 'Here', { chatId });
await bot.sender.sendBuffer(buffer, 'file.jpg', { chatId, mimeType: 'image/jpeg' });

// Large files without loading them into memory (size must be exact):
const { size } = fs.statSync('./video.mp4');
await bot.sender.sendStream(fs.createReadStream('./video.mp4'), 'video.mp4', { chatId, size, caption: 'Demo' });
```

Message ids are unique per process, even for concurrent sends in the same millisecond.

### Auth building blocks

`ArattixBot.loginWithQr()` covers the normal case. For custom flows (for example, showing the QR
in a web page) use the parts directly:

```js
const { ArattixBot, QRLogin, SessionManager, Bot } = require('arattix');

const { session } = new ArattixBot({ isShowQr: false });
const qr = new QRLogin(session, { showQr: false });
await qr.requestQrData();
console.log(qr.qrResp.qrcodeauth.oneauth_url);   // the string to render as a QR code

let status;
while ((status = await qr.pollOnce()) !== 'authenticated') {   // 'pending' | 'refreshed'
  if (status === 'refreshed') console.log('new QR:', qr.qrResp.qrcodeauth.oneauth_url);
  await new Promise((r) => setTimeout(r, 5000));
}
await new SessionManager(session).saveSession();   // cookies.json + headers.json
const bot = new Bot(session);
await bot.setupCsrf();
```

`SessionManager.testCookies()` returns `true` only when Arattai answers `2xx`. The redirect to
the login page that an expired session gets counts as invalid.

### Types

| Class | Fields |
|-------|--------|
| `Chat` | `chatId`, `title`, `owner`, `participants`, `message`, `lastmsguid` |
| `Message` | `msguid`, `msg` |
| `MediaInfo` | `fileId`, `fileName`, `mimeType`, `size`, `width`, `height`, `thumbnail` |
| `Participant` | `dname`, `zuid` |
| `ChatManager` | `parseChatData()` → `{ chatId: Chat }` |

## Defaults

All API URLs and constants live in `src/Defaults/index.js`:

```js
const { Defaults } = require('arattix');
console.log(Defaults.WEB_BASE_URL);        // https://web.arattai.in
console.log(Defaults.FILE_DOWNLOAD_URL);   // https://files.arattai.in/webdownload
console.log(Defaults.DOWNLOAD_SERVICE);    // CLIQ
```

`Defaults` is a plain object read at call time, so a moved endpoint can be patched at runtime
(`Defaults.SEND_MESSAGE_URL = '…'`). The server exposes the same thing as
`ARATTAI_ENDPOINT_OVERRIDES`.

## Project structure

```
.
├── index.js                 package entry (re-exports src/)
├── src/
│   ├── Socket/              ArattixBot (session + login), Bot (chats, messages, media), MessageSender
│   ├── auth/                QRLogin, SessionManager, TokenLogin (placeholder)
│   ├── Types/               Chat, ChatManager, Message, MediaInfo, Participant
│   └── Defaults/            endpoint URLs and constants
├── Example/                 simple-bot, command-bot, docker-bot
├── server/                  REST API server (TypeScript); see server/README.md
├── docs/                    documentation website (static HTML)
├── Dockerfile               arattix-bot image
├── Dockerfile.dev           live-reload development image
└── docker-compose.yml       bot, bot-dev (profile dev), server (profile server)
```

## Known limitations

- **Polling only.** New messages are found by polling; there is no push channel.
- **No group management or reactions** in the library yet (the server answers `501` for them).
- **`proxy` option throws.** `axios-cookiejar-support` rejects custom HTTP agents, and
  `https-proxy-agent` is not a dependency. Route traffic through a proxy at the network level
  instead.
- **Logout is local.** Deleting `cookies.json`/`headers.json` does not end the session on
  Arattai's side; sign out from the Arattai app for that.
- **No delivery or read receipts.**
- Arattai publishes no rate limits. Keep sending and polling rates modest to avoid flagging.

[server/AUDIT.md](server/AUDIT.md) has the full review, including the defects fixed in this fork.

## npm scripts

| Script | Does |
|---|---|
| `npm run example` | run `Example/simple-bot.js` |
| `npm run docker:build` | build the `arattix-bot` image |
| `npm run docker:run` | run the bot image interactively with the `arattix-bot-data` volume |
| `npm run docker:prod` | `docker compose up -d bot` |
| `npm run docker:dev` | live-reload development container |
| `npm run docker:logs` | follow the bot's logs |
| `npm run docker:server` | build and start the REST API server (single process) |
| `npm run docker:server:split` | build and start Redis + API + worker |

## License

MIT
