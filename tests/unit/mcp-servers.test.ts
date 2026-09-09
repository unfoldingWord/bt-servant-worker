/**
 * Unit tests for the MCP server pool helpers (admin-portal#278): the public
 * projection that redacts authToken, and the write-rule merge that keeps a
 * stored token across a redacted read → edit → write round-trip.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MCPServerConfig, MCPServerWrite } from '../../src/types/mcp';
import {
  type McpServerPool,
  describeLeftoverLegacyKeys,
  describeMigrationHint,
  mergeServerPool,
  mergeServerWrite,
  poolWriteAuthError,
  readMcpServerPool,
  readMcpServerPoolOrEmpty,
  resetChatFallbackWarning,
  resolveAuthToken,
  resolveOwnerOrg,
  toPublicServerConfig,
  toPublicServerConfigs,
  upsertServer,
} from '../../src/utils/mcp-servers';
import { MCP_GLOBAL_KEY, findDuplicateServerIds } from '../../src/utils/mcp-validation';
import type { RequestLogger } from '../../src/utils/logger';

const stored = (id: string, extra: Partial<MCPServerConfig> = {}): MCPServerConfig => ({
  id,
  name: `Server ${id}`,
  url: `https://${id}.example.com/mcp`,
  enabled: true,
  priority: 1,
  ...extra,
});

/** DEFAULT_ORG: the migrated `unfoldingWord` pool, used as the ownerOrg default. */
const DEFAULT_ORG = 'unfoldingWord';
/** A non-default acting org, as a partner admin's write route would carry. */
const ACTING_ORG = 'wordcollective';

describe('toPublicServerConfig', () => {
  it('drops authToken and reports hasAuthToken=true for a non-empty token', () => {
    const pub = toPublicServerConfig(stored('a', { authToken: 'secret-123' }), DEFAULT_ORG);
    expect(pub).toEqual({
      id: 'a',
      name: 'Server a',
      url: 'https://a.example.com/mcp',
      enabled: true,
      priority: 1,
      hasAuthToken: true,
      ownerOrg: DEFAULT_ORG,
    });
    expect('authToken' in pub).toBe(false);
    expect(JSON.stringify(pub)).not.toContain('secret-123');
  });

  it('reports hasAuthToken=false when the token is absent or empty', () => {
    expect(toPublicServerConfig(stored('a'), DEFAULT_ORG).hasAuthToken).toBe(false);
    expect(toPublicServerConfig(stored('a', { authToken: '' }), DEFAULT_ORG).hasAuthToken).toBe(
      false
    );
  });

  it('is an allowlist: unknown stored keys never reach the public shape', () => {
    const legacyStored = {
      ...stored('a', { authToken: 'sekrit' }),
      password: 'hunter2',
      hasAuthToken: false, // stale public-shape field persisted pre-#278
    } as unknown as MCPServerConfig;
    const pub = toPublicServerConfig(legacyStored, DEFAULT_ORG);
    expect(Object.keys(pub).sort()).toEqual(
      ['enabled', 'hasAuthToken', 'id', 'name', 'ownerOrg', 'priority', 'url'].sort()
    );
    expect(pub.hasAuthToken).toBe(true);
    expect(JSON.stringify(pub)).not.toMatch(/hunter2|sekrit/);
  });

  it('keeps every other field, including optional ones', () => {
    const pub = toPublicServerConfig(
      stored('a', { allowedTools: ['x'], transport: 'streamable-http', enabled: false }),
      DEFAULT_ORG
    );
    expect(pub).toMatchObject({
      allowedTools: ['x'],
      transport: 'streamable-http',
      enabled: false,
      hasAuthToken: false,
    });
  });
});

describe('toPublicServerConfigs', () => {
  it('projects a pool in order', () => {
    const pool = [stored('b', { authToken: 't' }), stored('a')];
    expect(toPublicServerConfigs(pool, DEFAULT_ORG).map((s) => [s.id, s.hasAuthToken])).toEqual([
      ['b', true],
      ['a', false],
    ]);
  });
});

