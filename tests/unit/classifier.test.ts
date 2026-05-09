import { describe, it, expect } from 'vitest';
import { classifyTriggers } from '../../src/services/classifier/index.js';

const modes = [{ name: 'spoken' }, { name: 'mast-methodology' }, { name: 'dbs-coach' }];

const languages = [{ name: 'arabic' }, { name: 'french' }];

const ctx = { availableModes: modes, availableLanguages: languages };

describe('classifyTriggers - no triggers', () => {
  it('passes through message unchanged when no triggers present', () => {
    const result = classifyTriggers('How do I translate Genesis 1:1?', ctx);

    expect(result.modeName).toBeUndefined();
    expect(result.languageName).toBeUndefined();
    expect(result.strippedMessage).toBe('How do I translate Genesis 1:1?');
    expect(result.warnings).toEqual([]);
  });

  it('does not extract triggers from the middle of a message', () => {
    const result = classifyTriggers('Please use #spoken mode', ctx);

    expect(result.modeName).toBeUndefined();
    expect(result.strippedMessage).toBe('Please use #spoken mode');
  });
});

describe('classifyTriggers - mode triggers', () => {
  it('extracts #mode at message start', () => {
    const result = classifyTriggers('#spoken How do I translate?', ctx);

    expect(result.modeName).toBe('spoken');
    expect(result.languageName).toBeUndefined();
    expect(result.strippedMessage).toBe('How do I translate?');
  });

  it('matches mode slug case-insensitively', () => {
    const result = classifyTriggers('#SPOKEN hello', ctx);
    expect(result.modeName).toBe('spoken');
  });

  it('matches hyphenated slugs', () => {
    const result = classifyTriggers('#mast-methodology What is MAST?', ctx);
    expect(result.modeName).toBe('mast-methodology');
    expect(result.strippedMessage).toBe('What is MAST?');
  });
});

describe('classifyTriggers - language triggers', () => {
  it('extracts @language at message start', () => {
    const result = classifyTriggers('@arabic Translate this verse', ctx);

    expect(result.modeName).toBeUndefined();
    expect(result.languageName).toBe('arabic');
    expect(result.strippedMessage).toBe('Translate this verse');
  });

  it('matches language slug case-insensitively', () => {
    const result = classifyTriggers('@FRENCH hello', ctx);
    expect(result.languageName).toBe('french');
  });
});

describe('classifyTriggers - combined triggers', () => {
  it('extracts both #mode and @language', () => {
    const result = classifyTriggers('#spoken @arabic How do I translate Genesis 1:1?', ctx);

    expect(result.modeName).toBe('spoken');
    expect(result.languageName).toBe('arabic');
    expect(result.strippedMessage).toBe('How do I translate Genesis 1:1?');
    expect(result.warnings).toEqual([]);
  });

  it('handles @language before #mode', () => {
    const result = classifyTriggers('@french #dbs-coach What is DBS?', ctx);

    expect(result.modeName).toBe('dbs-coach');
    expect(result.languageName).toBe('french');
    expect(result.strippedMessage).toBe('What is DBS?');
  });
});

describe('classifyTriggers - unrecognized tokens', () => {
  it('warns on unrecognized mode', () => {
    const result = classifyTriggers('#nonexistent hello', ctx);

    expect(result.modeName).toBeUndefined();
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('#nonexistent');
    expect(result.warnings[0]).toContain('not recognized');
    expect(result.strippedMessage).toBe('hello');
  });

  it('warns on unrecognized language', () => {
    const result = classifyTriggers('@klingon hello', ctx);

    expect(result.languageName).toBeUndefined();
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('@klingon');
  });

  it('warns on both unrecognized mode and language', () => {
    const result = classifyTriggers('#fake @bogus hello', ctx);

    expect(result.modeName).toBeUndefined();
    expect(result.languageName).toBeUndefined();
    expect(result.warnings).toHaveLength(2);
    expect(result.strippedMessage).toBe('hello');
  });

  it('matches recognized and warns on unrecognized in same message', () => {
    const result = classifyTriggers('#spoken @bogus hello', ctx);

    expect(result.modeName).toBe('spoken');
    expect(result.languageName).toBeUndefined();
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('@bogus');
  });
});

describe('classifyTriggers - edge cases', () => {
  it('handles message that is only a trigger token', () => {
    const result = classifyTriggers('#spoken', ctx);

    expect(result.modeName).toBe('spoken');
    // When rest is empty, falls back to original message
    expect(result.strippedMessage).toBe('#spoken');
  });

  it('handles empty available lists', () => {
    const result = classifyTriggers('#spoken hello', {
      availableModes: [],
      availableLanguages: [],
    });

    expect(result.modeName).toBeUndefined();
    expect(result.warnings).toHaveLength(1);
    expect(result.strippedMessage).toBe('hello');
  });

  it('handles lone # (no slug after prefix)', () => {
    const result = classifyTriggers('# hello', ctx);

    expect(result.modeName).toBeUndefined();
    expect(result.strippedMessage).toBe('# hello');
  });

  it('takes first of each trigger type, ignores duplicates', () => {
    const result = classifyTriggers('#spoken #dbs-coach hello', ctx);

    expect(result.modeName).toBe('spoken');
    expect(result.strippedMessage).toBe('hello');
  });
});
