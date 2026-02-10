import { describe, it, expect, vi, beforeEach } from 'vitest';
import { JsonMemoryStore } from '../../src/services/memory/store.js';
import {
  MEMORY_STORAGE_KEY,
  MAX_MEMORY_SIZE_BYTES,
  MemoryStorage,
} from '../../src/services/memory/types.js';

function createMockStorage() {
  const data = new Map<string, unknown>();
  return {
    get: vi.fn(async (key: string) => data.get(key)),
    put: vi.fn(async (key: string, value: unknown) => {
      data.set(key, value);
    }),
    delete: vi.fn(async (key: string) => data.delete(key)),
    _data: data,
  } as unknown as DurableObjectStorage & { _data: Map<string, unknown> };
}

function createMockLogger() {
  return {
    log: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as ReturnType<typeof vi.fn> & {
    log: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
  };
}

/** Helper to seed v2 JSON storage */
function seedEntries(
  storage: ReturnType<typeof createMockStorage>,
  entries: Record<
    string,
    { content: string; updatedAt?: number; createdAt?: number; pinned?: boolean }
  >
) {
  const now = Date.now();
  const memoryData: MemoryStorage = { entries: {} };
  for (const [name, entry] of Object.entries(entries)) {
    // eslint-disable-next-line security/detect-object-injection
    memoryData.entries[name] = {
      content: entry.content,
      updatedAt: entry.updatedAt ?? now,
      createdAt: entry.createdAt ?? now,
      pinned: entry.pinned,
    };
  }
  storage._data.set(MEMORY_STORAGE_KEY, memoryData);
}

let storage: ReturnType<typeof createMockStorage>;
let logger: ReturnType<typeof createMockLogger>;
let store: JsonMemoryStore;

beforeEach(() => {
  storage = createMockStorage();
  logger = createMockLogger();
  store = new JsonMemoryStore(
    storage as unknown as DurableObjectStorage,
    logger as ReturnType<typeof createMockLogger>
  );
});

describe('JsonMemoryStore - read full', () => {
  it('returns empty string when no memory exists', async () => {
    const result = await store.read();
    expect(result).toBe('');
  });

  it('returns full memory document as serialized markdown', async () => {
    seedEntries(storage, {
      'Section A': { content: 'Content A' },
      'Section B': { content: 'Content B' },
    });

    const result = await store.read();
    expect(typeof result).toBe('string');
    expect(result).toContain('## Section A');
    expect(result).toContain('Content A');
    expect(result).toContain('## Section B');
    expect(result).toContain('Content B');
  });

  it('logs memory_read_full for full reads', async () => {
    seedEntries(storage, { S: { content: 'Data' } });
    await store.read();
    expect(logger.log).toHaveBeenCalledWith(
      'memory_read_full',
      expect.objectContaining({
        section_count: 1,
        total_size_bytes: expect.any(Number),
        duration_ms: expect.any(Number),
      })
    );
  });
});

describe('JsonMemoryStore - read sections', () => {
  it('returns specific sections as content strings', async () => {
    seedEntries(storage, {
      Alpha: { content: 'Alpha content' },
      Beta: { content: 'Beta content' },
      Gamma: { content: 'Gamma content' },
    });

    const result = await store.read(['Alpha', 'Gamma']);
    expect(result).toEqual({
      Alpha: 'Alpha content',
      Gamma: 'Gamma content',
    });
  });

  it('omits missing sections from result', async () => {
    seedEntries(storage, { Exists: { content: 'Yes' } });

    const result = await store.read(['Exists', 'Missing']);
    expect(result).toEqual({
      Exists: 'Yes',
    });
  });

  it('logs memory_read for section reads', async () => {
    seedEntries(storage, { S: { content: 'Data' } });
    await store.read(['S']);
    expect(logger.log).toHaveBeenCalledWith(
      'memory_read',
      expect.objectContaining({
        sections_requested: ['S'],
        sections_returned: ['S'],
      })
    );
  });
});

describe('JsonMemoryStore - write', () => {
  it('creates new sections with timestamps', async () => {
    const result = await store.writeSections({ Progress: 'Phase 1 done' });
    expect(result.updated).toEqual(['Progress']);
    expect(result.deleted).toEqual([]);
    expect(result.evicted).toEqual([]);
    expect(result.totalSizeBytes).toBeGreaterThan(0);
    expect(result.capacityPercent).toBeGreaterThanOrEqual(0);

    const data = storage._data.get(MEMORY_STORAGE_KEY) as MemoryStorage;
    expect(data.entries['Progress']).toBeDefined();
    expect(data.entries['Progress'].content).toBe('Phase 1 done');
    expect(data.entries['Progress'].createdAt).toBeGreaterThan(0);
    expect(data.entries['Progress'].updatedAt).toBeGreaterThan(0);
  });

  it('updates existing sections and preserves createdAt', async () => {
    const earlier = Date.now() - 10000;
    seedEntries(storage, { Notes: { content: 'Old', createdAt: earlier, updatedAt: earlier } });

    const result = await store.writeSections({ Notes: 'New notes' });
    expect(result.updated).toEqual(['Notes']);

    const data = storage._data.get(MEMORY_STORAGE_KEY) as MemoryStorage;
    expect(data.entries['Notes'].content).toBe('New notes');
    expect(data.entries['Notes'].createdAt).toBe(earlier);
    expect(data.entries['Notes'].updatedAt).toBeGreaterThan(earlier);
  });

  it('deletes sections with null value', async () => {
    seedEntries(storage, {
      Keep: { content: 'Yes' },
      Remove: { content: 'No' },
    });
    const result = await store.writeSections({ Remove: null });
    expect(result.deleted).toEqual(['Remove']);

    const data = storage._data.get(MEMORY_STORAGE_KEY) as MemoryStorage;
    expect(data.entries['Keep']).toBeDefined();
    expect(data.entries['Remove']).toBeUndefined();
  });

  it('handles batch operations', async () => {
    seedEntries(storage, {
      A: { content: 'Old A' },
      B: { content: 'Old B' },
    });
    const result = await store.writeSections({
      A: 'New A',
      B: null,
      C: 'Brand new',
    });
    expect(result.updated.sort()).toEqual(['A', 'C']);
    expect(result.deleted).toEqual(['B']);
  });
});

describe('JsonMemoryStore - pinning', () => {
  it('pins sections via pin array', async () => {
    seedEntries(storage, { Notes: { content: 'Data' } });
    await store.writeSections({ Notes: 'Updated' }, ['Notes']);

    const data = storage._data.get(MEMORY_STORAGE_KEY) as MemoryStorage;
    expect(data.entries['Notes'].pinned).toBe(true);
  });

  it('unpins sections via unpin array', async () => {
    seedEntries(storage, { Notes: { content: 'Data', pinned: true } });
    await store.writeSections({ Notes: 'Updated' }, undefined, ['Notes']);

    const data = storage._data.get(MEMORY_STORAGE_KEY) as MemoryStorage;
    expect(data.entries['Notes'].pinned).toBeUndefined();
  });

  it('pinning a non-existent section is a no-op', async () => {
    const result = await store.writeSections({ A: 'Data' }, ['NonExistent']);
    expect(result.updated).toEqual(['A']);
    // No error thrown
  });

  it('preserves pinned status on update when no pin/unpin specified', async () => {
    seedEntries(storage, { Notes: { content: 'Data', pinned: true } });
    await store.writeSections({ Notes: 'Updated' });

    const data = storage._data.get(MEMORY_STORAGE_KEY) as MemoryStorage;
    expect(data.entries['Notes'].pinned).toBe(true);
  });
});

describe('JsonMemoryStore - eviction basics', () => {
  it('evicts oldest non-pinned entries when capacity exceeded', async () => {
    const entries: Record<string, { content: string; updatedAt: number; createdAt: number }> = {};
    const baseTime = Date.now() - 100000;
    for (let i = 0; i < 5; i++) {
      entries[`Entry${i}`] = {
        content: 'x'.repeat(1000),
        updatedAt: baseTime + i * 1000,
        createdAt: baseTime + i * 1000,
      };
    }
    seedEntries(storage, entries);

    const hugeContent = 'y'.repeat(MAX_MEMORY_SIZE_BYTES - 2000);
    const result = await store.writeSections({ Huge: hugeContent });

    expect(result.evicted.length).toBeGreaterThan(0);
    expect(result.totalSizeBytes).toBeLessThanOrEqual(MAX_MEMORY_SIZE_BYTES);
    expect(result.evicted[0]).toBe('Entry0');
  });

  it('does not evict pinned entries', async () => {
    const baseTime = Date.now() - 100000;
    seedEntries(storage, {
      Pinned: { content: 'x'.repeat(1000), pinned: true, updatedAt: baseTime, createdAt: baseTime },
      OldUnpinned: {
        content: 'x'.repeat(1000),
        updatedAt: baseTime + 1000,
        createdAt: baseTime + 1000,
      },
    });

    const hugeContent = 'y'.repeat(MAX_MEMORY_SIZE_BYTES - 500);
    const result = await store.writeSections({ Huge: hugeContent });

    expect(result.evicted).toContain('OldUnpinned');
    expect(result.evicted).not.toContain('Pinned');

    const data = storage._data.get(MEMORY_STORAGE_KEY) as MemoryStorage;
    expect(data.entries['Pinned']).toBeDefined();
  });

  it('write always succeeds even when storage is full', async () => {
    const fullContent = 'x'.repeat(MAX_MEMORY_SIZE_BYTES - 50);
    seedEntries(storage, { Full: { content: fullContent } });

    const result = await store.writeSections({ New: 'Some new content' });
    expect(result.totalSizeBytes).toBeLessThanOrEqual(MAX_MEMORY_SIZE_BYTES);
  });
});

describe('JsonMemoryStore - eviction edge cases', () => {
  it('truncates new content when only pinned entries remain and still over limit', async () => {
    const pinnedContent = 'p'.repeat(MAX_MEMORY_SIZE_BYTES - 100);
    seedEntries(storage, {
      BigPinned: { content: pinnedContent, pinned: true },
    });

    const result = await store.writeSections({ New: 'n'.repeat(200) }, ['New']);

    expect(result.totalSizeBytes).toBeLessThanOrEqual(MAX_MEMORY_SIZE_BYTES);
    expect(logger.warn).toHaveBeenCalledWith(
      'memory_content_truncated',
      expect.objectContaining({ entry_name: expect.any(String) })
    );
  });

  it('logs memory_evicted for each evicted entry', async () => {
    const baseTime = Date.now() - 100000;
    seedEntries(storage, {
      Old: { content: 'x'.repeat(1000), updatedAt: baseTime, createdAt: baseTime },
    });

    const hugeContent = 'y'.repeat(MAX_MEMORY_SIZE_BYTES);
    await store.writeSections({ Huge: hugeContent });

    expect(logger.log).toHaveBeenCalledWith(
      'memory_evicted',
      expect.objectContaining({
        entry_name: 'Old',
        size_freed_bytes: expect.any(Number),
      })
    );
  });
});

describe('JsonMemoryStore - v1 migration', () => {
  it('auto-migrates v1 markdown to v2 JSON', async () => {
    // Store v1 format (raw markdown string)
    storage._data.set(MEMORY_STORAGE_KEY, '## Progress\n\nPhase 1\n## Notes\n\nSome notes');

    const result = await store.read(['Progress']);
    expect(result).toEqual({
      Progress: '## Progress\n\nPhase 1',
    });

    // Should have logged migration
    expect(logger.log).toHaveBeenCalledWith(
      'memory_migrated_v1_to_v2',
      expect.objectContaining({
        section_count: 2,
        total_size_bytes: expect.any(Number),
      })
    );

    // Subsequent reads should use v2 format
    const data = storage._data.get(MEMORY_STORAGE_KEY) as MemoryStorage;
    expect(data.entries).toBeDefined();
    expect(data.entries['Progress']).toBeDefined();
    expect(data.entries['Notes']).toBeDefined();
  });

  it('migrated entries have timestamps', async () => {
    const beforeMigration = Date.now();
    storage._data.set(MEMORY_STORAGE_KEY, '## Section\n\nContent');

    await store.read();

    const data = storage._data.get(MEMORY_STORAGE_KEY) as MemoryStorage;
    expect(data.entries['Section'].createdAt).toBeGreaterThanOrEqual(beforeMigration);
    expect(data.entries['Section'].updatedAt).toBeGreaterThanOrEqual(beforeMigration);
  });

  it('handles empty v1 markdown', async () => {
    storage._data.set(MEMORY_STORAGE_KEY, '');
    const result = await store.read();
    expect(result).toBe('');
  });
});

describe('JsonMemoryStore - write logging', () => {
  it('logs memory_write on success with eviction info', async () => {
    await store.writeSections({ Test: 'Data' });
    expect(logger.log).toHaveBeenCalledWith(
      'memory_write',
      expect.objectContaining({
        sections_updated: ['Test'],
        sections_deleted: [],
        sections_evicted: [],
        size_before_bytes: expect.any(Number),
        size_after_bytes: expect.any(Number),
        duration_ms: expect.any(Number),
      })
    );
  });
});

describe('JsonMemoryStore - TOC', () => {
  it('returns empty TOC for empty memory', async () => {
    const toc = await store.getTableOfContents();
    expect(toc.entries).toEqual([]);
    expect(toc.totalSizeBytes).toBe(0);
    expect(toc.maxSizeBytes).toBe(MAX_MEMORY_SIZE_BYTES);
  });

  it('returns TOC with section info and pinned status', async () => {
    seedEntries(storage, {
      Progress: { content: 'Phase 1 done', pinned: true },
      Preferences: { content: 'Language: es' },
    });
    const toc = await store.getTableOfContents();
    expect(toc.entries).toHaveLength(2);
    expect(toc.entries[0].name).toBe('Progress');
    expect(toc.entries[0].pinned).toBe(true);
    expect(toc.entries[1].name).toBe('Preferences');
    expect(toc.entries[1].pinned).toBe(false);
  });

  it('logs memory_found_empty when no memory', async () => {
    await store.getTableOfContents();
    expect(logger.log).toHaveBeenCalledWith('memory_found_empty', {});
  });

  it('logs memory_toc_extracted when memory exists', async () => {
    seedEntries(storage, { S1: { content: 'Data' } });
    await store.getTableOfContents();
    expect(logger.log).toHaveBeenCalledWith(
      'memory_toc_extracted',
      expect.objectContaining({
        section_count: 1,
        sections: ['S1'],
      })
    );
  });
});

describe('JsonMemoryStore - clear and size', () => {
  it('removes all memory on clear', async () => {
    seedEntries(storage, { Data: { content: 'Content' } });
    await store.clear();
    expect(storage._data.has(MEMORY_STORAGE_KEY)).toBe(false);
  });

  it('logs memory_cleared', async () => {
    seedEntries(storage, { Data: { content: 'Content' } });
    await store.clear();
    expect(logger.log).toHaveBeenCalledWith(
      'memory_cleared',
      expect.objectContaining({ previous_size_bytes: expect.any(Number) })
    );
  });

  it('returns 0 for empty memory getSizeBytes', async () => {
    expect(await store.getSizeBytes()).toBe(0);
  });

  it('returns byte size of stored content', async () => {
    seedEntries(storage, { Test: { content: 'Hello world' } });
    const size = await store.getSizeBytes();
    expect(size).toBe(new TextEncoder().encode('Hello world').byteLength);
  });
});
