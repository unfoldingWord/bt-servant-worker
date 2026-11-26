/**
 * Unit tests for verbatim relay tokens (#462).
 */

import { describe, it, expect } from 'vitest';
import {
  parseRelayBlocks,
  parseRelayServerIds,
  isRelayActive,
  RelayCollector,
  RelayRegistry,
  RelayStreamFilter,
  expandRelayBlock,
  formatRelayNote,
  type FilterOutput,
  type RelayBlock,
} from '../../src/services/claude/relay.js';
import type { ToolCatalog } from '../../src/services/mcp/types.js';
import { mockRelayLogger, registryWith } from './relay-test-helpers.js';

const X = [{ id: 'x', text: 'T' }];
const expand = (s: string, blocks: RelayBlock[] = X): string =>
  expandRelayBlock(s, registryWith(blocks)).text;

function feed(chunks: string[], blocks: RelayBlock[] = X): FilterOutput {
  const filter = new RelayStreamFilter(registryWith(blocks));
  const out: FilterOutput = { text: '', events: [] };
  for (const o of [...chunks.map((c) => filter.push(c)), filter.flush()]) {
    out.text += o.text;
    out.events.push(...o.events);
  }
  return out;
}

function collector(...blocks: RelayBlock[]): RelayCollector {
  const c = new RelayCollector();
  for (const b of blocks) c.add(b);
  c.close();
  return c;
}

describe('switch', () => {
  it('parses RELAY_SERVER_IDS', () => {
    expect(parseRelayServerIds(undefined)).toEqual([]);
    expect(parseRelayServerIds('  ,  , ')).toEqual([]);
    expect(parseRelayServerIds(' a ,b,  c ')).toEqual(['a', 'b', 'c']);
  });

  it('is active only when the catalog has a tool from a listed server', () => {
    const catalog = {
      tools: [{ name: 't', description: '', inputSchema: {}, serverId: 'obs' }],
      serverMap: new Map(),
    } as unknown as ToolCatalog;
    expect(isRelayActive([], catalog)).toBe(false);
    expect(isRelayActive(['other'], catalog)).toBe(false);
    expect(isRelayActive(['obs'], catalog)).toBe(true);
  });
});

describe('parseRelayBlocks', () => {
  it('keeps well-formed blocks and drops the rest with one warning', () => {
    const logger = mockRelayLogger();
    const blocks = parseRelayBlocks(
      [
        { id: 'good', text: 'ok', extra: 1 },
        { id: 'bad id', text: 'x' },
        { id: 'x', text: 1 },
        null,
      ],
      logger
    );
    expect(blocks).toEqual([{ id: 'good', text: 'ok' }]);
    expect(logger.warns).toEqual([{ event: 'relay_invalid_block', data: { dropped: 3 } }]);
    expect(parseRelayBlocks(undefined, logger)).toEqual([]);
    expect(parseRelayBlocks({ id: 'x', text: 'y' }, logger)).toEqual([]);
  });
});

describe('RelayCollector', () => {
  it('discards blocks added after close', () => {
    const logger = mockRelayLogger();
    const c = collector({ id: 'a', text: '1' });
    c.add({ id: 'b', text: '2' }, logger);
    expect(c.blocks).toEqual([{ id: 'a', text: '1' }]);
    expect(logger.warns[0]?.event).toBe('relay_late_block');
  });
});

describe('RelayRegistry', () => {
  it('keeps the first text for an id and announces an id only where its text matches', () => {
    const reg = new RelayRegistry();
    const logger = mockRelayLogger();
    const accepted = reg.ingestCollectors(
      [
        collector({ id: 'x', text: 'one' }, { id: 'x', text: 'two' }),
        collector({ id: 'x', text: 'one' }),
        collector({ id: 'x', text: 'two' }),
      ],
      logger
    );
    expect(logger.warns.filter((w) => w.event === 'relay_id_conflict')).toHaveLength(2);
    expect(accepted).toEqual([['x'], ['x'], []]);
    expect(reg.get('x')).toBe('one');
  });

  it('caps a turn at 200 blocks and 64 KiB', () => {
    const logger = mockRelayLogger();
    const many = collector(
      ...Array.from({ length: 201 }, (_, i) => ({ id: `id-${i}`, text: 'x' }))
    );
    expect(new RelayRegistry().ingestCollectors([many], logger)[0]).toHaveLength(200);
    const kib = (n: number) => 'y'.repeat(n * 1024);
    const reg = new RelayRegistry();
    const sized = [collector({ id: 'a', text: kib(40) }), collector({ id: 'b', text: kib(24) })];
    expect(reg.ingestCollectors(sized, logger)).toEqual([['a'], ['b']]);
    expect(reg.ingestCollectors([collector({ id: 'c', text: 'z' })], logger)).toEqual([[]]);
    expect(logger.warns.filter((w) => w.event === 'relay_limit_exceeded')).toHaveLength(2);
  });
});

