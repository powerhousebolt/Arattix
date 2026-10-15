# arattix: Codebase Review & Failure-Domain Audit

Scope: the `arattix` library at the repository root (`src/`), reviewed as the foundation for
`arattix-server`. Every defect listed as **fixed** has a regression test in `server/test/`.

---

## 0. What the library actually is

The brief describes arattix as a WebSocket + headless-browser framework in the style of
whatsapp-web.js / Puppeteer. **It is neither.** That changes the failure model, so it comes first:

| Assumption | Reality in this fork |
|---|---|
| Headless browser / DOM automation | **No browser.** Pure HTTP with `axios` + `tough-cookie` (`axios-cookiejar-support`). |
| WebSocket session, inbound frames | **No socket anywhere.** Inbound messages are only discoverable by polling `GET /v2/chats/:id/messages`. |
| "Breaking DOM/layout changes" | Not applicable. What breaks is the **private HTTP contract**: URLs, query params, JSON shapes, the CSRF scheme. |
| Groups, reactions, channel admin, profile | **No endpoints in the library.** Only: QR login, chat list, messages, send text, upload file, download file. |

Arattai's real web client does receive push events over Zoho's WMS channel (the
`chat-js-avcliq-mediacomponents` bundle deleted in `65fd345` references `wmsEvents` for AV calls),
but the fork implements none of that protocol, and no frame format could be verified. The server
therefore uses **polling as its inbound event source**, behind an interface (`ArattaiGateway` +
`InboundPoller`) where a push transport can be added later without touching the API, queues or
webhooks.

Likewise the server **does not invent endpoints** for groups or reactions. Those routes exist,
are fully validated, queued and wired to gateway methods, but answer
`501 CAPABILITY_UNAVAILABLE` until someone captures the real requests (see §4) and implements the
matching gateway method. A fabricated endpoint would fail in production in ways that are much
harder to detect than an honest 501.

---

## 1. Session, cookie and CSRF handling (as implemented)

All state lives on **one shared axios instance**: the cookie jar is `session.defaults.jar`, and
the CSRF header is written into `session.defaults.headers.common`.

```
QR phase (src/auth/qr-login.js)
  GET  accounts.arattai.in                     → cookie iamcsr
  GET  accounts.arattai.in/signin?QRLogin=true
  POST /signin/v2/qrcode   X-ZCSRF-TOKEN: iamcsrcoo=<iamcsr>
       ← { qrcodeauth: { token, oneauth_url } }       oneauth_url is what the QR encodes
  PUT  /signin/v2/qrcode   Z-Authorization: Zoho-ticket <token>     (every 5 s)
       ← status_code 401 = QR expired → request a new one
         status_code 200 = approved; session cookies land in the jar

Web phase (src/Socket/bot.js setupCsrf / _refreshCsrf)
  GET  web.arattai.in/                         → cookie CT_CSRF_TOKEN
  header X-ZCSRF-TOKEN: zchat_csrparam=<CT_CSRF_TOKEN>; Z-Authorization removed

Persistence (src/auth/session-manager.js)
  cookies.json  ← jar.toJSON()                         plaintext, CWD
  headers.json  ← defaults.headers.common              plaintext, CWD (includes the QR ticket
                                                        and IAM CSRF header at save time)
```

Consequences:

* The session is a **bearer credential on disk in plaintext**.
* CSRF is re-derived from a cookie, so restoring cookies is enough. Restoring headers.json
  actually restores *stale* headers.
* Because headers are mutated on the shared instance, concurrent calls race on
  `X-ZCSRF-TOKEN`. This is harmless while the token is stable, and wrong for one request when
  it rotates.

How the server handles it (`server/src/arattai/arattix-gateway.ts`, `session/session-store.ts`):

* Persists **only the cookie jar** (plus User-Agent), never headers, encrypted with
  AES-256-GCM. The key is derived from `MASTER_KEY`, and the ciphertext is bound to the
  session id, so a copied blob does not decrypt in another slot.
* Re-derives CSRF with `bot.setupCsrf()` on every restore and login.
* Re-persists the jar after each successful heartbeat when the cookies changed, so a cookie
  rotated by Arattai survives a restart.
