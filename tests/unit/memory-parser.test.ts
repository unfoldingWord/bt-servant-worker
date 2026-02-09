import { describe, it, expect } from 'vitest';
import {
  parseMemoryDocument,
  serializeDocument,
  extractTOC,
  formatTOCForPrompt,
  getSection,
  updateSection,
  deleteSection,
} from '../../src/services/memory/parser.js';

describe('parseMemoryDocument - basic', () => {
  it('parses empty string into empty document', () => {
    const doc = parseMemoryDocument('');
    expect(doc.preamble).toBe('');
    expect(doc.sections).toEqual([]);
  });

  it('parses preamble-only document', () => {
    const doc = parseMemoryDocument('Just some text\nwith no headers');
    expect(doc.preamble).toBe('Just some text\nwith no headers');
    expect(doc.sections).toEqual([]);
  });

  it('parses single section', () => {
    const md = '## Progress\n\nCompleted phase 1.';
    const doc = parseMemoryDocument(md);
    expect(doc.preamble).toBe('');
    expect(doc.sections).toHaveLength(1);
    expect(doc.sections[0].name).toBe('Progress');
    expect(doc.sections[0].level).toBe(2);
    expect(doc.sections[0].content).toBe('## Progress\n\nCompleted phase 1.');
  });

  it('parses multiple sections', () => {
    const md = '## Section A\n\nContent A\n## Section B\n\nContent B';
    const doc = parseMemoryDocument(md);
    expect(doc.sections).toHaveLength(2);
    expect(doc.sections[0].name).toBe('Section A');
    expect(doc.sections[1].name).toBe('Section B');
  });

  it('preserves preamble before first section', () => {
    const md = 'This is preamble text.\n\n## First Section\n\nContent.';
    const doc = parseMemoryDocument(md);
    expect(doc.preamble).toBe('This is preamble text.\n');
    expect(doc.sections).toHaveLength(1);
    expect(doc.sections[0].name).toBe('First Section');
  });
});

describe('parseMemoryDocument - edge cases', () => {
  it('keeps sub-headers inside parent section', () => {
    const md = '## Parent\n\nIntro\n\n### Child\n\nChild content\n\n## Next\n\nOther';
    const doc = parseMemoryDocument(md);
    expect(doc.sections).toHaveLength(2);
    expect(doc.sections[0].name).toBe('Parent');
    expect(doc.sections[0].content).toContain('### Child');
    expect(doc.sections[0].content).toContain('Child content');
    expect(doc.sections[1].name).toBe('Next');
  });

  it('handles sections with duplicate names', () => {
    const md = '## Notes\n\nFirst\n## Notes\n\nSecond';
    const doc = parseMemoryDocument(md);
    expect(doc.sections).toHaveLength(2);
    expect(doc.sections[0].name).toBe('Notes');
    expect(doc.sections[1].name).toBe('Notes');
  });

  it('calculates byte sizes correctly for ASCII', () => {
    const md = '## Test\n\nHello';
    const doc = parseMemoryDocument(md);
    expect(doc.sections[0].sizeBytes).toBe(new TextEncoder().encode('## Test\n\nHello').byteLength);
  });

  it('calculates byte sizes correctly for multi-byte characters', () => {
    const md = '## Unicode\n\nHello 世界 🌍';
    const doc = parseMemoryDocument(md);
    const expected = new TextEncoder().encode('## Unicode\n\nHello 世界 🌍').byteLength;
    expect(doc.sections[0].sizeBytes).toBe(expected);
  });

  it('ignores # (h1) headers — only splits on ##', () => {
    const md = '# Title\n\nSome text\n## Real Section\n\nContent';
    const doc = parseMemoryDocument(md);
    expect(doc.preamble).toBe('# Title\n\nSome text');
    expect(doc.sections).toHaveLength(1);
    expect(doc.sections[0].name).toBe('Real Section');
  });
});

describe('serializeDocument', () => {
  it('serializes empty document to empty string', () => {
    expect(serializeDocument({ preamble: '', sections: [] })).toBe('');
  });

  it('serializes preamble-only document', () => {
    const result = serializeDocument({ preamble: 'Just text', sections: [] });
    expect(result).toBe('Just text');
  });

  it('round-trips through parse and serialize', () => {
    const originals = [
      '## Section A\n\nContent A\n## Section B\n\nContent B',
      'Preamble\n## Only Section\n\nBody text',
      '## Parent\n\nIntro\n\n### Child\n\nDeep content\n## Sibling\n\nOther',
    ];

    for (const md of originals) {
      const doc = parseMemoryDocument(md);
      expect(serializeDocument(doc)).toBe(md);
    }
  });
});

