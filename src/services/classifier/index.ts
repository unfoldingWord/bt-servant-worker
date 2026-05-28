/**
 * Deterministic trigger classifier for #<mode> and @<language> tokens at the
 * head of a user message.
 *
 * Synchronous, no network call. For each leading `#word` / `@word` token, the
 * matcher runs a three-tier cascade against the configured slug list:
 *
 *   1. exact (case-insensitive) → e.g. `#fia-coach`
 *   2. unique prefix → e.g. `#mast` → `mast-methodology`
 *   3. unique Levenshtein ≤ 2 strict winner → e.g. `#spokne` → `spoken`
 *
 * Tokens that fail all three tiers are recorded as `unmatchedTriggers` along
 * with the full available-options list, so the orchestrator can compose a
 * contextual "did you mean…" reply via its system prompt. Both matched and
 * unmatched tokens are stripped from the head of the message before it reaches
 * the orchestrator.
 *
 * Head-of-message scope only — once the scan encounters a non-trigger word,
 * matching stops (matches #199 / issue #211).
 */

// ─── Public types ────────────────────────────────────────────────────────────

export type TriggerKind = 'mode' | 'language';

export interface AvailableOption {
  name: string;
  label?: string | undefined;
}

export interface UnmatchedTrigger {
  kind: TriggerKind;
  /** Raw token text WITHOUT the leading `#` / `@` sigil */
  rawToken: string;
  /** Full configured option list for this kind, for the disambiguation reply */
  availableOptions: AvailableOption[];
}

export interface ClassifierResult {
  /** Resolved mode name (slug), or undefined if no #mode token matched */
  modeName: string | undefined;
  /** Resolved language name (slug), or undefined if no @language token matched */
  languageName: string | undefined;
  /** User message with all leading trigger tokens stripped (matched or not) */
  strippedMessage: string;
  /** Triggers that could not be resolved; surfaced to the orchestrator for disambiguation */
  unmatchedTriggers: UnmatchedTrigger[];
  /**
   * True when the user typed a reserved clear-mode hashtag (e.g. `#default`,
   * `#none`, `#clear`). Mutually exclusive with `modeName` for the same token.
   */
  clearMode: boolean;
  /**
   * True when the user typed a reserved clear-language `@`-token (e.g.
   * `@default`, `@none`, `@clear`). Mutually exclusive with `languageName`
   * for the same token. Orthogonal to `clearMode`: `#default` clears mode
   * only, `@default` clears language only, and `#default @default` clears
   * both.
   */
  clearLanguage: boolean;
}

/**
 * Reserved tokens that signal "clear" rather than activating a named
 * mode/language. Applied to BOTH `#` and `@` sigils so the token's sigil
 * decides which slot is cleared. Recognised before the matching cascade so
 * they cannot be shadowed by a published mode or language named
 * `default`/`none`/`clear`.
 */
const CLEAR_TOKENS: ReadonlySet<string> = new Set(['default', 'none', 'clear']);

export interface ClassifierContext {
  availableModes: AvailableOption[];
  availableLanguages: AvailableOption[];
}

// ─── Tokenisation ────────────────────────────────────────────────────────────

interface ParsedToken {
  sigil: '#' | '@';
  /** Raw token text without the sigil */
  raw: string;
}

/**
 * Pull leading `#word` / `@word` tokens off the message head.
 *
 * Returns the tokens (in order) and the remainder of the message with the
 * tokens stripped and leading whitespace trimmed. Stops at the first
 * non-sigil-prefixed word — head-of-message scope only.
 *
 * Tolerates a single `,` / `:` / `;` separator (and any following whitespace)
 * between consecutive tokens, so `@bot, #spoken-mode` and `@bot: #spoken-mode`
 * still resolve `#spoken-mode`. Telegram autocomplete commonly inserts a
 * comma after a bot mention. Period (`.`) is intentionally NOT tolerated to
 * avoid restructuring email-like fragments.
 */
