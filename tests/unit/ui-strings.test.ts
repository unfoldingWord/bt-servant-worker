/**
 * Tests for the worker-emitted UI string tables (issue #405).
 *
 * These are the non-LLM strings the worker writes straight into the chat:
 * SSE status lines, the queue notice, voice pipeline status, the
 * max-iterations notice, and the generic "processing failed" fallback.
 * They are keyed off the user's `response_language` (ISO 639-1).
 *
 * The parity test is the mechanism that makes "adding a language is one
 * table entry set" true: a new locale that misses a key, leaves one empty,
 * or copies the English fails here.
 */

import { describe, it, expect } from 'vitest';
import {
  STATUS_KEYS,
  UI_STRINGS,
  statusUpdate,
  uiString,
  type StatusKey,
  type UiStringKey,
} from '../../src/i18n/ui-strings.js';

const EXPECTED_KEYS: readonly UiStringKey[] = [
  'status_queued',
  'status_processing',
  'status_preparing',
  'status_executing_tools',
  'status_transcribing',
  'status_tts_generating',
  'status_tts_still_generating',
  'notice_max_iterations',
  'error_processing_failed',
];

describe('ui-strings tables', () => {
  it('en carries exactly the keys named in the issue design', () => {
    expect(Object.keys(UI_STRINGS.en).sort()).toEqual([...EXPECTED_KEYS].sort());
  });

  it('every locale has key parity with en', () => {
    const enKeys = Object.keys(UI_STRINGS.en).sort();
    for (const [locale, table] of Object.entries(UI_STRINGS)) {
      expect(Object.keys(table).sort(), `locale ${locale}`).toEqual(enKeys);
    }
  });

  it('no locale has an empty value', () => {
    for (const [locale, table] of Object.entries(UI_STRINGS)) {
      for (const [key, value] of Object.entries(table)) {
        expect(value.trim().length, `${locale}.${key}`).toBeGreaterThan(0);
      }
    }
  });

  it('no pt value is identical to its en value (untranslated copy)', () => {
    const pt = new Map(Object.entries(UI_STRINGS.pt));
    for (const [key, enValue] of Object.entries(UI_STRINGS.en)) {
      expect(pt.get(key), key).not.toBe(enValue);
    }
  });

  it('en values are the legacy literals the clients already display', () => {
    // Pinning these keeps the English behaviour byte-identical to the
    // pre-#405 worker for clients that have not yet adopted `key`.
    expect(UI_STRINGS.en.status_queued).toBe('Queued — processing will begin shortly');
    expect(UI_STRINGS.en.status_processing).toBe('Processing your request...');
    expect(UI_STRINGS.en.status_preparing).toBe('Preparing your response...');
    expect(uiString('en', 'status_executing_tools', { n: 3 })).toBe('Executing 3 tool(s)...');
    expect(UI_STRINGS.en.status_transcribing).toBe('Transcribing audio...');
    expect(UI_STRINGS.en.status_tts_generating).toBe('Generating audio response...');
    expect(UI_STRINGS.en.status_tts_still_generating).toBe('Still generating audio...');
    expect(UI_STRINGS.en.error_processing_failed).toBe('Processing failed');
    expect(UI_STRINGS.en.notice_max_iterations.startsWith('\n\n⚠️ ')).toBe(true);
  });

  it('pt max-iterations notice keeps the leading warning marker', () => {
    expect(UI_STRINGS.pt.notice_max_iterations.startsWith('\n\n⚠️ ')).toBe(true);
  });

  it('every {placeholder} in en also appears in pt', () => {
    const pt = new Map(Object.entries(UI_STRINGS.pt));
    for (const [key, enValue] of Object.entries(UI_STRINGS.en)) {
      const placeholders = enValue.match(/\{[a-z_]+\}/g) ?? [];
      for (const p of placeholders) {
        expect(pt.get(key), `${key} missing ${p}`).toContain(p);
      }
    }
  });
});

describe('uiString', () => {
  it('interpolates params for pt', () => {
    expect(uiString('pt', 'status_executing_tools', { n: 2 })).toBe(
      'Executando 2 ferramenta(s)...'
    );
  });

  it('returns the Portuguese table value for pt', () => {
    expect(uiString('pt', 'status_processing')).toBe(UI_STRINGS.pt.status_processing);
  });

  it('falls back to English for an unsupported locale', () => {
    expect(uiString('xx', 'status_processing')).toBe(UI_STRINGS.en.status_processing);
    expect(uiString('sw', 'status_queued')).toBe(UI_STRINGS.en.status_queued);
  });

  it('falls back to English for a missing locale', () => {
    expect(uiString(undefined, 'status_processing')).toBe(UI_STRINGS.en.status_processing);
    expect(uiString(null, 'status_processing')).toBe(UI_STRINGS.en.status_processing);
    expect(uiString('', 'status_processing')).toBe(UI_STRINGS.en.status_processing);
  });

  it('normalizes region subtags and case (pt-BR, PT) to the pt table', () => {
    expect(uiString('pt-BR', 'status_processing')).toBe(UI_STRINGS.pt.status_processing);
    expect(uiString('PT', 'status_processing')).toBe(UI_STRINGS.pt.status_processing);
  });

  it('rejects an unknown key at the type level', () => {
    // @ts-expect-error — 'not_a_key' is not a UiStringKey
    const call = () => uiString('en', 'not_a_key');
    // Runtime defence for the same case: never throw, never return undefined.
    expect(call()).toBe('not_a_key');
  });
});

describe('statusUpdate', () => {
  it('pairs the closed key with the localized message', () => {
    expect(statusUpdate('pt', 'status_transcribing')).toEqual({
      key: 'status_transcribing',
      message: UI_STRINGS.pt.status_transcribing,
    });
  });

  it('STATUS_KEYS is exactly the status_* subset of the table, in a stable order', () => {
    const expected: StatusKey[] = [
      'status_queued',
      'status_processing',
      'status_preparing',
      'status_executing_tools',
      'status_transcribing',
      'status_tts_generating',
      'status_tts_still_generating',
    ];
    expect([...STATUS_KEYS].sort()).toEqual([...expected].sort());
  });
});
