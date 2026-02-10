/**
 * User memory store (v2 — JSON with per-entry metadata)
 *
 * Stores entries as a JSON blob in Durable Object storage.
 * Supports auto-eviction of oldest non-pinned entries when capacity is exceeded.
 * Writes never fail — eviction always makes room.
 */

import { RequestLogger } from '../../utils/logger.js';
import { calculateTotalSize, parseV1Sections } from './parser.js';
import {
  MAX_MEMORY_SIZE_BYTES,
  MEMORY_STORAGE_KEY,
  MemoryEntry,
  MemoryStorage,
  MemoryTOC,
} from './types.js';
import { byteLength } from './utils.js';

export interface WriteResult {
  updated: string[];
  deleted: string[];
  evicted: string[];
  totalSizeBytes: number;
  capacityPercent: number;
}

export interface UserMemoryStore {
  /** Read full memory or specific sections */
  read(sections?: string[]): Promise<string | Record<string, string>>;

  /** Create/update sections (string) or delete them (null), with optional pin/unpin */
  writeSections(
    updates: Record<string, string | null>,
    pin?: string[],
    unpin?: string[]
  ): Promise<WriteResult>;

  /** Extract table of contents from current memory */
  getTableOfContents(): Promise<MemoryTOC>;

  /** Clear all memory */
  clear(): Promise<void>;

  /** Get total memory size in bytes */
  getSizeBytes(): Promise<number>;
}

/**
 * v2 implementation: JSON entries in DO storage with auto-eviction
 */
export class JsonMemoryStore implements UserMemoryStore {
  constructor(
    private storage: DurableObjectStorage,
    private logger: RequestLogger
  ) {}

