import { describe, it, expect } from 'vitest';
import { stripUlyssesComments } from '../../src/utils/ulysses-comments.js';

// ─── Fast path / no-comment input ────────────────────────────────────────────

describe('stripUlyssesComments — no comments', () => {
  it('returns plain text unchanged with no flag', () => {
    expect(stripUlyssesComments('hello world')).toEqual({
      cleaned: 'hello world',
      hadUnbalancedSpan: false,
    });
  });

  it('returns the empty string unchanged', () => {
    expect(stripUlyssesComments('')).toEqual({ cleaned: '', hadUnbalancedSpan: false });
  });

  it('preserves text that uses a single `+` or `%` (not a delimiter)', () => {
    expect(stripUlyssesComments('1 + 2 = 3, 50% off')).toEqual({
      cleaned: '1 + 2 = 3, 50% off',
      hadUnbalancedSpan: false,
    });
  });
});

// ─── Line comments (`%%`) ────────────────────────────────────────────────────

describe('stripUlyssesComments — line comments', () => {
  it('strips from `%%` through end-of-line', () => {
    expect(stripUlyssesComments('hello %% editor note').cleaned).toBe('hello ');
  });

  it('strips a column-0 `%%` line, leaving an empty line', () => {
    expect(stripUlyssesComments('%% editor note\nreal content').cleaned).toBe('\nreal content');
  });

  it('strips line comments while preserving the rest of the line', () => {
    expect(stripUlyssesComments('## Identity %% TODO: rewrite\nbody').cleaned).toBe(
      '## Identity \nbody'
    );
  });

  it('strips line comments on multiple lines independently', () => {
    expect(stripUlyssesComments('A %% note1\nB %% note2\nC').cleaned).toBe('A \nB \nC');
  });
});

// ─── Span comments (`++ … ++`) ───────────────────────────────────────────────

describe('stripUlyssesComments — inline span comments', () => {
  it('strips an inline span and its delimiters', () => {
    expect(stripUlyssesComments('Hello ++note++ world').cleaned).toBe('Hello  world');
  });

  it('strips a span at the start of the input', () => {
    // Opener at column 0 is allowed (no preceding char); closer must not be
    // followed by a word char, so the closing `++` is the one before the space.
    expect(stripUlyssesComments('++lead++ rest').cleaned).toBe(' rest');
  });

  it('strips a span at the end of the input', () => {
    expect(stripUlyssesComments('prefix ++trailing++').cleaned).toBe('prefix ');
  });

  it('strips two distinct spans on the same line', () => {
    expect(stripUlyssesComments('a ++b++ c ++d++ e').cleaned).toBe('a  c  e');
  });

  it('strips a multi-line span', () => {
    expect(stripUlyssesComments('start ++a\nb++ end').cleaned).toBe('start  end');
  });

  it('strips a span whose body contains `%%` wholesale', () => {
    expect(stripUlyssesComments('pre ++note %% inner++ post').cleaned).toBe('pre  post');
  });

  it('strips a multi-line span whose body contains `%%` lines', () => {
    expect(stripUlyssesComments('++a\n%% b\nc++ d').cleaned).toBe(' d');
  });
});

describe('stripUlyssesComments — word-boundary protection for `++`', () => {
  it('does not flag C-style increment in code: `for (let i = 0; i < 50; i++) { … }`', () => {
    const code = 'for (let i = 0; i < 50; i++) { console.log(i); }';
    expect(stripUlyssesComments(code)).toEqual({ cleaned: code, hadUnbalancedSpan: false });
  });

  it('does not strip `a++++b` because the `++` is glued to word chars on both sides', () => {
    // Each `++` is adjacent to a word char (`a` before / `b` after the
    // outer pair, and to each other in the middle). No valid opener.
    const input = 'a++++b';
    expect(stripUlyssesComments(input)).toEqual({ cleaned: input, hadUnbalancedSpan: false });
  });

  it('does not treat `i++` followed by another `i++` later as a span', () => {
    const input = 'i++ then later i++ done';
    expect(stripUlyssesComments(input)).toEqual({ cleaned: input, hadUnbalancedSpan: false });
  });

  it('treats `++note++` (no surrounding context) as a span', () => {
    expect(stripUlyssesComments('++note++').cleaned).toBe('');
  });

  it('treats `++ note ++` (Ulysses canonical with spaces) as a span', () => {
    expect(stripUlyssesComments('a ++ note ++ b').cleaned).toBe('a  b');
  });
});

// ─── Unbalanced delimiters ───────────────────────────────────────────────────

describe('stripUlyssesComments — unbalanced spans', () => {
  it('leaves a lone `++` literal and flags unbalanced', () => {
    const r = stripUlyssesComments('text ++ orphan');
    expect(r.cleaned).toBe('text ++ orphan');
    expect(r.hadUnbalancedSpan).toBe(true);
  });

  it('with three `++` delimiters, pairs the first two and orphans the third', () => {
    const r = stripUlyssesComments('++a++ ++ end');
    expect(r.cleaned).toBe(' ++ end');
    expect(r.hadUnbalancedSpan).toBe(true);
  });

  it('flags unbalanced even when the orphan appears after content', () => {
    const r = stripUlyssesComments('intact start ++ unpaired');
    expect(r.cleaned).toBe('intact start ++ unpaired');
    expect(r.hadUnbalancedSpan).toBe(true);
  });
});

// ─── Combined / acceptance fixture ──────────────────────────────────────────

describe('stripUlyssesComments — combined fixture', () => {
  it('handles a realistic mode document with mixed comments and code', () => {
    const input = [
      '## Identity',
      '',
      'You are TestBot. %% rewrite this section',
      'Always be concise. ++this aside is editor-only++',
      '',
      'Example loop: `for (let i = 0; i < 50; i++) { fetch(i); }`',
      '',
      '++long aside',
      'across multiple lines',
      'with %% nested line-marker inside++',
      'Final sentence.',
    ].join('\n');
    const expected = [
      '## Identity',
      '',
      'You are TestBot. ',
      'Always be concise. ',
      '',
      'Example loop: `for (let i = 0; i < 50; i++) { fetch(i); }`',
      '',
      '',
      'Final sentence.',
    ].join('\n');
    expect(stripUlyssesComments(input)).toEqual({
      cleaned: expected,
      hadUnbalancedSpan: false,
    });
  });
});
