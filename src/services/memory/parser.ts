/**
 * Memory parser and formatting utilities
 *
 * v2: Most parsing logic removed — JSON handles structure directly.
 * Remaining: TOC formatting for system prompt, v1 migration parsing.
 */

import { MemoryTOC } from './types.js';
import { byteLength } from './utils.js';

/** Format byte size as human-readable string */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

/**
 * Format a TOC for injection into the system prompt.
 * Returns empty string if there are no sections.
 */
export function formatTOCForPrompt(toc: MemoryTOC): string {
  if (toc.entries.length === 0) return '';

  const lines = toc.entries.map((e) => {
    const pinTag = e.pinned ? ' [pinned]' : '';
    return `- **${e.name}** (${formatSize(e.sizeBytes)})${pinTag}`;
  });
  lines.push('');
  lines.push(`Total: ${formatSize(toc.totalSizeBytes)} / ${formatSize(toc.maxSizeBytes)}`);
  return lines.join('\n');
}

/** Regex to match markdown headings (## or deeper) at the start of a line */
const HEADING_REGEX = /^(#{2,6})\s+(.+)$/;

/** Check if a line is a level-2 heading and return the heading text, or null */
function parseLevel2Heading(line: string): string | null {
  const match = HEADING_REGEX.exec(line);
  const hashes = match?.[1];
  const heading = match?.[2];
  if (hashes && heading && hashes.length === 2) {
    return heading.trim();
  }
  return null;
}

interface V1Section {
  name: string;
  content: string;
}

/**
 * Parse v1 markdown memory into sections.
 * Used only for migration from v1 (raw markdown) to v2 (JSON).
 */
export function parseV1Sections(markdown: string): V1Section[] {
  if (!markdown) return [];

  const sections: V1Section[] = [];
  let currentName: string | null = null;
  const currentLines: string[] = [];

  for (const line of markdown.split('\n')) {
    const heading = parseLevel2Heading(line);
    if (heading) {
      if (currentName !== null) {
        sections.push({ name: currentName, content: currentLines.join('\n') });
      }
      currentName = heading;
      currentLines.length = 0;
      currentLines.push(line);
    } else if (currentName !== null) {
      currentLines.push(line);
    }
    // Lines before first heading (preamble) are dropped during migration
  }

  if (currentName !== null) {
    sections.push({ name: currentName, content: currentLines.join('\n') });
  }

  return sections;
}

/**
 * Calculate total byte size of all entries' content.
 */
export function calculateTotalSize(entries: Record<string, { content: string }>): number {
  let total = 0;
  for (const entry of Object.values(entries)) {
    total += byteLength(entry.content);
  }
  return total;
}
