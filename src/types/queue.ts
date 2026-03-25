/**
 * Types for the UserQueue Durable Object
 *
 * The UserQueue sits between the worker router and UserSession,
 * serializing requests per-user via an alarm-based processing loop.
 */

import { ProgressMode } from './engine.js';
import { MCPServerConfig } from './mcp.js';
import { OrgConfig } from './org-config.js';
import { OrgModes, PromptOverrides } from './prompt-overrides.js';

/**
 * Entry in the queue awaiting processing.
 * Contains everything needed to forward the request to UserSession.
 */
export interface QueueEntry {
  message_id: string;
  user_id: string;
  client_id: string;
  message: string | undefined;
  message_type: 'text' | 'audio';
  audio_base64?: string | undefined;
  audio_format?: string | undefined;
  progress_callback_url?: string | undefined;
  progress_throttle_seconds?: number | undefined;
  progress_mode?: ProgressMode | undefined;
  message_key?: string | undefined;
  org: string;
  enqueued_at: number;
  /** Delivery mode: 'callback' for webhook, 'sse' for streaming */
  delivery: 'callback' | 'sse';
  /** Number of times this entry has been retried after transient failures */
  retry_count: number;
  /** Injected MCP servers from KV */
  _mcp_servers?: MCPServerConfig[] | undefined;
  /** Injected org config from KV */
  _org_config?: OrgConfig | undefined;
  /** Injected org-level prompt overrides from KV */
  _org_prompt_overrides?: PromptOverrides | undefined;
  /** Injected org modes from KV */
  _org_modes?: OrgModes | undefined;
  /** Worker-level request ID for cross-DO correlation */
  request_id?: string | undefined;
}

/**
 * Stored response for late-connecting SSE clients.
 * When a queue entry finishes processing but no SSE client is connected,
 * the response is stored here for later retrieval.
 */
export interface StoredResponse {
  message_id: string;
  events: StoredSSEEvent[];
  stored_at: number;
}

export interface StoredSSEEvent {
  event: string;
  data: string;
}

/**
 * Payload shape for audio_chunk events produced by chunking large TTS audio.
 *
 * When a complete event's voice_audio_base64 exceeds the DO storage per-value
 * limit, the audio is stripped and split into sequential audio_chunk events.
 * Clients reassemble by concatenating the `data` fields in index order.
 */
export interface AudioChunkPayload {
  type: 'audio_chunk';
  index: number;
  total: number;
  data: string;
}

/**
 * Metadata for the chunked incremental event store.
 *
 * Events are stored in individual keys (`ev:{messageId}:{index}`) rather than
 * a single array. This allows poll requests to read only new events (from cursor
 * to event_count) instead of the entire history, significantly reducing DO
 * storage I/O under concurrent polling.
 *
 * Stored at key: `evmeta:{messageId}`
 */
export interface EventStoreMetadata {
  message_id: string;
  event_count: number;
  done: boolean;
  created_at: number;
}

/**
 * Response from GET /poll
 */
export interface PollResponse {
  message_id: string;
  events: StoredSSEEvent[];
  done: boolean;
  cursor: number;
}

/**
 * Response from POST /enqueue
 */
export interface EnqueueResponse {
  message_id: string;
  queue_position: number;
}

/**
 * Response from GET /status
 */
export interface QueueStatusResponse {
  queue_length: number;
  processing: boolean;
  stored_response_count: number;
}
