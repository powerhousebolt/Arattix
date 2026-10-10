# arattix-server API Reference (v1)

Base URL: `https://<host>/api/v1`. Examples use:

```bash
export BASE=http://localhost:3000
export KEY=<one of API_KEYS>
```

## Conventions

### Authentication

Every `/api/v1` route requires an API key, sent as either header:

```
Authorization: Bearer <key>
X-API-Key: <key>
```

### Envelopes

Success:

```json
{ "data": { … }, "requestId": "184c7c20-b4b3-4e36-b1d7-988356de6f20" }
```

Error (every error, including validation, 404 and 500):

```json
{
  "error": { "code": "SESSION_NOT_READY", "message": "Arattai session is DISCONNECTED; it must be READY for this operation", "details": { "state": "DISCONNECTED", "reason": "LOGGED_OUT" } },
  "requestId": "889c36ff-37df-4896-875c-165b676b3b16"
}
```

`X-Request-Id` is echoed on every response (a valid incoming `X-Request-Id` is reused). Errors
with a known retry time also send `Retry-After` (seconds).

### Jobs: synchronous and asynchronous

All work runs on queues in the session worker. Mutating endpoints wait up to
`SYNC_WAIT_TIMEOUT_MS` (default 25 s) for the result:

* finished in time → **200** `{ "jobId", "status": "completed", "deduplicated", "result" }`
* still running → **202** `{ "jobId", "status": "queued", "deduplicated", "statusUrl" }`; poll `GET /api/v1/jobs/{jobId}`
* failed → the job's error, with its own status code (e.g. 409, 502, 504)

Add `?async=true` to get the 202 immediately. Job ids carry their queue: `ctl_` (control),
`out_` (outbound), `bc_` (broadcast), `dlv_` (webhook delivery).

### Idempotency

Send `Idempotency-Key: <any string ≤ 200 chars>` on `POST /messages/send`, `POST /messages/media`,
`POST /groups/create`, `PUT /groups/{id}/members` and `POST /channels/broadcast`. The same key
always maps to the same job: a retried request returns the original job (`"deduplicated": true`)
instead of sending twice. Keys are remembered while the job is retained (24 h for completed jobs).

### Error codes

| HTTP | code | Meaning | Retry? |
|---|---|---|---|
| 400 | `VALIDATION_FAILED` | Body/query/params invalid; `details` lists `{path, message, code}` per issue | fix request |
| 400 | `INVALID_JSON` | Body is not valid JSON | fix request |
| 400 | `UPLOAD_INVALID` | Multipart problem (too many files/fields, wrong field name) | fix request |
| 400 | `WEBHOOK_URL_REJECTED` / `WEBHOOK_URL_UNRESOLVABLE` | URL violates the webhook URL policy | fix request |
| 401 | `UNAUTHORIZED` | Missing/invalid API key (also `/metrics` with `METRICS_TOKEN`) | no |
| 404 | `NOT_FOUND` / `ROUTE_NOT_FOUND` | Unknown job, webhook, broadcast or route | no |
| 409 | `SESSION_NOT_READY` | Session is not `READY`; `details.state`, `details.reason` | after login |
| 409 | `SESSION_EXPIRED` | Arattai rejected the session during the job | after re-scan |
| 409 | `WEBHOOK_INACTIVE` | Testing a disabled subscription | no |
| 409 | `JOB_NOT_RETRYABLE` / `JOB_NOT_CANCELLABLE` | Retrying a job that is not failed, cancelling one that already started | no |
| 400 | `SETTING_NOT_EDITABLE` | `PUT /settings` named a secret, topology or unknown key | fix request |
| 410 | `JOB_EXPIRED` | A queued send passed its TTL before it could run | resend if still relevant |
| 410 | `JOB_CANCELLED` | The job was cancelled through `DELETE /jobs/{id}` before it ran | no |
| 413 | `PAYLOAD_TOO_LARGE` | Upload above `MEDIA_MAX_BYTES`, or JSON above 256 kB | no |
| 429 | `RATE_LIMITED` | Over `HTTP_RATE_LIMIT_PER_MINUTE` for this API key | after `Retry-After` |
| 501 | `CAPABILITY_UNAVAILABLE` | The fork has no verified Arattai endpoint for this (reactions, groups) | no |
| 502 | `UPSTREAM_REJECTED` | Arattai answered 4xx | no |
| 502 | `UPSTREAM_ERROR` | Arattai answered 5xx | reads: auto-retried |
| 502 | `UPSTREAM_CONTRACT_CHANGED` | Arattai's response shape changed (see AUDIT §4) | after fix |
| 502 | `WEBHOOK_HTTP_ERROR` / `WEBHOOK_NETWORK_ERROR` | Webhook test delivery failed | yes |
| 503 | `UPSTREAM_UNREACHABLE` | Network/DNS failure reaching Arattai | yes |
| 503 | `UPSTREAM_RATE_LIMITED` | Arattai answered 429 | after `Retry-After` |
| 503 | `UPSTREAM_CIRCUIT_OPEN` | Circuit breaker open after repeated upstream failures | after `Retry-After` |
| 503 | `QUEUE_FULL` | More than `QUEUE_MAX_PENDING` jobs waiting | after `Retry-After` |
| 503 | `WORKER_UNAVAILABLE` | Split deployment: no worker owns the session | after `Retry-After` |
| 503 | `SHUTTING_DOWN` | Process is draining | yes, another instance |
| 504 | `UPSTREAM_TIMEOUT` | Arattai timed out on a read | yes |
| 504 | `UPSTREAM_TIMEOUT_AMBIGUOUS` | A **send** timed out; it may or may not have been delivered. Not auto-retried | check the chat first, or retry with the same `Idempotency-Key` only if acceptable |
| 504 | `DOWNLOAD_TIMEOUT` | Media download did not finish within the sync window | yes |
| 500 | `INTERNAL` | Bug; logged with the `requestId` | — |

