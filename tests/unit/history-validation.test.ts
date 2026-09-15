/**
 * Unit tests for the client-supplied history validator + sanitizer (#392).
 *
 * `validateClientHistory` returns the exact 400 message the worker route and
 * UserDO both surface; `sanitizeClientHistory` must whitelist fields so a
 * client can never write R2 keys / speaker / attachments into stored history.
 */

import { describe, it, expect } from 'vitest';
import {
  MAX_CLIENT_HISTORY_BYTES,
  MAX_CLIENT_HISTORY_FIELD_CHARS,
  hasClientHistory,
  resolveEntryTimestamp,
  sanitizeClientHistory,
  validateClientHistory,
} from '../../src/utils/history-validation.js';
import type { ClientHistoryEntry } from '../../src/types/engine.js';

const turn = (i = 0): ClientHistoryEntry => ({
  user_message: `q${i}`,
  assistant_response: `a${i}`,
});

describe('hasClientHistory', () => {
  it('is true for an array, including an empty one', () => {
    expect(hasClientHistory({ history: [] })).toBe(true);
    expect(hasClientHistory({ history: [turn()] })).toBe(true);
  });

  it('is false when absent or null', () => {
    expect(hasClientHistory({})).toBe(false);
    expect(hasClientHistory({ history: null as unknown as undefined })).toBe(false);
  });
});

describe('validateClientHistory — shape', () => {
  it('accepts absent, null, an empty array, and a well-formed thread', () => {
    expect(validateClientHistory(undefined)).toBeNull();
    expect(validateClientHistory(null)).toBeNull();
    expect(validateClientHistory([])).toBeNull();
    expect(validateClientHistory([turn(0), turn(1)])).toBeNull();
  });

  it('rejects a non-array', () => {
    expect(validateClientHistory('nope')).toBe(
      'history must be an array of { user_message, assistant_response } entries'
    );
    expect(validateClientHistory({ user_message: 'x' })).toBe(
      'history must be an array of { user_message, assistant_response } entries'
    );
  });

  it('rejects a non-object entry and names its index', () => {
    expect(validateClientHistory([turn(), 'x'])).toBe('history[1] must be an object');
    expect(validateClientHistory([null])).toBe('history[0] must be an object');
    expect(validateClientHistory([[]])).toBe('history[0] must be an object');
  });
});

describe('validateClientHistory — text fields', () => {
  it('requires a non-empty user_message', () => {
    expect(validateClientHistory([{ assistant_response: 'a' }])).toBe(
      'history[0].user_message is required and must be non-empty'
    );
    expect(validateClientHistory([{ user_message: '   ', assistant_response: 'a' }])).toBe(
      'history[0].user_message is required and must be non-empty'
    );
    expect(validateClientHistory([{ user_message: 42, assistant_response: 'a' }])).toBe(
      'history[0].user_message is required and must be non-empty'
    );
  });

  it('requires a non-empty assistant_response (checked after user_message)', () => {
    expect(validateClientHistory([turn(), { user_message: 'q', assistant_response: '' }])).toBe(
      'history[1].assistant_response is required and must be non-empty'
    );
  });

  it('caps each text field at MAX_CLIENT_HISTORY_FIELD_CHARS', () => {
    const atCap = 'x'.repeat(MAX_CLIENT_HISTORY_FIELD_CHARS);
    const overCap = `${atCap}x`;
    expect(validateClientHistory([{ user_message: atCap, assistant_response: atCap }])).toBeNull();
    expect(validateClientHistory([{ user_message: overCap, assistant_response: 'a' }])).toBe(
      `history[0].user_message exceeds ${MAX_CLIENT_HISTORY_FIELD_CHARS} characters`
    );
    expect(validateClientHistory([{ user_message: 'q', assistant_response: overCap }])).toBe(
      `history[0].assistant_response exceeds ${MAX_CLIENT_HISTORY_FIELD_CHARS} characters`
    );
  });
});

describe('validateClientHistory — time fields', () => {
  it('accepts absent, null, a finite timestamp, and a parseable created_at', () => {
    expect(validateClientHistory([{ ...turn(), timestamp: null, created_at: null }])).toBeNull();
    expect(validateClientHistory([{ ...turn(), timestamp: 1757800000000 }])).toBeNull();
    expect(
      validateClientHistory([{ ...turn(), created_at: '2026-09-13T21:46:40.000Z' }])
    ).toBeNull();
  });

  it('rejects a non-numeric or non-finite timestamp', () => {
    expect(validateClientHistory([{ ...turn(), timestamp: '1757800000000' }])).toBe(
      'history[0].timestamp must be a number (milliseconds since epoch)'
    );
    expect(validateClientHistory([{ ...turn(), timestamp: Number.NaN }])).toBe(
      'history[0].timestamp must be a number (milliseconds since epoch)'
    );
  });

  it('rejects an unparseable created_at', () => {
    expect(validateClientHistory([{ ...turn(), created_at: 'yesterday' }])).toBe(
      'history[0].created_at must be an ISO 8601 date string'
    );
    expect(validateClientHistory([{ ...turn(), created_at: 1757800000000 }])).toBe(
      'history[0].created_at must be an ISO 8601 date string'
    );
  });
});

