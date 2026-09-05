/**
 * Claude Orchestrator
 *
 * Main orchestration loop that:
 * 1. Sends messages to Claude with tool definitions
 * 2. Executes tool calls (in parallel when possible)
 * 3. Loops until Claude returns a final text response
 * 4. Supports streaming via callbacks
 */

import Anthropic from '@anthropic-ai/sdk';
import { Env } from '../../config/types.js';
import { AudioContext, VOICE_SUBMISSION_PREFIX, voiceSubmissionKeyToUrl } from '../audio/index.js';
import { ChatHistoryEntry, StreamCallbacks } from '../../types/engine.js';
import { uiString } from '../../i18n/ui-strings.js';
import { createStatusEmitter, StatusEmitter } from '../../i18n/status-emitter.js';
import { DEFAULT_ORG_CONFIG, OrgConfig } from '../../types/org-config.js';
import {
  DEFAULT_PROMPT_VALUES,
  findModeBySlug,
  ModeContext,
  PROMPT_OVERRIDE_SLOTS,
  PromptSlot,
} from '../../types/prompt-overrides.js';
import {
  AppError,
  ClaudeAPIError,
  MCPError,
  MCPRequestCallLimitError,
  ValidationError,
} from '../../utils/errors.js';
import { redactToolInputForError, RequestLogger, summarizeToolInput } from '../../utils/logger.js';
import { stripUlyssesComments } from '../../utils/ulysses-comments.js';
import { UnmatchedTrigger } from '../classifier/index.js';
import { createMCPHostFunctions, executeCode } from '../code-execution/index.js';
import { withSpan, recordSpanError, countMetric, recordMetric } from '../telemetry/index.js';
import {
  callMCPTool,
  createHealthTracker,
  getHealthSummary,
  getToolNames,
  HealthTracker,
  isServerHealthy,
  ToolCatalog,
} from '../mcp/index.js';
import { MAX_MEMORY_SIZE_BYTES, UserMemoryStore } from '../memory/index.js';
import {
  AttachmentsContext,
  handleGenerateScripturePdf,
  handlePrepareUsfmSource,
  isGenerateScripturePdfInput,
  isPrepareUsfmSourceInput,
} from '../ptxprint/index.js';
import {
  buildSystemPromptBlocks,
  GroupChatContext,
  historyToMessages,
  sanitizeSpeaker,
  TriggerOnlyContext,
  VOICE_WRITING_RULES,
} from './system-prompt.js';
import {
  buildAllTools,
  getToolDefinitions,
  isR2KeyInput,
  isReadMemoryInput,
  isSwitchModeInput,
  isUpdateMemoryInput,
} from './tools.js';

/** Default max response size for MCP calls (1MB) */
const DEFAULT_MAX_MCP_RESPONSE_SIZE = 1048576;

/**
 * Per-tool-result content cap appended to the conversation history.
 *
 * Why: a tool result that is multiple MCP responses worth of `docs(...)`
 * output (the canonical bloat path — observed 96 KB single results from
 * `ptxprint-mcp.docs`) accumulates across iterations and pushes the next
 * Claude request body into the danger zone (>200 KB), which correlates
 * with silent SSE-consumer hangs in the DO that emit no exception. Cap
 * each tool_result content at the boundary where we serialize it into
 * the next message so that a chatty tool cannot silently destabilize the
 * loop. Truncation marker is plaintext (Anthropic accepts string content
 * for tool_result) and tells Claude to narrow its query rather than
 * fetch more.
 */
// Was 12 KB initially. Bumped to 32 KB on 2026-04-30 because the 12 KB
// cap was chopping virtually every meaningful ptxprint `docs(...)` read
// (typical articles return 30-90 KB). 32 KB lets the typical case
// through while still capping pathological 90+ KB returns. The 200 KB
// request body cap downstream still bounds total conversation size.
const DEFAULT_MAX_TOOL_RESULT_BYTES = 32_768; // 32 KB

function truncateToolResultContent(content: string, toolName: string): string {
  if (content.length <= DEFAULT_MAX_TOOL_RESULT_BYTES) return content;
  const head = content.slice(0, DEFAULT_MAX_TOOL_RESULT_BYTES);
  return (
    `${head}\n\n` +
    `…[TRUNCATED: tool '${toolName}' returned ${content.length} bytes; ` +
    `capped at ${DEFAULT_MAX_TOOL_RESULT_BYTES} to keep the conversation context bounded. ` +
    `To get more detail, narrow your query (e.g. a more specific 'query' string, ` +
    `or lower 'depth') or ask the user a clarifying question instead of fetching more. ` +
    `Do NOT retry with the same broad query — you will hit this cap again.]`
  );
}

/**
 * Hard ceiling on the JSON body size sent to the Anthropic Messages API.
 *
 * Why: above ~200 KB we have repeatedly observed silent SSE-consumer
 * hangs in the DO — the streaming response opens, then `reader.read()`
 * stops yielding chunks and no JS-level exception is ever thrown
 * (`$workers.outcome` stays "ok" because the response 200'd). Failing
 * fast here surfaces the runaway as a clear `claude_request_body_too_large`
 * error instead of an indefinite hang the user has no way to escape.
 * Pairs with truncateToolResultContent — the per-result cap is the
 * primary defense; this is the seatbelt for whatever it misses.
 */
const MAX_REQUEST_BODY_BYTES = 200_000;

class ClaudeRequestBodyTooLargeError extends AppError {
  constructor(
    public readonly bodySize: number,
    public readonly limit: number,
    public readonly messageCount: number
  ) {
    super(
      `Conversation context grew too large to send to Claude ` +
        `(${bodySize} bytes > ${limit} byte limit, ${messageCount} messages). ` +
        `This usually means a tool returned a very large result that is now stuck in history. ` +
        `Start a new conversation or ask a narrower follow-up question.`,
      'CLAUDE_REQUEST_BODY_TOO_LARGE',
      413
    );
    this.name = 'ClaudeRequestBodyTooLargeError';
  }
}

function assertRequestBodyWithinLimit(body: string, ctx: OrchestrationContext): void {
  if (body.length <= MAX_REQUEST_BODY_BYTES) return;
  ctx.logger.error('claude_request_body_too_large', null, {
    body_size_bytes: body.length,
    limit: MAX_REQUEST_BODY_BYTES,
    message_count: ctx.messages.length,
  });
  throw new ClaudeRequestBodyTooLargeError(
    body.length,
    MAX_REQUEST_BODY_BYTES,
    ctx.messages.length
  );
}

/** Default Claude model - can be overridden via CLAUDE_MODEL env var */
export const DEFAULT_MODEL = 'claude-sonnet-4-6';

/** Default max tokens - can be overridden via CLAUDE_MAX_TOKENS env var */
const DEFAULT_MAX_TOKENS = 4096;

/** Maximum allowed code length to prevent DoS via huge payloads (100KB) */
const MAX_CODE_LENGTH = 100_000;

/** Maximum number of tool names that can be requested at once */
const MAX_TOOL_NAMES = 100;

/** Maximum length of input to include in error messages */
const MAX_ERROR_INPUT_LENGTH = 100;

/** Truncate input for safe inclusion in error messages */
function truncateInput(input: unknown): string {
  const str = JSON.stringify(input);
  return str.length <= MAX_ERROR_INPUT_LENGTH ? str : str.slice(0, MAX_ERROR_INPUT_LENGTH) + '...';
}

interface OrchestratorOptions {
  env: Env;
  catalog: ToolCatalog;
  history: ChatHistoryEntry[];
  preferences: { response_language: string; first_interaction: boolean };
  orgConfig?: OrgConfig;
  resolvedPromptValues?: Required<Record<PromptSlot, string>>;
  memoryStore?: UserMemoryStore | undefined;
  memoryTOC?: string | undefined;
  modeContext?: ModeContext | undefined;
  audioContext?: AudioContext | undefined;
  attachmentsContext?: AttachmentsContext | undefined;
  /** Public worker origin (e.g. https://bt-servant-worker-staging.example.workers.dev). Used to build public URLs for ptxprint artifacts. */
  workerOrigin?: string | undefined;
  clientId?: string | undefined;
  groupContext?: GroupChatContext | undefined;
  isVoiceMessage?: boolean | undefined;
  /** Per-turn language document to inject into the system prompt */
  languageDocument?: string | undefined;
  /** Set when the user's whole message was routing triggers (`@hindi` alone).
   *  Forwarded to the system prompt so the reply is a short confirmation of the
   *  switch rather than an improvised answer to a bare token. */
  triggerOnly?: TriggerOnlyContext | undefined;
  /** Triggers from the user's leading `#<mode>` / `@<language>` tokens that
   *  could not be resolved. Forwarded to the system prompt so the orchestrator
   *  can compose a contextual "did you mean…" reply. */
  unmatchedTriggers?: UnmatchedTrigger[] | undefined;
  /** Whether the inbound message was directly addressed to the bot. Gateway-supplied.
   *  Text turns with `false` are short-circuited before orchestration; only audio
   *  turns can reach here with `false`.  Forwarded to the system prompt so the mode
   *  can decide how to handle ambient voice (e.g. story submission vs. ignore). */
  addressedToBot?: boolean | undefined;
  /** R2 key under `voice-submissions/...` for the inbound voice message that produced this turn's text
   *  via transcription. Surfaced to the prompt so the active mode can index the submission in memory. */
  inboundVoiceKey?: string | undefined;
  /** The org for this request. Used by tools like `read_r2_object` / `attach_audio`
   *  to scope-check that the requested R2 key belongs to this org. */
  org?: string | undefined;
  /** Per-turn id minted by the caller; stamped on every log this run emits. */
  turnId?: string | undefined;
  logger: RequestLogger;
  callbacks?: StreamCallbacks | undefined;
}

interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/**
 * Type guard for execute_code input with semantic validation.
 * Checks structure, non-empty code, and length limits.
 */
function isExecuteCodeInput(input: unknown): input is { code: string } {
  if (
    typeof input !== 'object' ||
    input === null ||
    !('code' in input) ||
    typeof (input as { code: unknown }).code !== 'string'
  ) {
    return false;
  }
  const code = (input as { code: string }).code;
  return code.length > 0 && code.length <= MAX_CODE_LENGTH;
}

/**
 * Type guard for get_tool_definitions input with semantic validation.
 * Checks structure, non-empty array, length limits, and non-empty tool names.
 */
function isGetToolDefinitionsInput(input: unknown): input is { tool_names: string[] } {
  if (
    typeof input !== 'object' ||
    input === null ||
    !('tool_names' in input) ||
    !Array.isArray((input as { tool_names: unknown }).tool_names)
  ) {
    return false;
  }
  const names = (input as { tool_names: string[] }).tool_names;
  return (
    names.length > 0 &&
    names.length <= MAX_TOOL_NAMES &&
    names.every((n) => typeof n === 'string' && n.length > 0)
  );
}

/** Anthropic API base URL */
const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';

/** Anthropic API version header value */
const ANTHROPIC_API_VERSION = '2023-06-01';

