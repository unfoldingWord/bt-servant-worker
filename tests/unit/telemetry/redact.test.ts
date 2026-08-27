import { describe, it, expect } from 'vitest';
import { attributeValueFor, buildSafeAttributes } from '../../../src/services/telemetry/redact.js';

describe('attributeValueFor — fail-closed classifier', () => {
  it('passes numbers and booleans raw', () => {
    expect(attributeValueFor('duration_ms', 42)).toBe(42);
    expect(attributeValueFor('success', true)).toBe(true);
    expect(attributeValueFor('success', false)).toBe(false);
  });

  it('masks any value under a sensitive-named key', () => {
    expect(attributeValueFor('api_key', 'sk-live-123')).toBe('[REDACTED]');
    expect(attributeValueFor('auth_token', 'bearer x')).toBe('[REDACTED]');
    expect(attributeValueFor('session_cookie', 'abc')).toBe('[REDACTED]');
  });

  it('reduces http(s) URL strings to origin under ANY key (drops path + query creds)', () => {
    const v = attributeValueFor('anything', 'https://api.example.com/v1/chat?sig=SECRET&u=u42');
    expect(v).toBe('https://api.example.com');
  });

  it('passes an allow-listed string key through raw', () => {
    expect(attributeValueFor('tool_name', 'generate_scripture_pdf')).toBe('generate_scripture_pdf');
    expect(attributeValueFor('server_id', 'translation-helps')).toBe('translation-helps');
  });

  it('passes a suffix-allow-listed key through raw', () => {
    expect(attributeValueFor('job_id', 'abc-123')).toBe('abc-123');
    expect(attributeValueFor('some_status', 'ok')).toBe('ok');
  });

  it('summarizes an UNKNOWN string key to length, never the raw content', () => {
    const v = attributeValueFor('user_message', 'what does John 3:16 mean');
    expect(v).toBe('string(24)');
    expect(v).not.toContain('John');
  });

  it('caps an over-long allow-listed string', () => {
    const long = 'a'.repeat(600);
    const v = attributeValueFor('reason', long) as string;
    expect(v.startsWith('a'.repeat(512))).toBe(true);
    expect(v).toContain('[truncated, 600 chars]');
  });

  it('summarizes objects/arrays to keys+types, never nested raw values', () => {
    const v = attributeValueFor('details', { book: 'John', note: 'secret user note' }) as string;
    const parsed = JSON.parse(v);
    expect(parsed.book).toBe('string(4)');
    expect(parsed.note).toBe('string(16)');
    expect(v).not.toContain('John');
    expect(v).not.toContain('secret user note');
  });
});

/**
 * SENSITIVE_KEY_PATTERN matches any key containing "token", which is right for
 * credentials but also catches the Anthropic usage counters. Those are small
 * integers describing billing volume — they cannot carry a credential or message
 * content — and masking them replaces a number with the string "[REDACTED]",
 * flipping the attribute's type in the sink.
 */
describe('attributeValueFor — numeric token-count carve-out', () => {
  it('passes NUMERIC LLM token counts raw despite the sensitive-key mask', () => {
    expect(attributeValueFor('input_tokens', 1420)).toBe(1420);
    expect(attributeValueFor('output_tokens', 87)).toBe(87);
    expect(attributeValueFor('cache_creation_input_tokens', 0)).toBe(0);
    expect(attributeValueFor('cache_read_input_tokens', 2048)).toBe(2048);
  });

  it('still masks a STRING under those same keys', () => {
    // Numeric-only: a credential mistakenly logged as `input_tokens` must not escape.
    expect(attributeValueFor('input_tokens', 'sk-ant-leaked')).toBe('[REDACTED]');
    expect(attributeValueFor('output_tokens', 'bearer x')).toBe('[REDACTED]');
  });

  it('still masks numbers under token-ish keys that are NOT allow-listed', () => {
    // Exact allow-list, not a suffix or pattern.
    expect(attributeValueFor('auth_token', 12345)).toBe('[REDACTED]');
    expect(attributeValueFor('refresh_token_count', 3)).toBe('[REDACTED]');
  });
});

describe('buildSafeAttributes', () => {
  it('classifies every key and drops null/undefined (no reserved-key skip)', () => {
    const attrs = buildSafeAttributes({
      tool_name: 'read_memory',
      iteration: 3,
      user_message: 'free text that must not leak',
      missing: undefined,
      empty: null,
      event: 'some_event', // allow-listed → raw (NOT skipped, unlike buildLogAttributes)
    });
    expect(attrs.tool_name).toBe('read_memory');
    expect(attrs.iteration).toBe(3);
    expect(attrs.user_message).toBe('string(28)');
    expect(attrs).not.toHaveProperty('missing');
    expect(attrs).not.toHaveProperty('empty');
    expect(attrs.event).toBe('some_event');
  });

  it('never egresses free-text content under an unexpected key', () => {
    const attrs = buildSafeAttributes({
      response: 'Here is the full translated passage the user asked about...',
      description: 'a free-form description that could carry content',
    });
    expect(attrs.response).toMatch(/^string\(\d+\)$/);
    expect(attrs.description).toMatch(/^string\(\d+\)$/);
  });
});
