# V1 General Test Plan

Manual test plan covering functionality from PRs #21-#25.

## Environment

- **Base URL**: `https://api.btservant.ai`
- **Auth Header**: `Authorization: Bearer $ENGINE_API_KEY`
- **Monitoring**: `wrangler tail --format=pretty`

## PRs Covered

| PR  | Title                            | Tests      |
| --- | -------------------------------- | ---------- |
| #25 | Request serialization via 429    | 14, 15     |
| #24 | Two-tier history rolling         | 2-5, 12-13 |
| #23 | Remove migration endpoints       | 7          |
| #22 | User history scoping + MCP to KV | 6, 8-11    |
| #21 | QuickJS executor fixes           | 12         |

---

## Test 1: Health & Domain Verification

**Purpose**: Verify new domain mapping works and service is healthy.

**Curl**:

```bash
curl -s https://api.btservant.ai/health | jq
```

**Expected Response** (200):

```json
{
  "status": "healthy",
  "version": "0.2.0"
}
```

**Pass Criteria**: Status 200, version present.

---

## Test 2: Org Config - Get Defaults (PR #24)

**Purpose**: Verify default org config values.

**Curl**:

```bash
curl -s https://api.btservant.ai/api/v1/admin/orgs/unfoldingWord/config \
  -H "Authorization: Bearer $ENGINE_API_KEY" | jq
```

**Expected Response** (200):

```json
{
  "org": "unfoldingWord",
  "config": {
    "max_history_storage": 50,
    "max_history_llm": 5
  }
}
```

**Pass Criteria**: Defaults returned (storage: 50, llm: 5).

---

## Test 3: Org Config - Valid Update (PR #24)

**Purpose**: Verify org config can be updated.

**Curl**:

```bash
curl -s -X PUT https://api.btservant.ai/api/v1/admin/orgs/unfoldingWord/config \
  -H "Authorization: Bearer $ENGINE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"max_history_storage": 75, "max_history_llm": 10}' | jq
```

**Expected Response** (200):

```json
{
  "org": "unfoldingWord",
  "config": {
    "max_history_storage": 75,
    "max_history_llm": 10
  },
  "message": "Org config updated"
}
```

**Pass Criteria**: Config updated to new values.

---

## Test 4: Org Config - Invalid Update (PR #24)

**Purpose**: Verify validation rejects llm > storage.

**Curl**:

```bash
curl -s -X PUT https://api.btservant.ai/api/v1/admin/orgs/unfoldingWord/config \
  -H "Authorization: Bearer $ENGINE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"max_history_storage": 5, "max_history_llm": 10}' | jq
```

**Expected Response** (400):

```json
{
  "error": "max_history_llm cannot exceed max_history_storage"
}
```

**Pass Criteria**: 400 status with validation error.

---

## Test 5: Org Config - Reset (PR #24)

**Purpose**: Verify org config resets to defaults.

**Curl**:

```bash
curl -s -X DELETE https://api.btservant.ai/api/v1/admin/orgs/unfoldingWord/config \
  -H "Authorization: Bearer $ENGINE_API_KEY" | jq
```

**Expected Response** (200):

```json
{
  "org": "unfoldingWord",
  "config": {
    "max_history_storage": 50,
    "max_history_llm": 5
  },
  "message": "Org config reset to defaults"
}
```

**Pass Criteria**: Config reset to defaults.

---

## Test 6: MCP Servers - List (PR #22)

**Purpose**: Verify MCP servers can be listed from KV.

**Curl**:

```bash
curl -s https://api.btservant.ai/api/v1/admin/orgs/unfoldingWord/mcp-servers \
  -H "Authorization: Bearer $ENGINE_API_KEY" | jq
```

**Expected Response** (200):

```json
{
  "org": "unfoldingWord",
  "servers": [...]
}
```

**Pass Criteria**: Returns org and servers array.

---

## Test 7: Migration Endpoints Removed (PR #23)

**Purpose**: Verify old migration endpoints return 404.

**Curl (migrate endpoint)**:

