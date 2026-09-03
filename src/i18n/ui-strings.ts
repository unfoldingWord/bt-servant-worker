/**
 * Worker-emitted UI strings (issue #405).
 *
 * These are the few non-LLM strings the worker writes straight into the chat:
 * SSE status lines, the queue notice, voice pipeline status, the
 * max-iterations notice, and the generic "processing failed" fallback. They
 * are keyed off the user's `response_language` (ISO 639-1, e.g. `en`, `pt`).
 *
 * Adding a language is one table entry set: add `xx` to `UI_STRINGS` with
 * every key of `en` (`satisfies` enforces parity at compile time;
 * `tests/unit/ui-strings.test.ts` enforces non-empty, non-copied values).
 *
 * Placeholders use the `{{name}}` syntax of `utils/template.ts`. A value may
 * also be a plural pair `{ one, other }`, selected by `params.n` through
 * `Intl.PluralRules` — English keeps its single "tool(s)" form.
 *
 * Import discipline: `src/types/engine.ts` imports types from here, so this
 * module must stay free of services / durable-objects imports.
 */

import { replaceTemplateVariables } from '../utils/template.js';

/** A string with one form for a count of one and another for everything else. */
export interface PluralForms {
  readonly one: string;
  readonly other: string;
}

export type UiStringValue = string | PluralForms;

const en = {
  status_queued: 'Queued — processing will begin shortly',
  status_processing: 'Processing your request...',
  status_preparing: 'Preparing your response...',
  status_executing_tools: 'Executing {{n}} tool(s)...',
  status_transcribing: 'Transcribing audio...',
  status_tts_generating: 'Generating audio response...',
  status_tts_still_generating: 'Still generating audio...',
  /**
   * Shown when the orchestration loop exits because it hit
   * MAX_ORCHESTRATION_ITERATIONS. Streamed via `onProgress` AND persisted in
   * history, so it is also what TTS reads aloud. Leading blank lines separate
   * it from whatever partial text the last iteration produced.
   */
  notice_max_iterations:
    "\n\n⚠️ I've reached my limit on how many steps I can take in a single turn while " +
    'working on this. The work above is what I got done; some of it may be incomplete. ' +
    "If you'd like me to keep going, send me a follow-up telling me what to focus on " +
    '(e.g. "just submit the standard PDF" or "try once more with X"), and I\'ll pick ' +
    'up from here without re-doing the parts that already worked.',
  error_processing_failed: 'Processing failed',
} as const satisfies Record<string, UiStringValue>;

/** Every worker-emitted UI string key. */
export type UiStringKey = keyof typeof en;

/** Brazilian Portuguese. */
const pt = {
  status_queued: 'Na fila — o processamento começará em breve',
  status_processing: 'Processando sua solicitação...',
  status_preparing: 'Preparando sua resposta...',
  status_executing_tools: {
    one: 'Executando {{n}} ferramenta...',
    other: 'Executando {{n}} ferramentas...',
  },
  status_transcribing: 'Transcrevendo o áudio...',
  status_tts_generating: 'Gerando resposta em áudio...',
  status_tts_still_generating: 'Ainda gerando o áudio...',
  notice_max_iterations:
    '\n\n⚠️ Atingi o limite de etapas que consigo executar em uma única rodada enquanto ' +
    'trabalhava nisso. O que está acima é o que consegui fazer; parte pode estar ' +
    'incompleta. Se quiser que eu continue, envie uma nova mensagem dizendo no que devo ' +
    'focar (por exemplo, "apenas envie o PDF padrão" ou "tente mais uma vez com X"), e ' +
    'eu retomo daqui sem refazer o que já funcionou.',
  error_processing_failed: 'Falha no processamento',
} as const satisfies Record<UiStringKey, UiStringValue>;

/** Locale → table. Keys are ISO 639-1 primary subtags, lower-case. */
export const UI_STRINGS = { en, pt } as const;

type UiLocale = keyof typeof UI_STRINGS;

/**
 * Closed set of keys that may appear on a `status` event. Clients branch on
 * this (e.g. extend an inactivity timeout while TTS runs) instead of
 * pattern-matching the localized `message`.
 */
export const STATUS_KEYS = [
  'status_queued',
  'status_processing',
  'status_preparing',
  'status_executing_tools',
  'status_transcribing',
  'status_tts_generating',
  'status_tts_still_generating',
] as const satisfies readonly UiStringKey[];

export type StatusKey = (typeof STATUS_KEYS)[number];

/** A status update as carried by SSE and the callback transport. */
export interface StatusUpdate {
  key: StatusKey;
  message: string;
}

export type UiStringParams = Readonly<Record<string, string | number>>;

/**
 * Map a `response_language` value to a table locale: `pt-BR` → `pt`,
 * `PT` → `pt`, unknown / missing → `en`. Ingress validation already enforces
 * two-letter ISO 639-1 codes; the normalization here is belt-and-braces.
 */
function resolveUiLocale(locale: string | null | undefined): UiLocale {
  const primary = (locale ?? '').trim().toLowerCase().split(/[-_]/)[0] ?? '';
  return Object.hasOwn(UI_STRINGS, primary) ? (primary as UiLocale) : 'en';
}

/** Pick the plural form for `params.n` (CLDR rules for `locale`); strings pass through. */
function selectForm(value: UiStringValue, locale: UiLocale, params?: UiStringParams): string {
  if (typeof value === 'string') return value;
  return new Intl.PluralRules(locale).select(Number(params?.n)) === 'one' ? value.one : value.other;
}

/**
 * Look up a worker-emitted UI string for `locale`, interpolating `{{name}}`
 * placeholders from `params`. Unsupported locales fall back to English.
 *
 * `key` is closed at the type level; the `?? key` last resort exists only so
 * a mismatched caller can never crash a turn or emit `undefined` into the chat.
 */
export function uiString(
  locale: string | null | undefined,
  key: UiStringKey,
  params?: UiStringParams
): string {
  const tableLocale = resolveUiLocale(locale);
  const table: Readonly<Record<UiStringKey, UiStringValue>> = UI_STRINGS[tableLocale];
  const text = selectForm(table[key] ?? key, tableLocale, params);
  return params ? replaceTemplateVariables(text, params) : text;
}

/** Build the `{ key, message }` pair every status event carries. */
export function statusUpdate(
  locale: string | null | undefined,
  key: StatusKey,
  params?: UiStringParams
): StatusUpdate {
  return { key, message: uiString(locale, key, params) };
}
