/**
 * Failed turns (`buildFailedChatTurnRecord`).
 *
 * Before this record existed, an outage read as silence: every chat_turn that
 * reached telemetry had succeeded, so an error rate could only ever be zero.
 * A failed turn is a real chat_turn that never answered — exit_reason error,
 * a bounded error_type, no tokens or steps — and never carries the error
 * message, which can quote user input.
 */
import { describe, it, expect } from 'vitest';
import { buildFailedChatTurnRecord, failureType } from '../../../src/durable-objects/user-do.js';
import { ValidationError } from '../../../src/utils/errors.js';
import type { ChatRequest } from '../../../src/types/engine.js';

const ENV = { DEFAULT_ORG: 'unfoldingWord' };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function body(overrides: Partial<ChatRequest> = {}): ChatRequest {
  return {
    client_id: 'whatsapp',
    user_id: 'whatsapp:15551234567',
    message_type: 'text',
    message: 'What does Luke 2:3 say?',
    _transport: 'final',
    ...overrides,
  } as ChatRequest;
}

describe('buildFailedChatTurnRecord', () => {
  it('is a chat_turn that never answered: exit_reason error, no tokens, no steps, empty reply', () => {
    const r = buildFailedChatTurnRecord(body(), ENV, new Error('boom'));
    expect(r.exit_reason).toBe('error');
    expect(r).not.toHaveProperty('input_tokens');
    expect(r).not.toHaveProperty('iterations');
    expect(r).not.toHaveProperty('response_language');
    expect(r.tool_calls).toEqual([]);
    expect(r.user_message).toBe('What does Luke 2:3 say?');
    expect(r.assistant_reply).toBe('');
    expect(r.had_outbound_voice).toBe(false);
    expect(r.client_id).toBe('whatsapp');
    expect(r.org).toBe('unfoldingWord');
    expect(typeof r.engine_version).toBe('string');
  });

  it('mints its own turn_id and names the model that would have answered', () => {
    const r = buildFailedChatTurnRecord(body(), ENV, new Error('boom'));
    expect(r.turn_id).toMatch(UUID);
    expect(typeof r.model).toBe('string');
    const custom = buildFailedChatTurnRecord(
      body(),
      { DEFAULT_ORG: 'x', CLAUDE_MODEL: 'claude-opus-5' },
      new Error('boom')
    );
    expect(custom.model).toBe('claude-opus-5');
  });

  it('carries a bounded error_type and never the error message', () => {
    const r = buildFailedChatTurnRecord(body(), ENV, new TypeError('leaked: Bob asked about Luke'));
    expect(r.error_type).toBe('TypeError');
    expect(JSON.stringify(r)).not.toContain('leaked');
    expect(JSON.stringify(r)).not.toContain('Bob');
  });

  it('marks a voice message as voice, with no text to carry', () => {
    const r = buildFailedChatTurnRecord(
      body({ message_type: 'audio', message: undefined }),
      ENV,
      new Error('stt down')
    );
    expect(r.had_inbound_voice).toBe(true);
    expect(r.user_message).toBe('');
  });
});

describe('failureType', () => {
  it('uses an AppError code, an Error class name, or unknown', () => {
    const app = new ValidationError('bad input');
    expect(failureType(app)).toBe(app.code);
    expect(failureType(new RangeError('x'))).toBe('RangeError');
    expect(failureType('a string')).toBe('unknown');
    expect(failureType(undefined)).toBe('unknown');
  });
});
