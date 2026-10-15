# arattix-server

A production REST API around the [arattix](../) library: QR authentication with persistent
encrypted sessions, paced outbound messaging and media, broadcasts, inbound events delivered as
signed webhooks, an admin web UI, and an operations story (health, metrics, graceful shutdown,
failover).

> **Read [AUDIT.md](AUDIT.md) first.** arattix is an **HTTP** client (axios + cookie jar), not a
> browser or WebSocket automation. Inbound events therefore come from **polling**. Group
> management and reactions have **no verified Arattai endpoint** in the library, so those routes
> exist but answer `501 CAPABILITY_UNAVAILABLE` until implemented (see AUDIT §4).

* **Admin web UI:** `http://<host>:3000/ui/`, see [Admin web UI](#admin-web-ui)
* **API reference:** [API_REFERENCE.md](API_REFERENCE.md), with every endpoint, cURL example and response shape
* **Codebase review and failure domains:** [AUDIT.md](AUDIT.md)

---

## Architecture

```
                        ┌──────────────── API tier (stateless, clusterable) ────────────────┐
  clients ──HTTPS──▶    │ Express 5 · API-key auth · rate limit · Zod validation · multer   │
                        │ CommandBus: HTTP request → job (sync wait ≤ SYNC_WAIT_TIMEOUT_MS)  │
                        └───────────────┬───────────────────────────────▲───────────────────┘
                                        │ jobs                          │ status / results
                         ┌──────────────▼───────────────────────────────┴──────────────┐
                         │      Queues (memory | BullMQ)  +  KV store (file | Redis)    │
                         │  control · outbound · broadcast · webhooks                   │
                         └──────────────┬───────────────────────────────────────────────┘
                                        │ consumed only by the lease holder
                        ┌───────────────▼──── Session worker (exactly one per account) ────┐
                        │ ConnectionManager  DISCONNECTED→CONNECTING→QR_READY→AUTHENTICATED │
                        │                    →SYNCING→READY · heartbeat · backoff · circuit │
                        │ SendThrottle       token bucket + per-chat spacing + jitter       │
                        │ InboundPoller      bounded polling → message.received events      │
                        │ WebhookDispatcher  fan-out → signed POST, retries, SSRF guard     │
                        │ ArattixGateway ─── the only code that talks to Arattai ───────────┼──▶ Arattai
                        └───────────────────────────────────────────────────────────────────┘
```

**Why a single session worker?** One Arattai account is one cookie session. Two processes
driving it would race CSRF tokens, double-poll inbound messages and double-deliver webhooks. A
Redis lease (`session/lease.ts`) guarantees one owner; extra workers wait on standby and take over
when the owner dies.

**Why Node.js + Express, not Deno + Hono?** Evaluated on 2026-10-10. The library and this server
already run unmodified on Deno 2.9 (cookie jar, multipart uploads, admin UI and API all worked),
so compatibility is not the issue; the question is what a migration buys. For one private VPS
the answer is little: Deno's permission sandbox and built-in TypeScript are real, but the Docker
image already runs as an unprivileged user with no browser, and `tsc` is a single dev
dependency. The cost is a rewrite of every Express-coupled piece (routes, auth, rate limiting,
multer's streaming uploads, the `supertest` suites) plus BullMQ/ioredis on a less-trodden
runtime, all with no user-visible gain. Node 22 LTS + Express 5 stays.

**Roles** (`ROLE`):

| Role | Runs | Needs | Use |
|---|---|---|---|
| `all` (default) | API + worker in one process | nothing (file store, memory queue) | single host, simplest |
| `api` | HTTP API only, produces jobs | Redis | scale horizontally (PM2 cluster, replicas) |
| `worker` | session, queues, poller, webhooks + health/metrics on `WORKER_PORT` | Redis | exactly one active per `SESSION_ID` |

### Connection state machine

```
             start()/restore                   startQrLogin()
 DISCONNECTED ─────────────▶ CONNECTING ◀─────────────────────── (any state, force=true)
      ▲  ▲                    │      │  QR issued
      │  │ SESSION_EXPIRED     │      ▼
      │  │ NO_SESSION          │   QR_READY ──(refresh: new QR, same state)
      │  │ QR_TIMEOUT          │      │ approved on phone
      │  │ LOGGED_OUT          ▼      ▼
      │  └──────────────── AUTHENTICATED ──▶ SYNCING ──▶ READY ──heartbeat──┐
      │                         ▲                         │  ▲              │
      │                         └── reconnect (backoff) ──┘  └──── ok ──────┘
      └──────── heartbeat sees expired session ───────────┘
```

Every transition is published as a `session.state_changed` event (webhooks) and as the
`arattai_session_state` metric.

---

## File structure

```
server/
├── src/
│   ├── index.ts                 entrypoint: config, signals, crash-only error handling, PM2 ready
│   ├── runtime.ts               wiring by ROLE; start (listen → lease → consume) / stop (drain)
│   ├── config.ts                Zod-validated environment (fails fast with every problem listed)
│   ├── logger.ts                Winston; JSON in production; redacts cookies/tokens/secrets/QR
│   ├── errors.ts                AppError model, wire format across the queue boundary
│   ├── crypto.ts                AES-256-GCM at rest (HKDF, key ids, rotation), HMAC, safeEqual
│   ├── circuit-breaker.ts       consecutive-failure breaker (CLOSED/OPEN/HALF_OPEN)
│   ├── metrics.ts               Prometheus text exporter (no dependency)
│   ├── kv.ts                    KeyValueStore: Memory | File (atomic, 0600) | Redis (SCAN)
│   ├── util.ts                  abortable sleep, backoff with jitter, timeouts
│   ├── settings.ts              settings catalogue; overrides saved from the UI, applied at start
│   ├── activity/
│   │   ├── recent.ts            capped log/event feeds: memory, or Redis (shared by all processes)
│   │   └── activity.ts          Winston transport and event recorder feeding them
│   ├── arattai/                 ── the upstream boundary ──
│   │   ├── gateway.ts           ArattaiGateway interface + domain types + capabilities
│   │   ├── arattix-gateway.ts   implementation over the arattix library; endpoint overrides
│   │   ├── classify.ts          axios/HTTP errors → AppError (retryable vs ambiguous)
│   │   ├── normalize.ts         tolerant parsers that detect contract drift
│   │   └── arattix.d.ts         types for the untyped JS library
│   ├── session/
│   │   ├── connection-manager.ts  state machine, QR flow, heartbeat, reconnect, persistence
│   │   ├── session-store.ts     encrypted cookie-jar persistence
│   │   ├── status.ts            status model + reader for API-only processes
│   │   └── lease.ts             Redis single-owner lease with renewal and fencing
│   ├── queue/                   JobQueue interface; memory and BullMQ implementations
│   ├── jobs/
│   │   ├── contracts.ts         queue kinds, job payloads, public job ids
│   │   ├── commands.ts          API side: submit + optional sync wait + idempotency keys
│   │   └── handlers.ts          worker side: control / outbound / broadcast handlers
│   ├── outbound/throttle.ts     token bucket + per-chat spacing + jitter
│   ├── events/
│   │   ├── bus.ts               typed in-process event bus, event catalogue
│   │   └── poller.ts            inbound polling with persisted cursors and gap detection
│   ├── webhooks/
│   │   ├── store.ts             subscriptions (secrets encrypted at rest)
│   │   ├── dispatcher.ts        fan-out and delivery (retry policy, auto-disable)
│   │   ├── signature.ts         X-Arattai-Signature sign/verify
│   │   ├── url-guard.ts         SSRF policy + connect-time DNS guard
│   │   └── http-post.ts         bounded, redirect-free POST
│   ├── media/spool.ts           upload/download spool with path confinement and sweeper
│   └── http/
│       ├── app.ts               health, metrics, /api/v1 mounting, error handling
│       ├── routes.ts            messaging, auth, groups, broadcasts, jobs, webhooks endpoints
│       ├── admin-routes.ts      system, tasks (list/retry/cancel), logs, events, settings, restart
│       ├── schemas.ts           Zod request schemas
│       └── middleware.ts        request id, access log, API keys, rate limit, uploads, errors
├── public/                      admin web UI (static, no build step): index.html, app.js, app.css
├── test/                        Vitest: unit, lifecycle, webhooks, API, admin, mock-Arattai, Redis
├── Dockerfile                   multi-stage, non-root, no browser; build from repo root
├── docker-compose.yml           Redis + API + worker
├── ecosystem.config.cjs         PM2: clustered API + single worker, or single process
├── .env.example                 every setting, documented
├── API_REFERENCE.md
└── AUDIT.md
```

---

## Quick start (single process)

Requirements: Node.js ≥ 20.

```bash
# from the repository root
npm install                         # library dependencies
cd server
npm ci
cp .env.example .env
sed -i "s/^API_KEYS=.*/API_KEYS=$(openssl rand -hex 24)/" .env
sed -i "s/^MASTER_KEY=.*/MASTER_KEY=$(openssl rand -hex 32)/" .env
npm run build
node --env-file=.env dist/index.js
```

Then log in:

```bash
KEY=$(grep ^API_KEYS .env | cut -d= -f2 | cut -d, -f1)
curl -s -X POST localhost:3000/api/v1/auth/session -H "Authorization: Bearer $KEY" | jq -r '.data.result.qr.dataUrl'
# open the data URL in a browser (or render .qr.data as a QR code) and scan it in the Arattai app
curl -s localhost:3000/api/v1/auth/status -H "Authorization: Bearer $KEY" | jq .data.state   # → "READY"
curl -s -X POST localhost:3000/api/v1/messages/send -H "Authorization: Bearer $KEY" \
     -H 'Content-Type: application/json' -d '{"chatId":"CT_…","text":"Hello from arattix-server"}'
```

Restart the process: the session is restored from `DATA_DIR` without a new scan.

Or open `http://localhost:3000/ui/`, sign in with the API key and use **Arattai login**.

---

## Admin web UI

The server hosts a browser UI at **`/ui/`** (`/` redirects there). It is static files with no
data of its own: every page calls `/api/v1` with an API key that the operator types in once and
that stays in that browser (tab only, or "remember on this device"). Turn it off with
`UI_ENABLED=false`. Pages are served with a strict Content-Security-Policy (no inline script,
same-origin only, no framing).

| Page | What you can do |
|---|---|
| Dashboard | Session state, worker and circuit, server version/role/uptime/memory, queue counts, capabilities, recent events and warnings |
| Arattai login | Start a QR login (the QR is shown on the page and refreshes itself), force a new QR, log out, see heartbeat, reconnect and last error |
| Chats | Browse chats and recent messages, download attachments, reply with text or a file |
| Send & broadcast | Send text or media (sync or async, TTL, Idempotency-Key), run a broadcast with live progress and per-recipient results; reactions and groups show as unavailable until the library supports them |
| Tasks | Every queued job across `control`, `outbound`, `broadcast` and `webhooks`: filter by queue, state and name, inspect payload/result/error, **retry** failed jobs, **cancel** waiting ones |
| Logs | Live tail of server logs (redacted), filter by level, component and text, download as JSON |
| Events | Live feed of `message.*`, `session.*` and `broadcast.*` events (QR payloads stripped) |
| Webhooks | Add (secret shown once), test, delete subscriptions; delivery status and failures |
| Settings | Every setting with its source (env, default, override). Tunables can be edited: they are validated as a whole, stored, and applied at the next start; `LOG_LEVEL` applies immediately. Secrets, topology and `ARATTAI_ENDPOINT_OVERRIDES` stay environment-only. **Restart server** asks the supervisor for a graceful restart |

Logs and events shown in the UI come from capped buffers (`LOG_BUFFER_SIZE`,
`EVENT_BUFFER_SIZE`). With `STORE_DRIVER=redis` the buffers live in Redis, so an API process
shows what the session worker logged. Settings saved in the UI are stored in the key-value store
(`settings:overrides`) and win over the environment; a stored value that no longer validates is
ignored at boot with an error log, never blocking startup.

**Restart** shuts the process down gracefully and relies on its supervisor (Docker
`restart: unless-stopped`, PM2, systemd, Kubernetes) to start it again. In a split deployment it
restarts only the API process that received it; restart the worker too to apply its settings.

---

## Configuration

Every variable, with defaults and explanations, is in [`.env.example`](.env.example). Config is
validated at boot. Invalid config exits with code 78 and lists every problem, so a supervisor
does not hot-loop on it.

| Group | Key settings |
|---|---|
| Required | `API_KEYS` (comma-separated, ≥ 24 chars each), `MASTER_KEY` (32 bytes hex/base64) |
| Topology | `ROLE`, `SESSION_ID`, `STORE_DRIVER`, `QUEUE_DRIVER`, `REDIS_URL`, `DATA_DIR` |
| Lifecycle | `HEARTBEAT_*`, `RECONNECT_BASE_MS` / `RECONNECT_MAX_MS`, `CIRCUIT_*`, `QR_TIMEOUT_MS` |
| Pacing | `SEND_RATE_PER_MINUTE`, `SEND_BURST`, `SEND_PER_CHAT_INTERVAL_MS`, `SEND_JITTER_MS`, `MESSAGE_TTL_MS` |
| Inbound | `POLL_*`, `SELF_USER_ID` |
| Webhooks | `WEBHOOK_*` (`WEBHOOK_ALLOW_HTTP` / `WEBHOOK_ALLOW_PRIVATE` are for development only) |
| Hot-fixes | `ARATTAI_ENDPOINT_OVERRIDES`, `ARATTAI_USER_AGENT` |
| Admin UI | `UI_ENABLED`, `LOG_BUFFER_SIZE`, `EVENT_BUFFER_SIZE` |

Tunables (not secrets or topology) can also be changed from the UI's Settings page or
`PUT /api/v1/settings`; those stored overrides take precedence over the environment.

---

## Deployment

### Private VPS (recommended)

One process (`ROLE=all`, file store, in-memory queue) behind Caddy for automatic HTTPS. No Redis
needed. On a fresh Ubuntu/Debian VPS with Docker installed and a DNS record (here
`arattix.example.com`) pointing at it:

```bash
git clone git@github.com:powerhousebolt/Arattix.git && cd Arattix
cp server/.env.example server/.env
sed -i "s/^API_KEYS=.*/API_KEYS=$(openssl rand -hex 24)/" server/.env
sed -i "s/^MASTER_KEY=.*/MASTER_KEY=$(openssl rand -hex 32)/" server/.env
sed -i "s/^TRUST_PROXY=.*/TRUST_PROXY=1/" server/.env          # Caddy is the one proxy hop
echo "DOMAIN=arattix.example.com" > .env

sudo ufw allow OpenSSH && sudo ufw allow 80,443/tcp && sudo ufw allow 443/udp && sudo ufw enable
docker compose --profile server --profile https up -d --build
docker compose --profile server logs -f server                 # watch it come up
```

Open `https://arattix.example.com/ui/`, sign in with the key from `API_KEYS` and scan the QR on
the **Arattai login** page. The server itself listens on `127.0.0.1:3000` only; the internet
reaches it through Caddy on 443. Without a domain, skip the `https` profile and use an SSH
tunnel instead: `ssh -L 3000:127.0.0.1:3000 your-vps`, then open `http://localhost:3000/ui/`.

* **Keep safe:** `server/.env` (`MASTER_KEY` decrypts the stored session; losing it means a new
  QR scan) and the `arattix_server-data` volume (session, webhooks, settings). Back up both:
  `docker run --rm -v arattix_server-data:/data -v "$PWD:/backup" alpine tar czf /backup/arattix-data.tgz -C /data .`
* **Update:** `git pull && docker compose --profile server --profile https up -d --build`. The
  session survives the restart, so no new scan is needed.
* **Wrong keys:** a client IP that presents 20 wrong API keys within 15 minutes is locked out
  (429) for the rest of that window. This depends on `TRUST_PROXY=1` above; without it every
  visitor shares Caddy's IP.
* **Prebuilt image:** CI pushes `ghcr.io/powerhousebolt/arattix-server` on every push to `main`
  (private while the repository is). Building on the VPS as above avoids registry credentials.

### Docker (single process)

With the repository's root `docker-compose.yml` (reads `server/.env`, keeps state in the
`server-data` volume, publishes `SERVER_PORT`, default 3000, on `127.0.0.1` only; set
`SERVER_BIND=0.0.0.0` in `./.env` to expose it on a private network):

```bash
cp server/.env.example server/.env    # set API_KEYS and MASTER_KEY
docker compose --profile server up -d --build server
```

Or plain Docker:

```bash
docker build -f server/Dockerfile -t arattix-server .          # from the repository root
docker run -d --name arattix --init -p 3000:3000 \
  -e API_KEYS=… -e MASTER_KEY=… -v arattix-data:/data \
  --stop-timeout 35 arattix-server
```

Image notes: multi-stage `node:22-alpine`, production dependencies only, runs as `node` (uid
1000), state in the `/data` volume, `HEALTHCHECK` on `/health/live`, JSON logs to stdout. **No
Chromium**: the library never needs a browser, which saves ~400 MB and a large attack surface.

### Docker Compose (split: Redis + API + worker)

```bash
cp server/.env.example server/.env    # set API_KEYS and MASTER_KEY
docker compose -f server/docker-compose.yml up -d --build
```

The API port is published on `127.0.0.1:3000` with `TRUST_PROXY=1`, for one reverse proxy on the
same host. To run several API replicas, drop its `ports:` and put the proxy on the compose
network. The API and worker share the `spool` volume: uploads land on the API side and are
streamed to Arattai by the worker.

### PM2 (one host)

```bash
cd server && npm ci && npm run build
pm2 start ecosystem.config.cjs --only arattix-api,arattix-worker   # needs REDIS_URL in .env
# or, without Redis:
pm2 start ecosystem.config.cjs --only arattix-all
pm2 save
```

* `arattix-api` runs in **cluster mode** (`instances: max`, override with `API_INSTANCES`). It is
  stateless, so any number is safe.
* `arattix-worker` runs in **fork mode with exactly one instance**. Never cluster it: extra
  instances only sit on standby.
* `wait_ready` + `process.send('ready')`, `kill_timeout: 30000` (above `SHUTDOWN_TIMEOUT_MS`),
  `exp_backoff_restart_delay`, `max_memory_restart: 512M`.
* Zero-downtime API deploys: `pm2 reload arattix-api`. Worker deploys: `pm2 restart arattix-worker`.
  The session is persisted, so a restart costs one restore (~1 s), not a QR scan.

### Kubernetes notes

API: a `Deployment` with any replica count, readiness on `/health/ready`, liveness on
`/health/live`. Worker: a `Deployment` with `replicas: 1` (a second replica is a hot standby: live
but not ready), `terminationGracePeriodSeconds: 35`. Shared spool: a `ReadWriteMany` volume, or
co-locate API and worker in one pod.

### Scale parameters

| Dimension | How it scales | Limit |
|---|---|---|
| HTTP throughput | add API processes | Redis and the worker's queue consumption |
| Outbound messages | `SEND_RATE_PER_MINUTE` (one account) | the account itself, so stay conservative (default 20/min) |
| Accounts | one worker (+ API) per `SESSION_ID` | Redis memory; keys are namespaced |
| Inbound latency | `POLL_INTERVAL_MS`, `POLL_CHATS_PER_TICK` | request volume per account; see the AUDIT on flagging |
| Backlog | `QUEUE_MAX_PENDING` (503 `QUEUE_FULL` beyond) | Redis memory |
| Upload size | `MEDIA_MAX_BYTES` (streamed, not buffered) | spool disk |

---

## Logging

Winston, one JSON object per line in production (`LOG_FORMAT=json`), human-readable with
`LOG_FORMAT=pretty`.

```json
{"level":"warn","message":"Heartbeat failed","component":"connection","failures":1,"code":"UPSTREAM_TIMEOUT","role":"worker","sessionId":"default","pid":1,"timestamp":"2026-10-10T10:20:05.118Z"}
```

| `LOG_LEVEL` | Shows |
|---|---|
| `error` | crashes, lost lease, contract drift, persistence failures |
| `warn` | heartbeat failures, retries, circuit transitions, webhook failures |
| `info` (default) | state transitions, startup/shutdown, lease changes |
| `http` | + one access-log line per request (method, path, status, duration, requestId, apiKeyId) |
| `debug` | + health-probe access logs |

Keys such as `cookie`, `authorization`, `secret`, `token`, `qr`, `dataUrl` and `x-zcsrf-token`
are redacted at any depth. API keys are logged only as a 12-character hash (`apiKeyId`). Every
response carries `X-Request-Id` (incoming ids are honoured) for correlation.

## Metrics and health

* `GET /health/live`: process is up (liveness).
* `GET /health/ready`: store, queue and lease checks (readiness); `?requireSession=true`
  additionally requires `READY`.
* `GET /metrics`: Prometheus text format. With `METRICS_TOKEN` set it needs
  `Authorization: Bearer <token>`; without it, only loopback and private-network clients may read
  it (others get `403 METRICS_FORBIDDEN`), so it never leaks through the public HTTPS proxy. Key series:
  `arattai_session_state{state}`, `arattai_heartbeats_total{result}`,
  `arattai_upstream_errors_total{operation,code}`, `arattai_circuit_open`,
  `arattai_outbound_total{job,result}`, `arattai_inbound_messages_total`,
  `arattai_poll_gaps_total`, `webhook_deliveries_total{result}`,
  `http_requests_total{method,route,status}`.

Suggested alerts:

```promql
arattai_session_state{state="READY"} == 0                                          # for 5m
increase(arattai_upstream_errors_total{code="UPSTREAM_CONTRACT_CHANGED"}[10m]) > 0
arattai_circuit_open == 1                                                          # for 5m
increase(webhook_deliveries_total{result="failure"}[15m]) > 50
```

---

## Operational runbooks

### 1. Session disconnected (`state=DISCONNECTED`)

Check `reason` in `GET /api/v1/auth/status`:

| reason | Meaning | Action |
|---|---|---|
| `SESSION_EXPIRED` | Arattai no longer accepts the cookies (signed out on the phone, expired, revoked) | Re-scan: `POST /api/v1/auth/session` and scan the QR. Sends answer 409 until `READY`. |
| `NO_SESSION` | Nothing stored (first boot, or after logout) | Same as above. |
| `QR_TIMEOUT` | Nobody scanned within `QR_TIMEOUT_MS` | `POST /api/v1/auth/session` again. |
| `QR_INIT_FAILED` / `QR_POLL_FAILED` | Arattai accounts endpoint failing | Check `lastError`; see runbook 3; retry. |
| `SESSION_CORRUPT` | Stored blob unreadable (wrong `MASTER_KEY`?) | Restore the right `MASTER_KEY` (runbook 6) or re-scan. |
| `LOGGED_OUT` | Someone called `DELETE /auth/session` | Re-scan if unintended. |
| `SHUTDOWN` | Process stopped | None. |

Automate it: subscribe a webhook to `session.state_changed` and page when `to` is
`DISCONNECTED`. To show the QR in a headless operator tool, subscribe to `session.qr` **by name**
(the `*` wildcard never delivers QR codes).

### 2. "Refreshing expired cookies"

There is no cookie-refresh call to make. The cookie jar is refreshed **automatically**: Arattai
rotates cookies on normal traffic, and the worker re-persists the jar after every successful
heartbeat when it changed. Once Arattai rejects the session (`SESSION_EXPIRED`), the only remedy
is a new QR scan. Re-sending old cookies cannot revive it. To force a clean login anyway:
`POST /api/v1/auth/session` with `{"force": true}`.

### 3. Stuck in `CONNECTING` / circuit open

`reason=RETRY_BACKOFF` with `reconnect.attempt` climbing and `circuit=OPEN` means Arattai is
unreachable or failing. The worker retries with capped exponential backoff on its own.

1. `lastError.code`: `UPSTREAM_UNREACHABLE` (DNS/network), `UPSTREAM_ERROR` (5xx),
   `UPSTREAM_RATE_LIMITED` (429; slow down `SEND_RATE_PER_MINUTE`), `UPSTREAM_CONTRACT_CHANGED`
   (runbook 4).
2. From the worker host: `curl -sI https://web.arattai.in/` to rule out egress/DNS problems.
3. Do **not** re-scan. The session is probably still valid, and re-login adds load.

### 4. Arattai changed its API (`UPSTREAM_CONTRACT_CHANGED`)

Follow AUDIT §4: confirm with a HAR capture, hot-patch with `ARATTAI_ENDPOINT_OVERRIDES` if only
a URL moved, otherwise update `arattai/normalize.ts` and `test/gateway.test.ts` and ship. The
session stays valid meanwhile; nothing is logged out.

### 5. Queue backlog / `QUEUE_FULL`

`GET /health/ready` and the metrics show it. Sends are paced by design (default 20/min), so a
1 000-recipient broadcast takes ≥ 50 min. Options: raise `QUEUE_MAX_PENDING` (Redis memory),
carefully raise `SEND_RATE_PER_MINUTE`, or let `MESSAGE_TTL_MS` expire stale sends.
`GET /api/v1/jobs/:id` shows individual jobs.

### 6. Rotating `MASTER_KEY`

1. Set `MASTER_KEY_PREVIOUS=<old>` and `MASTER_KEY=<new>`; restart.
2. The session blob is re-encrypted with the new key on the next restore (automatic).
3. Webhook signing secrets keep decrypting with `MASTER_KEY_PREVIOUS` but are **not**
   re-encrypted automatically. Re-create each subscription (new secret, encrypted with the new
   key) and roll the secret out to its receiver.
4. Then remove `MASTER_KEY_PREVIOUS` and restart.

Lost `MASTER_KEY`: the session must be re-scanned and webhooks re-created. Nothing else is
recoverable, by design.

### 7. Rotating API keys

`API_KEYS` accepts several keys. Add the new one, deploy (`pm2 reload arattix-api`), move
clients over, remove the old one, deploy again.

### 8. Worker failover

The active worker holds `arattix:<SESSION_ID>:lease` (TTL `LEASE_TTL_MS`, renewed every TTL/3).
On crash, a standby takes over within one TTL. On a graceful stop it takes over immediately.
`/health/ready` on a standby reports `lease: "standby: …"`. If renewal fails (Redis outage longer
than the TTL), the worker **exits on purpose** rather than risk two owners. The supervisor
restarts it into standby or ownership.

### 9. Webhook subscription disabled

`GET /api/v1/webhooks/:id` → `active: false` with `disabledReason` (410 Gone, too many consecutive
failures, or a URL that now resolves to a private address). Fix the receiver, then re-subscribe
(and delete the old subscription). `POST /api/v1/webhooks/:id/test` checks a receiver on demand.

---

## Testing

```bash
cd server
npm test                                    # 95 tests; the Redis suite is skipped
REDIS_URL=redis://127.0.0.1:6379 npm test   # all 107 (use a disposable Redis)
npm run typecheck
npm --prefix .. run test:lib                # library unit tests (node:test)
```

| Suite | Covers |
|---|---|
| `primitives` | crypto (AAD, tamper, rotation), signatures, backoff, circuit breaker, error classification, parsers, SSRF guard, throttle, memory queue, config |
| `connection` | full state machine: restore, transient retry, expiry, QR (refresh, timeout, force), heartbeat reconnect/expiry, cookie rotation; poller bootstrap, dedupe, restart resume, self-filter, gap detection |
| `webhooks` | delivery + signature, 5xx retry, 4xx no-retry, 410 disable, consecutive-failure disable, connect-time private-IP block, sensitive events |
| `api` | every endpoint through the full runtime: auth, validation, 409/501/413, idempotency, ambiguous timeouts, uploads/downloads and spool cleanup, broadcast, webhooks, health/metrics, restart restore |
| `admin` | UI hosting and CSP, system overview, task list/retry/cancel, log and event feeds (redaction, filters, cursors), settings validation, live and restart-time application, restart hook |
| `gateway` | **real arattix library** against a mock Arattai: QR login, CSRF binding, concurrent msgid uniqueness, 11 MB streamed upload, snapshot/restore, expiry on every path, contract drift, circuit, endpoint overrides |
| `redis` | BullMQ queue semantics and error transport, job list/retry/cancel, shared log feed, Redis KV, lease, split API/worker deployment end to end (including the worker's logs, events and tasks seen through the API), standby failover |

## Security notes

* Session cookies and webhook secrets are encrypted at rest (AES-256-GCM, context-bound).
  Files are written `0600` in a `0700` directory.
* QR payloads are login credentials. They are returned only to authenticated API callers,
  redacted from logs, and never sent to `*` webhook subscribers.
* Webhook SSRF protection: https only, no credentials in URLs, no private, loopback, link-local
  or metadata addresses, checked at subscribe time **and** on the IP each socket connects to
  (defeats DNS rebinding). Redirects are not followed.
* Uploads: size-capped, written to a confined spool with random names, original names sanitised,
  removed after the job's final attempt; orphans are swept.
* API keys are compared in constant time and logged only as hashes. After 20 rejected keys in 15
  minutes a client IP gets 429 until the window passes (keyed by `req.ip`, so set `TRUST_PROXY`
  to match your reverse proxy).
* The Compose files publish the API on `127.0.0.1` only; expose it through HTTPS (the `https`
  profile) or a tunnel, never as plain HTTP on a public address.
* Admin UI: the static shell holds no data; all reads and actions go through the API key. Strict
  CSP, `X-Frame-Options: DENY`, no third-party assets. Secrets are never returned by
  `/api/v1/settings` (only "configured" / masked URLs), and the log feed is redacted twice (logger
  and feed). Anyone with an API key has full admin rights, including settings and restart.