describe('formatRelayNote', () => {
  it('lists accepted ids in the exact note text', () => {
    expect(formatRelayNote(['id-1', 'id-2'])).toBe(
      '\n\n[Relay blocks from this tool call. To show one exactly, write its token: {{relay:id-1}} {{relay:id-2}}. Do not retype this text. These ids work only in this turn.]'
    );
  });
});

describe('RelayStreamFilter', () => {
  it('replaces tokens with the exact text, never rescanned or treated as a pattern', () => {
    expect(expand('before {{relay:x}} after')).toBe('before T after');
    expect(expand('「{{relay:x}}」')).toBe('「T」');
    expect(expand('{{{relay:x}}')).toBe('{T');
    expect(expand('{{relay:x}}', [{ id: 'x', text: '$& {{relay:x}}' }])).toBe('$& {{relay:x}}');
    expect(
      expand('{{relay:a}}-{{relay:b}}', [
        { id: 'a', text: 'A' },
        { id: 'b', text: 'B' },
      ])
    ).toBe('A-B');
  });

  it('leaves text that is not an exact token alone', () => {
    for (const s of [
      '{{version}}',
      '{',
      'keep{{',
      '{{ relay:x }}',
      '{{Relay:x}}',
      '{{relay:a b}}',
    ]) {
      expect(expand(s)).toBe(s);
    }
    const long = `{{relay:${'a'.repeat(129)}}}`;
    expect(expand(long)).toBe(long);
  });

  it('removes unknown, repeated and cut tokens, and reports them', () => {
    expect(feed(['a{{relay:missing}}b'])).toEqual({
      text: 'ab',
      events: [{ type: 'unknown_id', id: 'missing' }],
    });
    expect(feed(['{{relay:x}}{{relay:x}}'])).toEqual({
      text: 'T',
      events: [{ type: 'repeated_id', id: 'x' }],
    });
    expect(feed(['Hi {{relay:x}'])).toEqual({ text: 'Hi ', events: [{ type: 'truncated_token' }] });
    expect(feed(['Hi {{relay:'])).toEqual({ text: 'Hi ', events: [{ type: 'truncated_token' }] });
    expect(feed(['Hi {{rel'])).toEqual({ text: 'Hi {{rel', events: [] });
  });

  it('passes text without a brace through at once and holds only a possible token', () => {
    const filter = new RelayStreamFilter(registryWith(X));
    expect(filter.push('plain text ').text).toBe('plain text ');
    expect(filter.push('then {{rel').text).toBe('then ');
    expect(filter.push('ay:x').text).toBe('');
    expect(filter.push('}} done').text).toBe('T done');
  });
});

/** Seeded PRNG so the property test is reproducible. */
function mulberry32(seed: number): () => number {
  return () => {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('RelayStreamFilter: split input equals whole input', () => {
  const blocks = [...X, { id: 'a'.repeat(128), text: 'L' }];
  const samples = [
    'plain',
    'a{{relay:x}}b{{relay:x}}c',
    '{{{{relay:x}}',
    '{ {{relay:x}} {{version}}',
    '{{relay:missing}} 中{{relay:x}}文',
    `{{relay:${'a'.repeat(128)}}}`,
    `{{relay:${'a'.repeat(129)}}}`,
    'end {{relay:x',
  ];

  it('for every single cut and for random multi-cuts, text and events match', () => {
    const rand = mulberry32(462_001);
    for (const s of samples) {
      const whole = feed([s], blocks);
      for (let cut = 0; cut <= s.length; cut++) {
        expect(feed([s.slice(0, cut), s.slice(cut)], blocks)).toEqual(whole);
      }
      for (let n = 0; n < 20; n++) {
        const chunks: string[] = [];
        for (let p = 0; p < s.length;) {
          const next = p + 1 + Math.floor(rand() * 5);
          chunks.push(s.slice(p, next));
          p = next;
        }
        expect(feed(chunks, blocks)).toEqual(whole);
      }
    }
  });
});
