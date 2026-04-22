import { describe, it, expect } from 'vitest';
import { upsertMode } from '../../src/index.js';
import { OrgModes, MAX_MODES_PER_ORG } from '../../src/types/prompt-overrides.js';

function makeOrgModes(...modes: OrgModes['modes']): OrgModes {
  return { modes };
}

describe('upsertMode - new mode creation', () => {
  it('creates a new mode when none exists', () => {
    const orgModes = makeOrgModes();
    const result = upsertMode(orgModes, { name: 'test', overrides: { identity: 'Hello' } }, 'o');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.savedMode.overrides.identity).toBe('Hello');
    expect(orgModes.modes).toHaveLength(1);
  });

  it('returns error when MAX_MODES_PER_ORG exceeded', () => {
    const modes = Array.from({ length: MAX_MODES_PER_ORG }, (_, i) => ({
      name: `mode-${i}`,
      overrides: {},
    }));
    const result = upsertMode({ modes }, { name: 'one-too-many', overrides: {} }, 'o');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('Cannot have more than');
  });
});

describe('upsertMode - override merging', () => {
  it('merges overrides with existing mode', () => {
    const orgModes = makeOrgModes({
      name: 'test',
      overrides: { identity: 'Original', closing: 'Keep me' },
    });
    const result = upsertMode(orgModes, { name: 'test', overrides: { identity: 'Updated' } }, 'o');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.savedMode.overrides.identity).toBe('Updated');
      expect(result.savedMode.overrides.closing).toBe('Keep me');
    }
  });

  it('removes a slot when null is sent', () => {
    const orgModes = makeOrgModes({
      name: 'test',
      overrides: { identity: 'Remove me', closing: 'Keep me' },
    });
    const result = upsertMode(orgModes, { name: 'test', overrides: { identity: null } }, 'o');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.savedMode.overrides.identity).toBeUndefined();
      expect(result.savedMode.overrides.closing).toBe('Keep me');
    }
  });

  it('allows update even when at MAX_MODES_PER_ORG', () => {
    const modes = Array.from({ length: MAX_MODES_PER_ORG }, (_, i) => ({
      name: `mode-${i}`,
      overrides: {},
    }));
    const orgModes = { modes };
    const result = upsertMode(orgModes, { name: 'mode-0', overrides: { identity: 'Up' } }, 'o');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.savedMode.overrides.identity).toBe('Up');
    expect(orgModes.modes).toHaveLength(MAX_MODES_PER_ORG);
  });
});

describe('upsertMode - scalar field preservation', () => {
  it('preserves existing label when caller omits it', () => {
    const orgModes = makeOrgModes({ name: 't', label: 'My Label', overrides: {} });
    const result = upsertMode(orgModes, { name: 't', overrides: { identity: 'X' } }, 'o');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.savedMode.label).toBe('My Label');
  });

  it('preserves existing description when caller omits it', () => {
    const orgModes = makeOrgModes({ name: 't', description: 'My Desc', overrides: {} });
    const result = upsertMode(orgModes, { name: 't', overrides: { identity: 'X' } }, 'o');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.savedMode.description).toBe('My Desc');
  });

  it('updates label when caller provides one', () => {
    const orgModes = makeOrgModes({ name: 't', label: 'Old', overrides: {} });
    const result = upsertMode(orgModes, { name: 't', label: 'New', overrides: {} }, 'o');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.savedMode.label).toBe('New');
  });
});

describe('upsertMode - published flag preservation', () => {
  it('preserves existing published: true when caller omits the field', () => {
    const orgModes = makeOrgModes({ name: 't', published: true, overrides: {} });
    const result = upsertMode(orgModes, { name: 't', overrides: { identity: 'X' } }, 'o');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.savedMode.published).toBe(true);
  });

  it('preserves existing published: false when caller omits the field', () => {
    const orgModes = makeOrgModes({ name: 't', published: false, overrides: {} });
    const result = upsertMode(orgModes, { name: 't', overrides: { identity: 'X' } }, 'o');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.savedMode.published).toBe(false);
  });

  it('updates published when caller provides it (publish action)', () => {
    const orgModes = makeOrgModes({ name: 't', published: false, overrides: {} });
    const result = upsertMode(orgModes, { name: 't', published: true, overrides: {} }, 'o');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.savedMode.published).toBe(true);
  });

  it('updates published when caller provides it (unpublish action)', () => {
    const orgModes = makeOrgModes({ name: 't', published: true, overrides: {} });
    const result = upsertMode(orgModes, { name: 't', published: false, overrides: {} }, 'o');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.savedMode.published).toBe(false);
  });

  it('persists published on a brand-new mode', () => {
    const orgModes = makeOrgModes();
    const result = upsertMode(orgModes, { name: 'new', published: true, overrides: {} }, 'o');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.savedMode.published).toBe(true);
  });

  it('omits published key on new mode when not supplied (defaults to draft)', () => {
    const orgModes = makeOrgModes();
    const result = upsertMode(orgModes, { name: 'new', overrides: {} }, 'o');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.savedMode.published).toBeUndefined();
  });
});
