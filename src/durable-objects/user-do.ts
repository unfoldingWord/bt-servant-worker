/**
 * UserDO — Unified per-user Durable Object
 *
 * Merges the former UserSession (chat processing, state) and UserQueue
 * (message queuing, SSE relay) into a single DO. This eliminates the
 * DO-to-DO chain that caused Cloudflare error 1003 on outbound fetch to
 * api.anthropic.com.
 *
 * Architecture: Worker → UserDO → Anthropic API (depth 2, always works)
 *
 * All chat requests flow through an internal FIFO queue processed by the
 * alarm() handler. SSE clients hold an open connection while their message
 * waits in the queue; callback clients get 202 immediately.
 */

import { Hono } from 'hono';
import { Env } from '../config/types.js';
import {
  GroupChatContext,
  orchestrate,
  OrchestrationResult,
  TriggerOnlyContext,
} from '../services/claude/index.js';
import { formatTOCForPrompt, JsonMemoryStore } from '../services/memory/index.js';
import { buildToolCatalog, discoverAllTools } from '../services/mcp/index.js';
import { MCPServerConfig } from '../services/mcp/types.js';
import {
  createWebhookCallbacks,
  DEFAULT_PROGRESS_MODE,
  DEFAULT_THROTTLE_SECONDS,
  ProgressCallbackSender,
} from '../services/progress/index.js';
import {
  Attachment,
  ChatHistoryEntry,
  ChatHistoryResponse,
  ChatRequest,
  ChatResponse,
  ChatTransport,
  SSEEvent,
  StoredIdentity,
  StreamCallbacks,
  UpdatePreferencesRequest,
  UserPreferencesAPI,
  UserPreferencesInternal,
} from '../types/engine.js';
import { DEFAULT_ORG_CONFIG, OrgConfig } from '../types/org-config.js';
import {
  DEFAULT_PROMPT_VALUES,
  isModeVisible,
  ModeContext,
  mergePromptOverrides,
  PROMPT_OVERRIDE_SLOTS,
  PromptMode,
  PromptOverrides,
  resolveActiveModeName,
  resolvePromptOverrides,
  validateModeName,
  validatePromptOverrides,
} from '../types/prompt-overrides.js';
import { resolveEffectiveMode } from '../types/mode-markdown.js';
import {
  transcribeAudio,
  synthesizeSpeech,
  AudioContext,
  generateAudioKey,
  audioKeyToUrl,
  uploadAudio,
  generateVoiceSubmissionKey,
  uploadVoiceSubmission,
  voiceSubmissionKeyToUrl,
  normalizeAudioFormat,
} from '../services/audio/index.js';
import { AttachmentsContext, createAttachmentsContext } from '../services/ptxprint/index.js';
import { AppError, AudioTranscriptionError, ValidationError } from '../utils/errors.js';
import { createRequestLogger, RequestLogger, withEndpointLogging } from '../utils/logger.js';
import { countryFromPhoneUserId } from '../utils/phone-country.js';
import { applyTemplateVariables } from '../utils/template.js';
import { createTimingContext, timePhase, TimingContext } from '../utils/timing.js';
import {
  initLogTelemetry,
  flushLogTelemetry,
  initMetricTelemetry,
  flushMetricTelemetry,
  countMetric,
  runWithMetricsSuppressed,
  withSpan,
  withUserPseudonym,
  type MetricLabels,
} from '../services/telemetry/index.js';
import { classifyTriggers, ClassifierResult } from '../services/classifier/index.js';
import type { UnmatchedTrigger } from '../services/classifier/index.js';
import {
  detectWrittenLanguage,
  DetectedLanguage,
  UNDETERMINED_LANGUAGE,
} from '../services/language/index.js';
import { isAdminClient, isValidLanguageCode, validateChatBody } from '../utils/chat-validation.js';
import { OrgLanguages, resolveEffectiveLanguage } from '../types/languages.js';
import { InternalQueueEntry } from '../types/queue.js';
import { statusUpdate, uiString } from '../i18n/ui-strings.js';
import { createStatusEmitter, StatusEmitter } from '../i18n/status-emitter.js';

// ── Storage keys ───────────────────────────────────────────────────────────────
const HISTORY_KEY = 'history';
const IDENTITY_KEY = 'identity';
const PREFERENCES_KEY = 'preferences';
const PROMPT_OVERRIDES_KEY = 'prompt_overrides';
const SELECTED_MODE_KEY = 'selected_mode';
const SELECTED_LANGUAGE_KEY = 'selected_language';
const PROCESSING_LOCK_KEY = '_processing_lock';
const QUEUE_KEY = 'queue';
const QUEUE_PROCESSING_KEY = 'queue_processing';

// ── Constants ──────────────────────────────────────────────────────────────────
const LOCK_STALE_THRESHOLD_MS = 90_000; // 90 seconds
const DEFAULT_MAX_QUEUE_DEPTH = 50;
const DEFAULT_MAX_RETRIES = 3;
const ENQUEUE_RATE_WINDOW_MS = 60_000; // 1 minute
const ENQUEUE_RATE_LIMIT = 300;
const SSE_KEEPALIVE_INTERVAL_MS = 30_000; // 30 seconds

const DEFAULT_PREFERENCES: UserPreferencesInternal = {
  response_language: 'en',
  first_interaction: true,
};

function createErrorResponse(
  error: string,
  code: string,
  message: string,
  status: number
): Response {
  return Response.json({ error, code, message }, { status });
}

function storageErrorResponse(err: unknown): Response {
  const msg = err instanceof Error ? err.message : String(err);
  return createErrorResponse('Storage error', 'INTERNAL_ERROR', msg, 500);
}