describe('extractTOC', () => {
  it('returns empty entries for empty document', () => {
    const doc = parseMemoryDocument('');
    const toc = extractTOC(doc);
    expect(toc.entries).toEqual([]);
    expect(toc.totalSizeBytes).toBe(0);
    expect(toc.maxSizeBytes).toBe(131072);
  });

  it('lists all sections with sizes', () => {
    const md = '## Alpha\n\nShort\n## Beta\n\nA bit longer content here';
    const doc = parseMemoryDocument(md);
    const toc = extractTOC(doc);

    expect(toc.entries).toHaveLength(2);
    expect(toc.entries[0].name).toBe('Alpha');
    expect(toc.entries[0].level).toBe(2);
    expect(toc.entries[0].sizeBytes).toBeGreaterThan(0);
    expect(toc.entries[1].name).toBe('Beta');
  });

  it('totalSizeBytes matches full document byte length', () => {
    const md = '## One\n\nFirst\n## Two\n\nSecond';
    const doc = parseMemoryDocument(md);
    const toc = extractTOC(doc);
    expect(toc.totalSizeBytes).toBe(new TextEncoder().encode(md).byteLength);
  });
});

describe('formatTOCForPrompt', () => {
  it('returns empty string when no sections', () => {
    const toc = { entries: [], totalSizeBytes: 0, maxSizeBytes: 131072 };
    expect(formatTOCForPrompt(toc)).toBe('');
  });

  it('formats sections as bullet list with sizes', () => {
    const toc = {
      entries: [
        { name: 'UTC Progress', level: 2, sizeBytes: 1230 },
        { name: 'Preferences', level: 2, sizeBytes: 512 },
      ],
      totalSizeBytes: 1742,
      maxSizeBytes: 131072,
    };
    const result = formatTOCForPrompt(toc);
    expect(result).toContain('- **UTC Progress** (1.2 KB)');
    expect(result).toContain('- **Preferences** (512 B)');
    expect(result).toContain('Total: 1.7 KB / 128.0 KB');
  });
});

describe('getSection', () => {
  it('returns section content when found', () => {
    const doc = parseMemoryDocument('## Target\n\nFound it\n## Other\n\nNope');
    expect(getSection(doc, 'Target')).toBe('## Target\n\nFound it');
  });

  it('returns null when not found', () => {
    const doc = parseMemoryDocument('## Exists\n\nYes');
    expect(getSection(doc, 'Missing')).toBeNull();
  });

  it('is case-sensitive', () => {
    const doc = parseMemoryDocument('## Progress\n\nData');
    expect(getSection(doc, 'progress')).toBeNull();
    expect(getSection(doc, 'Progress')).toBe('## Progress\n\nData');
  });
});

describe('updateSection', () => {
  it('updates existing section content', () => {
    const doc = parseMemoryDocument('## Notes\n\nOld content');
    const updated = updateSection(doc, 'Notes', 'New content');
    expect(updated.sections).toHaveLength(1);
    expect(updated.sections[0].content).toBe('## Notes\n\nNew content');
  });

  it('creates new section when name does not exist', () => {
    const doc = parseMemoryDocument('## Existing\n\nKeep');
    const updated = updateSection(doc, 'New Section', 'Fresh content');
    expect(updated.sections).toHaveLength(2);
    expect(updated.sections[1].name).toBe('New Section');
    expect(updated.sections[1].content).toBe('## New Section\n\nFresh content');
  });

  it('preserves other sections', () => {
    const doc = parseMemoryDocument('## A\n\nContent A\n## B\n\nContent B');
    const updated = updateSection(doc, 'A', 'Updated A');
    expect(updated.sections).toHaveLength(2);
    expect(updated.sections[0].content).toBe('## A\n\nUpdated A');
    expect(updated.sections[1].content).toBe('## B\n\nContent B');
  });

  it('preserves preamble', () => {
    const doc = parseMemoryDocument('Preamble text\n## Section\n\nBody');
    const updated = updateSection(doc, 'Section', 'New body');
    expect(updated.preamble).toBe('Preamble text');
  });

  it('accepts content that already has a header', () => {
    const doc = parseMemoryDocument('');
    const updated = updateSection(doc, 'Custom', '## Custom\n\nWith header');
    expect(updated.sections[0].content).toBe('## Custom\n\nWith header');
  });

  it('normalizes mismatched header to match section name', () => {
    const doc = parseMemoryDocument('');
    const updated = updateSection(doc, 'Progress', '## Current Status\n\nDone');
    expect(updated.sections[0].name).toBe('Progress');
    expect(updated.sections[0].content).toBe('## Progress\n\nDone');
  });
});

describe('deleteSection', () => {
  it('removes existing section', () => {
    const doc = parseMemoryDocument('## A\n\nKeep\n## B\n\nRemove\n## C\n\nKeep');
    const updated = deleteSection(doc, 'B');
    expect(updated.sections).toHaveLength(2);
    expect(updated.sections[0].name).toBe('A');
    expect(updated.sections[1].name).toBe('C');
  });

  it('returns unchanged doc when section not found', () => {
    const doc = parseMemoryDocument('## Only\n\nContent');
    const updated = deleteSection(doc, 'Missing');
    expect(updated.sections).toHaveLength(1);
    expect(updated.sections[0].name).toBe('Only');
  });

  it('preserves preamble', () => {
    const doc = parseMemoryDocument('Preamble\n## Section\n\nBody');
    const updated = deleteSection(doc, 'Section');
    expect(updated.preamble).toBe('Preamble');
    expect(updated.sections).toEqual([]);
  });
});