interface OrchestrationContext {
  client: Anthropic;
  apiKey: string;
  model: string;
  maxTokens: number;
  /**
   * Org/mode-scoped system prefix, byte-identical for every user in that scope.
   * Carries the cache breakpoint — see {@link buildMessageBody}.
   */
  systemStable: string;
  /** Per-request remainder of the system prompt, separator-prefixed. */
  systemVolatile: string;
  /** FNV-1a of `systemStable`, for attributing cache-rate changes. */
  systemStableHash: string;
  /** Active mode slug, used as a metric dimension — the dominant cost driver. */
  activeMode: string | undefined;
  tools: Anthropic.Tool[];
  messages: Anthropic.MessageParam[];
  responses: string[];
  /** Index into responses[] where the most recent iteration's text begins. */
  lastIterationStartIndex: number;
  codeExecTimeout: number;
  maxMcpCalls: number;
  maxMcpResponseSize: number;
  /**
   * Whole-request cap on the number of MCP tool calls. Counts ACTUAL calls
   * (no fan-out estimation, no per-server heuristics). Top-level Claude
   * tool_use calls and execute_code-internal host-function calls both
   * increment the same counter; the cap fires when the next call would
   * cross the limit. Restored after the budget removal in this PR per
   * codex review feedback (PR #177): without it, raising
   * MAX_ORCHESTRATION_ITERATIONS to 100 + cpu_ms to 5min lets a chatty
   * tool loop run for minutes and burn hundreds of downstream calls
   * before anything stops it.
   */
  maxMcpCallsPerRequest: number;
  /** Mutable counter — increments inside handleMCPToolCall before each call. */
  mcpCallsMade: { count: number };
  /**
   * Per-turn id, minted by the caller (UserDO). Distinct from `request_id`:
   * `drainQueue` reuses the TRIGGERING request's logger for every entry it
   * drains, so `request_id` is not a per-turn key on that path and joining
   * generations on it would silently merge two users' turns.
   */
  turnId: string | undefined;
  /** Mutable per-run telemetry accumulator. See `TelemetryAccumulator`. */
  telemetry: TelemetryAccumulator;
  catalog: ToolCatalog;
  logger: RequestLogger;
  callbacks?: StreamCallbacks | undefined;
  /**
   * Locale for the notice the orchestrator writes into the response itself
   * (`notice_max_iterations`). Status lines go through `emitStatus` (#405).
   */
  locale: string;
  /** `callbacks.onStatus` bound to `locale`; `undefined` when there are no callbacks. */
  emitStatus?: StatusEmitter | undefined;
  healthTracker: HealthTracker;
  memoryStore: UserMemoryStore | undefined;
  modeContext: ModeContext | undefined;
  audioContext: AudioContext | undefined;
  attachmentsContext: AttachmentsContext | undefined;
  workerOrigin: string;
  /** The org scope for this request. Used by `read_r2_object` / `attach_audio` to
   *  enforce that requested R2 keys belong to this org. */
  org: string;
  env: Env;
}

/**
 * Per-turn facts accumulated across every iteration of one orchestration run.
 *
 * Exists because `OrchestrationResult` was previously the only channel out of
 * `orchestrate()`, and it carried nothing but text — so the model that answered,
 * what the turn cost, how many steps it took and why it stopped were all computed
 * and then discarded. Every downstream analytics question depends on these five
 * facts escaping the run.
 */
export interface OrchestrationTelemetry {
  /** Model requested for this run (`ctx.model`), not necessarily the one served. */
  model: string;
  /** Iterations actually run. 0 only if the loop never entered. */
  iterations: number;
  /** How the loop terminated. Bounded enum — safe as a metric label or log field. */
  exitReason: 'done' | 'max_iterations';
  /** `stop_reason` of the LAST Anthropic response; null if no iteration completed. */
  finalStopReason: string | null;
  /** Token counts SUMMED across every iteration (not last-write-wins). */
  usage: UsageSummary;
  /** MCP/host-function calls made this run. */
  mcpCallsMade: number;
  /**
   * Active mode slug at turn START. This is the correct — and only — attribution
   * key for "which mode governed this turn": the system prompt is built once,
   * before the loop, so a mid-turn `switch_mode` cannot affect this turn.
   */
  mode: string | undefined;
  /**
   * Mode selected via the `switch_mode` tool during this turn, which by design
   * takes effect on the user's NEXT message ("This will take effect on your next
   * message"). A forward-looking selection signal — never an attribution key.
   * `null` when no switch happened; the string `'__cleared__'` when mode was cleared.
   */
  modeSwitchedTo: string | null;
  /**
   * Every tool call made this turn, in order — names, servers and timings only,
   * never arguments (see `ToolCallRecord`). Capped at MAX_TOOL_CALL_RECORDS.
   */
  toolCalls: ToolCallRecord[];
}

/**
 * Sentinel for `modeSwitchedTo` when the user cleared their mode rather than
 * selecting a new one. A distinct string (not null) so "cleared" is
 * distinguishable from "no switch happened" in analytics.
 */
export const MODE_CLEARED = '__cleared__';

/**
 * One tool call the orchestrator made during a turn: WHICH tool, on which MCP
 * server, when, for how long, and whether it succeeded. Names and numbers
 * only — never the arguments or the result, which can carry user text.
 */
export interface ToolCallRecord {
  /** Tool name as the model called it (e.g. `fetch_scripture`, `execute_code`). */
  name: string;
  /** MCP server that owns the tool; null for host tools (execute_code, switch_mode, …). */
  server_id: string | null;
  /** Epoch ms when the call started. */
  started_at: number;
  duration_ms: number;
  ok: boolean;
}

/** Cap on recorded calls per turn so a runaway loop cannot bloat the log line. `mcpCallsMade` is never capped. */
export const MAX_TOOL_CALL_RECORDS = 50;

/**
 * Mutable accumulator threaded on `OrchestrationContext`, following the same
 * cell pattern as `mcpCallsMade`. Only holds what must survive ACROSS iterations;
 * everything else on `OrchestrationTelemetry` is read off the context at return.
 */
interface TelemetryAccumulator {
  iterations: number;
  exitReason: 'done' | 'max_iterations';
  finalStopReason: string | null;
  usage: UsageSummary;
  modeSwitchedTo: string | null;
  toolCalls: ToolCallRecord[];
}

/** Fresh accumulator for one run. Extracted to keep createOrchestrationContext under its line cap. */
function createTelemetryAccumulator(): TelemetryAccumulator {
  return {
    iterations: 0,
    exitReason: 'max_iterations',
    finalStopReason: null,
    usage: { ...EMPTY_USAGE },
    modeSwitchedTo: null,
    toolCalls: [],
  };
}

/** Result of an orchestration run. */
export interface OrchestrationResult {
  /** All text responses from all iterations (for display and history). */
  responses: string[];
  /** Index into responses[] where the final iteration's text begins. */
  finalIterationStartIndex: number;
  /** Per-turn facts for telemetry. Always populated — see `OrchestrationTelemetry`. */
  telemetry: OrchestrationTelemetry;
}

function extractToolCalls(content: Anthropic.ContentBlock[]): ToolUseBlock[] {
  return content.filter((block): block is ToolUseBlock => block.type === 'tool_use');
}

function extractTextResponses(content: Anthropic.ContentBlock[]): string[] {
  const texts: string[] = [];
  for (const block of content) {
    if (block.type === 'text' && block.text.trim()) {
      texts.push(block.text);
    }
  }
  return texts;
}

/**
 * Render `system` as content blocks with the cache breakpoint on the stable
 * prefix (issue #333).
 *
 * `cache_control` cannot attach to a bare string, so `system` has to be an
 * array. The breakpoint goes on the FIRST block — the org/mode-scoped prefix
 * that is byte-identical for every user — because caching is a prefix match and
 * a write only happens at the breakpoint. Marking the last block instead would
 * key the entry to per-request content and never produce a read.
 *
 * The volatile block is omitted rather than emitted empty: empty text blocks
 * cannot be cached and are rejected by the API.
 */
function buildSystemBlocks(ctx: OrchestrationContext): Anthropic.TextBlockParam[] {
  return [
    {
      type: 'text',
      text: ctx.systemStable,
      cache_control: { type: 'ephemeral' },
    },
    ...(ctx.systemVolatile ? [{ type: 'text' as const, text: ctx.systemVolatile }] : []),
  ];
}

/**
 * Build the JSON request body for the Anthropic Messages API.
 *
 * Two cache breakpoints, using 2 of the 4 available slots:
 *
 * 1. Explicit, on the stable system block. Render order is `tools` -> `system`
 *    -> `messages`, so this one entry covers the tool definitions AND the
 *    org/mode prompt prefix — the bulk of what we re-send every call.
 * 2. Top-level `cache_control`, which is automatic caching: the API places a
 *    breakpoint on the last cacheable block and advances it as the conversation
 *    grows. That is what pays for the orchestration loop, where each iteration
 *    re-sends every tool result accumulated so far. Because the breakpoint moves
 *    every iteration, consecutive writes stay a few content blocks apart and
 *    comfortably inside the API's 20-block lookback window.
 *
 * Prompt caching is GA — no beta header is required.
 */
export function buildMessageBody(ctx: OrchestrationContext, stream: boolean): string {
  return JSON.stringify({
    model: ctx.model,
    max_tokens: ctx.maxTokens,
    system: buildSystemBlocks(ctx),
    messages: ctx.messages,
    ...(ctx.tools.length > 0 ? { tools: ctx.tools } : {}),
    cache_control: { type: 'ephemeral' },
    stream,
  });
}

/**
 * Anthropic's cache pricing multipliers, relative to the base input rate.
 *
 * These are multipliers, not prices: they are identical across every model, so
 * encoding them here does not create a price table that goes stale when
 * Anthropic reprices. The dollar rate is applied at report time, never here.
 */
const CACHE_WRITE_5M_MULTIPLIER = 1.25;
const CACHE_WRITE_1H_MULTIPLIER = 2.0;
const CACHE_READ_MULTIPLIER = 0.1;

/** Token accounting for one Anthropic call, including what caching saved. */
export interface UsageSummary {
  /** Uncached remainder only — everything AFTER the last breakpoint. */
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  cache_write_5m_tokens: number;
  cache_write_1h_tokens: number;
  /**
   * What this call actually costs, expressed in base-rate-equivalent input
   * tokens. Subtract it from the true prompt size
   * (`input + cache_creation + cache_read`) to get the savings, then multiply
   * by the model's $/MTok. Caching does not change the prompt, so that
   * subtraction is an exact counterfactual, not an estimate — which is why we
   * can report savings without ever having measured a pre-caching baseline.
   */
  billable_input_tokens: number;
}

const EMPTY_USAGE: UsageSummary = {
  input_tokens: 0,
  output_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  cache_write_5m_tokens: 0,
  cache_write_1h_tokens: 0,
  billable_input_tokens: 0,
};

