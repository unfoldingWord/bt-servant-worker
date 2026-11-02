/**
 * Unit tests for the authoritative share-code resolver (admin-portal#345).
 *
 * The resolver runs the chat path's own read, merge and classifier over a KV,
 * so these tests seed a fake KV (deterministic listing, no keys from other
 * test files) and assert what `#<code>` really opens from the home org.
 */
import { env } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import type { PromptMode } from '../../src/types/prompt-overrides.js';
import { chatTriggerModeOptions } from '../../src/types/prompt-overrides.js';
import { MAX_FOREIGN_ORGS_PER_TURN } from '../../src/utils/cross-org-modes.js';
import type { RequestLogger } from '../../src/utils/logger.js';
import {
  invalidOrgError,
  loadShareCodeTarget,
  resolveModeShareCode,
  ShareCodeUnavailableError,
} from '../../src/utils/mode-share-code.js';

const HOME = 'unfoldingWord';

function spyLogger(): RequestLogger {
  return { log: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as RequestLogger;
}

const published = (name: string, extra: Partial<PromptMode> = {}): PromptMode => ({
  name,
  label: name,
  published: true,
  overrides: {},
  ...extra,
});

interface FakeKvOptions {
  listFails?: boolean;
  /** Keys whose get throws. */
  failGet?: string[];
  /** Keys present in the store but missing from the listing (list lag). */
  hideFromList?: string[];
  /** Keys stored as raw, non-JSON text (corrupt records). */
  rawText?: Record<string, string>;
  /** Do not seed an empty home record. */
  noHome?: boolean;
}

type FakeKv = KVNamespace & { get: ReturnType<typeof vi.fn>; list: ReturnType<typeof vi.fn> };

/**
 * Values are stored as JSON text, exactly as KV holds them. The home org gets
 * an empty modes record unless the test seeds one or passes `noHome`.
 */
function fakeKv(entries: Record<string, unknown>, opts: FakeKvOptions = {}): FakeKv {
  const seeded = opts.noHome === true ? entries : { [`${HOME}:modes`]: { modes: [] }, ...entries };
  const store = new Map(Object.entries(seeded).map(([k, v]) => [k, JSON.stringify(v)]));
  for (const [k, raw] of Object.entries(opts.rawText ?? {})) store.set(k, raw);
  return {
    get: vi.fn(async (key: string, type?: string) => {
      if (opts.failGet?.includes(key) === true) throw new Error(`kv get down: ${key}`);
      const raw = store.get(key);
      if (raw === undefined) return null;
      return type === 'json' ? JSON.parse(raw) : raw;
    }),
    list: vi.fn(async () => {
      if (opts.listFails === true) throw new Error('kv list down');
      const keys = [...store.keys()].filter((k) => opts.hideFromList?.includes(k) !== true);
      return { keys: keys.map((name) => ({ name })), list_complete: true };
    }),
    put: vi.fn(),
    delete: vi.fn(),
  } as unknown as FakeKv;
}

/** Resolve `modeName` in `org` exactly as the route does: load the snapshot, then resolve. */
async function resolve(kv: KVNamespace, org: string, modeName: string, homeOrg = HOME) {
  const loaded = await loadShareCodeTarget(kv, { org, homeOrg, modeName }, spyLogger());
  if (loaded.kind !== 'ok') throw new Error(`test setup: ${loaded.kind}`);
  return resolveModeShareCode(kv, loaded.target, spyLogger());
}

/** The detail a ShareCodeUnavailableError carries, or a failure if none was thrown. */
async function unavailableDetail(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ShareCodeUnavailableError) return error.detail;
    throw error;
  }
  throw new Error('expected ShareCodeUnavailableError');
}

