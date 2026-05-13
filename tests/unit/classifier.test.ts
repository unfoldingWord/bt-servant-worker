import { describe, it, expect } from 'vitest';
import {
  classifyTriggers,
  ClassifierContext,
  AvailableOption,
} from '../../src/services/classifier/index.js';

// ─── Fixtures ───────────────────────────────────────────────────────────────

const modes: AvailableOption[] = [
  { name: 'spoken', label: 'Spoken' },
  { name: 'mast-methodology', label: 'MAST Methodology' },
  { name: 'translation-coach', label: 'Translation Coach' },
  { name: 'fia-coach', label: 'FIA Coach' },
];

const languages: AvailableOption[] = [
  { name: 'english', label: 'English' },
  { name: 'spanish', label: 'Spanish' },
  { name: 'french', label: 'French' },
];

function buildCtx(overrides?: Partial<ClassifierContext>): ClassifierContext {
  return {
    availableModes: modes,
    availableLanguages: languages,
    ...overrides,
  };
}

// ─── No-trigger passthrough ─────────────────────────────────────────────────

describe('classifyTriggers — no triggers in message', () => {
  it('returns message unchanged when no leading # or @', () => {
    const result = classifyTriggers('How do I translate Genesis 1:1?', buildCtx());
    expect(result).toEqual({
      modeName: undefined,
      languageName: undefined,
      strippedMessage: 'How do I translate Genesis 1:1?',
      unmatchedTriggers: [],
      clearMode: false,
    });
  });

  it('does not match # or @ that appear mid-message (head-of-message scope)', () => {
    const result = classifyTriggers('Tell me about #spoken and @english.', buildCtx());
    expect(result.modeName).toBeUndefined();
    expect(result.languageName).toBeUndefined();
    expect(result.strippedMessage).toBe('Tell me about #spoken and @english.');
    expect(result.unmatchedTriggers).toEqual([]);
  });

  it('treats a bare `#` or `@` as not a trigger', () => {
    const result = classifyTriggers('#', buildCtx());
    expect(result.strippedMessage).toBe('#');
    expect(result.unmatchedTriggers).toEqual([]);
  });
});

// ─── Tier 1: exact match ────────────────────────────────────────────────────

describe('classifyTriggers — exact match', () => {
  it('matches #fia-coach exactly', () => {
    const result = classifyTriggers('#fia-coach hello there', buildCtx());
    expect(result.modeName).toBe('fia-coach');
    expect(result.languageName).toBeUndefined();
    expect(result.strippedMessage).toBe('hello there');
    expect(result.unmatchedTriggers).toEqual([]);
  });

  it('matches @spanish exactly (no spurious "null" warning)', () => {
    const result = classifyTriggers('@spanish ¿cómo estás?', buildCtx());
    expect(result.languageName).toBe('spanish');
    expect(result.modeName).toBeUndefined();
    expect(result.strippedMessage).toBe('¿cómo estás?');
    expect(result.unmatchedTriggers).toEqual([]);
  });

  it('is case-insensitive on exact match', () => {
    const result = classifyTriggers('@SPANISH hola', buildCtx());
    expect(result.languageName).toBe('spanish');
    expect(result.strippedMessage).toBe('hola');
  });

  it('matches both #mode and @language at the head, in either order', () => {
    const a = classifyTriggers('#fia-coach @english hi', buildCtx());
    expect(a.modeName).toBe('fia-coach');
    expect(a.languageName).toBe('english');
    expect(a.strippedMessage).toBe('hi');

    const b = classifyTriggers('@english #fia-coach hi', buildCtx());
    expect(b.modeName).toBe('fia-coach');
    expect(b.languageName).toBe('english');
    expect(b.strippedMessage).toBe('hi');
    expect(b.unmatchedTriggers).toEqual([]);
  });
});

// ─── Tier 2: unique prefix ──────────────────────────────────────────────────

describe('classifyTriggers — unique prefix match', () => {
  it('matches #mast → mast-methodology when only one option starts with "mast"', () => {
    const result = classifyTriggers('#mast tell me more', buildCtx());
    expect(result.modeName).toBe('mast-methodology');
    expect(result.strippedMessage).toBe('tell me more');
    expect(result.unmatchedTriggers).toEqual([]);
  });

  it('matches #fia → fia-coach', () => {
    const result = classifyTriggers('#fia hello', buildCtx());
    expect(result.modeName).toBe('fia-coach');
  });

  it('matches #trans → translation-coach (single prefix winner)', () => {
    const result = classifyTriggers('#trans hi', buildCtx());
    expect(result.modeName).toBe('translation-coach');
  });

  it('does NOT prefix-match when multiple options share the prefix', () => {
    const ctx = buildCtx({
      availableModes: [
        { name: 'translation-coach' },
        { name: 'translation-help' },
        { name: 'spoken' },
      ],
    });
    const result = classifyTriggers('#trans hi', ctx);
    expect(result.modeName).toBeUndefined();
    expect(result.unmatchedTriggers).toHaveLength(1);
    expect(result.unmatchedTriggers[0]).toMatchObject({ kind: 'mode', rawToken: 'trans' });
    // Unmatched tokens stay in place — they may be coincidental content.
    expect(result.strippedMessage).toBe('#trans hi');
  });
});