/** Coerce a possibly-null/absent token count to a number. */
function tokenCount(value: number | null | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * Add one call's usage into a running total, in place.
 *
 * Summing (rather than last-write-wins) is the whole point: one turn can run up
 * to MAX_ORCHESTRATION_ITERATIONS generations, and the cost of the turn is their
 * sum. Reading only the final response — the obvious mistake — under-reports a
 * multi-step turn by however many tool round-trips it took.
 */
function addUsage(into: UsageSummary, from: UsageSummary): void {
  into.input_tokens += from.input_tokens;
  into.output_tokens += from.output_tokens;
  into.cache_creation_input_tokens += from.cache_creation_input_tokens;
  into.cache_read_input_tokens += from.cache_read_input_tokens;
  into.cache_write_5m_tokens += from.cache_write_5m_tokens;
  into.cache_write_1h_tokens += from.cache_write_1h_tokens;
  into.billable_input_tokens += from.billable_input_tokens;
}

/**
 * Reduce an Anthropic `usage` block to the token accounting we report on.
 *
 * Tolerant by design: `usage` is telemetry, and a malformed or partial block
 * must never break a chat turn that otherwise succeeded.
 */
export function summarizeUsage(usage: Anthropic.Usage | undefined | null): UsageSummary {
  if (!usage) return { ...EMPTY_USAGE };

  const read = tokenCount(usage.cache_read_input_tokens);
  const writeTotal = tokenCount(usage.cache_creation_input_tokens);

  // Newer responses break the write down by TTL. When that breakdown is absent,
  // attribute the whole write to the 5-minute bucket — the only TTL we request.
  const breakdown = usage.cache_creation;
  const write1h = tokenCount(breakdown?.ephemeral_1h_input_tokens);
  const write5m = breakdown
    ? tokenCount(breakdown.ephemeral_5m_input_tokens)
    : writeTotal - write1h;

  const input = tokenCount(usage.input_tokens);

  return {
    input_tokens: input,
    output_tokens: tokenCount(usage.output_tokens),
    cache_creation_input_tokens: writeTotal || write5m + write1h,
    cache_read_input_tokens: read,
    cache_write_5m_tokens: write5m,
    cache_write_1h_tokens: write1h,
    billable_input_tokens: Math.round(
      input +
        CACHE_WRITE_5M_MULTIPLIER * write5m +
        CACHE_WRITE_1H_MULTIPLIER * write1h +
        CACHE_READ_MULTIPLIER * read
    ),
  };
}

/**
 * FNV-1a over the stable system block, logged once per request.
 *
 * When the cache hit rate dips, this is what separates "an MCP server was down
 * so the tool catalog shrank" from "an admin edited a prompt override in the
 * portal". Both change the cached prefix; without a fingerprint both are
 * invisible. Non-cryptographic and synchronous on purpose — `crypto.subtle` is
 * async and this sits on the request path.
 */
function fingerprint(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/**
 * Call the Anthropic Messages API using raw fetch.
 *
 * The Anthropic SDK's internal fetch triggers Cloudflare error 1003 when called
 * from inside a Durable Object — even at depth 2 (Worker → DO → Anthropic).
 * This appears to be a Cloudflare platform issue with SDK-managed fetch from DOs,
 * not strictly a nesting problem. Raw globalThis.fetch works in all contexts.
 */
/**
 * Hard ceiling on a single Anthropic Messages API request. Cloudflare Workers'
 * subrequest fetch has its own time budget but does not surface a useful error
 * when the upstream stalls; we add an explicit AbortSignal so an unresponsive
 * Anthropic stream surfaces as a clear `claude_fetch_aborted` error instead of
 * a silent orchestration death (which is what staging exhibited on
 * 2026-04-30 — the loop simply stopped emitting events after iteration 4).
 */
const CLAUDE_REQUEST_TIMEOUT_MS = 90_000;

/**
 * Retry/backoff policy for transient Anthropic API failures (issue #248).
 *
 * We bypass the Anthropic SDK's HTTP layer (PR #104), so we also lost its built-in
 * retry/backoff. These constants restore jittered exponential backoff for rate limits
 * (429) and transient 5xx, honoring `Retry-After`. Each attempt gets its own fresh
 * {@link CLAUDE_REQUEST_TIMEOUT_MS} hang-guard; the sum of attempts + backoff waits is
 * bounded by {@link CLAUDE_OVERALL_RETRY_WINDOW_MS} so a retry storm can't run for minutes.
 */
const CLAUDE_MAX_ATTEMPTS = 4; // 1 initial + 3 retries
const CLAUDE_RETRY_BASE_MS = 1_000;
const CLAUDE_RETRY_DELAY_CAP_MS = 30_000; // per-delay cap
const CLAUDE_OVERALL_RETRY_WINDOW_MS = 180_000; // wall-clock cap across all attempts

/** HTTP statuses worth retrying: rate limit, transient 5xx, and Anthropic `overloaded_error`. */
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504, 529]);

/**
 * Injectable clock seam so tests resolve backoff delays instantly and control the
 * jitter/elapsed-time inputs deterministically. Production uses {@link REAL_CLOCK}.
 */
export interface RetryClock {
  sleep(ms: number): Promise<void>;
  now(): number;
  random(): number;
}

async function realSleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

const REAL_CLOCK: RetryClock = {
  sleep: realSleep,
  now: () => Date.now(),
  random: () => Math.random(),
};

/** Whether an Anthropic HTTP status should be retried. */
export function isRetryableStatus(status: number): boolean {
  return RETRYABLE_STATUSES.has(status);
}

/**
 * Full-jitter exponential backoff: `random(0, min(cap, base * 2^(attempt-1)))`.
 * `attempt` is 1-based (the attempt that just failed).
 */
export function computeBackoffDelay(attempt: number, random: () => number): number {
  const bound = Math.min(CLAUDE_RETRY_DELAY_CAP_MS, CLAUDE_RETRY_BASE_MS * 2 ** (attempt - 1));
  return Math.round(random() * bound);
}

/**
 * Parse a `Retry-After` header into milliseconds. Supports delta-seconds and HTTP-date
 * forms; clamps negatives to 0; returns null when the header is absent/unparseable.
 */
export function parseRetryAfter(headers: Headers, now: () => number): number | null {
  const raw = headers.get('retry-after');
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds * 1000));
  const dateMs = Date.parse(raw);
  if (Number.isNaN(dateMs)) return null;
  return Math.max(0, dateMs - now());
}

/** Collect `anthropic-ratelimit-*` and `retry-after` response headers for diagnostics. */
function extractRatelimitHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    if (key.startsWith('anthropic-ratelimit-') || key === 'retry-after') out[key] = value;
  });
  return out;
}

/**
 * True when a rejected `fetch` is our own deliberate timeout abort (the per-attempt
 * hang-guard). Those already consumed the full request timeout, so we never retry them.
 * Genuine network rejections (e.g. `TypeError`) ARE retried.
 */
function isOurTimeoutAbort(error: unknown): boolean {
  return (error as Error | undefined)?.name === 'AbortError';
}

function buildClaudeAbortSignal(timeoutMs: number): {
  signal: AbortSignal;
  cleanup: () => void;
} {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return { signal: controller.signal, cleanup: () => clearTimeout(timer) };
}

async function postToAnthropic(
  body: string,
  signal: AbortSignal,
  apiKey: string
): Promise<Response> {
  return globalThis.fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_API_VERSION,
    },
    body,
    signal,
  });
}

async function throwAnthropicHttpError(
  ctx: OrchestrationContext,
  response: Response,
  streaming: boolean,
  fetchStart: number
): Promise<never> {
  // Best-effort body to enrich the error log immediately below. The HTTP error
  // is always logged, so a failed .text() read degrades to a placeholder — not
  // a silent swallow.
  const errorText = await response.text().catch(() => '(unreadable)');
  ctx.logger.error('claude_fetch_http_error', null, {
    streaming,
    status: response.status,
    has_body: !!response.body,
    body_preview: errorText.slice(0, 500),
    duration_ms: Date.now() - fetchStart,
  });
  throw new Anthropic.APIError(
    response.status,
    { message: errorText },
    errorText,
    response.headers
  );
}

function logFetchCommencement(ctx: OrchestrationContext, body: string, streaming: boolean): void {
  ctx.logger.log('claude_fetch_start', {
    streaming,
    body_size_bytes: body.length,
    message_count: ctx.messages.length,
    timeout_ms: CLAUDE_REQUEST_TIMEOUT_MS,
  });
}

function logFetchAborted(
  ctx: OrchestrationContext,
  error: unknown,
  streaming: boolean,
  fetchStart: number
): void {
  if ((error as Error)?.name !== 'AbortError') return;
  ctx.logger.error('claude_fetch_aborted', error, {
    streaming,
    timeout_ms: CLAUDE_REQUEST_TIMEOUT_MS,
    duration_ms: Date.now() - fetchStart,
  });
}

/** A successful Anthropic fetch plus the resources the caller must manage. */
export interface AnthropicFetchResult {
  /** A response with `ok === true`, body NOT yet consumed (ready for json()/SSE). */
  response: Response;
  /** Abort signal of the successful attempt; governs the body read until {@link cleanup}. */
  signal: AbortSignal;
  /** Clears the successful attempt's hang-guard timer. Caller must invoke after reading. */
  cleanup: () => void;
  /** Start timestamp of the successful attempt, for `claude_fetch_complete` duration. */
  fetchStart: number;
}

/**
 * POST to the Anthropic Messages API with jittered exponential backoff (issue #248).
 *
 * Retries on {@link RETRYABLE_STATUSES} and transient network rejections, honoring
 * `Retry-After`. Each attempt gets a fresh {@link CLAUDE_REQUEST_TIMEOUT_MS} hang-guard;
 * the total is bounded by {@link CLAUDE_OVERALL_RETRY_WINDOW_MS}. Retries happen strictly
 * BEFORE the response body is consumed, so the streaming caller can only ever retry
 * pre-first-byte — a mid-stream failure is out of scope here (handled by the caller).
 *
 * Returns a successful (`ok`) response with its still-open abort signal and a `cleanup`
 * the caller MUST invoke once it has finished reading the body. Throws via
 * {@link throwAnthropicHttpError} (HTTP error) or rethrows the network error otherwise.
 */
/** A failed attempt — either an HTTP error response or a thrown network error. */
interface AnthropicAttemptFailure {
  response?: Response;
  networkError?: unknown;
  cleanup: () => void;
  fetchStart: number;
}

type AnthropicAttemptOutcome =
  { ok: true; result: AnthropicFetchResult } | ({ ok: false } & AnthropicAttemptFailure);

/** Perform a single Anthropic fetch attempt with its own hang-guard signal. */
async function attemptAnthropicFetch(
  ctx: OrchestrationContext,
  body: string,
  streaming: boolean,
  attempt: number
): Promise<AnthropicAttemptOutcome> {
  const { signal, cleanup } = buildClaudeAbortSignal(CLAUDE_REQUEST_TIMEOUT_MS);
  const fetchStart = Date.now();
  try {
    const response = await postToAnthropic(body, signal, ctx.apiKey);
    ctx.logger.log('claude_fetch_response_received', {
      streaming,
      status: response.status,
      attempt,
      has_body: !!response.body,
      duration_ms: Date.now() - fetchStart,
    });
    if (response.ok) return { ok: true, result: { response, signal, cleanup, fetchStart } };
    return { ok: false, response, cleanup, fetchStart };
  } catch (networkError) {
    return { ok: false, networkError, cleanup, fetchStart };
  }
}

/** Whether a failed attempt is worth retrying (excludes our own timeout abort). */
function isAttemptRetryable(failure: AnthropicAttemptFailure): boolean {
  return failure.networkError
    ? !isOurTimeoutAbort(failure.networkError)
    : isRetryableStatus(failure.response!.status);
}

/**
 * Surface a failed attempt as its terminal error (network rethrow or HTTP error).
 * Uses `await` rather than `return <promise>` so the rejection handler attaches in the
 * caller's await chain immediately — a bare `return` defers attachment by a microtask,
 * which the test runner can flag as a transient unhandled rejection.
 */
async function failAnthropicTerminally(
  ctx: OrchestrationContext,
  streaming: boolean,
  failure: AnthropicAttemptFailure
): Promise<never> {
  if (failure.networkError) {
    logFetchAborted(ctx, failure.networkError, streaming, failure.fetchStart);
    throw failure.networkError;
  }
  await throwAnthropicHttpError(ctx, failure.response!, streaming, failure.fetchStart);
  throw new Error('failAnthropicTerminally: unreachable'); // throwAnthropicHttpError always throws
}

/** The backoff wait for a failed attempt: max(jittered exponential, Retry-After). */
function computeRetryDelay(
  attempt: number,
  failure: AnthropicAttemptFailure,
  clock: RetryClock
): { delayMs: number; retryAfterMs: number } {
  const retryAfterMs = failure.response
    ? (parseRetryAfter(failure.response.headers, clock.now) ?? 0)
    : 0;
  const delayMs = Math.max(computeBackoffDelay(attempt, clock.random), retryAfterMs);
  return { delayMs, retryAfterMs };
}

function logAnthropicRetry(
  ctx: OrchestrationContext,
  streaming: boolean,
  failure: AnthropicAttemptFailure,
  retry: { attempt: number; delayMs: number; retryAfterMs: number }
): void {
  ctx.logger.warn('claude_api_retry', {
    attempt: retry.attempt,
    max_attempts: CLAUDE_MAX_ATTEMPTS,
    status: failure.response?.status,
    delay_ms: retry.delayMs,
    retry_after_ms: retry.retryAfterMs || undefined,
    anthropic_ratelimit_headers: failure.response
      ? extractRatelimitHeaders(failure.response.headers)
      : undefined,
    streaming,
    network_error: failure.networkError ? (failure.networkError as Error).message : undefined,
  });
}

/**
 * Give up on a failed attempt: log exhaustion when `reason` is set (i.e. the failure was
 * retryable but we ran out of attempts or window), then surface the error.
 *
 * Cleanup runs in `finally`, AFTER the terminal error is surfaced — `throwAnthropicHttpError`
 * reads `response.text()`, and clearing the per-attempt abort guard first would let a stalled
 * error body hang indefinitely. Keeping the guard live means a stalled read aborts at the
 * 90s timeout instead (mirrors the retry path, which also drains the body before cleanup).
 */
