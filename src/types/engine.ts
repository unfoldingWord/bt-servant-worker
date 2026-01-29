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
  responses: string[];
  response_language: string;
  voice_audio_base64: string | null;
  // Backward compatibility fields (deprecated - will be removed when consumers updated)
  intent_processed: string;
  has_queued_intents: boolean;
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
  agentic_strength: 'normal' | 'low' | 'very_low';
  dev_agentic_mcp: boolean;
}

/**
 * API-facing user preferences (matches consumer expectations)
 */
export interface UserPreferencesAPI {
  response_language?: string | null;
  agentic_strength?: 'normal' | 'low' | 'very_low' | null;
  dev_agentic_mcp?: boolean | null;
}

/**
 * Request to update user preferences
 */
export interface UpdatePreferencesRequest {
  response_language?: string;
  agentic_strength?: 'normal' | 'low' | 'very_low';
  dev_agentic_mcp?: boolean;
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