  async read(sections?: string[]): Promise<string | Record<string, string>> {
    const startTime = Date.now();
    const data = await this.getMemoryData();

    if (!sections || sections.length === 0) {
      // Full read: return all entries as markdown-like content
      const content = this.serializeEntries(data.entries);
      this.logger.log('memory_read_full', {
        total_size_bytes: byteLength(content),
        section_count: Object.keys(data.entries).length,
        duration_ms: Date.now() - startTime,
      });
      return content;
    }

    const result: Record<string, string> = {};
    const returned: string[] = [];
    for (const name of sections) {
      // eslint-disable-next-line security/detect-object-injection -- name from caller input, used as object key
      const entry = data.entries[name];
      if (entry) {
        // eslint-disable-next-line security/detect-object-injection -- name from caller input, used as object key
        result[name] = entry.content;
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
    updates: Record<string, string | null>,
    pin?: string[],
    unpin?: string[]
  ): Promise<WriteResult> {
    const startTime = Date.now();
    const data = await this.getMemoryData();
    const sizeBefore = calculateTotalSize(data.entries);

    const { updated: updatedNames, deleted: deletedNames } = this.applyUpdates(data, updates);
    this.applyPinChanges(data, pin, unpin);
    const evictedNames = this.evictToFit(data);

    const sizeAfter = calculateTotalSize(data.entries);
    await this.storage.put(MEMORY_STORAGE_KEY, data);

    this.logger.log('memory_write', {
      sections_updated: updatedNames,
      sections_deleted: deletedNames,
      sections_evicted: evictedNames,
      size_before_bytes: sizeBefore,
      size_after_bytes: sizeAfter,
      duration_ms: Date.now() - startTime,
    });

    return {
      updated: updatedNames,
      deleted: deletedNames,
      evicted: evictedNames,
      totalSizeBytes: sizeAfter,
      capacityPercent: Math.round((sizeAfter / MAX_MEMORY_SIZE_BYTES) * 100),
    };
  }

  /** Apply section creates, updates, and deletes to in-memory data */
  private applyUpdates(
    data: MemoryStorage,
    updates: Record<string, string | null>
  ): { updated: string[]; deleted: string[] } {
    const updated: string[] = [];
    const deleted: string[] = [];
    const now = Date.now();

    for (const [name, value] of Object.entries(updates)) {
      if (value === null) {
        // eslint-disable-next-line security/detect-object-injection -- name from controlled iteration
        delete data.entries[name];
        deleted.push(name);
      } else {
        // eslint-disable-next-line security/detect-object-injection -- name from controlled iteration
        const existing = data.entries[name];
        const newEntry: MemoryEntry = {
          content: value,
          updatedAt: now,
          createdAt: existing?.createdAt ?? now,
        };
        if (existing?.pinned) {
          newEntry.pinned = true;
        }
        // eslint-disable-next-line security/detect-object-injection -- name from controlled iteration
        data.entries[name] = newEntry;
        updated.push(name);
      }
    }

    return { updated, deleted };
  }

  /** Apply pin and unpin changes to entries */
  private applyPinChanges(data: MemoryStorage, pin?: string[], unpin?: string[]): void {
    if (pin) {
      for (const name of pin) {
        // eslint-disable-next-line security/detect-object-injection -- name from caller input
        const entry = data.entries[name];
        if (entry) {
          entry.pinned = true;
        }
      }
    }
    if (unpin) {
      for (const name of unpin) {
        // eslint-disable-next-line security/detect-object-injection -- name from caller input
        const entry = data.entries[name];
        if (entry) {
          delete entry.pinned;
        }
      }
    }
  }

  async getTableOfContents(): Promise<MemoryTOC> {
    const data = await this.getMemoryData();
    const entryNames = Object.keys(data.entries);

    if (entryNames.length === 0) {
      this.logger.log('memory_found_empty', {});
      return { entries: [], totalSizeBytes: 0, maxSizeBytes: MAX_MEMORY_SIZE_BYTES };
    }

    const tocEntries = entryNames.map((name) => {
      // eslint-disable-next-line security/detect-object-injection -- name from Object.keys
      const entry = data.entries[name]!;
      return {
        name,
        sizeBytes: byteLength(entry.content),
        pinned: entry.pinned === true,
      };
    });

    const totalSizeBytes = calculateTotalSize(data.entries);

    this.logger.log('memory_toc_extracted', {
      section_count: tocEntries.length,
      total_size_bytes: totalSizeBytes,
      sections: entryNames,
    });

    return { entries: tocEntries, totalSizeBytes, maxSizeBytes: MAX_MEMORY_SIZE_BYTES };
  }

  async clear(): Promise<void> {
    const data = await this.getMemoryData();
    const previousSize = calculateTotalSize(data.entries);
    await this.storage.delete(MEMORY_STORAGE_KEY);
    this.logger.log('memory_cleared', { previous_size_bytes: previousSize });
  }

  async getSizeBytes(): Promise<number> {
    const data = await this.getMemoryData();
    return calculateTotalSize(data.entries);
  }

  /**
   * Evict oldest non-pinned entries until total size fits within MAX_MEMORY_SIZE_BYTES.
   * If only pinned entries remain and it still doesn't fit, truncate the newest entry's content.
   * Returns list of evicted entry names.
   */
  private evictToFit(data: MemoryStorage): string[] {
    const evicted: string[] = [];
    let totalSize = calculateTotalSize(data.entries);

    if (totalSize <= MAX_MEMORY_SIZE_BYTES) return evicted;

    // Collect non-pinned entries sorted by updatedAt ascending (oldest first)
    const nonPinned = Object.entries(data.entries)
      .filter(([, entry]) => !entry.pinned)
      .sort(([, a], [, b]) => a.updatedAt - b.updatedAt);

    // Evict oldest non-pinned entries until we fit
    for (const [name, entry] of nonPinned) {
      if (totalSize <= MAX_MEMORY_SIZE_BYTES) break;

      const freedBytes = byteLength(entry.content);
      this.logger.log('memory_evicted', {
        entry_name: name,
        age_ms: Date.now() - entry.updatedAt,
        size_freed_bytes: freedBytes,
      });

      // eslint-disable-next-line security/detect-object-injection -- name from Object.entries
      delete data.entries[name];
      evicted.push(name);
      totalSize -= freedBytes;
    }

    // If still over limit (only pinned remain), truncate the most recently updated entry's content
    if (totalSize > MAX_MEMORY_SIZE_BYTES) {
      const allEntries = Object.entries(data.entries).sort(
        ([, a], [, b]) => b.updatedAt - a.updatedAt
      );
      const newest = allEntries[0];
      if (newest) {
        const [newestName, newestEntry] = newest;
        const overage = totalSize - MAX_MEMORY_SIZE_BYTES;
        const contentBytes = byteLength(newestEntry.content);
        const targetBytes = contentBytes - overage;

        if (targetBytes > 0) {
          newestEntry.content = this.truncateToBytes(newestEntry.content, targetBytes);
          this.logger.warn('memory_content_truncated', {
            entry_name: newestName,
            original_bytes: contentBytes,
            truncated_to_bytes: byteLength(newestEntry.content),
          });
        }
      }
    }

    return evicted;
  }

  /** Truncate a string to fit within a byte budget */
  private truncateToBytes(str: string, maxBytes: number): string {
    const encoder = new TextEncoder();
    const encoded = encoder.encode(str);
    if (encoded.byteLength <= maxBytes) return str;

    const truncated = encoded.slice(0, maxBytes);
    const decoder = new TextDecoder();
    return decoder.decode(truncated);
  }

  /** Serialize all entries to a flat markdown string (for full reads) */
  private serializeEntries(entries: Record<string, MemoryEntry>): string {
    const parts: string[] = [];
    for (const [name, entry] of Object.entries(entries)) {
      parts.push(`## ${name}\n\n${entry.content}`);
    }
    return parts.join('\n');
  }

  /**
   * Get memory data, auto-migrating from v1 markdown format if needed.
   */
  private async getMemoryData(): Promise<MemoryStorage> {
    const raw = await this.storage.get<unknown>(MEMORY_STORAGE_KEY);

    if (raw === undefined || raw === null) {
      return { entries: {} };
    }

    // v2 format: JSON object with entries
    if (typeof raw === 'object' && !Array.isArray(raw) && 'entries' in (raw as object)) {
      return raw as MemoryStorage;
    }

    // v1 format: raw markdown string — migrate
    if (typeof raw === 'string') {
      return this.migrateV1(raw);
    }

    // Unknown format — start fresh
    this.logger.warn('memory_unknown_format', { type: typeof raw });
    return { entries: {} };
  }

  /**
   * Migrate v1 markdown memory to v2 JSON format.
   */
  private async migrateV1(markdown: string): Promise<MemoryStorage> {
    const now = Date.now();
    const sections = parseV1Sections(markdown);
    const entries: Record<string, MemoryEntry> = {};

    for (const section of sections) {
      entries[section.name] = {
        content: section.content,
        createdAt: now,
        updatedAt: now,
      };
    }

    const data: MemoryStorage = { entries };
    await this.storage.put(MEMORY_STORAGE_KEY, data);

    this.logger.log('memory_migrated_v1_to_v2', {
      section_count: sections.length,
      total_size_bytes: calculateTotalSize(entries),
    });

    return data;
  }
}