async function exhaustAnthropicRetries(
  ctx: OrchestrationContext,
  streaming: boolean,
  attempt: number,
  failure: AnthropicAttemptFailure,
  reason: 'max_attempts' | 'overall_window_exceeded' | null
): Promise<never> {
  if (reason) {
    ctx.logger.error('claude_api_retry_exhausted', failure.networkError ?? null, {
      streaming,
      attempts: attempt,
      status: failure.response?.status,
      reason,
    });
  }
  try {
    return await failAnthropicTerminally(ctx, streaming, failure);
  } finally {
    failure.cleanup();
  }
}

export async function fetchAnthropicWithRetry(
  ctx: OrchestrationContext,
  body: string,
  streaming: boolean,
  clock: RetryClock = REAL_CLOCK
): Promise<AnthropicFetchResult> {
  const overallStart = clock.now();
  for (let attempt = 1; attempt <= CLAUDE_MAX_ATTEMPTS; attempt++) {
    const outcome = await attemptAnthropicFetch(ctx, body, streaming, attempt);
    if (outcome.ok) return outcome.result;

    const isLast = attempt >= CLAUDE_MAX_ATTEMPTS;
    const retryable = isAttemptRetryable(outcome);
    const { delayMs, retryAfterMs } = computeRetryDelay(attempt, outcome, clock);
    const windowExceeded = clock.now() - overallStart + delayMs > CLAUDE_OVERALL_RETRY_WINDOW_MS;

    if (!retryable || isLast || windowExceeded) {
      const reason = isLast ? 'max_attempts' : 'overall_window_exceeded';
      await exhaustAnthropicRetries(ctx, streaming, attempt, outcome, retryable ? reason : null);
    }

    logAnthropicRetry(ctx, streaming, outcome, { attempt, delayMs, retryAfterMs });
    // Drain the error body so the connection is freed before we back off. Best-effort:
    // the retry is already logged above, and a failed drain is harmless (the body is
    // discarded on cleanup regardless), so the fallback is intentional, not a swallow.
    if (outcome.response) await outcome.response.text().catch(() => undefined);
    outcome.cleanup();
    await clock.sleep(delayMs);
  }
  // Unreachable: every iteration either returns or throws.
  throw new Error('fetchAnthropicWithRetry: exhausted loop without resolution');
}

async function callClaude(ctx: OrchestrationContext): Promise<Anthropic.Message> {
  if (ctx.callbacks) return streamClaudeResponse(ctx);
  const body = buildMessageBody(ctx, false);
  assertRequestBodyWithinLimit(body, ctx);
  logFetchCommencement(ctx, body, false);
  // signal omitted: the body read below is governed by the fetch's signal regardless;
  // cleanup (in finally) keeps the hang-guard timer live until the read completes.
  const { response, cleanup, fetchStart } = await fetchAnthropicWithRetry(ctx, body, false);
  try {
    const parsed = (await response.json()) as Anthropic.Message;
    ctx.logger.log('claude_fetch_complete', {
      streaming: false,
      stop_reason: parsed.stop_reason,
      content_blocks: parsed.content.length,
      duration_ms: Date.now() - fetchStart,
    });
    return parsed;
  } catch (error) {
    logFetchAborted(ctx, error, false, fetchStart);
    throw error;
  } finally {
    cleanup();
  }
}

async function streamClaudeResponse(ctx: OrchestrationContext): Promise<Anthropic.Message> {
  const body = buildMessageBody(ctx, true);
  assertRequestBodyWithinLimit(body, ctx);
  logFetchCommencement(ctx, body, true);
  const { response, signal, cleanup, fetchStart } = await fetchAnthropicWithRetry(ctx, body, true);
  try {
    if (!response.body) await throwAnthropicHttpError(ctx, response, true, fetchStart);
    const parsed = await parseSSEStream(response.body!, ctx.logger, ctx.callbacks, signal);
    ctx.logger.log('claude_fetch_complete', {
      streaming: true,
      stop_reason: parsed.stop_reason,
      content_blocks: parsed.content.length,
      duration_ms: Date.now() - fetchStart,
    });
    return parsed;
  } catch (error) {
    logFetchAborted(ctx, error, true, fetchStart);
    throw error;
  } finally {
    cleanup();
  }
}

interface SSEParseState {
  message: Anthropic.Message | undefined;
  eventCounts: Record<string, number>;
}

function applySSELines(
  state: SSEParseState,
  lines: string[],
  logger: RequestLogger,
  callbacks?: StreamCallbacks
): void {
  for (const line of lines) {
    if (!line.startsWith('data: ')) continue;
    const data = line.slice(6).trim();
    if (data === '[DONE]') continue;
    let event: Anthropic.RawMessageStreamEvent;
    try {
      event = JSON.parse(data) as Anthropic.RawMessageStreamEvent;
    } catch {
      logger.warn('sse_parse_error', { data: data.slice(0, 200) });
      continue;
    }
    const t = (event as { type?: string }).type ?? 'unknown';
    state.eventCounts[t] = (state.eventCounts[t] ?? 0) + 1;
    if (t === 'ping') continue;
    state.message = applySSEEvent(state.message, event, logger, callbacks);
  }
}

function attachSSEAbortListener(
  signal: AbortSignal | undefined,
  reader: ReadableStreamDefaultReader<Uint8Array>,
  logger: RequestLogger,
  ref: { chunks: number; bytes: number; start: number; state: SSEParseState }
): (() => void) | undefined {
  if (!signal) return undefined;
  const onAbort = () => {
    logger.warn('sse_stream_aborted', {
      elapsed_ms: Date.now() - ref.start,
      chunks: ref.chunks,
      bytes: ref.bytes,
      event_counts: { ...ref.state.eventCounts },
    });
    reader.cancel('upstream-abort').catch(() => {
      // The abort itself is already logged above (sse_stream_aborted). reader.cancel()
      // rejecting — e.g. the stream is already closed — is idempotent and harmless,
      // so there is nothing further to record here.
    });
  };
  signal.addEventListener('abort', onAbort);
  return () => signal.removeEventListener('abort', onAbort);
}

/**
 * Validate the post-loop SSE state and surface a final Message.
 *
 * CRITICAL: must check abort BEFORE the !state.message guard. The abort
 * listener cancels the reader, which makes reader.read() resolve with
 * done=true — so the loop exits "cleanly" even though we never saw
 * message_stop. Without this check, a 90s timeout that fires AFTER
 * message_start arrived would silently return the partial message
 * (truncated text or a half-built tool call) as a successful response,
 * defeating the entire reason this timeout exists.
 */
function finalizeSSEStream(
  state: SSEParseState,
  ref: { chunks: number; bytes: number; start: number },
  logger: RequestLogger,
  signal: AbortSignal | undefined
): Anthropic.Message {
  const base = {
    elapsed_ms: Date.now() - ref.start,
    chunks: ref.chunks,
    bytes: ref.bytes,
    event_counts: { ...state.eventCounts },
  };
  if (signal?.aborted) {
    logger.error('sse_stream_aborted_with_partial', null, {
      ...base,
      had_partial_message: !!state.message,
      partial_stop_reason: state.message?.stop_reason ?? null,
    });
    throw new Error('Claude stream aborted (timeout) before completing');
  }
  if (!state.message) {
    logger.error('sse_stream_no_message', null, base);
    throw new Error('Claude stream ended before producing a message');
  }
  logger.log('sse_stream_complete', {
    ...base,
    stop_reason: state.message.stop_reason,
    content_blocks: state.message.content.length,
  });
  return state.message;
}

/** Parse an SSE stream from the Anthropic Messages API into a final Message. */
async function parseSSEStream(
  body: ReadableStream<Uint8Array>,
  logger: RequestLogger,
  callbacks?: StreamCallbacks,
  signal?: AbortSignal
): Promise<Anthropic.Message> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const state: SSEParseState = { message: undefined, eventCounts: {} };
  const ref = { chunks: 0, bytes: 0, start: Date.now(), state };
  let buffer = '';

  logger.log('sse_stream_start', {});
  const detachAbort = attachSSEAbortListener(signal, reader, logger, ref);

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      ref.chunks += 1;
      ref.bytes += value.length;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      applySSELines(state, lines, logger, callbacks);
    }
    return finalizeSSEStream(state, ref, logger, signal);
  } finally {
    detachAbort?.();
  }
}

function applyContentDelta(
  message: Anthropic.Message,
  event: Anthropic.RawContentBlockDeltaEvent,
  logger: RequestLogger,
  callbacks?: StreamCallbacks
): void {
  const block = message.content[event.index];
  if (event.delta.type === 'text_delta' && block?.type === 'text') {
    const text = event.delta.text;
    block.text += text;
    notifyCallback(logger, () => callbacks?.onProgress(text));
  }
  if (event.delta.type === 'input_json_delta' && block?.type === 'tool_use') {
    const prev = typeof block.input === 'string' ? block.input : '';
    (block as { input: string }).input = prev + event.delta.partial_json;
  }
}

