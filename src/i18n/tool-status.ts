/**
 * Status lines for a tool the worker is about to call (#28).
 *
 * The label is chosen from the tool name, never from model text. A short
 * Bible or OBS `reference` argument may be included when the book is one the
 * worker already recognizes. Anything else in the arguments is ignored. One
 * turn says each label at most once, and waits about two seconds between
 * labels. A label held back by that gap is kept until the gap ends.
 */

import { isKnownBibleBook, isKnownBookCode } from '../utils/bible-books.js';
import { uiString, type StatusKey, type UiStringKey } from './ui-strings.js';

/** Minimum gap between two tool-progress statuses in one turn. */
export const TOOL_STATUS_MIN_INTERVAL_MS = 2_000;

const ELLIPSIS = '…';
const MAX_REFERENCE_LENGTH = 40;
const MAX_SERVER_NAME = 80;
const NUMBER = /^\d{1,3}$/;
const NUMBER_RANGE = /^\d{1,3}[-–]\d{1,3}$/;
const UNSAFE_REFERENCE_CHAR = /[\\/<>{}[\]()"'`$%@!?;|&*#+=~,]/;
/**
 * Same characters a reference rejects, stripped from an operator-configured
 * server name. Global, so each use resets `lastIndex` before replacing.
 */
const UNSAFE_SERVER_CHAR = /[\\/<>{}[\]()"'`$%@!?;|&*#+=~,]/g;

export interface ToolCallSnapshot {
  name: string;
  /** First argument when it is a plain object. Other shapes are ignored. */
  args: unknown;
  /** Display name from the MCP server config. Absent when the tool has no server. */
  serverName?: string | undefined;
}

export type ToolStatusDecision =
  | { kind: 'emit'; key: StatusKey; message: string }
  | { kind: 'skip'; reason: 'duplicate' | 'interval' }
  | { kind: 'fallback'; count: number };

/** A label the interval held back. `sendAt` does not move if a later call replaces it. */
export interface PendingToolStatus {
  key: StatusKey;
  message: string;
  sendAt: number;
}

export interface ToolStatusGate {
  decide(calls: readonly ToolCallSnapshot[], locale: string, now: number): ToolStatusDecision;
  /** An `execute_code` block that called no host tool. */
  noteIdle(now: number): ToolStatusDecision;
  /** The label waiting for the interval, if one is. */
  pending(): PendingToolStatus | null;
  /**
   * Say the held label when `now` has reached its time. Null when nothing is
   * waiting or the time has not come. Does not postpone the label.
   */
  flushPending(now: number): ToolStatusDecision | null;
  /** Drop a held label without saying it. The turn ended, or the caller cancelled. */
  cancelPending(): void;
}

interface ActivitySpec {
  readonly key: StatusKey;
  readonly verb: UiStringKey;
  readonly clause: UiStringKey;
  /** A reference replaces the object ("Reading John 3:16") instead of being appended. */
  readonly referenceReplaces?: boolean;
}

interface RenderedClause {
  readonly key: StatusKey;
  readonly verb: string;
  readonly text: string;
}

interface GateState {
  labels: Set<string>;
  lastAt: number;
  pending?: PendingToolStatus | undefined;
}

const ACTIVITY_ENTRIES: readonly (readonly [string, ActivitySpec])[] = [
  ['get_word_article', spec('status_lookup_words', 'tool_verb_lookup', 'tool_clause_words')],
  ['get_academy_article', spec('status_read_academy', 'tool_verb_read', 'tool_clause_academy')],
  ['get_passage', passageSpec()],
  ['get_passage_context', passageSpec()],
  ['get_note', spec('status_check_notes', 'tool_verb_check', 'tool_clause_notes')],
  ['get_notes', spec('status_check_notes', 'tool_verb_check', 'tool_clause_notes')],
  ['get_passage_index', spec('status_check_notes', 'tool_verb_check', 'tool_clause_notes')],
  ['get_questions', spec('status_check_questions', 'tool_verb_check', 'tool_clause_questions')],
  ['search_articles', spec('status_search_resources', 'tool_verb_search', 'tool_clause_search')],
  ['search', spec('status_search_resources', 'tool_verb_search', 'tool_clause_search')],
  ['get_obs_story', obsSpec()],
  ['get_obs_notes', obsSpec()],
  ['get_obs_index', obsSpec()],
  ['get_obs_questions', obsSpec()],
  ['get_obs_study_notes', obsSpec()],
  ['get_obs_study_questions', obsSpec()],
  [
    'fetch_obs_study_manual',
    spec('status_read_obs_manual', 'tool_verb_read', 'tool_clause_obs_manual'),
  ],
];

const TOOL_ACTIVITIES: ReadonlyMap<string, ActivitySpec> = new Map(ACTIVITY_ENTRIES);
const KNOWN_TOOLS = [...TOOL_ACTIVITIES.keys()].sort((a, b) => b.length - a.length);

function spec(key: StatusKey, verb: UiStringKey, clause: UiStringKey): ActivitySpec {
  return { key, verb, clause };
}

function passageSpec(): ActivitySpec {
  return {
    ...spec('status_read_passage', 'tool_verb_read', 'tool_clause_passage'),
    referenceReplaces: true,
  };
}

function obsSpec(): ActivitySpec {
  return {
    ...spec('status_read_obs', 'tool_verb_read', 'tool_clause_obs'),
    referenceReplaces: true,
  };
}

/** The `reference` argument when it is a short Bible or OBS reference; otherwise null. */
export function referenceFromArgs(args: unknown): string | null {
  if (!isRecord(args) || !Object.hasOwn(args, 'reference')) return null;
  return safeReference(args.reference);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeReference(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim().replace(/\s+/g, ' ');
  if (!isShortCleanReference(text)) return null;
  if (isObsReference(text) || isIntroReference(text) || isBibleReference(text)) return text;
  return null;
}

function isShortCleanReference(text: string): boolean {
  return (
    text.length > 0 &&
    text.length <= MAX_REFERENCE_LENGTH &&
    !hasControlChar(text) &&
    !UNSAFE_REFERENCE_CHAR.test(text)
  );
}

function hasControlChar(text: string): boolean {
  for (const char of text) {
    const code = char.charCodeAt(0);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

function isObsReference(text: string): boolean {
  const tokens = text.split(' ');
  if (tokens.length === 1) return isStoryFrame(tokens[0] ?? '');
  if (tokens.length !== 2 || !/^obs$/i.test(tokens[0] ?? '')) return false;
  const rest = tokens[1] ?? '';
  return NUMBER.test(rest) || isStoryFrame(rest);
}

function isStoryFrame(token: string): boolean {
  const [story, frame] = token.split(':');
  if (!story || frame === undefined || !NUMBER.test(story)) return false;
  return NUMBER.test(frame) || NUMBER_RANGE.test(frame);
}

function isIntroReference(text: string): boolean {
  const parts = splitBookTail(text);
  return parts !== null && /^\d{1,3}:intro$/i.test(parts.tail) && isKnownBibleBook(parts.book);
}

function isBibleReference(text: string): boolean {
  if (isKnownBookCode(text)) return true;
  const parts = splitBookTail(text);
  return parts !== null && isChapterToken(parts.tail) && isKnownBibleBook(parts.book);
}

function splitBookTail(text: string): { book: string; tail: string } | null {
  const tokens = text.split(' ');
  if (tokens.length < 2 || tokens.length > 4) return null;
  const tail = tokens[tokens.length - 1];
  if (!tail) return null;
  return { book: tokens.slice(0, -1).join(' '), tail };
}

function isChapterToken(token: string): boolean {
  const [chapter, verse] = token.split(':');
  if (!chapter || !NUMBER.test(chapter)) return false;
  if (verse === undefined) return true;
  return NUMBER.test(verse) || NUMBER_RANGE.test(verse);
}

function displayServerName(name: string | undefined): string | null {
  if (!name) return null;
  const cleaned = stripUnsafeServerChars(replaceControls(name)).replace(/\s+/g, ' ').trim();
  if (!cleaned) return null;
  return cleaned.length > MAX_SERVER_NAME ? cleaned.slice(0, MAX_SERVER_NAME).trim() : cleaned;
}

function stripUnsafeServerChars(text: string): string {
  UNSAFE_SERVER_CHAR.lastIndex = 0;
  return text.replace(UNSAFE_SERVER_CHAR, ' ');
}

function replaceControls(text: string): string {
  let out = '';
  for (const char of text) {
    const code = char.charCodeAt(0);
    out += code <= 31 || code === 127 ? ' ' : char;
  }
  return out;
}

function stripThPrefix(name: string): string {
  if (name.startsWith('th_')) return name.slice(3);
  const at = name.indexOf('_th_');
  return at === -1 ? name : name.slice(at + 4);
}

function knownToolName(name: string): string | undefined {
  if (TOOL_ACTIVITIES.has(name)) return name;
  return KNOWN_TOOLS.find((tool) => name.endsWith(`_${tool}`));
}

function canonicalToolName(raw: string): string {
  const stripped = stripThPrefix(raw);
  return knownToolName(stripped) ?? knownToolName(raw) ?? stripped;
}

function renderActivity(
  activity: ActivitySpec,
  reference: string | null,
  locale: string
): RenderedClause {
  const verb = uiString(locale, activity.verb);
  if (reference && activity.referenceReplaces) {
    return {
      key: activity.key,
      verb,
      text: uiString(locale, 'tool_clause_reference', { reference }),
    };
  }
  const base = uiString(locale, activity.clause);
  return { key: activity.key, verb, text: withReference(base, reference, locale) };
}

function renderServer(server: string, reference: string | null, locale: string): RenderedClause {
  const base = uiString(locale, 'tool_clause_server', { server });
  return {
    key: 'status_check_server',
    verb: uiString(locale, 'tool_verb_check'),
    text: withReference(base, reference, locale),
  };
}

function withReference(text: string, reference: string | null, locale: string): string {
  if (!reference) return text;
  return uiString(locale, 'tool_for', { text, reference });
}

function clauseForCall(call: ToolCallSnapshot, locale: string): RenderedClause | null {
  const reference = referenceFromArgs(call.args);
  const activity = TOOL_ACTIVITIES.get(canonicalToolName(call.name));
  if (activity) return renderActivity(activity, reference, locale);
  const server = displayServerName(call.serverName);
  return server ? renderServer(server, reference, locale) : null;
}

function planBatch(
  calls: readonly ToolCallSnapshot[],
  locale: string
): { key: StatusKey; message: string } | null {
  const clauses = calls
    .map((call) => clauseForCall(call, locale))
    .filter((clause): clause is RenderedClause => clause !== null);
  if (clauses.length === 0) return null;
  return combineClauses(dedupeClauses(clauses), locale);
}

function dedupeClauses(clauses: readonly RenderedClause[]): RenderedClause[] {
  const seen = new Set<string>();
  const unique: RenderedClause[] = [];
  for (const clause of clauses) {
    if (seen.has(clause.text)) continue;
    seen.add(clause.text);
    unique.push(clause);
  }
  return unique;
}

function combineClauses(
  clauses: readonly RenderedClause[],
  locale: string
): { key: StatusKey; message: string } {
  const first = clauses[0];
  if (!first || clauses.length === 1) {
    return { key: first?.key ?? 'status_combined_tools', message: `${first?.text ?? ''}…` };
  }
  const key = clauses.every((clause) => clause.key === first.key)
    ? first.key
    : 'status_combined_tools';
  return { key, message: `${joinClauses(clauses, locale)}${ELLIPSIS}` };
}

function joinClauses(clauses: readonly RenderedClause[], locale: string): string {
  const and = uiString(locale, 'tool_and');
  const verb = clauses[0]?.verb ?? '';
  if (sharesVerb(clauses, verb)) {
    const objects = clauses.map((clause) => clause.text.slice(verb.length + 1));
    return `${verb} ${objects.join(` ${and} `)}`;
  }
  return clauses
    .map((clause, index) => (index === 0 ? clause.text : lowerFirst(clause.text)))
    .join(` ${and} `);
}

function sharesVerb(clauses: readonly RenderedClause[], verb: string): boolean {
  if (!verb) return false;
  const prefix = `${verb} `;
  return clauses.every((clause) => clause.verb === verb && clause.text.startsWith(prefix));
}

function lowerFirst(text: string): string {
  const first = text.charAt(0);
  return first.toLocaleLowerCase() + text.slice(1);
}

function admit(
  state: GateState,
  label: string,
  now: number,
  intervalMs: number
): 'ok' | 'duplicate' | 'interval' {
  if (state.labels.has(label)) return 'duplicate';
  if (now - state.lastAt < intervalMs) return 'interval';
  state.labels.add(label);
  state.lastAt = now;
  state.pending = undefined;
  return 'ok';
}

/** Keep the newest unsaid label. The release time stays the one already scheduled. */
function holdPending(
  state: GateState,
  planned: { key: StatusKey; message: string },
  intervalMs: number
): void {
  const sendAt = state.pending?.sendAt ?? state.lastAt + intervalMs;
  state.pending = { key: planned.key, message: planned.message, sendAt };
}

function admitFallback(
  state: GateState,
  count: number,
  now: number,
  intervalMs: number
): ToolStatusDecision {
  const admission = admit(state, 'status_executing_tools', now, intervalMs);
  if (admission !== 'ok') return { kind: 'skip', reason: admission };
  return { kind: 'fallback', count };
}

function decideBatch(
  state: GateState,
  calls: readonly ToolCallSnapshot[],
  locale: string,
  now: number,
  intervalMs: number
): ToolStatusDecision {
  if (calls.length === 0) return { kind: 'skip', reason: 'duplicate' };
  const planned = planBatch(calls, locale);
  if (!planned) return admitFallback(state, calls.length, now, intervalMs);
  const admission = admit(state, planned.message, now, intervalMs);
  if (admission === 'interval') {
    holdPending(state, planned, intervalMs);
    return { kind: 'skip', reason: admission };
  }
  if (admission !== 'ok') return { kind: 'skip', reason: admission };
  return { kind: 'emit', key: planned.key, message: planned.message };
}

function releasePending(
  state: GateState,
  now: number,
  intervalMs: number
): ToolStatusDecision | null {
  const pending = state.pending;
  if (!pending || now < pending.sendAt) return null;
  state.pending = undefined;
  const admission = admit(state, pending.message, now, intervalMs);
  if (admission !== 'ok') return { kind: 'skip', reason: admission };
  return { kind: 'emit', key: pending.key, message: pending.message };
}

/** One gate per turn. `now` is injectable so tests do not wait. */
export function createToolStatusGate(intervalMs = TOOL_STATUS_MIN_INTERVAL_MS): ToolStatusGate {
  const state: GateState = { labels: new Set<string>(), lastAt: Number.NEGATIVE_INFINITY };
  return {
    decide(calls, locale, now) {
      return decideBatch(state, calls, locale, now, intervalMs);
    },
    noteIdle(now) {
      return admitFallback(state, 1, now, intervalMs);
    },
    pending() {
      return state.pending ?? null;
    },
    flushPending(now) {
      return releasePending(state, now, intervalMs);
    },
    cancelPending() {
      state.pending = undefined;
    },
  };
}
