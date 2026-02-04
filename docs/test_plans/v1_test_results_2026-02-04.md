# V1 Test Results - 2026-02-04

Manual test execution of `v1_general_test_plan.md` against production (`api.btservant.ai`).

**Test Date**: 2026-02-04 17:40 UTC
**Environment**: Production (api.btservant.ai)
**Tester**: Claude
**Result**: All 15 tests passed

## Summary

| Test | PR        | Description                            | Result   |
| ---- | --------- | -------------------------------------- | -------- |
| 1    | -         | Health & Domain                        | **PASS** |
| 2    | #24       | Org Config - Get Defaults              | **PASS** |
| 3    | #24       | Org Config - Valid Update              | **PASS** |
| 4    | #24       | Org Config - Invalid (llm > storage)   | **PASS** |
| 5    | #24       | Org Config - Reset to Defaults         | **PASS** |
| 6    | #22       | MCP Servers - List from KV             | **PASS** |
| 7    | #23       | Migration Endpoints - 404              | **PASS** |
| 8    | #22       | User Preferences - Get Default         | **PASS** |
| 9    | #22       | User Preferences - Valid Update        | **PASS** |
| 10   | #22       | User Preferences - Invalid (uppercase) | **PASS** |
| 11   | #22       | User History - Empty for New User      | **PASS** |
| 12   | #21/22/24 | Chat - Valid Request + MCP Tools       | **PASS** |
| 13   | #22/24    | User History - Saved After Chat        | **PASS** |
| 14   | #25       | Request Serialization - 429            | **PASS** |
| 15   | #25       | Streaming Endpoint                     | **PASS** |

---

## Detailed Test Results with Log Evidence

### Test 1: Health & Domain Verification

**Returned Response**:

```json
{ "status": "healthy", "version": "0.2.0" }
```