```bash
curl -s -w "\nHTTP Status: %{http_code}\n" -X POST \
  https://api.btservant.ai/api/v1/admin/orgs/unfoldingWord/migrate-mcp-to-kv \
  -H "Authorization: Bearer $ENGINE_API_KEY"
```

**Curl (cleanup endpoint)**:

```bash
curl -s -w "\nHTTP Status: %{http_code}\n" -X POST \
  https://api.btservant.ai/api/v1/admin/orgs/unfoldingWord/cleanup-org-do \
  -H "Authorization: Bearer $ENGINE_API_KEY"
```

**Expected**: HTTP Status 404 for both.

**Pass Criteria**: Both return 404 (endpoints removed).

---

## Test 8: User Preferences - Get Default (PR #22)

**Purpose**: Verify user preferences endpoint works with new user-scoped paths.

**Curl**:

```bash
curl -s https://api.btservant.ai/api/v1/orgs/unfoldingWord/users/test-user-manual/preferences \
  -H "Authorization: Bearer $ENGINE_API_KEY" | jq
```

**Expected Response** (200):

```json
{
  "response_language": "en"
}
```

**Pass Criteria**: Returns default language preference.

---

## Test 9: User Preferences - Valid Update (PR #22)

**Purpose**: Verify language preference can be updated.

**Curl**:

```bash
curl -s -X PUT https://api.btservant.ai/api/v1/orgs/unfoldingWord/users/test-user-manual/preferences \
  -H "Authorization: Bearer $ENGINE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"response_language": "es"}' | jq
```

**Expected Response** (200):

```json
{
  "response_language": "es"
}
```

**Pass Criteria**: Language updated to "es".

---

## Test 10: User Preferences - Invalid Update (PR #22)

**Purpose**: Verify validation rejects invalid language codes.

**Curl**:

```bash
curl -s -w "\nHTTP Status: %{http_code}\n" -X PUT \
  https://api.btservant.ai/api/v1/orgs/unfoldingWord/users/test-user-manual/preferences \
  -H "Authorization: Bearer $ENGINE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"response_language": "EN"}'
```

**Expected Response** (400):

```json
{
  "error": "Invalid response_language",
  "message": "Must be a valid ISO 639-1 language code (2 lowercase letters, e.g., \"en\", \"es\", \"fr\")"
}
```

**Pass Criteria**: 400 status with validation error.

---

## Test 11: User History - Empty (PR #22)

**Purpose**: Verify history endpoint works for new user.

**Curl**:

```bash
curl -s https://api.btservant.ai/api/v1/orgs/unfoldingWord/users/test-user-manual/history \
  -H "Authorization: Bearer $ENGINE_API_KEY" | jq
```

**Expected Response** (200):

```json
{
  "user_id": "test-user-manual",
  "entries": [],
  "total_count": 0,
  "limit": 50,
  "offset": 0
}
```

**Pass Criteria**: Empty entries array for new user.

---

## Test 12: Chat - Valid Request (PR #21/22/24)

**Purpose**: Verify chat works end-to-end with user-scoped history.

**Curl**:

```bash
curl -s -X POST https://api.btservant.ai/api/v1/chat \
  -H "Authorization: Bearer $ENGINE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "client_id": "manual-test",
    "user_id": "test-user-manual",
    "message": "What is John 3:16?",
    "message_type": "text",
    "org": "unfoldingWord"
  }' | jq
```

**Expected Response** (200):

```json
{
  "responses": ["..."],
  "response_language": "es",
  "voice_audio_base64": null
}
```

**Pass Criteria**:

- Response contains meaningful content
- `response_language` matches user preference ("es" from Test 9)
- Logs show history being saved

---

## Test 13: User History - After Chat (PR #22/24)

**Purpose**: Verify chat history was saved correctly.

**Curl**:

```bash
curl -s https://api.btservant.ai/api/v1/orgs/unfoldingWord/users/test-user-manual/history \
  -H "Authorization: Bearer $ENGINE_API_KEY" | jq
```

**Expected Response** (200):

