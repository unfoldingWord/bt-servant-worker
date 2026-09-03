/**
 * Worker-emitted UI strings (issue #405).
 *
 * These are the few non-LLM strings the worker writes straight into the chat:
 * SSE status lines, the queue notice, voice pipeline status, the
 * max-iterations notice, and the generic "processing failed" fallback. They
 * are keyed off the user's `response_language` (ISO 639-1, e.g. `en`, `pt`).
 *
 * Adding a language is one table entry set: add `xx` below with every key of
 * `en` (the `satisfies` clause enforces parity at compile time and
 * `tests/unit/ui-strings.test.ts` enforces non-empty, non-copied values).
 *
 * This module is a leaf: it must not import from services or durable
 * objects (`src/types/engine.ts` imports its types, so anything heavier
 * would be a cycle).
 */

const en = {
  status_queued: 'Queued — processing will begin shortly',
  status_processing: 'Processing your request...',
  status_preparing: 'Preparing your response...',
  status_executing_tools: 'Executing {n} tool(s)...',
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
} as const;

/** Brazilian Portuguese. */
const pt = {
  status_queued: 'Na fila — o processamento começará em breve',
  status_processing: 'Processando sua solicitação...',
  status_preparing: 'Preparando sua resposta...',
  status_executing_tools: 'Executando {n} ferramenta(s)...',
  status_transcribing: 'Transcrevendo o áudio...',
  status_tts_generating: 'Gerando resposta em áudio...',
  status_tts_still_generating: 'Ainda gerando o áudio...',
  notice_max_iterations:
    '\n\n⚠️ Cheguei ao meu limite de quantas etapas posso executar em uma única resposta ' +
    'enquanto trabalhava nisso. O que está acima é o que consegui concluir; parte disso ' +
    'pode estar incompleta. Se quiser que eu continue, envie uma mensagem de acompanhamento ' +
    'dizendo no que devo focar (por exemplo, "apenas envie o PDF padrão" ou "tente mais uma ' +
    'vez com X"), e eu retomarei daqui sem refazer as partes que já funcionaram.',
  error_processing_failed: 'Falha no processamento',
} as const satisfies Record<keyof typeof en, string>;

/** Every worker-emitted UI string key. */
export type UiStringKey = keyof typeof en;

/**
 * Closed set of keys that may appear on a `status` event. Clients branch on
 * this (e.g. extend an inactivity timeout while TTS runs) instead of
 * pattern-matching the localized `message`.
 */
export type StatusKey = Extract<UiStringKey, `status_${string}`>;

/** A status update as carried by SSE and the callback transport. */
export interface StatusUpdate {
  key: StatusKey;
  message: string;
}

/** Locale → table. Keys are ISO 639-1 primary subtags, lower-case. */
export const UI_STRINGS: Readonly<Record<'en' | 'pt', Readonly<Record<UiStringKey, string>>>> = {
  en,
  pt,
};

/** Locales that have a table of their own; anything else falls back to `en`. */
export const SUPPORTED_UI_LOCALES: readonly string[] = Object.keys(UI_STRINGS);

/** The `StatusKey` union at runtime, for contract tests and validation. */
export const STATUS_KEYS: readonly StatusKey[] = (Object.keys(en) as UiStringKey[]).filter(
  (k): k is StatusKey => k.startsWith('status_')
);

export type UiStringParams = Readonly<Record<string, string | number>>;

/**
 * Map-backed view of the tables for lookups by a runtime string. Built once;
 * avoids dynamic property access on plain objects (keys come from user
 * preferences, so `table[locale]` would be an injection sink).
 */
const TABLES: ReadonlyMap<string, ReadonlyMap<string, string>> = new Map(
  Object.entries(UI_STRINGS).map(([locale, table]) => [locale, new Map(Object.entries(table))])
);
const EN_TABLE = TABLES.get('en')!;

/**
 * Map a `response_language` value to a supported table locale.
 * `pt-BR` → `pt`, `PT` → `pt`, unknown / missing → `en`.
 */
export function resolveUiLocale(locale: string | null | undefined): keyof typeof UI_STRINGS {
  const primary = (locale ?? '').trim().toLowerCase().split(/[-_]/)[0] ?? '';
  return TABLES.has(primary) ? (primary as keyof typeof UI_STRINGS) : 'en';
}

/**
 * Look up a worker-emitted UI string for `locale`, interpolating `{name}`
 * placeholders from `params`. Unsupported locales fall back to English.
 *
 * `key` is closed at the type level; the runtime fallback of returning the
 * key itself exists only so a mismatched caller can never crash a turn or
 * emit `undefined` into the chat.
 */
export function uiString(
  locale: string | null | undefined,
  key: UiStringKey,
  params?: UiStringParams
): string {
  const table = TABLES.get(resolveUiLocale(locale)) ?? EN_TABLE;
  let text = table.get(key) ?? EN_TABLE.get(key) ?? key;
  for (const [name, value] of Object.entries(params ?? {})) {
    text = text.replaceAll(`{${name}}`, String(value));
  }
  return text;
}

/** Build the `{ key, message }` pair every status event carries. */
export function statusUpdate(
  locale: string | null | undefined,
  key: StatusKey,
  params?: UiStringParams
): StatusUpdate {
  return { key, message: uiString(locale, key, params) };
}