describe('toPublicServerConfig ownerOrg', () => {
  it('reports a stored ownerOrg', () => {
    expect(toPublicServerConfig(stored('a', { ownerOrg: ACTING_ORG }), DEFAULT_ORG).ownerOrg).toBe(
      ACTING_ORG
    );
  });

  it('defaults an absent ownerOrg to DEFAULT_ORG (a pre-#292 entry is in the migrated pool)', () => {
    expect(toPublicServerConfig(stored('a'), DEFAULT_ORG).ownerOrg).toBe(DEFAULT_ORG);
  });

  it('defaults an empty or malformed stored ownerOrg to DEFAULT_ORG', () => {
    // A pre-#278 record could persist junk verbatim; the public shape must
    // still be a usable org id.
    const empty = { ...stored('a'), ownerOrg: '' } as unknown as MCPServerConfig;
    const nonString = { ...stored('a'), ownerOrg: 123 } as unknown as MCPServerConfig;
    expect(toPublicServerConfig(empty, DEFAULT_ORG).ownerOrg).toBe(DEFAULT_ORG);
    expect(toPublicServerConfig(nonString, DEFAULT_ORG).ownerOrg).toBe(DEFAULT_ORG);
  });
});

describe('resolveAuthToken (write rule)', () => {
  const existing = stored('a', { authToken: 'keep-me' });

  it('preserves the stored token when the key is omitted', () => {
    expect(resolveAuthToken(stored('a'), existing)).toBe('keep-me');
  });

  it('yields no token when omitted and nothing is stored', () => {
    expect(resolveAuthToken(stored('a'), undefined)).toBeUndefined();
    expect(resolveAuthToken(stored('a'), stored('a'))).toBeUndefined();
  });

  it('clears on null and on empty string', () => {
    expect(resolveAuthToken({ ...stored('a'), authToken: null }, existing)).toBeUndefined();
    expect(resolveAuthToken({ ...stored('a'), authToken: '' }, existing)).toBeUndefined();
  });

  it('sets a non-empty string', () => {
    expect(resolveAuthToken({ ...stored('a'), authToken: 'new' }, existing)).toBe('new');
    expect(resolveAuthToken({ ...stored('a'), authToken: 'new' }, undefined)).toBe('new');
  });

  it('treats an explicit undefined like omitted', () => {
    expect(resolveAuthToken({ ...stored('a'), authToken: undefined }, existing)).toBe('keep-me');
  });

  it('does not re-persist a stored empty string when the write omits the token', () => {
    expect(resolveAuthToken(stored('a'), stored('a', { authToken: '' }))).toBeUndefined();
  });
});

describe('mergeServerWrite', () => {
  it('never persists a null or empty authToken field', () => {
    expect(
      'authToken' in mergeServerWrite({ ...stored('a'), authToken: null }, undefined, ACTING_ORG)
    ).toBe(false);
    expect(
      'authToken' in mergeServerWrite({ ...stored('a'), authToken: '' }, stored('a'), ACTING_ORG)
    ).toBe(false);
  });

  it('persists only known MCPServerConfig fields (allowlist), plus the stamped owner', () => {
    const write = {
      ...stored('a'),
      hasAuthToken: true, // public-shape field from a GET → PUT round-trip
      password: 'hunter2', // unknown secret-looking key
      ownerOrg: 'attacker', // body cannot claim ownership — stamped from the route
      allowedTools: ['t'],
      transport: 'json-rpc',
    } as unknown as MCPServerWrite;
    const merged = mergeServerWrite(write, undefined, ACTING_ORG);
    expect(Object.keys(merged).sort()).toEqual(
      ['allowedTools', 'enabled', 'id', 'name', 'ownerOrg', 'priority', 'transport', 'url'].sort()
    );
    expect(merged.ownerOrg).toBe(ACTING_ORG); // route wins over the body value
    expect(JSON.stringify(merged)).not.toContain('hunter2');
  });

  it('takes every non-token field from the write, not from existing', () => {
    const merged = mergeServerWrite(
      { ...stored('a', { name: 'Renamed', priority: 7 }) },
      stored('a', { authToken: 'keep-me', allowedTools: ['old'] }),
      ACTING_ORG
    );
    expect(merged).toEqual({
      id: 'a',
      name: 'Renamed',
      url: 'https://a.example.com/mcp',
      enabled: true,
      priority: 7,
      authToken: 'keep-me',
    });
  });
});