// ─── Tier 3: Levenshtein ────────────────────────────────────────────────────

describe('classifyTriggers — Levenshtein fuzzy match', () => {
  it('matches #spokne → spoken (transposition, distance 2)', () => {
    const result = classifyTriggers('#spokne ok', buildCtx());
    expect(result.modeName).toBe('spoken');
    expect(result.strippedMessage).toBe('ok');
  });

  it('matches @englsh → english (single deletion)', () => {
    const result = classifyTriggers('@englsh hi', buildCtx());
    expect(result.languageName).toBe('english');
  });

  it('does NOT match when two options tie on minimum edit distance', () => {
    // Both "mode-a" and "mode-b" are at edit distance 1 from "mode-x" — strict tie.
    const ctx = buildCtx({
      availableModes: [{ name: 'mode-a' }, { name: 'mode-b' }],
    });
    const result = classifyTriggers('#mode-x hi', ctx);
    expect(result.modeName).toBeUndefined();
    expect(result.unmatchedTriggers).toHaveLength(1);
    expect(result.unmatchedTriggers[0]).toMatchObject({ kind: 'mode', rawToken: 'mode-x' });
  });

  it('does NOT match when distance exceeds 2', () => {
    const result = classifyTriggers('#xyzabc hi', buildCtx());
    expect(result.modeName).toBeUndefined();
    expect(result.unmatchedTriggers).toHaveLength(1);
    expect(result.unmatchedTriggers[0]).toMatchObject({ kind: 'mode', rawToken: 'xyzabc' });
  });
});

// ─── Unmatched / mixed ──────────────────────────────────────────────────────

describe('classifyTriggers — unmatched trigger handling', () => {
  it('mixes matched + unmatched: @english resolves, #fza-ocahch is unmatched', () => {
    const result = classifyTriggers('@english #fza-ocahch hello there', buildCtx());
    expect(result.languageName).toBe('english');
    expect(result.modeName).toBeUndefined();
    expect(result.unmatchedTriggers).toHaveLength(1);
    expect(result.unmatchedTriggers[0]).toMatchObject({
      kind: 'mode',
      rawToken: 'fza-ocahch',
    });
    expect(result.unmatchedTriggers[0].availableOptions).toEqual(modes);
    // Matched @english stripped; unmatched #fza-ocahch preserved in place.
    expect(result.strippedMessage).toBe('#fza-ocahch hello there');
  });

  it('records both as unmatched when neither falls within the cascade', () => {
    // Both tokens are well outside Levenshtein ≤ 2 from any configured option.
    const result = classifyTriggers('@klingon #qwertyzz hello there', buildCtx());
    expect(result.modeName).toBeUndefined();
    expect(result.languageName).toBeUndefined();
    expect(result.unmatchedTriggers).toHaveLength(2);
    const kinds = result.unmatchedTriggers.map((t) => t.kind).sort();
    expect(kinds).toEqual(['language', 'mode']);
    const rawTokens = result.unmatchedTriggers.map((t) => t.rawToken).sort();
    expect(rawTokens).toEqual(['klingon', 'qwertyzz'].sort());
    // No tokens matched — both stay in place so Opus sees the literal text.
    expect(result.strippedMessage).toBe('@klingon #qwertyzz hello there');
  });

  it('resolves fuzzy tokens within Levenshtein ≤ 2 (e.g. @enzish → english)', () => {
    // Sanity check that the cascade actually fuzzy-matches the example from
    // the issue — distance 2 (z→l substitution + g insertion) is in range and
    // unique among the configured languages.
    const result = classifyTriggers('@enzish hi', buildCtx());
    expect(result.languageName).toBe('english');
    expect(result.unmatchedTriggers).toEqual([]);
  });

  it('availableOptions in unmatched entry comes from the relevant kind', () => {
    const result = classifyTriggers('@klingon hi', buildCtx());
    expect(result.unmatchedTriggers).toHaveLength(1);
    expect(result.unmatchedTriggers[0].kind).toBe('language');
    expect(result.unmatchedTriggers[0].availableOptions).toEqual(languages);
  });
});

