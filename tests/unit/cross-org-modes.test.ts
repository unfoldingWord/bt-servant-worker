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
  MAX_FOREIGN_ORGS_PER_TURN,
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

describe('mergeCrossOrgModes — malformed foreign elements (never throws)', () => {
  it('skips a null or non-object element with a log and keeps the rest of that org', () => {
    const logger = spyLogger();
    const bad = [null, 'str'] as unknown as PromptMode[];
    const merged = mergeCrossOrgModes(
      { modes: [] },
      [{ org: 'PBT', modes: [...bad, published('ok')] }],
      logger
    );
    expect(merged.modes.map((m) => m.name)).toEqual(['pbt/ok']);
    expect(logger.warn).toHaveBeenCalledWith('cross_org_modes_invalid_shape', {
      org: 'PBT',
      index: 0,
      reason: 'mode_not_object',
    });
    expect(logger.warn).toHaveBeenCalledWith('cross_org_modes_invalid_shape', {
      org: 'PBT',
      index: 1,
      reason: 'mode_not_object',
    });
  });

  it('skips a published mode whose aliases is not an array (the admin PUT rejects it too)', () => {
    const logger = spyLogger();
    const merged = mergeCrossOrgModes(
      { modes: [] },
      [{ org: 'PBT', modes: [{ ...published('x'), aliases: 42 as unknown as string[] }] }],
      logger
    );
    expect(merged.modes).toHaveLength(0);
    expect(logger.warn).toHaveBeenCalledWith('cross_org_modes_invalid_shape', {
      org: 'PBT',
      index: 0,
      name: 'x',
      reason: 'Mode aliases must be an array of strings',
    });
  });
});

/**
 * Review P2 (#336): a foreign element that is a non-null object passed the
 * old guard and was merged verbatim, so a shape the admin PUT would reject
 * (`overrides: null`, `welcome_message: 1`) reached the DO. There
 * `getEffectiveOverrides` returns `null` (it tests `!== undefined`) and
 * `resolvePromptOverrides` throws on EVERY later turn once the mode is the
 * user's `selected_mode`; `maybeBuildModeWelcome` calls `.trim()` on the
 * welcome copy and throws on first contact. The read-time guard must hold a
 * foreign element to the storage rules (`validatePromptMode`).
 */
