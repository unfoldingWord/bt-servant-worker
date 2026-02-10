import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MarkdownMemoryStore } from '../../src/services/memory/store.js';
import { MEMORY_STORAGE_KEY, MAX_MEMORY_SIZE_BYTES } from '../../src/services/memory/types.js';

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

let storage: ReturnType<typeof createMockStorage>;
let logger: ReturnType<typeof createMockLogger>;
let store: MarkdownMemoryStore;

beforeEach(() => {
  storage = createMockStorage();
  logger = createMockLogger();
  store = new MarkdownMemoryStore(
    storage as unknown as DurableObjectStorage,
    logger as ReturnType<typeof createMockLogger>
  );
});

describe('MarkdownMemoryStore - read full', () => {
  it('returns empty string when no memory exists', async () => {
    const result = await store.read();
    expect(result).toBe('');
  });

  it('returns full memory document', async () => {
    const md = '## Section A\n\nContent A\n## Section B\n\nContent B';
    storage._data.set(MEMORY_STORAGE_KEY, md);

    const result = await store.read();
    expect(result).toBe(md);
  });

  it('logs memory_read_full for full reads', async () => {
    storage._data.set(MEMORY_STORAGE_KEY, '## S\n\nData');
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

describe('MarkdownMemoryStore - read sections', () => {
  it('returns specific sections', async () => {
    const md = '## Alpha\n\nAlpha content\n## Beta\n\nBeta content\n## Gamma\n\nGamma content';
    storage._data.set(MEMORY_STORAGE_KEY, md);

    const result = await store.read(['Alpha', 'Gamma']);
    expect(result).toEqual({
      Alpha: '## Alpha\n\nAlpha content',
      Gamma: '## Gamma\n\nGamma content',
    });
  });

  it('omits missing sections from result', async () => {
    storage._data.set(MEMORY_STORAGE_KEY, '## Exists\n\nYes');

    const result = await store.read(['Exists', 'Missing']);
    expect(result).toEqual({
      Exists: '## Exists\n\nYes',
    });
  });

  it('logs memory_read for section reads', async () => {
    storage._data.set(MEMORY_STORAGE_KEY, '## S\n\nData');
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

describe('MarkdownMemoryStore - write', () => {
  it('creates new sections', async () => {
    const result = await store.writeSections({ Progress: 'Phase 1 done' });
    expect(result.updated).toEqual(['Progress']);
    expect(result.deleted).toEqual([]);
    expect(result.totalSizeBytes).toBeGreaterThan(0);

    const raw = storage._data.get(MEMORY_STORAGE_KEY) as string;
    expect(raw).toContain('## Progress');
    expect(raw).toContain('Phase 1 done');
  });

  it('updates existing sections', async () => {
    storage._data.set(MEMORY_STORAGE_KEY, '## Notes\n\nOld');
    const result = await store.writeSections({ Notes: 'New notes' });
    expect(result.updated).toEqual(['Notes']);

    const raw = storage._data.get(MEMORY_STORAGE_KEY) as string;
    expect(raw).toContain('New notes');
    expect(raw).not.toContain('Old');
  });

  it('deletes sections with null value', async () => {
    storage._data.set(MEMORY_STORAGE_KEY, '## Keep\n\nYes\n## Remove\n\nNo');
    const result = await store.writeSections({ Remove: null });
    expect(result.deleted).toEqual(['Remove']);

    const raw = storage._data.get(MEMORY_STORAGE_KEY) as string;
    expect(raw).toContain('## Keep');
    expect(raw).not.toContain('## Remove');
  });

  it('handles batch operations', async () => {
    storage._data.set(MEMORY_STORAGE_KEY, '## A\n\nOld A\n## B\n\nOld B');
    const result = await store.writeSections({
      A: 'New A',
      B: null,
      C: 'Brand new',
    });
    expect(result.updated.sort()).toEqual(['A', 'C']);
    expect(result.deleted).toEqual(['B']);
  });
});

describe('MarkdownMemoryStore - write limits and logging', () => {
  it('rejects writes that exceed max size', async () => {
    const hugeContent = 'x'.repeat(MAX_MEMORY_SIZE_BYTES);
    await expect(store.writeSections({ Huge: hugeContent })).rejects.toThrow(
      'Memory would exceed maximum size'
    );
    expect(logger.warn).toHaveBeenCalledWith(
      'memory_write_rejected',
      expect.objectContaining({ reason: 'exceeds_max_size' })
    );
  });

  it('accepts a write just under the max size', async () => {
    const header = '## Big\n\n';
    const body = 'x'.repeat(MAX_MEMORY_SIZE_BYTES - header.length);
    const result = await store.writeSections({ Big: body });
    expect(result.totalSizeBytes).toBe(MAX_MEMORY_SIZE_BYTES);
  });

  it('rejects a write one byte over the max size', async () => {
    const header = '## Big\n\n';
    const body = 'x'.repeat(MAX_MEMORY_SIZE_BYTES - header.length + 1);
    await expect(store.writeSections({ Big: body })).rejects.toThrow(
      'Memory would exceed maximum size'
    );
  });

  it('logs memory_write on success', async () => {
    await store.writeSections({ Test: 'Data' });
    expect(logger.log).toHaveBeenCalledWith(
      'memory_write',
      expect.objectContaining({
        sections_updated: ['Test'],
        sections_deleted: [],
        size_before_bytes: expect.any(Number),
        size_after_bytes: expect.any(Number),
        duration_ms: expect.any(Number),
      })
    );
  });
});

describe('MarkdownMemoryStore - TOC', () => {
  it('returns empty TOC for empty memory', async () => {
    const toc = await store.getTableOfContents();
    expect(toc.entries).toEqual([]);
    expect(toc.totalSizeBytes).toBe(0);
    expect(toc.maxSizeBytes).toBe(MAX_MEMORY_SIZE_BYTES);
  });

  it('returns TOC with section info', async () => {
    storage._data.set(
      MEMORY_STORAGE_KEY,
      '## Progress\n\nPhase 1 done\n## Preferences\n\nLanguage: es'
    );
    const toc = await store.getTableOfContents();
    expect(toc.entries).toHaveLength(2);
    expect(toc.entries[0].name).toBe('Progress');
    expect(toc.entries[1].name).toBe('Preferences');
  });

  it('logs memory_found_empty when no memory', async () => {
    await store.getTableOfContents();
    expect(logger.log).toHaveBeenCalledWith('memory_found_empty', {});
  });

  it('logs memory_toc_extracted when memory exists', async () => {
    storage._data.set(MEMORY_STORAGE_KEY, '## S1\n\nData');
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

describe('MarkdownMemoryStore - clear and size', () => {
  it('removes all memory on clear', async () => {
    storage._data.set(MEMORY_STORAGE_KEY, '## Data\n\nContent');
    await store.clear();
    expect(storage._data.has(MEMORY_STORAGE_KEY)).toBe(false);
  });

  it('logs memory_cleared', async () => {
    storage._data.set(MEMORY_STORAGE_KEY, '## Data\n\nContent');
    await store.clear();
    expect(logger.log).toHaveBeenCalledWith(
      'memory_cleared',
      expect.objectContaining({ previous_size_bytes: expect.any(Number) })
    );
  });

  it('returns 0 for empty memory getSizeBytes', async () => {
    expect(await store.getSizeBytes()).toBe(0);
  });

  it('returns byte size of stored memory', async () => {
    const md = '## Test\n\nHello world';
    storage._data.set(MEMORY_STORAGE_KEY, md);
    expect(await store.getSizeBytes()).toBe(new TextEncoder().encode(md).byteLength);
  });
});