describe('resolveOwnerOrg (write rule)', () => {
  it('stamps the acting org on create (no existing entry)', () => {
    expect(resolveOwnerOrg(undefined, ACTING_ORG)).toBe(ACTING_ORG);
  });

  it('preserves the stored owner on edit — an edit never transfers ownership', () => {
    expect(resolveOwnerOrg(stored('a', { ownerOrg: DEFAULT_ORG }), ACTING_ORG)).toBe(DEFAULT_ORG);
  });

  it('leaves a pre-#292 entry unowned on edit (absent stays absent)', () => {
    // The public projection reports the absent value as DEFAULT_ORG; the edit
    // does not stamp the acting org onto a legacy row.
    expect(resolveOwnerOrg(stored('a'), ACTING_ORG)).toBeUndefined();
  });

  it('does not re-persist an empty or malformed stored ownerOrg on edit', () => {
    const empty = { ...stored('a'), ownerOrg: '' } as unknown as MCPServerConfig;
    const nonString = { ...stored('a'), ownerOrg: 123 } as unknown as MCPServerConfig;
    expect(resolveOwnerOrg(empty, ACTING_ORG)).toBeUndefined();
    expect(resolveOwnerOrg(nonString, ACTING_ORG)).toBeUndefined();
  });

  it('does not stamp an empty acting org on create', () => {
    expect(resolveOwnerOrg(undefined, '')).toBeUndefined();
  });
});

describe('mergeServerWrite ownerOrg', () => {
  it('stamps the acting org as owner on create', () => {
    expect(mergeServerWrite(stored('a'), undefined, ACTING_ORG).ownerOrg).toBe(ACTING_ORG);
  });

  it('preserves an existing owner and ignores the acting org on edit', () => {
    const merged = mergeServerWrite(
      stored('a'),
      stored('a', { ownerOrg: DEFAULT_ORG }),
      ACTING_ORG
    );
    expect(merged.ownerOrg).toBe(DEFAULT_ORG);
  });

  it('does not stamp an owner when editing a pre-#292 entry', () => {
    expect('ownerOrg' in mergeServerWrite(stored('a'), stored('a'), ACTING_ORG)).toBe(false);
  });
});

describe('mergeServerPool (PUT)', () => {
  const pool = [
    stored('a', { authToken: 'tok-a', ownerOrg: DEFAULT_ORG }),
    stored('b', { authToken: 'tok-b', ownerOrg: DEFAULT_ORG }),
    stored('c'),
  ];

  it('keeps exactly the written servers, in write order, merging tokens and owners by id', () => {
    const next = mergeServerPool(
      [stored('c'), stored('a'), stored('d', { authToken: 'tok-d' })],
      pool,
      ACTING_ORG
    );
    expect(next).toEqual([
      // 'c' pre-existed unowned → stays unowned (projection defaults it later).
      stored('c'),
      // 'a' pre-existed → owner preserved, not reassigned to the acting org.
      stored('a', { authToken: 'tok-a', ownerOrg: DEFAULT_ORG }),
      // 'd' is new → stamped with the acting org.
      stored('d', { authToken: 'tok-d', ownerOrg: ACTING_ORG }),
    ]);
  });

  it('clears a token when the write says null', () => {
    const next = mergeServerPool([{ ...stored('a'), authToken: null }], pool, ACTING_ORG);
    expect(next).toEqual([stored('a', { ownerOrg: DEFAULT_ORG })]);
  });

  it('empties the pool for an empty write', () => {
    expect(mergeServerPool([], pool, ACTING_ORG)).toEqual([]);
  });
});

describe('upsertServer (POST)', () => {
  const pool = [stored('a', { authToken: 'tok-a', ownerOrg: DEFAULT_ORG }), stored('b')];

  it('replaces in place by id, preserving the token and owner when omitted', () => {
    const next = upsertServer(stored('a', { priority: 9 }), pool, ACTING_ORG);
    expect(next).toEqual([
      stored('a', { priority: 9, authToken: 'tok-a', ownerOrg: DEFAULT_ORG }),
      stored('b'),
    ]);
  });

  it('appends a new id and stamps it with the acting org', () => {
    const next = upsertServer(stored('z', { authToken: 'tok-z' }), pool, ACTING_ORG);
    expect(next.map((s) => s.id)).toEqual(['a', 'b', 'z']);
    expect(next[2].authToken).toBe('tok-z');
    expect(next[2].ownerOrg).toBe(ACTING_ORG);
  });

  it('does not mutate the input pool', () => {
    const before = JSON.stringify(pool);
    upsertServer({ ...stored('a'), authToken: null }, pool, ACTING_ORG);
    expect(JSON.stringify(pool)).toBe(before);
  });
});

