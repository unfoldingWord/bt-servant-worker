/**
 * Types for the UserQueue Durable Object
 *
 * The UserQueue sits between the worker router and UserSession,
 * serializing requests per-user via an alarm-based processing loop.
 */

import { ProgressMode } from './engine.js';
import { MCPServerConfig } from './mcp.js';
import { OrgConfig } from './org-config.js';
import { PromptOverrides } from './prompt-overrides.js';

/**
 * Entry in the queue awaiting processing.
 * Contains everything needed to forward the request to UserSession.
 */
export interface QueueEntry {
  message_id: string;
  user_id: string;
  client_id: string;
  message: string;
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
