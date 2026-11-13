# curl Examples for bt-servant-worker

## Quick Start

```bash
# 1. Start the dev server
pnpm dev

# 2. Note the port (shown in output, e.g., "Ready on http://localhost:65197")

# 3. Set your variables
export PORT=65197  # Use the port from step 2
export API_KEY="test-api-key-for-local-dev"  # From .dev.vars
```

---

## Health Check (no auth required)

```bash
curl http://localhost:$PORT/health
```

**Response:**

```json
{ "status": "healthy", "version": "0.2.0" }
```

---

## User Preferences

### Get Preferences

```bash
curl "http://localhost:$PORT/api/v1/users/my-user-id/preferences" \
  -H "Authorization: Bearer $API_KEY"
```

**Response (new user):**

```json
{ "response_language": "en" }
```

### Update Language (valid)

```bash
curl -X PUT "http://localhost:$PORT/api/v1/users/my-user-id/preferences" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"response_language": "es"}'
```

**Response:**

```json
{ "response_language": "es" }
```

### Update Language (INVALID - uppercase)

```bash
curl -X PUT "http://localhost:$PORT/api/v1/users/my-user-id/preferences" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"response_language": "EN"}'
```

**Response (400):**

```json
{
  "error": "Invalid response_language",
  "message": "Must be a valid ISO 639-1 language code (2 lowercase letters, e.g., \"en\", \"es\", \"fr\")"
}
```

---

## Chat History

### Get History

```bash
curl "http://localhost:$PORT/api/v1/users/my-user-id/history?user_id=my-user-id" \
  -H "Authorization: Bearer $API_KEY"
```

**Response (empty):**

```json
{ "user_id": "my-user-id", "entries": [], "total_count": 0, "limit": 50, "offset": 0 }
```

### Get History with Pagination

```bash
curl "http://localhost:$PORT/api/v1/users/my-user-id/history?user_id=my-user-id&limit=10&offset=0" \
  -H "Authorization: Bearer $API_KEY"
```

---

## Chat

### Send a Message

```bash
curl -X POST "http://localhost:$PORT/api/v1/chat" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "client_id": "curl-test",
    "user_id": "my-user-id",
    "message": "What is John 3:16?",
    "message_type": "text"
  }'
```

**Note:** This requires a valid `ANTHROPIC_API_KEY` in `.dev.vars` to actually call Claude.

### Send Empty Message (INVALID)

```bash
curl -X POST "http://localhost:$PORT/api/v1/chat" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "client_id": "curl-test",
    "user_id": "my-user-id",
    "message": "",
    "message_type": "text"
  }'
```

**Response (400):**

```json
{ "error": "Message is required" }
```

### Send a Message With a Client-Supplied Thread