describe('findDuplicateServerIds', () => {
  it('returns each duplicated id once', () => {
    expect(findDuplicateServerIds([{ id: 'a' }, { id: 'b' }, { id: 'a' }, { id: 'a' }])).toEqual([
      'a',
    ]);
    expect(findDuplicateServerIds([{ id: 'a' }, { id: 'b' }])).toEqual([]);
  });
});

// ─── readMcpServerPool against a fake KV ──────────────────────────────────────

/** Values are stored as JSON text, exactly as KV holds them (`get(key, 'text')`). */
function fakeKv(entries: Record<string, unknown>): KVNamespace {
  const store = new Map(Object.entries(entries).map(([k, v]) => [k, JSON.stringify(v)]));
  return {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    list: vi.fn(async () => ({
      keys: [...store.keys()].map((name) => ({ name })),
      list_complete: true,
      cacheStatus: null,
    })),
    put: vi.fn(),
    delete: vi.fn(),
  } as unknown as KVNamespace;
}

function fakeLogger() {
  return {
    log: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as RequestLogger & {
    warn: ReturnType<typeof vi.fn>;
    info: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
  };
}

describe('readMcpServerPool', () => {
  beforeEach(() => resetChatFallbackWarning());

  it('serves __global__ when present, even when empty, and never falls back', async () => {
    const kv = fakeKv({ [MCP_GLOBAL_KEY]: [], unfoldingWord: [stored('legacy')] });
    const logger = fakeLogger();
    const pool = await readMcpServerPool(kv, 'unfoldingWord', logger, 'admin');
    expect(pool).toEqual({
      servers: [],
      migrated: true,
      fallbackFound: false,
      legacyKeys: ['unfoldingWord'],
      legacyListing: 'complete',
      staleGlobalSuspected: false,
    });
    // Leftover legacy keys are surfaced (warn), but the pool is still served from __global__.
    expect(logger.warn).toHaveBeenCalledWith(
      'mcp_legacy_keys_leftover',
      expect.objectContaining({ legacy_keys: ['unfoldingWord'], global_server_count: 0 })
    );
    expect(logger.warn).not.toHaveBeenCalledWith('mcp_global_key_missing', expect.anything());
  });

  it('a migrated pool with no leftovers lists nothing and warns nothing', async () => {
    const kv = fakeKv({ [MCP_GLOBAL_KEY]: [stored('g')] });
    const logger = fakeLogger();
    const pool = await readMcpServerPool(kv, 'unfoldingWord', logger, 'admin');
    expect(pool.legacyKeys).toEqual([]);
    expect(pool.legacyListing).toBe('complete');
    expect(logger.warn).not.toHaveBeenCalled();
  });
});

describe('readMcpServerPool migrated leftovers', () => {
  beforeEach(() => resetChatFallbackWarning());

  it('migrated read reports the legacy key even when the listing fails (fail closed)', async () => {
    const kv = fakeKv({ [MCP_GLOBAL_KEY]: [stored('g')], unfoldingWord: [stored('legacy')] });
    (kv.list as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('list down'));
    const logger = fakeLogger();
    const pool = await readMcpServerPool(kv, 'unfoldingWord', logger, 'admin');
    expect(pool.migrated).toBe(true);
    expect(pool.legacyListing).toBe('failed');
    expect(pool.legacyKeys).toEqual(['unfoldingWord']);
    expect(logger.warn).toHaveBeenCalledWith(
      'mcp_legacy_keys_leftover',
      expect.objectContaining({ legacy_keys: ['unfoldingWord'], legacy_listing: 'failed' })
    );
  });

  it('a failing legacy-key probe never fails a migrated read; it fails closed', async () => {
    const kv = fakeKv({ [MCP_GLOBAL_KEY]: [stored('g')] });
    (kv.get as ReturnType<typeof vi.fn>).mockImplementation(async (key: string) => {
      if (key === MCP_GLOBAL_KEY) return JSON.stringify([stored('g')]);
      throw new Error('get down');
    });
    const logger = fakeLogger();
    const pool = await readMcpServerPool(kv, 'unfoldingWord', logger, 'admin');
    expect(pool.migrated).toBe(true);
    expect(pool.servers.map((s) => s.id)).toEqual(['g']);
    // Probe failure → assume present, downgrade listing, warn.
    expect(pool.legacyKeys).toEqual(['unfoldingWord']);
    expect(pool.legacyListing).toBe('failed');
    expect(logger.error).toHaveBeenCalledWith(
      'mcp_legacy_key_probe_failed',
      expect.any(Error),
      expect.objectContaining({ key: 'unfoldingWord' })
    );
    expect(logger.warn).toHaveBeenCalledWith(
      'mcp_legacy_keys_leftover',
      expect.objectContaining({ legacy_keys: ['unfoldingWord'], legacy_listing: 'failed' })
    );
  });

  it('migrated read warns on an incomplete listing even with no names', async () => {
    const kv = fakeKv({ [MCP_GLOBAL_KEY]: [stored('g')] });
    (kv.list as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('list down'));
    const logger = fakeLogger();
    const pool = await readMcpServerPool(kv, 'unfoldingWord', logger, 'admin');
    expect(pool.legacyKeys).toEqual([]);
    expect(pool.legacyListing).toBe('failed');
    expect(logger.warn).toHaveBeenCalledWith(
      'mcp_legacy_keys_leftover',
      expect.objectContaining({ legacy_listing: 'failed' })
    );
  });
});

describe('readMcpServerPool fallback', () => {
  beforeEach(() => resetChatFallbackWarning());

  it('falls back to the legacy key and reports migrated=false with the namespace keys', async () => {
    const kv = fakeKv({
      unfoldingWord: [stored('legacy', { authToken: 'tok-legacy-secret' })],
      'other-org': [stored('theirs')],
    });
    const logger = fakeLogger();
    const pool = await readMcpServerPool(kv, 'unfoldingWord', logger, 'admin');
    expect(pool.migrated).toBe(false);
    expect(pool.fallbackFound).toBe(true);
    expect(pool.legacyListing).toBe('complete');
    expect(pool.legacyKeys).toEqual(['unfoldingWord', 'other-org']);
    expect(pool.servers.map((s) => s.id)).toEqual(['legacy']);
    expect(logger.warn).toHaveBeenCalledWith(
      'mcp_global_key_missing',
      expect.objectContaining({
        fallback_found: true,
        server_count: 1,
        legacy_keys: ['unfoldingWord', 'other-org'],
      })
    );
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('tok-legacy-secret');
  });
});

describe('readMcpServerPool fresh namespace', () => {
  it('reports migrated=false when neither key exists (fresh namespace)', async () => {
    const pool = await readMcpServerPool(fakeKv({}), 'unfoldingWord', fakeLogger(), 'admin');
    expect(pool).toEqual({
      servers: [],
      migrated: false,
      fallbackFound: false,
      legacyKeys: [],
      legacyListing: 'complete',
      staleGlobalSuspected: false,
    });
  });
});

describe('readMcpServerPool on unmigrated namespaces', () => {
  beforeEach(() => resetChatFallbackWarning());

  it('reports migrated=false when only another org key holds servers', async () => {
    const kv = fakeKv({ 'other-org': [stored('theirs')] });
    const logger = fakeLogger();
    const pool = await readMcpServerPool(kv, 'unfoldingWord', logger, 'admin');
    expect(pool).toEqual({
      servers: [],
      migrated: false,
      fallbackFound: false,
      legacyKeys: ['other-org'],
      legacyListing: 'complete',
      staleGlobalSuspected: false,
    });
    expect(logger.warn).toHaveBeenCalledWith(
      'mcp_global_key_missing',
      expect.objectContaining({ fallback_found: false, legacy_keys: ['other-org'] })
    );
  });
});

describe('readMcpServerPool stale-miss detection', () => {
  beforeEach(() => resetChatFallbackWarning());

  it('flags a stale miss when the listing shows __global__ but get did not', async () => {
    const kv = fakeKv({});
    (kv.list as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      keys: [{ name: MCP_GLOBAL_KEY }],
      list_complete: true,
    });
    const logger = fakeLogger();
    const pool = await readMcpServerPool(kv, 'unfoldingWord', logger, 'admin');
    expect(pool.migrated).toBe(false);
    expect(pool.staleGlobalSuspected).toBe(true);
    expect(pool.legacyKeys).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(
      'mcp_global_key_missing',
      expect.objectContaining({ stale_global_suspected: true })
    );
  });
});

