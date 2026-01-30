/**
 * API contract types matching bt-servant-web-client and bt-servant-whatsapp-gateway
 */

export interface ChatRequest {
  client_id: string;
  user_id: string;
  message: string;
  message_type: 'text' | 'audio';
  audio_base64?: string;
  audio_format?: string;
  progress_callback_url?: string;
  progress_throttle_seconds?: number;
  message_key?: string; // WhatsApp message identifier for correlation
}

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

  /** Base64-encoded audio response, or null if no audio was generated */
  voice_audio_base64: string | null;
}

/**
 * Chat history entry stored in Durable Object
 */
export interface ChatHistoryEntry {
  user_message: string;
  assistant_response: string;
  timestamp: number;
  created_at?: string | null;
}

/**
 * Chat history response for API
 */
export interface ChatHistoryResponse {
  user_id: string;
  entries: ChatHistoryEntry[];
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
}

/**
 * Progress callback payload (sent to progress_callback_url)
 */
export interface ProgressCallback {
  user_id: string;
  message_key: string;
  text: string;
  timestamp: number;
}