// ─── Empty option lists ─────────────────────────────────────────────────────

describe('classifyTriggers — empty option lists', () => {
  it('records tokens as unmatched (and leaves them in place) when no modes/languages configured', () => {
    const ctx = buildCtx({ availableModes: [], availableLanguages: [] });
    const result = classifyTriggers('#spoken @english hi', ctx);
    expect(result.modeName).toBeUndefined();
    expect(result.languageName).toBeUndefined();
    expect(result.unmatchedTriggers).toHaveLength(2);
    expect(result.unmatchedTriggers[0].availableOptions).toEqual([]);
    expect(result.unmatchedTriggers[1].availableOptions).toEqual([]);
    expect(result.strippedMessage).toBe('#spoken @english hi');
  });

  it('still resolves the kind with available options when only the other is empty', () => {
    const ctx = buildCtx({ availableLanguages: [] });
    const result = classifyTriggers('#spoken @english hi', ctx);
    expect(result.modeName).toBe('spoken');
    expect(result.languageName).toBeUndefined();
    expect(result.unmatchedTriggers).toHaveLength(1);
    expect(result.unmatchedTriggers[0].kind).toBe('language');
    expect(result.unmatchedTriggers[0].rawToken).toBe('english');
    // Matched #spoken stripped; unmatched @english preserved.
    expect(result.strippedMessage).toBe('@english hi');
  });
});

// ─── Coincidental leading sigils (Codex finding) ────────────────────────────

describe('classifyTriggers — coincidental leading sigils preserve user content', () => {
  it('keeps @gmail.com in the stripped message so Opus sees the literal text', () => {
    const result = classifyTriggers(
      '@gmail.com is my address — but my question is about John 3:16.',
      buildCtx()
    );
    expect(result.languageName).toBeUndefined();
    expect(result.unmatchedTriggers).toHaveLength(1);
    expect(result.unmatchedTriggers[0].rawToken).toBe('gmail.com');
    expect(result.strippedMessage).toBe(
      '@gmail.com is my address — but my question is about John 3:16.'
    );
  });

  it('keeps a leading social hashtag in place', () => {
    const result = classifyTriggers(
      "#hashtag what's the best way to start translating Mark?",
      buildCtx()
    );
    expect(result.modeName).toBeUndefined();
    expect(result.strippedMessage).toBe("#hashtag what's the best way to start translating Mark?");
  });

  it('keeps a leading list marker like #1', () => {
    const result = classifyTriggers('#1 give me a one-sentence summary of John 3:16.', buildCtx());
    expect(result.modeName).toBeUndefined();
    expect(result.strippedMessage).toBe('#1 give me a one-sentence summary of John 3:16.');
  });

  it('keeps an unmatched language token while still stripping a matched mode', () => {
    // `@klingon` unmatched (preserved); `#fia-coach` matched (stripped).
    const result = classifyTriggers('@klingon #fia-coach hello', buildCtx());
    expect(result.modeName).toBe('fia-coach');
    expect(result.languageName).toBeUndefined();
    expect(result.strippedMessage).toBe('@klingon hello');
  });

  it('keeps the original case of an unmatched token', () => {
    const result = classifyTriggers('@GMAIL.com check this out', buildCtx());
    expect(result.unmatchedTriggers[0].rawToken).toBe('GMAIL.com');
    expect(result.strippedMessage).toBe('@GMAIL.com check this out');
  });
});

// ─── Clear-mode reserved hashtags ───────────────────────────────────────────

describe('classifyTriggers — clear-mode reserved hashtags', () => {
  it.each(['#default', '#none', '#clear'])(
    '%s sets clearMode=true and strips the token',
    (token) => {
      const result = classifyTriggers(`${token} please`, buildCtx());
      expect(result.clearMode).toBe(true);
      expect(result.modeName).toBeUndefined();
      expect(result.unmatchedTriggers).toEqual([]);
      expect(result.strippedMessage).toBe('please');
    }
  );

  it('clear-mode tokens are case-insensitive', () => {
    const result = classifyTriggers('#DEFAULT please', buildCtx());
    expect(result.clearMode).toBe(true);
    expect(result.strippedMessage).toBe('please');
  });

  it('clear-mode token combined with a language token works for both', () => {
    const result = classifyTriggers('#default @english hi', buildCtx());
    expect(result.clearMode).toBe(true);
    expect(result.modeName).toBeUndefined();
    expect(result.languageName).toBe('english');
    expect(result.strippedMessage).toBe('hi');
  });

  it('clear-mode shadows a published mode named "default" (reserved tokens win)', () => {
    const ctx = buildCtx({
      availableModes: [...modes, { name: 'default', label: 'Default' }],
    });
    const result = classifyTriggers('#default hi', ctx);
    expect(result.clearMode).toBe(true);
    expect(result.modeName).toBeUndefined();
  });

  it('non-leading clear-mode token is not recognised (head-of-message scope)', () => {
    const result = classifyTriggers('please #default', buildCtx());
    expect(result.clearMode).toBe(false);
    expect(result.strippedMessage).toBe('please #default');
  });

  it('clearMode defaults to false when no clear-mode token is present', () => {
    const result = classifyTriggers('#fia-coach hi', buildCtx());
    expect(result.clearMode).toBe(false);
    expect(result.modeName).toBe('fia-coach');
  });
});

