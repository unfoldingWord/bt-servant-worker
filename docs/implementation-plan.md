# bt-servant-worker Implementation Plan

## Overview

Build a Cloudflare Worker that evolves bt-servant-engine into a modern, edge-deployed architecture with QuickJS-based sandboxed code execution for dynamic MCP tool orchestration.

**Key Innovation:** Replace `isolated-vm` (Node.js native addon) with QuickJS compiled to WASM, enabling secure code execution at the edge while maintaining the Claude orchestration pattern from lasker-api.

---

## Phase 0: Barebones Deployment

### Goal

Deploy a minimal Cloudflare Worker with `/api/v1/chat` returning "BT Servant is alive and well."

### Files to Create

1. **wrangler.toml** - Cloudflare Worker configuration
2. **package.json** - Dependencies and scripts
3. **tsconfig.json** - TypeScript configuration
4. **src/index.ts** - Worker entry point with basic routing

### Implementation

```
src/
├── index.ts          # fetch handler, route to /health and /api/v1/chat
```

**Endpoints:**

- `GET /health` → `{ "status": "healthy" }`
- `POST /api/v1/chat` → `"BT Servant is alive and well."`

### Additional Phase 0 Setup: Fitness Functions, Pre-commit, CI/CD

#### Fitness Functions (ESLint + dependency-cruiser from lasker-api)

**ESLint rules:**

```javascript
// eslint.config.js
{
  rules: {
    // Code quality limits
    'max-lines-per-function': ['error', { max: 50, skipBlankLines: true, skipComments: true }],
    'max-statements': ['error', 25],
    'complexity': ['error', 10],           // Cyclomatic complexity
    'max-depth': ['error', 4],             // Nested blocks
    'max-nested-callbacks': ['error', 3],
    'max-params': ['error', 5],

    // Security
    'no-eval': 'error',
    'no-implied-eval': 'error',
    'no-new-func': 'error',

    // Console
    'no-console': ['warn', { allow: ['warn', 'error'] }]
  }
}
```

**Dependency-cruiser (circular deps + architecture):**

```javascript
// .dependency-cruiser.js
{
  forbidden: [
    // No circular dependencies
    { name: 'no-circular', from: {}, to: { circular: true } },

    // Onion architecture (adapted for our structure)
    // routes/ → can import services/, types/, utils/
    // services/ → can import other services/, types/, utils/
    // durable-objects/ → can import services/, types/
    // types/ → no internal dependencies
    {
      name: 'types-no-deps',
      from: { path: '^src/types' },
      to: { path: '^src/(routes|services|durable-objects)' },
    },
  ];
}
```

**Architecture layers for bt-servant-worker:**

```
routes/           → HTTP handlers (can import: services, types)
durable-objects/  → User session logic (can import: services, types)
services/
  ├── claude/     → Claude orchestration
  ├── mcp/        → MCP discovery & registry
  └── code-execution/ → QuickJS sandbox
types/            → Domain types (no dependencies)
```

#### Pre-commit Hooks (Husky + lint-staged)

```bash
# .husky/pre-commit
#!/usr/bin/env sh

echo "Running lint-staged..."
npx lint-staged

echo "Running type checks..."
pnpm run check

echo "Running architecture check..."
npx depcruise --config .dependency-cruiser.js src

echo "Running tests..."
pnpm run test

echo "Running build..."
pnpm run build
```

**CRITICAL**: Claude MUST NOT commit if pre-commit fails. Loop until fixed.

#### CI/CD: GitHub Actions

**.github/workflows/ci.yml** - Runs on push/PR to main:

```yaml
jobs:
  lint: # Prettier + ESLint
  typecheck: # tsc --noEmit
  architecture: # dependency-cruiser (circular deps, layer violations)
  test: # vitest
  build: # wrangler build (verify no errors)
```

**.github/workflows/deploy.yml** - Deploys to Cloudflare on main push:

```yaml
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: cloudflare/wrangler-action@v3
        with:
          apiToken: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          accountId: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
```

#### Claude GitHub Action for PR Reviews

