/**
 * Shared FAIL-CLOSED attribute redaction policy for OTLP telemetry.
 *
 * This is the single source of truth for turning arbitrary structured data into
 * safe OpenTelemetry attributes — used by BOTH the logs pipeline (`logs.ts`,
 * `buildLogAttributes`) and manual spans (`span.ts`, `withSpan`). It was extracted
 * out of `logs.ts` in M3 precisely so spans do not hand-roll a second, weaker
 * policy: any attribute we attach to a span goes through the exact same classifier
 * that guards log egress.
 *
 * The policy fails CLOSED: a value only egresses raw when we can prove it is bounded
 * and non-content (a number/boolean, a URL reduced to its origin, or a string under
 * an allow-list of structural keys). Everything else — unknown string keys, nested
 * objects/arrays — is summarized to type + length, so message content or precise
 * location cannot leak by default even from a call site that passes it in.
 */
import { summarizeArgs, SENSITIVE_KEY_PATTERN } from '../../utils/logger.js';

/** An OTLP attribute value must be a primitive; nested data is JSON-encoded. */
export type AttributeValue = string | number | boolean;

/**
 * Allow-list of string-valued attribute keys that may egress with their RAW
 * value. These are bounded structural identifiers / enums, never message content
 * or precise location. Anything NOT here is summarized to its length instead —
 * the policy fails CLOSED so a content-bearing field under a new/innocuous key
 * (e.g. `response`, `text_preview`, `user_message`) can never leak by default.
 *
 * Deliberately EXCLUDED: raw `error`/`stack`, and the generic `name`/`_key`/`_name`
 * families. Error boundaries embed untrusted upstream text (e.g. MCPError carries a
 * remote JSON-RPC message that may contain user content or a signed URL inside a
 * sentence — neither URL-origin nor truncation redacts that), so we export the
 * bounded `error_name` (error class) and keep full diagnostics on the console path.
 * `*_key` values are exact R2 audio paths embedding org/user/chat/speaker ids that
 * collector `user_id` hashing cannot reach; `name`/`*_name` can be filenames/display
 * names. All of these are summarized to length instead.
 */
const SAFE_STRING_ATTRIBUTE_KEYS = new Set<string>([
  'request_id',
  'user_id',
  'event',
  'org',
  'organization',
  'environment',
  'region',
  'transport',
  'chat_type',
  'chat_id',
  'thread_id',
  'client_id',
  'message_id',
  'message_type',
  'intent',
  'language',
  'source_language',
  'target_language',
  'response_language',
  'book',
  'chapter',
  'verse',
  'reference',
  'model',
  'tool',
  'tool_name',
  'server',
  'server_id',
  'server_name',
  'job_id',
  'bucket',
  'mode',
  'mode_name',
  'status',
  'status_code',
  'state',
  'phase',
  'step',
  'stage',
  'reason',
  'error_name',
  'error_type',
  'type',
  'action',
  'operation',
  'method',
  'format',
  'audio_format',
  'original_format',
  'direction',
  'kind',
  'level',
  'version',
  'code',
]);

/**
 * Key suffixes whose string values are bounded structural ids/enums, not content.
 * Excludes `_key` (exact R2 audio paths with embedded ids) and `_name`
 * (filenames/display names) — those are summarized to length instead.
 */
const SAFE_STRING_KEY_SUFFIXES = [
  '_id',
  '_ids',
  '_type',
  '_status',
  '_code',
  '_format',
  '_reason',
  '_mode',
  '_language',
  '_phase',
  '_state',
  '_kind',
];

/** Cap allow-listed string values so an unexpectedly large one cannot bloat egress. */
const MAX_ATTRIBUTE_STRING_LENGTH = 512;

function isSafeStringKey(key: string): boolean {
  if (SAFE_STRING_ATTRIBUTE_KEYS.has(key)) return true;
  return SAFE_STRING_KEY_SUFFIXES.some((suffix) => key.endsWith(suffix));
}

/** Reduce an http(s) URL to `scheme://host`; undefined if the value is not such a URL. */
function urlToOrigin(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
    return `${url.protocol}//${url.host}`;
  } catch {
    return undefined;
  }
}

function truncateAttribute(value: string): string {
  return value.length <= MAX_ATTRIBUTE_STRING_LENGTH
    ? value
    : `${value.slice(0, MAX_ATTRIBUTE_STRING_LENGTH)} [truncated, ${value.length} chars]`;
}

/**
 * Classify a single value into a safe OTLP attribute under the FAIL-CLOSED policy.
 * - sensitive-named key → `[REDACTED]`.
 * - number / boolean → raw (never content).
 * - http(s) URL string → origin only (drops path + signed query creds), any key.
 * - other string → raw (truncated) only if the key is allow-listed, else `string(<len>)`.
 * - object / array → keys+types summary, never nested raw values.
 */
export function attributeValueFor(key: string, value: unknown): AttributeValue {
  if (SENSITIVE_KEY_PATTERN.test(key)) return '[REDACTED]';
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const origin = urlToOrigin(value);
    if (origin !== undefined) return origin;
    if (isSafeStringKey(key)) return truncateAttribute(value);
    // Unknown string key ⇒ potential message content ⇒ never egress the value.
    return `string(${value.length})`;
  }
  // Objects/arrays: keys+types only, never nested raw values.
  return JSON.stringify(summarizeArgs(value));
}

/**
 * Turn an arbitrary record into flat, redacted OTLP attributes under the
 * FAIL-CLOSED policy. Null/undefined values are dropped; every remaining value is
 * classified by `attributeValueFor`. Unlike `buildLogAttributes` there are no
 * reserved keys — callers (e.g. `withSpan`) pass only the attributes they mean to
 * attach. Span/attribute NAMES are the caller's responsibility and must be static.
 */
export function buildSafeAttributes(
  record: Record<string, unknown>
): Record<string, AttributeValue> {
  const attributes: Record<string, AttributeValue> = {};
  for (const [key, value] of Object.entries(record)) {
    if (value === undefined || value === null) continue;
    attributes[key] = attributeValueFor(key, value);
  }
  return attributes;
}