describe('resolveModeShareCode — resolving codes', () => {
  it('a published home mode gets its bare slug and resolves', async () => {
    const kv = fakeKv({ [`${HOME}:modes`]: { modes: [published('obt-coach')] } });
    expect(await resolve(kv, HOME, 'obt-coach')).toEqual({
      code: 'obt-coach',
      resolves: true,
      resolved_org: HOME,
    });
  });

  it('a published foreign mode gets `<orgslug>/<slug>` and resolves to that org', async () => {
    const kv = fakeKv({
      [`${HOME}:modes`]: { modes: [published('obt-coach')] },
      'PBT:modes': { modes: [published('obt-coach')] },
    });
    expect(await resolve(kv, 'PBT', 'obt-coach')).toEqual({
      code: 'pbt/obt-coach',
      resolves: true,
      resolved_org: 'PBT',
    });
  });
});

describe('resolveModeShareCode — home/foreign by exact key', () => {
  it('home is the EXACT key: a differently-cased org is foreign and gets a qualified code', async () => {
    const kv = fakeKv({
      [`${HOME}:modes`]: { modes: [] },
      'unfoldingword:modes': { modes: [published('x')] },
    });
    expect(await resolve(kv, 'unfoldingword', 'x')).toEqual({
      code: 'unfoldingword/x',
      resolves: true,
      resolved_org: 'unfoldingword',
    });
  });

  it('a padded legacy org key is foreign under its trimmed slug', async () => {
    const kv = fakeKv({ ' PBT:modes': { modes: [published('x')] } });
    expect(await resolve(kv, ' PBT', 'x')).toEqual({
      code: 'pbt/x',
      resolves: true,
      resolved_org: ' PBT',
    });
  });

  it('`pbt/default` is not a clear token, so a foreign `default` mode resolves', async () => {
    const kv = fakeKv({ 'PBT:modes': { modes: [published('default')] } });
    expect(await resolve(kv, 'PBT', 'default')).toEqual({
      code: 'pbt/default',
      resolves: true,
      resolved_org: 'PBT',
    });
  });

  it('an org slug longer than 64 chars follows the chat path: merged, matched, resolves', async () => {
    const longOrg = 'a'.repeat(70);
    const kv = fakeKv({ [`${longOrg}:modes`]: { modes: [published('x')] } });
    expect(await resolve(kv, longOrg, 'x')).toEqual({
      code: `${longOrg}/x`,
      resolves: true,
      resolved_org: longOrg,
    });
  });
});

describe('resolveModeShareCode — read cost', () => {
  it('a home target needs no cross-org read: one get, no listing', async () => {
    const kv = fakeKv({ [`${HOME}:modes`]: { modes: [published('x')] } }, { listFails: true });
    expect((await resolve(kv, HOME, 'x')).resolves).toBe(true);
    expect(kv.list).not.toHaveBeenCalled();
    expect(kv.get).toHaveBeenCalledTimes(1);
  });

  it('a foreign target reads its own record once (the snapshot is reused)', async () => {
    const kv = fakeKv({ 'PBT:modes': { modes: [published('x')] } });
    expect((await resolve(kv, 'PBT', 'x')).resolves).toBe(true);
    const targetGets = kv.get.mock.calls.filter(([key]) => key === 'PBT:modes');
    const homeGets = kv.get.mock.calls.filter(([key]) => key === `${HOME}:modes`);
    expect(targetGets).toHaveLength(1);
    expect(homeGets).toHaveLength(1);
  });
});

describe('resolveModeShareCode — codes that do not resolve', () => {
  it('a home draft gets its would-be code, resolves=false, reason draft', async () => {
    const kv = fakeKv({ [`${HOME}:modes`]: { modes: [{ name: 'wip', overrides: {} }] } });
    expect(await resolve(kv, HOME, 'wip')).toEqual({
      code: 'wip',
      resolves: false,
      reason: 'draft',
    });
  });

  it('a foreign draft gets its would-be qualified code, reason draft', async () => {
    const kv = fakeKv({ 'PBT:modes': { modes: [{ name: 'wip', overrides: {} }] } });
    expect(await resolve(kv, 'PBT', 'wip')).toEqual({
      code: 'pbt/wip',
      resolves: false,
      reason: 'draft',
    });
  });

  it('a requires_group mode is hidden in a private WhatsApp chat', async () => {
    const kv = fakeKv({
      [`${HOME}:modes`]: { modes: [published('group-only', { requires_group: true })] },
    });
    expect(await resolve(kv, HOME, 'group-only')).toEqual({
      code: 'group-only',
      resolves: false,
      reason: 'requires_group',
    });
  });
});

