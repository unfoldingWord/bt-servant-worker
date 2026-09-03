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
 * or copies the English fails here. English literals are pinned in full so
 * the wording clients display (and TTS reads aloud) cannot drift.
 */

import { describe, it, expect } from 'vitest';
import {
  STATUS_KEYS,
  UI_STRINGS,
  statusUpdate,
  uiString,
  type UiStringKey,
  type UiStringValue,
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

/** Every textual form a table value can take (plain string, or plural pair). */
function forms(value: UiStringValue): string[] {
  return typeof value === 'string' ? [value] : [value.one, value.other];
}

const EN_NOTICE_MAX_ITERATIONS =
  "\n\n⚠️ I've reached my limit on how many steps I can take in a single turn while " +
  'working on this. The work above is what I got done; some of it may be incomplete. ' +
  "If you'd like me to keep going, send me a follow-up telling me what to focus on " +
  '(e.g. "just submit the standard PDF" or "try once more with X"), and I\'ll pick ' +
  'up from here without re-doing the parts that already worked.';

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

  it('no locale has an empty form', () => {
    for (const [locale, table] of Object.entries(UI_STRINGS)) {
      for (const [key, value] of Object.entries(table)) {
        for (const form of forms(value)) {
          expect(form.trim().length, `${locale}.${key}`).toBeGreaterThan(0);
        }
      }
    }
  });

  it('no pt form is identical to an en form (untranslated copy)', () => {
    const pt = new Map(Object.entries(UI_STRINGS.pt));
    for (const [key, enValue] of Object.entries(UI_STRINGS.en)) {
      for (const ptForm of forms(pt.get(key)!)) {
        expect(forms(enValue), key).not.toContain(ptForm);
      }
    }
  });

  it('STATUS_KEYS is exactly the status_-prefixed subset of the table', () => {
    const fromTable = Object.keys(UI_STRINGS.en)
      .filter((key) => key.startsWith('status_'))
      .sort();
    expect([...STATUS_KEYS].sort()).toEqual(fromTable);
  });
});

describe('ui-strings literals', () => {
  it('en values are the legacy literals the clients already display', () => {
    // Pinning these keeps the English behaviour byte-identical to the
    // pre-#405 worker for clients that have not yet adopted `key`.
    expect(UI_STRINGS.en.status_queued).toBe('Queued — processing will begin shortly');
    expect(UI_STRINGS.en.status_processing).toBe('Processing your request...');
    expect(UI_STRINGS.en.status_preparing).toBe('Preparing your response...');
    expect(UI_STRINGS.en.status_executing_tools).toBe('Executing {{n}} tool(s)...');
    expect(UI_STRINGS.en.status_transcribing).toBe('Transcribing audio...');
    expect(UI_STRINGS.en.status_tts_generating).toBe('Generating audio response...');
    expect(UI_STRINGS.en.status_tts_still_generating).toBe('Still generating audio...');
    expect(UI_STRINGS.en.error_processing_failed).toBe('Processing failed');
    expect(UI_STRINGS.en.notice_max_iterations).toBe(EN_NOTICE_MAX_ITERATIONS);
  });

  it('pt max-iterations notice is the owner-reviewed paragraph (native BR-PT)', () => {
    // Wording fixed by the repo owner in review; pinned so "turno" and the
    // second sentence cannot regress. Same "\n\n⚠️ " prefix as English.
    expect(UI_STRINGS.pt.notice_max_iterations).toBe(
      '\n\n⚠️ Atingi o limite de etapas que consigo executar em um único turno. ' +
        'O que está acima é o que consegui fazer; pode estar incompleta. ' +
        'Se quiser que eu continue, envie uma nova mensagem dizendo no que devo focar ' +
        '(por exemplo, "apenas envie o PDF padrão" ou "tente mais uma vez com X"), e eu ' +
        'retomo daqui sem refazer o que já funcionou.'
    );
  });

  it('every {{placeholder}} in en also appears in every pt form', () => {
    const pt = new Map(Object.entries(UI_STRINGS.pt));
    for (const [key, enValue] of Object.entries(UI_STRINGS.en)) {
      for (const enForm of forms(enValue)) {
        const placeholders = enForm.match(/\{\{[a-z_]+\}\}/g) ?? [];
        for (const placeholder of placeholders) {
          for (const ptForm of forms(pt.get(key)!)) {
            expect(ptForm, `${key} missing ${placeholder}`).toContain(placeholder);
          }
        }
      }
    }
  });
});

describe('uiString', () => {
  it('interpolates {{n}} and picks the pt plural form by count', () => {
    expect(uiString('pt', 'status_executing_tools', { n: 1 })).toBe('Executando 1 ferramenta...');
    expect(uiString('pt', 'status_executing_tools', { n: 2 })).toBe('Executando 2 ferramentas...');
  });

  it('keeps the single English "tool(s)" form for any count', () => {
    expect(uiString('en', 'status_executing_tools', { n: 1 })).toBe('Executing 1 tool(s)...');
    expect(uiString('en', 'status_executing_tools', { n: 3 })).toBe('Executing 3 tool(s)...');
  });

  it('selects the pt table for pt', () => {
    expect(uiString('pt', 'status_processing')).toBe(UI_STRINGS.pt.status_processing);
  });

  it.each(['xx', 'sw', undefined, null, ''])('falls back to English for locale %j', (locale) => {
    expect(uiString(locale, 'status_processing')).toBe(UI_STRINGS.en.status_processing);
  });

  it.each(['pt-BR', 'PT', ' pt_br '])('normalizes %j to the pt table', (locale) => {
    expect(uiString(locale, 'status_processing')).toBe(UI_STRINGS.pt.status_processing);
  });

  it('rejects an unknown key at the type level, and never throws at runtime', () => {
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
});
