# bt-servant-worker

[![CI](https://github.com/unfoldingWord/bt-servant-worker/actions/workflows/ci.yml/badge.svg)](https://github.com/unfoldingWord/bt-servant-worker/actions/workflows/ci.yml)

> AI-powered assistance for Bible translators, at the edge.

A Cloudflare Worker (built with [Hono](https://hono.dev/)) that provides AI-powered assistance to Bible translators via Claude, with sandboxed code execution, dynamic MCP tool orchestration, and per-user persistent memory.

## What This Project Does

bt-servant-worker is deployed on Cloudflare's edge network and provides:

- **Claude-powered chat** with multi-turn orchestration (up to 10 tool-use iterations per request)
- **Dynamic MCP tool discovery** — discovers and calls MCP tools from configured servers
- **Sandboxed code execution** via QuickJS compiled to WebAssembly
- **Audio message support** — speech-to-text (STT) via Whisper and text-to-speech (TTS) via Deepgram Aura-2, powered by Cloudflare Workers AI
- **Per-user state** — chat history, preferences, prompt overrides, and persistent memory via Durable Objects (SQLite-backed)
- **Request serialization** — one request at a time per user, preventing race conditions
- **Streaming support** — real-time SSE streaming and webhook progress callbacks
- **Queue system** — fire-and-forget enqueue with poll/stream retrieval for clients that can't hold long connections
- **Dynamic prompt overrides** — org and user-level customization of Claude's system prompt
- **Modes** — named prompt override presets (e.g., "mast-methodology") assignable per-user
- **User persistent memory** — schema-free markdown memory that persists across conversations

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│  Cloudflare Worker                                              │
│                                                                 │
│  POST /api/v1/chat ──► KV (org config, MCP servers, prompts)   │
│       │                                                         │
│       ▼                                                         │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │ Durable Object (per-user)                               │    │
│  │ - Chat history, preferences, prompt overrides, memory   │    │
│  │ - Request serialization via storage lock                │    │
│  └──────────────┬──────────────────────────────────────────┘    │
│                 │                                               │
│    ┌────────────┴────────────────────────────┐                  │
│    ▼                                         ▼                  │
│  Workers AI (STT/TTS)            Claude Orchestrator            │
│  ├─ Whisper (transcribe)         ├─ System prompt + tool catalog│
│  └─ Deepgram Aura-2 (speak)     └─ Up to 10 iterations        │
│                                         │                       │
│                    ┌────────────┬────────┴───┬──────────┐       │
│                    ▼            ▼            ▼          ▼       │
│                execute_code  get_tool_   read_memory  update_   │
│                (QuickJS)     definitions (DO store)   memory    │
└─────────────────────────────────────────────────────────────────┘
```

### Key Components

**QuickJS Sandbox** — Replaces Node.js `isolated-vm` with QuickJS compiled to WebAssembly. Code runs in a completely isolated sandbox with no access to `fetch`, environment variables, or Worker APIs. Only explicitly injected MCP tool wrappers are available.

**Durable Objects** — Two DO classes, both using SQLite-backed storage:

- **UserSession** — per-user chat processing, history, preferences, memory, prompt overrides
- **UserQueue** — alarm-based FIFO queue for async message processing with retry logic

**MCP Budget & Health Tracking** — Downstream API call budget tracking with circuit breaker pattern prevents runaway costs and blocks unhealthy servers.

**User Persistent Memory** — Schema-free markdown document per user. A deterministic TOC is injected into the system prompt; Claude reads/writes specific sections via tools. Memory persists indefinitely across sessions. 128KB storage cap per user.

**Dynamic Prompt Overrides** — 7 customizable prompt slots with 4-tier resolution: user → mode → org → default.

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

**Audio Pipeline (Workers AI)** — When a user sends an audio message (`message_type: 'audio'`), the worker transcribes it using Whisper (`@cf/openai/whisper-large-v3-turbo`), processes the transcribed text through the normal Claude orchestration, then auto-generates a spoken response using Deepgram Aura-2 (`@cf/deepgram/aura-2-en`). TTS failure is non-fatal — the text response is always returned.

| Constraint              | Value                                |
| ----------------------- | ------------------------------------ |
| Max audio input size    | 25 MB                                |
| Supported audio formats | ogg, mp3, wav, webm, flac, m4a       |
| Max TTS input           | 10,000 characters (truncated beyond) |
| TTS output format       | MP3                                  |
| TTS speaker             | luna                                 |

### Claude Built-in Tools

| Tool                   | Purpose                                                |
| ---------------------- | ------------------------------------------------------ |
| `execute_code`         | Run JavaScript in QuickJS sandbox with MCP tool access |
| `get_tool_definitions` | Get full JSON schemas for MCP tools before using them  |
| `read_memory`          | Read a section from the user's persistent memory       |
| `update_memory`        | Write/update a section of the user's persistent memory |
| `list_modes`           | List available prompt modes for the current org        |
| `switch_mode`          | Switch the user's active prompt mode                   |

## Authentication

All `/api/*` routes require a Bearer token in the `Authorization` header.

- **`ENGINE_API_KEY`** — super-admin token, grants access to all orgs and all endpoints
- **Org admin keys** — stored in the `ORG_ADMIN_KEYS` KV namespace, keyed by org name; grants admin access to that org only
- **Webhook callbacks** — authenticated via `X-Engine-Token` header containing the `ENGINE_API_KEY`

```
Authorization: Bearer <ENGINE_API_KEY or org-specific admin key>
```

## API Endpoints

### Chat

| Endpoint                     | Method | Description                           |
| ---------------------------- | ------ | ------------------------------------- |
| `/health`                    | GET    | Health check                          |
| `/api/v1/chat`               | POST   | Chat with Claude (synchronous)        |
| `/api/v1/chat/stream`        | POST   | Chat with Claude (SSE streaming)      |
| `/api/v1/chat/queue`         | POST   | Enqueue message — returns immediately |
| `/api/v1/chat/queue/poll`    | GET    | Poll for queued message events        |
| `/api/v1/chat/queue/stream`  | GET    | SSE stream for a queued message       |
| `/api/v1/chat/queue/:userId` | GET    | Queue status (debug)                  |

### User Endpoints

| Endpoint                                      | Method  | Description      |
| --------------------------------------------- | ------- | ---------------- |
| `/api/v1/orgs/:org/users/:userId/preferences` | GET/PUT | User preferences |
| `/api/v1/orgs/:org/users/:userId/history`     | GET     | Chat history     |

### Admin Endpoints

All admin endpoints require Bearer token authentication (super admin or org-specific admin key).

| Endpoint                                                 | Method       | Description                                         |
| -------------------------------------------------------- | ------------ | --------------------------------------------------- |
| `/api/v1/admin/orgs/:org/mcp-servers`                    | GET/PUT/POST | MCP server management (`?discover=true` for status) |
| `/api/v1/admin/orgs/:org/mcp-servers/:serverId`          | DELETE       | Remove MCP server                                   |
| `/api/v1/admin/orgs/:org/config`                         | GET/PUT/DEL  | Org config (history limits)                         |
| `/api/v1/admin/orgs/:org/prompt-overrides`               | GET/PUT/DEL  | Org-level prompt overrides                          |
| `/api/v1/admin/orgs/:org/modes`                          | GET          | List org modes                                      |
| `/api/v1/admin/orgs/:org/modes/:modeName`                | GET/PUT/DEL  | Manage individual mode                              |
| `/api/v1/admin/orgs/:org/users/:userId/mode`             | GET/PUT/DEL  | User's active mode                                  |
| `/api/v1/admin/orgs/:org/users/:userId/prompt-overrides` | GET/PUT/DEL  | User-level prompt overrides                         |
| `/api/v1/admin/orgs/:org/users/:userId/memory`           | GET/DEL      | User persistent memory                              |
| `/api/v1/admin/orgs/:org/users/:userId/history`          | DEL          | Delete user history                                 |

### Chat Request/Response

```typescript
// Request
interface ChatRequest {
  client_id: string;
  user_id: string;
  message: string;
  message_type: 'text' | 'audio';
  audio_base64?: string; // base64-encoded audio (required when message_type is 'audio')
  audio_format?: string; // audio format: 'ogg' | 'mp3' | 'wav' | 'webm' | 'flac' | 'm4a'
  org?: string; // defaults to DEFAULT_ORG env var
  org_id?: string; // legacy alias for org (backward compat with whatsapp gateway)
  message_key?: string; // correlation ID for webhook progress callbacks
  progress_callback_url?: string; // webhook URL for progress updates
  progress_mode?: 'complete' | 'iteration' | 'periodic' | 'sentence';
  progress_throttle_seconds?: number;
}

// Response
interface ChatResponse {
  responses: string[];
  response_language: string;
  voice_audio_base64: string | null; // base64 MP3 audio when input was audio, null otherwise
}
```

### Queue Endpoints

The queue system is for clients that can't hold open long connections (e.g., WhatsApp gateway). Enqueue a message, then poll or stream for results.

**Enqueue** — `POST /api/v1/chat/queue`

Same body as `/api/v1/chat`. Returns `202 Accepted`:

```json
{ "message_id": "uuid", "queue_position": 0 }
```

**Poll** — `GET /api/v1/chat/queue/poll?user_id=...&message_id=...&org=...&cursor=0`

Returns incremental events since `cursor`. Use the returned `cursor` for the next poll:

```json
{ "message_id": "uuid", "events": [...], "done": false, "cursor": 3 }
```

**Stream** — `GET /api/v1/chat/queue/stream?user_id=...&message_id=...&org=...`

SSE stream that emits events as they occur: `queued`, `processing`, `done`.

**Status** — `GET /api/v1/chat/queue/:userId?org=...`

Debug endpoint returning queue depth and processing state.

### SSE Event Types

For `/api/v1/chat/stream`:

| Event         | Payload                                                  | Description               |
| ------------- | -------------------------------------------------------- | ------------------------- |
| `status`      | `{ type: 'status', message: string }`                    | Processing status updates |
| `progress`    | `{ type: 'progress', text: string }`                     | Streaming text chunks     |
| `complete`    | `{ type: 'complete', response: ChatResponse }`           | Final response            |
| `error`       | `{ type: 'error', error: string }`                       | Error message             |
| `tool_use`    | `{ type: 'tool_use', tool: string, input: unknown }`     | Tool invocation (debug)   |
| `tool_result` | `{ type: 'tool_result', tool: string, result: unknown }` | Tool result (debug)       |

### Webhook Progress Callbacks

When `progress_callback_url` is provided, the worker sends POST requests with progress updates:

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
}

// Headers
{
  'Content-Type': 'application/json',
  'X-Engine-Token': '<ENGINE_API_KEY>'
}
```

### Error Codes

All error responses follow a standard format:

```json
{ "error": "ErrorName", "code": "ERROR_CODE", "message": "Human-readable description" }
```

| Code                          | HTTP | Description                                        |
| ----------------------------- | ---- | -------------------------------------------------- |
| `VALIDATION_ERROR`            | 400  | Invalid request body or parameters                 |
| `AUTHENTICATION_ERROR`        | 401  | Missing or invalid Bearer token                    |
| `AUTHORIZATION_ERROR`         | 403  | Token valid but lacks permission for this org      |
| `CONCURRENT_REQUEST_REJECTED` | 429  | Another request for this user is in progress       |
| `MCP_CALL_LIMIT_EXCEEDED`     | 429  | Too many MCP calls in one execution                |
| `MCP_BUDGET_EXCEEDED`         | 429  | Downstream API budget exceeded                     |
| `RATE_LIMIT_EXCEEDED`         | 429  | Rate limit hit on queue endpoints                  |
| `QUEUE_DEPTH_EXCEEDED`        | 429  | User's queue is full                               |
| `AUDIO_TRANSCRIPTION_ERROR`   | 400  | STT failed (bad format, oversized, invalid base64) |
| `MCP_RESPONSE_TOO_LARGE`      | 413  | MCP server response exceeds size limit             |
| `CODE_EXECUTION_ERROR`        | 500  | QuickJS sandbox error                              |
| `INTERNAL_ERROR`              | 500  | Unexpected server error                            |
| `MCP_ERROR`                   | 502  | MCP server unreachable or returned error           |
| `CLAUDE_API_ERROR`            | 502  | Claude API error                                   |
| `AUDIO_SYNTHESIS_ERROR`       | 502  | TTS failed                                         |
| `TIMEOUT_ERROR`               | 504  | Operation timed out                                |

## Request Serialization & Concurrency

Chat requests are processed **one at a time per user** to ensure conversation history integrity. Concurrent requests receive `429 Too Many Requests` with a `Retry-After` header.

API consumers **must** implement retry logic for 429 responses. The lock has a 90-second stale threshold as a safety mechanism.

```json
{
  "error": "Request in progress",
  "code": "CONCURRENT_REQUEST_REJECTED",
  "message": "Another request for this user is currently being processed. Please retry.",
  "retry_after_ms": 5000
}
```

## Environment Variables & Secrets

### Secrets (set via `wrangler secret put`)

| Secret              | Description                                                               |
| ------------------- | ------------------------------------------------------------------------- |
| `ANTHROPIC_API_KEY` | API key for Claude                                                        |
| `ENGINE_API_KEY`    | Bearer token for API auth + super-admin access + webhook `X-Engine-Token` |

### Required Environment Variables

Set in `wrangler.toml` under `[vars]`:

| Variable                       | Default           | Description                                 |
| ------------------------------ | ----------------- | ------------------------------------------- |
| `ENVIRONMENT`                  | `"development"`   | Runtime environment name                    |
| `MAX_ORCHESTRATION_ITERATIONS` | `"10"`            | Max Claude tool-use loop iterations         |
| `CODE_EXEC_TIMEOUT_MS`         | `"30000"`         | QuickJS execution timeout (ms)              |
| `MAX_MCP_CALLS_PER_EXECUTION`  | `"10"`            | Max MCP calls per `execute_code` invocation |
| `DEFAULT_ORG`                  | `"unfoldingWord"` | Fallback org when not specified in request  |

### Optional Environment Variables

These have sensible defaults and only need to be set to override:

| Variable                           | Default               | Description                                                      |
| ---------------------------------- | --------------------- | ---------------------------------------------------------------- |
| `CLAUDE_MODEL`                     | `"claude-sonnet-4-6"` | Claude model ID                                                  |
| `CLAUDE_MAX_TOKENS`                | `"4096"`              | Max tokens per Claude response                                   |
| `MAX_DOWNSTREAM_CALLS_PER_REQUEST` | —                     | MCP downstream API budget per request                            |
| `DEFAULT_DOWNSTREAM_PER_MCP_CALL`  | —                     | Estimated downstream calls per MCP tool call                     |
| `MAX_MCP_RESPONSE_SIZE_BYTES`      | `"1048576"`           | Max response size from MCP servers (1 MB)                        |
| `MAX_QUEUE_DEPTH`                  | `"50"`                | Max queued messages per user                                     |
| `QUEUE_STORED_RESPONSE_TTL_MS`     | `"300000"`            | TTL for stored responses for late-connecting SSE clients (5 min) |
| `QUEUE_MAX_RETRIES`                | `"3"`                 | Max retries for transient queue failures                         |

### Cloudflare Bindings

| Binding            | Type           | Purpose                                        |
| ------------------ | -------------- | ---------------------------------------------- |
| `AI`               | Workers AI     | STT (Whisper) and TTS (Deepgram Aura-2)        |
| `USER_SESSION`     | Durable Object | Per-user chat processing, history, memory      |
| `USER_QUEUE`       | Durable Object | Async message queue with alarm-based FIFO      |
| `ORG_ADMIN_KEYS`   | KV Namespace   | Per-org admin Bearer tokens                    |
| `MCP_SERVERS`      | KV Namespace   | MCP server configurations per org              |
| `ORG_CONFIG`       | KV Namespace   | Org-level configuration (history limits, etc.) |
| `PROMPT_OVERRIDES` | KV Namespace   | Org-level prompt overrides and modes           |

### Environments

A staging environment is configured in `wrangler.toml` under `[env.staging]` with separate KV namespace IDs and worker name `bt-servant-worker-staging`. Observability is enabled at 100% sampling rate in all environments.

## Project Structure

```
bt-servant-worker/
├── src/
│   ├── index.ts                         # Worker entry point + routes (Hono)
│   ├── config/                          # Environment configuration types
│   ├── durable-objects/                 # UserSession + UserQueue Durable Objects
│   ├── services/
│   │   ├── audio/                      # STT/TTS via Workers AI (Whisper, Deepgram)
│   │   ├── claude/                      # Orchestrator, system prompt, tools
│   │   ├── code-execution/             # QuickJS sandbox
│   │   ├── mcp/                        # MCP discovery, catalog, budget, health
│   │   ├── memory/                     # User persistent memory (parser, store)
│   │   └── progress/                   # Webhook progress callbacks
│   ├── types/                          # Shared TypeScript types
│   └── utils/                          # Logger, crypto, errors, validation
├── tests/
│   ├── unit/                           # Unit tests
│   └── e2e/                            # End-to-end tests
├── docs/
│   ├── implementation-plan.md          # Full implementation plan
│   └── plans/                          # Feature implementation plans
├── .github/workflows/
│   ├── ci.yml                          # CI: lint, typecheck, test, build
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

- Node.js >= 20.0.0
- pnpm >= 9.0.0

### Setup

```bash
pnpm install
```

### Commands

| Command             | Description                      |
| ------------------- | -------------------------------- |
| `pnpm dev`          | Start local development server   |
| `pnpm build`        | Build the worker                 |
| `pnpm test`         | Run tests                        |
| `pnpm test:watch`   | Run tests in watch mode          |
| `pnpm lint`         | Run ESLint                       |
| `pnpm lint:fix`     | Run ESLint with auto-fix         |
| `pnpm format`       | Format code with Prettier        |
| `pnpm format:check` | Check formatting without writing |
| `pnpm check`        | TypeScript type check            |
| `pnpm architecture` | Check for circular dependencies  |

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
2. CI runs (lint, typecheck, test, build)
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

These projects depend on bt-servant-worker's API:

- **[bt-servant-web-client](../bt-servant-web-client)** — Next.js chat frontend (audio UI gated behind `AUDIO_ENABLED` flag)
- **[bt-servant-admin-portal](../bt-servant-admin-portal)** — Admin dashboard for org config, MCP servers, prompt overrides, and user management
- **[bt-servant-whatsapp-gateway](../bt-servant-whatsapp-gateway)** — WhatsApp Business API integration (audio messages forwarded as `message_type: 'audio'`)
- **[baruch](../baruch)** — Cloudflare Worker companion service (self-administering via Claude tools)

## Related Projects

- **bt-servant-engine** — The Python/FastAPI predecessor (deprecated)

## License

Private