describe('readMcpServerPool logging and shape guards', () => {
  beforeEach(() => resetChatFallbackWarning());

  it('chat source warns once per isolate and is otherwise silent', async () => {
    const kv = fakeKv({ unfoldingWord: [stored('legacy')] });
    const logger = fakeLogger();
    await readMcpServerPool(kv, 'unfoldingWord', logger, 'chat');
    await readMcpServerPool(kv, 'unfoldingWord', logger, 'chat');
    await readMcpServerPool(kv, 'unfoldingWord', logger, 'chat');
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.info).not.toHaveBeenCalled();
    expect(kv.list).not.toHaveBeenCalled();
  });

  it('chat reads of a migrated pool never list keys', async () => {
    const kv = fakeKv({ [MCP_GLOBAL_KEY]: [stored('g')], unfoldingWord: [stored('legacy')] });
    const pool = await readMcpServerPool(kv, 'unfoldingWord', fakeLogger(), 'chat');
    expect(pool.legacyListing).toBe('skipped');
    expect(pool.legacyKeys).toEqual([]);
    expect(kv.list).not.toHaveBeenCalled();
  });

  it('chat warning re-arms after a successful __global__ read (rollback is reported again)', async () => {
    const logger = fakeLogger();
    const missing = fakeKv({ unfoldingWord: [stored('legacy')] });
    await readMcpServerPool(missing, 'unfoldingWord', logger, 'chat');
    await readMcpServerPool(fakeKv({ [MCP_GLOBAL_KEY]: [] }), 'unfoldingWord', logger, 'chat');
    await readMcpServerPool(missing, 'unfoldingWord', logger, 'chat');
    expect(logger.warn).toHaveBeenCalledTimes(2);
  });

  it('a failing key listing is logged and does not fail the read', async () => {
    const kv = fakeKv({ unfoldingWord: [stored('legacy')] });
    (kv.list as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('list down'));
    const logger = fakeLogger();
    const pool = await readMcpServerPool(kv, 'unfoldingWord', logger, 'admin');
    expect(pool.servers.map((s) => s.id)).toEqual(['legacy']);
    expect(logger.error).toHaveBeenCalledWith(
      'mcp_legacy_key_list_failed',
      expect.any(Error),
      expect.anything()
    );
    // The key that was actually read is reported even though the listing failed,
    // and the failure is visible so nobody infers "no legacy keys" from it.
    expect(pool.legacyListing).toBe('failed');
    expect(pool.legacyKeys).toEqual(['unfoldingWord']);
    expect(logger.warn).toHaveBeenCalledWith(
      'mcp_global_key_missing',
      expect.objectContaining({ legacy_keys: ['unfoldingWord'], legacy_listing: 'failed' })
    );
  });
});