* Supports key rotation (`MASTER_KEY_PREVIOUS`). Old blobs are re-encrypted on first read.

---

## 2. Defects found

### Fixed in this branch (library)

| # | Location | Defect | Impact | Fix / test |
|---|---|---|---|---|
| 1 | `src/index.js`, `src/Socket/index.js` | `require('./Auth')` but the directory is `auth/` | **Library cannot be loaded on Linux** (case-sensitive FS), including the shipped Docker image | Path fixed; every server test loads it |
| 2 | `src/auth/session-manager.js` `testCookies` | `validateStatus: s < 400` accepted the 3xx login redirect as valid; cookies loaded twice | Expired sessions reported valid: the bot never re-prompts for QR and fails later | Only 2xx is valid |
| 3 | `src/Socket/index.js` `loginWithQr` | Session saved even when QR login failed | Overwrote a good session with a half-authenticated one | Save only on success |
| 4 | `src/Socket/index.js` | `isShowQr` was ignored; the QR always printed | QR (a login credential) leaked into logs of headless deployments | Passed through to `QRLogin` |
| 5 | `src/Socket/index.js` | No default timeout on the axios instance | A stalled TCP connection hangs the caller forever (and the heartbeat with it) | `timeout: DEFAULT_TIMEOUT`; uploads use `MEDIA_TIMEOUT` |
| 6 | `src/Socket/messages.js` | `msgid` / `upload-id` = `Date.now()` | Concurrent sends in the same millisecond share an id | Monotonic id; `gateway.test.ts` fires a concurrent burst |
| 7 | `src/auth/qr-login.js` | QR polling loop was monolithic: no way to step, observe or cancel it | Unusable from a server (no deadline, prints to stdout) | `pollOnce()` added; `validateQr()` is now a loop over it |
| 8 | `src/Socket/messages.js` | Uploads buffered whole files in memory | 64 MB upload = 64 MB+ heap per request | `sendStream()` with exact `Content-Length` |
| 9 | `Example/docker-bot.js` | `require('./')` / `require('./src/...')` from inside `Example/` | The root Docker image's `CMD` crashes on start | Paths fixed |
| 20 | `src/Defaults` `MESSAGES_API` / `ATTACHMENTS_URL` | Ids were interpolated into the URL path unencoded | A crafted id (`../x`, `a?b`) could point an authenticated request at another path | `encodeURIComponent`; the server also refuses dot-only ids. `test/library.test.js` |
| 21 | `src/Socket/bot.js` `_parseMediaResponse` | `filename*=UTF-8''na%C3%AFve.png` was returned as `UTF-8` | Wrong download names | RFC 5987 parsing, quoted and bare names. `test/library.test.js` |
| 22 | `src/Socket/bot.js` `_createFreshSession` | Fresh sessions had no timeout | `fetchChatsLive*` could hang forever | Inherits the session timeout |
| 23 | `src/auth/session-manager.js` | `cookies.json` / `headers.json` written world-readable (`0644`) | Any local user could read the live login | Written `0600`, older files tightened. `test/library.test.js` |
| 24 | `Example/docker-bot.js` | Passed `HTTP_PROXY` as `proxy` (throws, see 10); `setInterval` polling overlapped and its rejections were unhandled | Crash on start when `HTTP_PROXY` is set; duplicate command replies; crash on the first network error | No proxy option; sequential polling loop with error handling |

### Not fixed (out of scope, worked around or documented)

