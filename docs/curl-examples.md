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

**Authentication.** Every `/api/*` request must carry `ENGINE_API_KEY` — the
global middleware accepts nothing else, and the MCP write routes additionally
refuse anything but the super admin key (403). The `ORG_ADMIN_KEYS` mechanism
below is defined in code but not currently reachable; it is kept here as a
reference for the org-scoped routes, not as a way to reach the global pool.

### Setting Up Org-Specific Admin Keys

To allow delegated administration for specific organizations, store admin keys in the `ORG_ADMIN_KEYS` KV namespace:

```bash
# Create the KV namespace (one-time setup)
npx wrangler kv:namespace create ORG_ADMIN_KEYS

# Add the namespace ID to wrangler.toml (replace placeholder-id-for-dev)

# Set an org-specific admin key
npx wrangler kv:key put --binding=ORG_ADMIN_KEYS "unfoldingWord" "your-org-specific-api-key"

# List all org keys
npx wrangler kv:key list --binding=ORG_ADMIN_KEYS
```

Clients would then use the org-specific key instead of the super admin key —
but see **Authentication** above: today every `/api/*` request must carry
`ENGINE_API_KEY`, so all examples below use `$API_KEY`.

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
  -H "Authorization: Bearer $API_KEY"
```

**Response (200):**

```json
{
  "code": "pbt/obt-coach",
  "resolves": true,
  "resolved_org": "PBT",
  "home_has_modes": true,
  "worker_version": "2.59.0"
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
  (another org with the same slug claimed the name first); `ambiguous` (the
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

Only the super-admin key (`ENGINE_API_KEY`) reaches this route; org-scoped
admin keys are refused by the `/api/*` gate.

**Errors:**

| Status | Body                                         | When                                                                                                                                                                                                                                                                                                                                                                              |
| ------ | -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 400    | `{"error":"home_org_required",...}`          | `home_org` is missing or empty                                                                                                                                                                                                                                                                                                                                                    |
| 400    | `{"error":"invalid_mode_name",...}`          | `:modeName` fails the slug pattern                                                                                                                                                                                                                                                                                                                                                |
| 400    | `{"error":"invalid_org",...}`                | `<org>:modes` or `<home_org>:modes` would exceed the 512-byte KV key limit                                                                                                                                                                                                                                                                                                        |
| 404    | `{"error":"mode_not_found",...}`             | no such org or mode                                                                                                                                                                                                                                                                                                                                                               |
| 500    | `{"error":"corrupt_modes_record",...}`       | `<org>:modes` is not valid JSON (permanent; fix the record)                                                                                                                                                                                                                                                                                                                       |
| 503    | `{"error":"modes_unavailable","detail":...}` | retry. `list_failed`: the key listing failed. `listing_lag`: the listing does not show the record yet. `read_failed`: the target record could not be read, or this org's own match could have been pre-empted by an unreadable org with the same slug that sorts first. A corrupt foreign org is skipped, as on the chat path; a failed home read for a foreign mode is not a 503 |

A 404 without `"error":"mode_not_found"` means the route itself is missing (a
worker older than 2.59.0).

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
