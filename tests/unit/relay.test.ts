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
  expandRelayText,
  formatRelayNote,
} from '../../src/services/claude/relay.js';
import type { ToolCatalog } from '../../src/services/mcp/types.js';
import { mockRelayLogger, registryWith } from './relay-test-helpers.js';

function feed(filter: RelayStreamFilter, chunks: string[]): string {
  let out = '';
  for (const c of chunks) out += filter.push(c).text;
  out += filter.flush().text;
  return out;
}

describe('parseRelayServerIds', () => {
  it('returns empty for unset, empty, or whitespace-only', () => {
    expect(parseRelayServerIds(undefined)).toEqual([]);
    expect(parseRelayServerIds('')).toEqual([]);
    expect(parseRelayServerIds('  ,  , ')).toEqual([]);
  });

  it('trims and splits comma-separated ids', () => {
    expect(parseRelayServerIds(' a ,b,  c ')).toEqual(['a', 'b', 'c']);
  });
});

describe('isRelayActive', () => {
  const tool = (serverId: string): ToolCatalog =>
    ({
      tools: [{ name: 't', description: '', inputSchema: {}, serverId, serverName: 'n' }],
      serverMap: new Map(),
    }) as ToolCatalog;

  it('is false when server id list is empty', () => {
    expect(isRelayActive([], tool('obs'))).toBe(false);
  });

  it('is false when catalog has no tool from listed servers', () => {
    expect(isRelayActive(['obs'], tool('other'))).toBe(false);
  });

  it('is true when catalog has a tool from a listed server', () => {
    expect(isRelayActive(['obs'], tool('obs'))).toBe(true);
  });
});

describe('parseRelayBlocks', () => {
  it('accepts well-formed blocks', () => {
    const logger = mockRelayLogger();
    expect(
      parseRelayBlocks([{ id: 'obs-en-01-05-observation', text: '- Q1\n- Q2' }], logger)
    ).toEqual([{ id: 'obs-en-01-05-observation', text: '- Q1\n- Q2' }]);
    expect(logger.warns).toEqual([]);
  });

  it('ignores invalid blocks and logs relay_invalid_block', () => {
    const logger = mockRelayLogger();
    const blocks = parseRelayBlocks(
      [
        { id: 'good', text: 'ok' },
        { id: 'bad id', text: 'x' },
        { id: 'a$b', text: 'x' },
        { id: '', text: 'x' },
        { id: 'x', text: 1 },
        null,
        'nope',
      ],
      logger
    );
    expect(blocks).toEqual([{ id: 'good', text: 'ok' }]);
    expect(logger.warns.every((w) => w.event === 'relay_invalid_block')).toBe(true);
  });

  it('ignores non-array meta', () => {
    const logger = mockRelayLogger();
    expect(parseRelayBlocks(undefined, logger)).toEqual([]);
    expect(parseRelayBlocks({ id: 'x', text: 'y' }, logger)).toEqual([]);
  });
});

describe('RelayCollector', () => {
  it('discards late blocks after close', () => {
    const logger = mockRelayLogger();
    const c = new RelayCollector();
    c.add({ id: 'a', text: '1' });
    c.close();
    c.add({ id: 'b', text: '2' }, logger);
    expect(c.blocks).toEqual([{ id: 'a', text: '1' }]);
    expect(logger.warns[0]?.event).toBe('relay_late_block');
  });
});

describe('RelayRegistry conflict', () => {
  it('keeps first text on id conflict', () => {
    const logger = mockRelayLogger();
    const a = new RelayCollector();
    a.add({ id: 'same', text: 'first' });
    a.add({ id: 'same', text: 'second' });
    a.close();
    const reg = new RelayRegistry();
    expect(reg.ingestCollectors([a], logger)).toEqual([['same']]);
    expect(reg.get('same')).toBe('first');
    expect(logger.warns.some((w) => w.event === 'relay_id_conflict')).toBe(true);
  });

  it('accepts matching duplicate across collectors', () => {
    const logger = mockRelayLogger();
    const a = new RelayCollector();
    a.add({ id: 'x', text: 'same' });
    a.close();
    const b = new RelayCollector();
    b.add({ id: 'x', text: 'same' });
    b.close();
    expect(new RelayRegistry().ingestCollectors([a, b], logger)).toEqual([['x'], ['x']]);
  });

  it('omits conflicting later id from that collector note', () => {
    const logger = mockRelayLogger();
    const a = new RelayCollector();
    a.add({ id: 'x', text: 'one' });
    a.close();
    const b = new RelayCollector();
    b.add({ id: 'x', text: 'two' });
    b.close();
    const reg = new RelayRegistry();
    expect(reg.ingestCollectors([a, b], logger)).toEqual([['x'], []]);
    expect(reg.get('x')).toBe('one');
  });
});