Replaces the stored history with the supplied turns before the turn runs (issue #392, full spec in [client-supplied-history.md](client-supplied-history.md)). `"history": []` starts blank.

```bash
curl -X POST "http://localhost:$PORT/api/v1/chat" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "client_id": "curl-test",
    "user_id": "my-user-id",
    "message_type": "text",
    "history": [
      { "user_message": "Give me an overview of Mark 1.", "assistant_response": "## Mark 1 — Overview\n..." }
    ],
    "message": "What does \"immediately\" signal in verse 12?"
  }'
```

**Response (200)** — includes the appended turn and the stored thread length (only when `history` was sent):

```json
{
  "message_id": "…",
  "responses": ["…"],
  "response_language": "en",
  "input_language": "en",
  "voice_audio_base64": null,
  "voice_audio_url": null,
  "history_entry": {
    "user_message": "What does \"immediately\" signal in verse 12?",
    "assistant_response": "…",
    "timestamp": 1757800000000
  },
  "history_length": 2
}
```

Verify what was stored:

```bash
curl "http://localhost:$PORT/api/v1/orgs/$ORG/users/my-user-id/history?user_id=my-user-id" \
  -H "Authorization: Bearer $API_KEY"
```

### Send a Message With a Client-Supplied Thread (INVALID: empty turn)

```bash
curl -X POST "http://localhost:$PORT/api/v1/chat" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "client_id": "curl-test",
    "user_id": "my-user-id",
    "message_type": "text",
    "history": [{ "user_message": "q", "assistant_response": "" }],
    "message": "hi"
  }'
```

**Response (400):**

```json
{ "error": "history[0].assistant_response is required and must be non-empty" }
```

### Suppress the Welcome and Memory

Both flags are independent of `history` and of each other. `suppress_welcome` skips the mode's first-contact welcome without writing any flag; `suppress_memory` removes the memory prompt slot, TOC and tools for the turn.

```bash
curl -X POST "http://localhost:$PORT/api/v1/chat" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "client_id": "curl-test",
    "user_id": "my-user-id",
    "message_type": "text",
    "suppress_welcome": true,
    "suppress_memory": true,
    "message": "#spoken hello"
  }'
```

**Response (400)** for a non-boolean flag:

```json
{ "error": "suppress_welcome must be a boolean" }
```

---

## Streaming Chat (SSE)

```bash
curl -X POST "http://localhost:$PORT/api/v1/chat/stream" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "client_id": "curl-test",
    "user_id": "my-user-id",
    "message": "What is Genesis 1:1?",
    "message_type": "text"
  }'
```

**Response (SSE events):**

```
data: {"type":"status","key":"status_processing","message":"Processing your request..."}

data: {"type":"progress","text":"In the beginning"}

data: {"type":"complete","response":{...}}
```

---

## Admin: MCP Server Management

The MCP server list is a **single global pool** shared by every organization
(admin-portal#278). The `:org` segment in these URLs keeps the route shape and
is echoed back in the `org` field, but it does not select data: every org sees
and edits the same list, stored under the reserved `MCP_SERVERS` key
`__global__`. Requests whose `:org` is literally `__global__` get `400`.

Responses never include a server's `authToken`; they report
`hasAuthToken: boolean` instead. On write (`POST` / `PUT`) the token is merged
by server `id`: omit `authToken` to keep whatever is stored, send `null` or
`""` to clear it, or a non-empty string to set it. Only the known config fields
(`id`, `name`, `url`, `enabled`, `priority`, `allowedTools`, `transport`,
`authToken`) are persisted; anything else in the body is dropped.

**Migration state.** While a namespace has no `__global__` key (KV returns
`null` — a stored value of `[]` is a real, empty pool, not a missing key),
reads fall back to the legacy `unfoldingWord` key, log `mcp_global_key_missing`,
and the GET body carries `migrated: false`, `code: "MCP_POOL_NOT_MIGRATED"`,
`fallback_found`, `legacy_keys` (every other key this read could see — the
fallback key it actually read is always included), `legacy_listing`
(`complete` / `truncated` / `failed` — `complete` means the server-side
pagination finished, **not** that the namespace is empty: KV `list` is
eventually consistent), `stale_global_suspected` (the listing showed
`__global__` although this read missed it — a stale read, retry) and a
`warning` that tells you what to do. In that state every `POST`/`PUT`/`DELETE`
returns `409` with the same fields plus `error`. The API never creates
`__global__` itself, and it never tells you the namespace is empty — you decide
that from your own listing:

```bash
npx wrangler kv key list --binding=MCP_SERVERS            # add --env staging / --local as needed
```

- **If that listing shows `__global__`**, the API read was stale (KV eventual
  consistency) — retry shortly. Do **not** seed `[]`, do **not** recreate the
  key from leftovers; the pool is already migrated.
- **If it shows other keys but not `__global__`**, create `__global__` from the
  **raw KV value(s)** of those legacy keys with the runbook on admin-portal#278
  (`wrangler kv key get … <legacy key>` → `wrangler kv key put … __global__ --path …`).
  Never write an admin `GET` body back as the migration payload: GET bodies
  are redacted (no `authToken`), so a `[]` seed followed by a `PUT` of a saved
  GET body silently drops every stored token.
- **Only if your listing shows no keys at all** (fresh or local namespace):

```bash
npx wrangler kv key put --binding=MCP_SERVERS --local __global__ '[]'
```

Once migrated, every admin GET carries `legacy_listing`; if the namespace still
holds legacy keys (or the server-side listing was incomplete, so leftovers may
exist unseen) it also carries `legacy_keys` and a `warning` that they are no
longer read — if `__global__` was seeded with `[]` by mistake, restore it from
the raw legacy value. Do not delete legacy keys until the global copy is
confirmed.

Once migrated, the admin routes are ordinary read-modify-write over KV, which
has no compare-and-swap: two admins writing at once (or a colo holding a stale
copy of `__global__`) resolve last-write-wins, as with every other admin config
route today.

**Authentication.** Every `/api/*` request must carry `ENGINE_API_KEY` or
`ADMIN_API_KEY` — the global middleware accepts nothing else. Admin routes need
super-admin authority: `ADMIN_API_KEY`, or `ENGINE_API_KEY` while
`ADMIN_KEY_REQUIRED` is unset, blank or `"false"` (README "Authentication"),
and the MCP write routes refuse anything else (403). Values stored in the
`ORG_ADMIN_KEYS` KV namespace are not accepted as bearer tokens. All examples
below use `$API_KEY`; use the admin key for the admin routes.

### List MCP Servers

```bash
curl "http://localhost:$PORT/api/v1/admin/orgs/unfoldingWord/mcp-servers" \
  -H "Authorization: Bearer $API_KEY"
```

**Response** (`org` echoes the URL; the list is the same for every org;
`migrated: true` means `__global__` exists — see "Migration state" above;
`legacy_listing` is always present on a migrated GET):

```json
{
  "org": "unfoldingWord",
  "migrated": true,
  "legacy_listing": "complete",
  "servers": [
    {
      "id": "translation-helps",
      "name": "Translation Helps MCP",
      "url": "https://translation-helps-mcp.pages.dev/api/mcp",
      "enabled": true,
      "priority": 1,
      "hasAuthToken": false
    }
  ]
}
```

### List MCP Servers with Discovery Status

Add `?discover=true` to run discovery and see which servers are working:

```bash
curl "http://localhost:$PORT/api/v1/admin/orgs/unfoldingWord/mcp-servers?discover=true" \
  -H "Authorization: Bearer $API_KEY"
```

**Response (with discovery):**

```json
{
  "org": "unfoldingWord",
  "migrated": true,
  "legacy_listing": "complete",
  "servers": [
    {
      "id": "translation-helps",
      "name": "Translation Helps MCP",
      "url": "https://translation-helps-mcp.pages.dev/api/mcp",
      "enabled": true,
      "priority": 1,
      "hasAuthToken": false,
      "discovery_status": "ok",
      "discovery_error": null,
      "tools_count": 5
    },
    {
      "id": "broken-server",
      "name": "Broken Server",
      "url": "https://invalid.example.com/mcp",
      "enabled": true,
      "priority": 2,
      "hasAuthToken": true,
      "discovery_status": "error",
      "discovery_error": "MCP server returned 404: Not Found",
      "tools_count": 0
    }
  ]
}
```

### Add MCP Server

```bash
curl -X POST "http://localhost:$PORT/api/v1/admin/orgs/unfoldingWord/mcp-servers" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "id": "translation-helps",
    "name": "Translation Helps MCP",
    "url": "https://translation-helps-mcp.pages.dev/api/mcp",
    "enabled": true,
    "priority": 1
  }'
```

`POST` upserts by `id`: posting an existing `id` replaces that entry in place.
Omitting `authToken` keeps the token already stored for that `id`.

### Set or Clear a Server's authToken

```bash
# Set (or rotate) the token — the response only reports hasAuthToken: true
curl -X POST "http://localhost:$PORT/api/v1/admin/orgs/unfoldingWord/mcp-servers" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "id": "fia",
    "name": "FIA Internalization",
    "url": "https://fia.example.com/mcp",
    "enabled": true,
    "priority": 3,
    "authToken": "new-upstream-secret"
  }'

# Clear the token: send null (or "")
curl -X POST "http://localhost:$PORT/api/v1/admin/orgs/unfoldingWord/mcp-servers" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "id": "fia",
    "name": "FIA Internalization",
    "url": "https://fia.example.com/mcp",
    "enabled": true,
    "priority": 3,
    "authToken": null
  }'
```

### Replace All MCP Servers

`PUT` replaces the whole pool with the array you send (servers you leave out
are removed; `[]` empties the pool; duplicate `id`s are rejected). Each entry's
`authToken` is merged by `id` under the same rule as `POST`, so a redacted
`GET` → edit → `PUT` round-trip keeps stored tokens.

```bash
curl -X PUT "http://localhost:$PORT/api/v1/admin/orgs/unfoldingWord/mcp-servers" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '[
    {
      "id": "translation-helps",
      "name": "Translation Helps MCP",
      "url": "https://translation-helps-mcp.pages.dev/api/mcp",
      "enabled": true,
      "priority": 1
    }
  ]'
```

### Delete MCP Server

```bash
curl -X DELETE "http://localhost:$PORT/api/v1/admin/orgs/unfoldingWord/mcp-servers/translation-helps" \
  -H "Authorization: Bearer $API_KEY"
```

---

## Admin: Partner API Keys

Named, revocable keys for partner apps (admin-portal#354). Our own clients
(web client, WhatsApp gateway, admin portal) keep using their deployment-wide
keys unchanged. These admin endpoints, like every `/api/v1/admin/*` route,
need super-admin authority: `ADMIN_API_KEY` (or `ENGINE_API_KEY` only while
`ADMIN_KEY_REQUIRED` is not `"true"`; production and staging set it to
`"true"`). A partner key never has it. The examples use `$API_KEY`; use the
admin key.

- The plaintext key (`apiKey`, shape `bts_<8 hex>_<43 base64url>_<11 base64url tag>`)
  is returned **once**, by create and rotate. It cannot be fetched again; only
  its SHA-256 is stored.
- **One writer.** Every admin operation goes to one Durable Object,
  `PartnerKeyStoreDO` (binding `PARTNER_KEY_STORE`), which runs them one at a
  time against its own transactional storage, the source of truth. Two admins
  acting on the same key at the same moment are simply applied in order.
- **Auth reads KV.** After each change the DO writes the key's record to
  `API_KEYS` KV at `key:<sha256>` (one write per changed key), and the chat
  auth reads only that. If the KV write fails, the change still stands, the
  response carries `"warnings": ["auth_update_pending"]`, and the DO retries
  the write from an alarm (every 30s) until it succeeds.
- **Tag.** The last 11 characters are an HMAC tag made with the
  `PARTNER_KEY_TAG_SECRET` secret. Auth checks it before any KV read, so a
  random or guessed token never costs a lookup. Without that secret partner
  keys can be neither issued nor used (every partner token gets `403 Invalid
API key`, and the misconfiguration is logged once per isolate), and
  changing it invalidates every issued key.
- List and get return the record (`id`, `prefix`, `name`, `app`, `org`,
  `createdBy`, `createdAt`, `scopes`, `userNamespace`, `status`, and when set
  `revokedAt`, `revokedBy`, `rotatedFrom`, `rotatedTo`, `expiresAt`,
  `termsVersion`, `termsAcceptedAt`, `limits`). Never the plaintext, never
  the hash. `expiresAt` is set on a key rotated away with a non-zero grace:
  the end of that grace, after which its `status` reads `expired`. `limits` is reserved for
  future per-key limits; no request can set it today, so it is absent.
- Create and rotate responses (the only ones carrying `apiKey`) are sent with
  `Cache-Control: no-store`.
- **Propagation.** KV is eventually consistent, and Cloudflare caches every
  KV read at the edge for 60s by default — misses ("negative lookups")
  included. So a revocation can take **about a minute** to take effect
  everywhere, and **a brand-new key may take up to ~60s to work everywhere**
  (a location that looked the key up just before it existed keeps answering
  `403` until its cached miss expires). To replace a key without a gap,
  prefer rotation with a grace period over create-then-revoke.
- List and get read the Durable Object, so they are always current and the
  list is always complete. Revoked keys are kept for audit.

### Create a Key

```bash
curl -X POST "http://localhost:$PORT/api/v1/admin/api-keys" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "org": "bcs",
    "name": "BCS production",
    "app": "BCS Translator App",
    "createdBy": "ops@unfoldingword.org",
    "termsVersion": "2026-11",
    "termsAcceptedAt": "2026-11-02T15:00:00Z"
  }'
```

**Response (201):** `{"key": {...record, "status": "active"}, "warnings": [], "apiKey": "bts_1a2b3c4d_..."}`

`org`, `name`, `app` and `createdBy` are required; `termsVersion` and
`termsAcceptedAt` are optional; `termsAcceptedAt` must be an ISO-8601
date-time with a time zone (`2026-11-02T15:00:00Z` or `...+02:00`). Size caps are UTF-8 bytes of the JSON-encoded
value: `name` and `app` 100, `createdBy` (and `revokedBy`) 120,
`termsVersion` 32. Labels must be a single line: a control character or line
break of any kind is a `400`, not silently removed. Any other field (for example `scopes` or
`limits`) is a `400`: every key has `scopes: ["chat"]`, and limits are not
settable yet.

**Unknown org.** The worker has no org registry, so an org counts as known
when it has any stored configuration (an `ORG_CONFIG` key `<org>`, or a
`PROMPT_OVERRIDES` key `<org>` / `<org>:*` such as `<org>:modes`), or is the
default org. Otherwise create returns `400 {"code": "unknown_org"}`, which
catches typos that would silently serve the defaults. For an org that will be
configured later, send `"allow_new_org": true`.

### List Keys (all orgs, or one)

```bash
curl "http://localhost:$PORT/api/v1/admin/api-keys" -H "Authorization: Bearer $API_KEY"
curl "http://localhost:$PORT/api/v1/admin/api-keys?org=bcs" -H "Authorization: Bearer $API_KEY"
```

**Response (200):** `{"org": "bcs" | null, "keys": [...records]}`

**Last used.** Each key in list and get (and the old key in a revoke or
rotate response) may carry `lastUsedAt`, an ISO-8601 time the key last
authenticated on an allowed route. It is absent until the key's first
recorded use. It is coarse: each worker instance records a key at most once
every 10 minutes, in the background, so `lastUsedAt` can be up to ~10 minutes
earlier than the key's true last request, never later. Refused requests
(revoked, expired, unknown, or a route outside the allowlist) are not
recorded. A rotated key's replacement starts with no `lastUsedAt`; the old
key keeps its own.

### Get One Key

```bash
curl "http://localhost:$PORT/api/v1/admin/api-keys/pk_0123456789abcdef" \
  -H "Authorization: Bearer $API_KEY"
```

### Revoke a Key

Immediate, and **revoke kills the whole chain**: any predecessor of this key
that is still working in its rotation grace window is revoked too, so revoking
the current key really cuts the partner off. The response lists every key this
call revoked in `revokedIds` (this key first, then its predecessors).
Idempotent: revoking a revoked key returns it unchanged with
`"alreadyRevoked": true` and `revokedIds: []` (its chain was already killed
when it was revoked). The body is optional.

```bash
curl -X POST "http://localhost:$PORT/api/v1/admin/api-keys/pk_0123456789abcdef/_revoke" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"revokedBy": "ops@unfoldingword.org"}'
```

### Rotate a Key

Issues a new key with the same name, app, org, terms and `userNamespace` (so
the partner's users keep their history), then retires the old one. Returns
`{"key": {...new}, "previous": {...old}, "revokedIds": [...], "warnings": [], "apiKey": "bts_..."}`.

**Grace window.** By default the old key keeps working for 7 days
(`previous.expiresAt`), so the partner can ship the new key without an
outage; after that it gets `403` (reason `expired_partner_key`) and shows
`status: "expired"`. Set `graceSeconds` (integer, 0 to 2592000 = 30 days; `null` is a `400`) to
change it; `"graceSeconds": 0` revokes the old key at once ("rotate and kill
now"), together with any older keys still in their own grace window, and the
response lists them in `revokedIds`. An explicit `_revoke` is always immediate, also during a grace window.

A revoked or expired key, or one already rotated, cannot be rotated (`409`);
create a new key or rotate the replacement instead. Two rotations of the same
key sent together are applied in order: the first succeeds and the second
gets `409` (already rotated). The new key, the retired old key and any chain
revocations are written in one atomic step. `warnings` is `[]`, or
`["auth_update_pending"]` when the KV write for auth is still being retried
(see above). The body is optional:
`{"createdBy": "...", "graceSeconds": 86400}`.

**A lost response.** The plaintext is never stored, so a create or rotate
response that does not arrive cannot be fetched again. Recover like this:

- **Lost rotate response:** `GET` the old key; its `rotatedTo` is the new key
  id (a repeated rotate of the old key also answers `409` with
  `"code": "already_rotated"` and `"rotatedTo"`). Rotate that new key id to
  get a fresh `apiKey`. Keep a grace period: the old key keeps working through
  its own grace window meanwhile. `"graceSeconds": 0` removes this safety net,
  because it revokes the old key at once, so a lost grace-0 response leaves
  the partner with no working key until the new key is rotated.
- **Lost create response:** nobody has the key. Find it in the list, revoke it
  (or rotate it) and use the new `apiKey`.

```bash
curl -X POST "http://localhost:$PORT/api/v1/admin/api-keys/pk_0123456789abcdef/_rotate" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"createdBy": "ops@unfoldingword.org", "graceSeconds": 86400}'
```

### Import a Partner App's Existing Users (super-admin)

For an app that used to call with the shared `ENGINE_API_KEY` and is moving to
a partner key. Its users' conversations live under their raw `user_id`; with
the partner key the same user is namespaced, so without this step they would
start over. This copies the named users' data (history, preferences, memory,
prompt overrides, selected mode and language, welcome flags) into the key's
namespace, once.

```bash
curl -X POST "http://localhost:$PORT/api/v1/admin/api-keys/pk_0123456789abcdef/_import-legacy-users" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"legacyClientId": "my-app", "userIds": ["user-1", "user-2"]}'
```

**Response (200):** `{"keyId": "...", "org": "...", "results": [{"userId": "user-1", "status": "copied", "entries": 6}, ...]}`

- Only a super-admin key (`ADMIN_API_KEY`) can call it. The partner key itself never gets access
  to raw user ids: conversations are keyed by org and user id only, so raw-id
  access would let it reach other clients' users.
- The source is the user's conversation in the **key's org**, and it is
  copied only when its stored identity is a private chat whose `client_id`
  equals `legacyClientId`. Otherwise the status is `client_mismatch`, or
  `not_found` when there is no identity record. `destination_not_empty` means
  the partner key has already been used for that user; nothing is
  overwritten. `destination_busy` means a turn is running or queued for that
  user under the partner key, and `source_busy` the same for the shared-key
  user (the export, and the check and write, are each one storage
  transaction inside that user's DO, refused while a turn holds its lock or
  anything is queued; the import never takes the lock itself); retry later. `failed` is logged.
- The key must be active: a revoked or expired key gets `409`
  (`key_revoked` / `key_expired`). The status is checked again before each
  batch of 5 users: if the key is revoked (or its grace runs out) during the
  import, the import stops and the users not yet copied are reported
  `key_revoked` / `key_expired` (or `status_check_failed`, logged, if the
  status cannot be read). The response is still `200` with every user's
  status.
- One import per key chain at a time: while an import into the same user
  namespace is running (the same key, or another key of its rotation
  chain), another gets `409` with `code: "import_in_progress"` and does
  nothing. A running import renews its lease before each user and before
  any cleanup, so it keeps it however long it runs; a run that died stops
  blocking after 10 minutes. If a run ever loses its lease, it copies and
  deletes nothing more and reports the users not yet done as `deferred`
  (re-run the import for them).
- Per user, in this order: a read-only check that the destination is empty
  and idle (otherwise `destination_not_empty` / `destination_busy`, with
  nothing copied), the source export, the audio copy, then the write (which
  checks the destination again).
- Audio the copied history references (`voice_audio_key` TTS replies,
  `inbound_voice_audio_key` voice messages, and each audio entry of
  `attachments[]`) is copied in R2, streamed, into the partner's partition
  (`audio/<org>/partner:<ns>:<user_id>/...`,
  `voice-submissions/<org>/partner:<ns>:<user_id>/...`), and the keys in the
  copied history are rewritten (for an attachment, its `r2_key` and `url`),
  so the partner key can download it. Source
  objects are not changed. A copy that already exists (from an earlier run)
  is reused, never overwritten. Each copied user's result carries
  `audio: { copied, existing, missing }`.
  - A source object that no longer exists keeps its history entry without
    the audio key, or without that attachment (logged, `missing`).
  - Any other copy failure fails the user: `audio_copy_failed`, nothing
    written to the destination, and only the objects this run created are
    removed. Re-run to retry.
  - Copies are removed only when the destination definitely did not take
    the write (a `destination_not_empty` / `destination_busy` refusal, or a
    body refused before any write). If the write's outcome is unknown (the
    request failed, or the answer was not a readable result), the user is
    `import_outcome_unknown` (logged) and the copies are kept: re-running
    reports `destination_not_empty` if the write landed, or imports again
    reusing those copies if it did not.
- One request does at most 800 R2 and Durable Object operations (a margin
  under Cloudflare's per-request subrequest limit). Users that would not fit,
  and every user after them, are reported `deferred`; re-run the import with
  those ids to continue.
- Every copied value must survive a JSON round-trip (all UserDO data is JSON
  today). An object member that is `undefined` is dropped (it carries
  nothing either way). Anything else that would not survive (a `Date`,
  `Map`, `Set`, binary data, `NaN` or `Infinity`, a function) makes that
  user `failed` (logged with the storage key), and nothing is written.
- The source is not changed or deleted. Each user is copied once, as it is
  at that moment: a turn the app sends with the shared key after that user's
  export is NOT copied. Cut-over runbook, in this order:
  1. Stop the app's shared-key traffic (pause the app, or put it in
     maintenance).
  2. Run the import, and re-run it for any user reported `source_busy` /
     `destination_busy` until each is `copied` (or a status you accept).
  3. Switch the app to the partner key and resume traffic.
- `userIds`: 1-100 distinct ids, each valid as a partner `user_id`.
- Only shared-key users can be imported: a `legacyClientId` starting with
  `partner:`, or a `userId` containing `partner:`, is a `400`, so one
  partner's users can never be copied into another partner's namespace.

### Calling Chat With a Partner Key

A partner key may call **only** `POST /api/v1/chat`,
`POST /api/v1/chat/stream`, and `GET` on the two audio download routes
(`/api/v1/audio/...` and `/api/v1/voice-submissions/...`, for its own audio
only; see below). Every other `/api/*` route answers `403`
(`This API key is not permitted to call this endpoint`). That answer is given
only once the key is authenticated (tag checked, key found and active); a
forged or unknown look-alike gets `403 Invalid API key` on every route. On
those two routes:

- `org` / `org_id` may be omitted or `null` (the key's org applies) or equal
  the key's org; any other value is a `400`.
- `client_id` is **set by the server** to `partner:<userNamespace>`; whatever
  the body sends is discarded. A partner can therefore not pose as
  `whatsapp`, `web` or `admin-portal`, and none of its text reaches the
  prompt (which says only "a partner app").
- `user_id`, `chat_id` and `thread_id` must be single-line strings of at most
  256 characters (`400` otherwise; `null` counts as absent for the optional
  two). Single-line excludes all control characters (C0 and C1), the
  Unicode line/paragraph separators and invisible format characters. Leading
  or trailing whitespace is refused, not trimmed. `chat_id` and `thread_id`
  may use only letters, digits, `_`, `.` and `-` (no `:`: the group
  conversation name joins them with `:`). `user_id` may not contain `/`, `?`,
  `#`, `%` or `\`, so every partner user stays addressable in the
  `/users/:userId` routes. `chat_id` is stored with the
  key's prefix, so it may be at most 228 characters (256 minus the prefix);
  `thread_id` up to 256.
- `speaker` may be at most 256 characters (longer is `400`,
  `partner_speaker`). A partner's speaker is then normalized before it is
  stored, logged or reaches the prompt: brackets removed, line breaks and
  controls flattened to one space, capped at 64 characters. (Internal
  clients' speakers are stored as sent; the prompt sanitizes every speaker.)
- `progress_callback_url` (and the other callback fields) are refused (`400`,
  the existing `/chat` and `/chat/stream` validation, worded for partners as
  "progress callbacks are not available with partner API keys").
- Audio works as for internal clients (decided 2026-11-02): voice messages
  in (`message_type: "audio"`, `audio_base64`, `audio_format`, with the same
  size and format limits) and spoken replies out (`voice_format`, the audio
  tools and the audio prompt guidance). Reply audio comes back as
  `voice_audio_url` (`/api/v1/audio/...`); archived voice messages and
  attached recordings as `/api/v1/voice-submissions/...` URLs. Fetch them
  with the same partner key.
- **Audio ownership.** A partner's audio lives in its own partition: TTS
  replies at `audio/<org>/partner:<ns>:<user_id>/<file>` and voice
  submissions at `voice-submissions/<org>/partner:<ns>:<chat>/<speaker>/<file>`
  (the chat segment is the user for a private chat, the group for a group).
  A partner key downloads only keys with exactly that shape, in its key's org
  and its own namespace; any other key (another partner's, an internal
  user's, another org's) answers `404`, exactly like a missing object. In a
  partner chat, `attach_audio` / `read_r2_object` reach only that partner's
  own recordings, and internal chats can never attach a partner's recording.
  There is no listing route.
- Inside the worker `user_id` becomes
  `partner:<userNamespace>:<user_id>` (and `chat_id` likewise), so a partner's
  users can never reach another app's or a WhatsApp user's conversation.
  That form is reserved: an internal (`ENGINE_API_KEY` / `ADMIN_API_KEY`)
  caller sending a `user_id`, or a
  `chat_id` (joined with `thread_id` as `<chat_id>:<thread_id>`, as in the
  group's name), that starts with `partner:` gets a `400`; so does a
  `partner:`-form `:userId` on the non-admin user routes
  (`/api/v1/orgs/:org/users/:userId/preferences` and `/history`). The
  super-admin `/api/v1/admin/...` routes may still address partner users.
- For every caller, an `org` containing `:` is a `400` wherever it names a
  conversation: chat bodies (`org` / `org_id`) and every `/orgs/:org/users/...`
  and `/orgs/:org/groups/...` route, admin or not (`invalid_org`).
  Conversation names join their parts with `:`, so such an org could rebuild
  another org's or a partner's name.

```bash
export PARTNER_KEY="bts_..."   # from the create response
curl -X POST "http://localhost:$PORT/api/v1/chat" \
  -H "Authorization: Bearer $PARTNER_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "client_id": "bcs-app",
    "user_id": "user-42",
    "message": "What is Genesis 1:1?",
    "message_type": "text"
  }'
```

An unknown, revoked or expired key, or a token whose tag does not verify, gets
`403 {"error": "Invalid API key"}` (logged as `auth_rejected` with reason
`unknown_partner_key`, `revoked_partner_key`, `expired_partner_key` or
`invalid_partner_key_tag`).
Every chat request logs `key_id` on `request_received` (`"internal"` for
`ENGINE_API_KEY`), which is how usage and "last used" per key are read from
telemetry.

---

## Admin: Mode Management — `spoken-mode` (STAGING ONLY)

> ⚠️ **STAGING ONLY.** The procedure below pushes the assembled
> `spoken-mode` mode document to the **staging** API. **Do not run this
> against production** until the mode has been validated with a real
> group on staging. Prod promotion is a separate manual step.
>
> Source of truth for the mode's behavior is
> [`docs/spoken-mode-flow.md`](spoken-mode-flow.md). The assembled
> mode document — what actually gets pushed below — is
> [`docs/spoken-mode-document.md`](spoken-mode-document.md). If the
> flow doc and the assembled document disagree, edit the assembled
> document to match.

### Prerequisite: verify MCP servers are registered on staging

The mode's `tool_guidance` slot names `translation-helps` and `aquifer`
explicitly. Confirm both are registered in the global pool on staging
before pushing the mode — otherwise Claude will be instructed to call
servers that don't exist.

```bash
STAGING_BASE_URL="https://staging-api.btservant.ai"
STAGING_ADMIN_KEY="<paste staging admin key>"

curl -s "$STAGING_BASE_URL/api/v1/admin/orgs/unfoldingWord/mcp-servers" \
  -H "Authorization: Bearer $STAGING_ADMIN_KEY" \
  | jq '.servers[] | .id'
```

Expect both `"translation-helps"` and `"aquifer"` in the output. If
either is missing, register it first (template above under "Add MCP
Server").

### Push the `spoken-mode` mode document to staging

Uses the new `{ document }` storage shape per worker PR #200. The
seven canonical H2 headings inside the document define the slot
boundaries (`src/types/mode-markdown.ts`).

```bash
STAGING_BASE_URL="https://staging-api.btservant.ai"
STAGING_ADMIN_KEY="<paste staging admin key>"

# Read the assembled mode document and PUT it. jq -Rs reads the whole
# file as a single JSON string so newlines and quoting are escaped
# correctly inside the request body.
DOC_JSON=$(jq -Rs '.' < docs/spoken-mode-document.md)

cat <<EOF | curl -X PUT "$STAGING_BASE_URL/api/v1/admin/orgs/unfoldingWord/modes/spoken-mode" \
  -H "Authorization: Bearer $STAGING_ADMIN_KEY" \
  -H "Content-Type: application/json" \
  --data-binary @-
{
  "label": "Spoken Mode",
  "description": "Facilitator-coach for oral-preference Bible translation groups. Walks a group from story collection through community-checked oral draft for a single passage.",
  "published": true,
  "document": $DOC_JSON
}
EOF
```

### Verify the round-trip on staging

Confirm the document round-trips through synthesize/parse cleanly (no
slot lost, no orphaned content):

```bash
curl -s "$STAGING_BASE_URL/api/v1/admin/orgs/unfoldingWord/modes/spoken-mode" \
  -H "Authorization: Bearer $STAGING_ADMIN_KEY" \
  | jq '.mode | {name, label, published, document_length: (.document | length)}'
```

Then list all modes on staging and confirm `spoken-mode` appears with
`published: true`:

```bash
curl -s "$STAGING_BASE_URL/api/v1/admin/orgs/unfoldingWord/modes" \
  -H "Authorization: Bearer $STAGING_ADMIN_KEY" \
  | jq '.modes[] | {name, published}'
```

### Smoke-test from the admin portal

Once the mode is pushed, exercise it end-to-end via the portal's
test-chat pane (per admin-portal PR #107: "wire test chat to active
mode + language selection") before involving a real Telegram group.

---

## Admin: Mode Share Code (admin-portal#345)

The authoritative WhatsApp chat code for a mode, as seen from the org a
WhatsApp request carries (`home_org`, the gateway's `ENGINE_ORG`). The worker
answers by running its own chat path: the same cross-org read (per-turn org
cap included), the same first-wins collision handling, and the real `#`-token
classifier (exact, then prefix, then fuzzy) over `#<code>`. The portal uses it
instead of re-deriving the code for QR codes and `wa.me` links.

`home_org` is compared to `:org` by exact key, like the chat path: `PBT` and
`pbt` are different orgs.

```bash
curl -s "http://localhost:$PORT/api/v1/admin/orgs/PBT/modes/obt-coach/share-code?home_org=unfoldingWord" \
  -H "Authorization: Bearer $ADMIN_API_KEY"
```

**Response (200):**

```json
{
  "code": "pbt/obt-coach",
  "resolves": true,
  "resolved_org": "PBT",
  "home_has_modes": true,
  "worker_version": "2.60.0"
}
```

- `code`: the token without `#`. A bare slug for a home mode, `<orgslug>/<slug>`
  for another org's. `null` only when the org name slugs to nothing.
- `resolves`: `true` only when sending `#<code>` from `home_org` selects exactly
  this org's mode.
- `reason` (only when `resolves` is false), checked in this order:
  `org_skipped`; `invalid_mode` (another org's mode fails the shape check the
  admin PUT enforces, so the cross-org merge drops it; never reported for a
  home mode, which chat serves as long as it has a string name); `draft`;
  `requires_group`; `reserved` (a home slug that is a clear token, like
  `default`; `pbt/default` is not one); `capped` (the org is past the
  per-turn foreign-org cap, so the chat path never reads it); `collision`
  (another org with the same slug claimed the name first, or another mode in this org already uses this name as an alias, or an earlier element of this org with the same name or alias wins chat's first-match lookup, such as an earlier draft or group-only duplicate); `ambiguous` (the
  message opens a different mode); `not_found` (it opens nothing).
- `resolved_org`: the raw org name of the mode `#<code>` actually opens, when
  it opens one. It comes only from the classifier's actual match, run on the
  whole message `#<code>`: on `collision` it is the winning org when the
  winner's mode is visible in a private chat, and absent when it is hidden
  (for example `requires_group`).
- `resolved_org_uncertain`: `true` only on a `resolves: false` answer when
  another org's modes could not be read. The `resolves` verdict and the
  `reason` stand (a failed read can only add competitors, never this org's
  own match), but which look-alike the code opens is unknown, so
  `resolved_org` is omitted; `ambiguous` vs `not_found` is equally uncertain.
- `home_has_modes`: whether `<home_org>:modes` exists as a modes record.
  `false` is legal (the chat path treats it as an empty home org) but usually
  means a mistyped gateway org, so the portal can warn. Absent when the home
  record could not be read or is not valid JSON, for a foreign mode; the answer is then computed
  with an empty home, as the chat path would, because a home record never
  affects a `<orgslug>/<slug>` token.

Draft and `requires_group` modes still return the would-be `code`.

`:modeName` is resolved the way chat resolves it: a mode whose name matches
wins over a mode that only lists it as an alias, and among duplicates the
one chat serves wins (home: the first published, non-`requires_group` one;
another org: the first published one that passes the shape check).

Like every `/api/v1/admin/*` route, this needs super-admin authority:
`ADMIN_API_KEY`, or `ENGINE_API_KEY` only while `ADMIN_KEY_REQUIRED` is not
enforced. With it enforced, `ENGINE_API_KEY` gets `403` with
`code: "admin_key_required"`.

**Errors:**

| Status | Body                                                    | When                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------ | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 400    | `{"error":"home_org_required","field":"home_org",...}`  | `home_org` is missing or empty                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 400    | `{"error":"invalid_mode_name",...}`                     | `:modeName` fails the slug pattern                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 400    | `{"error":"invalid_org","field":"org"\|"home_org",...}` | that field's `<org>:modes` key would exceed the 512-byte KV key limit                                                                                                                                                                                                                                                                                                                                                                                                         |
| 404    | `{"error":"mode_not_found",...}`                        | no such org or mode                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 500    | `{"error":"corrupt_modes_record",...}`                  | `<org>:modes` is not valid JSON, or is JSON but not a `{ "modes": [...] }` record (permanent; fix the record)                                                                                                                                                                                                                                                                                                                                                                 |
| 503    | `{"error":"modes_unavailable","detail":...}`            | retry. `list_failed`: the key listing failed. `listing_lag`: a complete listing does not show the record yet. `read_failed`: the target record could not be read, or an unreadable org with the same slug that sorts first could change who owns the name (it could claim it, or drop an earlier claimant's mode). A corrupt foreign org is skipped, as on the chat path; a failed home read for a foreign mode is not a 503; other failed reads set `resolved_org_uncertain` |

A 404 without `"error":"mode_not_found"` means the route itself is missing (a
worker older than 2.60.0).

Cost per call: one get each of `<org>:modes` and `<home_org>:modes` (one get
when they are the same org). A home mode needs nothing more, because a bare
`#token` only ever matches home modes. A foreign mode adds the chat path's key
listing and up to 50 foreign gets, reusing the two records already read. The
route answers one mode per call; it is admin-only and low traffic.

---

## Testing All E2E Scenarios

```bash
# Set variables
PORT=65197
API_KEY="test-api-key-for-local-dev"

# Test 1: Get default preferences
curl -s "http://localhost:$PORT/api/v1/users/test/preferences" -H "Authorization: Bearer $API_KEY"

# Test 2: Set valid language
curl -s -X PUT "http://localhost:$PORT/api/v1/users/test/preferences" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"response_language": "es"}'

# Test 3: Verify persistence
curl -s "http://localhost:$PORT/api/v1/users/test/preferences" -H "Authorization: Bearer $API_KEY"

# Tests 4-8: Invalid language codes (all return 400)
curl -s -X PUT "http://localhost:$PORT/api/v1/users/test/preferences" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"response_language": "english"}'  # too long

curl -s -X PUT "http://localhost:$PORT/api/v1/users/test/preferences" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"response_language": "EN"}'  # uppercase

# Test 9: Get empty history
curl -s "http://localhost:$PORT/api/v1/users/test/history?user_id=test" -H "Authorization: Bearer $API_KEY"

# Test 10: History with limit
curl -s "http://localhost:$PORT/api/v1/users/test/history?user_id=test&limit=10" -H "Authorization: Bearer $API_KEY"

# Test 11: History limit capped at 50
curl -s "http://localhost:$PORT/api/v1/users/test/history?user_id=test&limit=100" -H "Authorization: Bearer $API_KEY"

# Tests 12-13: Invalid chat messages (return 400)
curl -s -X POST "http://localhost:$PORT/api/v1/chat" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"client_id":"test","user_id":"test","message":"","message_type":"text"}'
```