function finalizeToolInput(message: Anthropic.Message, index: number, logger: RequestLogger): void {
  const block = message.content[index];
  if (block?.type !== 'tool_use' || typeof block.input !== 'string') return;
  // Empty string means no input_json_delta events arrived — tool has no input
  if ((block.input as string).trim() === '') {
    (block as { input: unknown }).input = {};
    return;
  }
  try {
    block.input = JSON.parse(block.input as string) as Record<string, unknown>;
  } catch (error) {
    logger.warn('tool_input_parse_error', {
      index,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Apply a single SSE event to build up the final Message. */
function applySSEEvent(
  message: Anthropic.Message | undefined,
  event: Anthropic.RawMessageStreamEvent,
  logger: RequestLogger,
  callbacks?: StreamCallbacks
): Anthropic.Message {
  if (event.type === 'message_start') return event.message;
  if (!message) throw new Error(`Unexpected stream event before message_start: ${event.type}`);

  if (event.type === 'message_delta') {
    message.stop_reason = event.delta.stop_reason;
    message.stop_sequence = event.delta.stop_sequence;
    message.usage.output_tokens = event.usage.output_tokens;
    return message;
  }

  if (event.type === 'content_block_start') {
    const block = { ...event.content_block };
    if (block.type === 'tool_use') (block as { input: unknown }).input = '';
    message.content.push(block as Anthropic.ContentBlock);
  } else if (event.type === 'content_block_delta') {
    applyContentDelta(message, event, logger, callbacks);
  } else if (event.type === 'content_block_stop') {
    finalizeToolInput(message, event.index, logger);
  }

  return message;
}

/** Invoke a callback safely — catches both sync throws and async rejections. */
function notifyCallback(logger: RequestLogger, fn: () => unknown): void {
  try {
    Promise.resolve(fn()).catch((error: unknown) => {
      logger.warn('callback_failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  } catch (error) {
    logger.warn('callback_failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function callClaudeForIteration(
  ctx: OrchestrationContext,
  iteration: number,
  iterStart: number
): Promise<Anthropic.Message> {
  const callStart = Date.now();
  try {
    const response = await callClaude(ctx);
    recordMetric('claude_fetch_duration_ms', Date.now() - callStart, { status: 'success' });
    countMetric('claude_fetch_total', { status: 'success' });
    return response;
  } catch (error) {
    recordMetric('claude_fetch_duration_ms', Date.now() - callStart, { status: 'error' });
    countMetric('claude_fetch_total', {
      status: 'error',
      error_name: error instanceof Error ? error.name : 'Error',
    });
    ctx.logger.error('iteration_claude_call_failed', error, {
      iteration,
      message_count: ctx.messages.length,
      elapsed_ms: Date.now() - iterStart,
    });
    throw error;
  }
}

async function executeIterationTools(
  toolCalls: ToolUseBlock[],
  ctx: OrchestrationContext,
  iteration: number,
  iterStart: number
): Promise<Anthropic.ToolResultBlockParam[]> {
  try {
    return await executeToolCalls(toolCalls, ctx);
  } catch (error) {
    ctx.logger.error('iteration_tool_execution_failed', error, {
      iteration,
      tool_calls: toolCalls.map((tc) => tc.name),
      elapsed_ms: Date.now() - iterStart,
    });
    throw error;
  }
}

/**
 * Emit per-call token counters (issue #333).
 *
 * Labelled by `model` and `mode`: caches are model-scoped, and the active mode
 * swings the cached prefix by roughly 3.5x between the smallest and largest
 * mode documents, so a savings number that is not broken down by mode is not
 * actionable. `org` is deliberately not a dimension, matching the precedent set
 * by `chat_turns_total`, which logs org but does not meter it.
 *
 * Zero-valued counters are skipped — an `add(0)` produces a series carrying no
 * information while still costing cardinality.
 */
function emitUsageMetrics(ctx: OrchestrationContext, usage: UsageSummary): void {
  const labels = { model: ctx.model, ...(ctx.activeMode ? { mode: ctx.activeMode } : {}) };

  const counters: Array<[string, number, Record<string, string>]> = [
    ['claude_input_tokens_total', usage.input_tokens, labels],
    ['claude_output_tokens_total', usage.output_tokens, labels],
    ['claude_cache_read_tokens_total', usage.cache_read_input_tokens, labels],
    ['claude_billable_input_tokens_total', usage.billable_input_tokens, labels],
    ['claude_cache_write_tokens_total', usage.cache_write_5m_tokens, { ...labels, type: '5m' }],
    ['claude_cache_write_tokens_total', usage.cache_write_1h_tokens, { ...labels, type: '1h' }],
  ];

  for (const [name, value, metricLabels] of counters) {
    if (value > 0) countMetric(name, metricLabels, value);
  }
}

/**
 * Log and meter one Claude response, including its token accounting.
 *
 * Token usage is reported here rather than swallowed (it previously was) so
 * cache performance and spend are observable — `cache_read_input_tokens > 0` is
 * the acceptance signal for prompt caching, and `billable_input_tokens` against
 * the true prompt size is how savings are reported. See issue #333.
 */
function reportClaudeResponse(
  ctx: OrchestrationContext,
  args: {
    iteration: number;
    response: Anthropic.Message;
    toolCalls: ToolUseBlock[];
    iterStart: number;
  }
): void {
  const { iteration, response, toolCalls, iterStart } = args;
  const usage = summarizeUsage(response.usage);
  // Accumulate BEFORE logging so a throw in the log path cannot lose the counts.
  addUsage(ctx.telemetry.usage, usage);
  ctx.telemetry.finalStopReason = response.stop_reason;
  ctx.logger.log('claude_response', {
    ...(ctx.turnId ? { turn_id: ctx.turnId } : {}),
    iteration,
    stop_reason: response.stop_reason,
    tool_calls_count: toolCalls.length,
    text_blocks_count: response.content.filter((b) => b.type === 'text').length,
    duration_ms: Date.now() - iterStart,
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    cache_creation_input_tokens: usage.cache_creation_input_tokens,
    cache_read_input_tokens: usage.cache_read_input_tokens,
    billable_input_tokens: usage.billable_input_tokens,
  });
  emitUsageMetrics(ctx, usage);
}

function processIteration(ctx: OrchestrationContext, iteration: number): Promise<boolean> {
  return withSpan('iteration', { iteration }, async () => {
    const iterStart = Date.now();
    ctx.logger.log('iteration_start', { iteration, message_count: ctx.messages.length });
    ctx.logger.log('claude_request', {
      ...(ctx.turnId ? { turn_id: ctx.turnId } : {}),
      iteration,
      message_count: ctx.messages.length,
      system_stable_hash: ctx.systemStableHash,
      system_stable_chars: ctx.systemStable.length,
    });

    if (iteration > 0) {
      // The separator divides prose from prose. On a tools-first turn (iteration 0
      // returns tool_use with no text block — the normal shape for a fresh account's
      // first question) nothing has been streamed yet, so emitting it would put
      // whitespace ahead of the first word: stream consumers that treat `progress`
      // as "the answer has started" blank out for the whole tool phase, and the
      // streamed text diverges from the final joined `responses` (#410).
      // `ctx.responses` only ever holds non-whitespace blocks (extractTextResponses),
      // so a non-empty array means real prose has already gone out.
      if (ctx.callbacks && ctx.responses.length > 0) {
        notifyCallback(ctx.logger, () => ctx.callbacks?.onProgress('\n'));
      }
      // Status stays unconditional — the tool phase should still narrate itself.
      ctx.emitStatus?.('status_preparing');
    }

    const response = await callClaudeForIteration(ctx, iteration, iterStart);
    const toolCalls = extractToolCalls(response.content);
    reportClaudeResponse(ctx, { iteration, response, toolCalls, iterStart });

    ctx.lastIterationStartIndex = ctx.responses.length;
    ctx.responses.push(...extractTextResponses(response.content));

    if (response.stop_reason === 'end_turn' || toolCalls.length === 0) {
      ctx.logger.log('iteration_end', {
        iteration,
        reason: response.stop_reason === 'end_turn' ? 'end_turn' : 'no_tool_calls',
        total_duration_ms: Date.now() - iterStart,
      });
      return true;
    }

    ctx.emitStatus?.('status_executing_tools', { n: toolCalls.length });
    const toolResults = await executeIterationTools(toolCalls, ctx, iteration, iterStart);
    ctx.messages.push({ role: 'assistant', content: response.content as Anthropic.ContentBlock[] });
    ctx.messages.push({ role: 'user', content: toolResults });
    notifyCallback(ctx.logger, () =>
      ctx.callbacks?.onIterationComplete?.(ctx.responses.join('\n'))
    );
    ctx.logger.log('iteration_end', {
      iteration,
      reason: 'continuing',
      tool_calls_executed: toolCalls.length,
      total_duration_ms: Date.now() - iterStart,
    });
    return false;
  });
}

/** Default code execution timeout in milliseconds (30 seconds) */
const DEFAULT_CODE_EXEC_TIMEOUT_MS = 30_000;

/** Default maximum orchestration iterations */
const DEFAULT_MAX_ITERATIONS = 10;

/**
 * Default whole-request MCP call cap.
 *
 * Counts every MCP tool call across one user turn — top-level tool_use
 * calls plus host-function calls inside any number of execute_code blocks.
 * Defends against runaway fan-out when MAX_ORCHESTRATION_ITERATIONS and
 * cpu_ms are set high enough for many turns to fit in one invocation.
 *
 * 100 = enough for the most call-heavy ptxprint flow we have observed
 * (low double-digit MCP calls per orchestration in current usage), with
 * ~10x headroom before tripping. If a flow legitimately needs more, raise
 * MAX_MCP_CALLS_PER_REQUEST in wrangler.toml — do NOT silently bypass.
 */
const DEFAULT_MAX_MCP_CALLS_PER_REQUEST = 100;

/**
 * Parse and validate an integer environment variable.
 * Returns the parsed value if valid, or the default if missing/invalid.
 * Logs a warning if the value is present but malformed.
 */
function parseIntEnvVar(
  value: string | undefined,
  key: string,
  defaultValue: number,
  logger: RequestLogger
): number {
  if (!value) {
    logger.log('config_default', { key, value: defaultValue });
    return defaultValue;
  }

  const parsed = parseInt(value, 10);
  if (isNaN(parsed) || parsed <= 0) {
    logger.warn('config_invalid', {
      key,
      provided: value,
      reason: isNaN(parsed) ? 'not a number' : 'must be positive',
      using_default: defaultValue,
    });
    return defaultValue;
  }

  return parsed;
}

function parseClaudeConfig(env: Env, logger: RequestLogger) {
  const model = env.CLAUDE_MODEL ?? DEFAULT_MODEL;
  if (!env.CLAUDE_MODEL) {
    logger.log('config_default', { key: 'CLAUDE_MODEL', value: model });
  }
  const maxTokens = parseIntEnvVar(
    env.CLAUDE_MAX_TOKENS,
    'CLAUDE_MAX_TOKENS',
    DEFAULT_MAX_TOKENS,
    logger
  );
  return { model, maxTokens };
}

function parseOrchestrationConfig(env: Env, logger: RequestLogger) {
  const codeExecTimeout = parseIntEnvVar(
    env.CODE_EXEC_TIMEOUT_MS,
    'CODE_EXEC_TIMEOUT_MS',
    DEFAULT_CODE_EXEC_TIMEOUT_MS,
    logger
  );
  const maxIterations = parseIntEnvVar(
    env.MAX_ORCHESTRATION_ITERATIONS,
    'MAX_ORCHESTRATION_ITERATIONS',
    DEFAULT_MAX_ITERATIONS,
    logger
  );
  const maxMcpCalls = parseIntEnvVar(
    env.MAX_MCP_CALLS_PER_EXECUTION,
    'MAX_MCP_CALLS_PER_EXECUTION',
    10,
    logger
  );
  const maxMcpCallsPerRequest = parseIntEnvVar(
    env.MAX_MCP_CALLS_PER_REQUEST,
    'MAX_MCP_CALLS_PER_REQUEST',
    DEFAULT_MAX_MCP_CALLS_PER_REQUEST,
    logger
  );
  return { codeExecTimeout, maxIterations, maxMcpCalls, maxMcpCallsPerRequest };
}

function parseMcpResponseSizeConfig(env: Env, logger: RequestLogger) {
  const maxMcpResponseSize = parseIntEnvVar(
    env.MAX_MCP_RESPONSE_SIZE_BYTES,
    'MAX_MCP_RESPONSE_SIZE_BYTES',
    DEFAULT_MAX_MCP_RESPONSE_SIZE,
    logger
  );
  return { maxMcpResponseSize };
}

function parseEnvConfig(env: Env, logger: RequestLogger) {
  const claudeConfig = parseClaudeConfig(env, logger);
  const orchestrationConfig = parseOrchestrationConfig(env, logger);
  const mcpResponseSizeConfig = parseMcpResponseSizeConfig(env, logger);

  return {
    ...claudeConfig,
    ...orchestrationConfig,
    ...mcpResponseSizeConfig,
  };
}

/**
 * Strip Ulysses-style editor comments (`%%` line / `++…++` span) from every
 * author-supplied content stream just before it is concatenated into the
 * system prompt (#201). Stored documents are never mutated — we work on
 * copies in memory. Unbalanced `++` runs are left literal and logged.
 */
function stripPromptComments(
  values: Required<Record<PromptSlot, string>>,
  languageDocument: string | undefined,
  logger: RequestLogger
): { values: Required<Record<PromptSlot, string>>; languageDocument: string | undefined } {
  const cleanedSlots = { ...values };
  for (const slot of PROMPT_OVERRIDE_SLOTS) {
    // eslint-disable-next-line security/detect-object-injection -- key from PROMPT_OVERRIDE_SLOTS
    const { cleaned, hadUnbalancedSpan } = stripUlyssesComments(values[slot]);
    if (hadUnbalancedSpan) {
      logger.warn('ulysses_unbalanced_span', { source: `prompt_slot:${slot}` });
    }
    // eslint-disable-next-line security/detect-object-injection -- key from PROMPT_OVERRIDE_SLOTS
    cleanedSlots[slot] = cleaned;
  }
  let cleanedLang = languageDocument;
  if (languageDocument !== undefined) {
    const { cleaned, hadUnbalancedSpan } = stripUlyssesComments(languageDocument);
    if (hadUnbalancedSpan) {
      logger.warn('ulysses_unbalanced_span', { source: 'language_document' });
    }
    cleanedLang = cleaned;
  }
  return { values: cleanedSlots, languageDocument: cleanedLang };
}

/** Build the seed `messages` array for an orchestration run. */
function buildSeedMessages(
  userMessage: string,
  options: OrchestratorOptions,
  llmMax: number
): Anthropic.MessageParam[] {
  return [
    ...historyToMessages(options.history, llmMax),
    {
      role: 'user',
      content: options.groupContext?.currentSpeaker
        ? `[${sanitizeSpeaker(options.groupContext.currentSpeaker)}]: ${userMessage}`
        : userMessage,
    },
  ];
}

/**
 * The env-derived execution limits, lifted out of `createOrchestrationContext`
 * so that function stays within the repo's 50-line budget. Pure projection --
 * the field names and values are identical to reading `config` inline.
 */
function executionLimits(
  config: ReturnType<typeof parseEnvConfig>
): Pick<
  OrchestrationContext,
  'codeExecTimeout' | 'maxMcpCalls' | 'maxMcpResponseSize' | 'maxMcpCallsPerRequest'
> {
  return {
    codeExecTimeout: config.codeExecTimeout,
    maxMcpCalls: config.maxMcpCalls,
    maxMcpResponseSize: config.maxMcpResponseSize,
    maxMcpCallsPerRequest: config.maxMcpCallsPerRequest,
  };
}

function createOrchestrationContext(
  userMessage: string,
  options: OrchestratorOptions,
  config: ReturnType<typeof parseEnvConfig>
): OrchestrationContext {
  const { env, catalog, history, preferences, orgConfig, logger, callbacks } = options;
  const locale = preferences.response_language;
  const rawPromptValues = options.resolvedPromptValues ?? DEFAULT_PROMPT_VALUES;
  const { values: promptValues, languageDocument } = stripPromptComments(
    rawPromptValues,
    options.languageDocument,
    logger
  );
  const llmMax = orgConfig?.max_history_llm ?? DEFAULT_ORG_CONFIG.max_history_llm;

  // prettier-ignore
  const systemBlocks = buildSystemPromptBlocks(catalog, preferences, history, promptValues, { memoryTOC: options.memoryTOC, clientId: options.clientId, groupContext: options.groupContext, isVoiceMessage: options.isVoiceMessage, languageDocument, triggerOnly: options.triggerOnly, unmatchedTriggers: options.unmatchedTriggers, addressedToBot: options.addressedToBot, inboundVoiceKey: options.inboundVoiceKey });

  return {
    client: new Anthropic({ apiKey: env.ANTHROPIC_API_KEY }),
    apiKey: env.ANTHROPIC_API_KEY,
    model: config.model,
    maxTokens: config.maxTokens,
    systemStable: systemBlocks.stable,
    systemVolatile: systemBlocks.volatile,
    systemStableHash: fingerprint(systemBlocks.stable),
    activeMode: options.modeContext?.activeModeName,
    tools: buildAllTools(catalog, {
      hasModes: (options.modeContext?.availableModes.length ?? 0) > 0,
    }),
    messages: buildSeedMessages(userMessage, options, llmMax),
    responses: [],
    lastIterationStartIndex: 0,
    ...executionLimits(config),
    mcpCallsMade: { count: 0 },
    turnId: options.turnId,
    telemetry: createTelemetryAccumulator(),
    catalog,
    logger,
    callbacks,
    locale,
    emitStatus: createStatusEmitter(callbacks, locale, logger),
    healthTracker: createHealthTracker(),
    memoryStore: options.memoryStore,
    modeContext: options.modeContext,
    audioContext: options.audioContext,
    attachmentsContext: options.attachmentsContext,
    workerOrigin: options.workerOrigin ?? '',
    org: options.org ?? options.env.DEFAULT_ORG,
    env: options.env,
  };
}

async function runOrchestrationLoop(
  ctx: OrchestrationContext,
  maxIterations: number
): Promise<void> {
  ctx.logger.log('orchestration_loop_start', { max_iterations: maxIterations });
  let lastIteration = -1;
  let exitReason: 'done' | 'max_iterations' = 'max_iterations';
  // Root of the manual span tree: the auto request/DO span → `orchestration` →
  // per-`iteration` → per-`tool_dispatch` (+ auto fetch/binding-I/O children).
  await withSpan('orchestration', { max_iterations: maxIterations }, async () => {
    for (let i = 0; i < maxIterations; i++) {
      lastIteration = i;
      const done = await processIteration(ctx, i);
      if (done) {
        exitReason = 'done';
        break;
      }
    }
  });
  if (exitReason === 'max_iterations') {
    ctx.logger.warn('orchestration_max_iterations_reached', {
      max_iterations: maxIterations,
      last_iteration: lastIteration,
    });
    // User-facing notice for hitting MAX_ORCHESTRATION_ITERATIONS. Without it
    // the user sees only whatever Claude streamed in the final iteration —
    // typically a mid-thought like "Let me fix by adding fontsize too:" — with
    // no sign the bot has stopped (observed live 2026-04-30, request
    // `de4c4d28-…`). Pushed through `onProgress` so it reaches the chat client
    // now, AND appended to `ctx.responses` so it persists in history and the
    // next turn does not see the partial mid-thought as the previous reply.
    // Text: `notice_max_iterations` in `src/i18n/ui-strings.ts`, localized (#405).
    const notice = uiString(ctx.locale, 'notice_max_iterations');
    notifyCallback(ctx.logger, () => ctx.callbacks?.onProgress(notice));
    ctx.responses.push(notice);
  }
  ctx.logger.log('orchestration_loop_end', {
    exit_reason: exitReason,
    last_iteration: lastIteration,
  });
  // Surface the loop's own locals onto the context so they can escape the run.
  // Without this they reach only the metric below, which is a no-op on the
  // alarm-drained path (see UserDO.alarm / runWithMetricsSuppressed).
  ctx.telemetry.iterations = lastIteration + 1;
  ctx.telemetry.exitReason = exitReason;

  // Iterations actually run this request (lastIteration is 0-based), labeled by how
  // the loop exited — bounded reason enum, no ids.
  recordMetric('orchestration_iterations', lastIteration + 1, {
    reason: exitReason,
    model: ctx.model,
    ...(ctx.activeMode ? { mode: ctx.activeMode } : {}),
  });

  // Log health summary at end of orchestration
  logOrchestrationSummary(ctx);
}

function logOrchestrationSummary(ctx: OrchestrationContext): void {
  const healthSummary = getHealthSummary(ctx.healthTracker);

  ctx.logger.log('orchestration_summary', {
    ...(ctx.turnId ? { turn_id: ctx.turnId } : {}),
    iterations: ctx.telemetry.iterations,
    exit_reason: ctx.telemetry.exitReason,
    stop_reason: ctx.telemetry.finalStopReason,
    model: ctx.model,
    mcp_calls_made: ctx.mcpCallsMade.count,
    mcp_calls_limit: ctx.maxMcpCallsPerRequest,
    mcp_calls_pct_of_limit: Math.round((ctx.mcpCallsMade.count / ctx.maxMcpCallsPerRequest) * 100),
    server_health:
      healthSummary.length > 0
        ? healthSummary.map((s) => ({
            server_id: s.serverId,
            healthy: s.healthy,
            total_calls: s.totalCalls,
            failure_rate: Math.round(s.failureRate * 100),
            avg_response_ms: s.averageResponseTimeMs,
          }))
        : undefined,
  });
}

function handleOrchestrationError(error: unknown, logger: RequestLogger): never {
  logger.error('claude_error', error);
  if (error instanceof Anthropic.APIError) {
    throw new ClaudeAPIError(error.message, error.status);
  }
  throw error;
}

/**
 * Placeholder substituted for an empty user turn at the orchestration boundary.
 *
 * See `orchestrate`. Deliberately reads as an instruction rather than as user
 * speech, so a model that receives it produces a sensible clarifying reply
 * instead of hallucinating a question the user never asked.
 */
const EMPTY_MESSAGE_PLACEHOLDER =
  '(The user sent a message with no readable content. Ask them briefly what they need.)';

/**
 * Main orchestration function
 */
export async function orchestrate(
  userMessage: string,
  options: OrchestratorOptions
): Promise<OrchestrationResult> {
  const config = parseEnvConfig(options.env, options.logger);

  // Backstop for #360: the Anthropic API rejects the ENTIRE request when any
  // user turn has empty content ("messages.N: user messages must have
  // non-empty content"), so one empty string here costs the whole turn — the
  // user sees a 502 and no reply. The known producer (trigger-only messages)
  // is fixed upstream in UserDO, but this path has no business trusting its
  // caller for something that fails this loudly and this far from the cause.
  // Logged at error level, never silently: reaching this means an upstream
  // caller has a bug that needs finding.
  let effectiveMessage = userMessage;
  if (userMessage.trim().length === 0) {
    options.logger.error('empty_user_message', new Error('Empty user message at orchestrate()'), {
      client_id: options.clientId ?? null,
      org: options.org ?? null,
      has_trigger_only: !!options.triggerOnly,
      history_length: options.history.length,
    });
    effectiveMessage = EMPTY_MESSAGE_PLACEHOLDER;
  }

  const ctx = createOrchestrationContext(effectiveMessage, options, config);

  ctx.emitStatus?.('status_processing');

  try {
    await runOrchestrationLoop(ctx, config.maxIterations);
  } catch (error) {
    handleOrchestrationError(error, ctx.logger);
  }

  return {
    responses: ctx.responses,
    finalIterationStartIndex: ctx.lastIterationStartIndex,
    telemetry: buildOrchestrationTelemetry(ctx),
  };
}

/** Collapse the mutable accumulator plus static context into the exported shape. */
function buildOrchestrationTelemetry(ctx: OrchestrationContext): OrchestrationTelemetry {
  return {
    model: ctx.model,
    iterations: ctx.telemetry.iterations,
    exitReason: ctx.telemetry.exitReason,
    finalStopReason: ctx.telemetry.finalStopReason,
    usage: ctx.telemetry.usage,
    mcpCallsMade: ctx.mcpCallsMade.count,
    mode: ctx.activeMode,
    modeSwitchedTo: ctx.telemetry.modeSwitchedTo,
    toolCalls: ctx.telemetry.toolCalls,
  };
}

async function executeToolCalls(
  toolCalls: ToolUseBlock[],
  ctx: OrchestrationContext
): Promise<Anthropic.ToolResultBlockParam[]> {
  return Promise.all(toolCalls.map((tc) => executeSingleTool(tc, ctx)));
}

/** Emit the tool-dispatch counter + duration histogram with bounded labels. */
function recordToolCallMetrics(
  toolName: string,
  status: 'success' | 'error',
  durationMs: number,
  errorName?: string
): void {
  recordMetric('tool_call_duration_ms', durationMs, { tool_name: toolName, status });
  countMetric('tool_calls_total', {
    tool_name: toolName,
    status,
    ...(errorName ? { error_name: errorName } : {}),
  });
}

function executeSingleTool(
  toolCall: ToolUseBlock,
  ctx: OrchestrationContext
): Promise<Anthropic.ToolResultBlockParam> {
  // `tool_name`/`tool_id` are allow-listed bounded ids; the tool INPUT is not attached
  // to the span (it can carry user content) — the existing summarized log keeps it.
  // Bound the tool_name METRIC label to the tools actually offered to Claude this
  // request (+ 'unknown' for a name the model invented), so a hallucinated tool name on
  // an error path can't spawn unbounded metric series. Spans/logs keep the raw name —
  // they are per-request events, not aggregated into fixed-cardinality series.
  const metricToolName = ctx.tools.some((t) => t.name === toolCall.name)
    ? toolCall.name
    : 'unknown';
  return withSpan(
    'tool_dispatch',
    { tool_name: toolCall.name, tool_id: toolCall.id },
    async (span) => {
      ctx.logger.log('tool_execution_start', {
        tool_name: toolCall.name,
        tool_id: toolCall.id,
        input: summarizeToolInput(toolCall.name, toolCall.input),
      });
      ctx.callbacks?.onToolUse?.(toolCall.name, toolCall.input);

      const startTime = Date.now();

      try {
        const result = await dispatchToolCall(toolCall, ctx);
        recordToolCallMetrics(metricToolName, 'success', Date.now() - startTime);
        logToolSuccess(ctx, toolCall, startTime);
        ctx.callbacks?.onToolResult?.(toolCall.name, result);
        const serialized = JSON.stringify(result);
        const content = truncateToolResultContent(serialized, toolCall.name);
        if (content.length < serialized.length) {
          ctx.logger.warn('tool_result_truncated', {
            tool_name: toolCall.name,
            original_bytes: serialized.length,
            capped_bytes: DEFAULT_MAX_TOOL_RESULT_BYTES,
          });
        }
        return { type: 'tool_result', tool_use_id: toolCall.id, content };
      } catch (error) {
        // The tool error is handled here (returned to the model as an error result),
        // not thrown, so mark the span explicitly — withSpan only auto-records throws.
        recordSpanError(span, error);
        recordToolCallMetrics(
          metricToolName,
          'error',
          Date.now() - startTime,
          error instanceof Error ? error.name : 'Error'
        );
        return handleToolError(ctx, toolCall, error, startTime);
      }
    }
  );
}

function dispatchPtxprintTool(
  toolCall: ToolUseBlock,
  ctx: OrchestrationContext
): Promise<unknown> | null {
  if (toolCall.name === 'generate_scripture_pdf')
    return dispatchGenerateScripturePdf(toolCall, ctx);
  if (toolCall.name === 'prepare_usfm_source') return dispatchPrepareUsfmSource(toolCall, ctx);
  return null;
}

function dispatchSimpleInternalTool(
  toolCall: ToolUseBlock,
  ctx: OrchestrationContext
): Promise<unknown> | unknown | null {
  if (toolCall.name === 'read_memory') return handleReadMemory(toolCall.input, ctx);
  if (toolCall.name === 'update_memory') return handleUpdateMemory(toolCall.input, ctx);
  if (toolCall.name === 'request_audio') return handleRequestAudio(ctx);
  if (toolCall.name === 'list_modes') return handleListModes(ctx);
  if (toolCall.name === 'switch_mode') return handleSwitchMode(toolCall.input, ctx);
  if (toolCall.name === 'read_r2_object') return handleReadR2Object(toolCall.input, ctx);
  if (toolCall.name === 'attach_audio') return handleAttachAudio(toolCall.input, ctx);
  return null;
}

async function dispatchToolCall(
  toolCall: ToolUseBlock,
  ctx: OrchestrationContext
): Promise<unknown> {
  if (toolCall.name === 'execute_code') {
    if (!isExecuteCodeInput(toolCall.input)) {
      throw new ValidationError(
        `Invalid input for execute_code: expected { code: string }, got ${truncateInput(toolCall.input)}`
      );
    }
    return handleExecuteCode(toolCall.input, ctx);
  }
  if (toolCall.name === 'get_tool_definitions') {
    if (!isGetToolDefinitionsInput(toolCall.input)) {
      throw new ValidationError(
        `Invalid input for get_tool_definitions: expected { tool_names: string[] }, got ${truncateInput(toolCall.input)}`
      );
    }
    return getToolDefinitions(ctx.catalog, toolCall.input.tool_names);
  }
  const simpleResult = dispatchSimpleInternalTool(toolCall, ctx);
  if (simpleResult !== null) return simpleResult;
  const ptxprintResult = dispatchPtxprintTool(toolCall, ctx);
  if (ptxprintResult) return ptxprintResult;
  return handleMCPToolCall(toolCall.name, toolCall.input, ctx);
}

function buildPtxprintCtx(ctx: OrchestrationContext) {
  return {
    env: ctx.env,
    catalog: ctx.catalog,
    workerOrigin: ctx.workerOrigin,
    attachmentsContext: ctx.attachmentsContext,
    logger: ctx.logger,
  };
}

async function dispatchGenerateScripturePdf(
  toolCall: ToolUseBlock,
  ctx: OrchestrationContext
): Promise<unknown> {
  if (!isGenerateScripturePdfInput(toolCall.input)) {
    throw new ValidationError(
      `Invalid input for generate_scripture_pdf: expected { translation: string, book: string, preset?: string }, got ${truncateInput(toolCall.input)}`
    );
  }
  return handleGenerateScripturePdf(toolCall.input, buildPtxprintCtx(ctx));
}

async function dispatchPrepareUsfmSource(
  toolCall: ToolUseBlock,
  ctx: OrchestrationContext
): Promise<unknown> {
  if (!isPrepareUsfmSourceInput(toolCall.input)) {
    throw new ValidationError(
      `Invalid input for prepare_usfm_source: expected { translation: string, book: string }, got ${truncateInput(toolCall.input)}`
    );
  }
  return handlePrepareUsfmSource(toolCall.input, buildPtxprintCtx(ctx));
}

async function handleReadMemory(input: unknown, ctx: OrchestrationContext): Promise<unknown> {
  if (!ctx.memoryStore) {
    return { error: 'Memory is not available for this session.' };
  }
  if (!isReadMemoryInput(input)) {
    throw new ValidationError(
      `Invalid input for read_memory: expected { sections?: string[] }, got ${truncateInput(input)}`
    );
  }
  const startTime = Date.now();
  const sections = input.sections?.length ? input.sections : undefined;
  const result = await ctx.memoryStore.read(sections);
  const sizeBytes = await ctx.memoryStore.getSizeBytes();
  const capacityPercent = Math.min(100, Math.round((sizeBytes / MAX_MEMORY_SIZE_BYTES) * 100));

  ctx.logger.log('memory_tool_dispatch', {
    tool_name: 'read_memory',
    input_summary: sections ? `sections: [${sections.join(', ')}]` : 'full',
    duration_ms: Date.now() - startTime,
  });

  if (typeof result === 'string') {
    const size = new TextEncoder().encode(result).byteLength;
    return { content: result, total_size_bytes: size, capacityPercent };
  }
  const totalSize = new TextEncoder().encode(JSON.stringify(result)).byteLength;
  return { sections: result, total_size_bytes: totalSize, capacityPercent };
}

/**
 * Recover from a known model-drift pattern: sometimes the model calls
 * update_memory with `sections` as a JSON-stringified object instead of an
 * object literal. When we detect that, parse the string and swap it in so the
 * strict validator can apply all other invariants. Emit a warn log so drift
 * stays observable; if the string is unparseable, throw a targeted
 * ValidationError (more useful to the retrying model than the generic one).
 *
 * Exported for unit testing. Takes only the logger so tests don't need to
 * construct a full OrchestrationContext.
 */
/**
 * Build recovery attempts for a stringified JSON sections value.
 * The model commonly: (a) stringifies correctly, (b) appends trailing whitespace,
 * or (c) loses brace-depth and adds 1-3 extra trailing `}` characters.
 */
function buildJsonRecoveryAttempts(raw: string): Array<{ label: string; value: string }> {
  const attempts: Array<{ label: string; value: string }> = [
    { label: 'raw', value: raw },
    { label: 'trimmed', value: raw.trim() },
  ];
  let stripped = raw.trim();
  for (let i = 0; i < 3 && stripped.endsWith('}'); i++) {
    const candidate = stripped.slice(0, -1);
    if (candidate.includes('}')) {
      attempts.push({ label: `strip_trailing_brace_${i + 1}`, value: candidate });
    }
    stripped = candidate;
  }
  return attempts;
}

export function coerceStringifiedSections(input: unknown, logger: RequestLogger): unknown {
  if (
    typeof input !== 'object' ||
    input === null ||
    !('sections' in input) ||
    typeof (input as { sections: unknown }).sections !== 'string'
  ) {
    return input;
  }
  const rawSections = (input as { sections: string }).sections;

  for (const { label, value } of buildJsonRecoveryAttempts(rawSections)) {
    try {
      const parsed: unknown = JSON.parse(value);
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        logger.warn('update_memory_sections_coerced_from_string', {
          reason: 'model sent sections as JSON string; auto-parsed before validation',
          raw_length: rawSections.length,
          recovery: label,
        });
        return { ...(input as object), sections: parsed };
      }
    } catch {
      // try next strategy
    }
  }

  logger.log('update_memory_sections_coerce_parse_failed', {
    error: 'all recovery strategies failed',
    raw_length: rawSections.length,
  });
  throw new ValidationError(
    'Invalid input for update_memory: `sections` must be a JSON object, not a JSON string. Pass the object directly; do not call JSON.stringify on it.'
  );
}

async function handleUpdateMemory(input: unknown, ctx: OrchestrationContext): Promise<unknown> {
  if (!ctx.memoryStore) {
    return { error: 'Memory is not available for this session.' };
  }
  const coerced = coerceStringifiedSections(input, ctx.logger);
  if (!isUpdateMemoryInput(coerced)) {
    throw new ValidationError(
      `Invalid input for update_memory: expected { sections: Record<string, string|null>, pin?: string[], unpin?: string[] }, got ${truncateInput(input)}`
    );
  }
  const startTime = Date.now();
  const result = await ctx.memoryStore.writeSections(coerced.sections, coerced.pin, coerced.unpin);

  ctx.logger.log('memory_tool_dispatch', {
    tool_name: 'update_memory',
    input_summary: `updated: [${result.updated.join(', ')}], deleted: [${result.deleted.join(', ')}], evicted: [${result.evicted.join(', ')}]`,
    duration_ms: Date.now() - startTime,
  });

  return result;
}

/**
 * Verify that an R2 key passed to `read_r2_object` / `attach_audio` belongs
 * to the current org's voice-submissions namespace. Returns `null` when the
 * key is in scope; otherwise returns an error envelope (logged at WARN per
 * CLAUDE.md "no silent swallow"). Cross-org reads are rejected here; reads
 * of TTS-output keys (`audio/...`) are also rejected — those aren't voice
 * submissions, they're synthesized response audio, and there's no current
 * use case for Claude to fetch them.
 */
function checkVoiceSubmissionScope(
  toolName: string,
  r2Key: string,
  ctx: OrchestrationContext
): { error: string } | null {
  const expectedPrefix = `${VOICE_SUBMISSION_PREFIX}/${ctx.org}/`;
  if (!r2Key.startsWith(expectedPrefix)) {
    ctx.logger.warn('r2_key_out_of_scope', {
      tool: toolName,
      r2_key: r2Key,
      org: ctx.org,
      reason: !r2Key.startsWith(`${VOICE_SUBMISSION_PREFIX}/`)
        ? 'not-a-voice-submission-prefix'
        : 'wrong-org',
    });
    return {
      error: `r2_key is out of scope for this request. Keys must begin with \`${expectedPrefix}\`.`,
    };
  }
  return null;
}

function handleReadR2Object(input: unknown, ctx: OrchestrationContext): unknown {
  if (!isR2KeyInput(input)) {
    throw new ValidationError(
      `Invalid input for read_r2_object: expected { r2_key: string }, got ${truncateInput(input)}`
    );
  }
  const scopeError = checkVoiceSubmissionScope('read_r2_object', input.r2_key, ctx);
  if (scopeError) return scopeError;
  const url = voiceSubmissionKeyToUrl(input.r2_key, ctx.workerOrigin);
  ctx.logger.log('read_r2_object_tool_called', { r2_key: input.r2_key });
  return { url, r2_key: input.r2_key };
}

async function handleAttachAudio(input: unknown, ctx: OrchestrationContext): Promise<unknown> {
  if (!isR2KeyInput(input)) {
    throw new ValidationError(
      `Invalid input for attach_audio: expected { r2_key: string }, got ${truncateInput(input)}`
    );
  }
  const scopeError = checkVoiceSubmissionScope('attach_audio', input.r2_key, ctx);
  if (scopeError) return scopeError;
  if (!ctx.attachmentsContext) {
    ctx.logger.warn('attach_audio_no_attachments_context', {
      reason: 'attachmentsContext is undefined; audio cannot be surfaced on ChatResponse',
      r2_key: input.r2_key,
    });
    return {
      error:
        'Audio attachments are not available for this session — the request context is missing the attachments side-channel.',
    };
  }
  const url = voiceSubmissionKeyToUrl(input.r2_key, ctx.workerOrigin);
  const mimeType = await lookupVoiceSubmissionMimeType(input.r2_key, ctx);
  ctx.attachmentsContext.add({
    type: 'audio',
    url,
    r2_key: input.r2_key,
    mime_type: mimeType,
  });
  ctx.logger.log('attach_audio_tool_called', { r2_key: input.r2_key, url, mime_type: mimeType });
  return {
    attached: true,
    url,
    r2_key: input.r2_key,
    mime_type: mimeType,
    note: 'The audio object has been attached to the response and will be delivered to the user alongside any text/TTS output.',
  };
}

/**
 * Look up the actual content-type stored alongside a voice-submission R2
 * object so the AudioAttachment carries the real MIME instead of a hardcoded
 * default. Inbound voice messages can arrive in several supported formats
 * (`ogg`, `mp3`, `wav`, `webm`, `flac`, `m4a`) and the archival path stores
 * each with the source content-type — we must surface that to the client so
 * downstream players pick the right decoder.
 *
 * Falls back to `audio/ogg` only when the HEAD fails, the object is missing,
 * or the stored content-type is empty. Each fallback logs a WARN per
 * CLAUDE.md "no silent swallow."
 */
async function lookupVoiceSubmissionMimeType(
  r2Key: string,
  ctx: OrchestrationContext
): Promise<string> {
  const fallback = 'audio/ogg';
  try {
    const head = await ctx.env.AUDIO_BUCKET.head(r2Key);
    if (!head) {
      ctx.logger.warn('attach_audio_r2_head_miss', {
        r2_key: r2Key,
        reason: 'object not found; falling back to audio/ogg',
      });
      return fallback;
    }
    const contentType = head.httpMetadata?.contentType;
    if (typeof contentType !== 'string' || contentType.length === 0) {
      ctx.logger.warn('attach_audio_r2_head_no_content_type', {
        r2_key: r2Key,
        reason: 'object stored without contentType metadata; falling back to audio/ogg',
      });
      return fallback;
    }
    return contentType;
  } catch (error) {
    ctx.logger.warn('attach_audio_r2_head_failed', {
      r2_key: r2Key,
      error: error instanceof Error ? error.message : String(error),
      reason: 'R2 HEAD threw; falling back to audio/ogg',
    });
    return fallback;
  }
}

function handleRequestAudio(ctx: OrchestrationContext): unknown {
  if (!ctx.audioContext) {
    ctx.logger.warn('request_audio_no_context', { reason: 'audioContext is undefined' });
    return { error: 'Audio responses are not available for this session.' };
  }
  ctx.audioContext.requestAudio();
  ctx.logger.log('request_audio_tool_called', { audioRequested: true });
  return `Audio response requested. Your text response will be converted to speech. ${VOICE_WRITING_RULES}`;
}

function handleListModes(ctx: OrchestrationContext): unknown {
  if (!ctx.modeContext) {
    return { modes: [], active_mode: null };
  }
  return {
    modes: ctx.modeContext.availableModes.map((m) => ({
      name: m.name,
      label: m.label ?? m.name,
      description: m.description ?? null,
    })),
    active_mode: ctx.modeContext.activeModeName ?? null,
  };
}

async function handleSwitchMode(input: unknown, ctx: OrchestrationContext): Promise<unknown> {
  if (!ctx.modeContext) {
    return { error: 'Modes are not configured for this organization.' };
  }
  if (!isSwitchModeInput(input)) {
    throw new ValidationError(
      `Invalid input for switch_mode: expected { mode: string | null }, got ${truncateInput(input)}`
    );
  }

  const { mode } = input;

  // Clearing mode selection
  if (mode === null) {
    await ctx.modeContext.setSelectedMode(null);
    ctx.telemetry.modeSwitchedTo = MODE_CLEARED;
    ctx.logger.log('mode_tool_dispatch', { tool_name: 'switch_mode', mode: null });
    return { success: true, mode: null, message: 'Mode cleared. Using default settings.' };
  }

  // Validate mode exists. findModeBySlug also matches aliases (issue #284), so a
  // saved script or user typing an old slug still resolves to the renamed mode.
  const found = findModeBySlug(ctx.modeContext.availableModes, mode);
  if (!found) {
    const available = ctx.modeContext.availableModes.map((m) => m.name).join(', ');
    return {
      error: `Mode '${mode}' not found.${available ? ` Available modes: ${available}` : ' No modes are configured.'}`,
    };
  }

  // Persist the canonical name, not the requested slug, so an alias selection is
  // normalized in storage immediately.
  await ctx.modeContext.setSelectedMode(found.name);
  ctx.telemetry.modeSwitchedTo = found.name;
  ctx.logger.log('mode_tool_dispatch', {
    tool_name: 'switch_mode',
    mode: found.name,
    ...(found.name !== mode ? { requested_slug: mode } : {}),
  });

  const label = found.label ?? found.name;
  return {
    success: true,
    mode: found.name,
    message: `Switched to ${label} mode. This will take effect on your next message.`,
  };
}

/** MCP server that owns `toolName`, or null for a host tool. */
function serverIdForTool(ctx: OrchestrationContext, toolName: string): string | null {
  return ctx.catalog.tools.find((t) => t.name === toolName)?.serverId ?? null;
}

/**
 * Remember one tool call for the turn record (`chat_turn.tool_calls`). Capped
 * so a runaway loop cannot bloat the log line; `mcpCallsMade` still counts all.
 */
function recordToolCall(
  ctx: OrchestrationContext,
  toolCall: ToolUseBlock,
  startTime: number,
  ok: boolean
): void {
  if (ctx.telemetry.toolCalls.length >= MAX_TOOL_CALL_RECORDS) return;
  ctx.telemetry.toolCalls.push({
    name: toolCall.name,
    server_id: serverIdForTool(ctx, toolCall.name),
    started_at: startTime,
    duration_ms: Date.now() - startTime,
    ok,
  });
}

function logToolSuccess(
  ctx: OrchestrationContext,
  toolCall: ToolUseBlock,
  startTime: number
): void {
  recordToolCall(ctx, toolCall, startTime, true);
  ctx.logger.log('tool_execution_complete', {
    tool_name: toolCall.name,
    tool_id: toolCall.id,
    input: summarizeToolInput(toolCall.name, toolCall.input),
    duration_ms: Date.now() - startTime,
    success: true,
  });
}

function handleToolError(
  ctx: OrchestrationContext,
  toolCall: ToolUseBlock,
  error: unknown,
  startTime: number
): Anthropic.ToolResultBlockParam {
  const errorMessage = error instanceof Error ? error.message : 'Unknown error';
  recordToolCall(ctx, toolCall, startTime, false);
  ctx.logger.error('tool_execution_error', error, {
    tool_name: toolCall.name,
    tool_id: toolCall.id,
    input: redactToolInputForError(toolCall.input),
    duration_ms: Date.now() - startTime,
  });
  ctx.callbacks?.onToolResult?.(toolCall.name, { error: errorMessage });
  return {
    type: 'tool_result',
    tool_use_id: toolCall.id,
    content: JSON.stringify({ error: errorMessage }),
    is_error: true,
  };
}

/**
 * Internal tools that are safe and useful from inside the execute_code sandbox.
 *
 * Curated list — most internal tools are inappropriate for sandbox calls:
 *  - `request_audio` toggles output mode (response-shape side effect, not a value).
 *  - `read_memory` / `update_memory` are durable user state; sandbox computation
 *    should not write through.
 *  - `generate_scripture_pdf` is the no-sandbox happy path; if Claude is in the
 *    sandbox doing custom work it has explicitly chosen to bypass the macro.
 *  - `get_tool_definitions` / `execute_code` itself are top-level only.
 *
 * `prepare_usfm_source` is a pure (translation, book) → source-spec resolver.
 * It is exactly the shape Claude needs while assembling a custom payload for
 * the raw `submit_typeset` MCP tool, so we expose it inside the sandbox.
 */
const SANDBOX_INTERNAL_TOOLS = ['prepare_usfm_source'] as const;

function isSandboxInternalTool(name: string): boolean {
  return (SANDBOX_INTERNAL_TOOLS as readonly string[]).includes(name);
}

async function dispatchSandboxInternalTool(
  name: string,
  args: unknown,
  ctx: OrchestrationContext
): Promise<unknown> {
  if (name === 'prepare_usfm_source') {
    if (!isPrepareUsfmSourceInput(args)) {
      throw new ValidationError(
        `Invalid input for prepare_usfm_source: expected { translation: string, book: string }, got ${truncateInput(args)}`
      );
    }
    return handlePrepareUsfmSource(args, buildPtxprintCtx(ctx));
  }
  throw new ValidationError(`Unknown sandbox-internal tool: ${name}`);
}

async function handleExecuteCode(
  input: { code: string },
  ctx: OrchestrationContext
): Promise<unknown> {
  const mcpToolNames = getToolNames(ctx.catalog);
  const toolNames = [...mcpToolNames, ...SANDBOX_INTERNAL_TOOLS];
  const toolCaller = async (name: string, args: unknown): Promise<unknown> => {
    if (isSandboxInternalTool(name)) {
      return dispatchSandboxInternalTool(name, args, ctx);
    }
    return handleMCPToolCall(name, args, ctx);
  };
  const hostFunctions = createMCPHostFunctions(toolCaller, toolNames);

  const result = await executeCode(
    input.code,
    { timeout_ms: ctx.codeExecTimeout, hostFunctions, maxMcpCalls: ctx.maxMcpCalls },
    ctx.logger
  );

  if (!result.success) {
    // Handle MCP call limit exceeded with structured error and guidance
    if (result.errorCode === 'MCP_CALL_LIMIT_EXCEEDED') {
      ctx.logger.log('tool_result_limit_error', {
        tool_name: 'execute_code',
        calls_made: result.callsMade,
        limit: result.callLimit,
        suggestion_sent: true,
      });
      return {
        error: result.error,
        errorCode: result.errorCode,
        callsMade: result.callsMade,
        limit: result.callLimit,
        logs: result.logs,
        suggestion:
          `You made ${result.callsMade} MCP calls but the limit is ${result.callLimit}. ` +
          'Ask user to narrow scope, or fetch summary instead of individual items. ' +
          'Offer to continue in batches.',
      };
    }
    return { error: result.error, logs: result.logs };
  }
  return { result: result.result, logs: result.logs, duration_ms: result.duration_ms };
}

function validateMCPToolCall(toolName: string, ctx: OrchestrationContext) {
  const tool = ctx.catalog.tools.find((t) => t.name === toolName);
  if (!tool) {
    throw new ValidationError(`Unknown tool: ${toolName}`);
  }

  const server = ctx.catalog.serverMap.get(tool.serverId);
  if (!server) {
    throw new MCPError(`Server not found for tool: ${toolName}`, tool.serverId);
  }

  return { tool, server };
}

function checkServerHealth(toolName: string, serverId: string, ctx: OrchestrationContext): void {
  if (!isServerHealthy(ctx.healthTracker, serverId)) {
    ctx.logger.warn('mcp_server_unhealthy', { tool_name: toolName, server_id: serverId });
    throw new MCPError(
      `Server ${serverId} is currently unhealthy (too many consecutive failures)`,
      serverId
    );
  }
}

/**
 * Enforce the whole-request MCP call cap. Counts ACTUAL MCP tool calls,
 * with no inference about what each MCP server does downstream — one
 * MCP call increments the counter by exactly one regardless of whether
 * the server makes 0, 1, or 100 internal API calls under the hood.
 *
 * Increments BEFORE the call so a denied call never reaches the network.
 * The thrown error message tells Claude this is the per-request cap (not
 * a per-execute_code cap), so it does not try to bypass by splitting work
 * across multiple sandbox blocks.
 */
function checkAndCountRequestMCPCall(toolName: string, ctx: OrchestrationContext): void {
  ctx.mcpCallsMade.count++;
  if (ctx.mcpCallsMade.count > ctx.maxMcpCallsPerRequest) {
    ctx.logger.warn('mcp_request_call_limit_exceeded', {
      tool_name: toolName,
      calls_made: ctx.mcpCallsMade.count,
      limit: ctx.maxMcpCallsPerRequest,
    });
    throw new MCPRequestCallLimitError(ctx.mcpCallsMade.count, ctx.maxMcpCallsPerRequest);
  }
}

async function handleMCPToolCall(
  toolName: string,
  input: unknown,
  ctx: OrchestrationContext
): Promise<unknown> {
  const { server } = validateMCPToolCall(toolName, ctx);
  checkServerHealth(toolName, server.id, ctx);
  checkAndCountRequestMCPCall(toolName, ctx);

  const callResult = await callMCPTool(server, toolName, input, ctx.logger, {
    healthTracker: ctx.healthTracker,
    maxResponseSizeBytes: ctx.maxMcpResponseSize,
  });

  return callResult.result;
}
