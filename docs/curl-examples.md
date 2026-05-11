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
data: {"type":"status","message":"Processing your request..."}

data: {"type":"progress","text":"In the beginning"}

data: {"type":"complete","response":{...}}
```

---

## Admin: MCP Server Management

Admin endpoints require either:

- `ENGINE_API_KEY` (super admin - manages all orgs)
- Org-specific admin key stored in KV namespace `ORG_ADMIN_KEYS`

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

Clients can then use the org-specific key instead of the super admin key:

```bash
curl "http://localhost:$PORT/api/v1/admin/orgs/unfoldingWord/mcp-servers" \
  -H "Authorization: Bearer your-org-specific-api-key"
```

### List MCP Servers

```bash
curl "http://localhost:$PORT/api/v1/admin/orgs/unfoldingWord/mcp-servers" \
  -H "Authorization: Bearer $API_KEY"
```

**Response:**

```json
{
  "org": "unfoldingWord",
  "servers": []
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
  "servers": [
    {
      "id": "translation-helps",
      "name": "Translation Helps MCP",
      "url": "https://translation-helps-mcp.pages.dev/api/mcp",
      "enabled": true,
      "priority": 1,
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

### Replace All MCP Servers

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
explicitly. Confirm both are registered for `unfoldingWord` on staging
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