describe('readMcpServerPool key listing and shape guards', () => {
  beforeEach(() => resetChatFallbackWarning());

  it('follows list pagination until list_complete', async () => {
    const kv = fakeKv({ unfoldingWord: [] });
    (kv.list as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ keys: [{ name: 'a' }], list_complete: false, cursor: 'c1' })
      .mockResolvedValueOnce({ keys: [{ name: 'b' }], list_complete: true });
    const logger = fakeLogger();
    await readMcpServerPool(kv, 'unfoldingWord', logger, 'admin');
    expect(kv.list).toHaveBeenCalledTimes(2);
    expect(kv.list).toHaveBeenLastCalledWith({ limit: 1000, cursor: 'c1' });
    // The fallback key that was read ('unfoldingWord', stored as []) is always
    // listed first, then the paginated names.
    expect(logger.warn).toHaveBeenCalledWith(
      'mcp_global_key_missing',
      expect.objectContaining({
        legacy_keys: ['unfoldingWord', 'a', 'b'],
        legacy_listing: 'complete',
      })
    );
  });

  it('warns when the key listing is truncated at the page cap', async () => {
    const kv = fakeKv({ unfoldingWord: [] });
    (kv.list as ReturnType<typeof vi.fn>).mockResolvedValue({
      keys: [{ name: 'k' }],
      list_complete: false,
      cursor: 'again',
    });
    const logger = fakeLogger();
    const pool = await readMcpServerPool(kv, 'unfoldingWord', logger, 'admin');
    expect(kv.list).toHaveBeenCalledTimes(10);
    expect(pool.legacyListing).toBe('truncated');
    expect(pool.legacyKeys).toHaveLength(11); // 10 listed pages + the fallback key itself
    expect(logger.warn).toHaveBeenCalledWith(
      'mcp_legacy_key_list_truncated',
      expect.objectContaining({ pages: 10 })
    );
  });
});

