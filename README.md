# bt-servant-worker

[![CI](https://github.com/unfoldingWord/bt-servant-worker/actions/workflows/ci.yml/badge.svg)](https://github.com/unfoldingWord/bt-servant-worker/actions/workflows/ci.yml)

> AI-powered assistance for Bible translators, at the edge.

A Cloudflare Worker (built with [Hono](https://hono.dev/)) that provides AI-powered assistance to Bible translators via Claude, with sandboxed code execution, dynamic MCP tool orchestration, and per-conversation persistent memory. It is the hub of the bt-servant ecosystem — gateways (Telegram, WhatsApp, Signal), the web client, the admin portal, and baruch all consume its API.

## What This Project Does

bt-servant-worker is deployed on Cloudflare's edge network and provides:

- **Claude-powered chat** with multi-turn orchestration (configurable tool-use loop, 100 iterations by default)
- **Dynamic MCP tool discovery** — discovers and calls MCP tools from configured servers, with a per-server-grouped catalog for source-ordered fallback
- **Sandboxed code execution** via QuickJS compiled to WebAssembly
- **Audio message support** — speech-to-text (STT) via Whisper (Workers AI) and text-to-speech (TTS) via OpenAI gpt-4o-mini-tts, with audio stored in R2
- **Spoken mode** — inbound voice archival, ambient (not-addressed-to-bot) turns, and tools to replay archived audio
- **Group & supergroup chat** — Telegram group/supergroup support with per-group DOs, thread-level isolation, speaker attribution, and shared group memory
- **Per-conversation state** — chat history, preferences, prompt overrides, and persistent memory via Durable Objects (SQLite-backed)
- **Request serialization** — one request at a time per conversation (user, group, or thread), preventing race conditions
- **Streaming support** — real-time SSE streaming and webhook progress callbacks
- **Callback mode** — fire-and-forget with webhook progress callbacks for clients that can't hold long connections
- **Dynamic prompt overrides** — org and user-level customization of Claude's system prompt
- **Modes** — named prompt presets (e.g., "mast-methodology") with publish gating, group-only gating, aliases, and safe rename/clone/retire lifecycle
- **Languages** — per-org language documents plus a `@<language>` trigger and per-request `response_language_hint`
- **Trigger syntax** — messages may start with `#<mode>` and/or `@<language>`; a deterministic classifier with LLM-backed fuzzy disambiguation resolves them, and selections persist across turns
- **Persistent memory** — schema-free sectioned memory per conversation, with pinning and auto-eviction
- **Scripture PDF typesetting** — `generate_scripture_pdf` macro tool delegating to a ptxprint MCP service, with PDFs mirrored to R2 and returned as response attachments
- **Tail-worker observability** — a separate tail worker captures failures the main worker cannot log (CPU exhaustion, uncaught exceptions, isolate eviction), and logs fan out to the bt-servant-telemetry workers

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│  Cloudflare Worker                                              │
│                                                                 │
│  POST /api/v1/chat[/stream|/callback]                           │
│       │        ──► KV (org config, MCP servers, prompts/modes,  │
│       ▼             languages, admin keys)                      │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │ UserDO — Unified Durable Object (per-conversation)      │    │
│  │ - Routing: user:{org}:{uid} | group:{org}:{cid}[:tid]  │    │
│  │ - Chat history, preferences, prompt overrides, memory   │    │
│  │ - Internal FIFO queue with alarm-based processing       │    │
│  │ - Request serialization (one at a time per DO)          │    │
│  └──────────────┬──────────────────────────────────────────┘    │
│                 │                                               │
│    ┌────────────┴────────────────────────────┐                  │
│    ▼                                         ▼                  │
│  Workers AI (STT)                Claude Orchestrator            │
│  └─ Whisper (transcribe)         ├─ System prompt + tool catalog│
│                                  └─ Configurable iterations     │
│  OpenAI TTS (gpt-4o-mini-tts)          │                       │
│  └─ Audio stored in R2   ┌──────┬──────┴──┬──────────┐        │
│                           ▼      ▼         ▼          ▼        │
│                     execute_  get_tool_ read/update generate_  │
│                     code      definitions  memory  scripture_pdf│
└─────────────────────────────────────────────────────────────────┘
```

Full C4 ecosystem diagrams (system context + container) live in [docs/architecture/](docs/architecture/).

### Key Components

**QuickJS Sandbox** — Replaces Node.js `isolated-vm` with QuickJS compiled to WebAssembly. Code runs in a completely isolated sandbox with no access to `fetch`, environment variables, or Worker APIs. Only explicitly injected MCP tool wrappers are available.

**Durable Objects** — A single unified `UserDO` class (SQLite-backed) that handles chat processing, history, preferences, memory, prompt overrides, and an internal FIFO queue with alarm-based processing. The same DO class is used for private chats, group chats, and supergroup threads — polymorphic routing keys determine which DO instance handles each conversation. This flat architecture eliminates DO-to-DO chains that previously caused Cloudflare error 1003.

**MCP Catalog & Health Tracking** — Tool manifests from all configured MCP servers are merged into a single catalog, grouped by server in the system prompt so Claude can honor source-ordered fallback between overlapping servers. Health tracking blocks unhealthy servers; per-execution and per-request MCP call caps prevent runaway fan-out.

**Persistent Memory** — Schema-free sectioned memory per conversation (user, group, or thread). A deterministic TOC is injected into the system prompt; Claude reads/writes specific sections via tools. Sections can be pinned; when the 128KB cap is exceeded, the oldest non-pinned sections are auto-evicted so writes never fail.

**Dynamic Prompt Overrides** — 7 customizable prompt slots with 4-tier resolution: user → mode → org → default. Each slot is capped at 8,000 characters. Ulysses-style comments (`%% ... %%`) are stripped before system prompt assembly.

| Slot                  | Purpose                                                       |
| --------------------- | ------------------------------------------------------------- |
| `identity`            | Who BT Servant is                                             |
| `methodology`         | Teaching framework                                            |
| `tool_guidance`       | How to use MCP tools                                          |
| `instructions`        | General behavioral instructions                               |
| `client_instructions` | Platform-specific response style (e.g., WhatsApp conciseness) |
| `memory_instructions` | How to use persistent memory                                  |
| `closing`             | Closing behavioral rules                                      |

Prompt override text supports `{{version}}` as a template variable, replaced at runtime with the current worker version.

**Modes** — Named prompt presets stored per org (max 20). A mode may store its slot values either as a legacy `overrides` map or as a single markdown `document` with one H2 section per slot; both shapes are accepted and resolved identically at chat time. Mode fields:

| Field            | Purpose                                                                |
| ---------------- | ---------------------------------------------------------------------- |
| `name`           | Unique slug (lowercase alphanumeric + hyphens)                         |
| `aliases`        | Old slugs kept from renames/retires so subscribers are never stranded  |
| `label`          | Human-readable display name                                            |
| `description`    | What the mode does                                                     |
| `published`      | Visibility gate — unpublished (draft) modes are visible to admins only |
| `requires_group` | Gate group-only modes by chat type (hidden/blocked in private chats)   |
| `overrides`      | Legacy slot map                                                        |
| `document`       | Markdown document (H2 per slot)                                        |

Lifecycle operations (`_rename`, `_clone`, `_retire`) manage modes without breaking users who have one selected — renames keep the old slug as an alias, retires forward the retired slug to a target mode. Users switch modes via the `switch_mode` tool, the `#<mode>` message trigger, or admin endpoints (per-user and per-group).

**Languages** — Per-org language documents (max 20) with a shared language scaffold template. Users select a response language via the `@<language>` message trigger (persists across turns) or per-request `response_language_hint`.

**Trigger Classifier** — Messages may begin with `#<mode>` and/or `@<language>` tokens. A deterministic cascade matches exact slugs first; fuzzy input falls back to a Haiku-powered LLM classifier for disambiguation.

**Audio Pipeline** — When a user sends an audio message (`message_type: 'audio'`), the worker archives the inbound voice recording to R2 (`voice-submissions/…`), transcribes it using Whisper (`@cf/openai/whisper-large-v3-turbo` via Workers AI), processes the transcribed text through the normal Claude orchestration, then generates a spoken response using OpenAI's `gpt-4o-mini-tts` (with exponential-backoff retry on 429/5xx). TTS audio is stored in R2 and served via `/api/v1/audio/*`. TTS failure is non-fatal — the text response is always returned. `audio_format` accepts both bare extensions (`ogg`) and MIME forms (`audio/ogg`).

| Constraint              | Value                                |
| ----------------------- | ------------------------------------ |
| Max audio input size    | 25 MB                                |
| Supported audio formats | ogg, mp3, wav, webm, flac, m4a       |
| Max TTS input           | 10,000 characters (truncated beyond) |
| TTS output format       | OGG/Opus                             |
| TTS model               | gpt-4o-mini-tts                      |
| TTS voice               | ash                                  |

**Spoken Mode / Ambient Group Voice** — Group messages may carry `addressed_to_bot: false` (e.g., ambient voice in a group where the bot listens but wasn't mentioned). Ambient turns are archived and attributed but short-circuit full orchestration. Claude can later retrieve and replay archived recordings via the `read_r2_object` and `attach_audio` tools. See [docs/spoken-mode-document.md](docs/spoken-mode-document.md).

**Scripture PDF Typesetting (ptxprint)** — The `generate_scripture_pdf` macro tool resolves a (translation, book) pair to a USFM source, submits a typesetting job to a ptxprint MCP service, polls for completion, mirrors the resulting PDF to R2, and returns it as a `pdf` attachment on the chat response. USFM sources, PDFs, and fonts are served publicly (no auth) from `/public/ptxprint/*`.

**Tail Worker** — A separate worker (`tail-worker/`, deployed as `bt-servant-tail`) consumes trace events from the main worker and emits structured `worker_death` and `long_invocation` events for failures the main worker cannot observe itself: CPU exhaustion, uncaught exceptions, and isolate eviction. Logs also fan out to the `bt-servant-telemetry` workers. The main worker's CPU limit is raised to 300,000 ms (5 min) to accommodate long ptxprint flows.

### Claude Built-in Tools

| Tool                     | Purpose                                                         |
| ------------------------ | --------------------------------------------------------------- |
| `execute_code`           | Run JavaScript in QuickJS sandbox with MCP tool access          |
| `get_tool_definitions`   | Get full JSON schemas for MCP tools before using them           |
| `read_memory`            | Read sections from the conversation's persistent memory         |
| `update_memory`          | Create/update/delete memory sections (with pin/unpin)           |
| `request_audio`          | Request that the response be delivered as TTS audio             |
| `generate_scripture_pdf` | Typeset a scripture book as a PDF via ptxprint                  |
| `prepare_usfm_source`    | Resolve (translation, book) to a USFM source for typesetting    |
| `read_r2_object`         | Retrieve an archived voice submission (org-scoped)              |
| `attach_audio`           | Attach an archived audio recording to the response (org-scoped) |
| `list_modes`             | List available prompt modes for the current org¹                |
| `switch_mode`            | Switch (or clear) the conversation's active prompt mode¹        |

¹ Only exposed when the org has modes configured. Unpublished and `requires_group` modes are filtered by caller context; admin clients see drafts.

## Authentication

All `/api/*` routes require a Bearer token in the `Authorization` header.

- **`ENGINE_API_KEY`** — super-admin token, grants access to all orgs and all endpoints
- **Org admin keys** — stored in the `ORG_ADMIN_KEYS` KV namespace, keyed by org name; grants admin access to that org only
- **Webhook callbacks** — authenticated via `X-Engine-Token` header containing the `ENGINE_API_KEY`

```
Authorization: Bearer <ENGINE_API_KEY or org-specific admin key>
```

`/health` and `/public/ptxprint/*` are unauthenticated.

## API Endpoints

### Chat

| Endpoint                | Method | Description                                                                                                                                                                                                                                                                                                                      |
| ----------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/health`               | GET    | Health check (returns `{ status, version }`)                                                                                                                                                                                                                                                                                     |
| `/api/v1/chat`          | POST   | **Synchronous final-only JSON response.** Blocks until the orchestrator finishes, then returns one `ChatResponse` body. Rejects `progress_callback_url`, `progress_mode`, `progress_throttle_seconds`, and `message_key` with a 400. Returns `429 CONCURRENT_REQUEST_REJECTED` with `Retry-After: 5` when the user's DO is busy. |
| `/api/v1/chat/stream`   | POST   | SSE streaming. Rejects `progress_callback_url`, `progress_mode`, `progress_throttle_seconds`, and `message_key` with a 400.                                                                                                                                                                                                      |
| `/api/v1/chat/callback` | POST   | 202 Accepted + webhook delivery. Requires `progress_callback_url` and `message_key` in the body (400 if either is missing).                                                                                                                                                                                                      |

### Audio & Artifacts

| Endpoint                      | Method | Description                                           |
| ----------------------------- | ------ | ----------------------------------------------------- |
| `/api/v1/audio/*`             | GET    | Serve TTS audio files from R2                         |
| `/api/v1/voice-submissions/*` | GET    | Serve archived inbound voice recordings from R2       |
| `/public/ptxprint/*`          | GET    | Public (no auth): USFM sources, generated PDFs, fonts |

### User Endpoints

| Endpoint                                      | Method  | Description                             |
| --------------------------------------------- | ------- | --------------------------------------- |
| `/api/v1/orgs/:org/users/:userId/preferences` | GET/PUT | User preferences                        |
| `/api/v1/orgs/:org/users/:userId/history`     | GET     | Chat history (`?limit=` and `?offset=`) |

### Admin Endpoints

All admin endpoints require Bearer token authentication (super admin or org-specific admin key).

| Endpoint                                                               | Method       | Description                                         |
| ---------------------------------------------------------------------- | ------------ | --------------------------------------------------- |
| `/api/v1/admin/orgs/:org/mcp-servers`                                  | GET/PUT/POST | MCP server management (`?discover=true` for status) |
| `/api/v1/admin/orgs/:org/mcp-servers/:serverId`                        | DELETE       | Remove MCP server                                   |
| `/api/v1/admin/orgs/:org/config`                                       | GET/PUT/DEL  | Org config (history limits)                         |
| `/api/v1/admin/orgs/:org/prompt-overrides`                             | GET/PUT/DEL  | Org-level prompt overrides                          |
| `/api/v1/admin/orgs/:org/modes`                                        | GET          | List org modes (markdown view)                      |
| `/api/v1/admin/orgs/:org/modes/:modeName`                              | GET/PUT/DEL  | Manage individual mode (aliases resolve)            |
| `/api/v1/admin/orgs/:org/modes/:modeName/_rename`                      | POST         | Rename a mode; old slug retained as alias           |
| `/api/v1/admin/orgs/:org/modes/:modeName/_clone`                       | POST         | Clone a mode (clone starts unpublished)             |
| `/api/v1/admin/orgs/:org/modes/:modeName/_retire`                      | POST         | Retire a mode, forwarding its slug to another mode  |
| `/api/v1/admin/orgs/:org/languages`                                    | GET          | List org languages                                  |
| `/api/v1/admin/orgs/:org/languages/:languageName`                      | GET/PUT/DEL  | Manage individual language document                 |
| `/api/v1/admin/orgs/:org/language-scaffold`                            | GET/PUT/DEL  | Org language scaffold template                      |
| `/api/v1/admin/orgs/:org/users/:userId/mode`                           | GET/PUT/DEL  | User's active mode                                  |
| `/api/v1/admin/orgs/:org/users/:userId/prompt-overrides`               | GET/PUT/DEL  | User-level prompt overrides                         |
| `/api/v1/admin/orgs/:org/users/:userId/memory`                         | GET/DEL      | User persistent memory                              |
| `/api/v1/admin/orgs/:org/users/:userId/history`                        | DEL          | Delete user history                                 |
| `/api/v1/admin/orgs/:org/groups/:chatId/preferences`                   | GET/PUT      | Group preferences (response_language)               |
| `/api/v1/admin/orgs/:org/groups/:chatId/history`                       | GET/DEL      | Group chat history                                  |
| `/api/v1/admin/orgs/:org/groups/:chatId/memory`                        | GET/DEL      | Group shared memory                                 |
| `/api/v1/admin/orgs/:org/groups/:chatId/mode`                          | GET/PUT/DEL  | Group's active mode                                 |
| `/api/v1/admin/orgs/:org/groups/:chatId/threads/:threadId/preferences` | GET/PUT      | Thread preferences                                  |
| `/api/v1/admin/orgs/:org/groups/:chatId/threads/:threadId/history`     | GET/DEL      | Thread chat history                                 |
| `/api/v1/admin/orgs/:org/groups/:chatId/threads/:threadId/memory`      | GET/DEL      | Thread shared memory                                |

### Chat Request/Response

```typescript
// Request
interface ChatRequest {
  client_id: string;
  user_id: string;
  message?: string; // optional when message_type is 'audio'
  message_type: 'text' | 'audio';
  audio_base64?: string; // base64-encoded audio (required when message_type is 'audio')
  audio_format?: string; // 'ogg' | 'mp3' | 'wav' | 'webm' | 'flac' | 'm4a' — bare or MIME form ('audio/ogg')
  org?: string; // defaults to DEFAULT_ORG env var
  org_id?: string; // legacy alias for org (backward compat with whatsapp gateway)
  message_key?: string; // correlation ID for webhook callbacks — REQUIRED on /chat/callback, REJECTED elsewhere
  progress_callback_url?: string; // webhook URL — REQUIRED on /chat/callback, REJECTED elsewhere
  progress_mode?: 'complete' | 'iteration' | 'periodic' | 'sentence'; // valid on /chat/callback only
  progress_throttle_seconds?: number; // valid on /chat/callback only

  // Group/supergroup chat fields (all optional — omit for private chats)
  chat_type?: 'private' | 'group' | 'supergroup'; // defaults to 'private'
  chat_id?: string; // group/supergroup chat ID (required when chat_type is 'group' or 'supergroup')
  speaker?: string; // display name of the message sender (for group context)
  thread_id?: string; // topic/thread ID within a supergroup
  addressed_to_bot?: boolean; // false = ambient message the bot overheard but wasn't asked (defaults true)
  response_language_hint?: string; // ISO 639-1 code — overrides stored preference for this request
}

// Response
interface ChatResponse {
  responses: string[];
  response_language: string;
  voice_audio_base64: string | null; // deprecated — always null (legacy compat)
  voice_audio_url?: string | null; // URL to fetch TTS audio from R2 (e.g., /api/v1/audio/...)
  attachments?: Attachment[]; // tool-produced artifacts (PDFs, archived audio)
}

type Attachment =
  | {
      type: 'pdf';
      url: string;
      filename: string;
      size_bytes?: number;
      mime_type: 'application/pdf';
    }
  | { type: 'audio'; url: string; r2_key: string; mime_type: string };
```

### Chat Transports

Transport mode is selected explicitly by the endpoint path. Each consumer should pick the endpoint that matches its delivery needs:

| Endpoint                | Transport        | Response                                                           | Use case                                                                                 |
| ----------------------- | ---------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| `/api/v1/chat`          | Synchronous JSON | `200 OK` with a single `ChatResponse` body (plus `message_id`)     | Simple backends, CLIs — anywhere "one request, one response" is enough                   |
| `/api/v1/chat/stream`   | SSE streaming    | `text/event-stream` with `status`/`progress`/`complete` events     | Web client / admin portal — anywhere a "typing" indicator is useful                      |
| `/api/v1/chat/callback` | Webhook (async)  | `202 Accepted` + `{ message_id }`; POST to `progress_callback_url` | Telegram & WhatsApp gateways, any async consumer that can't hold an HTTP connection open |

The `/chat/callback` endpoint requires both `progress_callback_url` and `message_key` in the body. The `/api/v1/chat` and `/api/v1/chat/stream` endpoints both reject `progress_callback_url`, `progress_mode`, `progress_throttle_seconds`, and `message_key` (they are only valid on `/chat/callback`).

#### Concurrency note for `/api/v1/chat`

Because `/api/v1/chat` holds the HTTP connection open for the duration of the orchestration, it cannot queue. If the user's Durable Object is already processing another request, `/api/v1/chat` returns `429 CONCURRENT_REQUEST_REJECTED` with a `Retry-After: 5` header. Clients must implement retry logic. The SSE and callback transports both queue cleanly and do not have this limitation.

```json
{ "message_id": "uuid" }
```

#### Usage examples

**`/api/v1/chat`** — synchronous final-only JSON:

```bash
curl -X POST https://api.btservant.ai/api/v1/chat \
  -H "Authorization: Bearer $ENGINE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "client_id": "my-client",
    "user_id": "alice",
    "message_type": "text",
    "message": "Hello"
  }'
```

Blocks until the orchestrator finishes and returns a JSON body:

```json
{
  "message_id": "uuid",
  "responses": ["..."],
  "response_language": "en",
  "voice_audio_base64": null,
  "voice_audio_url": null
}
```

If the user's DO is already processing another request, returns `429` with `{"code": "CONCURRENT_REQUEST_REJECTED", ...}` and a `Retry-After: 5` header. Retry the request.

**`/api/v1/chat/stream`** — SSE streaming (use `curl -N` to disable buffering):

```bash
curl -N -X POST https://api.btservant.ai/api/v1/chat/stream \
  -H "Authorization: Bearer $ENGINE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "client_id": "my-client",
    "user_id": "alice",
    "message_type": "text",
    "message": "Hello"
  }'
```

Response is `text/event-stream` with `status`, `progress`, and `complete` frames ending in a final `complete` event.

**`/api/v1/chat/callback`** — async webhook delivery:

```bash
curl -X POST https://api.btservant.ai/api/v1/chat/callback \
  -H "Authorization: Bearer $ENGINE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "client_id": "my-client",
    "user_id": "alice",
    "message_type": "text",
    "message": "Hello",
    "progress_callback_url": "https://my-gateway.example.com/webhook",
    "message_key": "msg-123"
  }'
```

Immediate response: `202 Accepted` with `{"message_id": "uuid"}`. The worker then POSTs callback events (`status`, `progress`, `complete`, `error`) to the `progress_callback_url` asynchronously. Set `progress_mode: "complete"` to receive only the final completion event (zero intermediate status/progress POSTs).

More examples in [docs/curl-examples.md](docs/curl-examples.md).

### SSE Event Types

For `POST /api/v1/chat/stream`:

| Event         | Payload                                                  | Description               |
| ------------- | -------------------------------------------------------- | ------------------------- |
| `status`      | `{ type: 'status', message: string }`                    | Processing status updates |
| `progress`    | `{ type: 'progress', text: string }`                     | Streaming text chunks     |
| `complete`    | `{ type: 'complete', response: ChatResponse }`           | Final response            |
| `error`       | `{ type: 'error', error: string }`                       | Error message             |
| `tool_use`    | `{ type: 'tool_use', tool: string, input: unknown }`     | Tool invocation (debug)   |
| `tool_result` | `{ type: 'tool_result', tool: string, result: unknown }` | Tool result (debug)       |

### Webhook Progress Callbacks

When a request hits `POST /api/v1/chat/callback`, the worker returns `202 Accepted` immediately and sends POST requests to the supplied `progress_callback_url` with progress updates:

```typescript
// Payload
interface CallbackPayload {
  type: 'status' | 'progress' | 'complete' | 'error';
  user_id: string;
  message_key: string;
  timestamp: string;
  message?: string; // for 'status' type
  text?: string; // for 'progress' and 'complete' types
  error?: string; // for 'error' type
  voice_audio_url?: string | null; // for 'complete' — TTS audio URL (preferred)
  voice_audio_base64?: string | null; // for 'complete' — legacy, null when R2 is enabled
  attachments?: Attachment[]; // for 'complete' — PDFs / archived audio produced by tools
  chat_id?: string; // present for group/supergroup chats — use to route response to correct chat
  thread_id?: string; // present for supergroup threads — use to route response to correct thread
}

// Headers
{
  'Content-Type': 'application/json',
  'X-Engine-Token': '<ENGINE_API_KEY>'
}
```

#### Progress modes

The `progress_mode` field on the request body controls which events the worker sends to your webhook. Errors always fire regardless of mode.

| Mode        | Events delivered                                                      | Use case                                                                                                       |
| ----------- | --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `complete`  | **Only** the final `complete` event                                   | Clean "one request, one delivery" — anywhere intermediate updates would be noise in a user-facing chat.        |
| `iteration` | `status` + per-orchestration-iteration `progress` deltas + `complete` | Default. Used by the Telegram and WhatsApp gateways — good for surfacing "typing" indicators and partial text. |
| `periodic`  | `status` + accumulated `progress` every N seconds + `complete`        | Rate-limited intermediate updates on a fixed cadence. `progress_throttle_seconds` controls N.                  |
| `sentence`  | `status` + `progress` per complete sentence + `complete`              | Natural streaming where partial text only surfaces at sentence boundaries.                                     |

### Error Codes

All error responses follow a standard format:

```json
{ "error": "ErrorName", "code": "ERROR_CODE", "message": "Human-readable description" }
```

| Code                              | HTTP | Description                                        |
| --------------------------------- | ---- | -------------------------------------------------- |
| `VALIDATION_ERROR`                | 400  | Invalid request body or parameters                 |
| `AUTHENTICATION_ERROR`            | 401  | Missing or invalid Bearer token                    |
| `AUTHORIZATION_ERROR`             | 403  | Token valid but lacks permission for this org      |
| `CONCURRENT_REQUEST_REJECTED`     | 429  | Another request for this conversation is in flight |
| `MCP_CALL_LIMIT_EXCEEDED`         | 429  | Too many MCP calls in one `execute_code` run       |
| `MCP_REQUEST_CALL_LIMIT_EXCEEDED` | 429  | Too many MCP calls across the whole request        |
| `RATE_LIMIT_EXCEEDED`             | 429  | Rate limit hit on queue endpoints                  |
| `QUEUE_DEPTH_EXCEEDED`            | 429  | Conversation's queue is full                       |
| `AUDIO_TRANSCRIPTION_ERROR`       | 400  | STT failed (bad format, oversized, invalid base64) |
| `MCP_RESPONSE_TOO_LARGE`          | 413  | MCP server response exceeds size limit             |
| `CODE_EXECUTION_ERROR`            | 500  | QuickJS sandbox error                              |
| `INTERNAL_ERROR`                  | 500  | Unexpected server error                            |
| `MCP_ERROR`                       | 502  | MCP server unreachable or returned error           |
| `CLAUDE_API_ERROR`                | 502  | Claude API error                                   |
| `AUDIO_SYNTHESIS_ERROR`           | 502  | TTS failed                                         |
| `TIMEOUT_ERROR`                   | 504  | Operation timed out                                |

## Request Serialization & Concurrency

Chat requests are processed **one at a time per conversation** (per user for private chats, per group, or per thread) to ensure history integrity. Concurrent requests to the same conversation receive `429 Too Many Requests` with a `Retry-After` header. Different users sending to the same group queue up FIFO within that group's DO.

API consumers **must** implement retry logic for 429 responses. The lock has a 90-second stale threshold as a safety mechanism.

```json
{
  "error": "Request in progress",
  "code": "CONCURRENT_REQUEST_REJECTED",
  "message": "Another request for this user is currently being processed. Please retry.",
  "retry_after_ms": 5000
}
```

## Group & Supergroup Chat Support

The worker supports Telegram-style group and supergroup chats alongside private (1:1) chats. All group fields are optional — omit them for private chats and behavior is identical to pre-v2.12.

### Conversation Routing

Each conversation maps to its own Durable Object instance via a routing key:

| Chat Type         | Routing Key                         | DO Instance                   |
| ----------------- | ----------------------------------- | ----------------------------- |
| Private (default) | `user:{org}:{user_id}`              | One per user                  |
| Group             | `group:{org}:{chat_id}`             | One per group chat            |
| Supergroup thread | `group:{org}:{chat_id}:{thread_id}` | One per thread within a group |

Each DO instance has its **own** history, memory, preferences, mode, and queue — completely isolated from other conversations.

### How It Works

1. Gateway sends `POST /api/v1/chat` with `chat_type`, `chat_id`, and optionally `speaker`, `thread_id`, and `addressed_to_bot`
2. Worker routes to the correct DO based on the routing key above
3. Speaker name is saved in history entries and prefixed as `[Speaker Name]: message` in the LLM context
4. Claude receives a "Group Chat Context" system prompt section that identifies the current speaker
5. Ambient turns (`addressed_to_bot: false`) are recorded (and voice archived) without triggering a full response
6. Response is returned via the chosen transport (with `chat_id`/`thread_id` included in callback payloads for routing)

### Example: Group Chat Request

```json
{
  "client_id": "telegram",
  "user_id": "alice-123",
  "message_type": "text",
  "message": "What is Genesis about?",
  "chat_type": "group",
  "chat_id": "-100123456789",
  "speaker": "Alice"
}
```

### Example: Supergroup Thread Request

```json
{
  "client_id": "telegram",
  "user_id": "bob-456",
  "message_type": "text",
  "message": "Tell me about Abraham",
  "chat_type": "supergroup",
  "chat_id": "-100123456789",
  "thread_id": "42",
  "speaker": "Bob",
  "response_language_hint": "ru"
}
```

### Design Decisions

- **Thread-level isolation** — each supergroup thread gets its own DO (matches Telegram's thread UI)
- **Speaker = display name only** — no `speaker_id`; Claude sees the name for addressing
- **Shared memory per-conversation** — group memory benefits all participants (not per-user within a group)
- **Group reset = entire group** — `DELETE .../groups/:chatId/history` clears all group history, no per-user filtering
- **User prefs don't bleed into groups** — each group/thread DO stores its own `response_language` independently
- **Group-only modes** — modes with `requires_group: true` are hidden and blocked in private chats
- **`response_language_hint`** — per-request language override (e.g., gateway detects user's language and passes it)
- **Backward compatible** — all group fields are optional; existing clients send none of them

### Speaker Attribution

History entries include a `speaker` field. When building the LLM context, history messages are formatted as:

```
[Alice]: What is Genesis about?
[Bob]: Tell me about Abraham
```

This gives Claude awareness of who said what. Speaker names are sanitized (brackets stripped, 64-char limit) to prevent prompt injection.

Access control (who can reset a group, who counts as "addressed") is the **gateway's** responsibility — the worker trusts authenticated requests.

## Environment Variables & Secrets

### Secrets (set via `wrangler secret put`)

| Secret              | Description                                                               |
| ------------------- | ------------------------------------------------------------------------- |
| `ANTHROPIC_API_KEY` | API key for Claude                                                        |
| `OPENAI_API_KEY`    | API key for OpenAI (TTS)                                                  |
| `ENGINE_API_KEY`    | Bearer token for API auth + super-admin access + webhook `X-Engine-Token` |

### Required Environment Variables

Set in `wrangler.toml` under `[vars]`:

| Variable                       | Default           | Description                                 |
| ------------------------------ | ----------------- | ------------------------------------------- |
| `ENVIRONMENT`                  | `"development"`   | Runtime environment name                    |
| `MAX_ORCHESTRATION_ITERATIONS` | `"100"`           | Max Claude tool-use loop iterations         |
| `CODE_EXEC_TIMEOUT_MS`         | `"30000"`         | QuickJS execution timeout (ms)              |
| `MAX_MCP_CALLS_PER_EXECUTION`  | `"10"`            | Max MCP calls per `execute_code` invocation |
| `MAX_MCP_CALLS_PER_REQUEST`    | `"100"`           | Max MCP calls across a whole request        |
| `DEFAULT_ORG`                  | `"unfoldingWord"` | Fallback org when not specified in request  |

### Optional Environment Variables

These have sensible defaults and only need to be set to override:

| Variable                      | Default               | Description                               |
| ----------------------------- | --------------------- | ----------------------------------------- |
| `CLAUDE_MODEL`                | `"claude-sonnet-4-6"` | Claude model ID                           |
| `CLAUDE_MAX_TOKENS`           | `"4096"`              | Max tokens per Claude response            |
| `MAX_MCP_RESPONSE_SIZE_BYTES` | `"1048576"`           | Max response size from MCP servers (1 MB) |
| `MAX_QUEUE_DEPTH`             | `"50"`                | Max queued messages per conversation      |
| `QUEUE_MAX_RETRIES`           | `"3"`                 | Max retries for transient queue failures  |
| `ADMIN_RATE_LIMIT_MAX`        | —                     | Admin endpoint rate limit (requests)      |
| `ADMIN_RATE_LIMIT_WINDOW_MS`  | —                     | Admin endpoint rate limit window          |

### Cloudflare Bindings

| Binding            | Type           | Purpose                                                                   |
| ------------------ | -------------- | ------------------------------------------------------------------------- |
| `AI`               | Workers AI     | STT (Whisper)                                                             |
| `USER_DO`          | Durable Object | Per-conversation chat, history, memory, queue (private, group, or thread) |
| `AUDIO_BUCKET`     | R2 Bucket      | TTS audio + archived voice submissions                                    |
| `PTXPRINT_BUCKET`  | R2 Bucket      | USFM sources, generated PDFs, fonts (served at `/public/ptxprint/*`)      |
| `ORG_ADMIN_KEYS`   | KV Namespace   | Per-org admin Bearer tokens                                               |
| `MCP_SERVERS`      | KV Namespace   | MCP server configurations per org                                         |
| `ORG_CONFIG`       | KV Namespace   | Org-level configuration (history limits, etc.)                            |
| `PROMPT_OVERRIDES` | KV Namespace   | Org-level prompt overrides, modes, languages                              |

The worker also declares **tail consumers** (`bt-servant-tail` for death detection, `bt-servant-telemetry` for log fanout) and raises the CPU limit to 300,000 ms for long ptxprint flows.

### Environments

A staging environment is configured in `wrangler.toml` under `[env.staging]` with separate KV namespace IDs and worker name `bt-servant-worker-staging`. Observability is enabled at 100% sampling rate in all environments.

## Project Structure

```
bt-servant-worker/
├── src/
│   ├── index.ts                         # Worker entry point + routes (Hono)
│   ├── config/                          # Environment configuration types
│   ├── durable-objects/                 # UserDO — unified per-conversation Durable Object
│   ├── generated/                       # Auto-generated files (version.ts)
│   ├── services/
│   │   ├── audio/                      # STT (Whisper), TTS (OpenAI), R2 storage
│   │   ├── classifier/                 # #mode / @language trigger detection
│   │   ├── claude/                      # Orchestrator, system prompt, tools
│   │   ├── code-execution/             # QuickJS sandbox
│   │   ├── mcp/                        # MCP discovery, catalog, health
│   │   ├── memory/                     # Persistent memory (parser, store)
│   │   ├── progress/                   # Webhook progress callbacks
│   │   └── ptxprint/                   # Scripture PDF typesetting (macro tool, polling, R2 mirror)
│   ├── types/                          # Shared TypeScript types
│   └── utils/                          # Logger, crypto, errors, validation
├── tail-worker/                        # Separate tail worker (bt-servant-tail) — death detection
├── tests/
│   ├── unit/                           # Unit tests
│   └── e2e/                            # End-to-end tests
├── docs/
│   ├── architecture/                   # C4 ecosystem diagrams (context + container)
│   ├── implementation-plan.md          # Full implementation plan
│   ├── spoken-mode-document.md         # Spoken mode design (voice archival, ambient turns)
│   ├── curl-examples.md                # API usage examples
│   └── plans/                          # Feature implementation plans
├── .github/workflows/
│   ├── ci.yml                          # CI: lint, typecheck, test, build, audit
│   ├── deploy.yml                      # Deploy to Cloudflare (after CI passes)
│   └── claude-review.yml              # Claude PR reviews
├── wrangler.toml                       # Cloudflare Worker config
├── wrangler.test.toml                  # Test config (omits [ai] binding for CI)
├── package.json                        # Dependencies and scripts
├── tsconfig.json                       # TypeScript config (strict mode)
├── eslint.config.js                    # ESLint with fitness functions
├── .dependency-cruiser.js              # Architecture enforcement
├── .prettierrc                         # Code formatting
└── .husky/pre-commit                   # Pre-commit hooks
```

## Development

### Prerequisites

- Node.js >= 22.0.0
- pnpm >= 9.0.0

### Setup

```bash
pnpm install
```

#### Line endings (Windows)

The repo enforces LF line endings via `.gitattributes`. Fresh clones are handled
automatically. If you have an **existing** clone made under Git-for-Windows'
default `core.autocrlf=true`, its files are still CRLF on disk and
`pnpm format:check` will fail until you migrate them once (clean working tree
required — commit or stash first):

```bash
pnpm normalize:eol
```

### Commands

| Command                    | Description                                  |
| -------------------------- | -------------------------------------------- |
| `pnpm dev`                 | Start local development server               |
| `pnpm build`               | Build the worker                             |
| `pnpm test`                | Run tests                                    |
| `pnpm test:watch`          | Run tests in watch mode                      |
| `pnpm lint`                | Run ESLint                                   |
| `pnpm lint:fix`            | Run ESLint with auto-fix                     |
| `pnpm format`              | Format code with Prettier                    |
| `pnpm format:check`        | Check formatting without writing             |
| `pnpm normalize:eol`       | Re-checkout the worktree as LF (one-time)    |
| `pnpm check`               | TypeScript type check                        |
| `pnpm check:tail`          | Type check the tail worker                   |
| `pnpm architecture`        | Check for circular dependencies              |
| `pnpm audit:prod`          | Dependency audit (production tree)           |
| `pnpm audit:all`           | Dependency audit (full tree, high+ severity) |
| `pnpm deploy:tail`         | Deploy the tail worker (CI/manual)           |
| `pnpm deploy:tail:staging` | Deploy the tail worker to staging            |

### Local Testing

```bash
pnpm dev
# In another terminal:
curl http://localhost:8787/health
```

## Code Quality (Fitness Functions)

This project enforces strict code quality rules via ESLint:

| Rule                     | Limit    | Purpose                          |
| ------------------------ | -------- | -------------------------------- |
| `max-lines-per-function` | 50 lines | Keep functions small and focused |
| `max-statements`         | 25       | Limit complexity per function    |
| `complexity`             | 10       | Cyclomatic complexity limit      |
| `max-depth`              | 4        | Limit nested blocks              |
| `max-nested-callbacks`   | 3        | Prevent callback hell            |
| `max-params`             | 5        | Encourage parameter objects      |

### Architecture Enforcement

Dependency-cruiser enforces onion architecture:

- **No circular dependencies** allowed
- **types/** cannot import from routes, services, or durable-objects
- **services/** cannot import from routes

## Deployment

Deployments go through CI/CD (never deploy directly):

1. Push to a branch and create a PR
2. CI runs (lint, typecheck, test, build, dependency audit)
3. Claude PR Review runs automatically
4. On merge to `main`, deploy runs automatically

The worker will be available at: `https://bt-servant-worker.<your-subdomain>.workers.dev`

## Pre-commit Hooks

Every commit runs:

1. **lint-staged** — ESLint + Prettier on staged files
2. **Type check** — `tsc --noEmit`
3. **Architecture check** — dependency-cruiser
4. **Tests** — vitest
5. **Build** — wrangler build

If any check fails, the commit is blocked.

## Consumers

These projects depend on bt-servant-worker's API (see the [C4 ecosystem diagrams](docs/architecture/) for the full picture):

- **[bt-servant-web-client](../bt-servant-web-client)** — Next.js chat frontend (SSE transport)
- **[bt-servant-admin-portal](../bt-servant-admin-portal)** — Admin dashboard for org config, MCP servers, prompt overrides, modes, languages, and user management
- **[bt-servant-whatsapp-gateway](../bt-servant-whatsapp-gateway)** — WhatsApp Business API integration (callback transport; audio messages forwarded as `message_type: 'audio'`)
- **bt-servant-telegram-gateway** — Telegram Bot API integration (private, group, and supergroup chats with thread support and spoken mode)
- **bt-servant-signal-gateway** — Signal messenger integration
- **[baruch](../baruch)** — Cloudflare Worker companion service (self-administering via Claude tools and the admin API)

## Related Projects

- **fia-mcp** — FIA knowledge-base MCP server, one of the MCP servers the worker orchestrates
- **bt-servant-engine** — The Python/FastAPI predecessor (deprecated)

## License

Private
