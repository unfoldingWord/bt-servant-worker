/**
 * User persisted memory types
 *
 * Schema-free markdown document per user, stored in the Durable Object.
 * The prompt overrides (especially `methodology`) control what Claude tracks.
 */

/**
 * Maximum memory document size in bytes (128KB).
 * Balances storage cost (~$2.50/month at 100K users on DO storage)
 * with utility. Average expected usage is ~10-20KB per user.
 */
export const MAX_MEMORY_SIZE_BYTES = 131072;

/** DO storage key for user memory */
export const MEMORY_STORAGE_KEY = 'user_memory';

/** A parsed section from the memory document */
export interface MemorySection {
  name: string;
  level: number; // heading level (2 for ##, 3 for ###, etc.)
  content: string; // full section content including sub-headings
  sizeBytes: number;
}

/** Parsed memory document: preamble + sections */
export interface MemoryDocument {
  preamble: string; // text before first section header
  sections: MemorySection[];
}

/** Single entry in the table of contents */
export interface MemoryTOCEntry {
  name: string;
  level: number;
  sizeBytes: number;
}

/** Table of contents extracted from a memory document */
export interface MemoryTOC {
  entries: MemoryTOCEntry[];
  totalSizeBytes: number;
  maxSizeBytes: number;
}
