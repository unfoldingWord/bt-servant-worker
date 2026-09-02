/**
 * Unit tests for the MCP server pool helpers (admin-portal#278): the public
 * projection that redacts authToken, and the write-rule merge that keeps a
 * stored token across a redacted read → edit → write round-trip.
 */
import { describe, expect, it } from 'vitest';
import type { MCPServerConfig } from '../../src/types/mcp';
import {
  mergeServerPool,
  mergeServerWrite,
  resolveAuthToken,
  toPublicServerConfig,
  toPublicServerConfigs,
  upsertServer,
} from '../../src/utils/mcp-servers';

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