/** Decode a base64 string to a Uint8Array. Throws on invalid input. */
function decodeBase64(base64: string): Uint8Array {
  const binary = atob(base64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Map an inbound audio format ID to its IANA MIME type. Accepts both bare
 * extension form (`ogg`) and MIME form (`audio/ogg`) so the Telegram gateway
 * (which sends MIME) and any future bare-extension caller both produce the
 * right content-type for R2 archival. Unknown formats fall back to a generic
 * octet-stream.
 */
function audioFormatToMime(format: string): string {
  const normalized = normalizeAudioFormat(format);
  if (normalized === null) return 'application/octet-stream';
  // eslint-disable-next-line security/detect-object-injection -- normalized is constrained to AudioFormat
  return AUDIO_FORMAT_MIME_MAP[normalized] ?? 'application/octet-stream';
}

const AUDIO_FORMAT_MIME_MAP: Readonly<Record<string, string>> = Object.freeze({
  ogg: 'audio/ogg',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  webm: 'audio/webm',
  flac: 'audio/flac',
  m4a: 'audio/mp4',
});

export type ModePersistenceAction =
  { kind: 'put'; mode: string } | { kind: 'delete' } | { kind: 'none' };

/**
 * Decide whether a classifier turn should persist or clear the user's selected
 * mode in DO storage. Pure: no I/O, no logging — caller dispatches the action.
 */
export function decideModePersistence(
  classified: { clearMode: boolean },
  priorActiveModeName: string | undefined,
  newEffectiveModeName: string | undefined
): ModePersistenceAction {
  if (classified.clearMode) {
    return priorActiveModeName ? { kind: 'delete' } : { kind: 'none' };
  }
  if (newEffectiveModeName && newEffectiveModeName !== priorActiveModeName) {
    return { kind: 'put', mode: newEffectiveModeName };
  }
  return { kind: 'none' };
}

export type LanguagePersistenceAction =
  { kind: 'put'; language: string } | { kind: 'delete' } | { kind: 'none' };

/**
 * Decide whether a classifier turn should persist or clear the user's selected
 * language in DO storage. Pure: no I/O, no logging — caller dispatches the
 * action. Parallel to `decideModePersistence`; kept as a sibling function
 * rather than a shared abstraction because mode and language flows diverge
 * downstream (mode short-circuits resolution when the trigger matches the
 * persisted mode; language always re-resolves to materialise the document).
 */
export function decideLanguagePersistence(
  classified: { clearLanguage: boolean },
  priorActiveLanguageName: string | undefined,
  newEffectiveLanguageName: string | undefined
): LanguagePersistenceAction {
  if (classified.clearLanguage) {
    return priorActiveLanguageName ? { kind: 'delete' } : { kind: 'none' };
  }
  if (newEffectiveLanguageName && newEffectiveLanguageName !== priorActiveLanguageName) {
    return { kind: 'put', language: newEffectiveLanguageName };
  }
  return { kind: 'none' };
}

/** Where the turn's requested language came from (rung of the cascade). */
export type LanguageSource = 'trigger' | 'persisted' | 'org_default' | 'none';

/**
 * Per-turn language/trigger context handed to the orchestrator.
 *
 * Grouped rather than passed positionally: `buildOrchOpts` already takes
 * enough trailing optionals that two more adjacent ones would be easy to
 * transpose at the call site.
 */
export interface LanguageOrchestrationContext {
  /** Set when the user's whole message was routing tokens (#360). */
  triggerOnly?: TriggerOnlyContext | undefined;
}

/**
 * Describe a turn whose message was nothing but routing tokens, or `undefined`
 * when the turn has real content for the orchestrator to answer.
 *
 * Only reports what changed on THIS turn: an `@hindi` sent while a mode is
 * already active must not claim the mode was just switched, so the applied
 * selections are gated on the classifier's own signals rather than read off the
 * resulting active state.
 *
 * A message that is empty for any OTHER reason (blank input, whitespace only)
 * returns `undefined` — no tokens resolved, so there is nothing to confirm —
 * and is caught by the empty-message backstop in `orchestrate()` instead.
 */
export function buildTriggerOnlyContext(
  classified: ClassifierResult,
  active: { modeLabel: string | undefined; languageLabel: string | undefined }
): TriggerOnlyContext | undefined {
  if (classified.strippedMessage.trim().length > 0) return undefined;

  const triggerOnly: TriggerOnlyContext = {};
  if (classified.modeName && active.modeLabel) triggerOnly.mode = active.modeLabel;
  if (classified.languageName && active.languageLabel) {
    triggerOnly.language = active.languageLabel;
  }
  if (classified.clearMode) triggerOnly.clearedMode = true;
  if (classified.clearLanguage) triggerOnly.clearedLanguage = true;

  return Object.keys(triggerOnly).length > 0 ? triggerOnly : undefined;
}

/**
 * Pick the text sent onward as the user turn.
 *
 * The whole of #360: a trigger-only message strips to `''`, and an empty user
 * turn makes the Anthropic API reject the entire request, so the raw text the
 * user typed is sent instead. Every other turn uses the stripped message, which
 * is what keeps resolved routing tokens out of the model's view.
 */
export function resolveTurnMessage(
  rawMessage: string,
  classified: ClassifierResult,
  triggerOnly: TriggerOnlyContext | undefined
): string {
  return triggerOnly ? rawMessage : classified.strippedMessage;
}

/**
 * Select the requested language name for a turn by walking the cascade:
 * `@`-trigger → per-user persisted selection → org default (worker#356).
 * Pure: no I/O, no logging. The org default is a fallback only — callers
 * must never persist it per-user (default-riding users track org-level
 * changes live). An empty-string default (drifted KV state) is treated as
 * absent rather than resolved to a guaranteed `missing` warn.
 */
export function selectRequestedLanguage(
  triggerLanguageName: string | undefined,
  selectedLanguageName: string | undefined,
  defaultLanguageName: string | undefined
): { requestedName: string | undefined; source: LanguageSource } {
  if (triggerLanguageName !== undefined) {
    return { requestedName: triggerLanguageName, source: 'trigger' };
  }
  if (selectedLanguageName !== undefined) {
    return { requestedName: selectedLanguageName, source: 'persisted' };
  }
  if (defaultLanguageName) {
    return { requestedName: defaultLanguageName, source: 'org_default' };
  }
  return { requestedName: undefined, source: 'none' };
}

function logModePersistenceChange(
  logger: RequestLogger,
  action: ModePersistenceAction,
  priorMode: string | undefined
): void {
  if (action.kind === 'put') {
    logger.log('mode_persisted_from_hashtag', {
      prior_mode: priorMode ?? null,
      new_mode: action.mode,
      source: 'hashtag',
    });
  } else if (action.kind === 'delete') {
    logger.log('mode_cleared_from_hashtag', {
      prior_mode: priorMode ?? null,
      source: 'hashtag',
    });
  }
}

function logLanguagePersistenceChange(
  logger: RequestLogger,
  action: LanguagePersistenceAction,
  priorLanguage: string | undefined
): void {
  if (action.kind === 'put') {
    logger.log('language_persisted_from_trigger', {
      prior_language: priorLanguage ?? null,
      new_language: action.language,
      source: 'trigger',
    });
  } else if (action.kind === 'delete') {
    logger.log('language_cleared_from_trigger', {
      prior_language: priorLanguage ?? null,
      source: 'trigger',
    });
  }
}

/**
 * Fail-closed shape guard for the edge country before it becomes a metric
 * label. `cf.country` is Cloudflare-controlled (ISO 3166 alpha-2 plus the
 * `T1`/`XX` sentinels), and the worker always overwrites any client-supplied
 * value — this is defense in depth so a malformed value can never open an
 * unbounded label dimension.
 */
function isCountryCode(value: string | undefined): value is string {
  return typeof value === 'string' && /^[A-Z0-9]{2}$/.test(value);
}

/**
 * Resolve the bounded dimensions a `chat_turn` record reports.
 *
 * `userCountry` and `edgeCountry` are deliberately SEPARATE and neither falls
 * back to the other: for gateway-relayed traffic the edge country is the
 * gateway's egress location, so substituting it for user geography would
 * misattribute every WhatsApp/Telegram user to wherever the gateway runs.
 */
/**
 * Everything `logChatTurn` needs that is NOT derivable from the ChatRequest.
 *
 * Passed as one object rather than as positional parameters: the repo caps
 * functions at 5 params (eslint `max-params`), and these travel together.
 */
interface ChatTurnContext {
  /** Per-turn id. Joins `chat_turn` to the generation-level orchestrator logs. */
  turnId: string;
  /** Mode that GOVERNED this turn (mode at turn start). The attribution key. */
  activeModeName: string | undefined;
  /** Resolved language name for this turn, if any. */
  activeLanguageName: string | undefined;
  /** How the language was resolved — bounded enum. */
  languageSource: LanguageSource;
  /** Per-turn facts from the orchestration run. */
  orchestration: OrchestrationResult['telemetry'];
  /** Wall-clock for the whole turn, measured from processChat entry. */
  durationMs: number;
  /** Turn was produced from an inbound voice message (STT cost, uncaptured here). */
  hadInboundVoice: boolean;
  /** Turn produced a voice reply (TTS cost, uncaptured here). */
  hadOutboundVoice: boolean;
  /**
   * Language the user WROTE this turn in (#404), or null when the detector
   * abstained. Log payload only — never a metric label (see
   * `buildChatTurnRecord`).
   */
  inputLanguage: DetectedLanguage | null;
}

/**
 * Build the full `chat_turn` log payload.
 *
 * Deliberately separate from `buildChatTurnDimensions`, which exists ONLY to
 * bound `countMetric` label cardinality. The log has no such constraint (it
 * already reads `user_id`/`client_id` straight off the body), so conflating the
 * two would push unbounded dimensions into the OTLP metric pipeline.
 */
function buildChatTurnPayload(
  body: ChatRequest,
  dims: ReturnType<typeof buildChatTurnDimensions>,
  responseLanguage: string,
  turn: ChatTurnContext
): Record<string, unknown> {
  const { usage } = turn.orchestration;
  return {
    turn_id: turn.turnId,
    user_id: body.user_id,
    org: dims.org,
    client_id: body.client_id,
    transport: dims.transport ?? null,
    chat_type: dims.chatType,
    response_language: responseLanguage,
    // #404: the language the user wrote in. `und` (not null) when the detector
    // abstained, so the field is always present for the tail consumer.
    input_language: turn.inputLanguage ? turn.inputLanguage.code : UNDETERMINED_LANGUAGE,
    input_language_confidence: turn.inputLanguage ? turn.inputLanguage.confidence : null,
    user_country: dims.userCountry ?? null,
    edge_country: dims.edgeCountry ?? null,
    // Mode that governed this turn. `mode_switched_to` is a NEXT-turn selection
    // (switch_mode: "This will take effect on your next message") and must never
    // be used to attribute this turn's cost or content.
    mode: turn.activeModeName ?? null,
    mode_switched_to: turn.orchestration.modeSwitchedTo,
    language: turn.activeLanguageName ?? null,
    language_source: turn.languageSource,
    model: turn.orchestration.model,
    iterations: turn.orchestration.iterations,
    exit_reason: turn.orchestration.exitReason,
    stop_reason: turn.orchestration.finalStopReason,
    mcp_calls_made: turn.orchestration.mcpCallsMade,
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    cache_creation_input_tokens: usage.cache_creation_input_tokens,
    cache_read_input_tokens: usage.cache_read_input_tokens,
    billable_input_tokens: usage.billable_input_tokens,
    duration_ms: turn.durationMs,
    had_inbound_voice: turn.hadInboundVoice,
    had_outbound_voice: turn.hadOutboundVoice,
  };
}

function buildChatTurnDimensions(
  body: ChatRequest,
  defaultOrg: string
): {
  org: string;
  chatType: string;
  transport: ChatTransport | undefined;
  userCountry: string | undefined;
  edgeCountry: string | undefined;
} {
  return {
    org: body.org ?? body.org_id ?? defaultOrg,
    chatType: body.chat_type ?? 'private',
    transport: body._transport,
    userCountry: countryFromPhoneUserId(body.user_id, body.client_id),
    edgeCountry: isCountryCode(body._edge_country) ? body._edge_country : undefined,
  };
}

/**
 * Build the `chat_turn` log payload and the `chat_turns_total` counter labels
 * from one source so they cannot drift.
 *
 * `input_language` / `input_language_confidence` (#404) go on the LOG PAYLOAD
 * ONLY. Metric labels bound series cardinality; the detector can emit any of
 * ~20 codes per turn and must never become a label.
 */
export function buildChatTurnRecord(
  body: ChatRequest,
  responseLanguage: string,
  defaultOrg: string,
  turn: ChatTurnContext
): { payload: Record<string, unknown>; labels: MetricLabels } {
  const dims = buildChatTurnDimensions(body, defaultOrg);
  return {
    payload: buildChatTurnPayload(body, dims, responseLanguage, turn),
    labels: buildChatTurnLabels(dims, responseLanguage),
  };
}

/** Bounded counter labels for `chat_turns_total` — unchanged since before #404. */
function buildChatTurnLabels(
  dims: ReturnType<typeof buildChatTurnDimensions>,
  responseLanguage: string
): MetricLabels {
  return {
    language: responseLanguage,
    chat_type: dims.chatType,
    ...(dims.transport ? { transport: dims.transport } : {}),
    ...(dims.userCountry ? { user_country: dims.userCountry } : {}),
    ...(dims.edgeCountry ? { edge_country: dims.edgeCountry } : {}),
  };
}

/**
 * Reconstruct the exact `idFromName` key the worker used to route to this DO
 * (mirrors `resolveDOId` in index.ts).
 */
function chatDoName(org: string, chatType: string, body: ChatRequest): string {
  if (chatType !== 'group' && chatType !== 'supergroup') return `user:${org}:${body.user_id}`;
  return body.thread_id
    ? `group:${org}:${body.chat_id}:${body.thread_id}`
    : `group:${org}:${body.chat_id}`;
}

/** Build the identity record a chat turn persists (see StoredIdentity). */
function buildStoredIdentity(body: ChatRequest, defaultOrg: string): StoredIdentity {
  const org = body.org ?? body.org_id ?? defaultOrg;
  const chatType = body.chat_type ?? 'private';
  const isGroup = chatType === 'group' || chatType === 'supergroup';
  return {
    do_name: chatDoName(org, chatType, body),
    org,
    chat_type: chatType,
    ...(isGroup ? {} : { user_id: body.user_id }),
    ...(body.chat_id ? { chat_id: body.chat_id } : {}),
    ...(body.thread_id ? { thread_id: body.thread_id } : {}),
    ...(body.client_id ? { client_id: body.client_id } : {}),
    updated_at: Date.now(),
  };
}

/**
 * Locale for everything the worker says in its own voice on a turn — status
 * lines, notices, the error fallback, and the orchestrator's
 * `response_language` — the gateway's per-request `response_language_hint`
 * when present, else the stored preference. This is the one place that
 * precedence is written (#405): `processChat` derives `effectivePreferences`
 * from it and `readStatusLocale` wraps it for paths that have no turn context.
 */
export function resolveStatusLocale(
  body: ChatRequest,
  preferences: UserPreferencesInternal
): string {
  return body.response_language_hint ?? preferences.response_language;
}

/**
 * User-facing text for a failed turn. An upstream `Error.message` passes
 * through unchanged (it is diagnostic — `ClaudeAPIError`, `MCPError` — and
 * translating exceptions is out of scope); only the generic fallback for a
 * non-Error throw is localized (#405). Pure: callers resolve `locale` before
 * their `try`, so no storage read ever happens inside a catch block.
 */
export function processingFailureDetail(error: unknown, locale: string): string {
  return error instanceof Error ? error.message : uiString(locale, 'error_processing_failed');
}

export class UserDO {
  private state: DurableObjectState;
  private env: Env;
  private app: Hono;
  private requestLogger: RequestLogger | null = null;

  /** Live SSE writers for queued messages, keyed by message_id */
  private queuedWriters: Map<string, WritableStreamDefaultWriter<Uint8Array>> = new Map();

  /** Sliding window timestamps for enqueue rate limiting */
  private enqueueTimestamps: number[] = [];

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;

    this.app = new Hono();
    this.app.get('/preferences', () => this.handleGetPreferences());
    this.app.put('/preferences', (c) => this.handleUpdatePreferences(c.req.raw));
    this.app.get('/history', (c) => this.handleGetHistory(new URL(c.req.url)));
    this.app.delete('/history', () => this.handleDeleteHistory());
    this.app.get('/prompt-overrides', () => this.handleGetPromptOverrides());
    this.app.put('/prompt-overrides', (c) => this.handleUpdatePromptOverrides(c.req.raw));
    this.app.delete('/prompt-overrides', () => this.handleDeletePromptOverrides());
    this.app.get('/mode', () => this.handleGetMode());
    this.app.put('/mode', (c) => this.handleSetMode(c.req.raw));
    this.app.delete('/mode', () => this.handleDeleteMode());
    this.app.get('/memory', () => this.handleGetMemory());
    this.app.delete('/memory', () => this.handleDeleteMemory());
    this.app.get('/identity', () => this.handleGetIdentity());
  }

  private getLogger(): RequestLogger {
    return this.requestLogger ?? createRequestLogger(crypto.randomUUID());
  }

  /**
   * Stand up this isolate's telemetry (logs + metrics). Idempotent per isolate and a
   * genuine no-op until the OTEL secrets are set.
   */
  private initTelemetry(): void {
    initLogTelemetry(this.env);
    initMetricTelemetry(this.env);
  }

  /**
   * Drain this isolate's buffered logs + aggregated metrics via the DO's own
   * `waitUntil`. Safe to call MORE THAN ONCE per invocation: logs drain their buffer,
   * and metrics use DELTA temporality so each flush exports only the measurements
   * recorded since the previous drain (no double-counting). This is why background
   * processing (SSE/callback drain) can flush its own late measurements without
   * disturbing the fetch-boundary flush.
   */
  private flushTelemetry(): void {
    flushLogTelemetry((promise) => this.state.waitUntil(promise));
    flushMetricTelemetry((promise) => this.state.waitUntil(promise));
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const requestId = request.headers.get('X-Request-ID') ?? crypto.randomUUID();
    this.requestLogger = createRequestLogger(requestId);

    // Telemetry (M2/M4): the DO runs in its own isolate with its own log buffer +
    // metric aggregation, so it must init + flush independently of the worker.
    this.initTelemetry();
    try {
      // Chat endpoints — one route per explicit transport.
      //   /chat/final     → synchronous final-only JSON. Worker has already
      //                     validated that none of the callback-flavored
      //                     fields are present.
      //   /chat/stream    → always SSE.
      //   /chat/callback  → always webhook; worker has already validated that
      //                     progress_callback_url and message_key are present.
      if (url.pathname === '/chat/final') {
        return await this.handleUnifiedChat(request, 'final');
      }
      if (url.pathname === '/chat/stream') {
        return await this.handleUnifiedChat(request, 'stream');
      }
      if (url.pathname === '/chat/callback') {
        return await this.handleUnifiedChat(request, 'callback');
      }

      // Non-chat endpoints don't need locking
      return await this.app.fetch(request);
    } finally {
      // Drains everything buffered up to this point. The streaming/callback transports
      // keep emitting from background work AFTER this returns (SSE writer, queued
      // drain); those late measurements are flushed by an explicit `flushTelemetry()`
      // at the end of each background path (see processImmediate*), and any residue on
      // isolate death is covered by the tail worker.
      this.flushTelemetry();
    }
  }

  // ── Alarm-based queue processing ──────────────────────────────────────────────

  async alarm(): Promise<void> {
    const logger = createRequestLogger(crypto.randomUUID());
    // Metric recording is SUPPRESSED for the whole alarm call tree. Outbound fetch from an
    // alarm() context is blocked by Cloudflare (1003, the same wall that forces
    // orchestration into the fetch handler), so no exporter can egress here, and there is
    // NO backstop for custom metrics (the tail worker forwards this isolate's console logs
    // + exceptions, not our in-memory OTLP metric payloads). Simply not calling
    // `initMetricTelemetry` here is not enough: a PRIOR fetch on a warm isolate may have
    // already stood up the module meter, so alarm work would otherwise record DELTAs into
    // it that can never export and are lost on a quiet eviction. `runWithMetricsSuppressed`
    // makes those `countMetric`/`recordMetric` calls no-ops for this async context only
    // (never a concurrent fetch's background work sharing the isolate). Metrics for queued
    // work are captured where that work runs under the fetch handler (processImmediate* →
    // drainQueue), which can export. Logs are NOT suppressed — the tail worker forwards
    // them — so alarm diagnostics stay observable.
    await runWithMetricsSuppressed(async () => {
      await this.drainAlarmQueue(logger);
      await this.rescheduleAlarm(logger);
    });
  }

  /** Dequeue and process one entry for an alarm tick; recover the lock on failure. */
  private async drainAlarmQueue(logger: RequestLogger): Promise<void> {
    try {
      const entry = await this.dequeueNext();
      if (!entry) {
        logger.log('queue_empty_alarm_done');
        return;
      }
      await this.processQueueEntry(entry, logger);
    } catch (error) {
      logger.error('alarm_fatal_error', error);
      try {
        await this.releaseLock();
      } catch (storageErr) {
        logger.error('alarm_recovery_storage_failed', storageErr, {
          original_error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  /** Schedule the next alarm tick; clear the processing flag if scheduling fails. */
  private async rescheduleAlarm(logger: RequestLogger): Promise<void> {
    try {
      await this.scheduleNextAlarm();
    } catch (error) {
      logger.error('alarm_schedule_next_failed', error);
      try {
        await this.state.storage.put(QUEUE_PROCESSING_KEY, false);
      } catch (storageErr) {
        logger.error('alarm_schedule_recovery_failed', storageErr);
      }
    }
  }

  // ── Unified chat handler ──────────────────────────────────────────────────────

  /**
   * Parse and re-validate the request body for a chat endpoint.
   *
   * Returns `{ body }` on success, or `{ error: Response }` on failure.
   *
   * The DO re-runs the worker's transport validation rules as
   * defense-in-depth. The worker already validated this request, but
   * re-checking here guarantees the transport → body invariant is
   * enforced at the same place we rely on it for queue dispatch
   * (processQueueEntry reads body.progress_callback_url to decide
   * callback vs SSE). If a future refactor breaks worker-side
   * validation, this fails loudly instead of silently dropping the
   * user's response in the queued path.
   */
  private async parseChatBody(
    request: Request,
    transport: ChatTransport,
    logger: RequestLogger
  ): Promise<{ body: ChatRequest; error?: never } | { body?: never; error: Response }> {
    let body: ChatRequest;
    try {
      body = (await request.json()) as ChatRequest;
    } catch (err) {
      logger.warn('chat_invalid_json', {
        transport,
        error: err instanceof Error ? err.message : String(err),
      });
      return { error: Response.json({ error: 'Invalid JSON body' }, { status: 400 }) };
    }

    const validationError = validateChatBody(body, transport);
    if (validationError) {
      logger.warn('chat_validation_failed_in_do', {
        transport,
        error: validationError,
        user_id: body.user_id,
      });
      return { error: Response.json({ error: validationError }, { status: 400 }) };
    }

    return { body };
  }

  private async handleUnifiedChat(request: Request, transport: ChatTransport): Promise<Response> {
    const logger = this.getLogger();

    const parsed = await this.parseChatBody(request, transport, logger);
    if (parsed.error) return parsed.error;
    const { body } = parsed;

    // The worker's pseudonym scope does NOT reach here. The DO is a separate isolate, so
    // async context cannot survive the stub.fetch() boundary — the same reason initTelemetry
    // runs independently in fetch(). Re-establish it from the body using the SAME salt, so
    // DO records carry the SAME user_hash the worker computed for this request. Without
    // this, the dozens of records produced here (tool calls, orchestration, timings) reach
    // OpenObserve with no user identifier at all.
    return withUserPseudonym(
      this.env,
      body.client_id,
      body.user_id,
      () => this.dispatchUnifiedChat(body, request, transport, logger),
      (error) =>
        logger.warn('user_pseudonym_failed', {
          error: error instanceof Error ? error.message : String(error),
          transport,
          client_id: body.client_id,
        })
    );
  }

  /**
   * The chat flow proper, run inside the DO's pseudonym scope. Split out of
   * `handleUnifiedChat` only to give that scope a callback boundary; behavior is unchanged.
   */
  private async dispatchUnifiedChat(
    body: ChatRequest,
    request: Request,
    transport: ChatTransport,
    logger: RequestLogger
  ): Promise<Response> {
    // Stamp the transport onto the body so queued entries retain it when the
    // queue drains in a later invocation (chat_turn telemetry reads it there).
    body._transport = transport;

    // Persist identity BEFORE rate limiting or orchestration: the record must
    // exist even for turns that fail downstream, or the DO stays unattributable.
    await this.persistIdentity(body, logger);

    // Rate limiting
    const rateLimited = this.enforceEnqueueRateLimit(body, transport, logger);
    if (rateLimited) return rateLimited;

    const messageId = crypto.randomUUID();
    const workerOrigin = request.headers.get('X-Worker-Origin') ?? '';

    // Locale for everything the worker says in its own voice on this request
    // (#405). Resolved BEFORE the busy check on purpose: nothing may yield
    // between inspecting the lock and enqueueing, or an active turn that
    // finishes in the gap drains an empty queue and this request is left to
    // alarm(), which cannot reach Anthropic (see below). One cached read,
    // shared by the immediate and queued paths.
    const locale = await this.readStatusLocale(body, logger);

    // Try to process immediately in the fetch handler if idle.
    // Outbound fetch to api.anthropic.com fails from DO alarm() contexts
    // (Cloudflare 1003), so we MUST process in the fetch handler.
    const lockAcquired = await this.tryAcquireLock();
    if (lockAcquired) {
      logger.log('chat_immediate', {
        message_id: messageId,
        user_id: body.user_id,
        transport,
      });
      if (transport === 'final') {
        return this.processImmediateFinal(body, workerOrigin, messageId, locale, logger);
      }
      if (transport === 'callback') {
        return this.processImmediateCallback(body, workerOrigin, messageId, locale, logger);
      }
      return this.processImmediateSSE(body, workerOrigin, messageId, locale, logger);
    }

    // DO is busy. The final transport cannot queue because we have no
    // way to hold an HTTP connection open while the alarm drains the
    // backlog — tell the caller to retry so they can re-serialize on
    // their side. Stream and callback transports can queue cleanly
    // (SSE holds the writer; callback returns 202 now, fires the
    // webhook later).
    if (transport === 'final') {
      logger.log('chat_busy_final_reject', {
        message_id: messageId,
        user_id: body.user_id,
      });
      return Response.json(
        {
          error: 'Request in progress',
          code: 'CONCURRENT_REQUEST_REJECTED',
          message: 'Another request for this user is currently being processed. Please retry.',
          retry_after_ms: 5000,
        },
        { status: 429, headers: { 'Retry-After': '5' } }
      );
    }

    return this.enqueueAndReturn(body, messageId, workerOrigin, locale, logger);
  }

  /**
   * Enqueue a message and return 202 (callback) or SSE stream (SSE delivery).
   * Delivery follows `body._transport`, stamped by `dispatchUnifiedChat`.
   *
   * No await may precede `enqueueEntry` here or sit between it and the SSE
   * writer registration: the caller already resolved `locale` (the queued
   * notice is localized, #405), so the busy check → enqueue → register
   * sequence never yields to a finishing turn's drain.
   */
  private async enqueueAndReturn(
    body: ChatRequest,
    messageId: string,
    workerOrigin: string,
    locale: string,
    logger: RequestLogger
  ): Promise<Response> {
    const isCallbackDelivery = body._transport === 'callback';
    const entry: InternalQueueEntry = {
      message_id: messageId,
      body: { ...body, _worker_origin: workerOrigin },
      enqueued_at: Date.now(),
      retry_count: 0,
    };

    const maxDepth = this.getMaxQueueDepth();
    const position = await this.enqueueEntry(entry, maxDepth);

    if (position === -1) {
      logger.warn('chat_queue_full', {
        message_id: messageId,
        user_id: body.user_id,
        max_depth: maxDepth,
        status: 429,
      });
      countMetric('queue_entries_total', { status: 'rejected', reason: 'queue_full' });
      return Response.json(
        {
          error: 'Queue full',
          code: 'QUEUE_DEPTH_EXCEEDED',
          message: `Queue depth limit (${maxDepth}) exceeded.`,
        },
        { status: 429, headers: { 'Retry-After': '5' } }
      );
    }

    logger.log('chat_enqueued', {
      message_id: messageId,
      delivery: isCallbackDelivery ? 'callback' : 'sse',
      queue_position: position,
      user_id: body.user_id,
    });
    countMetric('queue_entries_total', {
      status: 'enqueued',
      type: isCallbackDelivery ? 'callback' : 'sse',
    });

    if (isCallbackDelivery) {
      return Response.json({ message_id: messageId }, { status: 202 });
    }

    return this.createQueuedSSEStream(locale, messageId, logger);
  }

  /**
   * Process a final-mode message synchronously in the fetch handler and
   * return a JSON response.
   *
   * Unlike SSE and callback, this path cannot return early and let the
   * orchestrator run in the background — the caller is waiting on the
   * HTTP response, so we must await processChat and serialize the
   * ChatResponse before returning.
   *
   * Lock release and queue drain are fired as background work *after*
   * processChat resolves but *before* we return the Response. Drain
   * must not be awaited here: if SSE/callback requests were queued
   * while this final request was running, awaiting drainQueue would
   * make the /api/v1/chat caller wait for those backlogged
   * orchestrations to complete before getting their JSON body,
   * which blows the final-only latency contract. Fire-and-forget
   * matches the pattern used by processImmediateSSE and
   * processImmediateCallback, which launch processChat + release +
   * drain inside a background closure and return immediately.
   */
  private async processImmediateFinal(
    body: ChatRequest,
    workerOrigin: string,
    messageId: string,
    locale: string,
    logger: RequestLogger
  ): Promise<Response> {
    const timing = createTimingContext();
    let response: Response;
    try {
      const chatResponse = await this.processChat(body, workerOrigin, logger, timing);
      logger.log('immediate_final_complete', { message_id: messageId });
      response = Response.json({ message_id: messageId, ...chatResponse });
    } catch (error) {
      response = this.finalErrorResponse(error, locale, messageId, logger);
    }

    // Release the lock and drain the queue in the background so this
    // caller does not wait for any SSE/callback backlog that accumulated
    // while processChat was running.
    (async () => {
      try {
        await this.releaseLock();
        await this.drainQueue(logger);
      } catch (drainErr) {
        logger.error('immediate_final_drain_failed', drainErr, { message_id: messageId });
      } finally {
        // Flush measurements emitted by the background drain — they were recorded
        // after fetch()'s boundary flush already ran.
        this.flushTelemetry();
      }
    })().catch((err) =>
      logger.error('immediate_final_drain_unhandled', err, { message_id: messageId })
    );

    return response;
  }

  /** JSON error body for a failed final-mode turn; logs it with the right severity. */
  private finalErrorResponse(
    error: unknown,
    locale: string,
    messageId: string,
    logger: RequestLogger
  ): Response {
    if (error instanceof AppError) {
      // Surface structured app errors (ValidationError, MCPRequestCallLimitError,
      // MCPCallLimitError, etc.) with their declared code + status so callers
      // can distinguish 4xx user-correctable conditions (e.g. 429 rate-limit)
      // from genuine 500 server failures. Without this, every AppError other
      // than ValidationError collapsed to a generic 500.
      const isClientError = error.statusCode >= 400 && error.statusCode < 500;
      if (isClientError) {
        logger.warn('immediate_final_app_error', {
          message_id: messageId,
          code: error.code,
          status: error.statusCode,
          error: error.message,
        });
      } else {
        logger.error('immediate_final_app_error', error, {
          message_id: messageId,
          code: error.code,
          status: error.statusCode,
        });
      }
      return createErrorResponse(error.name, error.code, error.message, error.statusCode);
    }
    logger.error('immediate_final_error', error, { message_id: messageId });
    return createErrorResponse(
      uiString(locale, 'error_processing_failed'),
      'INTERNAL_ERROR',
      processingFailureDetail(error, locale),
      500
    );
  }

  /** Process a callback-mode message immediately in the fetch handler. Returns 202. */
  private processImmediateCallback(
    body: ChatRequest,
    workerOrigin: string,
    messageId: string,
    locale: string,
    logger: RequestLogger
  ): Response {
    // Start processing in background — return 202 immediately
    (async () => {
      const timing = createTimingContext();
      const callbacks = this.buildWebhookCallbacks(body, logger);
      try {
        const response = await this.processChat(body, workerOrigin, logger, timing, callbacks);
        await callbacks?.onComplete?.(response);
        logger.log('immediate_callback_complete', { message_id: messageId });
      } catch (error) {
        logger.error('immediate_callback_error', error, { message_id: messageId });
        await callbacks?.onError?.(processingFailureDetail(error, locale));
      } finally {
        await this.releaseLock();
        await this.drainQueue(logger);
        // Flush measurements from this background path — emitted after fetch() returned.
        this.flushTelemetry();
      }
    })().catch((err) =>
      logger.error('immediate_callback_unhandled', err, { message_id: messageId })
    );

    return Response.json({ message_id: messageId }, { status: 202 });
  }

  /** Process a chat message immediately in the fetch handler (not via alarm). */
  private processImmediateSSE(
    body: ChatRequest,
    workerOrigin: string,
    messageId: string,
    locale: string,
    logger: RequestLogger
  ): Response {
    const { readable, writable } = new TransformStream<Uint8Array>();
    const writer = writable.getWriter();
    const { sendEvent, keepaliveInterval } = this.buildSSESender(writer, logger, Date.now());

    const callbacks: StreamCallbacks = {
      onStatus: async (status) => sendEvent({ type: 'status', ...status }),
      onProgress: async (text) => sendEvent({ type: 'progress', text }),
      onComplete: async (response) => sendEvent({ type: 'complete', response }),
      onError: async (error) => sendEvent({ type: 'error', error }),
      onToolUse: async (tool, input) => sendEvent({ type: 'tool_use', tool, input }),
      onToolResult: async (tool, result) => sendEvent({ type: 'tool_result', tool, result }),
    };

    // Process in background — the Response is returned immediately with the SSE stream
    (async () => {
      try {
        const timing = createTimingContext();
        const response = await this.processChat(body, workerOrigin, logger, timing, callbacks);
        await sendEvent({ type: 'complete', response });
      } catch (error) {
        logger.error('immediate_sse_error', error, { message_id: messageId });
        await sendEvent({ type: 'error', error: processingFailureDetail(error, locale) });
      } finally {
        clearInterval(keepaliveInterval);
        await this.closeSSEWriter(writer, 'processImmediateSSE', messageId, logger);
        await this.releaseLock();
        await this.drainQueue(logger);
        // Flush measurements from this background path — emitted after fetch() returned.
        this.flushTelemetry();
      }
    })().catch((err) => logger.error('immediate_sse_unhandled', err, { message_id: messageId }));

    return new Response(readable, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    });
  }

  /**
   * Create an SSE stream for a queued message. Events flow when the alarm
   * processes it. Synchronous on purpose: the writer is registered before
   * any await can let a drain run (see `enqueueAndReturn`). `locale` is for
   * the queued notice (#405).
   */
  private createQueuedSSEStream(
    locale: string,
    messageId: string,
    logger: RequestLogger
  ): Response {
    const { readable, writable } = new TransformStream<Uint8Array>();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();

    // Register writer so alarm() can pipe events to it
    this.queuedWriters.set(messageId, writer);

    // Send initial queued event
    const queuedEvent: SSEEvent = { type: 'status', ...statusUpdate(locale, 'status_queued') };
    writer.write(encoder.encode(`data: ${JSON.stringify(queuedEvent)}\n\n`)).catch((error) => {
      logger.warn('sse_client_disconnected', {
        phase: 'initial_queued_event',
        message_id: messageId,
        error: error instanceof Error ? error.message : String(error),
      });
      this.queuedWriters.delete(messageId);
    });

    return new Response(readable, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    });
  }

  /**
   * Drain queued entries after immediate processing completes.
   * Runs in the fetch handler context (not alarm) to avoid Cloudflare 1003.
   * Processes entries one at a time until the queue is empty.
   */
  private async drainQueue(logger: RequestLogger): Promise<void> {
    for (;;) {
      const entry = await this.dequeueNext();
      if (!entry) return;

      // Emit INSIDE the dequeued entry's scope. This loop runs as background work started
      // in whichever user's `handleUnifiedChat` scope triggered the drain, and a group DO's
      // queue can hold entries for several users — so logging here unscoped would stamp
      // user A's `user_hash` onto a record carrying user B's `message_id`. The nested
      // `withUserPseudonym` inside `processQueueEntry` re-derives the same value; the
      // duplicated HMAC is negligible next to mis-attributing a user.
      await this.withEntryPseudonym(entry, logger, async () => {
        logger.log('drain_queue_entry', { message_id: entry.message_id });
        await this.processQueueEntry(entry, logger);
      });
    }
  }

  // ── Queue entry processing (called by alarm or drainQueue) ────────────────────

  /**
   * Run `fn` under the pseudonym of the user who owns `entry`.
   *
   * Queue draining crosses user boundaries in two ways: `alarm()` is a separate invocation
   * from the `fetch()` that enqueued the work, and a group DO's queue can hold entries for
   * several users. Either way the ambient scope belongs to someone else — or to nobody — so
   * every per-entry emission re-derives from the stored body. Fails closed: on a hashing
   * failure `withUserPseudonym` clears the store rather than inheriting the outer user's.
   */
  private withEntryPseudonym<T>(
    entry: InternalQueueEntry,
    logger: RequestLogger,
    fn: () => Promise<T>
  ): Promise<T> {
    return withUserPseudonym(this.env, entry.body.client_id, entry.body.user_id, fn, (error) =>
      logger.warn('user_pseudonym_failed', {
        error: error instanceof Error ? error.message : String(error),
        message_id: entry.message_id,
        client_id: entry.body.client_id,
      })
    );
  }

  private async processQueueEntry(entry: InternalQueueEntry, logger: RequestLogger): Promise<void> {
    return this.withEntryPseudonym(entry, logger, () =>
      this.processQueueEntryInScope(entry, logger)
    );
  }

  /** Queue-entry processing proper, inside the pseudonym scope. Behavior unchanged. */
  private async processQueueEntryInScope(
    entry: InternalQueueEntry,
    logger: RequestLogger
  ): Promise<void> {
    const startTime = Date.now();
    const body = entry.body;
    const isCallbackMode = !!body.progress_callback_url;

    logger.log('queue_processing_start', {
      message_id: entry.message_id,
      delivery: isCallbackMode ? 'callback' : 'sse',
      user_id: body.user_id,
      retry_count: entry.retry_count,
      queue_wait_ms: startTime - entry.enqueued_at,
    });

    // Acquire lock (defense-in-depth — alarm already serializes)
    await this.state.storage.put(PROCESSING_LOCK_KEY, Date.now());

    try {
      if (isCallbackMode) {
        await this.processCallbackEntry(entry, logger);
      } else {
        await this.processSSEEntry(entry, logger);
      }
      logger.log('queue_processing_complete', {
        message_id: entry.message_id,
        processing_ms: Date.now() - startTime,
      });
    } catch (error) {
      logger.error('queue_processing_error', error, {
        message_id: entry.message_id,
        user_id: body.user_id,
        retry_count: entry.retry_count,
        processing_ms: Date.now() - startTime,
      });
      await this.handleProcessingError(entry, error, logger);
    } finally {
      await this.releaseLock();
      this.queuedWriters.delete(entry.message_id);
    }
  }

  /** Process a callback-mode queue entry (WhatsApp gateway). */
  private async processCallbackEntry(
    entry: InternalQueueEntry,
    logger: RequestLogger
  ): Promise<void> {
    const body = entry.body;
    const workerOrigin = body._worker_origin ?? '';
    const timing = createTimingContext();
    const callbacks = this.buildWebhookCallbacks(body, logger);
    // Resolved inside the try so a throwing read still reaches onError (and the retry logic).
    let locale = DEFAULT_PREFERENCES.response_language;

    try {
      locale = await this.readStatusLocale(body, logger);
      const response = await this.processChat(body, workerOrigin, logger, timing, callbacks);
      await callbacks?.onComplete?.(response);
    } catch (error) {
      await callbacks?.onError?.(processingFailureDetail(error, locale));
      throw error;
    }
  }

  /** Build an SSE event sender bound to a writer, tracking disconnection state. */
  private buildSSESender(
    writer: WritableStreamDefaultWriter<Uint8Array> | undefined,
    logger: RequestLogger,
    startTime: number
  ) {
    const encoder = new TextEncoder();
    const state = { clientDisconnected: false, firstTokenTime: null as number | null };

    const sendEvent = async (event: SSEEvent): Promise<void> => {
      if (state.clientDisconnected || !writer) return;
      if (event.type === 'progress' && state.firstTokenTime === null) {
        state.firstTokenTime = Date.now() - startTime;
        logger.log('stream_first_token', { time_to_first_token_ms: state.firstTokenTime });
      }
      try {
        await writer.write(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      } catch (error) {
        state.clientDisconnected = true;
        logger.warn('sse_client_disconnected', {
          phase: 'send_event',
          event_type: event.type,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    };

    const keepaliveInterval = setInterval(() => {
      if (state.clientDisconnected || !writer) {
        clearInterval(keepaliveInterval);
        return;
      }
      writer
        .write(encoder.encode(`data: ${JSON.stringify({ type: 'keepalive' })}\n\n`))
        .catch((error: unknown) => {
          logger.warn('sse_keepalive_write_failed', {
            error: error instanceof Error ? error.message : String(error),
          });
          state.clientDisconnected = true;
          clearInterval(keepaliveInterval);
        });
    }, SSE_KEEPALIVE_INTERVAL_MS);

    return { sendEvent, keepaliveInterval, state };
  }

  /** Process an SSE-mode queue entry (web client). */
  private async processSSEEntry(entry: InternalQueueEntry, logger: RequestLogger): Promise<void> {
    const body = entry.body;
    const writer = this.queuedWriters.get(entry.message_id);
    const { sendEvent, keepaliveInterval } = this.buildSSESender(writer, logger, Date.now());
    // Resolved inside the try so the finally (writer close) always runs.
    let locale = DEFAULT_PREFERENCES.response_language;

    try {
      locale = await this.readStatusLocale(body, logger);
      const callbacks: StreamCallbacks = {
        onStatus: async (status) => sendEvent({ type: 'status', ...status }),
        onProgress: async (text) => sendEvent({ type: 'progress', text }),
        // onComplete is sent explicitly after processChat returns (not by the orchestrator)
        onComplete: async (response) => sendEvent({ type: 'complete', response }),
        onError: async (error) => sendEvent({ type: 'error', error }),
        onToolUse: async (tool, input) => sendEvent({ type: 'tool_use', tool, input }),
        onToolResult: async (tool, result) => sendEvent({ type: 'tool_result', tool, result }),
      };

      const timing = createTimingContext();
      const response = await this.processChat(
        body,
        body._worker_origin ?? '',
        logger,
        timing,
        callbacks
      );
      await sendEvent({ type: 'complete', response });
    } catch (error) {
      // Send error to SSE client BEFORE closing the writer — if we let this propagate
      // to processQueueEntry's handleProcessingError, the writer is already closed.
      logger.error('sse_entry_processing_error', error, { message_id: entry.message_id });
      await sendEvent({ type: 'error', error: processingFailureDetail(error, locale) });
      throw error; // Re-throw for retry logic in processQueueEntry
    } finally {
      clearInterval(keepaliveInterval);
      if (writer) await this.closeSSEWriter(writer, 'processSSEEntry', entry.message_id, logger);
    }
  }

  /** Close an SSE writer; a client that already disconnected is expected but never invisible. */
  private async closeSSEWriter(
    writer: WritableStreamDefaultWriter<Uint8Array>,
    phase: string,
    messageId: string,
    logger: RequestLogger
  ): Promise<void> {
    try {
      await writer.close();
    } catch (error) {
      logger.warn('stream_writer_close_failed', {
        phase,
        message_id: messageId,
        error: error instanceof Error ? error.message : String(error),
      });
      // Client disconnected — expected, but must be visible in logs.
    }
  }

  // ── Queue infrastructure ──────────────────────────────────────────────────────

  /** Atomically append entry to queue and schedule alarm if idle. Returns -1 if full. */
  private async enqueueEntry(entry: InternalQueueEntry, maxDepth: number): Promise<number> {
    // Runs in the DO fetch context (unlike the alarm-drained dequeue path, which
    // cannot export spans — CF error 1003), so this span reaches the collector.
    return withSpan('do.enqueue', { max_depth: maxDepth }, () =>
      this.state.blockConcurrencyWhile(async () => {
        const queue = (await this.state.storage.get<InternalQueueEntry[]>(QUEUE_KEY)) ?? [];

        if (queue.length >= maxDepth) return -1;

        queue.push(entry);
        await this.state.storage.put(QUEUE_KEY, queue);

        const isProcessing = (await this.state.storage.get<boolean>(QUEUE_PROCESSING_KEY)) ?? false;
        if (!isProcessing) {
          await this.state.storage.put(QUEUE_PROCESSING_KEY, true);
          await this.state.storage.setAlarm(Date.now());
        }
        return queue.length;
      })
    );
  }

  /** Atomically dequeue the next entry, or return null if queue is empty. */
  private async dequeueNext(): Promise<InternalQueueEntry | null> {
    return this.state.blockConcurrencyWhile(async () => {
      const queue = (await this.state.storage.get<InternalQueueEntry[]>(QUEUE_KEY)) ?? [];
      if (queue.length === 0) {
        await this.state.storage.put(QUEUE_PROCESSING_KEY, false);
        return null;
      }
      const next = queue.shift()!;
      await this.state.storage.put(QUEUE_KEY, queue);
      return next;
    });
  }

  /** Schedule the next alarm if there are items remaining in the queue. */
  private async scheduleNextAlarm(): Promise<void> {
    const hasMore = await this.state.blockConcurrencyWhile(async () => {
      const queue = (await this.state.storage.get<InternalQueueEntry[]>(QUEUE_KEY)) ?? [];
      if (queue.length === 0) {
        await this.state.storage.put(QUEUE_PROCESSING_KEY, false);
        return false;
      }
      return true;
    });

    if (hasMore) {
      await this.state.storage.setAlarm(Date.now());
    }
  }

  /** Re-enqueue a failed entry at the front of the queue for retry. */
  private async reEnqueue(entry: InternalQueueEntry): Promise<void> {
    await this.state.blockConcurrencyWhile(async () => {
      const queue = (await this.state.storage.get<InternalQueueEntry[]>(QUEUE_KEY)) ?? [];
      queue.unshift(entry);
      await this.state.storage.put(QUEUE_KEY, queue);
    });
  }

  /** Handle errors during queue processing with retry logic. */
  private async handleProcessingError(
    entry: InternalQueueEntry,
    error: unknown,
    logger: RequestLogger
  ): Promise<void> {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const maxRetries = this.getMaxRetries();

    if (this.isTransientError(errorMessage) && entry.retry_count < maxRetries) {
      logger.warn('queue_entry_retry', {
        message_id: entry.message_id,
        retry_count: entry.retry_count + 1,
        max_retries: maxRetries,
      });
      await this.reEnqueue({ ...entry, retry_count: entry.retry_count + 1 });
      return;
    }

    // Permanent failure — notify SSE client if connected
    const writer = this.queuedWriters.get(entry.message_id);
    if (writer) {
      try {
        const encoder = new TextEncoder();
        const event: SSEEvent = { type: 'error', error: errorMessage };
        await writer.write(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        await writer.close();
      } catch (writeErr) {
        logger.warn('sse_error_write_failed', {
          message_id: entry.message_id,
          error: writeErr instanceof Error ? writeErr.message : String(writeErr),
        });
      }
    }
  }

  /** Check if an error message indicates a transient (retryable) failure. */
  private isTransientError(errorMessage: string): boolean {
    return (
      /returned 5\d{2}/.test(errorMessage) ||
      errorMessage.includes('Network') ||
      errorMessage.includes('timeout') ||
      errorMessage.includes('ECONNREFUSED')
    );
  }

  /** Enforce the enqueue rate limit; returns a logged 429 response if exceeded, else null. */
  private enforceEnqueueRateLimit(
    body: ChatRequest,
    transport: ChatTransport,
    logger: RequestLogger
  ): Response | null {
    const rateLimited = this.checkRateLimit(
      this.enqueueTimestamps,
      ENQUEUE_RATE_WINDOW_MS,
      ENQUEUE_RATE_LIMIT,
      '10'
    );
    if (!rateLimited) return null;
    // A 429 is a signal, not a non-event — make it observable.
    logger.warn('chat_rate_limited', {
      user_id: body.user_id,
      transport,
      status: 429,
      window_ms: ENQUEUE_RATE_WINDOW_MS,
      limit: ENQUEUE_RATE_LIMIT,
    });
    countMetric('rate_limits_total', { type: 'enqueue', transport });
    return rateLimited;
  }

  /** Sliding-window rate limiter. */
  private checkRateLimit(
    timestamps: number[],
    windowMs: number,
    limit: number,
    retryAfter: string
  ): Response | null {
    const now = Date.now();
    const cutoff = now - windowMs;
    let expiredCount = 0;
    while (
      expiredCount < timestamps.length &&
      (timestamps.at(expiredCount) ?? Infinity) <= cutoff
    ) {
      expiredCount++;
    }
    if (expiredCount > 0) timestamps.splice(0, expiredCount);
    if (timestamps.length >= limit) {
      return Response.json(
        { error: 'Rate limit exceeded', code: 'RATE_LIMIT_EXCEEDED' },
        { status: 429, headers: { 'Retry-After': retryAfter } }
      );
    }
    timestamps.push(now);
    return null;
  }

  // ── Lock management ───────────────────────────────────────────────────────────

  private async tryAcquireLock(): Promise<boolean> {
    return this.state.blockConcurrencyWhile(async () => {
      const lock = await this.state.storage.get<number>(PROCESSING_LOCK_KEY);
      const now = Date.now();
      if (lock && now - lock < LOCK_STALE_THRESHOLD_MS) {
        return false;
      }
      if (lock) {
        this.getLogger().warn('stale_lock_overwritten', { lock_age_ms: now - lock });
      }
      await this.state.storage.put(PROCESSING_LOCK_KEY, now);
      return true;
    });
  }

  private async releaseLock(): Promise<void> {
    await this.state.storage.delete(PROCESSING_LOCK_KEY);
  }

  // ── Webhook callbacks ─────────────────────────────────────────────────────────

  private buildWebhookCallbacks(
    body: ChatRequest,
    logger: RequestLogger
  ): StreamCallbacks | undefined {
    if (!body.progress_callback_url || !body.message_key) return undefined;

    const sender = new ProgressCallbackSender(
      {
        url: body.progress_callback_url,
        user_id: body.user_id,
        message_key: body.message_key,
        token: this.env.ENGINE_API_KEY,
        ...(body.chat_id ? { chat_id: body.chat_id } : {}),
        ...(body.thread_id ? { thread_id: body.thread_id } : {}),
      },
      logger
    );
    const throttleSeconds =
      typeof body.progress_throttle_seconds === 'number' && body.progress_throttle_seconds > 0
        ? body.progress_throttle_seconds
        : DEFAULT_THROTTLE_SECONDS;
    return createWebhookCallbacks(sender, logger, {
      mode: body.progress_mode ?? DEFAULT_PROGRESS_MODE,
      throttleSeconds,
    });
  }

  /**
   * Persist this DO's identity under the `identity` storage key. The stored
   * `do_name` is what makes a hex id from the REST object-listing API
   * attributable to a user or group via the admin snapshot endpoint. Skips
   * the write when nothing changed so steady-state turns cost a read, not a
   * write.
   */
  private async persistIdentity(body: ChatRequest, logger: RequestLogger): Promise<void> {
    try {
      const identity = buildStoredIdentity(body, this.env.DEFAULT_ORG);
      const existing = await this.state.storage.get<StoredIdentity>(IDENTITY_KEY);
      if (
        existing &&
        existing.do_name === identity.do_name &&
        existing.client_id === identity.client_id
      ) {
        return;
      }
      await this.state.storage.put(IDENTITY_KEY, identity);
      logger.log('identity_persisted', {
        do_name: identity.do_name,
        org: identity.org,
        chat_type: identity.chat_type,
        client_id: body.client_id,
      });
    } catch (error) {
      logger.warn('identity_persist_failed', {
        error: error instanceof Error ? error.message : String(error),
        user_id: body.user_id,
      });
      // Explicitly continue — identity is enumeration metadata; the chat turn
      // itself must not fail because this bookkeeping write did.
    }
  }

  /**
   * Emit the per-turn language/geography telemetry: one `chat_turn` log record
   * and one bounded-label counter per ADDRESSED chat turn (the ambient
   * short-circuit path produces no response, so `response_language` would be
   * meaningless there and it is deliberately excluded).
   */
  private logChatTurn(
    body: ChatRequest,
    responseLanguage: string,
    logger: RequestLogger,
    turn: ChatTurnContext
  ): void {
    try {
      const record = buildChatTurnRecord(body, responseLanguage, this.env.DEFAULT_ORG, turn);
      logger.log('chat_turn', record.payload);
      countMetric('chat_turns_total', record.labels);
    } catch (error) {
      logger.warn('chat_turn_telemetry_failed', {
        error: error instanceof Error ? error.message : String(error),
        user_id: body.user_id,
      });
      // Explicitly continue — this is observability for an ALREADY-COMPLETED
      // turn (history is saved, the response is assembled). It must never
      // convert a successful chat into a failed one.
    }
  }

  // ── Chat processing pipeline ──────────────────────────────────────────────────

  private async processChat(
    body: ChatRequest,
    workerOrigin: string,
    logger: RequestLogger,
    timing: TimingContext,
    callbacks?: StreamCallbacks
  ): Promise<ChatResponse> {
    const ctx = { timing, logger, startTime: Date.now() };
    // Per-turn id. NOT the same as `request_id`: drainQueue reuses the triggering
    // request's logger across every entry it drains, so request_id can span turns.
    const turnId = crypto.randomUUID();
    // prettier-ignore
    logger.log('process_chat_start', { turn_id: turnId, message_type: body.message_type, has_audio: !!body.audio_base64, has_callbacks: !!callbacks, chat_type: body.chat_type ?? 'private' });

    const loaded = await this.loadChatContext(body, ctx, callbacks);

    const ambient = await this.maybeShortCircuitAmbient(body, loaded, logger);
    if (ambient) return ambient;

    // Extract #mode/@language trigger tokens and resolve per-turn overrides
    const triggerCtx = await this.classifyAndResolveTriggers(body, loaded, logger);

    // #404: detect the language the user WROTE in, once per turn, on the text
    // the classifier already stripped of matched trigger tokens. Telemetry
    // only: it is recorded on chat_turn and echoed on the response, and never
    // touches the persisted response_language preference.
    const inputLanguage = detectWrittenLanguage(triggerCtx.messageText, logger);

    // ── Build orchestrator options ────────────────────────────────────────────
    const effectivePreferences = { ...loaded.preferences, response_language: loaded.locale };
    const groupContext = this.maybeBuildGroupContext(body);

    const audioContext = this.buildAudioContext();
    const attachmentsContext = createAttachmentsContext();
    // prettier-ignore
    const orchOpts = { ...this.buildOrchOpts(body, loaded.catalog, loaded.history, effectivePreferences, triggerCtx.resolved, loaded.memoryStore, loaded.formattedTOC, loaded.orgModes, triggerCtx.activeModeName, audioContext, attachmentsContext, workerOrigin, logger, callbacks, groupContext, triggerCtx.languageDocument, triggerCtx.unmatchedTriggers, loaded.inboundVoiceKey, { triggerOnly: triggerCtx.triggerOnly }), turnId };

    const orchResult = await this.tracedPhase(ctx, 'orchestration', () =>
      this.runOrchestration(triggerCtx.messageText, orchOpts)
    );
    const ttsResponses = this.extractTtsResponses(orchResult, logger);

    const voiceAudio = await this.tracedPhase(ctx, 'audio_generation', () =>
      this.maybeGenerateAudio(body, audioContext, ttsResponses, logger, loaded.emitStatus)
    );
    const audioKey = voiceAudio?.audioKey ?? null;

    // prettier-ignore
    await this.tracedPhase(ctx, 'save_conversation', () =>
      this.saveConversation(triggerCtx.messageText, orchResult.responses, loaded.preferences, body._org_config ?? {}, { logger, audioKey, inboundVoiceKey: loaded.inboundVoiceKey, speaker: body.speaker, attachments: attachmentsContext.list() })
    );

    // prettier-ignore
    this.logChatTurn(body, effectivePreferences.response_language, logger, { turnId, activeModeName: triggerCtx.activeModeName, activeLanguageName: triggerCtx.activeLanguageName, languageSource: triggerCtx.languageSource, orchestration: orchResult.telemetry, durationMs: Date.now() - ctx.startTime, hadInboundVoice: !!loaded.inboundVoiceKey, hadOutboundVoice: audioKey !== null, inputLanguage });

    // prettier-ignore
    return this.assembleChatResponse({ responses: orchResult.responses, audioKey, workerOrigin, attachmentsContext, effectivePreferences, inputLanguage, logger, startTime: ctx.startTime });
  }

  /**
   * Run the trigger classifier and resolve per-turn mode/language overrides.
   * Extracted from processChat to keep each method within lint complexity limits.
   */
  private async classifyAndResolveTriggers(
    body: ChatRequest,
    loaded: Awaited<ReturnType<UserDO['loadChatContext']>>,
    logger: RequestLogger
  ) {
    const isGroupChat = this.isGroupChatType(body);
    const classified = classifyTriggers(loaded.messageText, {
      availableModes: loaded.orgModes.modes
        .filter((m) => isModeVisible(m, { isGroupChat, isAdmin: loaded.isAdmin }))
        .map((m) => ({ name: m.name, label: m.label, aliases: m.aliases })),
      availableLanguages: loaded.orgLanguages.languages
        .filter((l) => loaded.isAdmin || l.published === true)
        .map((l) => ({ name: l.name, label: l.label })),
    });

    const result = await this.applyTriggerOverrides(body, loaded, classified, logger);

    // #360: when the message was ONLY trigger tokens, the classifier strips it
    // to the empty string — and an empty user turn makes the Anthropic API
    // reject the ENTIRE request ("messages.N: user messages must have non-empty
    // content"), so the user got a 502 instead of the language they asked for.
    // Send the raw text they typed instead: non-empty, truthful, and it keeps
    // the saved transcript matching what they actually sent. `triggerOnly` then
    // tells the orchestrator the switch already happened so it confirms rather
    // than improvising against a bare `@hindi`.
    const triggerOnly = this.buildTriggerOnlyContext(loaded, classified, result);
    const messageText = resolveTurnMessage(loaded.messageText, classified, triggerOnly);
    this.logTriggerOutcome(loaded, classified, result, !!triggerOnly, logger);

    return {
      ...result,
      messageText,
      triggerOnly,
      unmatchedTriggers: classified.unmatchedTriggers,
    };
  }

  /** Display label for an org language slug, falling back to the slug itself. */
  private languageLabelFor(
    loaded: Awaited<ReturnType<UserDO['loadChatContext']>>,
    languageName: string | undefined
  ): string | undefined {
    if (!languageName) return undefined;
    const lang = loaded.orgLanguages.languages.find((l) => l.name === languageName);
    return lang?.label || languageName;
  }

  /** Display label for an org mode slug, falling back to the slug itself. */
  private modeLabelFor(
    loaded: Awaited<ReturnType<UserDO['loadChatContext']>>,
    modeName: string | undefined
  ): string | undefined {
    if (!modeName) return undefined;
    const mode = loaded.orgModes.modes.find((m) => m.name === modeName);
    return mode?.label || modeName;
  }

  /** Resolve display labels for this turn's selections and describe it. */
  private buildTriggerOnlyContext(
    loaded: Awaited<ReturnType<UserDO['loadChatContext']>>,
    classified: ClassifierResult,
    result: Awaited<ReturnType<UserDO['applyTriggerOverrides']>>
  ): TriggerOnlyContext | undefined {
    return buildTriggerOnlyContext(classified, {
      modeLabel: this.modeLabelFor(loaded, result.activeModeName),
      languageLabel: this.languageLabelFor(loaded, result.activeLanguageName),
    });
  }

  /** Emit the classifier-result + persistence telemetry for one chat turn. */
  private logTriggerOutcome(
    loaded: Awaited<ReturnType<UserDO['loadChatContext']>>,
    classified: ClassifierResult,
    result: Awaited<ReturnType<UserDO['applyTriggerOverrides']>>,
    triggerOnly: boolean,
    logger: RequestLogger
  ): void {
    const unmatchedKinds = [...new Set(classified.unmatchedTriggers.map((t) => t.kind))].sort();
    logger.log('trigger_classifier_result', {
      requested_mode: classified.modeName ?? null,
      requested_language: classified.languageName ?? null,
      effective_mode: result.activeModeName ?? null,
      effective_language: result.activeLanguageName ?? null,
      language_source: result.languageSource,
      language_document_injected: !!result.languageDocument,
      unmatched_count: classified.unmatchedTriggers.length,
      unmatched_kinds: unmatchedKinds,
      message_stripped: classified.strippedMessage !== loaded.messageText,
      // #360: the message was nothing but routing tokens. Greppable so the
      // rate of this path — and any recurrence of the empty-turn 400 — stays
      // visible in production.
      trigger_only: triggerOnly,
    });
    logModePersistenceChange(logger, result.modePersistence, loaded.activeModeName);
    logLanguagePersistenceChange(logger, result.languagePersistence, loaded.selectedLanguageName);
  }

  /**
   * Resolve the per-turn `resolved` prompt overrides for a hashtag-activated
   * mode. Returns null when the mode could not be resolved (missing or
   * unpublished and the caller is not admin), in which case the caller
   * leaves the existing `loaded.resolved` in place.
   */
  private async resolveModeOverride(
    body: ChatRequest,
    loaded: Awaited<ReturnType<UserDO['loadChatContext']>>,
    modeName: string
  ) {
    const mode = resolveEffectiveMode(loaded.orgModes, modeName, {
      includeUnpublished: loaded.isAdmin,
      isGroupChat: this.isGroupChatType(body),
    });
    if (!mode.effectiveModeName) return null;
    const orgOverrides = body._org_prompt_overrides ?? {};
    const userOverrides = await this.getPromptOverrides();
    const resolved = applyTemplateVariables(
      resolvePromptOverrides(orgOverrides, mode.modeOverrides, userOverrides)
    );
    return { resolved, effectiveModeName: mode.effectiveModeName };
  }

  /**
   * Resolve the per-turn `resolved` prompt overrides for a clear-intent
   * hashtag — same as the no-mode default, computed by passing an empty
   * `modeOverrides` map to the resolver.
   */
  private async resolveClearedOverride(body: ChatRequest) {
    const orgOverrides = body._org_prompt_overrides ?? {};
    const userOverrides = await this.getPromptOverrides();
    return applyTemplateVariables(resolvePromptOverrides(orgOverrides, {}, userOverrides));
  }

  /**
   * Apply classifier results: resolve the per-turn mode override and language
   * document, and persist the user's selected mode AND language to DO storage
   * when the classifier signals an explicit activation (matched `#mode-name`
   * or `@language-name`) or a reserved clear-intent token (`#default` /
   * `#none` / `#clear` for mode; `@default` / `@none` / `@clear` for
   * language). Persisted selections are read back by `getSelectedMode` /
   * `getSelectedLanguage` on subsequent requests, so the active selections
   * survive chat-history rolloff and DO eviction.
   *
   * Clear-intent is processed BEFORE activation so that a combined message
   * like `#default #spoken hi` (or `@default @arabic hi`) runs the current
   * turn in default regardless of whether a prior selection was persisted.
   * Without this order, the activation branch would override the per-turn
   * resolved prompts and the persistence decider would return 'none'
   * (nothing to delete) when no prior selection existed, leaving the
   * current turn in the new selection.
   */
  private async applyTriggerOverrides(
    body: ChatRequest,
    loaded: Awaited<ReturnType<UserDO['loadChatContext']>>,
    classified: ClassifierResult,
    logger: RequestLogger
  ) {
    let resolved = loaded.resolved;
    let activeModeName = loaded.activeModeName;
    let newEffectiveModeName: string | undefined;

    if (classified.clearMode) {
      activeModeName = undefined;
      resolved = await this.resolveClearedOverride(body);
    } else if (classified.modeName && classified.modeName !== loaded.activeModeName) {
      const result = await this.resolveModeOverride(body, loaded, classified.modeName);
      if (result) {
        activeModeName = result.effectiveModeName;
        newEffectiveModeName = result.effectiveModeName;
        resolved = result.resolved;
      }
    }

    const language = this.resolveLanguageForTurn(loaded, classified, logger);

    const modePersistence = decideModePersistence(
      classified,
      loaded.activeModeName,
      newEffectiveModeName
    );
    await this.dispatchSelectionPersistence(SELECTED_MODE_KEY, modePersistence);

    const languagePersistence = decideLanguagePersistence(
      classified,
      loaded.selectedLanguageName,
      language.newEffectiveLanguageName
    );
    await this.dispatchSelectionPersistence(SELECTED_LANGUAGE_KEY, languagePersistence);

    return {
      resolved,
      activeModeName,
      languageDocument: language.languageDocument,
      activeLanguageName: language.activeLanguageName,
      languageSource: language.languageSource,
      modePersistence,
      languagePersistence,
    };
  }

  /** Apply a mode/language selection persistence decision to DO storage. */
  private async dispatchSelectionPersistence(
    storageKey: string,
    action: ModePersistenceAction | LanguagePersistenceAction
  ): Promise<void> {
    if (action.kind === 'put') {
      await this.state.storage.put(storageKey, 'mode' in action ? action.mode : action.language);
    } else if (action.kind === 'delete') {
      await this.state.storage.delete(storageKey);
    }
  }

  /**
   * Determine which language applies to this turn and resolve its document.
   *
   * Single-place resolution: this is the only site that materialises the
   * language document for the current turn. `loadChatContext` reads only the
   * persisted name; everything else — trigger override, persisted fallback,
   * published-filter stale-masking — happens here.
   *
   * `newEffectiveLanguageName` is set ONLY when the current turn's `@`-trigger
   * resolved to a language. A persisted-fallback resolve does NOT bump this
   * field, so the persistence decider never re-`put`s the same name. A
   * stale-masked trigger (unpublished/missing, non-admin) also leaves the
   * field undefined so persistence never writes a name we can't resolve.
   */
  private resolveLanguageForTurn(
    loaded: Awaited<ReturnType<UserDO['loadChatContext']>>,
    classified: ClassifierResult,
    logger: RequestLogger
  ): {
    activeLanguageName: string | undefined;
    languageDocument: string | undefined;
    newEffectiveLanguageName: string | undefined;
    languageSource: LanguageSource;
  } {
    if (classified.clearLanguage) {
      return {
        activeLanguageName: undefined,
        languageDocument: undefined,
        newEffectiveLanguageName: undefined,
        languageSource: 'none',
      };
    }
    const { requestedName, source } = selectRequestedLanguage(
      classified.languageName,
      loaded.selectedLanguageName,
      loaded.orgLanguages.defaultLanguage
    );
    const triggerActivated = source === 'trigger';
    const resolution = resolveEffectiveLanguage(loaded.orgLanguages, requestedName, {
      includeUnpublished: loaded.isAdmin,
    });
    if (resolution.reason === 'missing' || resolution.reason === 'unpublished') {
      logger.warn('language_not_found', {
        active_language: requestedName ?? null,
        available_languages: loaded.isAdmin
          ? loaded.orgLanguages.languages.map((l) => l.name)
          : loaded.orgLanguages.languages.filter((l) => l.published === true).map((l) => l.name),
        reason: resolution.reason,
        source,
      });
    }
    return {
      activeLanguageName: resolution.effectiveLanguageName,
      languageDocument: resolution.languageDocument,
      newEffectiveLanguageName: triggerActivated ? resolution.effectiveLanguageName : undefined,
      languageSource: source,
    };
  }

  /** Load all context needed for orchestration. */
  private async loadChatContext(
    body: ChatRequest,
    ctx: { timing: TimingContext; logger: RequestLogger; startTime: number },
    callbacks?: StreamCallbacks
  ) {
    const { logger } = ctx;
    // Preferences load first so the transcription status line (emitted inside
    // resolve_message) is localized to this turn's locale (#405). History is
    // not needed until orchestration, so it loads alongside STT, not ahead of it.
    const preferences = await this.tracedPhase(ctx, 'load_preferences', () =>
      this.getPreferences()
    );
    const locale = resolveStatusLocale(body, preferences);
    const emitStatus = createStatusEmitter(callbacks, locale, logger);
    const [resolved_message, history] = await Promise.all([
      this.tracedPhase(ctx, 'resolve_message', () =>
        this.resolveMessageText(body, logger, emitStatus)
      ),
      this.tracedPhase(ctx, 'load_history', () => this.loadHistory(logger)),
    ]);
    const catalog = await this.tracedPhase(ctx, 'mcp_discovery', () =>
      this.discoverMCPTools(body._mcp_servers ?? [], logger)
    );
    const { resolved, orgModes, activeModeName, isAdmin } = await this.tracedPhase(
      ctx,
      'resolve_prompts',
      () => this.resolvePrompts(body, logger)
    );
    const { memoryStore, formattedTOC } = await this.tracedPhase(ctx, 'load_memory', () =>
      this.loadMemoryContext(logger)
    );
    const orgLanguages: OrgLanguages = body._org_languages ?? { languages: [] };
    const selectedLanguageName = await this.getSelectedLanguage();
    return {
      messageText: resolved_message.text,
      inboundVoiceKey: resolved_message.inboundVoiceKey,
      preferences,
      locale,
      emitStatus,
      history,
      catalog,
      resolved,
      orgModes,
      activeModeName,
      isAdmin,
      orgLanguages,
      selectedLanguageName,
      memoryStore,
      formattedTOC,
    };
  }

  private async resolveMessageText(
    body: ChatRequest,
    logger: RequestLogger,
    emit?: StatusEmitter
  ): Promise<{ text: string; inboundVoiceKey?: string }> {
    if (body.message_type === 'audio') {
      return this.transcribeAudioMessage(body, logger, emit);
    }
    if (!body.message?.trim()) {
      throw new ValidationError('Message is required');
    }
    return { text: body.message };
  }

  private async transcribeAudioMessage(
    body: ChatRequest,
    logger: RequestLogger,
    emit?: StatusEmitter
  ): Promise<{ text: string; inboundVoiceKey?: string }> {
    const sttFlowStart = Date.now();
    const { audio_base64, audio_format } = this.requireAudioFields(body, logger);
    await emit?.('status_transcribing');

    // Run transcription and R2 archival in parallel. Whisper consumes the
    // base64 string directly; archival needs the decoded bytes. Both kick
    // off together so archival latency doesn't gate the assistant response.
    // Archival failures must NEVER block transcription — the user-facing
    // turn must still complete even if R2 hiccups, so the archival promise
    // catches its own errors and resolves to `undefined`.
    const archivalPromise = this.archiveInboundVoice(body, audio_base64, audio_format, logger);
    const transcription = await transcribeAudio(this.env.AI, audio_base64, audio_format, logger);

    if (!transcription.text) {
      // Wait for archival to settle even on transcription failure so we
      // don't leave a half-finished R2 upload running past the request.
      const archivedKey = await archivalPromise;
      logger.log('audio_flow_stt_empty_text', { archived_key: archivedKey ?? null });
      throw new AudioTranscriptionError('Transcription returned empty text');
    }

    const inboundVoiceKey = await archivalPromise;
    logger.log('audio_flow_stt_complete', {
      original_format: audio_format,
      transcribed_length: transcription.text.length,
      transcription_ms: transcription.duration_ms,
      stt_flow_total_ms: Date.now() - sttFlowStart,
      text_preview: transcription.text.slice(0, 200),
      inbound_voice_archived: inboundVoiceKey !== undefined,
      inbound_voice_key: inboundVoiceKey ?? null,
    });
    return inboundVoiceKey === undefined
      ? { text: transcription.text }
      : { text: transcription.text, inboundVoiceKey };
  }

  /**
   * Validate audio input fields on a ChatRequest and log the STT-begin
   * trace. Returns the non-null audio fields for the caller to use without
   * having to re-narrow them.
   */
  private requireAudioFields(
    body: ChatRequest,
    logger: RequestLogger
  ): { audio_base64: string; audio_format: string } {
    logger.log('audio_flow_stt_begin', {
      has_audio_base64: !!body.audio_base64,
      audio_base64_length: body.audio_base64?.length ?? 0,
      audio_format: body.audio_format,
    });
    if (!body.audio_base64 || !body.audio_format) {
      throw new ValidationError(
        'audio_base64 and audio_format are required when message_type is audio'
      );
    }
    return { audio_base64: body.audio_base64, audio_format: body.audio_format };
  }

  /**
   * Archive an inbound voice message to R2 under the
   * `voice-submissions/{org}/{chat-scope}/{speaker-scope}/{uuid}.ogg` prefix.
   *
   * Best-effort: any error inside is logged and swallowed so the parent
   * STT flow continues. The user-visible turn (transcription + response)
   * must never fail because an archival upload fizzled. Returns the R2
   * key on success, `undefined` on failure (including invalid base64).
   */
  private async archiveInboundVoice(
    body: ChatRequest,
    audioBase64: string,
    audioFormat: string,
    logger: RequestLogger
  ): Promise<string | undefined> {
    const start = Date.now();
    const org = body.org ?? body.org_id ?? this.env.DEFAULT_ORG;
    const isGroup = this.isGroupChatType(body);
    const chatScope = isGroup && body.chat_id ? body.chat_id : body.user_id;
    const speakerScope = body.speaker?.trim() ? body.speaker : body.user_id;
    const key = generateVoiceSubmissionKey(org, chatScope, speakerScope);
    const mimeType = audioFormatToMime(audioFormat);
    try {
      const bytes = decodeBase64(audioBase64);
      await uploadVoiceSubmission(this.env.AUDIO_BUCKET, key, bytes, mimeType, logger);
      return key;
    } catch (error) {
      logger.warn('inbound_voice_archive_failed', {
        key,
        mime_type: mimeType,
        elapsed_ms: Date.now() - start,
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  /**
   * Emit mode-resolution telemetry: `mode_not_found` when a stale/blocked
   * selection was masked, and `alias_resolved` (issue #284) when the persisted
   * slug routed through an alias to a renamed/retired mode. Extracted from
   * `resolvePrompts` to keep that method under the complexity ceiling.
   */
  private logModeResolution(
    body: ChatRequest,
    logger: RequestLogger,
    opts: {
      requestedModeName: string | undefined;
      resolution: ReturnType<typeof resolveEffectiveMode>;
      orgModes: { modes: PromptMode[] };
      isGroupChat: boolean;
      isAdmin: boolean;
    }
  ): void {
    const { requestedModeName, resolution, orgModes, isGroupChat, isAdmin } = opts;
    const { effectiveModeName, reason, resolvedViaAlias } = resolution;
    if (reason === 'missing' || reason === 'unpublished' || reason === 'requires-group') {
      logger.warn('mode_not_found', {
        active_mode: requestedModeName,
        available_modes: orgModes.modes
          .filter((m) => isModeVisible(m, { isGroupChat, isAdmin }))
          .map((m) => m.name),
        reason,
      });
    }
    // The subscriber's persisted slug is an old one now pointing at a renamed/
    // retired mode. Logged so Benjamin's cutovers are visible in CF logs —
    // confirms real subscribers are being rerouted, not stranded.
    if (resolvedViaAlias) {
      logger.log('alias_resolved', {
        requested_slug: requestedModeName,
        canonical_name: effectiveModeName,
        org: body.org ?? body.org_id ?? this.env.DEFAULT_ORG,
      });
    }
  }

  private async resolvePrompts(body: ChatRequest, logger: RequestLogger) {
    const isAdmin = isAdminClient(body.client_id);
    const orgOverrides = body._org_prompt_overrides ?? {};
    const orgModes = body._org_modes ?? { modes: [] };
    const userSelectedMode = await this.getSelectedMode();
    const requestedModeName = resolveActiveModeName(userSelectedMode);

    // effectiveModeName masks a stale selection so the orchestrator's list_modes
    // tool doesn't surface a mode that has been unpublished or deleted as
    // "active." The persisted selection in storage is left untouched in case the
    // mode is republished later — we only mask in-memory for this request.
    // Admin-origin requests skip the published filter so authors can test drafts
    // from the portal's test chat pane.
    const isGroupChat = this.isGroupChatType(body);
    const resolution = resolveEffectiveMode(orgModes, requestedModeName, {
      includeUnpublished: isAdmin,
      isGroupChat,
    });
    const { effectiveModeName, modeOverrides } = resolution;
    this.logModeResolution(body, logger, {
      requestedModeName,
      resolution,
      orgModes,
      isGroupChat,
      isAdmin,
    });

    const userOverrides = await this.getPromptOverrides();
    const resolved = applyTemplateVariables(
      resolvePromptOverrides(orgOverrides, modeOverrides, userOverrides)
    );

    const overriddenSlots = PROMPT_OVERRIDE_SLOTS.filter(
      // eslint-disable-next-line security/detect-object-injection -- s is from PROMPT_OVERRIDE_SLOTS constant
      (s) => resolved[s] !== DEFAULT_PROMPT_VALUES[s]
    );
    if (overriddenSlots.length > 0) {
      logger.log('prompt_overrides_applied', {
        org_overrides: Object.keys(orgOverrides).length,
        mode_overrides: Object.keys(modeOverrides).length,
        active_mode: effectiveModeName ?? null,
        user_overrides: Object.keys(userOverrides).length,
        overridden_slots: overriddenSlots,
      });
    }
    return { resolved, orgModes, activeModeName: effectiveModeName, isAdmin };
  }

  private async loadMemoryContext(logger: RequestLogger) {
    const memoryStore = new JsonMemoryStore(this.state.storage, logger);
    const memoryTOC = await memoryStore.getTableOfContents();
    const formattedTOC = formatTOCForPrompt(memoryTOC);
    return { memoryStore, formattedTOC: formattedTOC || undefined };
  }

  private async loadHistory(logger: RequestLogger) {
    const startTime = Date.now();
    const history = await this.getHistory();
    logger.log('phase_load_complete', {
      history_count: history.length,
      duration_ms: Date.now() - startTime,
    });
    return history;
  }

  private async discoverMCPTools(mcpServers: MCPServerConfig[], logger: RequestLogger) {
    const startTime = Date.now();
    const servers = mcpServers.filter((s) => s.enabled).sort((a, b) => a.priority - b.priority);
    const manifests = await discoverAllTools(servers, logger);
    const catalog = buildToolCatalog(manifests, servers, logger);
    logger.log('mcp_catalog_built', {
      server_count: servers.length,
      tool_count: catalog.tools.length,
      discovery_duration_ms: Date.now() - startTime,
    });
    return catalog;
  }

  private async saveConversation(
    message: string,
    responses: string[],
    preferences: UserPreferencesInternal,
    orgConfig: OrgConfig,
    opts: {
      logger: RequestLogger;
      audioKey?: string | null;
      inboundVoiceKey?: string | undefined;
      speaker?: string | undefined;
      attachments?: Attachment[];
    }
  ) {
    const { logger, audioKey, inboundVoiceKey, speaker, attachments } = opts;
    const startTime = Date.now();
    const storageMax = orgConfig.max_history_storage ?? DEFAULT_ORG_CONFIG.max_history_storage;
    const hasAttachments = !!attachments && attachments.length > 0;
    await this.addHistoryEntry(
      {
        user_message: message,
        assistant_response: responses.join('\n'),
        timestamp: Date.now(),
        ...(audioKey ? { voice_audio_key: audioKey } : {}),
        ...(inboundVoiceKey ? { inbound_voice_audio_key: inboundVoiceKey } : {}),
        ...(speaker ? { speaker } : {}),
        ...(hasAttachments ? { attachments } : {}),
      },
      storageMax
    );
    if (preferences.first_interaction) {
      await this.updatePreferences({ ...preferences, first_interaction: false });
    }
    logger.log('phase_save_complete', {
      duration_ms: Date.now() - startTime,
      storageMax,
      attachment_count: attachments?.length ?? 0,
    });
  }

  // ── Audio ─────────────────────────────────────────────────────────────────────

  /** Extract only the final iteration's text for TTS (skip intermediate narration). */
  private extractTtsResponses(orchResult: OrchestrationResult, logger: RequestLogger): string[] {
    const { responses, finalIterationStartIndex } = orchResult;
    const ttsResponses = responses.slice(finalIterationStartIndex);
    logger.log('audio_flow_tts_filter', {
      total_responses: responses.length,
      final_iteration_start: finalIterationStartIndex,
      tts_responses: ttsResponses.length,
      filtered_out: responses.length - ttsResponses.length,
    });
    return ttsResponses;
  }

  private async maybeGenerateAudio(
    body: ChatRequest,
    audioContext: AudioContext,
    responses: string[],
    logger: RequestLogger,
    emit?: StatusEmitter
  ): Promise<{ audioKey: string } | null> {
    const ttsFlowStart = Date.now();
    const shouldGenerate = body.message_type === 'audio' || audioContext.audioRequested;
    const combinedText = responses.join('\n\n');
    const org = body.org ?? this.env.DEFAULT_ORG;
    const userId = body.user_id;
    logger.log('audio_flow_tts_decision', {
      message_type: body.message_type,
      audio_requested_by_tool: audioContext.audioRequested,
      should_generate: shouldGenerate,
      response_count: responses.length,
      combined_text_chars: combinedText.length,
      individual_response_lengths: responses.map((r) => r.length),
      has_responses: responses.length > 0,
    });
    if (!shouldGenerate || responses.length === 0) {
      logger.log('audio_flow_tts_skipped', {
        reason: !shouldGenerate ? 'not_requested' : 'no_responses',
      });
      return null;
    }
    const audio = await this.generateVoiceResponse(org, userId, responses, logger, emit);
    logger.log('audio_flow_tts_result', {
      has_audio: audio !== null,
      audio_key: audio?.audioKey ?? null,
      tts_flow_total_ms: Date.now() - ttsFlowStart,
    });
    return audio;
  }

  private startTtsKeepalive(
    emit: StatusEmitter,
    genStart: number,
    logger: RequestLogger
  ): { interval: ReturnType<typeof setInterval>; getCount: () => number } {
    let count = 0;
    const interval = setInterval(() => {
      count++;
      logger.log('tts_keepalive_sent', {
        keepalive_number: count,
        elapsed_seconds: Math.round((Date.now() - genStart) / 1000),
      });
      // The emitter logs and swallows callback failures itself; this guard is
      // for anything else, so a broken keepalive stops instead of repeating.
      emit('status_tts_still_generating').catch((error: unknown) => {
        logger.warn('tts_keepalive_failed', {
          error: error instanceof Error ? error.message : String(error),
          keepalive_number: count,
        });
        clearInterval(interval);
      });
    }, 15_000);
    return { interval, getCount: () => count };
  }

  private async generateVoiceResponse(
    org: string,
    userId: string,
    responses: string[],
    logger: RequestLogger,
    emit?: StatusEmitter
  ): Promise<{ audioKey: string } | null> {
    const genStart = Date.now();
    const combinedText = responses.join('\n\n');
    logger.log('audio_flow_generate_voice_start', {
      response_count: responses.length,
      combined_text_chars: combinedText.length,
      has_callbacks: !!emit,
    });

    const keepalive = emit ? this.startTtsKeepalive(emit, genStart, logger) : null;
    try {
      await emit?.('status_tts_generating');
      const synthesis = await synthesizeSpeech(this.env.OPENAI_API_KEY, combinedText, logger);
      const synthesisDoneAt = Date.now();

      const audioKey = generateAudioKey(org, userId);
      await uploadAudio(this.env.AUDIO_BUCKET, audioKey, synthesis.audio_bytes, logger);
      const uploadDoneAt = Date.now();

      logger.log('audio_flow_generate_voice_complete', {
        input_chars: synthesis.input_chars,
        synthesis_ms: synthesis.duration_ms,
        r2_upload_ms: uploadDoneAt - synthesisDoneAt,
        generate_voice_total_ms: uploadDoneAt - genStart,
        audio_bytes: synthesis.audio_bytes.byteLength,
        audio_key: audioKey,
        keepalives_sent: keepalive?.getCount() ?? 0,
      });
      return { audioKey };
    } catch (error) {
      logger.error('tts_generation_failed', error, {
        generate_voice_total_ms: Date.now() - genStart,
        combined_text_chars: combinedText.length,
        keepalives_sent: keepalive?.getCount() ?? 0,
      });
      return null;
    } finally {
      if (keepalive) clearInterval(keepalive.interval);
    }
  }

  // ── Ambient short-circuit ────────────────────────────────────────────────────

  /**
   * Short-circuit ambient text chatter: archive the message to history (so
   * Claude has group context on future turns) and return an empty response
   * without ever calling the LLM.  Audio with addressed_to_bot=false still
   * flows through — spoken-mode treats ambient voice during Step 0 as story
   * submissions.  Returns `null` when the message should proceed normally.
   */
  private async maybeShortCircuitAmbient(
    body: ChatRequest,
    loaded: Awaited<ReturnType<UserDO['loadChatContext']>>,
    logger: RequestLogger
  ): Promise<ChatResponse | null> {
    if (body.addressed_to_bot !== false || body.message_type === 'audio') return null;

    logger.log('ambient_text_short_circuit', {
      message_type: body.message_type,
      speaker: body.speaker,
    });
    await this.saveConversation(
      loaded.messageText,
      [],
      loaded.preferences,
      body._org_config ?? {},
      {
        logger,
        speaker: body.speaker,
      }
    );
    return {
      responses: [],
      response_language: loaded.preferences.response_language,
      voice_audio_base64: null,
      voice_audio_url: null,
    };
  }

  // ── Orchestration helpers ─────────────────────────────────────────────────────

  private async tracedPhase<T>(
    ctx: { timing: TimingContext; logger: RequestLogger; startTime: number },
    phase: string,
    fn: () => Promise<T>
  ): Promise<T> {
    const result = await timePhase(ctx.timing, phase, fn);
    ctx.logger.log('process_chat_phase', { phase, elapsed_ms: Date.now() - ctx.startTime });
    return result;
  }

  private async runOrchestration(
    messageText: string,
    options: Parameters<typeof orchestrate>[1]
  ): Promise<OrchestrationResult> {
    const startTime = Date.now();
    const result = await orchestrate(messageText, options);
    options.logger.log('phase_orchestration_complete', {
      response_count: result.responses.length,
      duration_ms: Date.now() - startTime,
    });
    return result;
  }

  // eslint-disable-next-line max-params -- opts builder, all params are necessary context
  private buildOrchOpts(
    body: ChatRequest,
    catalog: ReturnType<typeof buildToolCatalog>,
    history: ChatHistoryEntry[],
    preferences: UserPreferencesInternal,
    resolvedPromptValues: ReturnType<typeof resolvePromptOverrides>,
    memoryStore: JsonMemoryStore,
    formattedTOC: string | undefined,
    orgModes: { modes: PromptMode[] },
    activeModeName: string | undefined,
    audioContext: AudioContext,
    attachmentsContext: AttachmentsContext,
    workerOrigin: string,
    logger: RequestLogger,
    callbacks?: StreamCallbacks,
    groupContext?: GroupChatContext,
    languageDocument?: string,
    unmatchedTriggers?: UnmatchedTrigger[],
    inboundVoiceKey?: string | undefined,
    languageContext?: LanguageOrchestrationContext
  ): Parameters<typeof orchestrate>[1] {
    return {
      env: this.env,
      catalog,
      history,
      orgConfig: body._org_config ?? {},
      preferences: {
        response_language: preferences.response_language,
        first_interaction: preferences.first_interaction,
      },
      resolvedPromptValues,
      memoryStore,
      memoryTOC: formattedTOC || undefined,
      modeContext: this.buildModeContext(orgModes, activeModeName, body),
      audioContext,
      attachmentsContext,
      workerOrigin,
      clientId: body.client_id,
      groupContext,
      isVoiceMessage: body.message_type === 'audio',
      languageDocument,
      ...languageContext,
      unmatchedTriggers,
      addressedToBot: body.addressed_to_bot,
      inboundVoiceKey,
      org: body.org ?? body.org_id ?? this.env.DEFAULT_ORG,
      logger,
      callbacks,
    };
  }

  /** True when the request originates from a (Telegram) group/supergroup chat. */
  private isGroupChatType(body: ChatRequest): boolean {
    const chatType = body.chat_type ?? 'private';
    return chatType === 'group' || chatType === 'supergroup';
  }

  private maybeBuildGroupContext(body: ChatRequest): GroupChatContext | undefined {
    if (!this.isGroupChatType(body)) return undefined;
    return {
      isGroupChat: true,
      ...(body.speaker ? { currentSpeaker: body.speaker } : {}),
    };
  }

  private assembleChatResponse(opts: {
    responses: string[];
    audioKey: string | null;
    workerOrigin: string;
    attachmentsContext: AttachmentsContext;
    effectivePreferences: { response_language: string };
    inputLanguage: DetectedLanguage | null;
    logger: RequestLogger;
    startTime: number;
  }): ChatResponse {
    const {
      responses,
      audioKey,
      workerOrigin,
      attachmentsContext,
      effectivePreferences,
      inputLanguage,
      logger,
      startTime,
    } = opts;
    const voiceAudioUrl = audioKey ? audioKeyToUrl(audioKey, workerOrigin) : null;
    const attachments = attachmentsContext.list();
    // prettier-ignore
    logger.log('process_chat_complete', { total_ms: Date.now() - startTime, response_count: responses.length, has_voice_audio: voiceAudioUrl !== null, voice_audio_key: audioKey, total_response_chars: responses.join('').length, attachment_count: attachments.length, attachment_summary: attachments.map((a) => a.type === 'pdf' ? ({ type: a.type, filename: a.filename, size_bytes: a.size_bytes }) : ({ type: a.type, r2_key: a.r2_key, mime_type: a.mime_type })), response: responses.join('\n') });
    return {
      responses,
      response_language: effectivePreferences.response_language,
      input_language: inputLanguage?.code ?? UNDETERMINED_LANGUAGE,
      voice_audio_base64: null,
      voice_audio_url: voiceAudioUrl,
      ...(attachments.length > 0 ? { attachments } : {}),
    };
  }

  private buildAudioContext(): AudioContext {
    const ctx: AudioContext = {
      audioRequested: false,
      requestAudio: () => {
        ctx.audioRequested = true;
      },
    };
    return ctx;
  }

  private buildModeContext(
    orgModes: { modes: PromptMode[] },
    activeModeName: string | undefined,
    body: ChatRequest
  ): ModeContext {
    const isAdmin = isAdminClient(body.client_id);
    const isGroupChat = this.isGroupChatType(body);
    return {
      availableModes: orgModes.modes.filter((m) => isModeVisible(m, { isGroupChat, isAdmin })),
      activeModeName,
      setSelectedMode: async (name: string | null) => {
        if (name === null) {
          await this.state.storage.delete(SELECTED_MODE_KEY);
        } else {
          await this.state.storage.put(SELECTED_MODE_KEY, name);
        }
      },
    };
  }

  // ── Preferences / history / overrides / mode / memory handlers ────────────────

  private async handleGetPreferences(): Promise<Response> {
    return withEndpointLogging(this.getLogger(), 'get_preferences', async () => {
      const prefs = await this.getPreferences();
      // Report a language only when the user explicitly set one. Otherwise the
      // stored value is a default the worker never asked for; reporting it would
      // let clients mistake "never chose" for "chose English" (see #408).
      const apiPrefs: UserPreferencesAPI = {
        response_language: prefs.response_language_explicit ? prefs.response_language : null,
      };
      return Response.json(apiPrefs);
    });
  }

  private async handleUpdatePreferences(request: Request): Promise<Response> {
    return withEndpointLogging(this.getLogger(), 'update_preferences', async () => {
      const updates = (await request.json()) as UpdatePreferencesRequest;

      if (updates.response_language !== undefined) {
        if (
          typeof updates.response_language !== 'string' ||
          !isValidLanguageCode(updates.response_language)
        ) {
          return Response.json(
            {
              error: 'Invalid response_language',
              message:
                'Must be a valid ISO 639-1 language code (2 lowercase letters, e.g., "en", "es", "fr")',
            },
            { status: 400 }
          );
        }
      }

      const current = await this.getPreferences();
      const updated: UserPreferencesInternal = {
        ...current,
        ...(updates.response_language !== undefined && {
          response_language: updates.response_language,
          // Mark the language as explicitly chosen. This is the ONLY place the
          // flag is set, so GET /preferences can tell an explicit choice from a
          // worker-supplied default (see #408).
          response_language_explicit: true,
        }),
      };
      await this.updatePreferences(updated);

      // Report the language only when it is explicitly set, mirroring
      // handleGetPreferences — otherwise an empty PUT (no response_language, a
      // valid request) would echo the internal default while a subsequent GET
      // returns null, contradicting itself (see #408).
      const apiPrefs: UserPreferencesAPI = {
        response_language: updated.response_language_explicit ? updated.response_language : null,
      };
      return Response.json(apiPrefs);
    });
  }

  private async handleGetHistory(url: URL): Promise<Response> {
    return withEndpointLogging(this.getLogger(), 'get_history', async () => {
      const requestedLimit = parseInt(
        url.searchParams.get('limit') ?? String(DEFAULT_ORG_CONFIG.max_history_storage),
        10
      );
      const limit = Math.min(requestedLimit, DEFAULT_ORG_CONFIG.max_history_storage);
      const offset = parseInt(url.searchParams.get('offset') ?? '0', 10);
      const userId = url.searchParams.get('user_id') ?? '';

      const allHistory = await this.getHistory();
      const total = allHistory.length;
      const entries = allHistory.slice(offset, offset + limit).map((e) => ({
        ...e,
        created_at: e.timestamp ? new Date(e.timestamp).toISOString() : null,
        voice_audio_url: e.voice_audio_key ? audioKeyToUrl(e.voice_audio_key, url.origin) : null,
        inbound_voice_audio_url: e.inbound_voice_audio_key
          ? voiceSubmissionKeyToUrl(e.inbound_voice_audio_key, url.origin)
          : null,
      }));

      const response: ChatHistoryResponse = {
        user_id: userId,
        entries,
        total_count: total,
        limit,
        offset,
      };
      return Response.json(response);
    });
  }

  private async handleDeleteHistory(): Promise<Response> {
    return withEndpointLogging(
      this.getLogger(),
      'delete_history',
      async () => {
        await this.state.storage.delete(HISTORY_KEY);
        return Response.json({ message: 'User history cleared' });
      },
      storageErrorResponse
    );
  }

  private async handleGetIdentity(): Promise<Response> {
    return withEndpointLogging(
      this.getLogger(),
      'get_identity',
      async () => {
        const identity = (await this.state.storage.get<StoredIdentity>(IDENTITY_KEY)) ?? null;
        return Response.json({ identity });
      },
      storageErrorResponse
    );
  }

  private async handleGetPromptOverrides(): Promise<Response> {
    return withEndpointLogging(
      this.getLogger(),
      'get_prompt_overrides',
      async () => {
        const overrides = await this.getPromptOverrides();
        return Response.json(overrides);
      },
      storageErrorResponse
    );
  }

  private async handleUpdatePromptOverrides(request: Request): Promise<Response> {
    return withEndpointLogging(
      this.getLogger(),
      'update_prompt_overrides',
      async () => {
        const body = await request.json();
        const error = validatePromptOverrides(body);
        if (error) {
          return Response.json({ error }, { status: 400 });
        }
        const current = await this.getPromptOverrides();
        const merged = mergePromptOverrides(current, body as PromptOverrides);
        await this.updatePromptOverrides(merged);
        return Response.json(merged);
      },
      storageErrorResponse
    );
  }

  private async handleDeletePromptOverrides(): Promise<Response> {
    return withEndpointLogging(
      this.getLogger(),
      'delete_prompt_overrides',
      async () => {
        await this.state.storage.delete(PROMPT_OVERRIDES_KEY);
        return Response.json({ message: 'User prompt overrides cleared' });
      },
      storageErrorResponse
    );
  }

  private async handleGetMemory(): Promise<Response> {
    return withEndpointLogging(
      this.getLogger(),
      'get_memory',
      async () => {
        const store = new JsonMemoryStore(this.state.storage, this.getLogger());
        const { content, toc, entries } = await store.readAll();
        return Response.json({ content, toc, entries });
      },
      storageErrorResponse
    );
  }

  private async handleDeleteMemory(): Promise<Response> {
    return withEndpointLogging(
      this.getLogger(),
      'delete_memory',
      async () => {
        const store = new JsonMemoryStore(this.state.storage, this.getLogger());
        await store.clear();
        return Response.json({ message: 'User memory cleared' });
      },
      storageErrorResponse
    );
  }

  private async handleGetMode(): Promise<Response> {
    return withEndpointLogging(this.getLogger(), 'get_mode', async () => {
      const mode = await this.getSelectedMode();
      return Response.json({ mode: mode ?? null });
    });
  }

  private async handleSetMode(request: Request): Promise<Response> {
    return withEndpointLogging(this.getLogger(), 'set_mode', async () => {
      const body = (await request.json()) as Record<string, unknown>;
      const nameError = validateModeName(body.mode);
      if (nameError) {
        return Response.json({ error: nameError }, { status: 400 });
      }
      await this.state.storage.put(SELECTED_MODE_KEY, body.mode as string);
      return Response.json({ mode: body.mode, message: 'User mode updated' });
    });
  }

  private async handleDeleteMode(): Promise<Response> {
    return withEndpointLogging(this.getLogger(), 'delete_mode', async () => {
      await this.state.storage.delete(SELECTED_MODE_KEY);
      return Response.json({ mode: null, message: 'User mode cleared' });
    });
  }

  // ── Storage helpers ───────────────────────────────────────────────────────────

  private async getSelectedMode(): Promise<string | undefined> {
    return this.state.storage.get<string>(SELECTED_MODE_KEY);
  }

  private async getSelectedLanguage(): Promise<string | undefined> {
    return this.state.storage.get<string>(SELECTED_LANGUAGE_KEY);
  }

  private async getPromptOverrides(): Promise<PromptOverrides> {
    return (await this.state.storage.get<PromptOverrides>(PROMPT_OVERRIDES_KEY)) ?? {};
  }

  private async updatePromptOverrides(overrides: PromptOverrides): Promise<void> {
    await this.state.storage.put(PROMPT_OVERRIDES_KEY, overrides);
  }

  private async getHistory(): Promise<ChatHistoryEntry[]> {
    const history = await this.state.storage.get<ChatHistoryEntry[]>(HISTORY_KEY);
    return history ?? [];
  }

  private async addHistoryEntry(entry: ChatHistoryEntry, maxStorage: number): Promise<void> {
    const history = await this.getHistory();
    history.push(entry);
    const trimmed = history.slice(-maxStorage);
    await this.state.storage.put(HISTORY_KEY, trimmed);
  }

  private async getPreferences(): Promise<UserPreferencesInternal> {
    const prefs = await this.state.storage.get<UserPreferencesInternal>(PREFERENCES_KEY);
    return prefs ?? DEFAULT_PREFERENCES;
  }

  private async updatePreferences(preferences: UserPreferencesInternal): Promise<void> {
    await this.state.storage.put(PREFERENCES_KEY, preferences);
  }

  /**
   * `resolveStatusLocale` for a path that has no turn context yet (queued
   * notice, transport error fallbacks). One preferences read; the DO runtime
   * caches it. A failed read degrades to the hint or English — the string is
   * a courtesy, not the turn — but is logged so it never fails invisibly.
   */
  private async readStatusLocale(body: ChatRequest, logger: RequestLogger): Promise<string> {
    try {
      return resolveStatusLocale(body, await this.getPreferences());
    } catch (error) {
      logger.warn('status_locale_read_failed', {
        error: error instanceof Error ? error.message : String(error),
        user_id: body.user_id,
      });
      // Explicitly continue — the string is still sent, from the hint or in English.
      return resolveStatusLocale(body, DEFAULT_PREFERENCES);
    }
  }

  // ── Config helpers ────────────────────────────────────────────────────────────

  private getMaxQueueDepth(): number {
    return parseInt(this.env.MAX_QUEUE_DEPTH ?? '', 10) || DEFAULT_MAX_QUEUE_DEPTH;
  }

  private getMaxRetries(): number {
    return parseInt(this.env.QUEUE_MAX_RETRIES ?? '', 10) || DEFAULT_MAX_RETRIES;
  }
}