describe('resolveModeShareCode — reserved tokens and collisions', () => {
  it('a home mode whose slug is a clear token is reserved (the classifier clears instead)', async () => {
    const kv = fakeKv({ [`${HOME}:modes`]: { modes: [published('default')] } });
    expect(await resolve(kv, HOME, 'default')).toEqual({
      code: 'default',
      resolves: false,
      reason: 'reserved',
    });
  });

  it('slug collision: the first raw key in sort order wins, the loser reports collision', async () => {
    const kv = fakeKv({
      'PBT:modes': { modes: [published('obt-coach')] },
      'pbt:modes': { modes: [published('obt-coach')] },
    });
    // 'PBT' < 'pbt' in code-unit order, so PBT claims `pbt/obt-coach`.
    expect(await resolve(kv, 'PBT', 'obt-coach')).toMatchObject({
      resolves: true,
      resolved_org: 'PBT',
    });
    expect(await resolve(kv, 'pbt', 'obt-coach')).toEqual({
      code: 'pbt/obt-coach',
      resolves: false,
      reason: 'collision',
      resolved_org: 'PBT',
    });
  });
});

describe('resolveModeShareCode — capped and skipped orgs', () => {
  it('an org beyond the per-turn cap is capped, and the code reports who would steal it', async () => {
    const fillers = Object.fromEntries(
      Array.from({ length: MAX_FOREIGN_ORGS_PER_TURN }, (_, i) => [
        `Q${String(i).padStart(2, '0')}:modes`,
        { modes: [] },
      ])
    );
    const kv = fakeKv({
      ...fillers,
      // Inside the window: 'PBT' sorts first. Its similar name prefix-matches the token.
      'PBT:modes': { modes: [published('obt-coach-v2')] },
      // Outside the window: 'pbt' sorts after every 'Q..' key.
      'pbt:modes': { modes: [published('obt-coach')] },
    });
    expect(await resolve(kv, 'pbt', 'obt-coach')).toEqual({
      code: 'pbt/obt-coach',
      resolves: false,
      reason: 'capped',
      resolved_org: 'PBT',
    });
  });

  it('a capped org with no look-alike reports capped without resolved_org', async () => {
    const fillers = Object.fromEntries(
      Array.from({ length: MAX_FOREIGN_ORGS_PER_TURN }, (_, i) => [
        `a${String(i).padStart(2, '0')}:modes`,
        { modes: [] },
      ])
    );
    const kv = fakeKv({ ...fillers, 'zzz:modes': { modes: [published('x')] } });
    expect(await resolve(kv, 'zzz', 'x')).toEqual({
      code: 'zzz/x',
      resolves: false,
      reason: 'capped',
    });
  });

  it('an org whose name slugs to empty is org_skipped with no code', async () => {
    const kv = fakeKv({ '***:modes': { modes: [published('x')] } });
    expect(await resolve(kv, '***', 'x')).toEqual({
      code: null,
      resolves: false,
      reason: 'org_skipped',
    });
  });
});