function extractLeadingTokens(message: string): { tokens: ParsedToken[]; stripped: string } {
  const tokens: ParsedToken[] = [];
  let remaining = message.trimStart();

  while (remaining.length > 0) {
    const ch = remaining[0];
    if (ch !== '#' && ch !== '@') break;

    const spaceIdx = remaining.search(/\s/);
    const tokenText = spaceIdx === -1 ? remaining : remaining.slice(0, spaceIdx);
    const raw = tokenText.slice(1);

    // `#` or `@` alone (no following word chars) is not a trigger — bail out
    // without consuming it, leaving it in the stripped message.
    if (raw.length === 0) break;

    tokens.push({ sigil: ch, raw });
    remaining = spaceIdx === -1 ? '' : remaining.slice(spaceIdx).trimStart();
    // Only strip the separator when ANOTHER trigger follows it. Without the
    // lookahead, ordinary content like `@bot , please help` would silently
    // lose the comma — violating the classifier's preserve-unmatched-content
    // policy.
    remaining = remaining.replace(/^[,;:]\s*(?=[#@])/, '');
  }

  return { tokens, stripped: remaining };
}

// ─── Matching cascade ────────────────────────────────────────────────────────

interface LevenshteinRowParams {
  prev: number[];
  curr: number[];
  a: string;
  b: string;
  i: number;
}

/**
 * One DP row step: fills `curr[1..b.length]` from `prev[]`. Returns the
 * minimum value in the new row (callers use it for early-exit when min
 * exceeds the bound).
 */
function fillLevenshteinRow(p: LevenshteinRowParams): number {
  const { prev, curr, a, b, i } = p;
  const bLen = b.length;
  curr[0] = i;
  let rowMin = i;
  for (let j = 1; j <= bLen; j++) {
    const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
    const del = (prev[j] as number) + 1;
    const ins = (curr[j - 1] as number) + 1;
    const sub = (prev[j - 1] as number) + cost;
    const v = Math.min(del, ins, sub);
    curr[j] = v;
    if (v < rowMin) rowMin = v;
  }
  return rowMin;
}

/**
 * Edit distance with an upper bound. Returns `maxDistance + 1` as a sentinel
 * whenever the distance exceeds the bound; callers use `<= maxDistance` to
 * test acceptance.
 */
function boundedLevenshtein(a: string, b: string, maxDistance: number): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > maxDistance) return maxDistance + 1;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  const bLen = b.length;
  let prev: number[] = new Array<number>(bLen + 1).fill(0);
  let curr: number[] = new Array<number>(bLen + 1).fill(0);
  for (let j = 0; j <= bLen; j++) prev[j] = j;

  for (let i = 1; i <= a.length; i++) {
    const rowMin = fillLevenshteinRow({ prev, curr, a, b, i });
    if (rowMin > maxDistance) return maxDistance + 1;
    [prev, curr] = [curr, prev];
  }
  return prev[bLen] as number;
}

const LEVENSHTEIN_MAX = 2;

/** Tier 1: case-insensitive exact match. */
function tryExactMatch(lower: string, options: AvailableOption[]): string | null {
  for (const opt of options) {
    if (opt.name.toLowerCase() === lower) return opt.name;
  }
  return null;
}

/** Tier 2: unique prefix winner. */
function tryPrefixMatch(lower: string, options: AvailableOption[]): string | null {
  const hits = options.filter((opt) => opt.name.toLowerCase().startsWith(lower));
  return hits.length === 1 ? (hits[0] as AvailableOption).name : null;
}

/** Tier 3: Levenshtein ≤ LEVENSHTEIN_MAX with a strict unique winner. */
function tryFuzzyMatch(lower: string, options: AvailableOption[]): string | null {
  let best: { name: string; distance: number } | null = null;
  let tied = false;
  for (const opt of options) {
    const d = boundedLevenshtein(lower, opt.name.toLowerCase(), LEVENSHTEIN_MAX);
    if (d > LEVENSHTEIN_MAX) continue;
    if (best === null || d < best.distance) {
      best = { name: opt.name, distance: d };
      tied = false;
    } else if (d === best.distance) {
      tied = true;
    }
  }
  return best !== null && !tied ? best.name : null;
}

/**
 * Match a raw token against the configured options using the cascade:
 * exact → unique prefix → unique Levenshtein ≤ 2.
 */
function matchToken(raw: string, options: AvailableOption[]): string | null {
  if (options.length === 0) return null;
  const lower = raw.toLowerCase();
  return (
    tryExactMatch(lower, options) ?? tryPrefixMatch(lower, options) ?? tryFuzzyMatch(lower, options)
  );
}

// ─── Main classifier ─────────────────────────────────────────────────────────

/**
 * Parse `#<mode>` and `@<language>` triggers from the head of a user message.
 *
 * Synchronous, deterministic, allocation-light. The vast majority of messages
 * (no leading `#`/`@`) short-circuit through `extractLeadingTokens` with no
 * matching work.
 *
 * Stripping policy: only tokens that resolve to a configured mode/language
 * are removed from the message. Tokens that fail the cascade are LEFT IN
 * PLACE in `strippedMessage` because most leading `#`/`@` in the wild are
 * coincidental — email handles (`@gmail.com`), social hashtags (`#hashtag`),
 * addressee mentions (`@team`/`@john`), list markers (`#1`) — not failed
 * routing attempts. Stripping them would silently delete real user content
 * before the orchestrator ever sees it. The orchestrator still receives the
 * unmatched tokens via the `unmatchedTriggers` system-prompt section so it
 * can choose to acknowledge them when the user clearly was trying to route.
 */
type TokenOutcome =
  | { kind: 'clear'; sigil: '#' | '@' }
  | { kind: 'matched'; sigil: '#' | '@'; name: string }
  | { kind: 'unmatched'; trigger: UnmatchedTrigger; tokenText: string };

/** Classify a single leading token. Pure: no shared state. */
function classifyToken(token: ParsedToken, ctx: ClassifierContext): TokenOutcome {
  const isMode = token.sigil === '#';
  const options = isMode ? ctx.availableModes : ctx.availableLanguages;
  if (CLEAR_TOKENS.has(token.raw.toLowerCase())) {
    return { kind: 'clear', sigil: token.sigil };
  }
  const matched = matchToken(token.raw, options);
  if (matched !== null) {
    return { kind: 'matched', sigil: token.sigil, name: matched };
  }
  const triggerKind: TriggerKind = isMode ? 'mode' : 'language';
  return {
    kind: 'unmatched',
    trigger: { kind: triggerKind, rawToken: token.raw, availableOptions: options },
    tokenText: `${token.sigil}${token.raw}`,
  };
}

export function classifyTriggers(messageText: string, ctx: ClassifierContext): ClassifierResult {
  const { tokens, stripped: postTokens } = extractLeadingTokens(messageText);

  if (tokens.length === 0) {
    return {
      modeName: undefined,
      languageName: undefined,
      strippedMessage: messageText,
      unmatchedTriggers: [],
      clearMode: false,
      clearLanguage: false,
    };
  }

  let modeName: string | undefined;
  let languageName: string | undefined;
  let clearMode = false;
  let clearLanguage = false;
  const unmatchedTriggers: UnmatchedTrigger[] = [];
  const unmatchedTokenTexts: string[] = [];

  for (const token of tokens) {
    const outcome = classifyToken(token, ctx);
    if (outcome.kind === 'clear') {
      if (outcome.sigil === '#') clearMode = true;
      else clearLanguage = true;
    } else if (outcome.kind === 'matched') {
      if (outcome.sigil === '#') modeName = outcome.name;
      else languageName = outcome.name;
    } else {
      unmatchedTriggers.push(outcome.trigger);
      unmatchedTokenTexts.push(outcome.tokenText);
    }
  }

  const strippedMessage =
    unmatchedTokenTexts.length === 0
      ? postTokens
      : `${unmatchedTokenTexts.join(' ')}${postTokens.length > 0 ? ' ' + postTokens : ''}`;

  return {
    modeName,
    languageName,
    strippedMessage,
    unmatchedTriggers,
    clearMode,
    clearLanguage,
  };
}
