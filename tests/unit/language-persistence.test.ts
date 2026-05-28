import { describe, it, expect } from 'vitest';
import { decideLanguagePersistence } from '../../src/durable-objects/user-do.js';

describe('decideLanguagePersistence', () => {
  it('puts when @-trigger activates a new language (no prior language)', () => {
    const action = decideLanguagePersistence({ clearLanguage: false }, undefined, 'arabic');
    expect(action).toEqual({ kind: 'put', language: 'arabic' });
  });

  it('puts when @-trigger switches from one language to another', () => {
    const action = decideLanguagePersistence({ clearLanguage: false }, 'english', 'arabic');
    expect(action).toEqual({ kind: 'put', language: 'arabic' });
  });

  it('does nothing when @-trigger matches the already-persisted language', () => {
    const action = decideLanguagePersistence({ clearLanguage: false }, 'arabic', 'arabic');
    expect(action).toEqual({ kind: 'none' });
  });

  it('does nothing when classifier did not resolve a new language', () => {
    const action = decideLanguagePersistence({ clearLanguage: false }, 'arabic', undefined);
    expect(action).toEqual({ kind: 'none' });
  });

  it('does nothing when classifier did not resolve a language and there is no prior', () => {
    const action = decideLanguagePersistence({ clearLanguage: false }, undefined, undefined);
    expect(action).toEqual({ kind: 'none' });
  });

  it('deletes when clearLanguage is set and a prior language is persisted', () => {
    const action = decideLanguagePersistence({ clearLanguage: true }, 'arabic', undefined);
    expect(action).toEqual({ kind: 'delete' });
  });

  it('does nothing when clearLanguage is set but no prior language is persisted', () => {
    const action = decideLanguagePersistence({ clearLanguage: true }, undefined, undefined);
    expect(action).toEqual({ kind: 'none' });
  });

  it('clearLanguage wins over a stray newEffectiveLanguageName (defensive)', () => {
    // The classifier should never set both, but if a future caller passes both,
    // clear-intent wins so a mistakenly-resolved language cannot override the
    // user's explicit clear request. Mirrors the clearMode defensive case.
    const action = decideLanguagePersistence({ clearLanguage: true }, 'english', 'arabic');
    expect(action).toEqual({ kind: 'delete' });
  });

  it('clearLanguage + no prior + same-message language activation → none (per-turn reset is the callers job)', () => {
    // Combined message like `@default @arabic hi` with no prior persisted
    // language: the helper returns 'none' because there is nothing to delete
    // from storage, but the calling code (applyTriggerOverrides) MUST still
    // reset the per-turn active language so the current turn answers in
    // default. Mirror of the equivalent clearMode regression test.
    const action = decideLanguagePersistence({ clearLanguage: true }, undefined, 'arabic');
    expect(action).toEqual({ kind: 'none' });
  });
});
