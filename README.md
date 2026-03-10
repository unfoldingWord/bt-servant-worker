# bt-servant-worker

[![CI](https://github.com/unfoldingWord/bt-servant-worker/actions/workflows/ci.yml/badge.svg)](https://github.com/unfoldingWord/bt-servant-worker/actions/workflows/ci.yml)

> AI-powered assistance for Bible translators, at the edge.

A Cloudflare Worker that provides AI-powered assistance to Bible translators via Claude, with sandboxed code execution, dynamic MCP tool orchestration, and per-user persistent memory.

## What This Project Does

bt-servant-worker is deployed on Cloudflare's edge network and provides:

- **Claude-powered chat** with multi-turn orchestration (up to 10 tool-use iterations per request)
- **Dynamic MCP tool discovery** — discovers and calls MCP tools from configured servers
- **Sandboxed code execution** via QuickJS compiled to WebAssembly
- **Audio message support** — speech-to-text (STT) via Whisper and text-to-speech (TTS) via Deepgram Aura-2, powered by Cloudflare Workers AI
- **Per-user state** — chat history, preferences, prompt overrides, and persistent memory via Durable Objects
- **Request serialization** — one request at a time per user, preventing race conditions
- **Streaming support** — real-time SSE streaming and webhook progress callbacks
- **Dynamic prompt overrides** — org and user-level customization of Claude's system prompt
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

**Durable Objects** — Each user gets their own instance that guarantees single-threaded execution, stores chat history/preferences/memory, and persists data across requests.

**MCP Budget & Health Tracking** — Downstream API call budget tracking with circuit breaker pattern prevents runaway costs and blocks unhealthy servers.

**User Persistent Memory** — Schema-free markdown document per user. A deterministic TOC is injected into the system prompt; Claude reads/writes specific sections via tools. Memory persists indefinitely across sessions. 128KB storage cap per user.

**Dynamic Prompt Overrides** — 6 customizable prompt slots (identity, methodology, tool_guidance, instructions, memory_instructions, closing) with 3-tier resolution: user → org → default.

**Audio Pipeline (Workers AI)** — When a user sends an audio message (`message_type: 'audio'`), the worker transcribes it using Whisper (`@cf/openai/whisper-large-v3-turbo`), processes the transcribed text through the normal Claude orchestration, then auto-generates a spoken response using Deepgram Aura-2 (`@cf/deepgram/aura-2-en`). TTS failure is non-fatal — the text response is always returned. Requires the `AI` binding in `wrangler.toml`.

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
| `/api/v1/orgs/:org/users/:userId/history`     | GET/DEL | Chat history     |

### Admin Endpoints

All admin endpoints require Bearer token authentication (super admin or org-specific admin key).

| Endpoint                                                 | Method       | Description                 |
| -------------------------------------------------------- | ------------ | --------------------------- |
| `/api/v1/admin/orgs/:org/mcp-servers`                    | GET/PUT/POST | MCP server management       |
| `/api/v1/admin/orgs/:org/mcp-servers/:serverId`          | DELETE       | Remove MCP server           |
| `/api/v1/admin/orgs/:org/config`                         | GET/PUT/DEL  | Org config (history limits) |
| `/api/v1/admin/orgs/:org/prompt-overrides`               | GET/PUT/DEL  | Org-level prompt overrides  |
| `/api/v1/admin/orgs/:org/users/:userId/prompt-overrides` | GET/PUT/DEL  | User-level prompt overrides |
| `/api/v1/admin/orgs/:org/users/:userId/memory`           | GET/DEL      | User persistent memory      |

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
  org?: string;
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

## Request Serialization & Concurrency

Chat requests are processed **one at a time per user** to ensure conversation history integrity. Concurrent requests receive `429 Too Many Requests` with a `Retry-After` header.

API consumers **must** implement retry logic for 429 responses. The lock has a 90-second stale threshold as a safety mechanism.

See the [429 Response Format](#429-response-format) below.

### 429 Response Format

```json
{
  "error": "Request in progress",
  "code": "CONCURRENT_REQUEST_REJECTED",
  "message": "Another request for this user is currently being processed. Please retry.",
  "retry_after_ms": 5000
}
```

## Project Structure

```
bt-servant-worker/
├── src/
│   ├── index.ts                         # Worker entry point + admin routes
│   ├── config/                          # Environment configuration types
│   ├── durable-objects/                 # UserSession Durable Object
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

| Command             | Description                     |
| ------------------- | ------------------------------- |
| `pnpm dev`          | Start local development server  |
| `pnpm build`        | Build the worker                |
| `pnpm test`         | Run tests                       |
| `pnpm lint`         | Run ESLint                      |
| `pnpm format`       | Format code with Prettier       |
| `pnpm check`        | TypeScript type check           |
| `pnpm architecture` | Check for circular dependencies |

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