// ─── Leading punctuation tolerance between trigger tokens ───────────────────

describe('classifyTriggers — leading punctuation tolerance', () => {
  it.each([',', ':', ';'])(
    'tolerates space-`%s`-space between a leading bot mention and a #mode hashtag',
    (sep) => {
      // Telegram autocomplete commonly inserts a comma after a bot mention,
      // producing `@bot , #mode` (space-comma-space). Without the tolerance,
      // the loop bails at the comma and #mode is never seen.
      const result = classifyTriggers(`@bt_servant_qa_bot ${sep} #spoken hi`, buildCtx());
      expect(result.modeName).toBe('spoken');
      // The bot mention is still recorded as an unmatched language token —
      // only the separator handling changed, not the matching cascade.
      expect(result.unmatchedTriggers.map((t) => t.kind)).toEqual(['language']);
      expect(result.strippedMessage).toBe('@bt_servant_qa_bot hi');
    }
  );

  it('resolves both #mode and @language with a separator before the mode token', () => {
    const result = classifyTriggers('@bt_servant_qa_bot ; #spoken @english hi', buildCtx());
    expect(result.modeName).toBe('spoken');
    expect(result.languageName).toBe('english');
    expect(result.strippedMessage).toBe('@bt_servant_qa_bot hi');
  });

  it('handles a separator with no whitespace after it', () => {
    const result = classifyTriggers('@bt_servant_qa_bot ,#spoken hi', buildCtx());
    expect(result.modeName).toBe('spoken');
  });

  it('does not chain across multiple separators — `,,` blocks the lookahead', () => {
    // The strip is gated by a `(?=[#@])` lookahead, so `,, #spoken` does not
    // qualify (the char after the first `,` is `,`, not `#`/`@`). The loop
    // bails at the first comma and the entire tail — both commas included —
    // is preserved in the stripped message.
    const result = classifyTriggers('@bt_servant_qa_bot ,, #spoken hi', buildCtx());
    expect(result.modeName).toBeUndefined();
    expect(result.strippedMessage).toBe('@bt_servant_qa_bot ,, #spoken hi');
  });

  it('does NOT strip a separator when ordinary text follows (preserves user content)', () => {
    // Codex review caught a regression where the separator was stripped
    // unconditionally. The classifier's existing policy preserves unmatched
    // content; if the user wrote `@bot , please help`, the comma is part
    // of their message and must survive into strippedMessage.
    const result = classifyTriggers('@bt_servant_qa_bot , please help', buildCtx());
    expect(result.modeName).toBeUndefined();
    expect(result.strippedMessage).toBe('@bt_servant_qa_bot , please help');
  });

  it('does not tolerate a period as a separator (control: email-like fragments untouched)', () => {
    // `@user.name` is a single token (no whitespace inside), so the period
    // ends up inside the token's raw text — it is not a separator at all.
    // This test pins the existing behaviour so a future change to the
    // separator set does not silently restructure email-like input.
    const result = classifyTriggers('@user.name #spoken hi', buildCtx());
    expect(result.modeName).toBe('spoken');
    expect(result.unmatchedTriggers.map((t) => t.rawToken)).toEqual(['user.name']);
    expect(result.strippedMessage).toBe('@user.name hi');
  });
});

// ─── No network call ────────────────────────────────────────────────────────

describe('classifyTriggers — synchronous, no I/O', () => {
  it('returns a plain object synchronously without touching fetch', () => {
    // If the implementation accidentally falls back to an async classifier, the
    // typeof check below will fail because the return value would be a Promise.
    const result: unknown = classifyTriggers('#spoken hi', buildCtx());
    expect(typeof (result as { then?: unknown }).then).not.toBe('function');
  });
});
