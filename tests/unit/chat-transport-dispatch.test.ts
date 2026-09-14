/**
 * Unit tests for validateChatBody() — the worker-level per-transport
 * validation for the three explicit chat endpoints:
 *   - POST /api/v1/chat           (transport: 'final')
 *   - POST /api/v1/chat/stream    (transport: 'stream')
 *   - POST /api/v1/chat/callback  (transport: 'callback')
 *
 * DO path-dispatch smoke tests live in tests/e2e/chat-transport-dispatch.test.ts
 * because they rely on miniflare DO bindings (skipped on Windows).
 */

import { describe, it, expect } from 'vitest';
import { validateChatBody } from '../../src/index.js';
import { isAdminClient } from '../../src/utils/chat-validation.js';
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
    expect(validateChatBody(body as ChatRequest, 'final')).toBe('user_id is required');
  });

  it('rejects missing client_id', () => {
    const { client_id: _omit, ...body } = baseBody;
    void _omit;
    expect(validateChatBody(body as ChatRequest, 'final')).toBe('client_id is required');
  });

  it('rejects is_admin in the body (admin origin is derived from client_id)', () => {
    const body = { ...baseBody, is_admin: true } as unknown as ChatRequest;
    expect(validateChatBody(body, 'final')).toBe(
      'is_admin is not a valid field; admin origin is derived from client_id'
    );
  });

  it('rejects is_admin: false the same way (any presence of the field)', () => {
    const body = { ...baseBody, is_admin: false } as unknown as ChatRequest;
    expect(validateChatBody(body, 'final')).toBe(
      'is_admin is not a valid field; admin origin is derived from client_id'
    );
  });
});

describe('validateChatBody — voice_format', () => {
  it('accepts voice_format: opus', () => {
    expect(validateChatBody({ ...baseBody, voice_format: 'opus' }, 'final')).toBeNull();
  });

  it('accepts voice_format: aac', () => {
    expect(validateChatBody({ ...baseBody, voice_format: 'aac' }, 'final')).toBeNull();
  });

  it('accepts an absent voice_format (defaults to opus downstream)', () => {
    expect(validateChatBody(baseBody, 'final')).toBeNull();
  });

  it('rejects an unknown voice_format', () => {
    const body = { ...baseBody, voice_format: 'mp3' } as unknown as ChatRequest;
    expect(validateChatBody(body, 'final')).toBe(
      'Invalid voice_format: mp3. Must be one of: opus, aac'
    );
  });

  it('treats voice_format: null as absent (matches the ?? default downstream)', () => {
    const body = { ...baseBody, voice_format: null } as unknown as ChatRequest;
    expect(validateChatBody(body, 'final')).toBeNull();
  });

  it("rejects an empty-string voice_format ''", () => {
    const body = { ...baseBody, voice_format: '' } as unknown as ChatRequest;
    expect(validateChatBody(body, 'final')).toBe(
      'Invalid voice_format: . Must be one of: opus, aac'
    );
  });

  it.each([[false], [0], [{ fmt: 'aac' }]])(
    'rejects a non-string voice_format %j with a fixed message',
    (value) => {
      const body = { ...baseBody, voice_format: value } as unknown as ChatRequest;
      expect(validateChatBody(body, 'final')).toBe(
        'Invalid voice_format: expected a string. Must be one of: opus, aac'
      );
    }
  );

  it('rejects { toString: null } without throwing (coercion would raise a TypeError)', () => {
    const body = { ...baseBody, voice_format: { toString: null } } as unknown as ChatRequest;
    expect(validateChatBody(body, 'final')).toBe(
      'Invalid voice_format: expected a string. Must be one of: opus, aac'
    );
  });
});

describe('isAdminClient', () => {
  it('treats "admin-portal" as admin', () => {
    expect(isAdminClient('admin-portal')).toBe(true);
  });

  it('treats other client_ids as non-admin', () => {
    expect(isAdminClient('whatsapp-gateway')).toBe(false);
    expect(isAdminClient('web-client')).toBe(false);
    expect(isAdminClient('')).toBe(false);
  });

  it('treats undefined as non-admin', () => {
    expect(isAdminClient(undefined)).toBe(false);
  });
});