describe('RelayRegistry limits', () => {
  it('enforces the 200-block cap', () => {
    const logger = mockRelayLogger();
    const c = new RelayCollector();
    for (let i = 0; i < 201; i++) c.add({ id: `id-${i}`, text: 'x' });
    c.close();
    expect(new RelayRegistry().ingestCollectors([c], logger)[0]!.length).toBe(200);
    expect(logger.warns.some((w) => w.event === 'relay_limit_exceeded')).toBe(true);
  });

  it('enforces the 64KB cap', () => {
    const logger = mockRelayLogger();
    const big = new RelayCollector();
    big.add({ id: 'big', text: 'y'.repeat(64 * 1024 + 1) });
    big.close();
    expect(new RelayRegistry().ingestCollectors([big], logger)[0]).toEqual([]);
    expect(logger.warns.some((w) => w.event === 'relay_limit_exceeded')).toBe(true);
  });
});

describe('formatRelayNote', () => {
  it('lists accepted ids in the exact note text', () => {
    expect(formatRelayNote(['id-1', 'id-2'])).toBe(
      '\n\n[Relay blocks from this tool call. To show one exactly, write its token: {{relay:id-1}} {{relay:id-2}}. Do not retype this text. These ids work only in this turn.]'
    );
  });
});

describe('RelayStreamFilter expansion', () => {
  const text = 'HELLO $& WORLD';
  const reg = () => registryWith([{ id: 'x', text }]);

  it('expands a whole token', () => {
    expect(expandRelayText('before {{relay:x}} after', reg(), mockRelayLogger())).toBe(
      `before ${text} after`
    );
  });

  it('expands a token split at every cut position', () => {
    const token = '{{relay:x}}';
    for (let i = 1; i < token.length; i++) {
      expect(feed(new RelayStreamFilter(reg()), [token.slice(0, i), token.slice(i)])).toBe(text);
    }
  });

  it('expands one character per chunk', () => {
    expect(feed(new RelayStreamFilter(reg()), '{{relay:x}}'.split(''))).toBe(text);
  });

  it('expands several tokens', () => {
    const r = registryWith([
      { id: 'a', text: 'A' },
      { id: 'b', text: 'B' },
    ]);
    expect(expandRelayText('{{relay:a}}-{{relay:b}}', r, mockRelayLogger())).toBe('A-B');
  });

  it('emits leading brace then expands {{{relay:abc}}', () => {
    const r = registryWith([{ id: 'abc', text: 'Z' }]);
    expect(expandRelayText('{{{relay:abc}}', r, mockRelayLogger())).toBe('{Z');
  });

  it('handles { {{relay:x}}', () => {
    expect(expandRelayText('{ {{relay:x}}', reg(), mockRelayLogger())).toBe(`{ ${text}`);
  });

  it('accepts spaced case-insensitive opening', () => {
    expect(expandRelayText('{{ Relay : x }}', reg(), mockRelayLogger())).toBe(text);
  });

  it('inserts $& literally without replace semantics', () => {
    expect(expandRelayText('{{relay:x}}', reg(), mockRelayLogger())).toBe('HELLO $& WORLD');
  });

  it('does not rescan inserted text that contains a token', () => {
    const r = registryWith([{ id: 'outer', text: 'see {{relay:inner}}' }]);
    expect(expandRelayText('{{relay:outer}}', r, mockRelayLogger())).toBe('see {{relay:inner}}');
  });
});

