import { describe, it, expect } from 'vitest';
import { upsertMode, cloneMode, toMarkdownView } from '../../src/index.js';
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

// #311: welcome_message is an authored scalar that must survive admin CRUD.
// Before the fix, mergeExistingMode rebuilt the record field-by-field and
// dropped it on every PUT, and toMarkdownView never surfaced it, so the portal
// editor lost the copy on the next save.
describe('upsertMode - welcome_message (#311)', () => {
  it('preserves existing welcome_message when caller omits it', () => {
    const orgModes = makeOrgModes({
      name: 't',
      welcome_message: 'Hi there',
      overrides: {},
    });
    const result = upsertMode(orgModes, { name: 't', overrides: { identity: 'X' } }, 'o');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.savedMode.welcome_message).toBe('Hi there');
  });

  it('updates welcome_message when caller provides one', () => {
    const orgModes = makeOrgModes({ name: 't', welcome_message: 'Old copy', overrides: {} });
    const result = upsertMode(
      orgModes,
      { name: 't', welcome_message: 'New copy', overrides: {} },
      'o'
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.savedMode.welcome_message).toBe('New copy');
  });

  it('persists welcome_message on a brand-new mode', () => {
    const orgModes = makeOrgModes();
    const result = upsertMode(
      orgModes,
      { name: 't', welcome_message: 'Fresh', overrides: {} },
      'o'
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.savedMode.welcome_message).toBe('Fresh');
  });
});

// #311 FIX 3: the CREATE branch previously stored the input object unchanged, so
// `welcome_message: null` (or '') persisted `null` in KV — violating the
// `string | undefined` shape and returning null to clients. Normalize on create
// exactly as mergeExistingMode does on update: null/'' ⇒ store NO field.
describe('upsertMode - welcome_message create-path normalization (#311 FIX 3)', () => {
  it('stores NO welcome_message when a brand-new mode sends explicit null', () => {
    const orgModes = makeOrgModes();
    const result = upsertMode(
      orgModes,
      { name: 't', welcome_message: null, overrides: {} } as unknown as OrgModes['modes'][number],
      'o'
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.savedMode.welcome_message).toBeUndefined();
      // The key is absent from the stored record, not merely null.
      expect('welcome_message' in result.savedMode).toBe(false);
    }
    // And the persisted mode in the array carries no field either.
    expect('welcome_message' in orgModes.modes[0]!).toBe(false);
  });

  it('stores NO welcome_message when a brand-new mode sends an empty string', () => {
    const orgModes = makeOrgModes();
    const result = upsertMode(orgModes, { name: 't', welcome_message: '', overrides: {} }, 'o');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.savedMode.welcome_message).toBeUndefined();
      expect('welcome_message' in result.savedMode).toBe(false);
    }
    expect('welcome_message' in orgModes.modes[0]!).toBe(false);
  });
});

// #311 FIX 4: an author must be able to turn a welcome OFF. Three cases:
//  - omit (undefined) ⇒ unchanged (covered by the suite above);
//  - explicit null ⇒ removed (a plain `?? existing` treated null as a no-op);
//  - explicit '' ⇒ removed (compactOptional drops empty strings; made explicit).
describe('upsertMode - welcome_message opt-out (#311 FIX 4)', () => {
  it('removes welcome_message when the caller sends explicit null', () => {
    const orgModes = makeOrgModes({ name: 't', welcome_message: 'Turn me off', overrides: {} });
    const result = upsertMode(
      orgModes,
      // JSON carries a portal "clear" as null; the PromptMode type says string,
      // so cast to model the wire reality.
      { name: 't', welcome_message: null, overrides: {} } as unknown as OrgModes['modes'][number],
      'o'
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.savedMode.welcome_message).toBeUndefined();
      // The key is dropped, not merely set to a falsy value.
      expect('welcome_message' in result.savedMode).toBe(false);
    }
  });

  it('removes welcome_message when the caller sends an empty string', () => {
    const orgModes = makeOrgModes({ name: 't', welcome_message: 'Turn me off', overrides: {} });
    const result = upsertMode(orgModes, { name: 't', welcome_message: '', overrides: {} }, 'o');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.savedMode.welcome_message).toBeUndefined();
      expect('welcome_message' in result.savedMode).toBe(false);
    }
  });

  it('leaves welcome_message unchanged when the caller omits it', () => {
    const orgModes = makeOrgModes({ name: 't', welcome_message: 'Keep me', overrides: {} });
    const result = upsertMode(orgModes, { name: 't', overrides: { identity: 'X' } }, 'o');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.savedMode.welcome_message).toBe('Keep me');
  });
});