describe('readMcpServerPool corrupt stored values', () => {
  it('throws on a stored JSON null instead of treating it as a missing key', async () => {
    const kv = fakeKv({ [MCP_GLOBAL_KEY]: null, unfoldingWord: [stored('legacy')] });
    await expect(readMcpServerPool(kv, 'unfoldingWord', fakeLogger(), 'admin')).rejects.toThrow(
      /holds JSON null/
    );
  });

  it('throws when a stored entry lacks a string url or has a non-string authToken', async () => {
    await expect(
      readMcpServerPool(fakeKv({ [MCP_GLOBAL_KEY]: [{ id: 'x' }] }), 'u', fakeLogger(), 'admin')
    ).rejects.toThrow(/element 0/);
    await expect(
      readMcpServerPool(
        fakeKv({ [MCP_GLOBAL_KEY]: [stored('x', { authToken: 123 as unknown as string })] }),
        'u',
        fakeLogger(),
        'admin'
      )
    ).rejects.toThrow(/element 0/);
  });

  it('throws when a stored value is not an array of server configs', async () => {
    await expect(
      readMcpServerPool(fakeKv({ [MCP_GLOBAL_KEY]: { oops: 1 } }), 'u', fakeLogger(), 'admin')
    ).rejects.toThrow(/not a JSON array/);
    await expect(
      readMcpServerPool(fakeKv({ unfoldingWord: 'nope' }), 'unfoldingWord', fakeLogger(), 'admin')
    ).rejects.toThrow(/not a JSON array/);
    await expect(
      readMcpServerPool(
        fakeKv({ [MCP_GLOBAL_KEY]: [stored('ok'), null] }),
        'u',
        fakeLogger(),
        'admin'
      )
    ).rejects.toThrow(/element 1/);
  });
});

describe('readMcpServerPoolOrEmpty (chat path)', () => {
  beforeEach(() => resetChatFallbackWarning());

  it('returns the pool servers on success', async () => {
    const kv = fakeKv({ [MCP_GLOBAL_KEY]: [stored('g', { authToken: 'raw' })] });
    const servers = await readMcpServerPoolOrEmpty(kv, 'unfoldingWord', fakeLogger());
    // The chat path needs the raw config, token included.
    expect(servers).toEqual([stored('g', { authToken: 'raw' })]);
  });

  it('logs mcp_kv_read_error and returns [] on KV failure or corrupt data', async () => {
    const failing = {
      get: vi.fn(async () => {
        throw new Error('kv down');
      }),
    } as unknown as KVNamespace;
    const logger = fakeLogger();
    expect(await readMcpServerPoolOrEmpty(failing, 'unfoldingWord', logger)).toEqual([]);
    expect(logger.error).toHaveBeenCalledWith(
      'mcp_kv_read_error',
      expect.any(Error),
      expect.objectContaining({ global_key: MCP_GLOBAL_KEY })
    );

    const corrupt = fakeKv({ [MCP_GLOBAL_KEY]: 'nope' });
    const logger2 = fakeLogger();
    expect(await readMcpServerPoolOrEmpty(corrupt, 'unfoldingWord', logger2)).toEqual([]);
    expect(logger2.error).toHaveBeenCalledTimes(1);
  });
});

// ─── Operator guidance and write auth (pure) ──────────────────────────────────

const poolOf = (over: Partial<McpServerPool>): McpServerPool => ({
  servers: [],
  migrated: false,
  fallbackFound: false,
  legacyKeys: [],
  legacyListing: 'complete',
  staleGlobalSuspected: false,
  ...over,
});

