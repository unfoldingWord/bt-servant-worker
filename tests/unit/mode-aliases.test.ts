import { describe, it, expect } from 'vitest';
import { renameMode, cloneMode, retireMode } from '../../src/index.js';
import {
  findModeBySlug,
  checkModeSlugUniqueness,
  validateModeAliases,
  MAX_MODE_ALIASES,
  MAX_MODES_PER_ORG,
  OrgModes,
  PromptMode,
} from '../../src/types/prompt-overrides.js';
import { resolveEffectiveMode } from '../../src/types/mode-markdown.js';

// ─── Fixtures ───────────────────────────────────────────────────────────────

function makeOrgModes(...modes: PromptMode[]): OrgModes {
  return { modes };
}

const fiaCoach: PromptMode = {
  name: 'fia-coach',
  label: 'FIA Coach',
  published: true,
  document: '## Identity\nFIA Coach',
};

// ─── findModeBySlug ───────────────────────────────────────────────────────────

describe('findModeBySlug', () => {
  const modes: PromptMode[] = [
    { name: 'spoken', overrides: {} },
    { name: 'cbbt-mentoring', aliases: ['fia-trainer', 'old-trainer'], overrides: {} },
  ];

  it('matches on canonical name', () => {
    expect(findModeBySlug(modes, 'spoken')?.name).toBe('spoken');
  });

  it('matches on an alias and returns the canonical mode', () => {
    expect(findModeBySlug(modes, 'fia-trainer')?.name).toBe('cbbt-mentoring');
  });

  it('matches any alias in a multi-alias list', () => {
    expect(findModeBySlug(modes, 'old-trainer')?.name).toBe('cbbt-mentoring');
  });

  it('returns undefined on a miss', () => {
    expect(findModeBySlug(modes, 'nonexistent')).toBeUndefined();
  });

  it('handles modes without an aliases field', () => {
    expect(findModeBySlug([{ name: 'plain', overrides: {} }], 'plain')?.name).toBe('plain');
  });
});

// ─── validateModeAliases ──────────────────────────────────────────────────────

describe('validateModeAliases', () => {
  it('accepts undefined (no aliases)', () => {
    expect(validateModeAliases(undefined)).toBeNull();
  });

  it('accepts a valid array of slugs', () => {
    expect(validateModeAliases(['fia-coach', 'old-coach'])).toBeNull();
  });

  it('rejects a non-array', () => {
    expect(validateModeAliases('fia-coach')).toContain('must be an array');
  });

  it('rejects an entry that is not a valid slug', () => {
    expect(validateModeAliases(['Not A Slug'])).toContain('Invalid alias');
  });

  it('rejects duplicate entries', () => {
    expect(validateModeAliases(['dup', 'dup'])).toContain('Duplicate alias');
  });

  it('rejects more than MAX_MODE_ALIASES entries', () => {
    const tooMany = Array.from({ length: MAX_MODE_ALIASES + 1 }, (_, i) => `alias-${i}`);
    expect(validateModeAliases(tooMany)).toContain('more than');
  });
});

// ─── checkModeSlugUniqueness ──────────────────────────────────────────────────

describe('checkModeSlugUniqueness', () => {
  const modes: PromptMode[] = [
    { name: 'spoken', overrides: {} },
    { name: 'cbbt-mentoring', aliases: ['fia-trainer'], overrides: {} },
  ];

  it('allows a fresh, unique slug', () => {
    expect(checkModeSlugUniqueness(modes, ['brand-new'])).toBeNull();
  });

  it('rejects collision with another mode name', () => {
    expect(checkModeSlugUniqueness(modes, ['spoken'])).toContain('already belongs');
  });

  it('rejects collision with another mode alias', () => {
    expect(checkModeSlugUniqueness(modes, ['fia-trainer'])).toContain('already belongs');
  });

  it('rejects internal duplicates in the candidate set', () => {
    expect(checkModeSlugUniqueness(modes, ['a', 'a'])).toContain('duplicated');
  });

  it('allows a slug owned by an excluded mode (self on rename)', () => {
    // cbbt-mentoring is excluded, so reclaiming its own alias is fine.
    expect(checkModeSlugUniqueness(modes, ['fia-trainer'], ['cbbt-mentoring'])).toBeNull();
  });
});

// ─── renameMode ───────────────────────────────────────────────────────────────

