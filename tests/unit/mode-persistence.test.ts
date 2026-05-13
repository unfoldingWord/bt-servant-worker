import { describe, it, expect } from 'vitest';
import { decideModePersistence } from '../../src/durable-objects/user-do.js';

describe('decideModePersistence', () => {
  it('puts when hashtag activates a new mode (no prior mode)', () => {
    const action = decideModePersistence({ clearMode: false }, undefined, 'spoken-mode');
    expect(action).toEqual({ kind: 'put', mode: 'spoken-mode' });
  });

  it('puts when hashtag switches from one mode to another', () => {
    const action = decideModePersistence({ clearMode: false }, 'fia-coach', 'spoken-mode');
    expect(action).toEqual({ kind: 'put', mode: 'spoken-mode' });
  });

  it('does nothing when hashtag matches the already-persisted mode', () => {
    const action = decideModePersistence({ clearMode: false }, 'spoken-mode', 'spoken-mode');
    expect(action).toEqual({ kind: 'none' });
  });

  it('does nothing when classifier did not resolve a new mode', () => {
    const action = decideModePersistence({ clearMode: false }, 'spoken-mode', undefined);
    expect(action).toEqual({ kind: 'none' });
  });

  it('does nothing when classifier did not resolve a mode and there is no prior', () => {
    const action = decideModePersistence({ clearMode: false }, undefined, undefined);
    expect(action).toEqual({ kind: 'none' });
  });

  it('deletes when clearMode is set and a prior mode is persisted', () => {
    const action = decideModePersistence({ clearMode: true }, 'spoken-mode', undefined);
    expect(action).toEqual({ kind: 'delete' });
  });

  it('does nothing when clearMode is set but no prior mode is persisted', () => {
    const action = decideModePersistence({ clearMode: true }, undefined, undefined);
    expect(action).toEqual({ kind: 'none' });
  });

  it('clearMode wins over a stray newEffectiveModeName (defensive)', () => {
    // The classifier should never set both, but if a future caller passes both,
    // clear-intent wins so a mistakenly-resolved mode cannot override the
    // user's explicit clear request.
    const action = decideModePersistence({ clearMode: true }, 'fia-coach', 'spoken-mode');
    expect(action).toEqual({ kind: 'delete' });
  });
});
