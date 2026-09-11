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
import { APP_VERSION } from '../generated/version.js';
import {
  GroupChatContext,
  orchestrate,
  OrchestrationResult,
  TriggerOnlyContext,
  DEFAULT_MODEL,
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
  VoiceFormat,
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
import { buildModeWelcomeText } from '../utils/mode-welcome.js';
import { WA_ME_ORIGIN } from '../utils/mode-share-link.js';
import {
  transcribeAudio,
  synthesizeSpeech,
  AudioContext,
  SpeechSynthesisResult,
  generateAudioKey,
  audioKeyToUrl,
  uploadAudio,
  generateVoiceSubmissionKey,
  uploadVoiceSubmission,
  voiceSubmissionKeyToUrl,
  normalizeAudioFormat,
  voiceFormatSpec,
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
import { chatTurnText, type ChatTurnText } from '../services/telemetry/chat-turn-text.js';
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
/**
 * Prefix for the one-time welcome flag (#311). Keyed per-mode (`mode_welcomed:<slug>`)
 * and per-user in group chats (see `modeWelcomedKey`) — NOT the global
 * `first_interaction` preference, so an existing user still gets a mode's
 * welcome the first time they scan its QR.
 */
const MODE_WELCOMED_PREFIX = 'mode_welcomed:';
/**
 * Prefix for the durable pending-welcome bit (#311, FIX C). Set when a welcome
 * DELIVERY fails (the send threw) so the welcome is not lost: a later turn in
 * the same mode re-emits it even WITHOUT an explicit `#` trigger, and clears
 * this bit on a successful (re)delivery. Keyed identically to
 * `mode_welcomed:<key>` (per-user in group chats — see `modeWelcomePendingKey`).
 */
const MODE_WELCOME_PENDING_PREFIX = 'mode_welcome_pending:';
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
  aac: 'audio/aac',
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
  /**
   * The user's message and the assistant's reply
   * (services/telemetry/chat-turn-text.ts). Log payload only — never a
   * metric label.
   */
  text: ChatTurnText;
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
    // The conversation itself: user_message / assistant_reply (chat-turn-text.ts).
    ...turn.text,
    ...turnProvenance(turn),
  };
}

/**
 * Which engine produced the turn and what it did along the way: the build
 * version, so any metric can be split by deploy, and the tool calls the
 * orchestrator made — names, servers and timings only, never arguments.
 */