describe('RelayStreamFilter error paths', () => {
  const reg = () => registryWith([{ id: 'x', text: 'T' }]);

  it('removes a repeated id and logs once', () => {
    const logger = mockRelayLogger();
    expect(expandRelayText('{{relay:x}}{{relay:x}}', reg(), logger)).toBe('T');
    expect(logger.warns.filter((w) => w.event === 'relay_repeated_id')).toHaveLength(1);
  });

  it('removes unknown id and logs once', () => {
    const logger = mockRelayLogger();
    expect(expandRelayText('a{{relay:missing}}b', reg(), logger)).toBe('ab');
    expect(logger.warns.filter((w) => w.event === 'relay_unknown_id')).toHaveLength(1);
  });

  it('removes a truncated valid token on flush', () => {
    const logger = mockRelayLogger();
    expect(expandRelayText('{{relay:x', reg(), logger)).toBe('');
    expect(logger.warns.some((w) => w.event === 'relay_truncated_token')).toBe(true);
  });

  it('removes malformed tokens through }}', () => {
    const logger = mockRelayLogger();
    expect(expandRelayText('a{{relay:ab c}}b', reg(), logger)).toBe('ab');
    expect(logger.warns.some((w) => w.event === 'relay_malformed_token')).toBe(true);
    const logger2 = mockRelayLogger();
    expect(expandRelayText('a{{relay:a$b}}b', reg(), logger2)).toBe('ab');
    expect(logger2.warns.some((w) => w.event === 'relay_malformed_token')).toBe(true);
  });

  it('leaves {{version}}, lone {, and trailing {{ alone', () => {
    expect(expandRelayText('{{version}}', reg(), mockRelayLogger())).toBe('{{version}}');
    expect(expandRelayText('{', reg(), mockRelayLogger())).toBe('{');
    expect(expandRelayText('keep{{', reg(), mockRelayLogger())).toBe('keep{{');
  });

  it('handles unicode around a token', () => {
    expect(expandRelayText('「{{relay:x}}」', reg(), mockRelayLogger())).toBe('「T」');
  });
});

describe('RelayStreamFilter 200-char window (Corrección 1)', () => {
  it('does not treat }} beyond 200 chars from opening as malformed close', () => {
    const s = `{{relay:${'a'.repeat(250)}}}`;
    const whole = expandRelayText(s, registryWith([{ id: 'x', text: 'T' }]), mockRelayLogger());
    const cutAt200 = feed(new RelayStreamFilter(registryWith([{ id: 'x', text: 'T' }])), [
      s.slice(0, 200),
      s.slice(200),
    ]);
    expect(whole).toBe(s);
    expect(cutAt200).toBe(whole);
  });

  it('rescans so a later valid token still expands when a long malformed prefix has no }} in 200', () => {
    const s = `{{relay: ${'q'.repeat(300)} {{relay:x}}`;
    const whole = expandRelayText(s, registryWith([{ id: 'x', text: 'T' }]), mockRelayLogger());
    const cutAt200 = feed(new RelayStreamFilter(registryWith([{ id: 'x', text: 'T' }])), [
      s.slice(0, 200),
      s.slice(200),
    ]);
    expect(whole).toContain('T');
    expect(whole).toBe(cutAt200);
  });

  it('boundaries 199/200/201 with and without }} match across a cut', () => {
    const reg = () => registryWith([{ id: 'x', text: 'T' }]);
    for (const n of [199, 200, 201]) {
      for (const close of [true, false]) {
        const body = 'a'.repeat(Math.max(0, n - '{{relay:'.length - (close ? 2 : 0)));
        const s = `{{relay:${body}${close ? '}}' : ''}`;
        const whole = expandRelayText(s, reg(), mockRelayLogger());
        for (const cut of [0, 1, Math.min(200, s.length), s.length]) {
          expect(feed(new RelayStreamFilter(reg()), [s.slice(0, cut), s.slice(cut)])).toBe(whole);
        }
      }
    }
  });

  it('removes empty-id cut token {{relay: on flush', () => {
    const logger = mockRelayLogger();
    expect(expandRelayText('Hi {{relay:', registryWith([]), logger)).toBe('Hi ');
    expect(logger.warns.some((w) => w.event === 'relay_truncated_token')).toBe(true);
  });
});

describe('RelayRegistry exact limits (Corrección 1)', () => {
  it('accepts a block of exactly 64 KiB', () => {
    const logger = mockRelayLogger();
    const c = new RelayCollector();
    c.add({ id: 'exact', text: 'y'.repeat(64 * 1024) });
    c.close();
    expect(new RelayRegistry().ingestCollectors([c], logger)[0]).toEqual(['exact']);
  });

  it('enforces the 64 KiB cap across two collectors', () => {
    const logger = mockRelayLogger();
    const a = new RelayCollector();
    a.add({ id: 'a', text: 'y'.repeat(40 * 1024) });
    a.close();
    const b = new RelayCollector();
    b.add({ id: 'b', text: 'y'.repeat(40 * 1024) });
    b.close();
    const reg = new RelayRegistry();
    expect(reg.ingestCollectors([a, b], logger)).toEqual([['a'], []]);
    expect(logger.warns.some((w) => w.event === 'relay_limit_exceeded')).toBe(true);
  });

  it('accepts only the text that matches the registry for a conflicting second block', () => {
    const logger = mockRelayLogger();
    const prior = new RelayCollector();
    prior.add({ id: 'x', text: 'B' });
    prior.close();
    const reg = new RelayRegistry();
    reg.ingestCollectors([prior], mockRelayLogger());
    const c = new RelayCollector();
    c.add({ id: 'x', text: 'A' });
    c.add({ id: 'x', text: 'B' });
    c.close();
    // First in-collector wins for A; registry already has B → conflict on A, skip; B matches.
    // Within collector, first id wins (A), second (B) is skipped as duplicate id in collector.
    expect(reg.ingestCollectors([c], logger)).toEqual([[]]);
    expect(reg.get('x')).toBe('B');
  });
});