describe('describeMigrationHint', () => {
  it.each<[string, Partial<McpServerPool>]>([
    ['nothing seen and listing complete', {}],
    ['fallback key found but listing empty (list lagging get)', { fallbackFound: true }],
    ['listing failed', { legacyListing: 'failed' }],
    ['listing truncated', { legacyListing: 'truncated' }],
    ['listing skipped', { legacyListing: 'skipped' }],
    ['another key present', { legacyKeys: ['other-org'] }],
    ['stale global suspected', { staleGlobalSuspected: true }],
  ])('never tells the operator to seed [] outright when %s', (_label, over) => {
    const hint = describeMigrationHint(poolOf(over));
    expect(hint).not.toMatch(/^No legacy keys exist/);
    expect(hint).not.toContain("put … __global__ '[]'");
    expect(hint).toMatch(/Do NOT seed \[\]|only if it shows no keys at all/);
  });

  it('defers the emptiness decision to the operator-run wrangler listing', () => {
    const hint = describeMigrationHint(poolOf({}));
    expect(hint).toContain('not proof that none exist');
    expect(hint).toContain('wrangler kv key list --binding=MCP_SERVERS');
    expect(hint).toContain('only if it shows no keys at all');
    expect(hint).toContain('redacted');
  });
});

describe('describeMigrationHint wrangler cases', () => {
  it.each<[string, Partial<McpServerPool>]>([
    ['nothing seen', {}],
    ['fallback key seen', { fallbackFound: true, legacyKeys: ['unfoldingWord'] }],
    ['listing failed', { legacyListing: 'failed' }],
  ])(
    'tells the operator that a wrangler-visible __global__ means retry, never recreate (%s)',
    (_label, over) => {
      const hint = describeMigrationHint(poolOf(over));
      const retryIdx = hint.indexOf(`(1) if it shows '${MCP_GLOBAL_KEY}', this API read was stale`);
      const createIdx = hint.indexOf(`(2) if it shows other keys but not '${MCP_GLOBAL_KEY}'`);
      const seedIdx = hint.indexOf('(3) only if it shows no keys at all');
      expect(retryIdx).toBeGreaterThan(-1);
      expect(createIdx).toBeGreaterThan(retryIdx);
      expect(seedIdx).toBeGreaterThan(createIdx);
      expect(hint).toContain('retry shortly, do NOT seed [] and do NOT write anything');
    }
  );

  it('names the keys it knows and flags an incomplete listing', () => {
    const hint = describeMigrationHint(
      poolOf({ fallbackFound: true, legacyKeys: ['unfoldingWord'], legacyListing: 'failed' })
    );
    expect(hint).toContain('[unfoldingWord]');
    expect(hint).toContain('listing was failed');
  });

  it('calls out a stale read when the listing shows __global__', () => {
    const hint = describeMigrationHint(poolOf({ staleGlobalSuspected: true }));
    expect(hint).toContain('stale read');
    expect(hint).toContain('Retry');
    expect(hint).toContain('Do NOT seed []');
  });
});

describe('describeLeftoverLegacyKeys', () => {
  it('is silent only for a migrated pool with a complete, empty listing', () => {
    expect(describeLeftoverLegacyKeys(poolOf({}))).toBeNull();
    expect(describeLeftoverLegacyKeys(poolOf({ legacyKeys: ['x'] }))).toBeNull();
    expect(describeLeftoverLegacyKeys(poolOf({ migrated: true }))).toBeNull();
  });

  it('names leftovers and warns against deleting them prematurely', () => {
    const msg = describeLeftoverLegacyKeys(
      poolOf({ migrated: true, legacyKeys: ['unfoldingWord'] })
    );
    expect(msg).toContain('[unfoldingWord]');
    expect(msg).toContain('Do not delete');
  });

  it.each(['failed', 'truncated', 'skipped'] as const)(
    'warns that leftovers may exist unseen when the listing is %s',
    (status) => {
      const msg = describeLeftoverLegacyKeys(poolOf({ migrated: true, legacyListing: status }));
      expect(msg).toContain('may exist unseen');
    }
  );
});

describe('poolWriteAuthError', () => {
  it('accepts exactly the engine key', () => {
    expect(poolWriteAuthError('Bearer engine-key', 'engine-key')).toBeNull();
  });

  it.each([
    ['org-scoped key', 'Bearer org-key'],
    ['prefix of the engine key', 'Bearer engine'],
    ['missing Bearer prefix', 'engine-key'],
    ['empty token', 'Bearer '],
    ['no header', undefined],
  ])('rejects %s', (_label, header) => {
    expect(poolWriteAuthError(header, 'engine-key')).toContain('super admin');
  });
});
