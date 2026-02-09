/**
 * User memory store
 *
 * Interface and v1 implementation for persistent user memory.
 * v1 stores a raw markdown string in Durable Object storage.
 */

import { RequestLogger } from '../../utils/logger.js';
import {
  deleteSection,
  extractTOC,
  getSection,
  parseMemoryDocument,
  serializeDocument,
  updateSection,
} from './parser.js';
import { MAX_MEMORY_SIZE_BYTES, MEMORY_STORAGE_KEY, MemoryTOC } from './types.js';
import { byteLength } from './utils.js';

export interface UserMemoryStore {
  /** Read full memory or specific sections */
  read(sections?: string[]): Promise<string | Record<string, string>>;

  /** Create/update sections (string) or delete them (null) */
  writeSections(updates: Record<string, string | null>): Promise<{
    updated: string[];
    deleted: string[];
    totalSizeBytes: number;
  }>;

  /** Extract table of contents from current memory */
  getTableOfContents(): Promise<MemoryTOC>;

  /** Clear all memory */
  clear(): Promise<void>;

  /** Get raw memory size in bytes */
  getSizeBytes(): Promise<number>;
}

/**
 * v1 implementation: markdown in DO storage
 */
export class MarkdownMemoryStore implements UserMemoryStore {
  constructor(
    private storage: DurableObjectStorage,
    private logger: RequestLogger
  ) {}

  async read(sections?: string[]): Promise<string | Record<string, string>> {
    const startTime = Date.now();
    const raw = await this.getRawMemory();

    if (!sections || sections.length === 0) {
      const doc = parseMemoryDocument(raw);
      this.logger.log('memory_read_full', {
        total_size_bytes: byteLength(raw),
        section_count: doc.sections.length,
        duration_ms: Date.now() - startTime,
      });
      return raw;
    }

    const doc = parseMemoryDocument(raw);
    const result: Record<string, string> = {};
    const returned: string[] = [];
    for (const name of sections) {
      const content = getSection(doc, name);
      if (content !== null) {
        // eslint-disable-next-line security/detect-object-injection -- name from caller input, used as object key
        result[name] = content;
        returned.push(name);
      }
    }

    this.logger.log('memory_read', {
      sections_requested: sections,
      sections_returned: returned,
      response_size_bytes: byteLength(JSON.stringify(result)),
      duration_ms: Date.now() - startTime,
    });

    return result;
  }

  async writeSections(
    updates: Record<string, string | null>
  ): Promise<{ updated: string[]; deleted: string[]; totalSizeBytes: number }> {
    const startTime = Date.now();
    const raw = await this.getRawMemory();
    const sizeBefore = byteLength(raw);
    let doc = parseMemoryDocument(raw);

    const updatedNames: string[] = [];
    const deletedNames: string[] = [];

    for (const [name, value] of Object.entries(updates)) {
      if (value === null) {
        doc = deleteSection(doc, name);
        deletedNames.push(name);
      } else {
        doc = updateSection(doc, name, value);
        updatedNames.push(name);
      }
    }

    const newRaw = serializeDocument(doc);
    const sizeAfter = byteLength(newRaw);

    if (sizeAfter > MAX_MEMORY_SIZE_BYTES) {
      this.logger.warn('memory_write_rejected', {
        reason: 'exceeds_max_size',
        attempted_size_bytes: sizeAfter,
        max_size_bytes: MAX_MEMORY_SIZE_BYTES,
      });
      throw new Error(
        `Memory would exceed maximum size (${sizeAfter} bytes > ${MAX_MEMORY_SIZE_BYTES} bytes)`
      );
    }

    await this.storage.put(MEMORY_STORAGE_KEY, newRaw);

    this.logger.log('memory_write', {
      sections_updated: updatedNames,
      sections_deleted: deletedNames,
      size_before_bytes: sizeBefore,
      size_after_bytes: sizeAfter,
      duration_ms: Date.now() - startTime,
    });

    return {
      updated: updatedNames,
      deleted: deletedNames,
      totalSizeBytes: sizeAfter,
    };
  }

  async getTableOfContents(): Promise<MemoryTOC> {
    const raw = await this.getRawMemory();
    const doc = parseMemoryDocument(raw);
    const toc = extractTOC(doc);

    if (toc.entries.length === 0) {
      this.logger.log('memory_empty', {});
    } else {
      this.logger.log('memory_toc_extracted', {
        section_count: toc.entries.length,
        total_size_bytes: toc.totalSizeBytes,
        sections: toc.entries.map((e) => e.name),
      });
    }

    return toc;
  }

  async clear(): Promise<void> {
    const raw = await this.getRawMemory();
    const previousSize = byteLength(raw);
    await this.storage.delete(MEMORY_STORAGE_KEY);
    this.logger.log('memory_cleared', { previous_size_bytes: previousSize });
  }

  async getSizeBytes(): Promise<number> {
    const raw = await this.getRawMemory();
    return byteLength(raw);
  }

  private async getRawMemory(): Promise<string> {
    return (await this.storage.get<string>(MEMORY_STORAGE_KEY)) ?? '';
  }
}