describe('renameMode', () => {
  it('renames in place and retains the old slug as an alias', () => {
    const orgModes = makeOrgModes({ ...fiaCoach });
    const result = renameMode(orgModes, 'fia-coach', 'cbbt-mentoring');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.savedMode.name).toBe('cbbt-mentoring');
      expect(result.savedMode.aliases).toContain('fia-coach');
      expect(result.savedMode.label).toBe('FIA Coach'); // untouched
    }
    expect(orgModes.modes).toHaveLength(1);
  });

  it('accumulates aliases across multiple renames', () => {
    const orgModes = makeOrgModes({ ...fiaCoach });
    renameMode(orgModes, 'fia-coach', 'cbbt-mentoring');
    const result = renameMode(orgModes, 'cbbt-mentoring', 'cbbt-final');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.savedMode.name).toBe('cbbt-final');
      expect(result.savedMode.aliases).toEqual(
        expect.arrayContaining(['fia-coach', 'cbbt-mentoring'])
      );
    }
  });

  it('resolves the renamed mode via an OLD alias too', () => {
    const orgModes = makeOrgModes({ ...fiaCoach });
    renameMode(orgModes, 'fia-coach', 'cbbt-mentoring');
    const result = renameMode(orgModes, 'fia-coach', 'cbbt-final'); // address by old alias
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.savedMode.name).toBe('cbbt-final');
  });

  it('promotes an OWN alias back to canonical (rename to self-alias)', () => {
    // Renaming a mode to one of its own aliases is allowed: it makes the alias
    // the canonical name and demotes the prior name to an alias. No subscriber
    // is stranded (every old slug still resolves) and it is fully reversible —
    // an "un-rename". Verified against staging during #284. The uniqueness check
    // excludes the source itself, which is what permits this.
    const orgModes = makeOrgModes({ ...fiaCoach });
    renameMode(orgModes, 'fia-coach', 'cbbt-mentoring'); // aliases: [fia-coach]
    const result = renameMode(orgModes, 'cbbt-mentoring', 'fia-coach'); // promote the alias
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.savedMode.name).toBe('fia-coach');
      // The newly-canonical slug is removed from aliases; the prior name joins them.
      expect(result.savedMode.aliases).not.toContain('fia-coach');
      expect(result.savedMode.aliases).toContain('cbbt-mentoring');
    }
  });
});

describe('renameMode — errors', () => {
  it('returns not_found for a missing source', () => {
    const result = renameMode(makeOrgModes(), 'ghost', 'whatever');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('not_found');
  });

  it('rejects an invalid newName', () => {
    const result = renameMode(makeOrgModes({ ...fiaCoach }), 'fia-coach', 'Bad Name');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('invalid');
  });

  it('rejects renaming to the current name', () => {
    const result = renameMode(makeOrgModes({ ...fiaCoach }), 'fia-coach', 'fia-coach');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('invalid');
  });

  it('rejects a newName that collides with another mode', () => {
    const orgModes = makeOrgModes({ ...fiaCoach }, { name: 'spoken', overrides: {} });
    const result = renameMode(orgModes, 'fia-coach', 'spoken');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('conflict');
  });
});

// ─── cloneMode ────────────────────────────────────────────────────────────────

describe('cloneMode', () => {
  it('deep-copies content under the new name, unpublished, no aliases', () => {
    const orgModes = makeOrgModes({ ...fiaCoach, aliases: ['old-coach'] });
    const result = cloneMode(orgModes, 'fia-coach', 'fia-drafting', 'FIA Drafting');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.savedMode.name).toBe('fia-drafting');
      expect(result.savedMode.label).toBe('FIA Drafting');
      expect(result.savedMode.document).toBe(fiaCoach.document);
      expect(result.savedMode.published).toBe(false);
      expect(result.savedMode.aliases).toBeUndefined();
    }
    expect(orgModes.modes).toHaveLength(2);
  });

  it('inherits the source label when newLabel is omitted', () => {
    const orgModes = makeOrgModes({ ...fiaCoach });
    const result = cloneMode(orgModes, 'fia-coach', 'fia-drafting');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.savedMode.label).toBe('FIA Coach');
  });

  it('copies the overrides shape for a legacy mode', () => {
    const orgModes = makeOrgModes({ name: 'legacy', overrides: { identity: 'X' } });
    const result = cloneMode(orgModes, 'legacy', 'legacy-copy');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.savedMode.overrides).toEqual({ identity: 'X' });
      expect(result.savedMode.document).toBeUndefined();
    }
  });

  it('rejects a newName that collides with an existing alias', () => {
    const orgModes = makeOrgModes({ ...fiaCoach, aliases: ['old-coach'] });
    const result = cloneMode(orgModes, 'fia-coach', 'old-coach');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('conflict');
  });

  it('rejects when at MAX_MODES_PER_ORG', () => {
    const modes = Array.from({ length: MAX_MODES_PER_ORG }, (_, i) => ({
      name: `mode-${i}`,
      overrides: {},
    }));
    const result = cloneMode({ modes }, 'mode-0', 'one-too-many');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('invalid');
  });
});