---

## Auth core

### `POST /auth/session`: start a QR login

Starts (or returns the already-running) QR login and waits until the QR code is available.
Idempotent: if the session is `READY`, or a login is already in progress, the current status is
returned unchanged. `force: true` abandons any session or attempt and issues a new QR.

| Body field | Type | Default |
|---|---|---|
| `force` | boolean | `false` |

```bash
curl -s -X POST "$BASE/api/v1/auth/session" \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"force": false}'
```

**200**

```json
{
  "data": {
    "jobId": "ctl_cecdc20a-4504-4e46-85b4-edfef93e3fd2",
    "status": "completed",
    "deduplicated": false,
    "result": {
      "sessionId": "default",
      "state": "QR_READY",
      "reason": "QR_ISSUED",
      "since": "2026-10-10T10:22:46.118Z",
      "updatedAt": "2026-10-10T10:22:46.118Z",
      "qr": {
        "data": "https://accounts.arattai.in/…oneauth…",
        "dataUrl": "data:image/png;base64,iVBORw0KGgo…",
        "issuedAt": "2026-10-10T10:22:46.087Z",
        "expiresAt": "2026-10-10T10:25:46.087Z",
        "refreshCount": 0
      },
      "lastError": null,
      "reconnect": null,
      "authenticatedAt": null,
      "lastHeartbeatAt": null,
      "circuit": "CLOSED",
      "workerOnline": true
    }
  },
  "requestId": "184c7c20-b4b3-4e36-b1d7-988356de6f20"
}
```

* `qr.data` is the string to encode as a QR code; `qr.dataUrl` is that QR as a PNG, ready for an
  `<img src>`. **Both are login credentials.**
* Arattai expires QR codes on its own; the worker requests a fresh one automatically
  (`refreshCount` increases, `qr.data` changes). Poll `GET /auth/status` every few seconds to show
  the current code.
* `expiresAt` is when the whole attempt gives up (`QR_TIMEOUT_MS`), after which
  `state=DISCONNECTED, reason=QR_TIMEOUT`.

Errors: `503 WORKER_UNAVAILABLE`, `503 SHUTTING_DOWN`, `400 VALIDATION_FAILED`.

### `GET /auth/status`: session state

```bash
curl -s "$BASE/api/v1/auth/status" -H "Authorization: Bearer $KEY"
```

**200**

```json
{
  "data": {
    "sessionId": "default",
    "state": "READY",
    "reason": "QR_APPROVED",
    "since": "2026-10-10T10:22:46.183Z",
    "updatedAt": "2026-10-10T10:22:46.183Z",
    "qr": null,
    "lastError": null,
    "reconnect": null,
    "authenticatedAt": "2026-10-10T10:22:46.150Z",
    "lastHeartbeatAt": "2026-10-10T10:23:46.201Z",
    "circuit": "CLOSED",
    "workerOnline": true
  },
  "requestId": "88d9b2cc-c0b9-4341-a191-e34956f51cdf"
}
```

| Field | Values |
|---|---|
| `state` | `DISCONNECTED`, `CONNECTING`, `QR_READY`, `AUTHENTICATED`, `SYNCING`, `READY` |
| `reason` | `NOT_STARTED`, `RESTORING`, `RECONNECTING`, `RETRY_BACKOFF`, `NO_SESSION`, `SESSION_EXPIRED`, `SESSION_CORRUPT`, `QR_REQUESTED`, `QR_ISSUED`, `QR_REFRESHED`, `QR_APPROVED`, `QR_TIMEOUT`, `QR_INIT_FAILED`, `QR_POLL_FAILED`, `LOGIN_FINALIZE_FAILED`, `RESTORED`, `RECONNECTED`, `LOGGED_OUT`, `SHUTDOWN`, `INTERNAL_ERROR`, `WORKER_NOT_STARTED` |
| `reconnect` | while `CONNECTING`: `{ "attempt": 3, "nextRetryAt": "…" }` |
| `lastError` | last failure: `{ "code", "message", "at" }` |
| `circuit` | `CLOSED`, `OPEN`, `HALF_OPEN` |
| `workerOnline` | `false` when no worker owns the session (split deployments) |

### `DELETE /auth/session`: log out locally

Stops the session and deletes the stored cookies. Arattai's server-side session is not revoked
(the library has no logout endpoint). Sign out from the Arattai app for that.

```bash
curl -s -X DELETE "$BASE/api/v1/auth/session" -H "Authorization: Bearer $KEY"
```

**200**: `data.result` is the status with `state: "DISCONNECTED", reason: "LOGGED_OUT"`.

### `GET /capabilities`

Which operations the current gateway can perform.

```bash
curl -s "$BASE/api/v1/capabilities" -H "Authorization: Bearer $KEY"
```

