# User Persisted Memory — Implementation Plan

## Context

Conversation history uses a sliding window (default 5 turns for LLM context). Important state — like UTC phase completion for a passage — falls out of context after enough turns. Users then get asked to redo work they've already completed.

**User persisted memory** solves this: a schema-free markdown document per user, stored in the Durable Object, that Claude can read and write via tools. The memory persists across sessions indefinitely.

**Key design decisions:**

- **Schema-free markdown** — the prompt overrides (especially `methodology`) control what Claude tracks. Swap the methodology slot to a different teaching framework and Claude naturally tracks different things. No code changes needed.
- **Progressive disclosure** (Pattern B) — a deterministic TOC (extracted from markdown headers) is always injected into the system prompt. Claude calls tools to read/write specific sections. This keeps per-request token cost low while allowing large total memory.
- **Loose coupling** — a clean `UserMemoryStore` interface abstracts storage. v1 is markdown in DO storage. Future: graph DB, vector store, etc. The orchestrator only talks to the interface.
- **128KB storage cap** — negligible Cloudflare cost (~$2.50/month at 100K users). Section-level updates keep output token costs manageable.
- **Extensive logging** on all memory operations.

---

## Architecture

### Memory Flow

```
User sends message
  ↓
DO loads memory from storage
  ↓
System extracts TOC from markdown headers (deterministic, no LLM)
  ↓
TOC injected into system prompt via memory_instructions slot framing
  ↓
Claude sees TOC, decides if it needs details
  ├─ Calls read_memory(sections?) → gets specific sections or full doc
  ├─ Calls execute_code → fetches MCP data as usual
  └─ Calls update_memory(sections) → creates/updates/deletes sections
  ↓
Memory saved back to DO storage
  ↓
Claude responds to user
```

### System Prompt Assembly (updated)

```
[identity]
[methodology]
[tool_guidance]
[tool catalog]
[instructions]
[memory_instructions]   ← NEW slot (overridable framing for memory section)
[memory TOC]            ← auto-generated from markdown headers (NOT a slot)
[user preferences]
[conversation context]
[first interaction]
[closing]
```

### Tool Definitions

**`read_memory`** — standalone Anthropic tool

```
read_memory(sections?: string[])
  → no args: returns full memory document
  → with sections: returns only those named sections
  → returns: { content: string, total_size_bytes: number } or { sections: {name: content}, total_size_bytes }
```

**`update_memory`** — standalone Anthropic tool

```
update_memory(sections: { [section_name]: string | null })
  → string value: create or replace that section
  → null value: delete that section
  → multiple entries: batch operation in one call
  → returns: { updated: string[], deleted: string[], total_size_bytes: number }
```

### Data Model

```typescript
// src/services/memory/types.ts

export const MAX_MEMORY_SIZE_BYTES = 131072; // 128KB
export const MEMORY_STORAGE_KEY = 'user_memory';

export interface MemorySection {
  name: string;
  level: number; // heading level (2 for ##, 3 for ###, etc.)
  content: string; // full section content including sub-headings
  sizeBytes: number;
}

export interface MemoryDocument {
  preamble: string; // text before first section header
  sections: MemorySection[];
}

export interface MemoryTOCEntry {
  name: string;
  level: number;
  sizeBytes: number;
}

export interface MemoryTOC {
  entries: MemoryTOCEntry[];
  totalSizeBytes: number;
  maxSizeBytes: number;
}
```

### UserMemoryStore Interface

```typescript
// src/services/memory/store.ts

export interface UserMemoryStore {
  /** Read full memory or specific sections */
  read(sections?: string[]): Promise<string | Record<string, string>>;

  /** Create/update sections (string) or delete them (null) */
  writeSections(updates: Record<string, string | null>): Promise<{
    updated: string[];
    deleted: string[];
    totalSizeBytes: number;
  }>;

  /** Extract table of contents from current memory */
  getTableOfContents(): Promise<MemoryTOC>;

  /** Clear all memory */
  clear(): Promise<void>;

  /** Get raw memory size in bytes */
  getSizeBytes(): Promise<number>;
}
```