describe('mergeCrossOrgModes — foreign elements the admin PUT would reject (review P2)', () => {
  const only = (mode: unknown, logger = spyLogger()) =>
    mergeCrossOrgModes({ modes: [] }, [{ org: 'PBT', modes: [mode as PromptMode] }], logger);

  it('skips a published mode whose overrides is null, naming org, mode and reason', () => {
    const logger = spyLogger();
    const merged = only({ name: 'obt-coach', published: true, overrides: null }, logger);
    expect(merged.modes).toHaveLength(0);
    expect(logger.warn).toHaveBeenCalledWith('cross_org_modes_invalid_shape', {
      org: 'PBT',
      index: 0,
      name: 'obt-coach',
      reason: 'Mode overrides invalid: Prompt overrides must be a JSON object',
    });
  });

  it('skips a published mode whose welcome_message is not a string (1, {}, true)', () => {
    for (const welcome_message of [1, {}, true]) {
      const logger = spyLogger();
      const merged = only({ ...published('w'), welcome_message }, logger);
      expect(merged.modes, `welcome_message=${JSON.stringify(welcome_message)}`).toHaveLength(0);
      expect(logger.warn).toHaveBeenCalledWith('cross_org_modes_invalid_shape', {
        org: 'PBT',
        index: 0,
        name: 'w',
        reason: 'Mode welcome_message must be a string',
      });
    }
  });

  it('skips a non-string document, a non-string name and a missing name', () => {
    expect(only({ name: 'd', published: true, document: 7 }).modes).toHaveLength(0);
    expect(only({ name: 9, published: true, overrides: {} }).modes).toHaveLength(0);
    expect(only({ published: true, overrides: {} }).modes).toHaveLength(0);
  });

  it('still merges a well-formed mode with a null welcome_message or a string document', () => {
    expect(only({ ...published('n'), welcome_message: null }).modes.map((m) => m.name)).toEqual([
      'pbt/n',
    ]);
    expect(
      only({ name: 'd', published: true, document: '# Identity\n\nhi' }).modes.map((m) => m.name)
    ).toEqual(['pbt/d']);
  });

  it('does not validate (or log) foreign drafts — they are dropped before the shape check', () => {
    const logger = spyLogger();
    expect(only({ name: 'draft', overrides: null }, logger).modes).toHaveLength(0);
    expect(logger.warn).not.toHaveBeenCalled();
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

describe('readAllPublishedModes (seeded miniflare KV) — malformed foreign elements', () => {
  const ELEM_KEYS = [`${HOME}:modes`, 'u336-elem:modes'];
  afterEach(async () => {
    await Promise.all(ELEM_KEYS.map((k) => env.PROMPT_OVERRIDES.delete(k)));
  });

  it('resolves (never rejects) when a foreign record holds a null element or non-array aliases', async () => {
    const kv = env.PROMPT_OVERRIDES;
    await kv.put(`${HOME}:modes`, JSON.stringify({ modes: [published('home-mode')] }));
    // Not producible via the admin PUT (validated); a manual KV write can leave this shape.
    await kv.put(
      'u336-elem:modes',
      JSON.stringify({
        modes: [null, { ...published('bad-aliases'), aliases: 42 }, published('survivor')],
      })
    );
    const logger = spyLogger();
    const merged = await readAllPublishedModes(kv, HOME, logger);
    expect(merged.modes.map((m) => m.name)).toEqual(['home-mode', 'u336-elem/survivor']);
    expect(logger.warn).toHaveBeenCalledWith('cross_org_modes_invalid_shape', {
      org: 'u336-elem',
      index: 0,
      reason: 'mode_not_object',
    });
    expect(logger.warn).toHaveBeenCalledWith('cross_org_modes_invalid_shape', {
      org: 'u336-elem',
      index: 1,
      name: 'bad-aliases',
      reason: 'Mode aliases must be an array of strings',
    });
  });
});

describe('readAllPublishedModes (seeded miniflare KV) — elements the admin PUT would reject', () => {
  const ELEM_KEYS = [`${HOME}:modes`, 'u336-elem:modes'];
  afterEach(async () => {
    await Promise.all(ELEM_KEYS.map((k) => env.PROMPT_OVERRIDES.delete(k)));
  });

  it('drops a published element with overrides:null or a non-string welcome_message (review P2)', async () => {
    const kv = env.PROMPT_OVERRIDES;
    await kv.put(`${HOME}:modes`, JSON.stringify({ modes: [published('home-mode')] }));
    await kv.put(
      'u336-elem:modes',
      JSON.stringify({
        modes: [
          { name: 'null-overrides', published: true, overrides: null },
          { ...published('bad-welcome'), welcome_message: 1 },
          published('survivor'),
        ],
      })
    );
    const logger = spyLogger();
    const merged = await readAllPublishedModes(kv, HOME, logger);
    expect(merged.modes.map((m) => m.name)).toEqual(['home-mode', 'u336-elem/survivor']);
    const skipped = logger.warn.mock.calls
      .filter((c) => c[0] === 'cross_org_modes_invalid_shape')
      .map((c) => (c[1] as { name?: string; reason: string }).name);
    expect(skipped).toEqual(['null-overrides', 'bad-welcome']);
  });
});

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

describe('readAllPublishedModes (fake KV) — per-turn foreign org cap', () => {
  it('reads at most MAX_FOREIGN_ORGS_PER_TURN foreign orgs, in sorted key order, and logs the cap', async () => {
    const entries: Record<string, unknown> = { 'home:modes': { modes: [published('h')] } };
    const total = MAX_FOREIGN_ORGS_PER_TURN + 3;
    for (let i = 0; i < total; i++) {
      const org = `org${String(i).padStart(3, '0')}`;
      entries[`${org}:modes`] = { modes: [published(`m${i}`)] };
    }
    const kv = fakeKv(entries);
    const logger = spyLogger();
    const merged = await readAllPublishedModes(kv, 'home', logger);
    const foreignReads = kv.get.mock.calls
      .map((c) => c[0] as string)
      .filter((k) => k !== 'home:modes');
    expect(foreignReads).toHaveLength(MAX_FOREIGN_ORGS_PER_TURN);
    expect(foreignReads).toEqual([...foreignReads].sort());
    expect(merged.modes).toHaveLength(1 + MAX_FOREIGN_ORGS_PER_TURN);
    expect(merged.modes.at(-1)?.name).toBe(
      `org${String(MAX_FOREIGN_ORGS_PER_TURN - 1).padStart(3, '0')}/m${MAX_FOREIGN_ORGS_PER_TURN - 1}`
    );
    expect(logger.warn).toHaveBeenCalledWith(
      'cross_org_modes_foreign_capped',
      expect.objectContaining({ total, cap: MAX_FOREIGN_ORGS_PER_TURN })
    );
  });
});

/**
 * Review P2 (#336): the cap is applied to RAW sorted key names before any key
 * is read, so draft-only and empty orgs count against it and a publishing
 * org whose key sorts beyond the window is invisible on the chat path. The
 * cap stays (it bounds KV operations per invocation); the failure must at
 * least be observable — the warn names the dropped keys — and less likely
 * (window of 50). The follow-up for larger tenant counts is an index of
 * publishing orgs, not a larger cap.
 */
describe('readAllPublishedModes (fake KV) — cap observability (review P2)', () => {
  function seededBeyondCap(extra: number): ReturnType<typeof fakeKv> {
    const entries: Record<string, unknown> = { 'home:modes': { modes: [published('h')] } };
    for (let i = 0; i < MAX_FOREIGN_ORGS_PER_TURN + extra; i++) {
      entries[`org${String(i).padStart(3, '0')}:modes`] = { modes: [] };
    }
    return fakeKv(entries);
  }

  it('holds a window of 50 foreign orgs per turn', () => {
    expect(MAX_FOREIGN_ORGS_PER_TURN).toBe(50);
  });

  it('names every dropped key in the capped warn so the invisible org is findable in logs', async () => {
    const logger = spyLogger();
    await readAllPublishedModes(seededBeyondCap(3), 'home', logger);
    const dropped = [0, 1, 2].map(
      (i) => `org${String(MAX_FOREIGN_ORGS_PER_TURN + i).padStart(3, '0')}:modes`
    );
    expect(logger.warn).toHaveBeenCalledWith('cross_org_modes_foreign_capped', {
      total: MAX_FOREIGN_ORGS_PER_TURN + 3,
      cap: MAX_FOREIGN_ORGS_PER_TURN,
      dropped_count: 3,
      dropped,
    });
  });

  it('bounds the named keys at 20 while still reporting the full dropped count', async () => {
    const logger = spyLogger();
    await readAllPublishedModes(seededBeyondCap(25), 'home', logger);
    const call = logger.warn.mock.calls.find((c) => c[0] === 'cross_org_modes_foreign_capped');
    const payload = call?.[1] as { dropped_count: number; dropped: string[] };
    expect(payload.dropped_count).toBe(25);
    expect(payload.dropped).toHaveLength(20);
    expect(payload.dropped[0]).toBe(
      `org${String(MAX_FOREIGN_ORGS_PER_TURN).padStart(3, '0')}:modes`
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