describe('resolveModeShareCode — prefix/fuzzy stealing', () => {
  it('prefix stealing: a malformed target reports invalid_mode and names the look-alike it opens', async () => {
    const kv = fakeKv({
      'PBT:modes': { modes: [published('obt-coach-v2')] },
      // Published but malformed: the shared guard drops it, so `pbt/obt-coach`
      // is missing and the classifier's prefix tier picks PBT's look-alike.
      'pbt:modes': { modes: [published('obt-coach', { welcome_message: 1 as unknown as string })] },
    });
    expect(await resolve(kv, 'pbt', 'obt-coach')).toEqual({
      code: 'pbt/obt-coach',
      resolves: false,
      reason: 'invalid_mode',
      resolved_org: 'PBT',
    });
  });

  it('fuzzy stealing is caught the same way', async () => {
    const kv = fakeKv({
      'PBT:modes': { modes: [published('obt-coahc')] },
      'pbt:modes': { modes: [published('obt-coach', { welcome_message: 1 as unknown as string })] },
    });
    expect(await resolve(kv, 'pbt', 'obt-coach')).toMatchObject({
      resolves: false,
      reason: 'invalid_mode',
      resolved_org: 'PBT',
    });
  });

  it('a malformed target with no look-alike opens nothing (no resolved_org)', async () => {
    const kv = fakeKv({
      'pbt:modes': { modes: [published('obt-coach', { welcome_message: 1 as unknown as string })] },
    });
    expect(await resolve(kv, 'pbt', 'obt-coach')).toEqual({
      code: 'pbt/obt-coach',
      resolves: false,
      reason: 'invalid_mode',
    });
  });
});

describe('resolveModeShareCode — miss explanation order (cap, shape, then collision)', () => {
  it('a capped target whose name another org also claims is capped, not collision', async () => {
    const fillers = Object.fromEntries(
      Array.from({ length: MAX_FOREIGN_ORGS_PER_TURN }, (_, i) => [
        `Q${String(i).padStart(2, '0')}:modes`,
        { modes: [] },
      ])
    );
    const kv = fakeKv({
      ...fillers,
      'PBT:modes': { modes: [published('x')] },
      'pbt:modes': { modes: [published('x')] },
    });
    expect(await resolve(kv, 'pbt', 'x')).toEqual({
      code: 'pbt/x',
      resolves: false,
      reason: 'capped',
      resolved_org: 'PBT',
    });
  });

  it('a malformed target whose name a LATER org claims is invalid_mode, not collision', async () => {
    const kv = fakeKv({
      // PBT sorts first but its element fails the guard, so it claims nothing;
      // pbt then claims `pbt/x`.
      'PBT:modes': {
        modes: [published('x', { overrides: null as unknown as Record<string, string> })],
      },
      'pbt:modes': { modes: [published('x')] },
    });
    expect(await resolve(kv, 'PBT', 'x')).toEqual({
      code: 'pbt/x',
      resolves: false,
      reason: 'invalid_mode',
      resolved_org: 'pbt',
    });
  });
});

describe('resolveModeShareCode — the whole message must be the token', () => {
  it('a stored name with a space never resolves: `#obt coach` selects `obt` and leaves `coach`', async () => {
    const kv = fakeKv({
      [`${HOME}:modes`]: { modes: [published('obt coach'), published('obt')] },
    });
    expect(await resolve(kv, HOME, 'obt coach')).toEqual({
      code: 'obt coach',
      resolves: false,
      reason: 'invalid_mode',
      resolved_org: HOME,
    });
  });
});

describe('resolveModeShareCode — degraded reads', () => {
  it('a failed key listing makes a foreign answer unavailable (list_failed)', async () => {
    const kv = fakeKv({ 'PBT:modes': { modes: [published('x')] } }, { listFails: true });
    expect(await unavailableDetail(resolve(kv, 'PBT', 'x'))).toBe('list_failed');
  });

  it('a failed get of a same-slug org could hide a collision winner (read_failed)', async () => {
    const kv = fakeKv(
      { 'PBT:modes': { modes: [published('x')] }, 'pbt:modes': { modes: [published('x')] } },
      { failGet: ['PBT:modes'] }
    );
    expect(await unavailableDetail(resolve(kv, 'pbt', 'x'))).toBe('read_failed');
  });

  it('a failed get could hide the look-alike behind a not_found (read_failed)', async () => {
    const kv = fakeKv(
      {
        'other:modes': { modes: [published('y')] },
        'pbt:modes': { modes: [published('x', { welcome_message: 1 as unknown as string })] },
      },
      { failGet: ['other:modes'] }
    );
    expect(await unavailableDetail(resolve(kv, 'pbt', 'x'))).toBe('read_failed');
  });

  it('a failed get of an unrelated org does not block a resolving answer', async () => {
    const kv = fakeKv(
      { 'other:modes': { modes: [published('y')] }, 'pbt:modes': { modes: [published('x')] } },
      { failGet: ['other:modes'] }
    );
    expect(await resolve(kv, 'pbt', 'x')).toMatchObject({ resolves: true, resolved_org: 'pbt' });
  });

  it('a record a complete listing does not show yet is listing_lag, not not_found', async () => {
    const kv = fakeKv(
      { 'pbt:modes': { modes: [published('x')] } },
      { hideFromList: ['pbt:modes'] }
    );
    expect(await unavailableDetail(resolve(kv, 'pbt', 'x'))).toBe('listing_lag');
  });
});

