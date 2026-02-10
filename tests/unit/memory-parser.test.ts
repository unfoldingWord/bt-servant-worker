import { describe, it, expect } from 'vitest';
import {
  formatTOCForPrompt,
  formatSize,
  parseV1Sections,
  calculateTotalSize,
} from '../../src/services/memory/parser.js';

describe('formatSize', () => {
  it('formats bytes under 1KB', () => {
    expect(formatSize(512)).toBe('512 B');
    expect(formatSize(0)).toBe('0 B');
  });

  it('formats kilobytes', () => {
    expect(formatSize(1024)).toBe('1.0 KB');
    expect(formatSize(1230)).toBe('1.2 KB');
    expect(formatSize(131072)).toBe('128.0 KB');
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
        { name: 'UTC Progress', sizeBytes: 1230, pinned: false },
        { name: 'Preferences', sizeBytes: 512, pinned: false },
      ],
      totalSizeBytes: 1742,
      maxSizeBytes: 131072,
    };
    const result = formatTOCForPrompt(toc);
    expect(result).toContain('- **UTC Progress** (1.2 KB)');
    expect(result).toContain('- **Preferences** (512 B)');
    expect(result).toContain('Total: 1.7 KB / 128.0 KB');
  });

  it('shows [pinned] indicator for pinned entries', () => {
    const toc = {
      entries: [
        { name: 'UTC: Romans 8', sizeBytes: 200, pinned: true },
        { name: 'Old Notes', sizeBytes: 2100, pinned: false },
      ],
      totalSizeBytes: 2300,
      maxSizeBytes: 131072,
    };
    const result = formatTOCForPrompt(toc);
    expect(result).toContain('- **UTC: Romans 8** (200 B) [pinned]');
    expect(result).toContain('- **Old Notes** (2.1 KB)');
    expect(result).not.toContain('Old Notes** (2.1 KB) [pinned]');
  });
});

describe('parseV1Sections', () => {
  it('parses empty string into empty array', () => {
    expect(parseV1Sections('')).toEqual([]);
  });

  it('parses single section', () => {
    const sections = parseV1Sections('## Progress\n\nPhase 1 done');
    expect(sections).toHaveLength(1);
    expect(sections[0].name).toBe('Progress');
    expect(sections[0].content).toBe('## Progress\n\nPhase 1 done');
  });

  it('parses multiple sections', () => {
    const sections = parseV1Sections('## A\n\nContent A\n## B\n\nContent B');
    expect(sections).toHaveLength(2);
    expect(sections[0].name).toBe('A');
    expect(sections[1].name).toBe('B');
  });

  it('keeps sub-headers inside parent section', () => {
    const sections = parseV1Sections(
      '## Parent\n\nIntro\n\n### Child\n\nChild text\n## Next\n\nOther'
    );
    expect(sections).toHaveLength(2);
    expect(sections[0].name).toBe('Parent');
    expect(sections[0].content).toContain('### Child');
    expect(sections[1].name).toBe('Next');
  });

  it('drops preamble text before first heading', () => {
    const sections = parseV1Sections('Preamble text\n## Section\n\nContent');
    expect(sections).toHaveLength(1);
    expect(sections[0].name).toBe('Section');
  });
});

describe('calculateTotalSize', () => {
  it('returns 0 for empty entries', () => {
    expect(calculateTotalSize({})).toBe(0);
  });

  it('sums byte sizes of all entry contents', () => {
    const entries = {
      a: { content: 'hello' },
      b: { content: 'world' },
    };
    const expected =
      new TextEncoder().encode('hello').byteLength + new TextEncoder().encode('world').byteLength;
    expect(calculateTotalSize(entries)).toBe(expected);
  });

  it('handles multi-byte characters', () => {
    const entries = { unicode: { content: '世界 🌍' } };
    expect(calculateTotalSize(entries)).toBe(new TextEncoder().encode('世界 🌍').byteLength);
  });
});