| # | Location | Defect | Impact | Server handling |
|---|---|---|---|---|
| 10 | `src/Socket/index.js` | `proxy` option cannot work: `axios-cookiejar-support` rejects custom agents | Proxy support was dead code that failed with `Cannot find module 'https-proxy-agent'` | Now fails fast with a clear message; use an egress proxy at the network layer |
| 11 | `axios-cookiejar-support` | Creates a **new HTTP agent per request**, so no keep-alive | Every call is a fresh TCP + TLS handshake: latency, plus a "new connection" pattern | Request volume is minimised (pacing, bounded polling) |
| 12 | `Bot.fetchMessages` | Non-JSON body (login page) becomes `[]` | **Expired session looks like "no new messages"** | Gateway calls the endpoint itself and classifies the body |
| 13 | `ChatManager.parseChatData` | Swallows parse errors (`console.error`); one malformed chat used to drop every chat after it | Contract drift is invisible | Bad rows are now skipped one by one; the server uses its own parser that raises `UPSTREAM_CONTRACT_CHANGED` on envelope drift |
| 14 | `Bot.downloadMedia` | Fallback endpoint hides the primary error | Misleading errors | Accepted; errors are classified from the fallback |
| 15 | `Bot.fetchChats*` | `_refreshCsrf()` (an extra `GET /`) on **every** call | Doubles request volume | Chat list fetched every `POLL_CHATLIST_EVERY` ticks only |
| 16 | `Bot.fetchChatsLive*` | Builds a brand-new server session per call | Session churn | Not used by the server |
| 17 | `SessionManager` | Plaintext `cookies.json` / `headers.json` in CWD (now `0600`, see 23) | Credential exposure via volumes and backups | Server never uses it; encrypted store instead |
| 18 | root `Dockerfile` | `npm ci` without a lockfile (deleted in `8fa1415`) | Image build fails | Server image (`server/Dockerfile`) installs the root with `npm install` |
| 19 | `Example/*` | Polls every chat every 3 s (30 chats ≈ 10 req/s) | Looks like abuse; risks flagging | Poller fetches at most `POLL_CHATS_PER_TICK` chats per tick |

---

## 3. Single points of failure and failure domains

| Failure | Library behaviour | Server mitigation | Where |
|---|---|---|---|
| **Session expired / revoked** | Silent `[]`, or an HTML login page parsed as data | Every path classifies 401/403, login redirects and HTML bodies as `SESSION_EXPIRED`. Heartbeat probes `GET /` (no redirects) + `GET /v1/chats`. A job that sees expiry triggers an immediate re-check, so one odd response cannot log the account out. Result: `DISCONNECTED(SESSION_EXPIRED)` + `session.state_changed` webhook | `classify.ts`, `connection-manager.ts` |
| **No heartbeat** | Nothing notices a dead session until a user action fails | Heartbeat every `HEARTBEAT_INTERVAL_MS` with its own timeout; `HEARTBEAT_FAILURE_THRESHOLD` consecutive transient failures → reconnect | `connection-manager.ts` |
| **Network partition / stalled socket** | Hangs (no timeout) | Timeouts everywhere; reconnect with exponential backoff and jitter (capped at `RECONNECT_MAX_MS`); flows are cancellable (generation counter + AbortController) | `connection-manager.ts` |
| **Upstream 5xx / 429 storms** | Each caller fails independently | Circuit breaker (`CIRCUIT_FAILURE_THRESHOLD`, `CIRCUIT_COOLDOWN_MS`) fails fast with 503 + `Retry-After`; 429 `Retry-After` honoured | `circuit-breaker.ts` |
| **Ambiguous send** (timeout after the request left) | Caller may retry and **double-send** | Classified `UPSTREAM_TIMEOUT_AMBIGUOUS`, never auto-retried; clients retry safely with `Idempotency-Key` | `classify.ts`, `jobs/commands.ts` |
| **Process crash** | Session in memory only; re-login | Encrypted session persisted on login and on cookie rotation; poller cursors persisted; BullMQ jobs survive; a broadcast re-run maps recipients to their existing child jobs (deterministic ids), so **no duplicates** | `session-store.ts`, `poller.ts`, `handlers.ts` |
| **Two processes on one account** (PM2 cluster, a second container) | Both log in, race CSRF, double-poll, double-deliver | Redis lease: one owner, the rest on standby (alive, not ready). If renewal fails the owner exits (fencing) and the supervisor restarts it into standby | `session/lease.ts`, `runtime.ts` |
| **Unbounded memory** ("socket leaks") | There are no long-lived sockets; the leak risks are unbounded maps and buffers | Seen-sets capped (200 ids × 1 000 chats); throttle map pruned; queue retention bounded; uploads streamed from disk; spool swept (`SPOOL_MAX_AGE_MS`) | various |
| **Stale CSRF** | Refreshed on every chat-list call only | Re-derived on restore/login; the heartbeat's `GET /` refreshes the cookie, and rotated cookies are persisted | gateway, heartbeat |
| **QR flow abandoned** | Infinite loop | `QR_TIMEOUT_MS` deadline → `DISCONNECTED(QR_TIMEOUT)`; `force` restarts it | `connection-manager.ts` |
| **Redis outage** (split mode) | n/a | API `/health/ready` → 503; BullMQ reconnects; a worker that cannot renew its lease within `LEASE_TTL_MS` exits by design (split-brain safety) | `lease.ts` |
| **Worker down** (split mode) | n/a | API answers `503 WORKER_UNAVAILABLE` instead of queueing into the void; queued sends carry a TTL (`MESSAGE_TTL_MS`) so they are not delivered hours late | `routes.ts`, `handlers.ts` |
| **Webhook receiver down** | n/a | Exponential retries; 410 or `WEBHOOK_MAX_CONSECUTIVE_FAILURES` auto-disables the subscription; SSRF guard checks the IP each socket actually connects to | `webhooks/` |

