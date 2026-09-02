/**
 * Unit tests for the MCP server pool helpers (admin-portal#278): the public
 * projection that redacts authToken, and the write-rule merge that keeps a
 * stored token across a redacted read → edit → write round-trip.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MCPServerConfig, MCPServerWrite } from '../../src/types/mcp';
import {
  mergeServerPool,
  mergeServerWrite,
  readMcpServerPool,
  readMcpServerPoolOrEmpty,
  resetChatFallbackWarning,
  resolveAuthToken,
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

describe('toPublicServerConfig', () => {
  it('drops authToken and reports hasAuthToken=true for a non-empty token', () => {
    const pub = toPublicServerConfig(stored('a', { authToken: 'secret-123' }));
    expect(pub).toEqual({
      id: 'a',
      name: 'Server a',
      url: 'https://a.example.com/mcp',
      enabled: true,
      priority: 1,
      hasAuthToken: true,
    });
    expect('authToken' in pub).toBe(false);
    expect(JSON.stringify(pub)).not.toContain('secret-123');
  });

  it('reports hasAuthToken=false when the token is absent or empty', () => {
    expect(toPublicServerConfig(stored('a')).hasAuthToken).toBe(false);
    expect(toPublicServerConfig(stored('a', { authToken: '' })).hasAuthToken).toBe(false);
  });

  it('is an allowlist: unknown stored keys never reach the public shape', () => {
    const legacyStored = {
      ...stored('a', { authToken: 'sekrit' }),
      password: 'hunter2',
      hasAuthToken: false, // stale public-shape field persisted pre-#278
    } as unknown as MCPServerConfig;
    const pub = toPublicServerConfig(legacyStored);
    expect(Object.keys(pub).sort()).toEqual(
      ['enabled', 'hasAuthToken', 'id', 'name', 'priority', 'url'].sort()
    );
    expect(pub.hasAuthToken).toBe(true);
    expect(JSON.stringify(pub)).not.toMatch(/hunter2|sekrit/);
  });

  it('keeps every other field, including optional ones', () => {
    const pub = toPublicServerConfig(
      stored('a', { allowedTools: ['x'], transport: 'streamable-http', enabled: false })
    );
    expect(pub).toMatchObject({
      allowedTools: ['x'],
      transport: 'streamable-http',
      enabled: false,
      hasAuthToken: false,
    });
  });

  it('projects a pool in order', () => {
    const pool = [stored('b', { authToken: 't' }), stored('a')];
    expect(toPublicServerConfigs(pool).map((s) => [s.id, s.hasAuthToken])).toEqual([
      ['b', true],
      ['a', false],
    ]);
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
    expect('authToken' in mergeServerWrite({ ...stored('a'), authToken: null }, undefined)).toBe(
      false
    );
    expect('authToken' in mergeServerWrite({ ...stored('a'), authToken: '' }, stored('a'))).toBe(
      false
    );
  });

  it('persists only known MCPServerConfig fields (allowlist)', () => {
    const write = {
      ...stored('a'),
      hasAuthToken: true, // public-shape field from a GET → PUT round-trip
      password: 'hunter2', // unknown secret-looking key
      allowedTools: ['t'],
      transport: 'json-rpc',
    } as unknown as MCPServerWrite;
    const merged = mergeServerWrite(write, undefined);
    expect(Object.keys(merged).sort()).toEqual(
      ['allowedTools', 'enabled', 'id', 'name', 'priority', 'transport', 'url'].sort()
    );
    expect(JSON.stringify(merged)).not.toContain('hunter2');
  });

  it('takes every non-token field from the write, not from existing', () => {
    const merged = mergeServerWrite(
      { ...stored('a', { name: 'Renamed', priority: 7 }) },
      stored('a', { authToken: 'keep-me', allowedTools: ['old'] })
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

describe('mergeServerPool (PUT)', () => {
  const pool = [
    stored('a', { authToken: 'tok-a' }),
    stored('b', { authToken: 'tok-b' }),
    stored('c'),
  ];

  it('keeps exactly the written servers, in write order, merging tokens by id', () => {
    const next = mergeServerPool(
      [stored('c'), stored('a'), stored('d', { authToken: 'tok-d' })],
      pool
    );
    expect(next).toEqual([
      stored('c'),
      stored('a', { authToken: 'tok-a' }),
      stored('d', { authToken: 'tok-d' }),
    ]);
  });

  it('clears a token when the write says null', () => {
    const next = mergeServerPool([{ ...stored('a'), authToken: null }], pool);
    expect(next).toEqual([stored('a')]);
  });

  it('empties the pool for an empty write', () => {
    expect(mergeServerPool([], pool)).toEqual([]);
  });
});

describe('upsertServer (POST)', () => {
  const pool = [stored('a', { authToken: 'tok-a' }), stored('b')];

  it('replaces in place by id and preserves the token when omitted', () => {
    const next = upsertServer(stored('a', { priority: 9 }), pool);
    expect(next).toEqual([stored('a', { priority: 9, authToken: 'tok-a' }), stored('b')]);
  });

  it('appends a new id', () => {
    const next = upsertServer(stored('z', { authToken: 'tok-z' }), pool);
    expect(next.map((s) => s.id)).toEqual(['a', 'b', 'z']);
    expect(next[2].authToken).toBe('tok-z');
  });

  it('does not mutate the input pool', () => {
    const before = JSON.stringify(pool);
    upsertServer({ ...stored('a'), authToken: null }, pool);
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

function fakeKv(entries: Record<string, unknown>): KVNamespace {
  const store = new Map(Object.entries(entries));
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
    expect(pool).toEqual({ servers: [], migrated: true });
    expect(logger.warn).not.toHaveBeenCalled();
    expect(kv.list).not.toHaveBeenCalled();
  });

  it('falls back to the legacy key and reports migrated=false with the namespace keys', async () => {
    const kv = fakeKv({
      unfoldingWord: [stored('legacy', { authToken: 'tok-legacy-secret' })],
      'other-org': [stored('theirs')],
    });
    const logger = fakeLogger();
    const pool = await readMcpServerPool(kv, 'unfoldingWord', logger, 'admin');
    expect(pool.migrated).toBe(false);
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

  it('reports migrated=false when neither key exists (fresh namespace)', async () => {
    const pool = await readMcpServerPool(fakeKv({}), 'unfoldingWord', fakeLogger(), 'admin');
    expect(pool).toEqual({ servers: [], migrated: false });
  });

  it('reports migrated=false when only another org key holds servers', async () => {
    const kv = fakeKv({ 'other-org': [stored('theirs')] });
    const logger = fakeLogger();
    const pool = await readMcpServerPool(kv, 'unfoldingWord', logger, 'admin');
    expect(pool).toEqual({ servers: [], migrated: false });
    expect(logger.warn).toHaveBeenCalledWith(
      'mcp_global_key_missing',
      expect.objectContaining({ fallback_found: false, legacy_keys: ['other-org'] })
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
    expect(logger.warn).toHaveBeenCalledWith(
      'mcp_global_key_missing',
      expect.objectContaining({ legacy_keys: [] })
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
    expect(logger.warn).toHaveBeenCalledWith(
      'mcp_global_key_missing',
      expect.objectContaining({ legacy_keys: ['a', 'b'] })
    );
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
