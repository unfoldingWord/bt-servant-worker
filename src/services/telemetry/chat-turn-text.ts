/**
 * Conversation text on the `chat_turn` record.
 *
 * The turn record has always carried facts ABOUT a turn — model, tokens, mode,
 * timing. This module adds its words: the user's message and the assistant's
 * reply, so the tail consumer (bt-servant-telemetry) can scrub personal names
 * out of both and forward the exchange to PostHog's conversation view.
 *
 * Governance:
 *   - Console/tail path only. The OTLP path classifies both keys as unknown
 *     string keys and egresses `string(<len>)`, never the text
 *     (services/telemetry/redact.ts, pinned by redact.test.ts).
 *   - Capped per field so one enormous reply cannot bloat a log line.
 *   - Log payload only. `buildChatTurnRecord` never lets either field near the
 *     `chat_turns_total` metric labels.
 *   - Whether the text goes any further is the tail consumer's decision: it
 *     scrubs before forwarding and withholds the text entirely when it cannot.
 */

/** Per-field cap. WhatsApp inbound tops out at 4,096 chars; replies run longer. */
export const CHAT_TURN_TEXT_MAX_CHARS = 12_000;

/** The two text fields, named exactly as they appear on the log record. */
export interface ChatTurnText {
  user_message: string;
  assistant_reply: string;
}

/** Clip to the cap, keeping the head and saying how much was dropped. */
export function clampChatTurnText(text: string, maxChars = CHAT_TURN_TEXT_MAX_CHARS): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n…[truncated ${text.length - maxChars} chars]`;
}

/**
 * The text fields for a turn record.
 *
 * `responses` are the orchestrator's text responses across iterations, which
 * the user receives as consecutive messages; joined with a blank line they read
 * as the one reply the user saw.
 */
export function chatTurnText(userMessage: string, responses: readonly string[]): ChatTurnText {
  return {
    user_message: clampChatTurnText(userMessage),
    assistant_reply: clampChatTurnText(responses.join('\n\n')),
  };
}