```json
{
  "data": {
    "messages.text": true,
    "messages.media": true,
    "messages.reaction": false,
    "chats.read": true,
    "media.download": true,
    "groups.create": false,
    "groups.members": false,
    "events.polling": true
  },
  "requestId": "24f4e30d-57f3-49d1-b93a-dc9e44838b73"
}
```

---

## Messaging service

All sends go through the outbound queue and are paced by the throttle (`SEND_RATE_PER_MINUTE`,
`SEND_BURST`, `SEND_PER_CHAT_INTERVAL_MS`, `SEND_JITTER_MS`), so a send may take a few seconds
under load. Sends that cannot run within their TTL (`ttlSeconds`, default `MESSAGE_TTL_MS`) fail
with `410 JOB_EXPIRED` instead of arriving late.

### `POST /messages/send`: text or reaction

**Text** (`type` defaults to `"text"`):

| Field | Type | Rules |
|---|---|---|
| `type` | `"text"` | optional |
| `chatId` | string | required; 1–128 chars of `A–Z a–z 0–9 _ . : @ -` |
| `text` | string | required; ≤ 10 000 chars; not blank. Sent verbatim, so any inline formatting syntax the Arattai client renders (e.g. `*bold*`, `_italic_`) passes through unchanged |
| `displayName` | string | optional, ≤ 100 chars (the library's `dname` field) |
| `ttlSeconds` | integer | optional, 5–86 400 |

```bash
curl -s -X POST "$BASE/api/v1/messages/send" \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -H "Idempotency-Key: order-1042-confirmation" \
  -d '{"chatId":"CT_1350000000000000001_123456789","text":"Your order *#1042* has shipped."}'
```

**200**

```json
{
  "data": {
    "jobId": "out_ae2e16b0-aff7-4cd5-bdb4-b8b011ea188b",
    "status": "completed",
    "deduplicated": false,
    "result": {
      "chatId": "CT_1350000000000000001_123456789",
      "upstream": { "…": "Arattai's raw response body" }
    }
  },
  "requestId": "90b4cdea-5a4b-4ad0-91af-70823be39268"
}
```

**202** (`?async=true`, or the send is still queued after the sync window)

```json
{
  "data": {
    "jobId": "out_fecd29a6-ec34-43e8-a11d-e388fa22eca9",
    "status": "queued",
    "deduplicated": false,
    "statusUrl": "/api/v1/jobs/out_fecd29a6-ec34-43e8-a11d-e388fa22eca9"
  },
  "requestId": "14cef740-d07e-42cd-9443-44234f614ba4"
}
```

**400**

```json
{
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "Request validation failed",
    "details": [
      { "path": "chatId", "message": "must contain only letters, digits and _ . : @ -", "code": "invalid_format" },
      { "path": "text", "message": "Invalid input: expected string, received undefined", "code": "invalid_type" }
    ]
  },
  "requestId": "f49e3b31-77be-4356-b52b-c804e043130d"
}
```

**Reaction:** validated, but not available in the current fork:

```bash
curl -s -X POST "$BASE/api/v1/messages/send" \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"type":"reaction","chatId":"CT_1","messageId":"1700000000001","emoji":"👍"}'
```

**501**

```json
{
  "error": {
    "code": "CAPABILITY_UNAVAILABLE",
    "message": "\"messages.reaction\" is not supported by the arattix fork yet: no verified Arattai endpoint exists for it",
    "details": { "capability": "messages.reaction" }
  },
  "requestId": "1f9b7a86-9441-4536-97da-653c38bb1171"
}
```

Other errors: `409 SESSION_NOT_READY`, `409 SESSION_EXPIRED`, `410 JOB_EXPIRED`,
`502 UPSTREAM_*`, `503 QUEUE_FULL | UPSTREAM_CIRCUIT_OPEN | WORKER_UNAVAILABLE`,
`504 UPSTREAM_TIMEOUT_AMBIGUOUS`.

### `POST /messages/media`: upload and send a file

`multipart/form-data`. The file is streamed to a spool on disk (never held in memory) and then
streamed to Arattai with an exact `Content-Length`.

| Part | Type | Rules |
|---|---|---|
| `file` | file | required; exactly one; 1 byte to `MEDIA_MAX_BYTES` (default 64 MiB); UTF-8 names supported |
| `chatId` | text | required (same rules as above) |
| `caption` | text | optional, ≤ 4 000 chars |
| `mimeType` | text | optional override, e.g. `audio/ogg` |
| `ttlSeconds` | text | optional, 5–86 400 |

Content type resolution: `mimeType` field → file-name extension (`report.pdf` →
`application/pdf`) → the part's declared `Content-Type` → `application/octet-stream`. The file
name is sanitised (path components, control characters and `"\/<>:|?*` removed, ≤ 200 chars).

```bash
curl -s -X POST "$BASE/api/v1/messages/media" \
  -H "Authorization: Bearer $KEY" \
  -H "Idempotency-Key: invoice-1042-pdf" \
  -F chatId=CT_1350000000000000001_123456789 \
  -F caption="Invoice for Q3" \
  -F file=@./invoice-1042.pdf
```

**200**

```json
{
  "data": {
    "jobId": "out_1bd0eb64-db1d-45d4-83e6-fc750ccc2835",
    "status": "completed",
    "deduplicated": false,
    "result": { "chatId": "CT_1350000000000000001_123456789", "upstream": { "…": "Arattai's raw upload response" } }
  },
  "requestId": "be679469-5284-4476-a210-309d0fee2b0b"
}
```

**413**

```json
{ "error": { "code": "PAYLOAD_TOO_LARGE", "message": "Payload exceeds the 67108864-byte limit" }, "requestId": "…" }
```

**400** missing file:

```json
{ "error": { "code": "VALIDATION_FAILED", "message": "Request validation failed", "details": [ { "path": "file", "message": "a multipart \"file\" part is required", "code": "required" } ] }, "requestId": "…" }
```

### `GET /chats`: list chats

| Query | Default | Range |
|---|---|---|
| `limit` | 20 | 1–200 |

```bash
curl -s "$BASE/api/v1/chats?limit=20" -H "Authorization: Bearer $KEY"
```

**200**

```json
{
  "data": {
    "jobId": "ctl_77642b66-aa00-41ca-872a-7bcaa54e46f0",
    "status": "completed",
    "deduplicated": false,
    "result": [
      {
        "chatId": "CT_1350000000000000001_123456789",
        "title": "Ops Team",
        "lastMessageId": "1700000000002",
        "lastMessagePreview": "see you at 5",
        "owner": { "id": "60012345", "name": "Asha" },
        "participants": [ { "id": "60012345", "name": "Asha" }, { "id": "60067890", "name": "Ravi" } ]
      }
    ]
  },
  "requestId": "68bf4430-4c48-4bf3-82f5-4a8c015973fa"
}
```

### `GET /chats/{chatId}/messages`: recent messages (oldest first)

| Query | Default | Range |
|---|---|---|
| `limit` | 20 | 1–100 |

```bash
curl -s "$BASE/api/v1/chats/CT_1350000000000000001_123456789/messages?limit=10" -H "Authorization: Bearer $KEY"
```

**200**

```json
{
  "data": {
    "jobId": "ctl_2927deb1-1efc-44c7-be84-ac1fe2273c9b",
    "status": "completed",
    "deduplicated": false,
    "result": [
      {
        "id": "1700000000001",
        "type": "text",
        "text": "hello",
        "sender": { "id": "60067890", "name": "Ravi" },
        "timestamp": 1760091766000,
        "media": null
      },
      {
        "id": "1700000000002",
        "type": "file",
        "text": null,
        "sender": { "id": "60067890", "name": "Ravi" },
        "timestamp": 1760091790000,
        "media": { "fileId": "i5b22…", "fileName": "photo.jpg", "mimeType": "image/jpeg", "size": 195287 }
      }
    ]
  },
  "requestId": "972f0d58-f89a-43e3-8972-569b8a91469a"
}
```

`timestamp` is `null` when Arattai's payload carries no recognisable time field.

### `GET /media/{fileId}`: download a file

| Query | Required | Notes |
|---|---|---|
| `chatId` | yes | chat the file belongs to |
| `thumbnail` | no | `true` for the thumbnail |

```bash
curl -s -OJ "$BASE/api/v1/media/i5b22abc?chatId=CT_1350000000000000001_123456789" -H "Authorization: Bearer $KEY"
```

**200**: binary body with `Content-Type` from Arattai, `Content-Length`,
`Content-Disposition: attachment; filename*=UTF-8''photo.jpg` and `X-Content-Type-Options: nosniff`.
Errors: `409 SESSION_NOT_READY`, `502 UPSTREAM_*`, `504 DOWNLOAD_TIMEOUT`.

---

## Group management engine

Both endpoints are fully validated, queued and paced, but **return 501 with the current fork**:
the library contains no group endpoints, and none have been verified (see AUDIT §0 and §4 for how
to add them). Validation errors are still returned first, so integrations can be built and tested
against the contract now.

### `POST /groups/create`

| Field | Type | Rules |
|---|---|---|
| `name` | string | required, 1–100 chars |
| `participants` | string[] | required, 1–256 unique user ids |
| `description` | string | optional, ≤ 500 chars |

```bash
curl -s -X POST "$BASE/api/v1/groups/create" \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"name":"Launch war-room","participants":["60012345","60067890"],"description":"Release coordination"}'
```

**501**

```json
{
  "error": {
    "code": "CAPABILITY_UNAVAILABLE",
    "message": "\"groups.create\" is not supported by the arattix fork yet: no verified Arattai endpoint exists for it",
    "details": { "capability": "groups.create" }
  },
  "requestId": "c527ac13-53ed-4161-b072-71f0ef677bed"
}
```

When implemented, the success shape is the standard job response (`200` with
`result: { "chatId": null, "upstream": … }`, or `202`).

### `PUT /groups/{id}/members`

| Field | Type | Rules |
|---|---|---|
| `action` | enum | `add`, `remove`, `promote`, `demote`, `transfer_ownership` |
| `userIds` | string[] | 1–256 unique ids; **exactly 1** for `transfer_ownership` |

```bash
# add members
curl -s -X PUT "$BASE/api/v1/groups/CT_1350000000000000001_123456789/members" \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"action":"add","userIds":["60011111","60022222"]}'

# promote to admin / demote
curl -s -X PUT "$BASE/api/v1/groups/CT_1350000000000000001_123456789/members" \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"action":"promote","userIds":["60011111"]}'

# transfer ownership
curl -s -X PUT "$BASE/api/v1/groups/CT_1350000000000000001_123456789/members" \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"action":"transfer_ownership","userIds":["60011111"]}'
```

**501** `CAPABILITY_UNAVAILABLE` (`details.capability = "groups.members"`).

**400** for `transfer_ownership` with two ids:

```json
{ "error": { "code": "VALIDATION_FAILED", "message": "Request validation failed", "details": [ { "path": "userIds", "message": "transfer_ownership takes exactly one user id", "code": "custom" } ] }, "requestId": "…" }
```

---

## Channels and broadcasts

### `POST /channels/broadcast`

Sends one text to many chats or channels (any chat id the account can post to). The broadcast
runs as a coordinator job: recipients are processed in chunks of `chunkSize`, with `chunkDelayMs`
between chunks; each recipient is a regular outbound send, so per-message pacing and per-chat
spacing still apply. Duplicate recipients are removed. If the session leaves `READY` mid-way,
the remaining recipients are marked `aborted` rather than queued blindly.

If the worker crashes mid-broadcast (BullMQ mode), the broadcast is retried and recipients
already sent map back to their existing per-recipient jobs, so **nobody is messaged twice**.

| Field | Type | Rules |
|---|---|---|
| `recipients` | string[] | required, 1–`BROADCAST_MAX_RECIPIENTS` (default 1 000) |
| `text` | string | required, ≤ 10 000 chars, not blank |
| `displayName` | string | optional |
| `chunkSize` | integer | 1–50, default 10 |
| `chunkDelayMs` | integer | `BROADCAST_MIN_CHUNK_DELAY_MS` (default 5 000) to 3 600 000; default max(min, 30 000) |

```bash
curl -s -X POST "$BASE/api/v1/channels/broadcast" \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -H "Idempotency-Key: diwali-campaign-2026" \
  -d '{
        "recipients": ["CT_1350000000000000001_123456789", "CT_1350000000000000002_123456789", "CT_1350000000000000003_123456789"],
        "text": "Our offices are closed on Monday.",
        "chunkSize": 2,
        "chunkDelayMs": 30000
      }'
```

**202**

```json
{
  "data": {
    "broadcastId": "bc_c11050c6-48bd-4b58-8914-13ec34109ab9",
    "status": "queued",
    "deduplicated": false,
    "total": 3,
    "chunks": 2,
    "estimatedMinDurationMs": 30000,
    "statusUrl": "/api/v1/channels/broadcast/bc_c11050c6-48bd-4b58-8914-13ec34109ab9"
  },
  "requestId": "49e49fa3-60d5-4416-9577-689bff12bffd"
}
```

### `GET /channels/broadcast/{broadcastId}`: progress and results

```bash
curl -s "$BASE/api/v1/channels/broadcast/bc_c11050c6-48bd-4b58-8914-13ec34109ab9" -H "Authorization: Bearer $KEY"
```

**200** (finished; while running, `state` is `active` and `progress` updates after each chunk)

```json
{
  "data": {
    "id": "bc_c11050c6-48bd-4b58-8914-13ec34109ab9",
    "name": "broadcast",
    "state": "completed",
    "progress": { "total": 3, "sent": 2, "failed": 1, "aborted": 0, "unknown": 0, "chunksDone": 2, "chunks": 2 },
    "attemptsMade": 1,
    "createdAt": "2026-10-10T10:22:46.355Z",
    "finishedAt": "2026-10-10T10:23:16.369Z",
    "result": {
      "total": 3, "sent": 2, "failed": 1, "aborted": 0, "unknown": 0, "chunksDone": 2, "chunks": 2,
      "results": [
        { "chatId": "CT_1350000000000000001_123456789", "status": "sent", "jobId": "out_c11050c6-48bd-4b58-8914-13ec34109ab9-CT_1350000000000000001_123456789" },
        { "chatId": "CT_1350000000000000002_123456789", "status": "sent", "jobId": "out_c11050c6-…" },
        { "chatId": "CT_1350000000000000003_123456789", "status": "failed", "jobId": "out_c11050c6-…", "error": { "code": "UPSTREAM_REJECTED", "message": "Arattai rejected sendText (HTTP 400)" } }
      ]
    },
    "queue": "broadcast"
  },
  "requestId": "e709bc7e-ff93-4d50-9964-0065f751fe3a"
}
```

Per-recipient `status`: `sent`, `failed`, `aborted` (session left `READY`), `unknown` (the send
did not finish within the broadcast's wait window; check its `jobId`). A `broadcast.completed`
webhook event carries the final counts.

---

## Jobs

### `GET /jobs/{jobId}`

```bash
curl -s "$BASE/api/v1/jobs/out_fecd29a6-ec34-43e8-a11d-e388fa22eca9" -H "Authorization: Bearer $KEY"
```

**200**

```json
{
  "data": {
    "id": "out_fecd29a6-ec34-43e8-a11d-e388fa22eca9",
    "name": "message.text",
    "state": "completed",
    "progress": null,
    "attemptsMade": 1,
    "createdAt": "2026-10-10T10:22:46.208Z",
    "finishedAt": "2026-10-10T10:22:46.208Z",
    "result": { "chatId": "CT_1", "upstream": { "…": "…" } },
    "queue": "outbound"
  },
  "requestId": "f2edac61-76c9-4021-b096-b33e6ed036b8"
}
```

`state`: `waiting`, `delayed` (waiting to retry), `active`, `completed`, `failed`. Failed (or
retrying) jobs carry `error: { status, code, message, details?, retryable }`. **404** after
retention (24 h completed, 7 days failed in BullMQ mode).

---

## Webhook subscription engine

### Event catalogue

| Event | When | `data` |
|---|---|---|
| `message.received` | Poller found a new inbound message | `{ chatId, chatTitle, message: { id, type, text, sender, timestamp, media, fromSelf }, gapDetected, raw }` |
| `message.sent` | Arattai accepted a send/upload | `{ jobId, kind: "text"\|"media"\|"reaction", chatId, upstream }` |
| `message.failed` | A send failed for good (no retries left) | `{ jobId, kind, chatId, error: { code, message } }` |
| `session.state_changed` | Any connection state transition | `{ from, to, reason, error }` |
| `session.qr` | A QR code was issued or refreshed. **Sensitive: delivered only to subscriptions that list it by name** | `{ data, issuedAt, expiresAt, refreshCount }` |
| `broadcast.completed` | A broadcast finished | `{ broadcastId, total, sent, failed, aborted, unknown, chunksDone, chunks }` |
| `webhook.test` | `POST /webhooks/{id}/test` | `{ message, subscriptionId }` |

`"*"` subscribes to every event except `session.qr`.

Delivery body (one event per request):

```json
{
  "id": "evt_9f0c2c5a6a7e4b1f8d3e0b6c2a1d4e5f",
  "type": "message.received",
  "sessionId": "default",
  "occurredAt": "2026-10-10T10:30:01.512Z",
  "data": {
    "chatId": "CT_1350000000000000001_123456789",
    "chatTitle": "Ops Team",
    "message": {
      "id": "1700000000003",
      "type": "text",
      "text": "/status",
      "sender": { "id": "60067890", "name": "Ravi" },
      "timestamp": 1760092201000,
      "media": null,
      "fromSelf": false
    },
    "gapDetected": false,
    "raw": { "…": "the untouched Arattai message object" }
  }
}
```

Delivery headers:

| Header | Value |
|---|---|
| `X-Arattai-Signature` | `t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>` |
| `X-Arattai-Event` | event type |
| `X-Arattai-Delivery` | event id; **dedupe on this** (delivery is at-least-once) |
| `X-Arattai-Attempt` | 1, 2, … |
| `Content-Type` | `application/json` |

Receiver contract: answer **2xx within `WEBHOOK_TIMEOUT_MS`** (10 s). `5xx`, `408`, `429` and
network errors are retried with exponential backoff up to `WEBHOOK_MAX_ATTEMPTS` (8). Other `4xx`
are not retried. `410 Gone` disables the subscription immediately; `WEBHOOK_MAX_CONSECUTIVE_FAILURES`
(50) failed attempts in a row disable it as well. Redirects are not followed. Events are not
ordered across deliveries; use `occurredAt`.

#### Verifying `X-Arattai-Signature` (Node.js / Express)

```js
const crypto = require('node:crypto');
const express = require('express');
const app = express();

app.post('/arattai-webhook', express.raw({ type: 'application/json' }), (req, res) => {
  const header = req.get('X-Arattai-Signature') || '';
  const parts = Object.fromEntries(header.split(',').map((p) => p.split('=', 2)));
  const t = Number(parts.t);
  const body = req.body.toString('utf8');                       // the RAW body, not re-serialised JSON
  const expected = crypto.createHmac('sha256', process.env.ARATTAI_WEBHOOK_SECRET).update(`${t}.${body}`).digest('hex');
  const fresh = Math.abs(Date.now() / 1000 - t) <= 300;          // reject replays older than 5 min
  const valid = parts.v1 && expected.length === parts.v1.length &&
                crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(parts.v1));
  if (!fresh || !valid) return res.sendStatus(401);

  const event = JSON.parse(body);
  // dedupe on event.id / X-Arattai-Delivery, then process asynchronously
  res.sendStatus(204);
});
```

#### Verifying in Python

```python
import hmac, hashlib, time

def verify(secret: str, header: str, raw_body: bytes, tolerance: int = 300) -> bool:
    parts = dict(p.split("=", 1) for p in header.split(","))
    t = int(parts.get("t", "0"))
    if abs(time.time() - t) > tolerance:
        return False
    expected = hmac.new(secret.encode(), f"{t}.".encode() + raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, parts.get("v1", ""))
```

### `POST /webhooks/subscribe`

| Field | Type | Rules |
|---|---|---|
| `url` | string | required; `https://` (http only with `WEBHOOK_ALLOW_HTTP`); no credentials; must not be or resolve to a private, loopback, link-local or metadata address (unless `WEBHOOK_ALLOW_PRIVATE`) |
| `events` | string[] | event types and/or `"*"`; default `["*"]` |
| `description` | string | optional, ≤ 500 chars |
| `secret` | string | optional, 16–256 chars; generated if omitted |

```bash
curl -s -X POST "$BASE/api/v1/webhooks/subscribe" \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"url":"https://crm.example.com/hooks/arattai","events":["message.received","session.state_changed"],"description":"CRM inbox"}'
```

**201**: the `secret` is returned **only here**; store it.

```json
{
  "data": {
    "id": "wh_a7cf31d75eb6478c934032f53f6f0345",
    "url": "https://crm.example.com/hooks/arattai",
    "events": ["message.received", "session.state_changed"],
    "description": "CRM inbox",
    "active": true,
    "disabledReason": null,
    "createdAt": "2026-10-10T10:22:46.663Z",
    "updatedAt": "2026-10-10T10:22:46.663Z",
    "consecutiveFailures": 0,
    "lastDeliveryAt": null,
    "lastStatus": null,
    "lastError": null,
    "secret": "whsec_5b2b99b108ac4b8bde31c121f6d556116365240f0f25b59b"
  },
  "requestId": "604ee4e9-1914-413c-ab7b-363eff27034f"
}
```

**400**

```json
{ "error": { "code": "WEBHOOK_URL_REJECTED", "message": "Webhook URL must use https" }, "requestId": "…" }
```

### `GET /webhooks`: list subscriptions (secrets never included)

```bash
curl -s "$BASE/api/v1/webhooks" -H "Authorization: Bearer $KEY"
```

```json
{
  "data": [
    {
      "id": "wh_a7cf31d75eb6478c934032f53f6f0345",
      "url": "https://crm.example.com/hooks/arattai",
      "events": ["message.received", "session.state_changed"],
      "description": "CRM inbox",
      "active": true,
      "disabledReason": null,
      "createdAt": "2026-10-10T10:22:46.663Z",
      "updatedAt": "2026-10-10T10:22:46.673Z",
      "consecutiveFailures": 0,
      "lastDeliveryAt": "2026-10-10T10:22:46.673Z",
      "lastStatus": 200,
      "lastError": null
    }
  ],
  "requestId": "8b649df7-3df8-4760-a0d6-1cbf1041cc07"
}
```

### `GET /webhooks/{id}`

```bash
curl -s "$BASE/api/v1/webhooks/wh_a7cf31d75eb6478c934032f53f6f0345" -H "Authorization: Bearer $KEY"
```

**200**: one subscription (same shape as a list item). **404** `NOT_FOUND`.

### `DELETE /webhooks/{id}`: unsubscribe

```bash
curl -s -X DELETE "$BASE/api/v1/webhooks/wh_a7cf31d75eb6478c934032f53f6f0345" -H "Authorization: Bearer $KEY"
```

```json
{ "data": { "id": "wh_a7cf31d75eb6478c934032f53f6f0345", "deleted": true }, "requestId": "8acd161b-3507-4926-a919-762364adab11" }
```

Deliveries already queued for a deleted subscription are dropped.

### `POST /webhooks/{id}/test`: send a signed `webhook.test` event now

```bash
curl -s -X POST "$BASE/api/v1/webhooks/wh_a7cf31d75eb6478c934032f53f6f0345/test" -H "Authorization: Bearer $KEY"
```

**200**

```json
{
  "data": {
    "jobId": "dlv_cacf668d-29be-45ff-bfff-2d725b06d760",
    "eventId": "evt_655017f480b7446991233d7a9c60ab50",
    "delivered": true,
    "result": { "status": 200 }
  },
  "requestId": "e606dc22-bc5c-4b39-99af-4d0efed70178"
}
```

**502** when the receiver fails (single attempt, no retries):

```json
{ "error": { "code": "WEBHOOK_HTTP_ERROR", "message": "Receiver answered HTTP 500", "details": { "receiverStatus": 500, "body": "…" } }, "requestId": "…" }
```

**409** `WEBHOOK_INACTIVE` when the subscription is disabled.

---

## Administration (tasks, logs, events, settings)

These back the admin web UI at `/ui/` and are ordinary `/api/v1` routes with the same API key.

### `GET /system`: server overview

```bash
curl -s "$BASE/api/v1/system" -H "Authorization: Bearer $KEY"
```

**200** `data`: `version`, `node`, `pid`, `role`, `sessionId`, `storeDriver`, `queueDriver`,
`startedAt`, `uptimeSeconds`, `memory { rss, heapUsed, heapTotal }`, `logLevel`, `session` (same
shape as `GET /auth/status`), `capabilities`, and `queues { control|outbound|broadcast|webhooks:
{ waiting, active, delayed, completed, failed } }`.

### `POST /system/restart`

**202** `{ "restarting": true, "role", "note" }`, then a graceful shutdown. A supervisor must
start the process again. In a split deployment only the receiving process restarts.

### `GET /queues`

**200** `[{ "queue": "outbound", "counts": { "waiting": 0, "active": 1, "delayed": 0, "completed": 12, "failed": 1 } }, …]`

### `GET /jobs`: list tasks

| Query | Default | |
|---|---|---|
| `queue` | all | comma-separated: `control,outbound,broadcast,webhooks` |
| `state` | all | comma-separated: `waiting,delayed,active,completed,failed` |
| `name` | — | exact job name, e.g. `message.text`, `auth.start`, `broadcast`, `deliver` |
| `limit` | 50 | 1–200 |

```bash
curl -s "$BASE/api/v1/jobs?queue=outbound&state=failed" -H "Authorization: Bearer $KEY"
```

**200** newest first; each item is the `GET /jobs/{jobId}` shape plus `data` (the job payload;
internal spool paths removed):

```json
{
  "data": [
    {
      "id": "out_0abbfbfc-…-CT_bad",
      "queue": "outbound",
      "name": "message.text",
      "state": "failed",
      "attemptsMade": 1,
      "createdAt": "2026-10-10T11:12:57.120Z",
      "finishedAt": "2026-10-10T11:12:57.130Z",
      "error": { "status": 502, "code": "UPSTREAM_REJECTED", "message": "Arattai refused the message", "retryable": false },
      "data": { "chatId": "CT_bad", "text": "Release 1.4 is live.", "expiresAt": 1791631377245 }
    }
  ],
  "requestId": "…"
}
```

### `POST /jobs/{jobId}/retry`

Re-queues a **failed** job from its first attempt. **202** `{ "id", "retried": true, "statusUrl" }`;
**409** `JOB_NOT_RETRYABLE` otherwise. A send whose TTL passed fails again with `JOB_EXPIRED`;
resend it instead.

### `DELETE /jobs/{jobId}`: cancel

Removes a **waiting** or **delayed** job so it never runs. **200** `{ "id", "cancelled": true }`;
**409** `JOB_NOT_CANCELLABLE` once it has started or finished.

### `GET /logs`: recent log records

| Query | Default | |
|---|---|---|
| `after` | — | only records with `seq` greater than this (tail with the previous `cursor`) |
| `limit` | 200 | 1–1000, newest records matching the filters, returned oldest first |
| `level` | — | minimum severity: `warn` returns `warn` and `error` |
| `component` | — | e.g. `http`, `connection`, `queue`, `webhooks`, `broadcast` |
| `q` | — | case-insensitive text search in message and fields |

**200**

```json
{
  "data": {
    "entries": [
      { "seq": 42, "at": "2026-10-10T11:12:57.247Z", "level": "info", "message": "Broadcast finished", "component": "broadcast", "role": "all", "pid": 1, "meta": { "broadcastId": "…", "sent": 3 } }
    ],
    "cursor": 42,
    "bufferSize": 2000
  },
  "requestId": "…"
}
```

Records are redacted like the console log. The buffer keeps the last `LOG_BUFFER_SIZE` records
at or above `LOG_LEVEL`. `DELETE /logs` clears it.

### `GET /events`: recent events

`after`, `limit` (1–500, default 100) and `type` (comma-separated event types) as above.
Entries: `{ seq, id, type, occurredAt, data }`, the same events webhooks receive, with `raw`
upstream payloads dropped and `session.qr` data replaced by `{ "redacted": true }`.

### `GET /settings`

**200** `{ "settings": [ … ], "restartRequired": false }`, one item per setting:

```json
{ "key": "SEND_RATE_PER_MINUTE", "group": "Outbound pacing", "description": "Sustained sends per minute.", "value": "20", "source": "env", "editable": true, "live": false, "secret": false, "pending": null }
```

`source`: `env`, `default` or `override` (saved through this API). `pending`: a saved value
that this process has not applied yet (`""` means a removed override). Secret values are never
returned: `"configured"`, `"2 keys configured"`, or a URL with its password masked.

### `PUT /settings`

```bash
curl -s -X PUT "$BASE/api/v1/settings" -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
     -d '{"values":{"SEND_RATE_PER_MINUTE":"30","LOG_LEVEL":"http","SELF_USER_ID":null}}'
```

`null` (or `""`) removes an override. The whole resulting configuration is validated first:
**400** `VALIDATION_FAILED` with per-key `details`, or `SETTING_NOT_EDITABLE` for secrets,
topology and unknown keys. **200** returns the `GET /settings` shape. `LOG_LEVEL` applies
immediately in the receiving process; everything else on the next start (`restartRequired`).

---

## Operations endpoints (no API key)

The admin UI itself is served at `GET /ui/` (static files; `/` redirects there) unless
`UI_ENABLED=false`. It needs an API key to load any data.

### `GET /health/live`

```bash
curl -s "$BASE/health/live"
```

```json
{ "status": "ok" }
```

### `GET /health/ready`

```bash
curl -s "$BASE/health/ready"                        # 200 when store/queue (and lease) are healthy
curl -s "$BASE/health/ready?requireSession=true"    # also requires state READY
```

**200**

```json
{
  "status": "ok",
  "checks": { "store": "ok", "queue": "ok", "lease": "ok" },
  "session": { "state": "READY", "reason": "RESTORED", "workerOnline": true }
}
```

**503** (example: standby worker)

```json
{
  "status": "unavailable",
  "checks": { "store": "ok", "queue": "ok", "lease": "standby: another worker owns the session" },
  "session": { "state": "DISCONNECTED", "reason": "NOT_STARTED", "workerOnline": true }
}
```

### `GET /metrics`

```bash
curl -s "$BASE/metrics" -H "Authorization: Bearer $METRICS_TOKEN"   # header only if METRICS_TOKEN is set
```

```
# HELP arattai_session_state Current session state (1 = active state).
# TYPE arattai_session_state gauge
arattai_session_state{state="READY"} 1
arattai_session_state{state="DISCONNECTED"} 0
# HELP arattai_outbound_total Outbound operations by job and result.
# TYPE arattai_outbound_total counter
arattai_outbound_total{job="message.text",result="ok"} 1532
# HELP http_requests_total HTTP requests by route and status.
# TYPE http_requests_total counter
http_requests_total{method="POST",route="/api/v1/messages/send",status="200"} 1530
…
```
