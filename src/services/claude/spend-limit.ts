/**
 * Recognise Anthropic's "you have run out of money" responses (#468).
 *
 * On 2026-10-29 the org reached the spend limit it had set itself and every
 * turn failed for about seven hours with HTTP 400 `invalid_request_error`,
 * "You have reached your specified API usage limits. You will regain access
 * on 2026-11-01 at 00:00 UTC." (548 events, confirmed in production logs by
 * Ian). Nothing told it apart from a malformed request.
 *
 * Documented shapes (platform.claude.com/docs/en/api/rate-limits and /errors,
 * read 2026-11-13):
 * - Self-set org or workspace spend limit: HTTP 400, `invalid_request_error`,
 *   message starting `You have reached your specified API usage limits` or
 *   `You have reached your specified workspace API usage limits`, then when
 *   access resumes. There is no structured code for this case, so the message
 *   is the only signal.
 * - Usage-tier monthly spend cap: HTTP 429, `rate_limit_error`, NO
 *   `retry-after`, and `error.details.error_code: "enforced_spend_limit_reached"`.
 *   Its message reads "You have reached your API usage limits: ...".
 * - Billing problem (for example a declined card): HTTP 402, `billing_error`.
 *
 * Only HTTP 400, 402 and 429 are inspected (the documented spend and billing
 * statuses). Match rules, in order (first hit wins):
 * 1. `error.type === "billing_error"` or HTTP 402 → `billing`.
 * 2. `error.details.error_code === "enforced_spend_limit_reached"` →
 *    `spend_cap` for a 429, `spend_limit` otherwise.
 * 3. HTTP 400 or 429 whose message (the parsed `error.message`, else the raw
 *    body) matches {@link SPEND_MESSAGE_PATTERNS} → `spend_limit` for a 400,
 *    `spend_cap` for a 429. A 429 that carries `retry-after` is excluded: that
 *    is a real rate limit or a Claude Code workspace limit, which does clear.
 *
 * The message match is deliberately looser than the documented prefix so a
 * small wording change does not silently turn the alert off: whitespace and
 * case are normalised, "limit"/"limits" and the optional "specified" /
 * "workspace" words are accepted, and "usage limit" together with "regain
 * access" also counts. It is anchored on "usage limit", which no request
 * validation error contains. Everything else (validation 400s, ordinary or
 * ramp-limit 429s) returns null and keeps its existing handling.
 *
 * Pure: no I/O, no logging. Only applied to routes whose provider is
 * Anthropic; OpenRouter's own credit errors are a different account.
 */
import type { UpstreamSpendKind } from '../../utils/errors.js';

export const ENFORCED_SPEND_LIMIT_CODE = 'enforced_spend_limit_reached';

/** Normalised (lower-case, single-spaced) message patterns; see the module doc. */
const SPEND_MESSAGE_PATTERNS: readonly ((msg: string) => boolean)[] = [
  (m) => /\breached (?:your|the) (?:specified )?(?:workspace )?api usage limits?\b/.test(m),
  (m) => /\busage limits?\b/.test(m) && /\bregain access\b/.test(m),
];

/** Statuses whose body can carry a spend or billing signal (worth reading the body for). */
const SPEND_CANDIDATE_STATUSES: ReadonlySet<number> = new Set([400, 402, 429]);

export function isSpendCandidateStatus(status: number): boolean {
  return SPEND_CANDIDATE_STATUSES.has(status);
}

export interface UpstreamSpendVerdict {
  kind: UpstreamSpendKind;
  /** `error.type` from the body, when it parsed. */
  errorType?: string;
  /** `error.details.error_code` from the body, when present. */
  errorCode?: string;
  /** The upstream message (or raw body), trimmed to 300 chars, for the log only. */
  message: string;
  /** Whether the body parsed as JSON. */
  bodyJson: boolean;
}

interface ParsedErrorBody {
  /** False when the body was not JSON; the raw text is then matched instead. */
  json: boolean;
  type?: string | undefined;
  message?: string | undefined;
  code?: string | undefined;
}

function parseErrorBody(text: string): ParsedErrorBody {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Not JSON (a proxy page, a truncated body). Not swallowed: the verdict
    // carries `bodyJson: false`, which the caller logs, and the raw text is
    // matched instead. A non-match is logged by the existing HTTP error path.
    return { json: false };
  }
  const error = (parsed as { error?: unknown } | null)?.error;
  if (!error || typeof error !== 'object') return { json: true };
  const e = error as { type?: unknown; message?: unknown; details?: unknown };
  const details = e.details as { error_code?: unknown } | undefined;
  return {
    json: true,
    type: typeof e.type === 'string' ? e.type : undefined,
    message: typeof e.message === 'string' ? e.message : undefined,
    code: details && typeof details.error_code === 'string' ? details.error_code : undefined,
  };
}

function normalise(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ');
}

function messageSaysSpend(text: string): boolean {
  const m = normalise(text);
  return SPEND_MESSAGE_PATTERNS.some((matches) => matches(m));
}

/** Rules 1 and 2: the structured fields (`error.type`, `error.details.error_code`). */
function kindFromStructure(status: number, parsed: ParsedErrorBody): UpstreamSpendKind | null {
  if (status === 402 || parsed.type === 'billing_error') return 'billing';
  if (parsed.code !== ENFORCED_SPEND_LIMIT_CODE) return null;
  return status === 429 ? 'spend_cap' : 'spend_limit';
}

/** Rule 3: the message text, for a 400, or a 429 without `retry-after`. */
function kindFromMessage(
  status: number,
  text: string,
  hasRetryAfter: boolean
): UpstreamSpendKind | null {
  if (status === 429 && hasRetryAfter) return null;
  if (status !== 400 && status !== 429) return null;
  if (!messageSaysSpend(text)) return null;
  return status === 429 ? 'spend_cap' : 'spend_limit';
}

/**
 * Classify an Anthropic error response as a spend or billing stop, or null.
 * `hasRetryAfter` is whether the response carried a `retry-after` header.
 */
export function classifyUpstreamSpend(
  status: number,
  bodyText: string,
  hasRetryAfter: boolean
): UpstreamSpendVerdict | null {
  if (!isSpendCandidateStatus(status)) return null;
  const parsed = parseErrorBody(bodyText);
  const kind =
    kindFromStructure(status, parsed) ??
    kindFromMessage(status, parsed.message ?? bodyText, hasRetryAfter);
  if (!kind) return null;
  return {
    kind,
    ...(parsed.type ? { errorType: parsed.type } : {}),
    ...(parsed.code ? { errorCode: parsed.code } : {}),
    message: (parsed.message ?? bodyText).slice(0, 300),
    bodyJson: parsed.json,
  };
}