function turnProvenance(turn: ChatTurnContext): Record<string, unknown> {
  return {
    engine_version: APP_VERSION,
    tool_calls: turn.orchestration.toolCalls,
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

/** Bounded label for why a turn failed: an AppError's code, else the error's class name. Never the message. */
export function failureType(error: unknown): string {
  if (error instanceof AppError) return error.code;
  if (error instanceof Error) return error.name || 'Error';
  return 'unknown';
}

type FailedTurnEnv = Pick<Env, 'DEFAULT_ORG' | 'CLAUDE_MODEL'>;

/**
 * A first-contact mode welcome resolved for the current turn (#311).
 *
 * `keys` carries the durable storage keys the delivery outcome writes:
 * `welcomed` (the one-time flag) is set and `pending` cleared on a SUCCESSFUL
 * delivery; `pending` is set on a FAILED delivery so a later turn re-emits.
 * `keys` is absent for admin re-previews (FIX B) — admins always re-emit and
 * neither read nor write either bit.
 */
interface ModeWelcome {
  text: string;
  keys?: { welcomed: string; pending: string };
}

/**
 * Outcome of the pre-orchestration welcome delivery (#311, FIX 1).
 *
 * `handledOutOfBand` — a transport-level `onWelcome` sink existed (the
 * webhook/WhatsApp path ONLY, per FIX 1), so the welcome was sent as its OWN
 * message and must NOT be prepended into `responses`. Both the SSE path
 * (`/chat/stream`) and TRUE `/chat/final` leave this false and the caller
 * prepends the welcome in-band into `responses`.
 *
 * `delivered` — the welcome actually reached the user THIS turn: the
 * out-of-band send resolved without throwing. On a throw it is false and a
 * `pending` bit was set to re-emit on a later turn. Model-welcome suppression
 * (FIX 2) is gated on `emittingWelcome` (a welcome was DUE this turn), NOT on
 * delivery: a failed out-of-band send falls back to the `pending` re-emit of
 * the authored copy, never to a second (model) welcome.
 */
interface WelcomeDelivery {
  handledOutOfBand: boolean;
  delivered: boolean;
}

/**
 * #311 FIX B: mutable tracker threaded from `processChat` into `runChatTurn` so
 * the wrapper's finally can arm a pending re-emit when the turn throws AFTER the
 * mode was persisted but BEFORE the in-band welcome's flag/pending write ran.
 *
 * `due` — the welcome resolved for this turn (undefined when none). `handledOutOfBand`
 * — the webhook path already recorded/pended it (guard skips). `finalized` — the
 * in-band recording ran (or was deferred to the SSE caller), so the guard must
 * NOT also arm pending.
 */
interface InBandWelcomeTracker {
  due: ModeWelcome | undefined;
  handledOutOfBand: boolean;
  finalized: boolean;
}

/**
 * The `chat_turn` record for a turn that failed for GOOD — retries exhausted,
 * or a path that never retries. Without it an outage reads as silence: every
 * turn that reached telemetry had succeeded, so an error rate could only ever
 * be zero. Carries what is known at that point (who, which channel, what was
 * asked) plus `exit_reason: 'error'` and a bounded `error_type`; never the
 * error message, which can quote user input. Mints its own turn_id — a failed
 * turn never has a successful twin.
 */
export function buildFailedChatTurnRecord(
  body: ChatRequest,
  env: FailedTurnEnv,
  error: unknown
): Record<string, unknown> {
  const dims = buildChatTurnDimensions(body, env.DEFAULT_ORG);
  return {
    turn_id: crypto.randomUUID(),
    user_id: body.user_id,
    org: dims.org,
    client_id: body.client_id,
    transport: dims.transport ?? null,
    chat_type: dims.chatType,
    user_country: dims.userCountry ?? null,
    edge_country: dims.edgeCountry ?? null,
    model: env.CLAUDE_MODEL ?? DEFAULT_MODEL,
    exit_reason: 'error',
    error_type: failureType(error),
    had_inbound_voice: body.message_type === 'audio',
    had_outbound_voice: false,
    engine_version: APP_VERSION,
    tool_calls: [],
    // The question that went unanswered (scrubbed downstream like any turn); no reply exists.
    user_message: body.message ?? '',
    assistant_reply: '',
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
      this.logFailedChatTurn(body, error, logger);
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
        this.logFailedChatTurn(body, error, logger);
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
    const { sendEvent, keepaliveInterval, state } = this.buildSSESender(writer, logger, Date.now());

    // #311 FIX 1: the SSE path does NOT wire `onWelcome`. Both live SSE consumers
    // (web client `use-chat-runtime.ts`, portal `sse-stream.ts`) REPLACE the
    // stream with `complete.responses`, so a progress-only welcome would be
    // dropped while the flag still got recorded. The welcome is instead prepended
    // in-band into `complete.responses` (see `processChat`).
    // TODO(#311 follow-up): a truly-separate SSE welcome bubble would need a new
    // dedicated SSE event type plus web-client + portal changes to render it.
    // FIX 1: `deferInBandWelcomeRecord` captures the DO's flag-recording closure
    // so it runs AFTER the `complete` write, gated on the client still being
    // connected (a disconnect records a pending re-emit instead of the flag).
    let recordWelcome: ((delivered: boolean) => Promise<void>) | undefined;
    const callbacks: StreamCallbacks = {
      onStatus: async (status) => sendEvent({ type: 'status', ...status }),
      onProgress: async (text) => sendEvent({ type: 'progress', text }),
      onComplete: async (response) => sendEvent({ type: 'complete', response }),
      onError: async (error) => sendEvent({ type: 'error', error }),
      onToolUse: async (tool, input) => sendEvent({ type: 'tool_use', tool, input }),
      onToolResult: async (tool, result) => sendEvent({ type: 'tool_result', tool, result }),
      deferInBandWelcomeRecord: (record) => {
        recordWelcome = record;
      },
    };

    // Process in background — the Response is returned immediately with the SSE stream
    (async () => {
      try {
        const timing = createTimingContext();
        const response = await this.processChat(body, workerOrigin, logger, timing, callbacks);
        await sendEvent({ type: 'complete', response });
        // #311 FIX 1: record the one-time welcome flag ONLY after the `complete`
        // write, with the live connection state — a mid-turn disconnect leaves a
        // pending re-emit instead of burning the flag on an unseen welcome.
        await this.finalizeSseWelcomeRecord(recordWelcome, state, logger);
      } catch (error) {
        this.logFailedChatTurn(body, error, logger);
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
    // #311 FIX A: a MISSING writer means the welcome was never delivered. The
    // queued-SSE caller (`processSSEEntry`) builds a sender from
    // `queuedWriters.get(id)`, which is `undefined` when the writer was deleted
    // on a client disconnect (`createQueuedSSEStream`) or never registered (a
    // retry). `sendEvent`/keepalive already no-op on `!writer` WITHOUT throwing,
    // so `clientDisconnected` would otherwise stay `false` and
    // `finalizeSseWelcomeRecord` would burn the one-time flag on a `complete`
    // that never went out. Seed `clientDisconnected` from writer presence so a
    // missing writer flows through as not-delivered ⇒ pending is armed instead.
    const state = {
      clientDisconnected: writer === undefined,
      firstTokenTime: null as number | null,
    };

    const sendEvent = async (event: SSEEvent): Promise<void> => {
      if (state.clientDisconnected || !writer) return;
      // Non-whitespace only: the metric should time the first real word, not an
      // inter-iteration separator or a whitespace-only text delta (#410).
      if (event.type === 'progress' && event.text.trim() !== '' && state.firstTokenTime === null) {
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
    const { sendEvent, keepaliveInterval, state } = this.buildSSESender(writer, logger, Date.now());
    // Resolved inside the try so the finally (writer close) always runs.
    let locale = DEFAULT_PREFERENCES.response_language;

    try {
      locale = await this.readStatusLocale(body, logger);
      // #311 FIX 1: no `onWelcome` on the SSE path — the welcome is prepended
      // in-band into `complete.responses` (both SSE consumers replace the stream
      // with that array, so an out-of-band progress welcome would be dropped).
      // `deferInBandWelcomeRecord` defers the one-time flag write to after the
      // `complete` send so a mid-turn disconnect re-emits instead of skipping.
      let recordWelcome: ((delivered: boolean) => Promise<void>) | undefined;
      const callbacks: StreamCallbacks = {
        onStatus: async (status) => sendEvent({ type: 'status', ...status }),
        onProgress: async (text) => sendEvent({ type: 'progress', text }),
        // onComplete is sent explicitly after processChat returns (not by the orchestrator)
        onComplete: async (response) => sendEvent({ type: 'complete', response }),
        onError: async (error) => sendEvent({ type: 'error', error }),
        onToolUse: async (tool, input) => sendEvent({ type: 'tool_use', tool, input }),
        onToolResult: async (tool, result) => sendEvent({ type: 'tool_result', tool, result }),
        deferInBandWelcomeRecord: (record) => {
          recordWelcome = record;
        },
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
      // #311 FIX 1: record the one-time welcome flag only after the `complete`
      // write, gated on the client still being connected (else pending re-emit).
      await this.finalizeSseWelcomeRecord(recordWelcome, state, logger);
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

    // Permanent failure: count the turn as failed, then notify the SSE client if connected.
    this.logFailedChatTurn(entry.body, error, logger);
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
      // #428: voice turns get a voice reply whose TTS already strips
      // intermediate narration (extractTtsResponses); suppress the text
      // side too or gateways interleave narration bubbles before the voice
      // note. Gated on message_type only — tool-requested audio on a text
      // turn (audioContext.audioRequested) is unknowable this early.
      suppressProgressText: body.message_type === 'audio',
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
   * Emit a `chat_turn` for a turn that failed for good, so failures are
   * counted rather than read as silence. Observability for a turn that has
   * ALREADY failed: it must never turn one failure into two.
   */
  private logFailedChatTurn(body: ChatRequest, error: unknown, logger: RequestLogger): void {
    try {
      logger.log('chat_turn', buildFailedChatTurnRecord(body, this.env, error));
    } catch (logError) {
      logger.warn('chat_turn_telemetry_failed', {
        error: logError instanceof Error ? logError.message : String(logError),
        user_id: body.user_id,
      });
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
    // #311 FIX B: track the in-band welcome so the finally can arm a pending
    // re-emit when orchestration or save throws AFTER the mode was persisted (at
    // `classifyAndResolveTriggers`) but BEFORE `finalizeEmittedWelcome` ran the
    // flag/pending write. Without it a later plain same-mode turn — no `#` token,
    // so `classified.modeName` is unset — never welcomes. The webhook path is
    // unaffected (`deliverWelcomeOutOfBand` records/pends before orchestration and
    // sets `handledOutOfBand`, which the guard skips).
    const welcomeTracker: InBandWelcomeTracker = {
      due: undefined,
      handledOutOfBand: false,
      finalized: false,
    };
    const ctx = { timing, logger, startTime: Date.now() };
    try {
      return await this.runChatTurn(body, workerOrigin, ctx, welcomeTracker, callbacks);
    } finally {
      // #311 FIX B: arm the pending re-emit when an in-band welcome was DUE but
      // its flag/pending write never ran. No-ops on the success path
      // (`finalized`), for admins (no keys), for the webhook path
      // (`handledOutOfBand`), and when no welcome was due.
      await this.armInBandWelcomePendingOnThrow(
        welcomeTracker.due,
        welcomeTracker.handledOutOfBand,
        welcomeTracker.finalized,
        logger
      );
    }
  }

  /**
   * The per-turn chat pipeline proper. Split from `processChat` so the wrapper
   * can own the FIX B pending-on-throw finally without tipping the lint
   * complexity limits. Mutates `welcomeTracker` as the in-band welcome resolves,
   * delivers, and records, so the wrapper's finally can arm a pending re-emit
   * when this throws before that recording ran.
   */
  private async runChatTurn(
    body: ChatRequest,
    workerOrigin: string,
    ctx: { timing: TimingContext; logger: RequestLogger; startTime: number },
    welcomeTracker: InBandWelcomeTracker,
    callbacks?: StreamCallbacks
  ): Promise<ChatResponse> {
    const { logger } = ctx;
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

    // ── Deliver the welcome BEFORE building orchestrator options ──────────────
    // #311: the welcome is its OWN message ONLY on the webhook/WhatsApp path,
    // which has an `onWelcome` sink and renders each send discretely (FIX 1). On
    // the SSE path (`/chat/stream`) and TRUE `/chat/final` there is no
    // `onWelcome`; the welcome is prepended in-band into `responses` below,
    // because both SSE consumers replace the stream with `complete.responses`.
    //
    // Delivery runs FIRST so its outcome is known before `buildOrchOpts` reads
    // the preferences. `handledOutOfBand` decides the in-band prepend.
    const welcome = triggerCtx.welcome;
    // #311 FIX B: capture the due welcome for the wrapper's finally guard. Set
    // here — after `classifyAndResolveTriggers` has already persisted
    // `selected_mode` — so a later orchestration/save throw can still arm the
    // pending re-emit.
    welcomeTracker.due = welcome;
    // `emittingWelcome` — an authored welcome is DUE this turn (first-contact or
    // a pending re-emit). It drives model-welcome suppression regardless of
    // out-of-band delivery success (FIX 2).
    const emittingWelcome = !!welcome;
    const welcomeDelivery = await this.deliverWelcomeOutOfBand(welcome, callbacks, logger);
    // #311 FIX B: the webhook path already recorded/pended before orchestration.
    welcomeTracker.handledOutOfBand = welcomeDelivery.handledOutOfBand;

    // ── Build orchestrator options ────────────────────────────────────────────
    // FIX 2 (#311): suppress the model's "This is the user's first interaction.
    // Briefly welcome them." injection (system-prompt.ts) whenever an authored
    // welcome is DUE this turn — even if the out-of-band send THREW — so a
    // brand-new user is never welcomed twice. On a failed webhook delivery the
    // `mode_welcome_pending` re-emit is the SOLE fallback (it re-delivers the
    // authored copy + wa.me link next same-mode turn); the model never doubles
    // up. Per-turn ONLY — the durable `first_interaction:false` is written by
    // `recordWelcomeDelivered` (on actual delivery), and `saveConversation`
    // skips its flip on emitting turns so a failed delivery stays re-welcomable.
    const effectivePreferences = {
      ...loaded.preferences,
      response_language: loaded.locale,
      ...(emittingWelcome ? { first_interaction: false } : {}),
    };
    const audioContext = this.buildAudioContext();
    const attachmentsContext = createAttachmentsContext();
    // prettier-ignore
    const orchOpts = { ...this.buildOrchOpts(body, loaded.catalog, loaded.history, effectivePreferences, triggerCtx.resolved, loaded.memoryStore, loaded.formattedTOC, loaded.orgModes, triggerCtx.activeModeName, audioContext, attachmentsContext, workerOrigin, logger, callbacks, this.maybeBuildGroupContext(body), triggerCtx.languageDocument, triggerCtx.unmatchedTriggers, loaded.inboundVoiceKey, { triggerOnly: triggerCtx.triggerOnly }), turnId };

    const { orchResult, audioKey } = await this.orchestrateWithAudio(
      ctx,
      triggerCtx.messageText,
      orchOpts,
      {
        context: audioContext,
        body,
        emitStatus: loaded.emitStatus,
      }
    );

    // On SSE/final the welcome rides ahead of the model answer as its own
    // `responses` entry (that transport returns the whole array, so no delta
    // slicing garbles it). The webhook path already sent it out of band.
    const responses =
      welcome && !welcomeDelivery.handledOutOfBand
        ? [welcome.text, ...orchResult.responses]
        : orchResult.responses;

    // #311 FIX 5: persist history as MODEL text only. The welcome + wa.me link
    // must not become the assistant's prior turn, or the model may mimic it.
    // FIX 2: `emittingWelcome` defers the `first_interaction` flip to
    // `recordWelcomeDelivered` — the flip persists only when the authored
    // welcome actually delivered, so a failed delivery stays re-welcomable.
    // prettier-ignore
    await this.tracedPhase(ctx, 'save_conversation', () =>
      this.saveConversation(triggerCtx.messageText, orchResult.responses, loaded.preferences, body._org_config ?? {}, { logger, audioKey, inboundVoiceKey: loaded.inboundVoiceKey, speaker: body.speaker, attachments: attachmentsContext.list(), emittingWelcome })
    );

    // #311: on SSE/final the welcome ships inside `responses`; record it as
    // delivered only after the turn is saved, so a throw before here re-emits.
    // FIX 1: on the SSE path recording is DEFERRED to the caller (run after the
    // `complete` write, gated on the client still being connected) via
    // `deferInBandWelcomeRecord`; `/chat/final` (no such hook) records inline.
    // FIX 2: an emitted admin preview also persists `first_interaction:false`.
    await this.finalizeEmittedWelcome(welcome, welcomeDelivery.handledOutOfBand, callbacks);
    // #311 FIX B: in-band recording ran (or was deferred to the SSE caller) — the
    // wrapper's finally guard must NOT also arm pending. Set only after a clean
    // finalize.
    welcomeTracker.finalized = true;

    // prettier-ignore
    this.logChatTurn(body, effectivePreferences.response_language, logger, { turnId, activeModeName: triggerCtx.activeModeName, activeLanguageName: triggerCtx.activeLanguageName, languageSource: triggerCtx.languageSource, orchestration: orchResult.telemetry, durationMs: Date.now() - ctx.startTime, hadInboundVoice: !!loaded.inboundVoiceKey, hadOutboundVoice: audioKey !== null, inputLanguage, text: chatTurnText(triggerCtx.messageText, responses) });

    // prettier-ignore
    return this.assembleChatResponse({ responses, audioKey, workerOrigin, attachmentsContext, effectivePreferences, inputLanguage, logger, startTime: ctx.startTime });
  }

  /**
   * Run orchestration then (optionally) synthesize the voice reply, timing both
   * phases. Extracted from `runChatTurn` to keep it within the lint complexity
   * limits. Returns the orchestration result and the stored audio key (null when
   * no audio was produced).
   */
  private async orchestrateWithAudio(
    ctx: { timing: TimingContext; logger: RequestLogger; startTime: number },
    messageText: string,
    orchOpts: Parameters<UserDO['runOrchestration']>[1],
    audio: { context: AudioContext; body: ChatRequest; emitStatus: StatusEmitter | undefined }
  ): Promise<{ orchResult: OrchestrationResult; audioKey: string | null }> {
    const { logger } = ctx;
    const orchResult = await this.tracedPhase(ctx, 'orchestration', () =>
      this.runOrchestration(messageText, orchOpts)
    );
    const ttsResponses = this.extractTtsResponses(orchResult, logger);
    const voiceAudio = await this.tracedPhase(ctx, 'audio_generation', () =>
      this.maybeGenerateAudio(audio.body, audio.context, ttsResponses, logger, audio.emitStatus)
    );
    return { orchResult, audioKey: voiceAudio?.audioKey ?? null };
  }

  /**
   * #311 FIX B: arm the in-band pending re-emit from `processChat`'s finally.
   *
   * Fires ONLY when a welcome was DUE this turn, it was NOT delivered out of band
   * (webhook already records/pends before orchestration), it carries keys (admin
   * previews do not), and in-band recording never ran (`finalizeEmittedWelcome`
   * did not complete because orchestration or `saveConversation` threw after the
   * mode was persisted). Without this, a follow-up plain same-mode turn — which
   * carries no `#` token, so `classified.modeName` is unset — would never
   * welcome, silently swallowing the authored copy.
   *
   * Idempotent: re-`put`ting an already-set pending bit is harmless. Runs in a
   * `finally`, so a storage failure here must NOT mask the original turn error —
   * it is logged (never silently) and the original throw is left to propagate.
   */
  private async armInBandWelcomePendingOnThrow(
    welcome: ModeWelcome | undefined,
    handledOutOfBand: boolean,
    finalized: boolean,
    logger: RequestLogger
  ): Promise<void> {
    if (!welcome?.keys || handledOutOfBand || finalized) return;
    try {
      await this.state.storage.put(welcome.keys.pending, true);
      logger.warn('mode_welcome_pending_armed_on_throw', { pending_key: welcome.keys.pending });
    } catch (error) {
      // The turn already failed and that error is propagating from the try;
      // rethrowing here would mask it. Log at error (a storage write failed
      // during recovery) and let the original throw win.
      logger.error('mode_welcome_pending_arm_failed', error, { pending_key: welcome.keys.pending });
    }
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
    const welcome = await this.resolveTurnWelcome(body, loaded, classified, { newEffective: newEffectiveModeName, active: activeModeName }, logger); // prettier-ignore

    return {
      resolved,
      activeModeName,
      languageDocument: language.languageDocument,
      activeLanguageName: language.activeLanguageName,
      languageSource: language.languageSource,
      modePersistence,
      languagePersistence,
      welcome,
    };
  }

  /**
   * #311: deliver the welcome as its own message before the model runs, ONLY on
   * the webhook/WhatsApp transport, which renders each send discretely and is the
   * only path with `onWelcome` present (FIX 1). The SSE path and `/chat/final`
   * have no `onWelcome`, so this returns `handledOutOfBand: false` for them and
   * the caller prepends the welcome in-band into `responses`.
   *
   * FIX C: delivery is NON-FATAL. On success it records the one-time flag and
   * clears any pending bit; on failure it LOGS (structured, per the no-silent-
   * catch policy), sets the durable pending bit so a later turn re-emits, and
   * RETURNS WITHOUT RETHROWING so `processChat` still returns the model answer.
   * On success `handledOutOfBand: true` tells the caller NOT to also prepend the
   * welcome into `responses`; `delivered` distinguishes a resolved send (records
   * the flag) from a throw (pending set, re-emitted next same-mode turn). The
   * model welcome is suppressed on both outcomes because a welcome was DUE this
   * turn (`emittingWelcome`, FIX 2) — a failed send never doubles up.
   *
   * A residual failure this worker cannot observe — the gateway returns 200 but
   * Meta then rejects the send — is tracked in bt-servant-whatsapp-gateway#45.
   */
  private async deliverWelcomeOutOfBand(
    welcome: ModeWelcome | undefined,
    callbacks: StreamCallbacks | undefined,
    logger: RequestLogger
  ): Promise<WelcomeDelivery> {
    if (!welcome || !callbacks?.onWelcome) return { handledOutOfBand: false, delivered: false };
    try {
      await callbacks.onWelcome(welcome.text);
    } catch (error) {
      logger.warn('mode_welcome_delivery_failed', {
        error: error instanceof Error ? error.message : String(error),
        pending_key: welcome.keys?.pending ?? null,
        // Residual (gateway-200-then-Meta-failure) is invisible here — see
        // bt-servant-whatsapp-gateway#45.
      });
      if (welcome.keys) await this.state.storage.put(welcome.keys.pending, true);
      return { handledOutOfBand: true, delivered: false };
    }
    // The send landed — the user has seen the welcome, so this is handled
    // out-of-band regardless of what the flag write does next.
    await this.recordWelcomeDeliveredBestEffort(welcome, logger);
    return { handledOutOfBand: true, delivered: true };
  }

  /**
   * Record the one-time welcome flag after a SUCCESSFUL out-of-band send —
   * best-effort. If the storage write throws (hiccup/eviction) we log and
   * degrade rather than propagate: propagating would leave `handledOutOfBand`
   * unset in the caller and make processChat's finally arm `mode_welcome_pending`,
   * re-emitting a welcome the user already received. Worst case the flag stays
   * unset and an explicit re-scan re-welcomes once (double-send > pending skip).
   * Partial-write atomicity of `recordWelcomeDelivered` itself is tracked in #422.
   */
  private async recordWelcomeDeliveredBestEffort(
    welcome: ModeWelcome,
    logger: RequestLogger
  ): Promise<void> {
    try {
      await this.recordWelcomeDelivered(welcome);
    } catch (error) {
      logger.warn('mode_welcome_record_failed', {
        error: error instanceof Error ? error.message : String(error),
        welcomed_key: welcome.keys?.welcomed ?? null,
      });
    }
  }

  /**
   * #311: finalize the emitted welcome's durable state after the turn is saved.
   * Covers the in-band (SSE/`/chat/final`) one-time flag AND the admin-preview
   * `first_interaction:false` write (FIX 2). Out-of-band (webhook) delivery
   * already recorded its own flag, so the flag half no-ops there.
   *
   * FIX 1: on the SSE path the welcome only reaches the client inside the
   * `complete` event, which is written by the caller AFTER `processChat` returns
   * — and a mid-turn client disconnect makes that write a no-op. So when the
   * caller supplies `deferInBandWelcomeRecord`, DEFER flag recording to it: the
   * caller runs the handed recorder after the `complete` write with `delivered =
   * !clientDisconnected`. On `/chat/final` there is no stream to drop, so record
   * inline right here (as before). A throw before this point re-emits on retry.
   */
  private async finalizeEmittedWelcome(
    welcome: ModeWelcome | undefined,
    sentOutOfBand: boolean,
    callbacks: StreamCallbacks | undefined
  ): Promise<void> {
    if (!welcome) return;
    // FIX 2: an admin preview carries no keys, so the flag paths below no-op for
    // it — persist `first_interaction:false` here (and ONLY that) so a later
    // already-active `#<mode>` turn does not trigger the model's own welcome.
    await this.recordAdminWelcomeEmitted(welcome);
    if (sentOutOfBand) return;
    if (callbacks?.deferInBandWelcomeRecord) {
      // SSE: the caller runs this after the `complete` write (see the SSE
      // handlers), passing whether the client was still connected.
      callbacks.deferInBandWelcomeRecord((delivered) =>
        this.recordInBandWelcomeOutcome(welcome, delivered)
      );
      return;
    }
    // `/chat/final`: no stream to disconnect — the welcome is in the JSON body.
    await this.recordWelcomeDelivered(welcome);
  }

  /**
   * #311 FIX 1: apply the deferred SSE welcome outcome. `delivered` (the client
   * was still connected when `complete` was written) records the one-time flag;
   * a disconnect leaves a `mode_welcome_pending` bit instead so a later
   * same-mode turn re-emits the welcome the user never saw. Admin previews carry
   * no keys, so both branches no-op for them (re-preview stays intact).
   */
  private async recordInBandWelcomeOutcome(
    welcome: ModeWelcome,
    delivered: boolean
  ): Promise<void> {
    if (delivered) {
      await this.recordWelcomeDelivered(welcome);
    } else if (welcome.keys) {
      await this.state.storage.put(welcome.keys.pending, true);
    }
  }

  /**
   * #311 FIX 2: an admin welcome carries NO keys (admins re-preview freely and
   * are never `mode_welcomed`), so `recordWelcomeDelivered` no-ops and the
   * end-of-turn `first_interaction` flip is skipped on an emitting turn —
   * leaving `first_interaction:true`. The preview DID go out, so persist
   * `first_interaction:false` durably here (and ONLY that — no `mode_welcomed`,
   * no pending). Without it the next already-active `#<mode>` turn (the portal
   * prefixes `#<mode>` every turn, and the authored copy is correctly withheld)
   * would trigger the model's own "This is the user's first interaction. Briefly
   * welcome them." injection. No-op for non-admin welcomes (they carry keys).
   */
  private async recordAdminWelcomeEmitted(welcome: ModeWelcome | undefined): Promise<void> {
    if (!welcome || welcome.keys) return;
    const preferences = await this.getPreferences();
    if (preferences.first_interaction) {
      await this.updatePreferences({ ...preferences, first_interaction: false });
    }
  }

  /**
   * #311 FIX 1: run the deferred SSE welcome recorder after the `complete` event
   * was written. `delivered = !clientDisconnected` — the client received the
   * welcome only if it was still connected. A storage failure here is NON-FATAL:
   * the turn already completed and `complete` already shipped, so log it (never
   * silently) and continue — worst case the one-time flag is not recorded and the
   * user is re-welcomed on a later same-mode turn, which the logs make visible.
   */
  private async finalizeSseWelcomeRecord(
    record: ((delivered: boolean) => Promise<void>) | undefined,
    state: { clientDisconnected: boolean },
    logger: RequestLogger
  ): Promise<void> {
    if (!record) return;
    try {
      await record(!state.clientDisconnected);
    } catch (error) {
      logger.warn('mode_welcome_record_failed', {
        client_disconnected: state.clientDisconnected,
        error: error instanceof Error ? error.message : String(error),
      });
      // Explicitly continue — recording the one-time flag is a post-turn side
      // effect; failing it must not tear down an already-completed SSE turn.
    }
  }

  /**
   * #311: mark a welcome as successfully delivered — set the one-time
   * `mode_welcomed` flag and clear any `mode_welcome_pending` bit. No-op for
   * admin re-previews (FIX B), which carry no keys.
   *
   * FIX 2: also persist `first_interaction:false` durably here — the authored
   * welcome ACTUALLY went out (webhook success, or in-band SSE/`/chat/final`), so
   * a later turn whose orchestration throws before `saveConversation` can never
   * re-welcome the user via the model. This is NOT reached on a failed delivery
   * (pending re-emit, or a later model welcome, handles that case instead).
   */
  private async recordWelcomeDelivered(welcome: ModeWelcome): Promise<void> {
    if (!welcome.keys) return;
    await this.state.storage.put(welcome.keys.welcomed, true);
    await this.state.storage.delete(welcome.keys.pending);
    const preferences = await this.getPreferences();
    if (preferences.first_interaction) {
      await this.updatePreferences({ ...preferences, first_interaction: false });
    }
  }

  /**
   * Decide this turn's first-contact welcome (#311). Fires whenever an explicit
   * `#mode` trigger resolves to a visible canonical mode and the one-time flag
   * is unset — even when that mode is already active (existing user rescanning
   * its QR, or switch_mode-then-QR). NOT on clear-intent (`#default`/`#none`/
   * `#clear`) and NOT on persisted-fallback re-entry (no `#` token ⇒
   * classified.modeName unset). Reuses the canonical slug from the mode-change
   * branch when set; otherwise resolves it (already-active re-trigger).
   */
  private async resolveTurnWelcome(
    body: ChatRequest,
    loaded: Awaited<ReturnType<UserDO['loadChatContext']>>,
    classified: ClassifierResult,
    modes: { newEffective: string | undefined; active: string | undefined },
    logger: RequestLogger
  ): Promise<ModeWelcome | undefined> {
    // Explicit `#mode` path: first-time emit (or admin re-preview, FIX B, or an
    // already-active re-trigger) still REQUIRES a `#` token this turn.
    const triggeredMode =
      classified.clearMode || !classified.modeName
        ? undefined
        : (modes.newEffective ?? this.resolveTriggeredMode(body, loaded, classified.modeName));
    if (triggeredMode) {
      // FIX 3: `newEffective` is set ONLY on a mode CHANGE this turn (see
      // applyTriggerOverrides). Pass that through so the admin always-emit is
      // restricted to a (re-)entry, not every already-active `#<same-mode>`.
      const isModeChange = !!modes.newEffective;
      const explicit = await this.maybeBuildModeWelcome(
        body,
        loaded,
        triggeredMode,
        isModeChange,
        logger
      );
      if (explicit) return explicit;
    }
    // FIX C: pending re-emit path — a PRIOR delivery for this turn's active mode
    // failed and left a `mode_welcome_pending` bit. Re-emit WITHOUT an explicit
    // `#` trigger. Runs only when the explicit path produced nothing, so exactly
    // ONE welcome is emitted per turn.
    return this.maybePendingWelcome(body, loaded, modes.active, logger);
  }

  /**
   * Build the one-time first-contact welcome for `effectiveModeName` (#311), or
   * `undefined` when none is due (mode has no authored copy, or the one-time
   * flag is already set). Opt-in by authoring: a mode with no `welcome_message`
   * emits nothing.
   *
   * Does NOT write the flag — it returns the flag key so the caller can write
   * it only AFTER the welcome is actually delivered, leaving a failed delivery
   * to re-emit on retry. `effectiveModeName` is the canonical slug, so the flag
   * and the `wa.me` trigger key off the canonical name even for an alias scan.
   */
  private async maybeBuildModeWelcome(
    body: ChatRequest,
    loaded: Awaited<ReturnType<UserDO['loadChatContext']>>,
    effectiveModeName: string,
    isModeChange: boolean,
    logger: RequestLogger
  ): Promise<ModeWelcome | undefined> {
    const mode = loaded.orgModes.modes.find((m) => m.name === effectiveModeName);
    const welcomeCopy = mode?.welcome_message?.trim();
    if (!mode || !welcomeCopy) return undefined;

    const text = buildModeWelcomeText(welcomeCopy, effectiveModeName, this.env.WHATSAPP_NUMBER);

    // FIX B (#311): admins re-preview freely — on an explicit `#mode` an admin
    // gets the welcome with NO flag read/write, so an author iterating on
    // `welcome_message` sees every save. FIX 3: restrict that always-emit to a
    // mode CHANGE (a (re-)entry — the real re-preview flow: edit copy, switch
    // away, switch back). The portal prefixes `#<mode>` on EVERY test-chat turn,
    // so without this an already-active `#<same-mode>` would glue the welcome
    // onto every admin reply. On an already-active `#` (no change) the admin
    // falls through here and through `maybePendingWelcome` (admin-guarded) to no
    // welcome — never the per-turn spam.
    if (loaded.isAdmin) {
      if (!isModeChange) return undefined;
      this.logModeWelcomePrepared(logger, effectiveModeName, text, { reason: 'admin_preview' });
      return { text };
    }

    // FIX 3 (#311): alias-aware — a user welcomed under ANY of the mode's CURRENT
    // slugs (canonical `name` + `aliases`) is already welcomed, so a rename/reslug
    // (#284) that turns the old slug into an alias never re-welcomes them. Flags
    // live per user DO and cannot be migrated from org KV, so this is a
    // copy-on-read check: the delivered flag is still WRITTEN on the CANONICAL key
    // via `modeWelcomeKeys(effectiveModeName)` below.
    if (await this.isAnyCurrentSlugWelcomed(body, mode)) return undefined;

    this.logModeWelcomePrepared(logger, effectiveModeName, text, { reason: 'first_contact' });
    return { text, keys: this.modeWelcomeKeys(body, effectiveModeName) };
  }

  /**
   * FIX C (#311): pending RE-EMIT. When a prior delivery for the turn's active
   * mode failed, a `mode_welcome_pending:<key>` bit was set. Re-emit that mode's
   * welcome on ANY subsequent turn in that mode — even without a `#` trigger —
   * as long as it is not yet `mode_welcomed`. Non-admins only (admins never
   * write pending). Returns `undefined` when nothing is pending.
   */
  // TODO(review, #422): this runs on every plain (non-#) turn with an active mode
  // and does 1 + |aliases| durable storage.get calls to detect the rare failed-
  // delivery re-emit — an N+1 read on the chat hot path. Gate it behind a cheap
  // signal (e.g. a single cached "has any pending" marker) so steady-state turns
  // skip the per-alias reads. Tracked with the other welcome hardening in #422.
  private async maybePendingWelcome(
    body: ChatRequest,
    loaded: Awaited<ReturnType<UserDO['loadChatContext']>>,
    activeModeName: string | undefined,
    logger: RequestLogger
  ): Promise<ModeWelcome | undefined> {
    if (!activeModeName || loaded.isAdmin) return undefined;

    const keys = this.modeWelcomeKeys(body, activeModeName);
    const mode = loaded.orgModes.modes.find((m) => m.name === activeModeName);

    // FIX C (#311): alias-aware pending lookup — mirror `isAnyCurrentSlugWelcomed`.
    // After a reslug (#284) the old slug becomes an alias, so a pending bit set
    // under the FORMER slug is stranded off the current canonical key. Resolve it
    // across the mode's current slugs and copy it onto the canonical key on read
    // (deleting the alias key), so the re-emit fires and future reads are keyed
    // canonically. When the mode is gone we can only check the canonical key.
    const pending = mode
      ? await this.resolveAnyCurrentSlugPending(body, mode, keys.pending)
      : (await this.state.storage.get<boolean>(keys.pending)) === true;
    if (!pending) return undefined;

    const welcomeCopy = mode?.welcome_message?.trim();
    // FIX 4 (#311): the authored copy was removed (empty/absent, or the mode is
    // gone) AFTER a failed delivery left this pending bit. Clear the stale bit(s)
    // across the mode's current slugs so re-authoring the copy later does not
    // surprise-welcome the user on a plain same-mode turn.
    if (!mode || !welcomeCopy) {
      await this.clearPendingAcrossCurrentSlugs(body, mode, keys.pending);
      logger.log('mode_welcome_pending_cleared', { mode: activeModeName, reason: 'copy_removed' });
      return undefined;
    }

    // FIX 3/C (#311): alias-aware welcomed check (see `maybeBuildModeWelcome`) — a
    // rename must not re-emit for a user already welcomed under a former slug.
    // When it fires, ALSO clear any stale pending bit across the mode's current
    // slugs so a stranded pending never lingers after the user is welcomed.
    if (await this.isAnyCurrentSlugWelcomed(body, mode)) {
      await this.clearPendingAcrossCurrentSlugs(body, mode, keys.pending);
      return undefined;
    }

    const text = buildModeWelcomeText(welcomeCopy, activeModeName, this.env.WHATSAPP_NUMBER);
    this.logModeWelcomePrepared(logger, activeModeName, text, { reason: 'pending_reemit' });
    return { text, keys };
  }

  /**
   * FIX C (#311): true when a `mode_welcome_pending` bit exists under ANY of this
   * mode's CURRENT slugs — canonical `name` first, then any `aliases` (former
   * slugs after a reslug, #284). Mirrors `isAnyCurrentSlugWelcomed`: when the bit
   * is found only under an alias it is COPIED onto the canonical pending key and
   * the alias key is DELETED (copy-on-read), so the re-emit keys canonically and
   * the stranded alias bit does not linger. `canonicalPendingKey` is the caller's
   * already-computed canonical key (equals `modeWelcomePendingKey(body, mode.name)`).
   */
  private async resolveAnyCurrentSlugPending(
    body: ChatRequest,
    mode: PromptMode,
    canonicalPendingKey: string
  ): Promise<boolean> {
    if ((await this.state.storage.get<boolean>(canonicalPendingKey)) === true) return true;
    for (const alias of mode.aliases ?? []) {
      const aliasKey = this.modeWelcomePendingKey(body, alias);
      if ((await this.state.storage.get<boolean>(aliasKey)) === true) {
        // Copy-on-read: migrate the former-slug pending bit onto the canonical
        // key so the re-emit and all future reads key off the current name.
        await this.state.storage.put(canonicalPendingKey, true);
        await this.state.storage.delete(aliasKey);
        return true;
      }
    }
    return false;
  }

  /**
   * FIX C (#311): delete the `mode_welcome_pending` bit under ALL of the mode's
   * current slugs — the canonical key plus every alias. Used when the welcomed
   * short-circuit fires or the authored copy was removed, so a stale pending bit
   * never lingers under the canonical key or a former slug. `mode` may be
   * undefined (mode deleted), in which case only the canonical key is cleared.
   */
  private async clearPendingAcrossCurrentSlugs(
    body: ChatRequest,
    mode: PromptMode | undefined,
    canonicalPendingKey: string
  ): Promise<void> {
    await this.state.storage.delete(canonicalPendingKey);
    for (const alias of mode?.aliases ?? []) {
      await this.state.storage.delete(this.modeWelcomePendingKey(body, alias));
    }
  }

  /** Structured `mode_welcome_prepared` log shared by the emit paths (#311). */
  private logModeWelcomePrepared(
    logger: RequestLogger,
    mode: string,
    text: string,
    extra: { reason: 'first_contact' | 'admin_preview' | 'pending_reemit' }
  ): void {
    logger.log('mode_welcome_prepared', {
      mode,
      reason: extra.reason,
      // A missing/typo'd WHATSAPP_NUMBER silently drops the forwarding link;
      // surface it in logs rather than swallowing it.
      whatsapp_number_configured: !!this.env.WHATSAPP_NUMBER,
      has_share_link: text.includes(WA_ME_ORIGIN),
      welcome_length: text.length,
    });
  }

  /**
   * Storage key for the one-time welcome flag. Group-chat DOs are shared across
   * members (`group:{org}:{chat_id}`), so a bare `mode_welcomed:<slug>` would
   * let one member's scan suppress everyone else's — key per sender there. 1:1
   * DOs are already per-user, so they keep the slug-only key.
   */
  private modeWelcomedKey(body: ChatRequest, slug: string): string {
    return this.isGroupChatType(body)
      ? `${MODE_WELCOMED_PREFIX}${body.user_id}:${slug}`
      : `${MODE_WELCOMED_PREFIX}${slug}`;
  }

  /**
   * Storage key for the pending-welcome bit (#311, FIX C). Same per-user/group
   * keying as `modeWelcomedKey` so member A's failed delivery only queues a
   * re-emit for member A, never member B in a shared group DO.
   */
  private modeWelcomePendingKey(body: ChatRequest, slug: string): string {
    return this.isGroupChatType(body)
      ? `${MODE_WELCOME_PENDING_PREFIX}${body.user_id}:${slug}`
      : `${MODE_WELCOME_PENDING_PREFIX}${slug}`;
  }

  /**
   * FIX 3 (#311): true when the user carries a `mode_welcomed` flag under ANY of
   * this mode's CURRENT slugs — its canonical `name` or any `aliases` (#284). A
   * reslug turns the former canonical slug into an alias, so a user welcomed
   * under the old name must not be re-welcomed under the new one. Flags live in
   * each user DO and cannot be migrated from org KV, so when the flag is found
   * only under an alias we COPY it onto the current canonical key (copy-on-read),
   * leaving future lookups keyed canonically. In group DOs the alias set applies
   * to the `<slug>` portion of the per-sender key (`modeWelcomedKey`).
   */
  private async isAnyCurrentSlugWelcomed(body: ChatRequest, mode: PromptMode): Promise<boolean> {
    const canonicalKey = this.modeWelcomedKey(body, mode.name);
    if ((await this.state.storage.get<boolean>(canonicalKey)) === true) return true;
    for (const alias of mode.aliases ?? []) {
      if ((await this.state.storage.get<boolean>(this.modeWelcomedKey(body, alias))) === true) {
        // Copy-on-read: migrate the former-slug flag onto the canonical key so
        // the user reads as welcomed under the new name from here on.
        await this.state.storage.put(canonicalKey, true);
        return true;
      }
    }
    return false;
  }

  /** The paired `mode_welcomed` / `mode_welcome_pending` keys for a mode (#311). */
  private modeWelcomeKeys(body: ChatRequest, slug: string): { welcomed: string; pending: string } {
    return {
      welcomed: this.modeWelcomedKey(body, slug),
      pending: this.modeWelcomePendingKey(body, slug),
    };
  }

  /**
   * Canonical slug an explicit `#mode` trigger resolves to, or `undefined` when
   * it is not visible to this caller/context (unpublished, or `requires_group`
   * for a non-admin outside a group). Used by the welcome gate to key off the
   * canonical name even when the mode is already active this turn.
   */
  private resolveTriggeredMode(
    body: ChatRequest,
    loaded: Awaited<ReturnType<UserDO['loadChatContext']>>,
    modeName: string
  ): string | undefined {
    return resolveEffectiveMode(loaded.orgModes, modeName, {
      includeUnpublished: loaded.isAdmin,
      isGroupChat: this.isGroupChatType(body),
    }).effectiveModeName;
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
      emittingWelcome?: boolean;
    }
  ) {
    const { logger, audioKey, inboundVoiceKey, speaker, attachments, emittingWelcome } = opts;
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
    await this.maybeFlipFirstInteraction(preferences, emittingWelcome);
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
    const voiceFormat: VoiceFormat = body.voice_format ?? 'opus';
    logger.log('audio_flow_tts_decision', {
      message_type: body.message_type,
      audio_requested_by_tool: audioContext.audioRequested,
      should_generate: shouldGenerate,
      voice_format: voiceFormat,
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
    const audio = await this.generateVoiceResponse(
      { org, userId, responses, format: voiceFormat },
      logger,
      emit
    );
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

  /** Synthesize the combined text in the requested format and upload it to R2. */
  private async synthesizeAndUploadVoice(
    voice: { org: string; userId: string; format: VoiceFormat },
    combinedText: string,
    logger: RequestLogger
  ): Promise<{ audioKey: string; synthesis: SpeechSynthesisResult; r2UploadMs: number }> {
    const synthesis = await synthesizeSpeech(
      this.env.OPENAI_API_KEY,
      combinedText,
      logger,
      voice.format
    );
    const synthesisDoneAt = Date.now();
    const audioKey = generateAudioKey(voice.org, voice.userId, voice.format);
    await uploadAudio(
      this.env.AUDIO_BUCKET,
      audioKey,
      synthesis.audio_bytes,
      voiceFormatSpec(voice.format).contentType,
      logger
    );
    return { audioKey, synthesis, r2UploadMs: Date.now() - synthesisDoneAt };
  }

  private async generateVoiceResponse(
    voice: { org: string; userId: string; responses: string[]; format: VoiceFormat },
    logger: RequestLogger,
    emit?: StatusEmitter
  ): Promise<{ audioKey: string } | null> {
    const genStart = Date.now();
    const combinedText = voice.responses.join('\n\n');
    logger.log('audio_flow_generate_voice_start', {
      response_count: voice.responses.length,
      combined_text_chars: combinedText.length,
      voice_format: voice.format,
      has_callbacks: !!emit,
    });

    const keepalive = emit ? this.startTtsKeepalive(emit, genStart, logger) : null;
    try {
      await emit?.('status_tts_generating');
      const { audioKey, synthesis, r2UploadMs } = await this.synthesizeAndUploadVoice(
        voice,
        combinedText,
        logger
      );

      logger.log('audio_flow_generate_voice_complete', {
        input_chars: synthesis.input_chars,
        synthesis_ms: synthesis.duration_ms,
        r2_upload_ms: r2UploadMs,
        generate_voice_total_ms: Date.now() - genStart,
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

  /**
   * #311 FIX 2: the normal end-of-turn `first_interaction` flip. Skipped on a
   * welcome-emitting turn — there `recordWelcomeDelivered` owns the durable
   * `first_interaction:false` and writes it ONLY when the authored welcome
   * actually delivered, so a failed-then-pending welcome stays re-welcomable.
   */
  private async maybeFlipFirstInteraction(
    preferences: UserPreferencesInternal,
    emittingWelcome: boolean | undefined
  ): Promise<void> {
    if (emittingWelcome || !preferences.first_interaction) return;
    await this.updatePreferences({ ...preferences, first_interaction: false });
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
