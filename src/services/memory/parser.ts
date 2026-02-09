/**
 * Memory document parser
 *
 * Pure functions for parsing, serializing, and manipulating markdown
 * memory documents. Sections are delimited by ## (level 2) headers.
 */

import { MAX_MEMORY_SIZE_BYTES, MemoryDocument, MemorySection, MemoryTOC } from './types.js';

/** Regex to match markdown headings (## or deeper) at the start of a line */
const HEADING_REGEX = /^(#{2,6})\s+(.+)$/;

/** Calculate byte size of a string using TextEncoder */
function byteLength(str: string): number {
  return new TextEncoder().encode(str).byteLength;
}

/** Format byte size as human-readable string */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

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

interface ParseState {
  preamble: string;
  sections: MemorySection[];
  currentSection: { name: string; level: number; lines: string[] } | null;
}

function processLine(state: ParseState, line: string): void {
  const heading = parseLevel2Heading(line);
  if (heading) {
    if (state.currentSection) {
      state.sections.push(buildSection(state.currentSection));
    }
    state.currentSection = { name: heading, level: 2, lines: [line] };
  } else if (state.currentSection) {
    state.currentSection.lines.push(line);
  } else {
    state.preamble += (state.preamble ? '\n' : '') + line;
  }
}

/**
 * Parse a markdown string into a MemoryDocument.
 * Splits on level-2 headers (##). Sub-headers (###, ####) stay
 * inside their parent section.
 */
export function parseMemoryDocument(markdown: string): MemoryDocument {
  if (!markdown) {
    return { preamble: '', sections: [] };
  }

  const state: ParseState = { preamble: '', sections: [], currentSection: null };
  for (const line of markdown.split('\n')) {
    processLine(state, line);
  }

  if (state.currentSection) {
    state.sections.push(buildSection(state.currentSection));
  }
  return { preamble: state.preamble, sections: state.sections };
}

function buildSection(raw: { name: string; level: number; lines: string[] }): MemorySection {
  const content = raw.lines.join('\n');
  return {
    name: raw.name,
    level: raw.level,
    content,
    sizeBytes: byteLength(content),
  };
}

/**
 * Serialize a MemoryDocument back to a markdown string.
 * Round-trip: parseMemoryDocument(serializeDocument(doc)) ≈ doc
 */
export function serializeDocument(doc: MemoryDocument): string {
  const parts: string[] = [];
  if (doc.preamble) {
    parts.push(doc.preamble);
  }
  for (const section of doc.sections) {
    parts.push(section.content);
  }
  return parts.join('\n');
}

/**
 * Extract a table of contents from a MemoryDocument.
 */
export function extractTOC(doc: MemoryDocument): MemoryTOC {
  const fullText = serializeDocument(doc);
  const totalSizeBytes = byteLength(fullText);

  const entries = doc.sections.map((s) => ({
    name: s.name,
    level: s.level,
    sizeBytes: s.sizeBytes,
  }));

  return { entries, totalSizeBytes, maxSizeBytes: MAX_MEMORY_SIZE_BYTES };
}

/**
 * Format a TOC for injection into the system prompt.
 * Returns empty string if there are no sections.
 */
export function formatTOCForPrompt(toc: MemoryTOC): string {
  if (toc.entries.length === 0) return '';

  const lines = toc.entries.map((e) => `- **${e.name}** (${formatSize(e.sizeBytes)})`);
  lines.push('');
  lines.push(`Total: ${formatSize(toc.totalSizeBytes)} / ${formatSize(toc.maxSizeBytes)}`);
  return lines.join('\n');
}

/**
 * Get a section by name (case-sensitive).
 * Returns the section content or null if not found.
 */
export function getSection(doc: MemoryDocument, name: string): string | null {
  const section = doc.sections.find((s) => s.name === name);
  return section ? section.content : null;
}

/**
 * Update or create a section. Returns a new MemoryDocument.
 * If the section exists, replaces its content.
 * If it doesn't exist, appends a new ## section.
 */
export function updateSection(doc: MemoryDocument, name: string, content: string): MemoryDocument {
  const fullContent = content.startsWith('##') ? content : `## ${name}\n\n${content}`;
  const newSection: MemorySection = {
    name,
    level: 2,
    content: fullContent,
    sizeBytes: byteLength(fullContent),
  };

  const idx = doc.sections.findIndex((s) => s.name === name);
  const sections = [...doc.sections];
  if (idx >= 0) {
    // eslint-disable-next-line security/detect-object-injection -- idx from findIndex
    sections[idx] = newSection;
  } else {
    sections.push(newSection);
  }

  return { preamble: doc.preamble, sections };
}

/**
 * Delete a section by name. Returns a new MemoryDocument.
 */
export function deleteSection(doc: MemoryDocument, name: string): MemoryDocument {
  return {
    preamble: doc.preamble,
    sections: doc.sections.filter((s) => s.name !== name),
  };
}
