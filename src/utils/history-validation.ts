/**
 * Validation + sanitization for a client-supplied conversation thread (#392).
 *
 * A chat request may carry `history: ClientHistoryEntry[]`, which REPLACES the
 * user's stored thread before the turn runs (see docs/client-supplied-history.md).
 * Two concerns live here, deliberately apart from `chat-validation.ts` so that
 * file stays within the complexity lint:
 *
 * - `validateClientHistory` — shape/size rules, returning the exact 400 message.
 *   Runs at the worker route AND again in UserDO (defense in depth, same as
 *   `validateChatBody`).
 * - `sanitizeClientHistory` — builds FRESH storage entries from a whitelist of
 *   fields. It never spreads the client object, so R2 audio keys, `speaker`,
 *   `attachments`, or the read endpoint's derived URLs can never reach storage
 *   (where `GET /history` would mint URLs for them).
 */

import type { ChatHistoryEntry, ChatRequest, ClientHistoryEntry } from '../types/engine.js';

/** Per-field character cap on `user_message` / `assistant_response`. */
export const MAX_CLIENT_HISTORY_FIELD_CHARS = 16_000;

/**
 * Cap on the serialized `history` array. UserDO is SQLite-backed, so one
 * storage value (the history array; the callback queue holding whole request
 * bodies) is limited to 2 MiB. 512 KiB leaves headroom for the 50-turn cap
 * and for queued bodies that carry a thread.
 */
export const MAX_CLIENT_HISTORY_BYTES = 512 * 1024;

type TextField = 'user_message' | 'assistant_response';

/**
 * True when the request supplies a thread. `null` is treated as absent, matching
 * the `voice_format` convention (both mean "use the default behavior"). This is
 * the ONE predicate the DO uses to decide replace-vs-continue, so the worker
 * validator and the DO can never disagree about what counts as "supplied".
 */
export function hasClientHistory(body: Pick<ChatRequest, 'history'>): boolean {
  return Array.isArray(body.history);
}

function validateTextField(
  entry: Record<string, unknown>,
  field: TextField,
  index: number
): string | null {
  const value = entry[field];
  if (typeof value !== 'string' || value.trim().length === 0) {
    return `history[${index}].${field} is required and must be non-empty`;
  }
  if (value.length > MAX_CLIENT_HISTORY_FIELD_CHARS) {
    return `history[${index}].${field} exceeds ${MAX_CLIENT_HISTORY_FIELD_CHARS} characters`;
  }
  return null;
}

/** Both time spellings are optional; when present they must at least parse. */
function validateTimeFields(entry: Record<string, unknown>, index: number): string | null {
  const { timestamp, created_at } = entry;
  if (timestamp != null && (typeof timestamp !== 'number' || !Number.isFinite(timestamp))) {
    return `history[${index}].timestamp must be a number (milliseconds since epoch)`;
  }
  if (
    created_at != null &&
    (typeof created_at !== 'string' || Number.isNaN(Date.parse(created_at)))
  ) {
    return `history[${index}].created_at must be an ISO 8601 date string`;
  }
  return null;
}

function validateEntry(entry: unknown, index: number): string | null {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    return `history[${index}] must be an object`;
  }
  const record = entry as Record<string, unknown>;
  return (
    validateTextField(record, 'user_message', index) ??
    validateTextField(record, 'assistant_response', index) ??
    validateTimeFields(record, index)
  );
}

/**
 * Validate the optional `history` field. Returns the 400 message or null.
 *
 * Order: the byte cap is checked FIRST so an oversized payload is rejected
 * before any per-entry work; then each entry is checked in order and the first
 * failure names its index.
 */
export function validateClientHistory(history: unknown): string | null {
  if (history === undefined || history === null) return null;
  if (!Array.isArray(history)) {
    return 'history must be an array of { user_message, assistant_response } entries';
  }
  const bytes = new TextEncoder().encode(JSON.stringify(history)).byteLength;
  if (bytes > MAX_CLIENT_HISTORY_BYTES) {
    return `history exceeds ${MAX_CLIENT_HISTORY_BYTES} bytes`;
  }
  for (let i = 0; i < history.length; i++) {
    const error = validateEntry(history[i], i);
    if (error) return error;
  }
  return null;
}

/**
 * Resolve the stored `timestamp` for an uploaded entry: `timestamp` wins, then
 * a parseable `created_at`, then `now`. Nothing in the worker sorts by this
 * value (order is array order), so a defaulted time is purely a label.
 */
export function resolveEntryTimestamp(entry: ClientHistoryEntry, now: number): number {
  if (typeof entry.timestamp === 'number' && Number.isFinite(entry.timestamp)) {
    return entry.timestamp;
  }
  if (typeof entry.created_at === 'string') {
    const parsed = Date.parse(entry.created_at);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return now;
}

/**
 * Build storage entries from validated client entries. Whitelist only — see
 * the module comment for why this must never spread the client object.
 */
export function sanitizeClientHistory(
  entries: ClientHistoryEntry[],
  now: number
): ChatHistoryEntry[] {
  return entries.map((entry) => ({
    user_message: entry.user_message,
    assistant_response: entry.assistant_response,
    timestamp: resolveEntryTimestamp(entry, now),
  }));
}