describe('welcome_message view + clone (#311)', () => {
  it('round-trips welcome_message through GET (view) -> PUT (omit) -> GET (view)', () => {
    // GET: an authored mode surfaces welcome_message in the admin view.
    const stored: OrgModes['modes'][number] = {
      name: 't',
      welcome_message: 'Round trip',
      overrides: {},
    };
    expect(toMarkdownView(stored).welcome_message).toBe('Round trip');

    // PUT that omits welcome_message (the portal editor's normal save).
    const orgModes = makeOrgModes(stored);
    const result = upsertMode(orgModes, { name: 't', overrides: { identity: 'X' } }, 'o');
    expect(result.ok).toBe(true);

    // GET again: the copy is still present in the view, not silently dropped.
    if (result.ok) expect(toMarkdownView(result.savedMode).welcome_message).toBe('Round trip');
  });

  it('cloneMode copies welcome_message onto the clone', () => {
    const orgModes = makeOrgModes({
      name: 'src',
      welcome_message: 'Clone me',
      overrides: {},
    });
    const result = cloneMode(orgModes, 'src', 'dst');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.savedMode.welcome_message).toBe('Clone me');
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

describe('upsertMode - requires_group flag preservation', () => {
  it('preserves existing requires_group: true when caller omits the field', () => {
    const orgModes = makeOrgModes({ name: 't', requires_group: true, overrides: {} });
    const result = upsertMode(orgModes, { name: 't', overrides: { identity: 'X' } }, 'o');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.savedMode.requires_group).toBe(true);
  });

  it('preserves existing requires_group: false when caller omits the field', () => {
    const orgModes = makeOrgModes({ name: 't', requires_group: false, overrides: {} });
    const result = upsertMode(orgModes, { name: 't', overrides: { identity: 'X' } }, 'o');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.savedMode.requires_group).toBe(false);
  });

  it('updates requires_group when caller provides it', () => {
    const orgModes = makeOrgModes({ name: 't', requires_group: false, overrides: {} });
    const result = upsertMode(orgModes, { name: 't', requires_group: true, overrides: {} }, 'o');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.savedMode.requires_group).toBe(true);
  });

  it('persists requires_group on a brand-new mode', () => {
    const orgModes = makeOrgModes();
    const result = upsertMode(orgModes, { name: 'new', requires_group: true, overrides: {} }, 'o');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.savedMode.requires_group).toBe(true);
  });

  it('omits requires_group key on new mode when not supplied', () => {
    const orgModes = makeOrgModes();
    const result = upsertMode(orgModes, { name: 'new', overrides: {} }, 'o');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.savedMode.requires_group).toBeUndefined();
  });
});

// ─── Phase 1 of #200 — cross-shape upsert ──────────────────────────────────

describe('upsertMode - storage shape: new and same-shape', () => {
  it('persists a brand-new markdown-shape mode with its document field', () => {
    const orgModes = makeOrgModes();
    const result = upsertMode(orgModes, { name: 'new', document: '## Identity\n\nfresh\n' }, 'o');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.savedMode.document).toBe('## Identity\n\nfresh\n');
      expect(result.savedMode.overrides).toBeUndefined();
    }
  });

  it('wholesale-replaces an existing markdown-shape mode on document PUT', () => {
    const orgModes = makeOrgModes({ name: 't', document: '## Identity\n\nold\n' });
    const result = upsertMode(orgModes, { name: 't', document: '## Identity\n\nnew\n' }, 'o');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.savedMode.document).toBe('## Identity\n\nnew\n');
      expect(result.savedMode.overrides).toBeUndefined();
    }
  });

  it('strips control chars from incoming document on persist', () => {
    const orgModes = makeOrgModes();
    const result = upsertMode(
      orgModes,
      { name: 'new', document: '## Identity\n\nclean\x00here\n' },
      'o'
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.savedMode.document).not.toContain('\x00');
      expect(result.savedMode.document).toContain('cleanhere');
    }
  });
});

describe('upsertMode - storage shape: cross-shape transitions', () => {
  it('migrates a legacy mode to markdown shape on first markdown PUT', () => {
    const orgModes = makeOrgModes({
      name: 't',
      label: 'My Mode',
      published: true,
      overrides: { identity: 'old-slot' },
    });
    const result = upsertMode(
      orgModes,
      { name: 't', document: '## Identity\n\nfrom portal\n' },
      'o'
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.savedMode.document).toBe('## Identity\n\nfrom portal\n');
      expect(result.savedMode.overrides).toBeUndefined();
      // Scalar fields preserved across the shape migration.
      expect(result.savedMode.label).toBe('My Mode');
      expect(result.savedMode.published).toBe(true);
    }
  });

  it('reverts a markdown mode to legacy slot shape when a legacy PUT arrives', () => {
    const orgModes = makeOrgModes({ name: 't', document: '## Identity\n\nmd\n' });
    const result = upsertMode(orgModes, { name: 't', overrides: { identity: 'slotty' } }, 'o');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.savedMode.overrides).toEqual({ identity: 'slotty' });
      expect(result.savedMode.document).toBeUndefined();
    }
  });
});
