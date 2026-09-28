import { describe, it, expect } from 'vitest';
import { redactArgsForError, sanitizeArgsForLog } from '../../src/utils/logger.js';

describe('sanitizeArgsForLog', () => {
  it('keeps real values for ordinary tool arguments', () => {
    const args = { reference: 'John 3:16', language: 'es-419', book: 'JHN', limit: 5, all: true };
    expect(sanitizeArgsForLog(args)).toEqual(args);
  });

  it('redacts credential and phone keys, including nested ones', () => {
    expect(
      sanitizeArgsForLog({
        api_key: 'sk-1',
        Authorization: 'Bearer x',
        password: 'p',
        cookie: 'c',
        access_token: 't',
        phone_number: '+15551234567',
        nested: { userPhone: '+1', reference: 'Gen 1:1' },
      })
    ).toEqual({
      api_key: '[REDACTED]',
      Authorization: '[REDACTED]',
      password: '[REDACTED]',
      cookie: '[REDACTED]',
      access_token: '[REDACTED]',
      phone_number: '[REDACTED]',
      nested: { userPhone: '[REDACTED]', reference: 'Gen 1:1' },
    });
  });

  it('truncates strings over 500 chars and notes the original length', () => {
    const out = sanitizeArgsForLog({ query: 'a'.repeat(1200), items: ['b'.repeat(501)] }) as {
      query: string;
      items: string[];
    };
    expect(out.query).toBe(`${'a'.repeat(500)} [truncated, 1200 chars]`);
    expect(out.items[0]).toBe(`${'b'.repeat(500)} [truncated, 501 chars]`);
  });

  it('returns a JSON-safe copy', () => {
    const out = sanitizeArgsForLog({ big: BigInt(7), fn: () => 1, missing: undefined });
    expect(JSON.parse(JSON.stringify(out))).toEqual({ big: '7', fn: '[function]', missing: null });
  });
});

describe('redactArgsForError', () => {
  it('also masks phone keys', () => {
    expect(redactArgsForError({ phone: '+1', book: 'MAT' })).toEqual({
      phone: '[REDACTED]',
      book: 'MAT',
    });
  });
});
