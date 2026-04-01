/**
 * Types for the internal queue in UserDO.
 *
 * The queue serializes chat requests per user via an alarm-based
 * processing loop within the merged UserDO Durable Object.
 */

import { ChatRequest } from './engine.js';

/**
 * Entry in the internal queue awaiting processing.
 * Contains the original request body and queue metadata.
 */
export interface InternalQueueEntry {
  message_id: string;
  /** The full chat request body including injected KV config */
  body: ChatRequest & { _worker_origin?: string };
  enqueued_at: number;
  /** Number of times this entry has been retried after transient failures */
  retry_count: number;
}
