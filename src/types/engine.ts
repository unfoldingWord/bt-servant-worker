/**
 * API contract types matching bt-servant-web-client and bt-servant-whatsapp-gateway
 */

import { OrgLanguages } from './languages.js';
import { MCPServerConfig } from './mcp.js';
import { OrgConfig } from './org-config.js';
import { OrgModes, PromptOverrides } from './prompt-overrides.js';

/**
 * Progress mode for webhook callbacks.
 * - 'complete': Legacy behavior - only send on completion
 * - 'iteration': Send after each orchestration iteration (default)
 * - 'periodic': Send accumulated text every N seconds
 * - 'sentence': Send after each complete sentence
 */
export type ProgressMode = 'complete' | 'iteration' | 'periodic' | 'sentence';

/** Chat type for routing. Defaults to 'private' when absent (backward compat). */
export type ChatType = 'private' | 'group' | 'supergroup';

/**
 * Chat transport selected by the worker route.
 *
 * - 'final'    → POST /api/v1/chat. Synchronous final-only JSON response.
 *                Rejects progress_callback_url, progress_mode,
 *                progress_throttle_seconds, and message_key with a 400.
 * - 'stream'   → POST /api/v1/chat/stream. Always SSE.
 * - 'callback' → POST /api/v1/chat/callback. Always webhook callback; requires
 *                body.progress_callback_url and body.message_key.
 */
export type ChatTransport = 'final' | 'stream' | 'callback';

export interface ChatRequest {
  client_id: string;
  user_id: string;
  message?: string;
  message_type: 'text' | 'audio';
  audio_base64?: string;
  audio_format?: string;
  progress_callback_url?: string;
  progress_throttle_seconds?: number;
  progress_mode?: ProgressMode;
  message_key?: string; // WhatsApp message identifier for correlation
  org?: string; // Organization for MCP server selection (defaults to DEFAULT_ORG)
  org_id?: string; // Alias for org (backward compat with whatsapp gateway)

  /** Chat type. Defaults to 'private' when absent (backward compat). */
  chat_type?: ChatType;

  /** Group/supergroup chat ID. Required when chat_type is 'group' or 'supergroup'. */
  chat_id?: string;

  /** Display name of the person who sent the message (for group context). */
  speaker?: string;

  /** Telegram topic/thread ID within a supergroup. */
  thread_id?: string;

  /**
   * Whether the inbound message was directly addressed to the bot.
   *
   * Set by the gateway (e.g. Telegram gateway sets `true` when the message
   * mentions `@bt_servant` or is a reply to a bot message, `false` for
   * ambient group chatter not directed at the bot). Defaults to `true` when
   * absent — i.e. existing clients are unchanged.
   *
   * The orchestrator surfaces this to Claude via a small `## Addressed
   * Status` section in the system prompt when `false`; modes whose
   * `client_instructions` choose to stay silent for non-addressed turns
   * can do so. Modes that don't reference it are unaffected.
   */
  addressed_to_bot?: boolean;

  /** Gateway-provided language hint. Overrides stored preference for this request. */
  response_language_hint?: string;

  /** Internal: MCP servers injected by worker (not from client) */
  _mcp_servers?: MCPServerConfig[];

  /** Internal: Org config injected by worker (not from client) */
  _org_config?: OrgConfig;

  /** Internal: Org-level prompt overrides injected by worker from KV (not from client) */
  _org_prompt_overrides?: PromptOverrides;

  /** Internal: Org modes injected by worker from KV (not from client) */
  _org_modes?: OrgModes;

  /** Internal: Org languages injected by worker from KV (not from client) */
  _org_languages?: OrgLanguages;
}

/**
 * A binary artifact produced by a tool and surfaced to the consumer alongside
 * the text response. Currently only PDFs (from the ptxprint integration); the
 * type is open-ended so other artifact kinds can be added without a breaking
 * change to consumers.
 */