**Log Evidence**: No log entry generated (health endpoint doesn't log for performance reasons).

**Assessment**: The new `api.btservant.ai` domain successfully resolved and returned the expected health check response. The 200 status code and correct JSON structure confirm the Cloudflare Workers deployment is accessible via the custom domain. This verifies the DNS/routing configuration is correct.

---

### Test 2: Org Config - Get Defaults (PR #24)

**Returned Response**:

```json
{ "org": "unfoldingWord", "config": { "max_history_storage": 50, "max_history_llm": 5 } }
```

**Log Evidence**:

```json
{
  "event": "admin_action",
  "timestamp": 1770226814431,
  "action": "get_org_config",
  "org": "unfoldingWord",
  "config": { "max_history_storage": 50, "max_history_llm": 5 }
}
```

**Assessment**: The logs confirm the `get_org_config` admin action was executed for the `unfoldingWord` organization. The returned config matches the default values defined in PR #24: `max_history_storage: 50` (how many turns to store) and `max_history_llm: 5` (how many turns to send to Claude). This validates that the two-tier history system defaults are working correctly.

---

### Test 3: Org Config - Valid Update (PR #24)

**Returned Response**:

```json
{
  "org": "unfoldingWord",
  "config": { "max_history_storage": 75, "max_history_llm": 10 },
  "message": "Org config updated"
}
```

**Log Evidence**:

```json
{
  "event": "admin_action",
  "timestamp": 1770226820824,
  "action": "update_org_config",
  "org": "unfoldingWord",
  "config": { "max_history_storage": 75, "max_history_llm": 10 }
}
```

**Assessment**: The `update_org_config` admin action successfully persisted the new configuration to KV storage. The logs show the exact values that were stored (75/10), and the response confirmed the update. This validates that PR #24's org config PUT endpoint correctly accepts and stores valid configuration values.

---

### Test 4: Org Config - Invalid Update (PR #24)

**Returned Response** (HTTP 400):

```json
{ "error": "max_history_llm cannot exceed max_history_storage" }
```

**Log Evidence**: PUT request received but no `admin_action` log was emitted, confirming the validation rejected the request before any persistence occurred.

**Assessment**: The validation logic correctly rejected the invalid configuration where `max_history_llm` (10) exceeded `max_history_storage` (5). The request was blocked at the validation layer (400 response) without touching KV storage. This confirms PR #24's cross-field validation is working as designed to prevent illogical configurations.

---

### Test 5: Org Config - Reset (PR #24)

**Returned Response**:

```json
{
  "org": "unfoldingWord",
  "config": { "max_history_storage": 50, "max_history_llm": 5 },
  "message": "Org config reset to defaults"
}
```

**Log Evidence**:

```json
{
  "event": "admin_action",
  "timestamp": 1770226832884,
  "action": "reset_org_config",
  "org": "unfoldingWord"
}
```

**Assessment**: The `reset_org_config` action was logged, confirming the DELETE endpoint removed the custom configuration from KV. The response shows the config reverted to system defaults (50/5). This validates that organizations can reset their configuration without leaving orphaned data.

---

### Test 6: MCP Servers - List (PR #22)

**Returned Response**:

```json
{
  "org": "unfoldingWord",
  "servers": [
    {
      "id": "translation-helps",
      "name": "Translation Helps MCP",
      "url": "https://tc-helps.mcp.servant.bible/api/mcp",
      "priority": 1,
      "enabled": true
    }
  ]
}
```

**Log Evidence**:

```json
{
  "event": "admin_action",
  "timestamp": 1770226837756,
  "action": "list_mcp_servers",
  "org": "unfoldingWord",
  "server_count": 1,
  "discover": false
}
```

**Assessment**: The `list_mcp_servers` action confirmed that MCP server configuration is now being read from KV (not from DO storage as before PR #22). The log shows `server_count: 1`, matching the response. The `discover: false` indicates we didn't run discovery (which would have probed the MCP server). This validates that PR #22's migration to KV storage is working.

---

### Test 7: Migration Endpoints Removed (PR #23)

**Returned Response**: Both endpoints returned `404 Not Found`.

**Log Evidence**:

```
POST https://api.btservant.ai/api/v1/admin/orgs/unfoldingWord/migrate-mcp-to-kv - Ok @ 2/4/2026, 5:40:43 PM
POST https://api.btservant.ai/api/v1/admin/orgs/unfoldingWord/cleanup-org-do - Ok @ 2/4/2026, 5:40:45 PM
```

**Assessment**: The log shows both POST requests hit the worker (status "Ok" means the request was received), but no `admin_action` events were logged because the routes no longer exist. The 404 responses confirm PR #23 successfully removed these temporary migration endpoints. The endpoints served their purpose during the migration and are now correctly gone.

---

### Test 8: User Preferences - Get Default (PR #22)

**Returned Response**:

```json
{ "response_language": "en" }
```

**Log Evidence**:

```json
{
  "event": "user_request_received",
  "request_id": "f163d975-4cb8-4eaa-a28a-da092c113bc6",
  "timestamp": 1770226850135,
  "user_id": "test-user-manual",
  "org": "unfoldingWord",
  "path": "/preferences",
  "method": "GET"
}
```

Followed by internal DO routing: `GET https://api.btservant.ai/preferences`

**Assessment**: The logs show the new user-scoped routing path (`/api/v1/orgs/:org/users/:userId/preferences`) correctly identified the user and org, then routed to the user's Durable Object. The internal DO request to `/preferences` confirms the request reached the correct user-scoped DO (not an org-scoped DO as before PR #22). Default language "en" was returned for a new user.

---

### Test 9: User Preferences - Valid Update (PR #22)

**Returned Response**:

```json
{ "response_language": "es" }
```

**Log Evidence**:

```json
{
  "event": "user_request_received",
  "request_id": "bc6fbda3-cfd0-4a6e-871e-36ddb9d43284",
  "timestamp": 1770226856020,
  "user_id": "test-user-manual",
  "org": "unfoldingWord",
  "path": "/preferences",
  "method": "PUT"
}
```

**Assessment**: The PUT request was correctly routed to the user-scoped DO. The preference was persisted (as verified by the response) and this user's language is now "es". This preference will be used in subsequent chat requests to respond in Spanish, demonstrating that user preferences are properly isolated to individual users (PR #22's user scoping fix).

---

### Test 10: User Preferences - Invalid Update (PR #22)

**Returned Response** (HTTP 400):

```json
{
  "error": "Invalid response_language",
  "message": "Must be a valid ISO 639-1 language code (2 lowercase letters, e.g., \"en\", \"es\", \"fr\")"
}
```

**Log Evidence**: Request received but no preference update logged.

**Assessment**: The validation correctly rejected "EN" (uppercase) as an invalid language code. The detailed error message provides clear guidance on the expected format. This validates that PR #22's language code validation is working - only ISO 639-1 codes (2 lowercase letters) are accepted.

---

### Test 11: User History - Empty (PR #22)

**Returned Response**:

```json
{ "user_id": "test-user-manual", "entries": [], "total_count": 0, "limit": 50, "offset": 0 }
```

**Log Evidence**:

```json
{
  "event": "user_request_received",
  "request_id": "1757f29c-60cd-47e3-9d5b-72954522cfcb",
  "timestamp": 1770226866336,
  "user_id": "test-user-manual",
  "org": "unfoldingWord",
  "path": "/history",
  "method": "GET"
}
```

**Assessment**: The history endpoint correctly returned an empty array for a user with no chat history. The `limit: 50` confirms the default maximum (from PR #24's `max_history_storage` default). This validates that user-scoped DOs start with empty history and the history endpoint is accessible via the new API path structure from PR #22.

---

### Test 12: Chat - Valid Request (PR #21/22/24)

**Returned Response**:

```json
{
  "responses": [
    "¡Bienvenido! Soy BT Servant, tu asistente para la traducción bíblica...",
    "Ahora busco Juan 3:16:",
    "Juan 3:16 es uno de los versículos más conocidos de la Biblia. Aquí tienes varias traducciones en inglés:\n\n**Juan 3:16**\n\n**ULT (Unlocked Literal Translation):**\n\"For God so loved the world, that he gave his One and Only Son...\"\n\n**UST (Unlocked Simplified Translation):**\n\"This is because God loved the world's people in this way...\"\n\n**T4T (Translation for Translators):**\n\"God loved us people in the world so much...\"\n\n**UEB (Unlocked English Bible):**\n\"For God so loved the world, that he gave his one and only Son...\""
  ],
  "response_language": "es",
  "voice_audio_base64": null
}
```

**Log Evidence**:

1. **DO Routing**: `"do_id":"dd4e57e608bbb73de56799688225722345f87f68bda77f80f7f71269da238e8b"` - User-specific DO ID
2. **Chat Start**: `"do_chat_start"` with `user_id: "test-user-manual"`
3. **History Load**: `"history_count": 0` - Started with empty history
4. **MCP Discovery**: Found 9 tools from `translation-helps` server in 312ms
5. **Claude Iterations**: 3 iterations with tool calls:
   - Iteration 0: Called `get_tool_definitions` to understand available MCP tools
   - Iteration 1: Called `execute_code` which ran `fetch_scripture({ reference: "John 3:16" })`
   - Iteration 2: Final response generation
6. **MCP Tool Call**: `fetch_scripture` completed in 3359ms
7. **History Save**: `"phase_save_complete"` with `"storageMax": 50`
8. **Total Duration**: 14978ms (about 15 seconds)
9. **Final Response**: Full response in Spanish with 3 segments

**Assessment**: This test validates multiple PRs working together:

- **PR #22**: User-scoped DO (unique `do_id` per user), MCP servers loaded from KV
- **PR #24**: History rolling uses `storageMax: 50` (default), response respects user's language preference ("es" from Test 9)
- **PR #21**: Code execution via QuickJS worked correctly (the `execute_code` tool ran JavaScript that called `fetch_scripture`)

The response being in Spanish confirms the user preference system is integrated with chat. The MCP tool usage confirms the KV-based MCP configuration is working.

---

### Test 13: User History - After Chat (PR #22/24)

**Returned Response**:

```json
{
  "user_id": "test-user-manual",
  "entries": [
    {
      "user_message": "What is John 3:16?",
      "assistant_response": "¡Bienvenido! Soy BT Servant... [full response]",
      "timestamp": 1770226888352,
      "created_at": "2026-02-04T17:41:28.352Z"
    }
  ],
  "total_count": 1,
  "limit": 50,
  "offset": 0
}
```

**Log Evidence**:

```json
{
  "event": "user_request_received",
  "request_id": "777161c6-afc1-4472-98d9-00158c666cd2",
  "timestamp": 1770226904620,
  "user_id": "test-user-manual",
  "org": "unfoldingWord",
  "path": "/history",
  "method": "GET"
}
```

**Assessment**: The chat history was correctly persisted to the user-scoped DO. The entry includes:

- Original user message ("What is John 3:16?")
- Full assistant response (concatenated from 3 segments)
- Timestamp matching the `do_chat_complete` event
- ISO 8601 `created_at` timestamp

This validates PR #22's user-scoped history (each user has their own history) and PR #24's history storage mechanism.

---

### Test 14: Request Serialization - 429 (PR #25)

**Returned Response** (second request):

```json
{
  "error": "Request in progress",
  "code": "CONCURRENT_REQUEST_REJECTED",
  "message": "Another request for this user is currently being processed. Please retry.",
  "retry_after_ms": 5000
}
```

HTTP Status: 429 with `Retry-After: 5` header

**Log Evidence**:

```json
{ "event": "CONCURRENT_REQUEST_REJECTED", "user_id": "unknown", "timestamp": 1770226929862 }
```

**Full Timeline from Logs**:

1. **First request starts**: `"do_chat_start"` at timestamp `1770226917514` for `test-user-429`
2. **First request processing**: Multiple MCP tool calls fetching Genesis chapters
3. **Second request arrives**: `"CONCURRENT_REQUEST_REJECTED"` at `1770226929862` (12 seconds later)
4. **First request continues**: More tool calls and eventually completes (though with some 503 errors from MCP server being overwhelmed)

**Assessment**: PR #25's request serialization worked exactly as designed:

1. First request acquired the lock on the user's DO
2. Second request attempted to acquire lock, failed, and received 429
3. The `CONCURRENT_REQUEST_REJECTED` event was logged as a warning
4. The 429 response included `retry_after_ms: 5000` and `Retry-After` header to guide client retry behavior

The lock prevented race conditions in conversation history that could occur if two requests modified history simultaneously.

---

### Test 15: Streaming Endpoint (PR #25)

**Returned Response** (SSE stream):

```
data: {"type":"status","message":"Processing your request..."}
data: {"type":"progress","text":"¡Hola! Welcome"}
data: {"type":"progress","text":" to BT Servant,"}
data: {"type":"progress","text":" your helpful assistant for Bible translation"}
... [more progress events]
data: {"type":"complete","response":{...}}
```

**Log Evidence**:

1. **Stream Start**: `"do_stream_start"` for `test-user-stream`
2. **History Load**: `"history_count": 0`
3. **MCP Discovery**: Found 9 tools in 647ms
4. **First Token**: `"stream_first_token"` with `"time_to_first_token_ms": 1956`
5. **Claude Response**: Single iteration, `stop_reason: "end_turn"`, 2850ms total
6. **History Save**: `"phase_save_complete"` with `"storageMax": 50`
7. **Stream Complete**: `"do_stream_complete"` in 3497ms total
8. **Final Response**: Full response text logged:

```json
{
  "responses": [
    "¡Hola! Welcome to BT Servant, your helpful assistant for Bible translation work. I'm here to help you with:\n\n- Looking up scripture passages and references\n- Checking translation notes and resources  \n- Answering questions about biblical languages (Hebrew, Greek, Aramaic)\n- Providing translation suggestions and alternatives\n- Explaining cultural and historical context\n\nI have access to a variety of Bible translation tools and resources from the Door43 catalog that I can use to assist you. How can I help you with your Bible translation work today?"
  ],
  "response_language": "en",
  "user_id": "test-user-stream"
}
```

**Assessment**: The streaming endpoint worked correctly:

- SSE events flowed properly with `status`, `progress`, and `complete` event types
- Time to first token was 1956ms (good latency)
- The lock was acquired at stream start and released after completion (as evidenced by `do_stream_complete`)
- History was saved correctly with `storageMax: 50`
- Total stream duration was 3497ms

---

## PR Verification Summary

| PR  | Feature               | Verification                                            |
| --- | --------------------- | ------------------------------------------------------- |
| #21 | QuickJS fixes         | Code execution in Test 12 worked correctly              |
| #22 | User scoping + MCP KV | User-specific DO IDs, MCP loaded from KV                |
| #23 | Migration removal     | Both endpoints return 404                               |
| #24 | Two-tier history      | `storageMax: 50`, `max_history_llm: 5` defaults working |
| #25 | Request serialization | 429 with `CONCURRENT_REQUEST_REJECTED` logged           |

All functionality from PRs #21-#25 verified working in production.