describe('loadShareCodeTarget', () => {
  const load = (kv: KVNamespace, org: string, modeName: string, homeOrg = HOME) =>
    loadShareCodeTarget(kv, { org, homeOrg, modeName }, spyLogger());

  it('a failed get of the target record is read_failed', async () => {
    const target = fakeKv({ 'pbt:modes': { modes: [published('x')] } }, { failGet: ['pbt:modes'] });
    expect(await unavailableDetail(load(target, 'pbt', 'x'))).toBe('read_failed');
  });

  it('a failed home get is read_failed for a HOME target', async () => {
    const kv = fakeKv(
      { [`${HOME}:modes`]: { modes: [published('x')] } },
      { failGet: [`${HOME}:modes`] }
    );
    expect(await unavailableDetail(load(kv, HOME, 'x'))).toBe('read_failed');
  });

  it('a failed home get degrades to an empty home for a FOREIGN target (home_has_modes unknown)', async () => {
    const kv = fakeKv({ 'pbt:modes': { modes: [published('x')] } }, { failGet: [`${HOME}:modes`] });
    const loaded = await load(kv, 'pbt', 'x');
    expect(loaded.kind).toBe('ok');
    if (loaded.kind !== 'ok') return;
    expect(loaded.homeHasModes).toBeUndefined();
    expect(await resolveModeShareCode(kv, loaded.target, spyLogger())).toMatchObject({
      code: 'pbt/x',
      resolves: true,
    });
  });

  it('an absent home record is an empty home, as on the chat path (home_has_modes false)', async () => {
    const kv = fakeKv({ 'pbt:modes': { modes: [published('x')] } }, { noHome: true });
    const loaded = await load(kv, 'pbt', 'x');
    expect(loaded).toMatchObject({ kind: 'ok', homeHasModes: false });
    expect(await resolve(kv, 'pbt', 'x')).toMatchObject({ code: 'pbt/x', resolves: true });
  });

  it('home_has_modes is true when the home record exists', async () => {
    const kv = fakeKv({ 'pbt:modes': { modes: [published('x')] } });
    expect(await load(kv, 'pbt', 'x')).toMatchObject({ kind: 'ok', homeHasModes: true });
  });
});

