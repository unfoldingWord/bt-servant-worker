# Client-Supplied Conversation History

Issue #392. Three optional fields on every chat transport (`/api/v1/chat`, `/api/v1/chat/stream`, `/api/v1/chat/callback`) let a client own its conversation instead of relying on the thread the worker stores per user:

| Field              | Type                   | Default | What it does                                                                        |
| ------------------ | ---------------------- | ------- | ----------------------------------------------------------------------------------- |
| `history`          | `ClientHistoryEntry[]` | absent  | Replaces the stored thread with this one before the turn runs. `[]` starts blank.   |
| `suppress_welcome` | `boolean`              | `false` | Skips the first-contact welcome (authored mode copy, share link, model self-greet). |
| `suppress_memory`  | `boolean`              | `false` | Turns persistent memory off for the turn: no prompt slot, no TOC, no memory tools.  |

The fields are independent. Any combination is valid. All three are additive: a request that omits them behaves exactly as before, so existing gateways are unaffected.

Motivation: Fluent caches passage-overview conversations on its own side, including pre-canned turns it authored, and hands them back when a user resumes. That gives every new conversation a blank start by default, keeps conversation storage under the client's privacy policy, and lets the client change overview content without new worker features.

## Request fields

```typescript
interface ChatRequest {
  // ...existing fields...

  /**
   * Replace the stored conversation with this thread before processing the
   * message. Omit to continue the stored thread (default). `[]` starts blank.
   * Private chats only; rejected with 400 on group/supergroup.
   */
  history?: ClientHistoryEntry[];

  /**
   * Skip the first-contact welcome for this turn: the mode's authored
   * welcome_message + share link, AND the model's own "briefly welcome them"
   * instruction. Writes no welcome flags. Default false.
   */
  suppress_welcome?: boolean;

  /**
   * Turn persistent memory off for this turn: the memory instructions slot,
   * the memory TOC, and the read_memory/update_memory tools are all omitted.
   * Nothing is read from or written to the user's memory. Default false.
   */
  suppress_memory?: boolean;
}

interface ClientHistoryEntry {
  user_message: string; // required, non-empty after trim, ≤ 16,000 chars
  assistant_response: string; // required, non-empty after trim, ≤ 16,000 chars
  timestamp?: number; // ms since epoch; optional
  created_at?: string; // ISO 8601; optional, used when timestamp is absent
  // any other keys (voice_audio_key, inbound_voice_audio_key, speaker,
  // attachments, voice_audio_url, ...) are silently dropped
}
```

Pre-canned turns: a client that wants to present its own generated page as prior assistant output writes the page as `assistant_response` and authors the `user_message` that would have produced it (for example "Give me an overview of Mark 1."). That is how the model would have generated the text, so later turns stay consistent. A turn cannot have an empty user side.

## Response fields

Present only when the request supplied `history`, so gateway payloads are byte-identical.

```typescript
interface ChatResponse {
  // ...existing fields...
  history_entry?: { user_message: string; assistant_response: string; timestamp: number };
  history_length?: number; // stored thread length after this turn's append
}
```

`history_entry` is the turn the worker just appended. A client that owns its thread appends it to its local copy and sends the whole thread next time. `history_length` lets the client detect server-side trimming (below).

On `/api/v1/chat/stream` the fields ride inside the `complete` event's `response`. On `/api/v1/chat/callback` they ride on the final `type: "complete"` webhook payload (see `ProgressCallback` in `src/types/engine.ts`). That webhook is sent whenever a receipt exists, even in progress modes where the text already streamed and the complete would otherwise carry no delta.

## Semantics

