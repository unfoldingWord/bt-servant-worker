/**
 * Unit tests for validateChatBody() — the worker-level per-transport
 * validation introduced in v2.13.0 for the explicit /chat, /chat/stream,
 * /chat/callback endpoints.
 *
 * DO path-dispatch smoke tests live in tests/e2e/chat-transport-dispatch.test.ts
 * because they rely on miniflare DO bindings (skipped on Windows).
 */

import { describe, it, expect } from 'vitest';
import { validateChatBody } from '../../src/index.js';
import type { ChatRequest } from '../../src/types/engine.js';

const baseBody: ChatRequest = {
  client_id: 'cli',
  user_id: 'u1',
  message_type: 'text',
  message: 'hi',
};

describe('validateChatBody — shared rules', () => {
  it('rejects missing user_id', () => {
    const { user_id: _omit, ...body } = baseBody;
    void _omit;
    expect(validateChatBody(body as ChatRequest, 'legacy')).toBe('user_id is required');
  });

  it('rejects missing client_id', () => {
    const { client_id: _omit, ...body } = baseBody;
    void _omit;
    expect(validateChatBody(body as ChatRequest, 'legacy')).toBe('client_id is required');
  });

  it('accepts a minimal valid body on legacy transport', () => {
    expect(validateChatBody(baseBody, 'legacy')).toBeNull();
  });
});

describe('validateChatBody — stream transport', () => {
  it('accepts a minimal valid body', () => {
    expect(validateChatBody(baseBody, 'stream')).toBeNull();
  });

  it('rejects progress_callback_url', () => {
    const result = validateChatBody(
      { ...baseBody, progress_callback_url: 'https://example.com/hook' },
      'stream'
    );
    expect(result).toContain('progress_callback_url');
    expect(result).toContain('/api/v1/chat/callback');
  });

  it('rejects progress_mode', () => {
    const result = validateChatBody({ ...baseBody, progress_mode: 'iteration' }, 'stream');
    expect(result).toContain('progress_mode');
  });

  it('rejects progress_throttle_seconds', () => {
    const result = validateChatBody({ ...baseBody, progress_throttle_seconds: 5 }, 'stream');
    expect(result).toContain('progress_throttle_seconds');
  });

  it('rejects message_key', () => {
    const result = validateChatBody({ ...baseBody, message_key: 'm1' }, 'stream');
    expect(result).toContain('message_key');
    expect(result).toContain('/api/v1/chat/callback');
  });
});

describe('validateChatBody — callback transport', () => {
  it('accepts a body with progress_callback_url and message_key', () => {
    const result = validateChatBody(
      {
        ...baseBody,
        progress_callback_url: 'https://example.com/hook',
        message_key: 'm1',
      },
      'callback'
    );
    expect(result).toBeNull();
  });

  it('rejects missing progress_callback_url', () => {
    expect(validateChatBody({ ...baseBody, message_key: 'm1' }, 'callback')).toBe(
      'progress_callback_url is required on /api/v1/chat/callback'
    );
  });

  it('rejects missing message_key', () => {
    expect(
      validateChatBody(
        { ...baseBody, progress_callback_url: 'https://example.com/hook' },
        'callback'
      )
    ).toBe('message_key is required on /api/v1/chat/callback');
  });

  it('rejects missing both progress_callback_url and message_key (URL error first)', () => {
    expect(validateChatBody(baseBody, 'callback')).toBe(
      'progress_callback_url is required on /api/v1/chat/callback'
    );
  });
});

describe('validateChatBody — legacy transport (body-dispatch)', () => {
  it('accepts a body WITH progress_callback_url (legacy callback mode)', () => {
    expect(
      validateChatBody(
        {
          ...baseBody,
          progress_callback_url: 'https://example.com/hook',
          message_key: 'm1',
        },
        'legacy'
      )
    ).toBeNull();
  });

  it('accepts a body WITHOUT progress_callback_url (legacy SSE mode)', () => {
    expect(validateChatBody(baseBody, 'legacy')).toBeNull();
  });

  it('accepts progress_mode and progress_throttle_seconds on legacy', () => {
    expect(
      validateChatBody(
        {
          ...baseBody,
          progress_callback_url: 'https://example.com/hook',
          message_key: 'm1',
          progress_mode: 'iteration',
          progress_throttle_seconds: 5,
        },
        'legacy'
      )
    ).toBeNull();
  });
});

describe('validateChatBody — group chat rules (transport-agnostic)', () => {
  it('requires chat_id for group chats', () => {
    const result = validateChatBody({ ...baseBody, chat_type: 'group' }, 'legacy');
    expect(result).toBe('chat_id is required for group/supergroup chats');
  });

  it('requires chat_id for supergroups on the stream transport', () => {
    const result = validateChatBody({ ...baseBody, chat_type: 'supergroup' }, 'stream');
    expect(result).toBe('chat_id is required for group/supergroup chats');
  });
});
