import { describe, it, expect } from 'vitest';
import { redactArgsForError, sanitizeArgsForLog } from '../../src/utils/logger.js';

describe('sanitizeArgsForLog — allow-listed keys', () => {
  it('keeps real values for allow-listed diagnostic arguments', () => {
    const args = { reference: 'John 3:16', language: 'es-419', book: 'JHN', limit: 5, all: true };
    expect(sanitizeArgsForLog(args)).toEqual(args);
  });

  it('matches allow-listed keys across snake_case, camelCase and kebab-case', () => {
    expect(
      sanitizeArgsForLog({ start_chapter: '3', startVerse: '16', 'language-code': 'bn' })
    ).toEqual({ start_chapter: '3', startVerse: '16', 'language-code': 'bn' });
  });
});

describe('sanitizeArgsForLog — fail-closed for other keys', () => {
  it('summarizes user content under ordinary-looking keys', () => {
    expect(
      sanitizeArgsForLog({
        query: 'my husband left me, what does the Bible say about divorce',
        text: 'Please pray for my sister Maria in Dhaka',
        payload: { message: 'full user message here', language: 'bn' },
      })
    ).toEqual({
      query: 'string(57)',
      text: 'string(40)',
      payload: { message: 'string(22)', language: 'bn' },
    });
  });

  it('summarizes credentials embedded under non-sensitive keys', () => {
    const url = 'https://bucket.example.com/obj?X-Amz-Signature=abc123&X-Amz-Credential=AKIA';
    const out = sanitizeArgsForLog({ url, headers: { 'x-custom': 'Bearer sk-live-xyz' } });
    expect(out).toEqual({ url: `string(${url.length})`, headers: { 'x-custom': 'string(18)' } });
    expect(JSON.stringify(out)).not.toMatch(/abc123|AKIA|sk-live/);
  });

  it('summarizes array items unless the array sits under an allow-listed key', () => {
    expect(
      sanitizeArgsForLog({ references: ['Gen 1:1', 'Rom 8:28'], messages: ['hello there'] })
    ).toEqual({ references: ['Gen 1:1', 'Rom 8:28'], messages: ['string(11)'] });
  });
});

describe('sanitizeArgsForLog — masking, truncation, JSON safety', () => {
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

  it('truncates allow-listed strings over 100 chars and notes the original length', () => {
    const out = sanitizeArgsForLog({ reference: 'a'.repeat(250), books: ['b'.repeat(101)] }) as {
      reference: string;
      books: string[];
    };
    expect(out.reference).toBe(`${'a'.repeat(100)} [truncated, 250 chars]`);
    expect(out.books[0]).toBe(`${'b'.repeat(100)} [truncated, 101 chars]`);
  });

  it('summarizes a bare non-object argument', () => {
    expect(sanitizeArgsForLog('raw user text')).toBe('string(13)');
  });

  it('returns a JSON-safe copy', () => {
    const out = sanitizeArgsForLog({ big: BigInt(7), fn: () => 1, missing: undefined });
    expect(JSON.parse(JSON.stringify(out))).toEqual({
      big: '[bigint]',
      fn: '[function]',
      missing: null,
    });
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
