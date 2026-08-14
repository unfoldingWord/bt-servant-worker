import { describe, it, expect } from 'vitest';
import { buildTriggerOnlyContext, resolveTurnMessage } from '../../src/durable-objects/user-do.js';
import { ClassifierResult } from '../../src/services/classifier/index.js';

/**
 * Regression cover for #360.
 *
 * A message consisting only of routing tokens (`@hindi`, `#dbs-coach`) strips
 * to the empty string, and the Anthropic API rejects the ENTIRE request when
 * any user turn has empty content — so the user got a 502 instead of the
 * language switch they asked for, even though the switch itself had already
 * been persisted.
 */

function classified(overrides?: Partial<ClassifierResult>): ClassifierResult {
  return {
    modeName: undefined,
    languageName: undefined,
    strippedMessage: '',
    unmatchedTriggers: [],
    clearMode: false,
    clearLanguage: false,
    ...overrides,
  };
}

const NO_LABELS = { modeLabel: undefined, languageLabel: undefined };

describe('buildTriggerOnlyContext', () => {
  it('describes a lone @language turn', () => {
    const ctx = buildTriggerOnlyContext(classified({ languageName: 'hindi' }), {
      modeLabel: undefined,
      languageLabel: 'Hindi',
    });
    expect(ctx).toEqual({ language: 'Hindi' });
  });

  it('describes a lone #mode turn', () => {
    const ctx = buildTriggerOnlyContext(classified({ modeName: 'dbs-coach' }), {
      modeLabel: 'DBS Coach',
      languageLabel: undefined,
    });
    expect(ctx).toEqual({ mode: 'DBS Coach' });
  });

  it('describes a combined #mode @language turn', () => {
    const ctx = buildTriggerOnlyContext(classified({ modeName: 'spoken', languageName: 'hindi' }), {
      modeLabel: 'Spoken',
      languageLabel: 'Hindi',
    });
    expect(ctx).toEqual({ mode: 'Spoken', language: 'Hindi' });
  });

  it('describes clear-intent tokens', () => {
    const ctx = buildTriggerOnlyContext(
      classified({ clearLanguage: true, clearMode: true }),
      NO_LABELS
    );
    expect(ctx).toEqual({ clearedMode: true, clearedLanguage: true });
  });

  it('reports ONLY what changed this turn, not the inherited active state', () => {
    // `@hindi` sent while a mode is already active: the mode label resolves
    // (it IS active), but the user did not switch modes, so claiming they did
    // would make the confirmation lie.
    const ctx = buildTriggerOnlyContext(classified({ languageName: 'hindi' }), {
      modeLabel: 'DBS Coach',
      languageLabel: 'Hindi',
    });
    expect(ctx).toEqual({ language: 'Hindi' });
  });
});

describe('buildTriggerOnlyContext — when it must decline', () => {
  it('returns undefined when the turn still has content', () => {
    const ctx = buildTriggerOnlyContext(
      classified({ languageName: 'hindi', strippedMessage: 'who wrote Luke?' }),
      { modeLabel: undefined, languageLabel: 'Hindi' }
    );
    expect(ctx).toBeUndefined();
  });

  it('returns undefined for a message that is empty for any other reason', () => {
    // Blank input resolves no tokens — there is nothing to confirm, and the
    // empty-message backstop in orchestrate() handles it instead.
    expect(buildTriggerOnlyContext(classified(), NO_LABELS)).toBeUndefined();
    expect(
      buildTriggerOnlyContext(classified({ strippedMessage: '   ' }), NO_LABELS)
    ).toBeUndefined();
  });

  it('returns undefined when a selection resolved to no label (nothing to name)', () => {
    // Defensive: a language that vanished from org config between resolution
    // and labelling would otherwise produce an empty confirmation directive.
    const ctx = buildTriggerOnlyContext(classified({ languageName: 'hindi' }), NO_LABELS);
    expect(ctx).toBeUndefined();
  });
});

describe('resolveTurnMessage', () => {
  it('sends the RAW text for a trigger-only turn, never the empty string', () => {
    // The #360 regression, stated directly.
    const c = classified({ languageName: 'hindi' });
    const text = resolveTurnMessage('@hindi', c, { language: 'Hindi' });
    expect(text).toBe('@hindi');
    expect(text.length).toBeGreaterThan(0);
  });

  it('sends the STRIPPED text for an ordinary trigger turn', () => {
    const c = classified({ languageName: 'hindi', strippedMessage: 'who wrote Luke?' });
    expect(resolveTurnMessage('@hindi who wrote Luke?', c, undefined)).toBe('who wrote Luke?');
  });

  it('sends the stripped text unchanged when there were no triggers at all', () => {
    const c = classified({ strippedMessage: 'who wrote Luke?' });
    expect(resolveTurnMessage('who wrote Luke?', c, undefined)).toBe('who wrote Luke?');
  });

  it('leaves a genuinely empty message empty for the orchestrate() backstop', () => {
    expect(resolveTurnMessage('', classified(), undefined)).toBe('');
  });
});