describe('validateClientHistory — byte cap', () => {
  it('rejects a serialized thread over MAX_CLIENT_HISTORY_BYTES before per-entry checks', () => {
    // Each entry is under the per-field cap, so only the byte cap can fire.
    const big = 'x'.repeat(MAX_CLIENT_HISTORY_FIELD_CHARS);
    const entries = Array.from({ length: 40 }, () => ({
      user_message: big,
      assistant_response: big,
    }));
    expect(new TextEncoder().encode(JSON.stringify(entries)).byteLength).toBeGreaterThan(
      MAX_CLIENT_HISTORY_BYTES
    );
    // A malformed trailing entry must NOT be what gets reported — the cap wins.
    expect(validateClientHistory([...entries, { user_message: '' }])).toBe(
      `history exceeds ${MAX_CLIENT_HISTORY_BYTES} bytes`
    );
  });

  it('counts multi-byte characters by their UTF-8 size', () => {
    // 'é' is 2 bytes in UTF-8, so a 1-char-per-byte estimate would under-count.
    const entries = [
      { user_message: 'é'.repeat(MAX_CLIENT_HISTORY_FIELD_CHARS), assistant_response: 'a' },
    ];
    const bytes = new TextEncoder().encode(JSON.stringify(entries)).byteLength;
    expect(bytes).toBeGreaterThan(MAX_CLIENT_HISTORY_FIELD_CHARS);
    expect(validateClientHistory(entries)).toBeNull();
  });
});

describe('resolveEntryTimestamp', () => {
  const now = 1_700_000_000_000;

  it('prefers timestamp over created_at', () => {
    const entry = { ...turn(), timestamp: 5, created_at: '2026-09-13T21:46:40.000Z' };
    expect(resolveEntryTimestamp(entry, now)).toBe(5);
  });

  it('parses created_at when timestamp is absent', () => {
    const entry = { ...turn(), created_at: '2026-09-13T21:46:40.000Z' };
    expect(resolveEntryTimestamp(entry, now)).toBe(Date.parse('2026-09-13T21:46:40.000Z'));
  });

  it('defaults to now when neither is usable', () => {
    expect(resolveEntryTimestamp(turn(), now)).toBe(now);
    expect(resolveEntryTimestamp({ ...turn(), created_at: null }, now)).toBe(now);
  });
});

describe('sanitizeClientHistory', () => {
  it('whitelists fields — R2 keys, speaker, attachments and derived URLs are dropped', () => {
    const hostile = {
      user_message: 'q',
      assistant_response: 'a',
      timestamp: 7,
      voice_audio_key: 'audio/other-org/victim/x.opus',
      inbound_voice_audio_key: 'voice-submissions/other-org/victim/y.ogg',
      voice_audio_url: 'https://evil.example/x',
      inbound_voice_audio_url: 'https://evil.example/y',
      speaker: 'Mallory',
      attachments: [
        { type: 'audio', url: 'https://evil.example/z', r2_key: 'k', mime_type: 'audio/ogg' },
      ],
      created_at: '2026-09-13T21:46:40.000Z',
    } as unknown as ClientHistoryEntry;

    const [entry] = sanitizeClientHistory([hostile], 1);
    expect(entry).toEqual({ user_message: 'q', assistant_response: 'a', timestamp: 7 });
    expect(Object.keys(entry ?? {})).toEqual(['user_message', 'assistant_response', 'timestamp']);
  });

  it('preserves order and resolves each entry timestamp independently', () => {
    const out = sanitizeClientHistory(
      [
        turn(0),
        { ...turn(1), timestamp: 3 },
        { ...turn(2), created_at: '1970-01-01T00:00:02.000Z' },
      ],
      99
    );
    expect(out.map((e) => e.user_message)).toEqual(['q0', 'q1', 'q2']);
    expect(out.map((e) => e.timestamp)).toEqual([99, 3, 2000]);
  });

  it('returns an empty array for an empty thread', () => {
    expect(sanitizeClientHistory([], 1)).toEqual([]);
  });
});
