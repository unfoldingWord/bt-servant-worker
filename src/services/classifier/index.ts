/**
 * Deterministic trigger token extractor for #<mode> and @<language> syntax.
 *
 * Scans the head of a user message for `#slug` and `@slug` tokens and matches
 * them against available modes/languages by exact case-insensitive slug match.
 * No LLM call — pure string matching. Tokens are stripped from the message
 * before it reaches the orchestrator.
 */

// ─── Public types ────────────────────────────────────────────────────────────

export interface ClassifierResult {
  /** Resolved mode name (slug), or undefined if no #mode token found */
  modeName: string | undefined;
  /** Resolved language name (slug), or undefined if no @language token found */
  languageName: string | undefined;
  /** User message with trigger tokens stripped from the head */
  strippedMessage: string;
  /** Soft warnings for unrecognized tokens */
  warnings: string[];
}

export interface ClassifierContext {
  availableModes: Array<{ name: string }>;
  availableLanguages: Array<{ name: string }>;
}

// ─── Token extraction ───────────────────────────────────────────────────────

/**
 * A trigger token parsed from the message head.
 * `prefix` is '#' or '@', `slug` is the word after the prefix.
 */
interface ParsedToken {
  prefix: '#' | '@';
  slug: string;
  /** Full raw text including prefix, e.g. "#spoken" */
  raw: string;
}

/**
 * Extract trigger tokens from the very start of a message.
 * Tokens must appear before any natural-language text. Each token is
 * a `#word` or `@word` separated by whitespace. Extraction stops at the
 * first word that doesn't start with `#` or `@`.
 */
function extractLeadingTokens(message: string): { tokens: ParsedToken[]; rest: string } {
  const tokens: ParsedToken[] = [];
  let remaining = message.trimStart();

  while (remaining.length > 0) {
    const ch = remaining[0];
    if (ch !== '#' && ch !== '@') break;

    // Find the end of this token (next whitespace or end of string)
    const spaceIdx = remaining.search(/\s/);
    const tokenText = spaceIdx === -1 ? remaining : remaining.slice(0, spaceIdx);

    // Must have at least one character after the prefix
    if (tokenText.length <= 1) break;

    tokens.push({
      prefix: ch as '#' | '@',
      slug: tokenText.slice(1),
      raw: tokenText,
    });

    remaining = spaceIdx === -1 ? '' : remaining.slice(spaceIdx).trimStart();
  }

  return { tokens, rest: remaining };
}

// ─── Matching ───────────────────────────────────────────────────────────────

function matchSlug(slug: string, available: Array<{ name: string }>): string | undefined {
  const lower = slug.toLowerCase();
  const found = available.find((item) => item.name.toLowerCase() === lower);
  return found?.name;
}

// ─── Main function ──────────────────────────────────────────────────────────

/**
 * Extract `#<mode>` and `@<language>` trigger tokens from the head of a
 * user message. Matches against available modes/languages by exact
 * case-insensitive slug comparison. Returns the stripped message and any
 * warnings for unrecognized tokens.
 */
export function classifyTriggers(messageText: string, ctx: ClassifierContext): ClassifierResult {
  const { tokens, rest } = extractLeadingTokens(messageText);

  if (tokens.length === 0) {
    return {
      modeName: undefined,
      languageName: undefined,
      strippedMessage: messageText,
      warnings: [],
    };
  }

  let modeName: string | undefined;
  let languageName: string | undefined;
  const warnings: string[] = [];

  for (const token of tokens) {
    if (token.prefix === '#' && modeName === undefined) {
      const matched = matchSlug(token.slug, ctx.availableModes);
      if (matched) {
        modeName = matched;
      } else {
        warnings.push(`Mode '${token.raw}' was not recognized. Using your default mode.`);
      }
    } else if (token.prefix === '@' && languageName === undefined) {
      const matched = matchSlug(token.slug, ctx.availableLanguages);
      if (matched) {
        languageName = matched;
      } else {
        warnings.push(`Language '${token.raw}' was not recognized. No language guidance applied.`);
      }
    }
  }

  return {
    modeName,
    languageName,
    strippedMessage: rest || messageText,
    warnings,
  };
}
