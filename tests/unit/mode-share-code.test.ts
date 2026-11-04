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
import { resolveEffectiveMode } from '../../src/types/mode-markdown.js';
import { classifyTriggers } from '../../src/services/classifier/index.js';
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
  it('a malformed foreign target is invalid_mode before any read (the merge drops it)', async () => {
    const kv = fakeKv({
      'PBT:modes': { modes: [published('obt-coach-v2')] },
      'pbt:modes': { modes: [published('obt-coach', { welcome_message: 1 as unknown as string })] },
    });
    expect(await resolve(kv, 'pbt', 'obt-coach')).toEqual({
      code: 'pbt/obt-coach',
      resolves: false,
      reason: 'invalid_mode',
    });
    expect(kv.list).not.toHaveBeenCalled();
  });

  it('a malformed foreign DRAFT reports invalid_mode, not draft (shape is checked first)', async () => {
    const kv = fakeKv({
      'pbt:modes': {
        modes: [{ name: 'x', overrides: null as unknown as Record<string, string> }],
      },
    });
    expect(await resolve(kv, 'pbt', 'x')).toMatchObject({ reason: 'invalid_mode' });
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
    });
  });
});

describe('resolveModeShareCode — the whole message must be the token', () => {
  it('a stored name with a space never resolves: `#obt coach` selects `obt` and leaves `coach`', async () => {
    const kv = fakeKv({
      [`${HOME}:modes`]: { modes: [published('obt coach'), published('obt')] },
    });
    // Chat serves the element (the crash guard keeps it), so this is not
    // invalid_mode: the message simply opens a different mode.
    expect(await resolve(kv, HOME, 'obt coach')).toEqual({
      code: 'obt coach',
      resolves: false,
      reason: 'ambiguous',
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

  it('a failed get cannot change a static invalid_mode', async () => {
    const kv = fakeKv(
      {
        'other:modes': { modes: [published('y')] },
        'pbt:modes': { modes: [published('x', { welcome_message: 1 as unknown as string })] },
      },
      { failGet: ['other:modes'] }
    );
    expect(await resolve(kv, 'pbt', 'x')).toMatchObject({ reason: 'invalid_mode' });
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
});

describe('loadShareCodeTarget — corrupt home', () => {
  const load = (kv: KVNamespace, org: string, modeName: string, homeOrg = HOME) =>
    loadShareCodeTarget(kv, { org, homeOrg, modeName }, spyLogger());

  it('a corrupt home record for a FOREIGN target is an empty home, logged as chat logs it, home_has_modes unknown', async () => {
    const kv = fakeKv(
      { 'pbt:modes': { modes: [published('x')] } },
      { noHome: true, rawText: { [`${HOME}:modes`]: '{not json' } }
    );
    const logger = spyLogger();
    const loaded = await loadShareCodeTarget(
      kv,
      { org: 'pbt', homeOrg: HOME, modeName: 'x' },
      logger
    );
    expect(loaded).toMatchObject({ kind: 'ok', homeHasModes: undefined });
    expect(logger.warn).toHaveBeenCalledWith(
      'mode_share_code_home_read_failed',
      expect.objectContaining({
        key: `${HOME}:modes`,
        source: 'share_code',
        error_name: 'CorruptModesRecordError',
        stack: expect.any(String),
      })
    );
    expect(logger.error).not.toHaveBeenCalled();
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

  it('`aliases: null` on a home mode is normalized to none, so chat serves it and it resolves', async () => {
    const kv = fakeKv({
      [`${HOME}:modes`]: {
        modes: [
          published('x', { aliases: null as unknown as string[] }),
          published('far-away-mode'),
        ],
      },
    });
    expect(await resolve(kv, HOME, 'x')).toEqual({ code: 'x', resolves: true, resolved_org: HOME });
  });

  it('`overrides: null` on a home mode is normalized, so chat serves it and it resolves', async () => {
    const kv = fakeKv({
      [`${HOME}:modes`]: {
        modes: [
          published('x', { overrides: null as unknown as Record<string, string> }),
          published('y'),
        ],
      },
    });
    expect(await resolve(kv, HOME, 'x')).toMatchObject({ resolves: true });
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

  it('capped stays firm when another org failed to read; only the look-alike is uncertain', async () => {
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
    expect(await resolve(kv, 'zzz', 'x')).toEqual({
      code: 'zzz/x',
      resolves: false,
      reason: 'capped',
      resolved_org_uncertain: true,
    });
  });
});

describe('resolveModeShareCode — failed reads leave misses firm', () => {
  it('a collision loss stays firm when a read failed; resolved_org is withheld as uncertain', async () => {
    const kv = fakeKv(
      {
        'PBT:modes': { modes: [published('x')] },
        'pbt:modes': { modes: [published('x')] },
        'pbt.:modes': { modes: [published('x')] },
      },
      { failGet: ['pbt.:modes'] }
    );
    expect(await resolve(kv, 'pbt', 'x')).toEqual({
      code: 'pbt/x',
      resolves: false,
      reason: 'collision',
      resolved_org_uncertain: true,
    });
  });

  it('without failed reads there is no uncertainty flag', async () => {
    const kv = fakeKv({
      'PBT:modes': { modes: [published('x')] },
      'pbt:modes': { modes: [published('x')] },
    });
    const answer = await resolve(kv, 'pbt', 'x');
    expect(answer).toEqual({
      code: 'pbt/x',
      resolves: false,
      reason: 'collision',
      resolved_org: 'PBT',
    });
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

describe('share-code logging (round 6)', () => {
  it('a 404 still logs a bad home at warn, under the share-code event, never the chat error event', async () => {
    const kv = fakeKv({}, { noHome: true, rawText: { [`${HOME}:modes`]: '{not json' } });
    const logger = spyLogger();
    const loaded = await loadShareCodeTarget(
      kv,
      { org: 'pbt', homeOrg: HOME, modeName: 'x' },
      logger
    );
    expect(loaded).toEqual({ kind: 'mode_not_found' });
    expect(logger.warn).toHaveBeenCalledWith(
      'mode_share_code_home_read_failed',
      expect.objectContaining({ key: `${HOME}:modes`, source: 'share_code' })
    );
    expect(logger.warn).not.toHaveBeenCalledWith('org_modes_kv_read_error', expect.anything());
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('a corrupt target still logs the home read failure once', async () => {
    const kv = fakeKv(
      {},
      { noHome: true, rawText: { 'pbt:modes': '{bad', [`${HOME}:modes`]: '{bad' } }
    );
    const logger = spyLogger();
    const loaded = await loadShareCodeTarget(
      kv,
      { org: 'pbt', homeOrg: HOME, modeName: 'x' },
      logger
    );
    expect(loaded).toEqual({ kind: 'corrupt_record', key: 'pbt:modes' });
    const homeEvents = (logger.warn as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([event]) => event === 'mode_share_code_home_read_failed'
    );
    expect(homeEvents).toHaveLength(1);
    expect(homeEvents[0]?.[1]).toMatchObject({ key: `${HOME}:modes`, source: 'share_code' });
  });
});

describe('share-code logging — shared reader', () => {
  it('a failed foreign get is logged at warn with source share_code, never at error', async () => {
    const kv = fakeKv(
      { 'other:modes': { modes: [published('y')] }, 'pbt:modes': { modes: [published('x')] } },
      { failGet: ['other:modes'] }
    );
    const logger = spyLogger();
    const loaded = await loadShareCodeTarget(
      kv,
      { org: 'pbt', homeOrg: HOME, modeName: 'x' },
      logger
    );
    if (loaded.kind !== 'ok') throw new Error('setup');
    await resolveModeShareCode(kv, loaded.target, logger);
    expect(logger.warn).toHaveBeenCalledWith(
      'cross_org_modes_read_failed',
      expect.objectContaining({ key: 'other:modes', source: 'share_code' })
    );
    expect(logger.error).not.toHaveBeenCalled();
  });
});

describe('loadShareCodeTarget — target selection follows chat (round 7)', () => {
  it('[draft x, published x] on a home org: chat resolves the draft first and opens nothing (collision)', async () => {
    const kv = fakeKv({
      [`${HOME}:modes`]: { modes: [{ name: 'x', overrides: {} }, published('x')] },
    });
    expect(await resolve(kv, HOME, 'x')).toEqual({
      code: 'x',
      resolves: false,
      reason: 'collision',
    });
  });

  it('[group-only x, published x] on a home org: chat resolves the group-only one first (collision)', async () => {
    const kv = fakeKv({
      [`${HOME}:modes`]: { modes: [published('x', { requires_group: true }), published('x')] },
    });
    expect(await resolve(kv, HOME, 'x')).toEqual({
      code: 'x',
      resolves: false,
      reason: 'collision',
    });
  });

  it('[draft x, published x] on a foreign org selects the one the merge keeps', async () => {
    const kv = fakeKv({ 'pbt:modes': { modes: [{ name: 'x', overrides: {} }, published('x')] } });
    expect(await resolve(kv, 'pbt', 'x')).toMatchObject({ code: 'pbt/x', resolves: true });
  });

  it('[a with alias b, b]: the target is the mode NAMED b, but chat opens a (collision naming home)', async () => {
    const kv = fakeKv({
      [`${HOME}:modes`]: { modes: [published('a', { aliases: ['b'] }), published('b')] },
    });
    const loaded = await loadShareCodeTarget(
      kv,
      { org: HOME, homeOrg: HOME, modeName: 'b' },
      spyLogger()
    );
    expect(loaded.kind === 'ok' && loaded.target.mode.name).toBe('b');
    expect(await resolve(kv, HOME, 'b')).toEqual({
      code: 'b',
      resolves: false,
      reason: 'collision',
      resolved_org: HOME,
    });
  });

  it('parity: each verdict agrees with the DO pipeline (classifier, then resolveEffectiveMode)', async () => {
    const records: PromptMode[][] = [
      [{ name: 'x', overrides: {} }, published('x')],
      [published('x', { requires_group: true }), published('x')],
      [published('a', { aliases: ['x'] }), published('x')],
      [published('x')],
    ];
    for (const modes of records) {
      const kv = fakeKv({ [`${HOME}:modes`]: { modes } });
      const chatOpens = resolveEffectiveMode(
        { modes },
        classifyTriggers('#x', {
          availableModes: chatTriggerModeOptions(modes, { isGroupChat: false, isAdmin: false }),
          availableLanguages: [],
        }).modeName,
        { includeUnpublished: false, isGroupChat: false }
      ).effectiveModeName;
      expect((await resolve(kv, HOME, 'x')).resolves).toBe(chatOpens === 'x');
    }
  });

  it('an alias still selects its mode when no mode has that name', async () => {
    const kv = fakeKv({ [`${HOME}:modes`]: { modes: [published('a', { aliases: ['old-a'] })] } });
    expect(await resolve(kv, HOME, 'old-a')).toMatchObject({ code: 'a', resolves: true });
  });
});

describe('resolveModeShareCode — same-org alias claim (round 7)', () => {
  it('another mode of THIS org claiming the qualified name by alias is a collision naming this org', async () => {
    const kv = fakeKv({
      'pbt:modes': { modes: [published('y', { aliases: ['x'] }), published('x')] },
    });
    expect(await resolve(kv, 'pbt', 'x')).toEqual({
      code: 'pbt/x',
      resolves: false,
      reason: 'collision',
      resolved_org: 'pbt',
    });
  });
});

describe('loadShareCodeTarget — wrong-shape target (round 7)', () => {
  it('valid JSON that is not a modes record is corrupt_record, not a 404', async () => {
    const kv = fakeKv({ 'pbt:modes': { not: 'modes' } });
    const loaded = await loadShareCodeTarget(
      kv,
      { org: 'pbt', homeOrg: HOME, modeName: 'x' },
      spyLogger()
    );
    expect(loaded).toEqual({ kind: 'corrupt_record', key: 'pbt:modes' });
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