/** Seeded PRNG so property tests are reproducible. */
function mulberry32(seed: number): () => number {
  return () => {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function feedWithEvents(
  filter: RelayStreamFilter,
  chunks: string[]
): { text: string; events: ReturnType<RelayStreamFilter['push']>['events'] } {
  let text = '';
  const events: ReturnType<RelayStreamFilter['push']>['events'] = [];
  for (const c of chunks) {
    const o = filter.push(c);
    text += o.text;
    events.push(...o.events);
  }
  const o = filter.flush();
  text += o.text;
  events.push(...o.events);
  return { text, events };
}

const CHUNK_SAMPLES = [
  'plain',
  '{{relay:x}}',
  'a{{relay:x}}b{{relay:x}}c',
  '{{{relay:x}}',
  '{ {{relay:x}}',
  '{{version}} and {{relay:x}}',
  '{{relay:missing}}',
  '中{{relay:x}}文',
  '{{ Relay : x }}',
  '{{{{relay:x}}',
  `{{relay:${'a'.repeat(128)}}}`,
  `{{relay:${'a'.repeat(129)}}}`,
  `{{relay:${'a'.repeat(250)}}}`,
  `{{relay: ${'q'.repeat(300)} {{relay:x}}`,
];

const CHUNK_BLOCKS = [
  { id: 'x', text: 'T' },
  { id: 'a'.repeat(128), text: 'L' },
];

describe('RelayStreamFilter single-cut property', () => {
  it('equals whole input for text and events', () => {
    for (const s of CHUNK_SAMPLES) {
      for (let cut = 0; cut <= s.length; cut++) {
        const whole = feedWithEvents(new RelayStreamFilter(registryWith(CHUNK_BLOCKS)), [s]);
        const chunked = feedWithEvents(new RelayStreamFilter(registryWith(CHUNK_BLOCKS)), [
          s.slice(0, cut),
          s.slice(cut),
        ]);
        expect(chunked.text).toBe(whole.text);
        expect(chunked.events).toEqual(whole.events);
      }
    }
  });
});

describe('RelayStreamFilter seeded multi-cut property', () => {
  it('equals whole input for text and events', () => {
    const rand = mulberry32(462_001);
    for (const s of CHUNK_SAMPLES) {
      for (let n = 0; n < 20; n++) {
        const cuts: number[] = [0];
        let p = 0;
        while (p < s.length) {
          p += 1 + Math.floor(rand() * 5);
          if (p < s.length) cuts.push(p);
        }
        cuts.push(s.length);
        const chunks: string[] = [];
        for (let i = 0; i < cuts.length - 1; i++) {
          chunks.push(s.slice(cuts[i]!, cuts[i + 1]));
        }
        const whole = feedWithEvents(new RelayStreamFilter(registryWith(CHUNK_BLOCKS)), [s]);
        const chunked = feedWithEvents(new RelayStreamFilter(registryWith(CHUNK_BLOCKS)), chunks);
        expect(chunked.text).toBe(whole.text);
        expect(chunked.events).toEqual(whole.events);
      }
    }
  });
});

describe('RelayStreamFilter flush-from-state property', () => {
  it('matches expand of that prefix', () => {
    const s = 'pre {{relay:x}} mid {{relay:missing}} end';
    const blocks = [{ id: 'x', text: 'T' }];
    for (let i = 0; i <= s.length; i++) {
      const prefix = s.slice(0, i);
      const whole = feedWithEvents(new RelayStreamFilter(registryWith(blocks)), [prefix]);
      const filter = new RelayStreamFilter(registryWith(blocks));
      const a = filter.push(prefix);
      const b = filter.flush();
      expect(a.text + b.text).toBe(whole.text);
      expect([...a.events, ...b.events]).toEqual(whole.events);
    }
  });
});