export interface PdfAttachment {
  type: 'pdf';
  url: string;
  filename: string;
  size_bytes?: number;
  mime_type: 'application/pdf';
}

/**
 * A stored audio object (e.g. an archived voice submission) attached to the
 * response. Distinct from `ChatResponse.voice_audio_url`, which carries
 * freshly-synthesized TTS audio of the assistant's text response. An
 * `AudioAttachment` lets Claude surface a previously-recorded audio object —
 * for example, replaying a participant's original story recording — alongside
 * (or instead of) TTS narration.
 */
export interface AudioAttachment {
  type: 'audio';
  url: string;
  r2_key: string;
  mime_type: 'audio/ogg';
}

export type Attachment = PdfAttachment | AudioAttachment;

export interface ChatResponse {
  /**
   * Array of response text segments from the assistant.
   *
   * Why an array instead of a single string?
   * - Claude may produce multiple text blocks interleaved with tool calls
   * - Each text block from Claude becomes a separate array element
   * - This preserves the structure of multi-turn tool-assisted responses
   *
   * Common patterns:
   * - Simple responses: Single element with the complete response
   * - Tool-assisted responses: Multiple elements (e.g., "Let me check that...", then result)
   *
   * For display, consumers should typically:
   * - Join with '\n' for plain text: responses.join('\n')
   * - Display sequentially for chat UI
   * - Use the last element if only the final answer matters
   */
  responses: string[];

  /** Language code for the response (e.g., 'en', 'es', 'fr') */
  response_language: string;

  /** @deprecated Use voice_audio_url instead. Always null when R2 is enabled. */
  voice_audio_base64: string | null;

  /** URL to fetch the audio from R2, or null if no audio was generated */
  voice_audio_url?: string | null;

  /**
   * Tool-produced artifacts (e.g., generated PDFs). Empty / omitted when no
   * artifact-producing tool ran. Consumers that don't understand the type
   * should ignore the field — never present a raw URL string in chat.
   */
  attachments?: Attachment[];
}

/**
 * Chat history entry stored in Durable Object
 */
export interface ChatHistoryEntry {
  user_message: string;
  assistant_response: string;
  timestamp: number;
  created_at?: string | null;
  /**
   * R2 object key for the TTS-synthesized audio of `assistant_response`
   * (assistant → user). Stored under the `audio/{org}/{user_id}/{uuid}.opus`
   * prefix. Present only when TTS ran for this turn.
   */
  voice_audio_key?: string | null;
  /**
   * R2 object key for the inbound voice submission that produced
   * `user_message` via transcription (user → assistant). Stored under the
   * `voice-submissions/{org}/{chatId|user_id}/{speaker|user_id}/{uuid}.ogg`
   * prefix. Present only when the inbound message was a voice message.
   *
   * Independent of `voice_audio_key` — a single turn may carry both keys
   * (voice in, TTS out) or either alone.
   */
  inbound_voice_audio_key?: string | null;
  /** Display name of the speaker (group chats only). */
  speaker?: string;
  /**
   * Tool-produced artifacts persisted alongside the assistant response.
   * Stored as the same shape exposed on ChatResponse.attachments so /history
   * can replay artifacts without reconstruction. Origin lives inside the URL
   * — these are content-addressed and bound to our R2 bucket.
   */
  attachments?: Attachment[];
}

/** History entry as returned by the API (includes computed fields). */
export interface ChatHistoryResponseEntry extends ChatHistoryEntry {
  /** URL to fetch the TTS-output audio from R2, or null if no audio was generated */
  voice_audio_url?: string | null;
  /** URL to fetch the inbound voice submission from R2, or null if the inbound message was text */
  inbound_voice_audio_url?: string | null;
}

/**
 * Chat history response for API
 */
export interface ChatHistoryResponse {
  user_id: string;
  entries: ChatHistoryResponseEntry[];
  total_count: number;
  limit: number;
  offset: number;
}

