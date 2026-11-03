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
  /** What the worker is looking up, built from the tool name (#28). */
  status_lookup_words: 'Looking up Translation Words…',
  status_read_academy: 'Reading Translation Academy…',
  status_read_passage: 'Reading the passage…',
  status_check_notes: 'Checking the translation notes…',
  status_check_questions: 'Checking the translation questions…',
  status_search_resources: 'Searching the resources…',
  status_read_obs: 'Reading Open Bible Stories…',
  status_read_obs_manual: 'Reading the OBS study manual…',
  status_check_server: 'Checking {{server}}…',
  status_combined_tools: 'Checking several resources…',
  /** Clauses the tool-status planner joins. Not emitted as keys themselves. */
  tool_verb_lookup: 'Looking up',
  tool_verb_read: 'Reading',
  tool_verb_check: 'Checking',
  tool_verb_search: 'Searching',
  tool_clause_words: 'Looking up Translation Words',
  tool_clause_academy: 'Reading Translation Academy',
  tool_clause_passage: 'Reading the passage',
  tool_clause_reference: 'Reading {{reference}}',
  tool_clause_notes: 'Checking the translation notes',
  tool_clause_questions: 'Checking the translation questions',
  tool_clause_search: 'Searching the resources',
  tool_clause_obs: 'Reading Open Bible Stories',
  tool_clause_obs_manual: 'Reading the OBS study manual',
  tool_clause_server: 'Checking {{server}}',
  tool_for: '{{text}} for {{reference}}',
  tool_and: 'and',
  /**
   * Shown when the orchestration loop exits because it hit
   * MAX_ORCHESTRATION_ITERATIONS. Streamed via `onProgress` AND persisted in
   * history, so on a voice turn it is also what TTS reads aloud. Leading blank
   * lines separate it from the answer above it. On a text turn that answer is
   * the no-tools recovery, not the unfinished round's narration (#421).
   */
  notice_max_iterations:
    "\n\n⚠️ I've reached my limit on how many steps I can take in a single turn while " +
    'working on this. The work above is what I got done; some of it may be incomplete. ' +
    "If you'd like me to keep going, send me a follow-up telling me what to focus on " +
    '(e.g. "just submit the standard PDF" or "try once more with X"), and I\'ll pick ' +
    'up from here without re-doing the parts that already worked.',
  error_processing_failed: 'Processing failed',
  /**
   * Shown when a text turn ends with no user-facing text and a no-tools
   * recovery call also produced none (#158). Not the max-iterations notice:
   * that one is for a loop that ran out of steps with work still in progress.
   */
  notice_empty_answer: "Sorry, I couldn't finish an answer just now. Please try again.",
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
  status_lookup_words: 'Buscando em Translation Words…',
  status_read_academy: 'Lendo a Translation Academy…',
  status_read_passage: 'Lendo a passagem…',
  status_check_notes: 'Verificando as notas de tradução…',
  status_check_questions: 'Verificando as perguntas de tradução…',
  status_search_resources: 'Pesquisando os recursos…',
  status_read_obs: 'Lendo Open Bible Stories…',
  status_read_obs_manual: 'Lendo o manual de estudo do OBS…',
  status_check_server: 'Verificando {{server}}…',
  status_combined_tools: 'Verificando vários recursos…',
  tool_verb_lookup: 'Buscando em',
  tool_verb_read: 'Lendo',
  tool_verb_check: 'Verificando',
  tool_verb_search: 'Pesquisando',
  tool_clause_words: 'Buscando em Translation Words',
  tool_clause_academy: 'Lendo a Translation Academy',
  tool_clause_passage: 'Lendo a passagem',
  tool_clause_reference: 'Lendo {{reference}}',
  tool_clause_notes: 'Verificando as notas de tradução',
  tool_clause_questions: 'Verificando as perguntas de tradução',
  tool_clause_search: 'Pesquisando os recursos',
  tool_clause_obs: 'Lendo Open Bible Stories',
  tool_clause_obs_manual: 'Lendo o manual de estudo do OBS',
  tool_clause_server: 'Verificando {{server}}',
  tool_for: '{{text}} para {{reference}}',
  tool_and: 'e',
  notice_max_iterations:
    '\n\n⚠️ Atingi o limite de etapas que consigo executar em um único turno. ' +
    'O que está acima é o que consegui fazer; pode estar incompleta. ' +
    'Se quiser que eu continue, envie uma nova mensagem dizendo no que devo ' +
    'focar (por exemplo, "apenas envie o PDF padrão" ou "tente mais uma vez com X"), e ' +
    'eu retomo daqui sem refazer o que já funcionou.',
  error_processing_failed: 'Falha no processamento',
  notice_empty_answer:
    'Desculpe, não consegui concluir uma resposta agora. Tente de novo, por favor.',
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
  'status_lookup_words',
  'status_read_academy',
  'status_read_passage',
  'status_check_notes',
  'status_check_questions',
  'status_search_resources',
  'status_read_obs',
  'status_read_obs_manual',
  'status_check_server',
  'status_combined_tools',
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
