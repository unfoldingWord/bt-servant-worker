/**
 * Unit tests for the authoritative share-code resolver (admin-portal#345).
 *
 * The resolver runs the chat path's own read, merge and classifier over a KV,
 * so these tests seed a fake KV (deterministic listing, no keys from other
 * test files) and assert what `#<code>` really opens from the home org.
 */
import { describe, expect, it, vi } from 'vitest';
import type { PromptMode } from '../../src/types/prompt-overrides.js';
import { MAX_FOREIGN_ORGS_PER_TURN } from '../../src/utils/cross-org-modes.js';
import type { RequestLogger } from '../../src/utils/logger.js';
import {
  chatTriggerModeOptions,
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

/** Values are stored as JSON text, exactly as KV holds them. */
function fakeKv(entries: Record<string, unknown>, opts: { listFails?: boolean } = {}): KVNamespace {
  const store = new Map(Object.entries(entries).map(([k, v]) => [k, JSON.stringify(v)]));
  return {
    get: vi.fn(async (key: string, type?: string) => {
      const raw = store.get(key);
      if (raw === undefined) return null;
      return type === 'json' ? JSON.parse(raw) : raw;
    }),
    list: vi.fn(async () => {
      if (opts.listFails === true) throw new Error('kv list down');
      return { keys: [...store.keys()].map((name) => ({ name })), list_complete: true };
    }),
    put: vi.fn(),
    delete: vi.fn(),
  } as unknown as KVNamespace;
}

/** Resolve `modeName` in `org` the way the route does: read the org's record, find the mode. */
async function resolve(kv: KVNamespace, org: string, modeName: string, homeOrg = HOME) {
  const record = (await kv.get(`${org}:modes`, 'json')) as { modes: PromptMode[] };
  const mode = record.modes.find((m) => m.name === modeName);
  if (mode === undefined) throw new Error(`test setup: ${org}/${modeName} missing`);
  return resolveModeShareCode(kv, { org, mode, homeOrg }, spyLogger());
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

  it('the home org still resolves when the foreign key listing fails', async () => {
    const kv = fakeKv({ [`${HOME}:modes`]: { modes: [published('x')] } }, { listFails: true });
    expect((await resolve(kv, HOME, 'x')).resolves).toBe(true);
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
  it('prefix stealing: a mode missing from the pool must not report the look-alike as a hit', async () => {
    const kv = fakeKv({
      'PBT:modes': { modes: [published('obt-coach-v2')] },
      // Published but malformed: the merge drops it, so `pbt/obt-coach` is
      // missing and the classifier's prefix tier picks PBT's look-alike.
      'pbt:modes': { modes: [published('obt-coach', { welcome_message: 1 as unknown as string })] },
    });
    expect(await resolve(kv, 'pbt', 'obt-coach')).toEqual({
      code: 'pbt/obt-coach',
      resolves: false,
      reason: 'ambiguous',
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
      reason: 'ambiguous',
      resolved_org: 'PBT',
    });
  });

  it('a foreign mode absent from the pool with no look-alike is not_found', async () => {
    const kv = fakeKv({
      'pbt:modes': { modes: [published('obt-coach', { welcome_message: 1 as unknown as string })] },
    });
    expect(await resolve(kv, 'pbt', 'obt-coach')).toEqual({
      code: 'pbt/obt-coach',
      resolves: false,
      reason: 'not_found',
    });
  });
});

describe('resolveModeShareCode — degraded reads', () => {
  it('a failed key listing makes a foreign answer unavailable rather than a false negative', async () => {
    const kv = fakeKv({ 'PBT:modes': { modes: [published('x')] } }, { listFails: true });
    await expect(resolve(kv, 'PBT', 'x')).rejects.toBeInstanceOf(ShareCodeUnavailableError);
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
