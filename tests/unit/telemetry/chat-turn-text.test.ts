/**
 * Conversation text on the turn record (services/telemetry/chat-turn-text.ts):
 * both fields verbatim, the reply joined the way the user received it, and a
 * per-field cap that says what it dropped.
 */
import { describe, it, expect } from 'vitest';
import {
  CHAT_TURN_TEXT_MAX_CHARS,
  chatTurnText,
  clampChatTurnText,
} from '../../../src/services/telemetry/chat-turn-text.js';

describe('chatTurnText', () => {
  it('carries the message verbatim and joins the responses with a blank line', () => {
    expect(chatTurnText('What does John 3:16 mean?', ['One.', 'Two.'])).toEqual({
      user_message: 'What does John 3:16 mean?',
      assistant_reply: 'One.\n\nTwo.',
    });
  });

  it('turns an empty response list into an empty reply, not a missing field', () => {
    expect(chatTurnText('q', [])).toEqual({ user_message: 'q', assistant_reply: '' });
  });
});

describe('clampChatTurnText', () => {
  it('leaves text at or under the cap untouched', () => {
    const exact = 'x'.repeat(CHAT_TURN_TEXT_MAX_CHARS);
    expect(clampChatTurnText(exact)).toBe(exact);
    expect(clampChatTurnText('short')).toBe('short');
  });

  it('keeps the head and says how much was dropped', () => {
    const out = clampChatTurnText('x'.repeat(CHAT_TURN_TEXT_MAX_CHARS + 5));
    expect(out.startsWith('x'.repeat(CHAT_TURN_TEXT_MAX_CHARS))).toBe(true);
    expect(out.endsWith('\n…[truncated 5 chars]')).toBe(true);
  });
});