/**
 * Internal user preferences stored in Durable Object
 */
export interface UserPreferencesInternal {
  response_language: string;
  first_interaction: boolean;
}

/**
 * API-facing user preferences (matches consumer expectations)
 */
export interface UserPreferencesAPI {
  response_language?: string | null;
}

/**
 * Request to update user preferences
 */
export interface UpdatePreferencesRequest {
  response_language?: string;
}

/**
 * SSE event types for streaming endpoint
 */
export type SSEEventType =
  | 'status'
  | 'progress'
  | 'complete'
  | 'error'
  | 'tool_use'
  | 'tool_result';

export interface SSEStatusEvent {
  type: 'status';
  message: string;
}

export interface SSEProgressEvent {
  type: 'progress';
  text: string;
}

export interface SSECompleteEvent {
  type: 'complete';
  response: ChatResponse;
}

export interface SSEErrorEvent {
  type: 'error';
  error: string;
}

export interface SSEToolUseEvent {
  type: 'tool_use';
  tool: string;
  input: unknown;
}

export interface SSEToolResultEvent {
  type: 'tool_result';
  tool: string;
  result: unknown;
}

export type SSEEvent =
  | SSEStatusEvent
  | SSEProgressEvent
  | SSECompleteEvent
  | SSEErrorEvent
  | SSEToolUseEvent
  | SSEToolResultEvent;

/**
 * Stream callbacks interface for orchestrator
 */
export interface StreamCallbacks {
  onStatus: (message: string) => void;
  onProgress: (text: string) => void;
  onComplete: (response: ChatResponse) => void;
  onError: (error: string) => void;
  onToolUse?: (toolName: string, input: unknown) => void;
  onToolResult?: (toolName: string, result: unknown) => void;
  onIterationComplete?: (text: string) => void;
}

/**
 * Progress callback payload (sent to progress_callback_url).
 *
 * Public contract for callback consumers (whatsapp gateway, future
 * integrations). Must stay in sync with the actual payload assembled in
 * `src/services/progress/callback.ts` (`CallbackPayload`). When you change
 * one, change the other.
 */
export type ProgressCallbackType = 'status' | 'progress' | 'complete' | 'error';

export interface ProgressCallback {
  type: ProgressCallbackType;
  user_id: string;
  message_key: string;
  /** ISO-8601 timestamp string (e.g. "2026-04-30T14:00:00.000Z"). */
  timestamp: string;
  /** Status updates (e.g. "Working on it…") — present on `type: "status"`. */
  message?: string;
  /** Accumulated/delta text — present on `progress` and `complete` events. */
  text?: string;
  /** Error description — present on `type: "error"`. */
  error?: string;
  /** Voice audio (base64-encoded) — present on `complete` when TTS is on. */
  voice_audio_base64?: string | null;
  /** Voice audio (URL form, preferred for large payloads) — present on `complete` when TTS is on. */
  voice_audio_url?: string | null;
  /** Tool-produced artifacts (e.g. generated PDFs) — present on `complete` when tools registered them. */
  attachments?: Attachment[];
  /** Group/supergroup chat ID (present only for group chats). */
  chat_id?: string;
  /** Thread ID within a supergroup (present only for threaded chats). */
  thread_id?: string;
}

/**
 * Standard error response format used across all error responses
 */
export interface ApiError {
  error: string;
  code: string;
  message: string;
}

/**
 * Error response when a concurrent request is rejected (429)
 */
export interface ConcurrentRequestError extends ApiError {
  code: 'CONCURRENT_REQUEST_REJECTED';
  retry_after_ms: number;
}

/**
 * Validation error response (400)
 */
export interface ValidationErrorResponse extends ApiError {
  code: 'VALIDATION_ERROR';
}

/**
 * Internal error response (500)
 */
export interface InternalErrorResponse extends ApiError {
  code: 'INTERNAL_ERROR';
}