// ─── retireMode ───────────────────────────────────────────────────────────────

describe('retireMode', () => {
  it('deletes the source and forwards its slug onto the target', () => {
    const orgModes = makeOrgModes(
      { ...fiaCoach, aliases: ['old-coach'] },
      { name: 'fia-drafting', published: true, document: '## Identity\nDrafting' }
    );
    const result = retireMode(orgModes, 'fia-coach', 'fia-drafting');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.savedMode.name).toBe('fia-drafting');
      // Both the retired canonical slug AND its prior aliases move over.
      expect(result.savedMode.aliases).toEqual(expect.arrayContaining(['fia-coach', 'old-coach']));
    }
    expect(orgModes.modes).toHaveLength(1);
    expect(findModeBySlug(orgModes.modes, 'fia-coach')?.name).toBe('fia-drafting');
  });

  it('returns not_found for a missing source', () => {
    const orgModes = makeOrgModes({ name: 'fia-drafting', overrides: {} });
    const result = retireMode(orgModes, 'ghost', 'fia-drafting');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('not_found');
  });

  it('returns not_found for a missing forwardTo', () => {
    const result = retireMode(makeOrgModes({ ...fiaCoach }), 'fia-coach', 'ghost');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('not_found');
  });

  it('rejects forwarding a mode to itself', () => {
    const result = retireMode(makeOrgModes({ ...fiaCoach }), 'fia-coach', 'fia-coach');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('invalid');
  });

  it('rejects forwarding to itself addressed via an alias', () => {
    const orgModes = makeOrgModes({ ...fiaCoach, aliases: ['old-coach'] });
    const result = retireMode(orgModes, 'fia-coach', 'old-coach');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('invalid');
  });
});

// ─── Regression: the core acceptance bar ──────────────────────────────────────

describe('resolveEffectiveMode after rename (regression for #284)', () => {
  it('resolves a stale selected_mode to the renamed mode, not "missing"', () => {
    const orgModes = makeOrgModes({ ...fiaCoach });
    renameMode(orgModes, 'fia-coach', 'cbbt-mentoring');

    // A subscriber whose DO still holds the OLD slug:
    const resolved = resolveEffectiveMode(orgModes, 'fia-coach');
    expect(resolved.reason).toBe('ok');
    expect(resolved.effectiveModeName).toBe('cbbt-mentoring'); // canonical, not the alias
    expect(resolved.resolvedViaAlias).toBe(true);
  });

  it('reports resolvedViaAlias=false for a canonical-name hit', () => {
    const orgModes = makeOrgModes({ ...fiaCoach });
    const resolved = resolveEffectiveMode(orgModes, 'fia-coach');
    expect(resolved.reason).toBe('ok');
    expect(resolved.resolvedViaAlias).toBe(false);
  });

  it('still gates an unpublished mode reached via alias for non-admins', () => {
    const orgModes = makeOrgModes({ ...fiaCoach, published: false });
    renameMode(orgModes, 'fia-coach', 'cbbt-mentoring');
    const resolved = resolveEffectiveMode(orgModes, 'fia-coach');
    expect(resolved.reason).toBe('unpublished');
    expect(resolved.effectiveModeName).toBeUndefined();
  });

  it('still gates a requires_group mode reached via alias in a 1:1 chat', () => {
    const orgModes = makeOrgModes({ ...fiaCoach, requires_group: true });
    renameMode(orgModes, 'fia-coach', 'cbbt-mentoring');
    const resolved = resolveEffectiveMode(orgModes, 'fia-coach', { isGroupChat: false });
    expect(resolved.reason).toBe('requires-group');
  });
});
