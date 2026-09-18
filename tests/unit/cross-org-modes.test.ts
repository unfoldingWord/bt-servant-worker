/**
 * Unit tests for the flat cross-org published-mode list (admin-portal#336).
 *
 * The chat path merges the request org's modes (bare, drafts included) with
 * every OTHER org's `published === true` modes, whose name and aliases are
 * qualified as `<orgslug>/<slug>`. `orgSlug` is derived at read time from the
 * raw org name; nothing is rewritten in KV.
 */
import { env } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OrgModes, PromptMode } from '../../src/types/prompt-overrides.js';
import { validateModeSelection } from '../../src/types/prompt-overrides.js';
import {
  MAX_MODES_KEY_PAGES,
  mergeCrossOrgModes,
  orgSlug,
  readAllPublishedModes,
} from '../../src/utils/cross-org-modes.js';
import type { RequestLogger } from '../../src/utils/logger.js';

type SpyLogger = RequestLogger & {
  log: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
};

function spyLogger(): SpyLogger {
  return {
    log: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as SpyLogger;
}

const published = (name: string, extra: Partial<PromptMode> = {}): PromptMode => ({
  name,
  label: name,
  published: true,
  overrides: {},
  ...extra,
});

const draft = (name: string): PromptMode => ({ name, label: name, overrides: {} });

// ─── orgSlug ──────────────────────────────────────────────────────────────────

describe('orgSlug', () => {
  it('lowercases and kebab-cases the three staging org names', () => {
    expect(orgSlug('Test Organization')).toBe('test-organization');
    expect(orgSlug('Bible Society of Jordan')).toBe('bible-society-of-jordan');
    expect(orgSlug('PBT')).toBe('pbt');
    expect(orgSlug('unfoldingWord')).toBe('unfoldingword');
  });

  it('collapses runs of non-alphanumerics (including `/`) into a single hyphen', () => {
    expect(orgSlug('a/b')).toBe('a-b');
    expect(orgSlug('Foo  &  Bar')).toBe('foo-bar');
    expect(orgSlug('x__y..z')).toBe('x-y-z');
  });

  it('trims whitespace and strips leading/trailing hyphens', () => {
    expect(orgSlug('  Haneen ')).toBe('haneen');
    expect(orgSlug('-Org-')).toBe('org');
    expect(orgSlug('(Org)')).toBe('org');
  });

  it('returns the empty string for a punctuation-only or blank name (caller skips it)', () => {
    expect(orgSlug('***')).toBe('');
    expect(orgSlug('   ')).toBe('');
    expect(orgSlug('')).toBe('');
  });

  it('is idempotent (a future #144 lowercasing migration yields the same slug)', () => {
    expect(orgSlug(orgSlug('Test Organization'))).toBe('test-organization');
    expect(orgSlug('Haneen')).toBe(orgSlug('haneen'));
  });
});

// ─── mergeCrossOrgModes ───────────────────────────────────────────────────────

const home: OrgModes = {
  modes: [published('translation-coach', { aliases: ['tc'] }), draft('home-draft')],
};

describe('mergeCrossOrgModes — home and foreign shapes', () => {
  it('keeps home modes exactly as stored: bare names, drafts included, no org field', () => {
    const merged = mergeCrossOrgModes(home, [], spyLogger());
    expect(merged.modes).toEqual(home.modes);
    expect(merged.modes.every((m) => !('org' in m))).toBe(true);
  });

  it('appends only published foreign modes, qualified with the org slug and carrying org', () => {
    const logger = spyLogger();
    const merged = mergeCrossOrgModes(
      home,
      [
        {
          org: 'PBT',
          modes: [
            published('obt-coach', { aliases: ['obt'], label: 'OBT Coach' }),
            draft('pbt-draft'),
          ],
        },
      ],
      logger
    );
    const names = merged.modes.map((m) => m.name);
    expect(names).toEqual(['translation-coach', 'home-draft', 'pbt/obt-coach']);
    const obt = merged.modes.find((m) => m.name === 'pbt/obt-coach');
    expect(obt).toMatchObject({
      name: 'pbt/obt-coach',
      aliases: ['pbt/obt'],
      label: 'OBT Coach',
      org: 'PBT',
      published: true,
    });
    expect(names).not.toContain('pbt/pbt-draft');
    expect(names).not.toContain('pbt-draft');
    expect(logger.warn).not.toHaveBeenCalled();
  });
});

describe('mergeCrossOrgModes — drafts and shared bare slugs', () => {
  it('treats published:false / missing as draft on foreign orgs', () => {
    const merged = mergeCrossOrgModes(
      { modes: [] },
      [{ org: 'X', modes: [published('a', { published: false }), { name: 'b', overrides: {} }] }],
      spyLogger()
    );
    expect(merged.modes).toEqual([]);
  });

  it('lets a foreign mode share a bare slug with home (Test Organization/uW translation-coach)', () => {
    const merged = mergeCrossOrgModes(
      home,
      [{ org: 'Test Organization', modes: [published('translation-coach')] }],
      spyLogger()
    );
    expect(merged.modes.map((m) => m.name)).toEqual([
      'translation-coach',
      'home-draft',
      'test-organization/translation-coach',
    ]);
  });
});

describe('mergeCrossOrgModes — ordering', () => {
  it('is deterministic: foreign orgs merge in sorted org-name order regardless of input order', () => {
    const a = mergeCrossOrgModes(
      { modes: [] },
      [
        { org: 'Zeta', modes: [published('m')] },
        { org: 'Alpha', modes: [published('m')] },
      ],
      spyLogger()
    );
    const b = mergeCrossOrgModes(
      { modes: [] },
      [
        { org: 'Alpha', modes: [published('m')] },
        { org: 'Zeta', modes: [published('m')] },
      ],
      spyLogger()
    );
    expect(a.modes.map((m) => m.name)).toEqual(['alpha/m', 'zeta/m']);
    expect(b.modes.map((m) => m.name)).toEqual(['alpha/m', 'zeta/m']);
  });
});

describe('mergeCrossOrgModes — collisions', () => {
  it('on a qualified-name collision (Haneen/haneen) the first in sorted order wins and the loser is logged', () => {
    const logger = spyLogger();
    const merged = mergeCrossOrgModes(
      { modes: [] },
      [
        { org: 'haneen', modes: [published('coach', { label: 'lower' })] },
        { org: 'Haneen', modes: [published('coach', { label: 'upper' })] },
      ],
      logger
    );
    // Sorted key order: 'Haneen' < 'haneen' (uppercase sorts first).
    expect(merged.modes).toHaveLength(1);
    expect(merged.modes[0]).toMatchObject({ name: 'haneen/coach', label: 'upper', org: 'Haneen' });
    expect(logger.warn).toHaveBeenCalledWith(
      'cross_org_mode_collision',
      expect.objectContaining({
        qualified_name: 'haneen/coach',
        org: 'haneen',
        winner_org: 'Haneen',
      })
    );
  });

  it('drops a colliding qualified alias but keeps the mode, logging the alias loser', () => {
    const logger = spyLogger();
    const merged = mergeCrossOrgModes(
      { modes: [] },
      [
        { org: 'Haneen', modes: [published('coach')] },
        { org: 'haneen', modes: [published('mentor', { aliases: ['coach', 'old-mentor'] })] },
      ],
      logger
    );
    expect(merged.modes.map((m) => m.name)).toEqual(['haneen/coach', 'haneen/mentor']);
    expect(merged.modes[1]?.aliases).toEqual(['haneen/old-mentor']);
    expect(logger.warn).toHaveBeenCalledWith(
      'cross_org_mode_collision',
      expect.objectContaining({ qualified_name: 'haneen/coach', kind: 'alias', org: 'haneen' })
    );
  });
});

describe('mergeCrossOrgModes — skips and purity', () => {
  it('skips an org whose slug is empty or reserved, with a log', () => {
    const logger = spyLogger();
    const merged = mergeCrossOrgModes(
      { modes: [] },
      [
        { org: '***', modes: [published('a')] },
        { org: '__global__', modes: [published('b')] },
      ],
      logger
    );
    expect(merged.modes).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(
      'cross_org_modes_org_skipped',
      expect.objectContaining({ org: '***', reason: 'empty_slug' })
    );
    expect(logger.warn).toHaveBeenCalledWith(
      'cross_org_modes_org_skipped',
      expect.objectContaining({ org: '__global__', reason: 'reserved' })
    );
  });

  it('never mutates the input mode objects', () => {
    const mode = published('obt-coach', { aliases: ['obt'] });
    mergeCrossOrgModes({ modes: [] }, [{ org: 'PBT', modes: [mode] }], spyLogger());
    expect(mode.name).toBe('obt-coach');
    expect(mode.aliases).toEqual(['obt']);
    expect('org' in mode).toBe(false);
  });
});

// ─── readAllPublishedModes against real (miniflare) KV ────────────────────────

/** Unique key prefix so leftovers from other suites (storage is not isolated) cannot bleed in. */
const HOME = 'u336-home';
const SEEDED_KEYS = [
  `${HOME}:modes`,
  'U336 PBT:modes',
  'u336-corrupt:modes',
  'u336-badshape:modes',
  'u336-null:modes',
  'u336-x:modes', // an org literally named `u336-x:modes` → prompt-overrides key `u336-x:modes`
  'u336-draft-only:modes',
];

async function seedNamespace(): Promise<void> {
  const kv = env.PROMPT_OVERRIDES;
  await kv.put(`${HOME}:modes`, JSON.stringify({ modes: [published('home-mode'), draft('hd')] }));
  await kv.put(
    'U336 PBT:modes',
    JSON.stringify({ modes: [published('obt-coach', { aliases: ['obt'] }), draft('pbt-draft')] })
  );
  await kv.put('u336-corrupt:modes', '{not json');
  await kv.put('u336-badshape:modes', JSON.stringify({ modes: 'nope' }));
  await kv.put('u336-null:modes', 'null');
  // A non-modes record whose KEY ends with `:modes` (org named `u336-x:modes`).
  await kv.put('u336-x:modes', JSON.stringify({ identity: 'org-level prompt overrides' }));
  await kv.put('u336-draft-only:modes', JSON.stringify({ modes: [draft('only-a-draft')] }));
}

describe('readAllPublishedModes (seeded miniflare KV)', () => {
  afterEach(async () => {
    await Promise.all(SEEDED_KEYS.map((k) => env.PROMPT_OVERRIDES.delete(k)));
  });

  it('returns home modes first (bare, drafts kept) plus every other org’s published modes, qualified', async () => {
    await seedNamespace();
    const logger = spyLogger();
    const merged = await readAllPublishedModes(env.PROMPT_OVERRIDES, HOME, logger);
    const names = merged.modes.map((m) => m.name);

    expect(names.slice(0, 2)).toEqual(['home-mode', 'hd']);
    expect(names).toContain('u336-pbt/obt-coach');
    expect(merged.modes.find((m) => m.name === 'u336-pbt/obt-coach')).toMatchObject({
      org: 'U336 PBT',
      aliases: ['u336-pbt/obt'],
    });
    // Foreign drafts never reach the DO.
    expect(names.some((n) => n.endsWith('/pbt-draft') || n.endsWith('/only-a-draft'))).toBe(false);
    // The home org is never merged as a foreign org.
    expect(names.some((n) => n.startsWith('u336-home/'))).toBe(false);
  });

  it('skips corrupt, null and non-modes-shaped keys with a log each, without failing the read', async () => {
    await seedNamespace();
    const logger = spyLogger();
    const merged = await readAllPublishedModes(env.PROMPT_OVERRIDES, HOME, logger);
    const names = merged.modes.map((m) => m.name);
    expect(names).toContain('u336-pbt/obt-coach');
    expect(names.some((n) => n.startsWith('u336-x'))).toBe(false);

    const errorKeys = logger.error.mock.calls.map((c) => (c[2] as { key: string }).key);
    expect(errorKeys).toContain('u336-corrupt:modes');
    const warnKeys = logger.warn.mock.calls
      .filter((c) => c[0] === 'cross_org_modes_invalid_shape')
      .map((c) => (c[1] as { key: string }).key);
    expect(warnKeys).toEqual(
      expect.arrayContaining(['u336-badshape:modes', 'u336-null:modes', 'u336-x:modes'])
    );
  });

  it('a home org with no modes key still receives the foreign published list', async () => {
    await seedNamespace();
    const merged = await readAllPublishedModes(env.PROMPT_OVERRIDES, 'u336-nobody', spyLogger());
    const names = merged.modes.map((m) => m.name);
    expect(names).toContain('u336-pbt/obt-coach');
    expect(names).toContain('u336-home/home-mode');
    expect(names).not.toContain('u336-home/hd');
  });
});

// ─── readAllPublishedModes against a fake KV (failure + paging) ───────────────

/** Values are stored as JSON text, exactly as KV holds them. */
function fakeKv(entries: Record<string, unknown>): KVNamespace & {
  get: ReturnType<typeof vi.fn>;
  list: ReturnType<typeof vi.fn>;
} {
  const store = new Map(Object.entries(entries).map(([k, v]) => [k, JSON.stringify(v)]));
  return {
    get: vi.fn(async (key: string, type?: string) => {
      const raw = store.get(key);
      if (raw === undefined) return null;
      return type === 'json' ? JSON.parse(raw) : raw;
    }),
    list: vi.fn(async () => ({
      keys: [...store.keys()].map((name) => ({ name })),
      list_complete: true,
      cacheStatus: null,
    })),
    put: vi.fn(),
    delete: vi.fn(),
  } as unknown as KVNamespace & { get: ReturnType<typeof vi.fn>; list: ReturnType<typeof vi.fn> };
}

describe('readAllPublishedModes (fake KV) — failure handling', () => {
  it('falls back to home-only when the key listing fails, logging the failure', async () => {
    const kv = fakeKv({
      'home:modes': { modes: [published('h')] },
      'Other:modes': { modes: [published('o')] },
    });
    kv.list.mockRejectedValueOnce(new Error('list down'));
    const logger = spyLogger();
    const merged = await readAllPublishedModes(kv, 'home', logger);
    expect(merged.modes.map((m) => m.name)).toEqual(['h']);
    expect(logger.error).toHaveBeenCalledWith(
      'cross_org_modes_list_failed',
      expect.any(Error),
      expect.anything()
    );
  });

  it('falls back to an empty home list when the home key read fails, still merging foreign modes', async () => {
    const kv = fakeKv({
      'home:modes': { modes: [published('h')] },
      'Other:modes': { modes: [published('o')] },
    });
    kv.get.mockImplementationOnce(async () => {
      throw new Error('home get down');
    });
    const logger = spyLogger();
    const merged = await readAllPublishedModes(kv, 'home', logger);
    expect(merged.modes.map((m) => m.name)).toEqual(['other/o']);
    expect(logger.error).toHaveBeenCalledWith(
      'org_modes_kv_read_error',
      expect.any(Error),
      expect.objectContaining({ key: 'home:modes' })
    );
  });
});

describe('readAllPublishedModes (fake KV) — record faults', () => {
  it('logs and treats a non-modes-shaped HOME record as empty, still merging foreign modes', async () => {
    const kv = fakeKv({
      'home:modes': { modes: 'nope' },
      'Other:modes': { modes: [published('o')] },
    });
    const logger = spyLogger();
    const merged = await readAllPublishedModes(kv, 'home', logger);
    expect(merged.modes.map((m) => m.name)).toEqual(['other/o']);
    expect(logger.warn).toHaveBeenCalledWith('org_modes_invalid_shape', { key: 'home:modes' });
  });

  it('skips a foreign key whose get fails, logging it, and keeps the others', async () => {
    const kv = fakeKv({
      'home:modes': { modes: [published('h')] },
      'A:modes': { modes: [published('a')] },
      'B:modes': { modes: [published('b')] },
    });
    kv.get.mockImplementation(async (key: string) => {
      if (key === 'A:modes') throw new Error('A down');
      const store: Record<string, unknown> = {
        'home:modes': { modes: [published('h')] },
        'B:modes': { modes: [published('b')] },
      };
      return store[key] ?? null;
    });
    const logger = spyLogger();
    const merged = await readAllPublishedModes(kv, 'home', logger);
    expect(merged.modes.map((m) => m.name)).toEqual(['h', 'b/b']);
    expect(logger.error).toHaveBeenCalledWith(
      'cross_org_modes_read_failed',
      expect.any(Error),
      expect.objectContaining({ key: 'A:modes' })
    );
  });
});

describe('readAllPublishedModes (fake KV) — key filtering and pagination', () => {
  it('only lists keys ending in `:modes`; org-level and language keys are never fetched', async () => {
    const kv = fakeKv({
      'home:modes': { modes: [published('h')] },
      Other: { identity: 'x' },
      'Other:languages': { languages: [] },
      'Other:modes': { modes: [published('o')] },
      __global__: [],
    });
    const merged = await readAllPublishedModes(kv, 'home', spyLogger());
    expect(merged.modes.map((m) => m.name)).toEqual(['h', 'other/o']);
    const fetched = kv.get.mock.calls.map((c) => c[0] as string).sort();
    expect(fetched).toEqual(['Other:modes', 'home:modes']);
  });

  it('follows list pagination until list_complete and bounds the page count', async () => {
    const kv = fakeKv({ 'home:modes': { modes: [published('h')] } });
    kv.list
      .mockResolvedValueOnce({ keys: [{ name: 'A:modes' }], list_complete: false, cursor: 'c1' })
      .mockResolvedValueOnce({ keys: [{ name: 'B:modes' }], list_complete: true });
    kv.get.mockImplementation(async (key: string) => {
      const store: Record<string, unknown> = {
        'home:modes': { modes: [published('h')] },
        'A:modes': { modes: [published('a')] },
        'B:modes': { modes: [published('b')] },
      };
      return store[key] ?? null;
    });
    const merged = await readAllPublishedModes(kv, 'home', spyLogger());
    expect(merged.modes.map((m) => m.name)).toEqual(['h', 'a/a', 'b/b']);
    expect(kv.list).toHaveBeenCalledTimes(2);
    expect(kv.list).toHaveBeenLastCalledWith({ limit: 1000, cursor: 'c1' });
  });

  it('stops after MAX_MODES_KEY_PAGES pages and logs the truncation', async () => {
    const kv = fakeKv({ 'home:modes': { modes: [published('h')] } });
    kv.list.mockResolvedValue({ keys: [], list_complete: false, cursor: 'again' });
    const logger = spyLogger();
    const merged = await readAllPublishedModes(kv, 'home', logger);
    expect(merged.modes.map((m) => m.name)).toEqual(['h']);
    expect(kv.list).toHaveBeenCalledTimes(MAX_MODES_KEY_PAGES);
    expect(logger.warn).toHaveBeenCalledWith(
      'cross_org_modes_list_truncated',
      expect.objectContaining({ pages: MAX_MODES_KEY_PAGES })
    );
  });
});

// ─── validateModeSelection (admin DO PUT /mode) ───────────────────────────────

describe('validateModeSelection', () => {
  it('accepts a bare mode slug exactly as validateModeName does', () => {
    expect(validateModeSelection('translation-coach')).toBeNull();
  });

  it('accepts an org-qualified selection `<orgslug>/<modeslug>`', () => {
    expect(validateModeSelection('pbt/obt-coach')).toBeNull();
    expect(validateModeSelection('test-organization/translation-coach')).toBeNull();
  });

  it('rejects a malformed org half', () => {
    expect(validateModeSelection('PBT/obt-coach')).not.toBeNull();
    expect(validateModeSelection('/obt-coach')).not.toBeNull();
    expect(validateModeSelection('-pbt/obt-coach')).not.toBeNull();
    expect(validateModeSelection('p bt/obt-coach')).not.toBeNull();
  });

  it('rejects a malformed mode half and extra separators', () => {
    expect(validateModeSelection('pbt/')).not.toBeNull();
    expect(validateModeSelection('pbt/OBT')).not.toBeNull();
    expect(validateModeSelection('pbt/obt/coach')).not.toBeNull();
  });

  it('rejects non-strings and empty strings', () => {
    expect(validateModeSelection(undefined)).not.toBeNull();
    expect(validateModeSelection(42)).not.toBeNull();
    expect(validateModeSelection('')).not.toBeNull();
  });
});
