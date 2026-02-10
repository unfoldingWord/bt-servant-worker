/**
 * User persisted memory types (v2 — JSON storage with per-entry metadata)
 *
 * Each entry has timestamps and an optional pinned flag.
 * Prompt overrides (especially `methodology`) control what Claude tracks.
 */

/**
 * Maximum memory document size in bytes (128KB).
 * Balances storage cost (~$2.50/month at 100K users on DO storage)
 * with utility. Average expected usage is ~10-20KB per user.
 */
export const MAX_MEMORY_SIZE_BYTES = 131072;

/** DO storage key for user memory */
export const MEMORY_STORAGE_KEY = 'user_memory';

/** A single entry in the memory store */
export interface MemoryEntry {
  content: string; // markdown text for this section
  updatedAt: number; // ms timestamp of last update
  createdAt: number; // ms timestamp of creation
  pinned?: boolean; // if true, never auto-evicted
}

/** What's stored in DO storage as a single JSON blob */
export interface MemoryStorage {
  entries: Record<string, MemoryEntry>;
}

/** Single entry in the table of contents */
export interface MemoryTOCEntry {
  name: string;
  sizeBytes: number;
  pinned: boolean;
}

/** Table of contents extracted from memory */
export interface MemoryTOC {
  entries: MemoryTOCEntry[];
  totalSizeBytes: number;
  maxSizeBytes: number;
}