describe('validateChatBody — final transport', () => {
  it('accepts a minimal valid body', () => {
    expect(validateChatBody(baseBody, 'final')).toBeNull();
  });

  it('rejects progress_callback_url', () => {
    const result = validateChatBody(
      { ...baseBody, progress_callback_url: 'https://example.com/hook' },
      'final'
    );
    expect(result).toContain('progress_callback_url');
    expect(result).toContain('/api/v1/chat');
    expect(result).toContain('/api/v1/chat/callback');
  });

  it('rejects progress_mode', () => {
    const result = validateChatBody({ ...baseBody, progress_mode: 'iteration' }, 'final');
    expect(result).toContain('progress_mode');
    expect(result).toContain('/api/v1/chat');
  });

  it('rejects progress_throttle_seconds', () => {
    const result = validateChatBody({ ...baseBody, progress_throttle_seconds: 5 }, 'final');
    expect(result).toContain('progress_throttle_seconds');
  });

  it('rejects message_key', () => {
    const result = validateChatBody({ ...baseBody, message_key: 'm1' }, 'final');
    expect(result).toContain('message_key');
    expect(result).toContain('/api/v1/chat/callback');
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
    expect(result).toContain('/api/v1/chat/stream');
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

  it('accepts progress_mode and progress_throttle_seconds alongside required fields', () => {
    const result = validateChatBody(
      {
        ...baseBody,
        progress_callback_url: 'https://example.com/hook',
        message_key: 'm1',
        progress_mode: 'complete',
        progress_throttle_seconds: 5,
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

describe('validateChatBody — group chat rules (transport-agnostic)', () => {
  it('requires chat_id for group chats on the final transport', () => {
    const result = validateChatBody({ ...baseBody, chat_type: 'group' }, 'final');
    expect(result).toBe('chat_id is required for group/supergroup chats');
  });

  it('requires chat_id for supergroups on the stream transport', () => {
    const result = validateChatBody({ ...baseBody, chat_type: 'supergroup' }, 'stream');
    expect(result).toBe('chat_id is required for group/supergroup chats');
  });

  it('requires chat_id for groups on the callback transport', () => {
    const result = validateChatBody(
      {
        ...baseBody,
        chat_type: 'group',
        progress_callback_url: 'https://example.com/hook',
        message_key: 'm1',
      },
      'callback'
    );
    expect(result).toBe('chat_id is required for group/supergroup chats');
  });
});

describe('validateChatBody — client-owned conversation fields (#392)', () => {
  const thread = [{ user_message: 'q', assistant_response: 'a' }];
  const callbackFields = { progress_callback_url: 'https://example.com/hook', message_key: 'm1' };

  it('accepts history, suppress_welcome and suppress_memory on every transport', () => {
    const fields = { history: thread, suppress_welcome: true, suppress_memory: true };
    expect(validateChatBody({ ...baseBody, ...fields }, 'final')).toBeNull();
    expect(validateChatBody({ ...baseBody, ...fields }, 'stream')).toBeNull();
    expect(validateChatBody({ ...baseBody, ...fields, ...callbackFields }, 'callback')).toBeNull();
  });

  it('accepts an empty history (start blank) and explicit false flags', () => {
    const body = { ...baseBody, history: [], suppress_welcome: false, suppress_memory: false };
    expect(validateChatBody(body, 'final')).toBeNull();
  });

  it('treats null flags and null history as absent', () => {
    const body = {
      ...baseBody,
      history: null,
      suppress_welcome: null,
      suppress_memory: null,
    } as unknown as ChatRequest;
    expect(validateChatBody(body, 'final')).toBeNull();
  });

  it('still allows suppress flags on group chats (they are not history)', () => {
    const body = { ...baseBody, chat_type: 'group' as const, chat_id: 'g1', suppress_memory: true };
    expect(validateChatBody(body, 'final')).toBeNull();
  });
});

describe('validateChatBody — client-owned conversation fields, rejections (#392)', () => {
  const thread = [{ user_message: 'q', assistant_response: 'a' }];

  it('rejects a non-boolean suppress_welcome', () => {
    const body = { ...baseBody, suppress_welcome: 'yes' } as unknown as ChatRequest;
    expect(validateChatBody(body, 'final')).toBe('suppress_welcome must be a boolean');
  });

  it('rejects a non-boolean suppress_memory', () => {
    const body = { ...baseBody, suppress_memory: 1 } as unknown as ChatRequest;
    expect(validateChatBody(body, 'final')).toBe('suppress_memory must be a boolean');
  });

  it('surfaces the history validator message verbatim', () => {
    const body = {
      ...baseBody,
      history: [{ user_message: 'q', assistant_response: '' }],
    } as unknown as ChatRequest;
    expect(validateChatBody(body, 'final')).toBe(
      'history[0].assistant_response is required and must be non-empty'
    );
  });

  it('rejects history on group and supergroup chats, even when empty', () => {
    const group = { ...baseBody, chat_type: 'group' as const, chat_id: 'g1', history: [] };
    expect(validateChatBody(group, 'final')).toBe(
      'history is not supported on group/supergroup chats'
    );
    const supergroup = {
      ...baseBody,
      chat_type: 'supergroup' as const,
      chat_id: 'g1',
      history: thread,
    };
    expect(validateChatBody(supergroup, 'stream')).toBe(
      'history is not supported on group/supergroup chats'
    );
  });
});