---

## 4. Mitigation strategy for Arattai/Zoho contract changes

There is no DOM to break; the fragile surface is a handful of private HTTP endpoints. The strategy
is to **isolate, detect, hot-patch, degrade, repair**.

1. **Isolate.** Only `server/src/arattai/` knows URLs, cookies, CSRF or JSON shapes. Everything
   else talks to the `ArattaiGateway` interface. A contract change is one file, not a refactor.

2. **Detect, and distinguish drift from expiry.** `normalize.ts` validates every envelope. A
   changed shape raises `UPSTREAM_CONTRACT_CHANGED`, which is deliberately *not* `SESSION_EXPIRED`,
   so drift never logs the account out. The heartbeat is a canary that runs the core contract
   (`GET /`, `GET /v1/chats`) every minute. Alert on:
   ```promql
   increase(arattai_upstream_errors_total{code="UPSTREAM_CONTRACT_CHANGED"}[10m]) > 0
   ```

3. **Hot-patch without a release.**
   * `ARATTAI_ENDPOINT_OVERRIDES='{"SEND_MESSAGE_URL":"https://…","MESSAGES_API":"https://…/{chatId}/…"}'`
     re-points any library endpoint, function-valued ones via `{chatId}` / `{fileId}` templates.
     Unknown keys and type mismatches fail at boot.
   * `ARATTAI_USER_AGENT` bumps the browser fingerprint if old UAs get rejected.

4. **Degrade instead of failing hard.** A malformed row in a list is skipped, not fatal. A
   contract error during restore keeps retrying with backoff while you patch. Unsupported
   operations are capability-flagged (`GET /api/v1/capabilities`) and answer 501.

5. **Repair loop.**
   1. Open web.arattai.in in a browser, reproduce the action, export a HAR.
   2. Update `server/test/gateway.test.ts`, the mock Arattai that serves as the **executable
      contract** (QR, CSRF, chats, messages, send, upload, download), to the new behaviour. Watch
      it fail.
   3. Update the gateway / `normalize.ts` until it passes, then ship.

   The same loop is how reactions and group management get implemented: capture the request,
   add it to the mock, implement the gateway method, flip the capability flag.

6. **Canary.** Run a second deployment against a test account with a synthetic
   `POST /messages/send` to a private chat every few minutes and alert on its failure. It catches
   breakage before customer traffic does.

---

## 5. Known limitations

* **Inbound latency equals the poll interval.** If more than `POLL_MESSAGE_LIMIT` messages arrive
  in one chat between two polls of that chat, older ones are missed. This is detected
  (`gapDetected: true` on the event, `arattai_poll_gaps_total`), not prevented.
* **No delivery or read receipts.** The library exposes none. `message.sent` means "Arattai
  accepted the request".
* **Logout is local.** The library has no logout endpoint; revoke the session from the Arattai app
  for a hard logout.
* **One account per `SESSION_ID`.** For multiple accounts, run one worker per `SESSION_ID`
  (API processes are also per `SESSION_ID`, since it selects the queues).
* **Pacing defaults are conservative guesses.** Arattai publishes no rate limits; tune
  `SEND_RATE_PER_MINUTE` and friends from observation.
* The HTTP API rate limiter is per process (in-memory). With N API processes the effective
  limit is N × `HTTP_RATE_LIMIT_PER_MINUTE`.