```json
{
  "user_id": "test-user-manual",
  "entries": [
    {
      "user_message": "What is John 3:16?",
      "assistant_response": "...",
      "timestamp": 1234567890,
      "created_at": "2026-02-04T..."
    }
  ],
  "total_count": 1,
  "limit": 50,
  "offset": 0
}
```

**Pass Criteria**: Entry from Test 12 appears in history.

---

## Test 14: Request Serialization - 429 (PR #25)

**Purpose**: Verify concurrent requests return 429.

**Script** (save as `test_429.sh`):

```bash
#!/bin/bash
# Test concurrent request serialization

API_URL="https://api.btservant.ai/api/v1/chat"
AUTH="Authorization: Bearer $ENGINE_API_KEY"

echo "=== Starting first request (background) ==="
curl -s -X POST "$API_URL" \
  -H "$AUTH" \
  -H "Content-Type: application/json" \
  -d '{
    "client_id": "test-429",
    "user_id": "test-user-429",
    "message": "Explain the entire book of Genesis in detail",
    "message_type": "text",
    "org": "unfoldingWord"
  }' > /tmp/first_response.json &
FIRST_PID=$!

echo "=== Waiting 1 second, then sending concurrent request ==="
sleep 1

echo "=== Sending second request (should get 429) ==="
curl -s -w "\nHTTP Status: %{http_code}\n" -X POST "$API_URL" \
  -H "$AUTH" \
  -H "Content-Type: application/json" \
  -d '{
    "client_id": "test-429",
    "user_id": "test-user-429",
    "message": "Hello",
    "message_type": "text",
    "org": "unfoldingWord"
  }'

echo ""
echo "=== Waiting for first request to complete ==="
wait $FIRST_PID

echo "=== First request response ==="
cat /tmp/first_response.json | jq
```

**Expected Second Request Response** (429):

```json
{
  "error": "Request in progress",
  "code": "CONCURRENT_REQUEST_REJECTED",
  "message": "Another request for this user is currently being processed. Please retry.",
  "retry_after_ms": 5000
}
```

**Pass Criteria**:

- Second request gets 429 status
- Response includes `retry_after_ms`
- `Retry-After` header present
- Logs show `CONCURRENT_REQUEST_REJECTED` event
- First request completes successfully

---

## Test 15: Streaming Endpoint (PR #25)

**Purpose**: Verify streaming chat works with lock.

**Curl**:

```bash
curl -s -N -X POST https://api.btservant.ai/api/v1/chat/stream \
  -H "Authorization: Bearer $ENGINE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "client_id": "manual-test",
    "user_id": "test-user-stream",
    "message": "Say hello in Spanish",
    "message_type": "text",
    "org": "unfoldingWord"
  }'
```

**Expected Response**: Server-Sent Events stream:

```
data: {"type":"status","message":"Processing..."}

data: {"type":"progress","text":"Hola"}

data: {"type":"complete","response":{...}}
```

**Pass Criteria**:

- SSE events stream correctly
- Final `complete` event contains response
- Lock is acquired and released (check logs)

---

## Cleanup

After testing, reset test user state:

```bash
# Reset preferences back to English
curl -s -X PUT https://api.btservant.ai/api/v1/orgs/unfoldingWord/users/test-user-manual/preferences \
  -H "Authorization: Bearer $ENGINE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"response_language": "en"}' | jq
```

---

## Summary Checklist

| Test                   | PR        | Status |
| ---------------------- | --------- | ------ |
| 1. Health              | -         |        |
| 2. Org Config Get      | #24       |        |
| 3. Org Config Update   | #24       |        |
| 4. Org Config Invalid  | #24       |        |
| 5. Org Config Reset    | #24       |        |
| 6. MCP Servers List    | #22       |        |
| 7. Migration 404       | #23       |        |
| 8. User Prefs Get      | #22       |        |
| 9. User Prefs Update   | #22       |        |
| 10. User Prefs Invalid | #22       |        |
| 11. User History Empty | #22       |        |
| 12. Chat Valid         | #21/22/24 |        |
| 13. User History After | #22/24    |        |
| 14. 429 Concurrent     | #25       |        |
| 15. Streaming          | #25       |        |