| Situation                                                  | Behavior                                                                                                                                                                                                               |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `history` absent (or `null`)                               | Stored thread used as today. No new response fields.                                                                                                                                                                   |
| `history: []`                                              | Stored thread cleared, turn runs with no prior context, turn is saved as entry 1. `history_length: 1`.                                                                                                                 |
| `history: [n turns]`                                       | Stored thread replaced by the n turns (sanitized), then the turn appends. `history_length: min(n, cap) + 1`, where cap is the org's `max_history_storage` (default 50).                                                |
| n > `max_history_storage`                                  | Oldest entries dropped so the last `cap` remain, then the append drops one more. `history_length` reports the truth. Logged as `history_replaced` with `supplied`, `stored`, `trimmed`.                                |
| Entry missing/empty `user_message` or `assistant_response` | 400 `history[i].user_message is required and must be non-empty` (index named).                                                                                                                                         |
| Field over 16,000 chars                                    | 400 `history[i].assistant_response exceeds 16000 characters`.                                                                                                                                                          |
| Serialized `history` over 512 KiB                          | 400 `history exceeds 524288 bytes`. Checked before per-entry rules.                                                                                                                                                    |
| Queued transports: several near-cap bodies for one user    | The callback/SSE queue is persisted as one storage value. A request that would push the serialized queue past 1.5 MiB gets 429 `QUEUE_BYTES_EXCEEDED` with `Retry-After: 5`, like depth. Retry after the queue drains. |
| `history` not an array / entry not an object               | 400 `history must be an array of { user_message, assistant_response } entries` / `history[i] must be an object`.                                                                                                       |
| `timestamp` / `created_at` present but malformed           | 400 `history[i].timestamp must be a number (milliseconds since epoch)` / `history[i].created_at must be an ISO 8601 date string`.                                                                                      |
| `chat_type` is `group` or `supergroup` with `history`      | 400 `history is not supported on group/supergroup chats`.                                                                                                                                                              |
| `suppress_welcome` / `suppress_memory` not a boolean       | 400 `suppress_welcome must be a boolean` / `suppress_memory must be a boolean`. `null` is treated as absent.                                                                                                           |
| `suppress_welcome: true`                                   | Authored welcome not emitted, no `mode_welcomed:*` or `mode_welcome_pending:*` write, system prompt omits the first-interaction line. The normal end-of-turn `first_interaction` flip still happens.                   |
| `suppress_memory: true`                                    | Memory store not loaded, system prompt omits the `memory_instructions` slot and TOC, tool list omits `read_memory` and `update_memory`. Existing memory untouched. Logged as `memory_suppressed_by_client`.            |
| Turn fails after replacement                               | The stored thread is already the supplied one (replacement is not rolled back). Resend on retry; replacement is idempotent.                                                                                            |
| Timestamps                                                 | `timestamp` wins, else parsed `created_at`, else request time. Nothing sorts by them; order is array order.                                                                                                            |

The message text stays subject to the existing `#mode` / `@language` trigger parsing. Supplied history does not.

### What the flags do not touch

- **The slot is `user_id`.** The worker keeps one thread per org and user. There is no separate conversation id; whatever `history` carries becomes the contents of that slot. A client with several conversations per person swaps the right one in on each request. Do not mint composite user ids per conversation: memory, preferences and welcome flags live in the same slot and would fragment.
- **Preferences** (response language, active mode) stay server-side per user.
- **Concurrency** is per user: the worker processes one turn at a time for a given `user_id`, so two threads for the same person answer serially, never concurrently.
- **Welcome flags on other channels.** Because `suppress_welcome` writes nothing, the same person arriving later through WhatsApp or Telegram still gets the mode's welcome there.

## Examples

`$BASE` is the worker origin, `$API_KEY` the `ENGINE_API_KEY` bearer token.

### Start a fresh conversation with a pre-canned opening page, no welcome, no memory

```bash
curl -s "$BASE/api/v1/chat" \
  -H "Authorization: Bearer $API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{
    "client_id": "fluent",
    "user_id": "user-42",
    "org": "unfoldingword",
    "message_type": "text",
    "suppress_welcome": true,
    "suppress_memory": true,
    "history": [
      {
        "user_message": "Give me an overview of Mark 1.",
        "assistant_response": "## Mark 1 — Overview\nMark opens abruptly with John the Baptist..."
      }
    ],
    "message": "What does \"immediately\" signal in verse 12?"
  }'
```

Response:

```json
{
  "message_id": "…",
  "responses": ["In Mark, \"immediately\" (Greek euthys) ..."],
  "response_language": "en",
  "input_language": "en",
  "voice_audio_base64": null,
  "voice_audio_url": null,
  "history_entry": {
    "user_message": "What does \"immediately\" signal in verse 12?",
    "assistant_response": "In Mark, \"immediately\" (Greek euthys) ...",
    "timestamp": 1757800000000
  },
  "history_length": 2
}
```

### Resume a cached thread

The client appended the previous `history_entry` to its copy and sends the whole thread:

```bash
curl -s "$BASE/api/v1/chat" \
  -H "Authorization: Bearer $API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{
    "client_id": "fluent",
    "user_id": "user-42",
    "org": "unfoldingword",
    "message_type": "text",
    "suppress_welcome": true,
    "suppress_memory": true,
    "history": [
      { "user_message": "Give me an overview of Mark 1.", "assistant_response": "## Mark 1 — Overview..." },
      { "user_message": "What does \"immediately\" signal in verse 12?", "assistant_response": "In Mark, ...", "timestamp": 1757800000000 }
    ],
    "message": "And in verse 18?"
  }'
```

### Start blank

```bash
curl -s "$BASE/api/v1/chat" \
  -H "Authorization: Bearer $API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{
    "client_id": "fluent",
    "user_id": "user-42",
    "org": "unfoldingword",
    "message_type": "text",
    "suppress_welcome": true,
    "suppress_memory": true,
    "history": [],
    "message": "Hello"
  }'
```

