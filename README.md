# bt-servant-worker

[![CI](https://github.com/unfoldingWord/bt-servant-worker/actions/workflows/ci.yml/badge.svg)](https://github.com/unfoldingWord/bt-servant-worker/actions/workflows/ci.yml)

> AI-powered assistance for Bible translators, at the edge.

This project is designed to help translators work more efficiently with their Bible translation projects. It provides advanced features for processing natural language queries and executing code in a secure environment.

A Cloudflare Worker that evolves bt-servant-engine into a modern, edge-deployed architecture with QuickJS-based sandboxed code execution for dynamic MCP tool orchestration.

## What This Project Does

bt-servant-worker is an AI-powered assistant for Bible translators, deployed on Cloudflare's edge network. It replaces the existing Python/FastAPI bt-servant-engine with a TypeScript-based Cloudflare Worker that can:

- Process natural language queries about Bible translation
- Dynamically discover and call MCP (Model Context Protocol) tools
- Execute code in a sandboxed QuickJS environment
- Maintain per-user chat history and preferences
- Serialize requests per-user using Durable Objects

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│  Cloudflare Worker                                              │
│                                                                 │
│  POST /api/v1/chat                                              │
│       │                                                         │
│       ▼                                                         │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────────────┐  │
│  │ MCP Registry│───▶│ Discovery   │───▶│ Tool Catalog        │  │
│  │ (DO Storage)│    │ (fetch MCP) │    │ (for system prompt) │  │
│  └─────────────┘    └─────────────┘    └─────────────────────┘  │
│                                               │                 │
│                                               ▼                 │
│                     ┌─────────────────────────────────────────┐ │
│                     │ Claude Orchestrator                     │ │
│                     │ - System prompt with tool catalog       │ │
│                     │ - Up to 10 iterations                   │ │
│                     │ - Parallel tool execution               │ │
│                     └──────────────┬──────────────────────────┘ │
│                                    │                            │
│              ┌─────────────────────┼─────────────────────┐      │
│              ▼                     ▼                     ▼      │
│  ┌───────────────────┐  ┌─────────────────┐  ┌───────────────┐  │
│  │ execute_code      │  │ get_tool_defs   │  │ Direct MCP    │  │
│  │ (QuickJS sandbox) │  │ (return schemas)│  │ tool call     │  │
│  └───────────────────┘  └─────────────────┘  └───────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

### Key Innovation: QuickJS Sandbox

The project replaces Node.js `isolated-vm` (which uses native V8 snapshots and can't run on Cloudflare) with QuickJS compiled to WebAssembly. This provides:

- **Security**: Code runs in a completely isolated sandbox with no access to `fetch`, environment variables, or Worker APIs
- **Controlled Access**: Only explicitly injected functions (MCP tool wrappers) are available
- **Edge Compatibility**: Runs on Cloudflare's edge network worldwide

### Durable Objects for Request Serialization

Each user gets their own Durable Object instance that:

- Guarantees single-threaded execution (no race conditions)
- Stores chat history, preferences, and MCP server configs
- Persists data across requests (survives Worker eviction)
- Matches the `asyncio.Lock` behavior from bt-servant-engine

## Request Serialization & Concurrency

### Why Requests Are Serialized Per User

bt-servant-worker processes chat requests **one at a time per user** to ensure conversation history integrity. This prevents race conditions where:

- Two concurrent requests read the same history state
- Both generate responses based on stale context
- History becomes inconsistent with what the user sees in their chat interface

### How It Works

Each user's chat session is handled by a dedicated Durable Object instance. When a request arrives:

1. The DO checks if another request is currently processing (via a storage lock)
2. If **not locked**: acquire lock, process request, release lock
3. If **locked**: return `429 Too Many Requests` immediately

### Handling 429 Responses

API consumers **must** implement retry logic for 429 responses:

```typescript
async function sendChatRequest(message: string, userId: string): Promise<ChatResponse> {
  const maxRetries = 10;
  const baseDelay = 2000; // Start with 2 second delay

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const response = await fetch(`${API_URL}/api/v1/orgs/${org}/users/${userId}/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${API_KEY}`,
      },
      body: JSON.stringify({ message, user_id: userId }),
    });

    if (response.status === 429) {
      // Another request is processing - wait and retry
      const retryAfter = response.headers.get('Retry-After');
      const delay = retryAfter ? parseInt(retryAfter) * 1000 : baseDelay * Math.pow(1.5, attempt);

      console.log(`Request queued, retrying in ${delay}ms...`);
      await new Promise((resolve) => setTimeout(resolve, delay));
      continue;
    }

    if (!response.ok) {
      throw new Error(`API error: ${response.status}`);
    }

    return response.json();
  }

  throw new Error('Max retries exceeded - request could not be processed');
}
```

### 429 Response Format

```json
{
  "error": "Request in progress",
  "code": "CONCURRENT_REQUEST",
  "message": "Another request for this user is currently being processed. Please retry.",
  "retry_after_ms": 5000
}
```

**Headers:**

- `Retry-After: 5` (suggested wait time in seconds)
- `Content-Type: application/json`

### Why Not Queue in the Server?

We considered server-side request queuing but chose client-side retry because:

1. **Resilience**: If the server crashes, queued requests would be lost. With client retry, the client still has the message.
2. **Standard HTTP**: 429 is a well-understood pattern that clients expect to handle.
3. **Observability**: 429 responses are logged and can be monitored for contention issues.
4. **Simplicity**: Keeps the Durable Object focused on chat logic, not queue management.

### Typical Request Flow

```
User sends message
        ↓
Consumer (gateway/web client) calls API
        ↓
    ┌─────────────────┐
    │ Lock available? │
    └────────┬────────┘
             │
      ┌──────┴──────┐
      ↓             ↓
     YES           NO
      ↓             ↓
  Process      Return 429
  request          ↓
      ↓        Consumer waits
  Return       and retries
  response         ↓
             (loop until
              lock available)
```

### Expected Behavior by Client Type

| Client                          | Behavior                                                                                               |
| ------------------------------- | ------------------------------------------------------------------------------------------------------ |
| **bt-servant-web-client**       | Should disable send button while awaiting response, preventing most 429s. Implement retry as fallback. |
| **bt-servant-whatsapp-gateway** | Cannot control WhatsApp UI. Must implement robust retry with exponential backoff.                      |
| **Future API consumers**        | Must implement 429 handling per this documentation.                                                    |

### Lock Timeout

The processing lock has a 90-second stale threshold. If a request crashes without releasing the lock, subsequent requests will succeed after 90 seconds. This is a safety mechanism, not expected behavior. When a stale lock is overwritten, a warning is logged for monitoring.

## Project Structure

```
bt-servant-worker/
├── src/
│   └── index.ts                      # Worker entry point
├── tests/
│   └── index.test.ts                 # Tests
├── docs/
│   └── implementation-plan.md        # Full implementation plan
├── .github/workflows/
│   ├── ci.yml                        # CI: lint, typecheck, test, build
│   ├── deploy.yml                    # Deploy to Cloudflare (after CI passes)
│   └── claude-review.yml             # Claude PR reviews
├── wrangler.toml                     # Cloudflare Worker config
├── package.json                      # Dependencies and scripts
├── tsconfig.json                     # TypeScript config (strict mode)
├── eslint.config.js                  # ESLint with fitness functions
├── .dependency-cruiser.js            # Architecture enforcement
├── .prettierrc                       # Code formatting
└── .husky/pre-commit                 # Pre-commit hooks
```

## API Endpoints

### Phase 0 (Current)

| Endpoint       | Method | Response                          |
| -------------- | ------ | --------------------------------- |
| `/health`      | GET    | `{"status": "healthy"}`           |
| `/api/v1/chat` | POST   | `"BT Servant is alive and well."` |

### Phase 1 (Planned)

| Endpoint       | Method | Description                         |
| -------------- | ------ | ----------------------------------- |
| `/health`      | GET    | Health check                        |
| `/api/v1/chat` | POST   | Full chat with Claude orchestration |

**Request:**

```typescript
interface ChatRequest {
  client_id: string;
  user_id: string;
  message: string;
  message_type: 'text' | 'audio';
  audio_base64?: string;
  audio_format?: string;
}
```

**Response:**

```typescript
interface ChatResponse {
  responses: string[];
  response_language: string;
  voice_audio_base64: string | null;
}
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
curl -X POST http://localhost:8787/api/v1/chat
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

### Option A: GitHub Actions (Automatic)

1. Add secrets to your GitHub repo:
   - `CLOUDFLARE_API_TOKEN`
   - `CLOUDFLARE_ACCOUNT_ID`
   - `ANTHROPIC_API_KEY` (for Claude PR reviews)

2. Push to `main` branch
3. CI runs → if passes → Deploy runs automatically

### Option B: Manual Deploy

```bash
wrangler login      # One-time authentication
wrangler deploy     # Deploy to Cloudflare
```

The worker will be available at: `https://bt-servant-worker.<your-subdomain>.workers.dev`

## Pre-commit Hooks

Every commit runs:

1. **lint-staged** - ESLint + Prettier on staged files
2. **Type check** - `tsc --noEmit`
3. **Architecture check** - dependency-cruiser
4. **Tests** - vitest
5. **Build** - wrangler build

If any check fails, the commit is blocked.

## CI Watcher (Claude Code)

When using Claude Code, a `ci-watcher` subagent automatically monitors GitHub Actions after every push. It reports CI status and helps fix any failures before moving on.

## Implementation Phases

### Phase 0: Barebones Deployment ✅

- Basic Worker with health and chat endpoints
- CI/CD pipeline
- Code quality tooling
- Pre-commit hooks

### Phase 1: Dynamic Code Execution (Planned)

- Durable Objects for per-user state
- QuickJS sandbox for code execution
- MCP tool discovery and orchestration
- Claude API integration
- Chat history storage

See [docs/implementation-plan.md](docs/implementation-plan.md) for the full plan.

## Related Projects

- **bt-servant-engine** - The Python/FastAPI predecessor
- **bt-servant-web-client** - Next.js frontend
- **bt-servant-whatsapp-gateway** - WhatsApp integration
- **lasker-api** - Reference for dynamic code execution pattern

## License

Private