v1 implementation: `MarkdownMemoryStore` backed by DO `this.state.storage`.

### New Prompt Slot: `memory_instructions`

Added as 6th slot in `PROMPT_OVERRIDE_SLOTS`. Default value:

```
## User Memory

Below is a table of contents of this user's persistent memory. Use the
read_memory tool to retrieve specific sections when needed for context.
Use the update_memory tool to save important information that should
persist across conversations — such as progress through teaching
frameworks, user preferences discovered through interaction, and
key decisions made during translation work.

Keep memory organized with clear section names. Remove outdated
information when updating. Be concise — store conclusions and
decisions, not full conversation transcripts.
```

Orgs override this slot to customize what Claude tracks (e.g., UTC-specific instructions).

---

## Files to Create

### 1. `src/services/memory/types.ts`

- `MemorySection`, `MemoryDocument`, `MemoryTOCEntry`, `MemoryTOC` interfaces
- `MAX_MEMORY_SIZE_BYTES` constant (128KB)
- `MEMORY_STORAGE_KEY` constant

### 2. `src/services/memory/parser.ts`

- `parseMemoryDocument(markdown: string): MemoryDocument` — split markdown into preamble + sections by `##` headers
- `serializeDocument(doc: MemoryDocument): string` — reassemble markdown from document model
- `extractTOC(doc: MemoryDocument): MemoryTOC` — extract headers with sizes
- `formatTOCForPrompt(toc: MemoryTOC): string` — render TOC as readable text for system prompt
- `getSection(doc: MemoryDocument, name: string): string | null`
- `updateSection(doc: MemoryDocument, name: string, content: string): MemoryDocument`
- `deleteSection(doc: MemoryDocument, name: string): MemoryDocument`
- All operations are pure functions on the document model

### 3. `src/services/memory/store.ts`

- `UserMemoryStore` interface (as above)
- `MarkdownMemoryStore` class implementing the interface
  - Constructor takes `DurableObjectStorage` and `RequestLogger`
  - Reads/writes raw markdown string from DO storage key `user_memory`
  - Uses parser functions for section operations
  - Validates total size against `MAX_MEMORY_SIZE_BYTES` on write
  - Extensive logging on all operations

### 4. `src/services/memory/index.ts`

- Barrel export

### 5. `tests/unit/memory-parser.test.ts`

- Parse empty document, single section, multiple sections, nested headers
- Serialize round-trip (parse → serialize = original)
- TOC extraction with correct sizes
- Section CRUD: get, update (existing), update (new), delete
- Edge cases: no sections (preamble only), duplicate header names, very long sections
- Format TOC for prompt

### 6. `tests/unit/memory-store.test.ts`

- Read empty memory (returns empty string)
- Read full memory
- Read specific sections
- Write new sections
- Update existing sections
- Delete sections (null value)
- Batch operations (multiple updates + deletes in one call)
- Size limit enforcement (reject writes that exceed 128KB)
- Clear memory
- Logging verification

---

## Files to Modify

### 7. `src/types/prompt-overrides.ts`

- Add `'memory_instructions'` to `PROMPT_OVERRIDE_SLOTS` array
- Add `memory_instructions?: string | null` to `PromptOverrides` interface
- Add `memory_instructions` entry to `DEFAULT_PROMPT_VALUES`

### 8. `src/services/claude/tools.ts`

- Add `buildReadMemoryTool(): Anthropic.Tool` — tool definition with `sections` optional array param
- Add `buildUpdateMemoryTool(): Anthropic.Tool` — tool definition with `sections` object param (string | null values)
- Update `buildAllTools()` to include memory tools
- Add input type guards: `isReadMemoryInput()`, `isUpdateMemoryInput()`

### 9. `src/services/claude/orchestrator.ts`

- Add `memoryStore?: UserMemoryStore` to `OrchestratorOptions`
- Add `memoryStore` to `OrchestrationContext`
- Add dispatch cases in `dispatchToolCall()`:
  - `read_memory` → call `memoryStore.read(sections?)`
  - `update_memory` → call `memoryStore.writeSections(sections)`