**.github/workflows/claude-review.yml**:

```yaml
name: Claude PR Review

on:
  pull_request:
    types: [opened, synchronize]
  issue_comment:
    types: [created]

jobs:
  review:
    if: github.event_name == 'pull_request' || contains(github.event.comment.body, '@claude')
    runs-on: ubuntu-latest
    steps:
      - uses: anthropics/claude-code-action@v1
        with:
          anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
```

This enables:

- Automatic PR review on open/update
- Interactive `@claude` mentions in comments
- Code analysis and suggestions

**Sources:**

- [Claude Code Action](https://github.com/anthropics/claude-code-action)
- [Claude Code Security Review](https://github.com/anthropics/claude-code-security-review)

#### Files to Create in Phase 0

| File                                  | Purpose                       |
| ------------------------------------- | ----------------------------- |
| `wrangler.toml`                       | Cloudflare Worker config      |
| `package.json`                        | Dependencies, scripts         |
| `tsconfig.json`                       | TypeScript config             |
| `eslint.config.js`                    | ESLint with fitness functions |
| `.prettierrc`                         | Prettier config               |
| `.husky/pre-commit`                   | Pre-commit hook               |
| `.github/workflows/ci.yml`            | CI pipeline                   |
| `.github/workflows/deploy.yml`        | Deploy to Cloudflare          |
| `.github/workflows/claude-review.yml` | Claude PR reviews             |
| `src/index.ts`                        | Worker entry point            |

### Verification

```bash
pnpm install
pnpm dev              # Local development
curl http://localhost:8787/api/v1/chat -X POST
wrangler deploy       # Deploy to Cloudflare
```

---

## Phase 1: Dynamic Code Execution with QuickJS

### Goal

Implement Claude-orchestrated MCP tool calls using QuickJS for sandboxed code execution, with MCP server registry in Durable Object storage.

### Architecture

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
│           │                                         │           │
│           └─────────────────┬───────────────────────┘           │
│                             ▼                                   │
│                    ┌─────────────────┐                          │
│                    │ MCP Server(s)   │                          │
│                    │ (external)      │                          │
│                    └─────────────────┘                          │
└─────────────────────────────────────────────────────────────────┘
```

### Project Structure

```
bt-servant-worker/
├── wrangler.toml
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts                      # Worker entry, routing to DO
│   ├── config/
│   │   └── types.ts                  # Env bindings interface
│   ├── durable-objects/
│   │   └── user-session.ts           # Per-user serialization + chat logic
│   ├── services/
│   │   ├── claude/
│   │   │   ├── orchestrator.ts       # Main orchestration loop
│   │   │   ├── system-prompt.ts      # System prompt builder
│   │   │   └── tools.ts              # Tool definitions for Claude
│   │   ├── code-execution/
│   │   │   ├── quickjs-executor.ts   # QuickJS WASM sandbox
│   │   │   └── types.ts              # Execution types
│   │   └── mcp/
│   │       ├── registry.ts           # KV-backed server configs
│   │       ├── discovery.ts          # Tool discovery
│   │       └── catalog.ts            # Catalog generation
│   ├── types/
│   │   └── engine.ts                 # API contract (match web-client)
│   └── utils/
│       └── errors.ts                 # Error classes
└── tests/
```

### Critical Files

| File                                              | Purpose                                  | Pattern From                                                      |
| ------------------------------------------------- | ---------------------------------------- | ----------------------------------------------------------------- |
| `src/durable-objects/user-session.ts`             | Per-user serialization, main chat logic  | New (replaces `asyncio.Lock`)                                     |
| `src/services/code-execution/quickjs-executor.ts` | QuickJS sandbox replacing isolated-vm    | `lasker-api/src/services/code-execution/local-executor.ts`        |
| `src/services/mcp/discovery.ts`                   | Dynamic tool discovery from MCP servers  | New, based on MCP protocol                                        |
| `src/services/claude/orchestrator.ts`             | Claude loop with parallel tool execution | `lasker-api/src/services/claude.service.ts`                       |
| `src/types/engine.ts`                             | API contract types                       | `bt-servant-web-client/src/types/engine.ts` (minus intent fields) |
| `src/index.ts`                                    | Worker entry, routes to Durable Object   | New                                                               |

### API Contract (UPDATED - removing intent system)

**Request:**

```typescript
interface ChatRequest {
  client_id: string;
  user_id: string;
  message: string;
  message_type: 'text' | 'audio';
  audio_base64?: string;
  audio_format?: string;
  progress_callback_url?: string;
  progress_throttle_seconds?: number;
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

### Streaming Endpoint (SSE)

In addition to the standard `/api/v1/chat` endpoint, support a streaming endpoint for real-time response delivery.

**Endpoint:** `POST /api/v1/chat/stream`

**Response:** Server-Sent Events (SSE) with `Content-Type: text/event-stream`

```typescript
// SSE Headers
{
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache',
  'Connection': 'keep-alive'
}
```

**SSE Event Types:**

| Event         | Purpose                                 | Payload                                                  |
| ------------- | --------------------------------------- | -------------------------------------------------------- |
| `status`      | Processing status messages              | `{ type: 'status', message: string }`                    |
| `progress`    | Streaming text chunks as they arrive    | `{ type: 'progress', text: string }`                     |
| `complete`    | Final response when finished            | `{ type: 'complete', response: ChatResponse }`           |
| `error`       | Error messages                          | `{ type: 'error', error: string }`                       |
| `tool_use`    | Tool invocation (debug mode only)       | `{ type: 'tool_use', tool: string, input: unknown }`     |
| `tool_result` | Tool execution result (debug mode only) | `{ type: 'tool_result', tool: string, result: unknown }` |

**SSE Event Format:**

```typescript
function formatSSEEvent(data: object): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}
```

**Streaming Callback Interface:**

```typescript
interface StreamCallbacks {
  onStatus: (message: string) => void;
  onProgress: (text: string) => void;
  onComplete: (response: ChatResponse) => void;
  onError: (error: string) => void;
  onToolUse?: (toolName: string, input: unknown) => void;
  onToolResult?: (toolName: string, result: unknown) => void;
}
```

**Implementation Notes:**

- Uses Anthropic SDK's `messages.stream()` for token-by-token delivery
- Each `content_block_delta` event with `text_delta` triggers `onProgress()`
- Tool uses are collected and executed between agentic iterations
- Stream continues across multiple Claude calls during tool execution
- Debug events (`tool_use`, `tool_result`) controlled by `SSE_DEBUG_EVENTS` env var

**Reference:** See `lasker-api/src/services/claude.service.ts` for streaming implementation pattern.

### Client Updates Required

| Project                     | File                                         | Change                                                              |
| --------------------------- | -------------------------------------------- | ------------------------------------------------------------------- |
| bt-servant-web-client       | `src/types/engine.ts`                        | Remove `intent_processed`, `has_queued_intents` from `ChatResponse` |
| bt-servant-web-client       | Any UI using these fields                    | Remove references                                                   |
| bt-servant-web-client       | Chat component                               | Add SSE streaming support for `/api/v1/chat/stream` endpoint        |
| bt-servant-whatsapp-gateway | `whatsapp_gateway/services/engine_client.py` | Update response type (remove intent fields)                         |

### bt-servant-whatsapp-gateway Compatibility

The gateway is a **thin relay** - it forwards requests to the engine and relays responses back to WhatsApp. Mostly compatible as-is:

**What works unchanged:**

- Request format (`ChatRequest`) - identical
- Auth pattern (Bearer token) - identical
- Progress callbacks - identical
- Audio handling - identical
- Message chunking - works on `responses[]` array

**What needs updating:**

- Response type definition - remove `intent_processed`, `has_queued_intents`
- Any logging/metrics that reference these fields

### Storage: All in Durable Objects (no KV needed)

| Data                | Storage        | Why                         |
| ------------------- | -------------- | --------------------------- |
| MCP server registry | **DO Storage** | Org/user-specific config    |
| Chat history        | **DO Storage** | Per-user, needs consistency |
| User preferences    | **DO Storage** | Per-user, needs consistency |

**No KV namespaces needed** - all persistent data lives in Durable Object storage.

**MCP Registry in DO Storage:**

```typescript
// In UserSession DO
async getMCPServers(): Promise<MCPServerConfig[]> {
  // Could be org-level (shared DO) or user-level
  const servers = await this.state.storage.get<MCPServerConfig[]>('mcp_servers');
  return servers ?? DEFAULT_MCP_SERVERS;
}

async updateMCPServers(servers: MCPServerConfig[]): Promise<void> {
  await this.state.storage.put('mcp_servers', servers);
}
```

**Future: Org-level DO**
If MCP registry needs to be shared across users in an org, we can create a separate `OrgConfig` Durable Object class keyed by `org_id`.

### MCP Registry Schema

```typescript
interface MCPServerConfig {
  id: string;
  name: string;
  url: string;
  authToken?: string;
  enabled: boolean;
  priority: number;
  allowedTools?: string[]; // Whitelist
}
```

### QuickJS Security Model

```
┌─────────────────────────────────────────────────────────────┐
│  QuickJS WASM Sandbox                                       │
│                                                             │
│  globalThis:                                                │
│    ├── console.log/warn/error/info  (captured to logs)     │
│    ├── fetch_scripture(args)        (calls host function)  │
│    ├── fetch_translation_notes(...) (calls host function)  │
│    └── ... (one function per MCP tool)                     │
│                                                             │
│  NOT available:                                             │
│    ├── fetch         (doesn't exist)                        │
│    ├── globalThis.env (doesn't exist)                       │
│    └── any Worker APIs (doesn't exist)                      │
└─────────────────────────────────────────────────────────────┘
```

### Claude Tools

| Tool                   | Purpose                                                   |
| ---------------------- | --------------------------------------------------------- |
| `execute_code`         | Run JS in QuickJS sandbox, orchestrate multiple MCP calls |
| `get_tool_definitions` | Get full schemas for MCP tools before using them          |
| `<mcp_tool_name>`      | Direct call to MCP tool (for simple single-tool queries)  |

---

## Cloudflare Workers vs FastAPI: Concurrency Model

### FastAPI (current bt-servant-engine)

```python
# In-memory per-user lock - works because single process
user_locks: DefaultDict[str, asyncio.Lock] = defaultdict(asyncio.Lock)

async def process_message(user_message):
    async with user_locks[user_message.user_id]:  # Serializes per user
        await _process_with_brain(context)
```

- **Single process** with in-memory state
- `asyncio.Lock` per user ensures one message processed at a time per user
- If user sends 2 messages quickly, second waits for first to complete
- **Problem**: Doesn't scale horizontally (multiple instances = multiple lock sets)

### Cloudflare Workers (new architecture)

```
Request 1 ──▶ ┌─────────────┐
              │  V8 Isolate │ ──▶ Process
Request 2 ──▶ │  (Worker)   │ ──▶ Process (concurrent!)
              └─────────────┘
```

- **Isolate-based**: Each request gets execution context
- **No shared memory**: Can't use in-memory locks
- **Requests run concurrently**: Two requests for same user CAN overlap
- **Stateless by design**: No `user_locks` dictionary persists

### User Serialization Options for Workers

| Option                            | Pros                          | Cons                      |
| --------------------------------- | ----------------------------- | ------------------------- |
| **No locking**                    | Simple, fast                  | Race conditions possible  |
| **Durable Objects**               | Native CF, strong consistency | More complex, cost        |
| **External lock (Redis/Upstash)** | Works, familiar               | Extra latency, dependency |
| **Optimistic (last-write-wins)**  | Simple                        | May lose data             |

### Decision: Use Durable Objects for User Serialization

Durable Objects provide per-user request serialization - only one request per user processes at a time, matching bt-servant-engine's `asyncio.Lock` behavior.

**How it works:**

```typescript
// src/durable-objects/user-session.ts
export class UserSession implements DurableObject {
  constructor(
    private state: DurableObjectState,
    private env: Env
  ) {}

  async fetch(request: Request): Promise<Response> {
    // Durable Objects guarantee single-threaded execution per instance
    // Only one request for this user_id runs at a time
    const body = (await request.json()) as ChatRequest;

    // Process the chat request
    const response = await this.processChat(body);

    return new Response(JSON.stringify(response), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private async processChat(request: ChatRequest): Promise<ChatResponse> {
    // MCP discovery, Claude orchestration, etc.
  }
}
```

**Worker routes to DO by user_id:**

```typescript
// src/index.ts
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (url.pathname === '/api/v1/chat') {
      const body = (await request.clone().json()) as ChatRequest;

      // Get DO stub for this user
      const id = env.USER_SESSION.idFromName(body.user_id);
      const stub = env.USER_SESSION.get(id);

      // Forward request to DO - serialized per user
      return stub.fetch(request);
    }
  },
};
```

**wrangler.toml addition:**

```toml
[[durable_objects.bindings]]
name = "USER_SESSION"
class_name = "UserSession"

[[migrations]]
tag = "v1"
new_classes = ["UserSession"]
```

**Benefits:**

- Matches existing bt-servant-engine behavior
- Native Cloudflare solution, no external dependencies
- Automatic scaling - one DO instance per active user
- Stores user state (history, preferences) in DO storage

**DO Lifecycle:**

```
┌─────────────────────────────────────────────────────────────────────┐
│  Durable Object Instance: UserSession("alice@example.com")          │
│                                                                     │
│  CREATED: First request for this user_id (anywhere in the world)   │
│                                                                     │
│  LIVES: Handles ALL requests for alice@example.com globally        │
│         (not tied to a specific Worker instance or region)         │
│                                                                     │
│  EVICTED: After idle period (Cloudflare decides, ~30s-minutes)     │
│           Memory cleared, but STORAGE PERSISTS                     │
│                                                                     │
│  RE-ACTIVATED: Next request recreates instance, loads storage      │
│                                                                     │
│  STORAGE: Persists FOREVER until explicitly deleted                │
│           (chat history, preferences survive eviction)             │
└─────────────────────────────────────────────────────────────────────┘
```

**What happens when user sends two messages back-to-back?**

```
Message 1 ──▶ ┌──────────────────────────────┐
              │  UserSession DO (user_id=X)  │
              │                              │
              │  [Processing Message 1...]   │ ◀── Only one at a time
              │                              │
Message 2 ──▶ │  [QUEUED - waiting...]       │ ◀── NOT lost, just waiting
              └──────────────────────────────┘
                        │
                        ▼ (Message 1 completes)
              ┌──────────────────────────────┐
              │  [Processing Message 2...]   │
              └──────────────────────────────┘
```

- DO guarantees **single-threaded execution** per instance
- Second request **waits** (queued by Cloudflare) until first completes
- **No messages are lost** - they queue automatically
- This matches `asyncio.Lock` behavior in bt-servant-engine

---

## Chat History Storage

### Current (bt-servant-engine)

- **Storage**: TinyDB (JSON file at `/data/db.json`)
- **Max history**: 5 messages per user
- **Fields stored per user**:
  - `history` - array of `{user_message, assistant_response}`
  - `response_language` - preferred language
  - `agentic_strength` - normal/low/very_low
  - `dev_agentic_mcp` - boolean flag
  - `first_interaction` - boolean

### New (bt-servant-worker)

**Use Durable Object storage** - each DO instance has SQLite-backed storage.

```typescript
// src/durable-objects/user-session.ts
export class UserSession implements DurableObject {
  constructor(
    private state: DurableObjectState,
    private env: Env
  ) {}

  async fetch(request: Request): Promise<Response> {
    // Get chat history from DO storage
    const history = (await this.state.storage.get<ChatHistoryEntry[]>('history')) ?? [];

    // Process message...
    const response = await this.processChat(body, history);

    // Update chat history (keep last 5)
    history.push({ user_message: body.message, assistant_response: response.responses.join('\n') });
    await this.state.storage.put('history', history.slice(-5));

    return new Response(JSON.stringify(response));
  }
}
```

**Why DO storage instead of KV?**

- DO storage is **strongly consistent** (KV is eventually consistent)
- No extra latency - storage is local to DO instance
- Transactional - can update multiple values atomically
- Already using DO for request serialization

---

## Worker Limits & Constraints

### Good News: Wall-Clock Time is FREE

Cloudflare bills for **CPU time**, not wall-clock time. Waiting for external APIs (Claude, MCP) costs nothing!

| Activity              | CPU Time | Wall Time | Billed? |
| --------------------- | -------- | --------- | ------- |
| Claude API call (30s) | ~0ms     | 30s       | **No**  |
| MCP fetch call (2s)   | ~0ms     | 2s        | **No**  |
| QuickJS execution     | 50ms     | 50ms      | **Yes** |
| JSON parsing          | 5ms      | 5ms       | **Yes** |

### Cloudflare Worker Limits (Paid Plan)

| Resource        | Limit                            | Concern?                    |
| --------------- | -------------------------------- | --------------------------- |
| CPU time        | 30s default, **up to 5 minutes** | OK (can increase)           |
| Wall-clock time | **No limit**                     | OK (I/O wait is free)       |
| Memory          | 128 MB                           | Monitor QuickJS + responses |
| Subrequests     | 1000 per request                 | OK                          |

### Durable Object Limits (Paid Plan)

| Resource            | Limit              | Concern?            |
| ------------------- | ------------------ | ------------------- |
| CPU time            | Same as Worker     | OK                  |
| Wall-clock time     | **No limit**       | OK                  |
| Memory              | 128 MB             | Monitor             |
| Storage             | Unlimited (billed) | OK                  |
| Concurrent requests | 1 (serialized)     | That's what we want |

### Cost Estimate

| Resource        | Pricing          | Typical Usage         |
| --------------- | ---------------- | --------------------- |
| Worker requests | $0.30/million    | Minimal               |
| DO requests     | $0.15/million    | Minimal               |
| DO storage      | $0.20/GB-month   | <1GB                  |
| CPU time        | $0.02/million ms | ~50ms/request = cheap |

For a Bible translation assistant with moderate usage, expect **$5-20/month**.

---

## Cloudflare Hierarchy (for context)

```
CLOUDFLARE ACCOUNT (yours)
    │
    └── WORKERS SERVICE: "bt-servant-worker"
        │   (Your deployed code - lives forever until deleted)
        │
        └── Durable Object Class: UserSession
            │
            └── DO Instances (one per user_id)
                ├── alice@example.com → UserSession instance + storage
                ├── bob@example.com → UserSession instance + storage
                └── ...
```

---

## Observability & Logging

Cloudflare provides built-in observability (no external tools needed).

### Logging Approach

Use native `console.log` with structured JSON - no external library needed:

- Workers Logs automatically parses and indexes JSON fields
- Include correlation ID (`request_id`) in all logs for request tracing
- JSON format enables powerful queries in the Cloudflare dashboard

### Cloudflare Observability Features

#### Workers Logs (GA)

- **Enable**: `observability = { enabled = true }` in wrangler.toml
- **Retention**: 7 days
- **Includes**: Invocation logs, custom logs (console.log), errors, exceptions
- **Dashboard**: Query logs across all Workers
- **Free** on both Free and Paid plans

#### Workers Tracing (Beta)

- **Enable**: `observability.traces.enabled = true` in wrangler.toml
- **What**: OpenTelemetry-compliant spans showing timing for every operation
- **View**: Trace waterfall in Cloudflare dashboard
- **Export**: Compatible with Honeycomb, Grafana Cloud, Axiom

#### Query Builder

- Write SQL-like queries against your logs
- Filter by user_id, request path, errors, etc.
- Create visualizations and save queries

### Log Levels

Use console methods for log levels:

```typescript
console.log(); // INFO - normal operations
console.info(); // INFO - same as log
console.warn(); // WARN - recoverable issues
console.error(); // ERROR - failures, exceptions
console.debug(); // DEBUG - verbose (filtered in production)
```

### Events to Log

| Event                     | Level | When                                | Fields                                                       |
| ------------------------- | ----- | ----------------------------------- | ------------------------------------------------------------ |
| `request_received`        | INFO  | Request enters Worker               | `request_id`, `user_id`, `client_id`, `path`                 |
| `do_routed`               | INFO  | Request forwarded to Durable Object | `request_id`, `do_id`                                        |
| `mcp_discovery_start`     | INFO  | Starting MCP tool discovery         | `request_id`, `server_count`                                 |
| `mcp_discovery_complete`  | INFO  | Discovery finished                  | `request_id`, `tools_found`, `duration_ms`                   |
| `mcp_discovery_error`     | ERROR | Discovery failed                    | `request_id`, `server_url`, `error`                          |
| `claude_request`          | INFO  | Calling Claude API                  | `request_id`, `iteration`, `message_count`                   |
| `claude_response`         | INFO  | Claude responded                    | `request_id`, `iteration`, `tool_calls_count`, `duration_ms` |
| `claude_error`            | ERROR | Claude API error                    | `request_id`, `error`, `status_code`                         |
| `tool_execution_start`    | INFO  | Starting tool execution             | `request_id`, `tool_name`, `iteration`                       |
| `tool_execution_complete` | INFO  | Tool finished                       | `request_id`, `tool_name`, `duration_ms`, `success`          |
| `tool_execution_error`    | ERROR | Tool failed                         | `request_id`, `tool_name`, `error`                           |
| `code_execution_start`    | INFO  | QuickJS sandbox starting            | `request_id`, `code_length`                                  |
| `code_execution_complete` | INFO  | QuickJS finished                    | `request_id`, `duration_ms`, `console_logs_count`            |
| `code_execution_error`    | ERROR | QuickJS error                       | `request_id`, `error`, `line_number`                         |
| `request_complete`        | INFO  | Request finished                    | `request_id`, `duration_ms`, `iterations`, `status`          |
| `request_error`           | ERROR | Unhandled error                     | `request_id`, `error`, `stack`                               |

### Structured Log Format

```typescript
interface LogEntry {
  event: string; // Event name from table above
  request_id: string; // Correlation ID (UUID)
  timestamp: number; // Date.now()
  user_id?: string; // When available
  // ... event-specific fields
}

// Helper function
function log(entry: LogEntry): void {
  console.log(JSON.stringify(entry));
}

function logError(entry: LogEntry & { error: string; stack?: string }): void {
  console.error(JSON.stringify(entry));
}
```

### Example: Tracing a Request

```typescript
// Generate correlation ID at request entry
const requestId = crypto.randomUUID();

// Log request received
console.log(
  JSON.stringify({
    event: 'request_received',
    request_id: requestId,
    user_id: body.user_id,
    client_id: body.client_id,
    path: '/api/v1/chat',
    timestamp: Date.now(),
  })
);

// Log MCP discovery
console.log(
  JSON.stringify({
    event: 'mcp_discovery_complete',
    request_id: requestId,
    tools_found: manifest.tools.length,
    duration_ms: Date.now() - startTime,
    timestamp: Date.now(),
  })
);

// Log Claude iteration
console.log(
  JSON.stringify({
    event: 'claude_response',
    request_id: requestId,
    iteration: 1,
    tool_calls_count: response.tool_calls?.length ?? 0,
    duration_ms: Date.now() - claudeStartTime,
    timestamp: Date.now(),
  })
);
```

Then in the Cloudflare dashboard, query by `request_id` to see the full trace.

### Error Handling & Logging

- Wrap all async operations in try/catch
- Log errors with full context before re-throwing or returning error response
- Include stack traces for unexpected errors
- **Sanitize sensitive data**: Never log API keys, auth tokens, or full message content

```typescript
try {
  const result = await claudeClient.messages.create(params);
} catch (error) {
  console.error(
    JSON.stringify({
      event: 'claude_error',
      request_id: requestId,
      error: error instanceof Error ? error.message : 'Unknown error',
      status_code: error?.status,
      timestamp: Date.now(),
    })
  );
  throw error;
}
```

### wrangler.toml Configuration

```toml
[observability]
enabled = true
head_sampling_rate = 1  # Log 100% of requests (adjust for high traffic)
```

**Sources:**

- [Workers Observability](https://developers.cloudflare.com/workers/observability/)
- [Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/)
- [Workers Tracing](https://developers.cloudflare.com/workers/observability/traces/)

---

### Orchestration Loop

1. Build system prompt with tool catalog
2. Send user message to Claude
3. Loop (max 10 iterations):
   - If Claude returns text only → done
   - If Claude uses tools → execute in parallel
   - Append tool results to messages
   - Continue
4. Return final response

### Environment Variables

```toml
[vars]
ENVIRONMENT = "development"
MAX_ORCHESTRATION_ITERATIONS = "10"
CODE_EXEC_TIMEOUT_MS = "5000"

# Secrets (via wrangler secret put)
# ANTHROPIC_API_KEY
# ENGINE_API_KEY
```

---

## Verification

### Phase 0

```bash
# Local
pnpm dev
curl -X POST http://localhost:8787/api/v1/chat
# Should return: "BT Servant is alive and well."

# Deployed
wrangler deploy
curl -X POST https://bt-servant-worker.<account>.workers.dev/api/v1/chat
```

### Phase 1

```bash
# 1. Set up secrets
wrangler secret put ANTHROPIC_API_KEY
wrangler secret put ENGINE_API_KEY

# 2. Deploy (creates Durable Object migration)
wrangler deploy

# 3. Test locally (MCP registry will use defaults or be seeded via admin endpoint)
wrangler dev
curl -X POST http://localhost:8787/api/v1/chat \
  -H "Authorization: Bearer <key>" \
  -H "Content-Type: application/json" \
  -d '{"client_id":"test","user_id":"test@example.com","message":"Help me understand John 3:16","message_type":"text"}'

# 4. Test streaming endpoint
curl -X POST http://localhost:8787/api/v1/chat/stream \
  -H "Authorization: Bearer <key>" \
  -H "Content-Type: application/json" \
  -H "Accept: text/event-stream" \
  -d '{"client_id":"test","user_id":"test@example.com","message":"Help me understand John 3:16","message_type":"text"}'
# Should see SSE events: status, progress (multiple), complete

# 5. Test with web client
# Update bt-servant-web-client ENGINE_BASE_URL to worker URL
# Send a translation help query
```

**Note:** MCP registry is stored in DO storage, seeded with defaults on first access. Can add admin endpoints later to configure MCP servers per user/org.

---

## Key Architectural Shift

**The entire intent detection system from bt-servant-engine is being replaced.**

| bt-servant-engine (old)    | bt-servant-worker (new)      |
| -------------------------- | ---------------------------- |
| 16 hardcoded intent types  | No explicit intents          |
| LangGraph intent routing   | Claude decides dynamically   |
| Intent classification step | Emergent from tool selection |
| Rigid orchestration paths  | Flexible agentic flow        |

Claude sees the user message + tool catalog and naturally determines which MCP tools to call. Intent is implicit in tool selection, not a separate classification step.

**API change:** Remove `intent_processed` and `has_queued_intents` from response - they're artifacts of the old system. Update web-client and whatsapp-gateway accordingly.

---

## Phase 1 Scope Decisions

| Feature            | Decision    | Rationale                                             |
| ------------------ | ----------- | ----------------------------------------------------- |
| Streaming (SSE)    | **Include** | Real-time response delivery via `/api/v1/chat/stream` |
| Progress callbacks | Skip        | Streaming replaces the need for webhooks              |
| Audio/TTS          | Skip        | Return `voice_audio_base64: null`                     |
| Intent system      | None        | Fully agentic - Claude decides                        |

---

## Open Questions

1. **QuickJS package**: Need to verify which QuickJS WASM package works best with Cloudflare Workers (`quickjs-emscripten` or alternatives).