### Memory off, but continuing the server-stored thread

The flags are independent; this one keeps the stored thread and only turns memory off:

```bash
curl -s "$BASE/api/v1/chat" \
  -H "Authorization: Bearer $API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{
    "client_id": "fluent",
    "user_id": "user-42",
    "org": "unfoldingword",
    "message_type": "text",
    "suppress_memory": true,
    "message": "Remind me what we covered"
  }'
```

### Round-trip from the read endpoint

`GET /api/v1/orgs/:org/users/:userId/history` returns entries with extra derived fields (`created_at`, `voice_audio_url`, ...). They can be posted back unchanged; the extra fields are dropped:

```bash
HIST=$(curl -s "$BASE/api/v1/orgs/unfoldingword/users/user-42/history" \
  -H "Authorization: Bearer $API_KEY" | jq '.entries')

curl -s "$BASE/api/v1/chat" \
  -H "Authorization: Bearer $API_KEY" \
  -H 'Content-Type: application/json' \
  -d "$(jq -n --argjson h "$HIST" '{
    client_id: "fluent", user_id: "user-42", org: "unfoldingword",
    message_type: "text", history: $h, message: "continue"
  }')"
```

### Streaming transport

Same fields; the receipt arrives in the `complete` event:

```bash
curl -N -s "$BASE/api/v1/chat/stream" \
  -H "Authorization: Bearer $API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{
    "client_id": "fluent",
    "user_id": "user-42",
    "org": "unfoldingword",
    "message_type": "text",
    "suppress_welcome": true,
    "history": [],
    "message": "Hello"
  }'
# ...
# data: {"type":"complete","response":{"responses":["..."],"history_entry":{...},"history_length":1, ...}}
```

### Rejected requests

```bash
# 400 {"error":"history is not supported on group/supergroup chats"}
curl -s "$BASE/api/v1/chat" -H "Authorization: Bearer $API_KEY" -H 'Content-Type: application/json' \
  -d '{"client_id":"tg","user_id":"u","message_type":"text","chat_type":"group","chat_id":"g1","history":[],"message":"hi"}'

# 400 {"error":"history[0].assistant_response is required and must be non-empty"}
curl -s "$BASE/api/v1/chat" -H "Authorization: Bearer $API_KEY" -H 'Content-Type: application/json' \
  -d '{"client_id":"fluent","user_id":"u","message_type":"text","history":[{"user_message":"x","assistant_response":""}],"message":"hi"}'

# 400 {"error":"suppress_welcome must be a boolean"}
curl -s "$BASE/api/v1/chat" -H "Authorization: Bearer $API_KEY" -H 'Content-Type: application/json' \
  -d '{"client_id":"fluent","user_id":"u","message_type":"text","suppress_welcome":"yes","message":"hi"}'

# 400 {"error":"suppress_memory must be a boolean"}
curl -s "$BASE/api/v1/chat" -H "Authorization: Bearer $API_KEY" -H 'Content-Type: application/json' \
  -d '{"client_id":"fluent","user_id":"u","message_type":"text","suppress_memory":1,"message":"hi"}'
```

## Observability

Every turn's `chat_turn` log record carries `supplied_history_count` (number of uploaded turns, or `null` when the field was absent), `welcome_suppressed` and `memory_suppressed`. A replacement also logs `history_replaced` with `supplied`, `stored` and `trimmed` counts; the flags log `welcome_suppressed_by_client` and `memory_suppressed_by_client`. Rejected bodies log `chat_validation_failed_in_do` with the exact error.

## Implementation map

| Concern                   | Where                                                                                                                                                       |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Types                     | `src/types/engine.ts` (`ChatRequest`, `ChatResponse`, `ClientHistoryEntry`)                                                                                 |
| Validation + sanitization | `src/utils/history-validation.ts`; wired through `validateChatBody` in `src/utils/chat-validation.ts`                                                       |
| Replacement               | `UserDO.loadOrReplaceHistory` in `src/durable-objects/user-do.ts`                                                                                           |
| Welcome suppression       | `UserDO.resolveTurnWelcome` (gate) and `neutralizeModelWelcome` (model self-greet)                                                                          |
| Memory suppression        | `UserDO.suppressedMemoryContext`; orchestrator keys the prompt slot, TOC and tools off `memoryStore`                                                        |
| Receipt fields            | `historyReceiptFields` / `clientHistoryReceipt` in `src/durable-objects/user-do.ts`                                                                         |
| Tests                     | `tests/unit/history-validation.test.ts`, `tests/e2e/client-supplied-history.test.ts`, plus cases in the chat-validation, tools and system-prompt unit files |