describe('loadShareCodeTarget — corrupt records', () => {
  const load = (kv: KVNamespace, org: string, modeName: string, homeOrg = HOME) =>
    loadShareCodeTarget(kv, { org, homeOrg, modeName }, spyLogger());

  it('a corrupt (non-JSON) target record is corrupt_record, not a retryable failure', async () => {
    const kv = fakeKv({}, { rawText: { 'pbt:modes': '{not json' } });
    expect(await load(kv, 'pbt', 'x')).toEqual({ kind: 'corrupt_record', key: 'pbt:modes' });
  });

  it('real KV: a non-JSON value is told apart from a transport error', async () => {
    await env.PROMPT_OVERRIDES.put('u345-corrupt:modes', '{not json');
    try {
      const loaded = await loadShareCodeTarget(
        env.PROMPT_OVERRIDES,
        { org: 'u345-corrupt', homeOrg: 'u345-corrupt', modeName: 'x' },
        spyLogger()
      );
      expect(loaded).toEqual({ kind: 'corrupt_record', key: 'u345-corrupt:modes' });
    } finally {
      await env.PROMPT_OVERRIDES.delete('u345-corrupt:modes');
    }
  });

  it('a corrupt home record is an empty home, as the chat path reads it', async () => {
    const kv = fakeKv(
      { 'pbt:modes': { modes: [published('x')] } },
      { noHome: true, rawText: { [`${HOME}:modes`]: '{not json' } }
    );
    expect(await load(kv, 'pbt', 'x')).toMatchObject({ kind: 'ok', homeHasModes: false });
    expect(await resolve(kv, 'pbt', 'x')).toMatchObject({ resolves: true });
  });

  it('an unknown org or mode is mode_not_found', async () => {
    const kv = fakeKv({ 'pbt:modes': { modes: [published('x')] } });
    expect(await load(kv, 'nobody', 'x')).toEqual({ kind: 'mode_not_found' });
    expect(await load(kv, 'pbt', 'nope')).toEqual({ kind: 'mode_not_found' });
  });

  it('malformed elements (null, primitive, non-array aliases) are skipped, not dereferenced', async () => {
    const kv = fakeKv({
      'pbt:modes': { modes: [null, 7, { name: 'bad', aliases: 5 }, published('x')] },
    });
    const loaded = await load(kv, 'pbt', 'x');
    expect(loaded.kind).toBe('ok');
    expect(await resolve(kv, 'pbt', 'x')).toMatchObject({ resolves: true });
  });

  it('a home record with a null element still resolves a home target', async () => {
    const kv = fakeKv({ [`${HOME}:modes`]: { modes: [null, published('x')] } });
    expect(await resolve(kv, HOME, 'x')).toMatchObject({ code: 'x', resolves: true });
  });
});

describe('resolveModeShareCode — malformed elements', () => {
  it('a null home element does not crash a FOREIGN target', async () => {
    const kv = fakeKv({
      [`${HOME}:modes`]: { modes: [null, published('h')] },
      'pbt:modes': { modes: [published('x')] },
    });
    expect(await resolve(kv, 'pbt', 'x')).toMatchObject({ code: 'pbt/x', resolves: true });
  });

  it('an element without a string name is skipped', async () => {
    const kv = fakeKv({
      [`${HOME}:modes`]: { modes: [{ name: 5, published: true }, published('x')] },
    });
    expect(await resolve(kv, HOME, 'x')).toMatchObject({ code: 'x', resolves: true });
  });

  it('`aliases: null` fails the shared guard, so the mode is invalid_mode (chat never sees it)', async () => {
    const kv = fakeKv({
      [`${HOME}:modes`]: {
        modes: [
          published('x', { aliases: null as unknown as string[] }),
          published('far-away-mode'),
        ],
      },
    });
    expect(await resolve(kv, HOME, 'x')).toEqual({
      code: 'x',
      resolves: false,
      reason: 'invalid_mode',
    });
  });

  it('`overrides: null` on a home mode is invalid_mode; its neighbours still resolve', async () => {
    const kv = fakeKv({
      [`${HOME}:modes`]: {
        modes: [
          published('x', { overrides: null as unknown as Record<string, string> }),
          published('y'),
        ],
      },
    });
    expect(await resolve(kv, HOME, 'x')).toMatchObject({ resolves: false, reason: 'invalid_mode' });
    expect(await resolve(kv, HOME, 'y')).toMatchObject({ resolves: true });
  });

  it('a corrupt foreign org is skipped like on the chat path, not a read failure', async () => {
    const kv = fakeKv(
      { 'pbt:modes': { modes: [published('x')] } },
      { rawText: { 'PBT:modes': '{not json' } }
    );
    expect(await resolve(kv, 'pbt', 'x')).toMatchObject({ resolves: true, resolved_org: 'pbt' });
  });
});