- Add input validation with type guards
- If no memoryStore provided, memory tools return error message (graceful degradation)

### 10. `src/services/claude/system-prompt.ts`

- Update `buildSystemPrompt()` signature to accept optional `memoryTOC: string`
- Inject memory_instructions slot between `instructions` and user preferences (ALWAYS)
- Append formatted TOC after memory_instructions (only when memory is non-empty)

### 11. `src/durable-objects/user-session.ts`

- Create `MarkdownMemoryStore` instance in `processChat()`, pass to orchestrator
- In `processChat()`: extract TOC, pass to `buildSystemPrompt()`
- Add Hono routes for admin API:
  - `GET /memory` → read full memory
  - `DELETE /memory` → clear memory

### 12. `src/index.ts`

- Add admin endpoints:
  - `GET /api/v1/admin/orgs/:org/users/:userId/memory` — routes to DO
  - `DELETE /api/v1/admin/orgs/:org/users/:userId/memory` — routes to DO

### 13. `tests/unit/system-prompt.test.ts`

- Test memory_instructions slot appears in correct position
- Test TOC injection when memory exists
- Test no memory section when TOC is empty

### 14. `tests/unit/prompt-overrides.test.ts`

- Update tests to include `memory_instructions` as valid slot
- Test validation accepts/rejects it correctly

---

## Implementation Order

1. **Create branch**: `git checkout -b feature/user-memory`
2. **Types + Parser** (files 1-2, 5): Pure functions, no dependencies. Write tests first.
3. **Memory Store** (files 3-4, 6): Wraps parser with DO storage. Write tests first.
4. **Prompt slot** (file 7, 14): Add `memory_instructions` to the 6 slots.
5. **Tool definitions** (file 8): Add `read_memory` and `update_memory` tools.
6. **Orchestrator** (file 9): Wire tools to memory store in dispatch loop.
7. **System prompt** (file 10, 13): Inject TOC into prompt assembly.
8. **DO integration** (file 11): Wire everything in UserSession.
9. **Admin endpoints** (file 12): GET/DELETE for user memory.
10. **Verification**: Full test suite + manual curl tests.

---

## Logging Requirements

Every memory operation must be logged with structured JSON. Key events:

| Event                   | Fields                                                                               |
| ----------------------- | ------------------------------------------------------------------------------------ |
| `memory_toc_extracted`  | section_count, total_size_bytes, sections (names array)                              |
| `memory_read`           | sections_requested, sections_returned, response_size_bytes, duration_ms              |
| `memory_read_full`      | total_size_bytes, section_count, duration_ms                                         |
| `memory_write`          | sections_updated, sections_deleted, size_before_bytes, size_after_bytes, duration_ms |
| `memory_write_rejected` | reason (e.g., "exceeds_max_size"), attempted_size_bytes, max_size_bytes              |
| `memory_cleared`        | previous_size_bytes                                                                  |
| `memory_tool_dispatch`  | tool_name, input_summary, duration_ms                                                |
| `memory_empty`          | (logged when TOC extraction finds no memory)                                         |
| `memory_error`          | operation, error_message, stack                                                      |

---

## Verification

1. **`pnpm test`** — unit tests for parser, store, tools, system prompt, prompt overrides
2. **`pnpm check`** — TypeScript type checking
3. **`pnpm lint`** — ESLint compliance
4. **`pnpm architecture`** — no circular dependencies
5. **Manual curl tests**:
   - GET memory (empty): `GET /api/v1/admin/orgs/unfoldingWord/users/testuser/memory`
   - Chat to trigger memory creation (ask Claude to remember something)
   - GET memory (populated): verify sections created
   - Chat again, verify Claude sees TOC and can read/update sections
   - DELETE memory, verify cleared
   - Chat again, verify memory is empty
6. **Override `memory_instructions` slot** via existing prompt override API to customize what Claude tracks