describe('resolveModeShareCode — failure impact is judged on the raw match', () => {
  it('a same-slug failure that sorts AFTER the target cannot pre-empt it', async () => {
    const kv = fakeKv(
      { 'PBT:modes': { modes: [published('x')] }, 'pbt:modes': { modes: [published('x')] } },
      { failGet: ['pbt:modes'] }
    );
    // 'PBT' < 'pbt': PBT claims `pbt/x` first even if pbt had been read.
    expect(await resolve(kv, 'PBT', 'x')).toMatchObject({ resolves: true, resolved_org: 'PBT' });
  });

  it('a capped target with a failed org is unavailable (the look-alike could be there)', async () => {
    const fillers = Object.fromEntries(
      Array.from({ length: MAX_FOREIGN_ORGS_PER_TURN }, (_, i) => [
        `a${String(i).padStart(2, '0')}:modes`,
        { modes: [] },
      ])
    );
    const kv = fakeKv(
      { ...fillers, 'zzz:modes': { modes: [published('x')] } },
      { failGet: ['a07:modes'] }
    );
    expect(await unavailableDetail(resolve(kv, 'zzz', 'x'))).toBe('read_failed');
  });

  it('any failed read makes a non-own-exact answer unavailable, even a collision loss', async () => {
    const kv = fakeKv(
      {
        'PBT:modes': { modes: [published('x')] },
        'pbt:modes': { modes: [published('x')] },
        'pbt.:modes': { modes: [published('x')] },
      },
      { failGet: ['pbt.:modes'] }
    );
    expect(await unavailableDetail(resolve(kv, 'pbt', 'x'))).toBe('read_failed');
  });
});

describe('resolveModeShareCode — answers come from the actual match', () => {
  it('a requires_group claimant hidden in private chat is never reported as the opened org', async () => {
    const kv = fakeKv({
      // PBT claims `pbt/x` first, but its mode is group-only, so in a private
      // WhatsApp chat `#pbt/x` opens nothing.
      'PBT:modes': { modes: [published('x', { requires_group: true })] },
      'pbt:modes': { modes: [published('x')] },
    });
    expect(await resolve(kv, 'pbt', 'x')).toEqual({
      code: 'pbt/x',
      resolves: false,
      reason: 'collision',
    });
  });

  it('shared-reader warnings carry source: share_code', async () => {
    const kv = fakeKv({
      'PBT:modes': { modes: [published('x')] },
      'pbt:modes': { modes: [published('x')] },
    });
    const logger = spyLogger();
    const loaded = await loadShareCodeTarget(
      kv,
      { org: 'pbt', homeOrg: HOME, modeName: 'x' },
      logger
    );
    if (loaded.kind !== 'ok') throw new Error('setup');
    await resolveModeShareCode(kv, loaded.target, logger);
    expect(logger.warn).toHaveBeenCalledWith(
      'cross_org_mode_collision',
      expect.objectContaining({ org: 'pbt', source: 'share_code' })
    );
  });
});

describe('invalidOrgError', () => {
  it('accepts an org whose modes key fits 512 bytes and rejects empty or longer ones', () => {
    expect(invalidOrgError('a'.repeat(506))).toBeNull();
    expect(invalidOrgError('a'.repeat(507))).toMatch(/512 bytes/);
    // Bytes, not characters: 'é' is two bytes in UTF-8.
    expect(invalidOrgError('é'.repeat(254))).toMatch(/512 bytes/);
    expect(invalidOrgError('')).toMatch(/empty/);
  });
});

describe('chatTriggerModeOptions', () => {
  it('drops drafts and group-only modes for a non-admin private chat, keeps aliases', () => {
    const options = chatTriggerModeOptions(
      [
        published('a', { aliases: ['old-a'] }),
        { name: 'draft', overrides: {} },
        published('g', { requires_group: true }),
      ],
      { isGroupChat: false, isAdmin: false }
    );
    expect(options).toEqual([{ name: 'a', label: 'a', aliases: ['old-a'] }]);
  });
});
