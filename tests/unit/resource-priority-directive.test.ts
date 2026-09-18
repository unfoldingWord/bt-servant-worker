import { describe, it, expect } from 'vitest';
import {
  applyResourcePriority,
  parseResourcePriorityOrder,
  renderResourcePriorityDirective,
  resourceNameFromId,
  splitResourceId,
  RESOURCE_PRIORITY_BEGIN,
  RESOURCE_PRIORITY_END,
} from '../../src/services/claude/resource-priority.js';

/**
 * Build a `## Tool Guidance` SLOT BODY (what `parseModeDocument` hands the
 * orchestrator — no `## Tool Guidance` heading line) that carries the portal's
 * generated block for `order`, plus optional prose before and after the block.
 */
function slotWithBlock(orderLine: string, opts?: { lead?: string; trail?: string }): string {
  const lead = opts?.lead ? `${opts.lead}\n\n` : '';
  const trail = opts?.trail ? `\n\n${opts.trail}` : '';
  return `${lead}${RESOURCE_PRIORITY_BEGIN}
${orderLine}
### Resource priorities
When answering from resources, strongly prefer the sources below, in this order.
1. Literal Text — unfoldingWord (Bible)
2. Simplified Text — unfoldingWord (Bible)

When your answer draws on anything other than the highest-ranked source, say so.
${RESOURCE_PRIORITY_END}${trail}`;
}

const VALID_ORDER = '<!-- order: ["translation-helps:ult","translation-helps:ust"] -->';

describe('parseResourcePriorityOrder - detection', () => {
  it('returns null when there is no block', () => {
    expect(parseResourcePriorityOrder('just some tool guidance')).toBeNull();
    expect(parseResourcePriorityOrder('')).toBeNull();
  });

  it('does not treat an inline mention of the marker as a block', () => {
    expect(
      parseResourcePriorityOrder('see the <!-- bt:resource-priorities --> block below')
    ).toBeNull();
  });

  it('parses a well-formed order into ids', () => {
    expect(parseResourcePriorityOrder(slotWithBlock(VALID_ORDER))).toEqual([
      'translation-helps:ult',
      'translation-helps:ust',
    ]);
  });

  it('parses an order line even when indented', () => {
    expect(parseResourcePriorityOrder(slotWithBlock(`  ${VALID_ORDER}`))).toEqual([
      'translation-helps:ult',
      'translation-helps:ust',
    ]);
  });

  it('parses a CRLF document', () => {
    const crlf = slotWithBlock(VALID_ORDER).replace(/\n/g, '\r\n');
    expect(parseResourcePriorityOrder(crlf)).toEqual([
      'translation-helps:ult',
      'translation-helps:ust',
    ]);
  });
});

describe('parseResourcePriorityOrder - block scoping and validity', () => {
  it('ignores an order comment before the block', () => {
    const before = `<!-- order: ["evil:x"] -->\n\n${slotWithBlock(VALID_ORDER)}`;
    expect(parseResourcePriorityOrder(before)).toEqual([
      'translation-helps:ult',
      'translation-helps:ust',
    ]);
  });

  it('ignores an order comment after the block', () => {
    const noOrderInside = slotWithBlock('(no order line here)', {
      trail: '<!-- order: ["evil:y"] -->',
    });
    expect(parseResourcePriorityOrder(noOrderInside)).toBe('corrupt');
  });

  it('reports corrupt when the order line is unreadable', () => {
    expect(parseResourcePriorityOrder(slotWithBlock('(the order line was hand-deleted)'))).toBe(
      'corrupt'
    );
    expect(parseResourcePriorityOrder(slotWithBlock('<!-- order: [oops] -->'))).toBe('corrupt');
    expect(parseResourcePriorityOrder(slotWithBlock('<!-- order: [1,2] -->'))).toBe('corrupt');
  });

  it('reports corrupt for an orphan opening marker (no closing)', () => {
    const orphan = `${RESOURCE_PRIORITY_BEGIN}\n${VALID_ORDER}\n### Resource priorities\n1. Literal Text`;
    expect(parseResourcePriorityOrder(orphan)).toBe('corrupt');
  });

  it('parses an empty order as an empty array (not corrupt)', () => {
    expect(parseResourcePriorityOrder(slotWithBlock('<!-- order: [] -->'))).toEqual([]);
  });

  it('captures greedily to the last bracket so an id containing "]" survives', () => {
    const order = parseResourcePriorityOrder(slotWithBlock('<!-- order: ["aquifer:Notes]"] -->'));
    expect(order).toEqual(['aquifer:Notes]']);
  });

  it('reports corrupt when there are multiple blocks', () => {
    const two = `${slotWithBlock(VALID_ORDER)}\n\n${slotWithBlock(VALID_ORDER)}`;
    expect(parseResourcePriorityOrder(two)).toBe('corrupt');
  });
});

describe('splitResourceId / resourceNameFromId', () => {
  it('splits on the first colon', () => {
    expect(splitResourceId('translation-helps:ult')).toEqual({
      serverId: 'translation-helps',
      name: 'ult',
    });
  });
  it('keeps later colons with the name', () => {
    expect(splitResourceId('aquifer:Some:Name')).toEqual({
      serverId: 'aquifer',
      name: 'Some:Name',
    });
  });
  it('treats a colonless id as an all-name id', () => {
    expect(splitResourceId('noColon')).toEqual({ serverId: '', name: 'noColon' });
    expect(resourceNameFromId('translation-helps:ult')).toBe('ult');
  });
});

describe('renderResourcePriorityDirective - server-aware entries (#341)', () => {
  it('names the ranked server and its resource ids for a translation-helps ranking', () => {
    const directive = renderResourcePriorityDirective([
      'translation-helps:ult',
      'translation-helps:ust',
    ]);
    expect(directive).toContain('### Applying the resource priority');
    expect(directive).toContain('1. server translation-helps: ult, then ust');
    // #341: no hardcoded tool name — the pool decides which tool serves a server.
    expect(directive).not.toContain('fetch_scripture');
  });

  it('derives an aquifer-only ranking from the ids, with no foreign tool or resource names', () => {
    const directive = renderResourcePriorityDirective([
      'aquifer:WorldEnglishBible',
      'aquifer:BereanStandardBible',
    ]);
    expect(directive).toContain('1. server aquifer: WorldEnglishBible, then BereanStandardBible');
    expect(directive).not.toContain('2.');
    // #341 regression: the old directive named `fetch_scripture` and primed
    // `ult`/`ust`/`t4t`/`ueb` for every ranking, including an Aquifer one.
    expect(directive).not.toContain('fetch_scripture');
    expect(directive).not.toContain('`ult`');
    expect(directive).not.toContain('`ust`');
    expect(directive).not.toContain('t4t');
    expect(directive).not.toContain('ueb');
    expect(directive).not.toContain('translation-helps');
  });

  it('keeps a mixed-server ranking in ranked order, one entry per consecutive server run', () => {
    const directive = renderResourcePriorityDirective([
      'aquifer:WorldEnglishBible',
      'translation-helps:ult',
      'aquifer:BereanStandardBible',
    ]);
    const first = directive.indexOf('1. server aquifer: WorldEnglishBible');
    const second = directive.indexOf('2. server translation-helps: ult');
    const third = directive.indexOf('3. server aquifer: BereanStandardBible');
    expect(first).toBeGreaterThan(-1);
    expect(second).toBeGreaterThan(first);
    expect(third).toBeGreaterThan(second);
    // The interleaving is NOT collapsed into one aquifer group, which would
    // silently promote BereanStandardBible above ult.
    expect(directive).not.toContain('WorldEnglishBible, then BereanStandardBible');
  });

  it('lists an id with no server prefix plainly', () => {
    const directive = renderResourcePriorityDirective(['noColon', 'aquifer:WorldEnglishBible']);
    expect(directive).toContain('1. noColon');
    expect(directive).not.toContain('1. server');
    expect(directive).toContain('2. server aquifer: WorldEnglishBible');
  });
});

describe('renderResourcePriorityDirective - wording and de-duplication', () => {
  it('keeps the coverage qualifier in the disclosure sentence', () => {
    const directive = renderResourcePriorityDirective(['translation-helps:ult']);
    // Disclosure fires only when bypassing the top source THAT COVERS the
    // question — matching the portal prose; not on any non-top source.
    expect(directive).toContain('highest-ranked source that covers the question, say so');
  });

  it('keeps the same name under different servers as distinct ranked entries', () => {
    const directive = renderResourcePriorityDirective(['translation-helps:ult', 'aquifer:ult']);
    expect(directive).toContain('1. server translation-helps: ult');
    expect(directive).toContain('2. server aquifer: ult');
  });

  it('de-duplicates by full composite id, preserving first-seen position', () => {
    const directive = renderResourcePriorityDirective([
      'translation-helps:ult',
      'translation-helps:ult',
      'translation-helps:ust',
    ]);
    expect(directive).toContain('1. server translation-helps: ult, then ust');
    expect(directive).not.toContain('ult, then ult');
    expect(directive).not.toContain('2.');
  });

  it('returns empty string when no usable ids remain', () => {
    expect(renderResourcePriorityDirective([])).toBe('');
    expect(renderResourcePriorityDirective(['translation-helps:', ''])).toBe('');
  });
});

describe('renderResourcePriorityDirective - catalog display names (#341 review)', () => {
  // The tool catalog the model sees headings each server by its display name
  // (`### Translation Helps MCP`), never by its id, so the directive must carry
  // the display name for the model to join a ranked server to its tools.
  const names = new Map([
    ['translation-helps', 'Translation Helps MCP'],
    ['aquifer', 'Aquifer MCP'],
  ]);

  it('labels each server with its catalog display name and keeps the id as the join key', () => {
    const directive = renderResourcePriorityDirective(
      ['translation-helps:ult', 'aquifer:WorldEnglishBible'],
      names
    );
    expect(directive).toContain('1. server Translation Helps MCP (id translation-helps): ult');
    expect(directive).toContain('2. server Aquifer MCP (id aquifer): WorldEnglishBible');
  });

  it('falls back to the bare id when the server is not in the catalog', () => {
    const directive = renderResourcePriorityDirective(['th2:ult'], names);
    expect(directive).toContain('1. server th2: ult');
  });
});

describe('renderResourcePriorityDirective - selector wording (#341 review)', () => {
  const names = new Map([['aquifer', 'Aquifer MCP']]);

  it('tells the model to pass only the resource id, never the server prefix', () => {
    const directive = renderResourcePriorityDirective(['aquifer:WorldEnglishBible'], names);
    expect(directive).toContain('only the resource id after the colon');
    expect(directive).not.toContain('pass the id exactly as written');
  });

  it('describes unprefixed ids as bare resource ids instead of claiming a server for them', () => {
    const directive = renderResourcePriorityDirective(['noColon'], names);
    expect(directive).toContain('1. noColon');
    expect(directive).toContain('An entry without a `server` prefix is a bare resource id');
    expect(directive).toContain('(for entry 1 that is `noColon`)');
    expect(directive).not.toContain('Each entry names a server');
  });

  it('draws the selector example from the ranking itself, never from a foreign resource', () => {
    const directive = renderResourcePriorityDirective(['translation-helps:ult'], names);
    expect(directive).toContain('(for entry 1 that is `ult`)');
    expect(directive).not.toContain('WorldEnglishBible');
    expect(directive).not.toContain('aquifer');
  });
});

describe('applyResourcePriority - transform', () => {
  it('leaves guidance with no block untouched (identity)', () => {
    const input = 'Prefer authoritative sources.';
    const result = applyResourcePriority(input);
    expect(result.applied).toBe(false);
    expect(result.order).toBeNull();
    expect(result.toolGuidance).toBe(input);
  });

  it('is byte-identical for multi-line guidance with ordinary comments, blank runs and CRLF (prompt-cache)', () => {
    // The transformed slot sits in the cacheable stable system block, so any
    // byte drift when no block is present would bust the prompt cache.
    const input =
      'Lead.\r\n\r\n\r\n<!-- author note -->\r\n  indented line\r\nTrailing whitespace   \r\n\r\n';
    const result = applyResourcePriority(input);
    expect(result.applied).toBe(false);
    expect(result.order).toBeNull();
    expect(result.toolGuidance).toBe(input);
  });

  it('strips the HTML-comment markers and appends the directive for a valid order', () => {
    const input = slotWithBlock(VALID_ORDER, { lead: 'Author-written guidance here.' });
    const result = applyResourcePriority(input);

    expect(result.applied).toBe(true);
    expect(result.order).toEqual(['translation-helps:ult', 'translation-helps:ust']);

    // Leak fix: no raw block/order HTML comments survive.
    expect(result.toolGuidance).not.toContain(RESOURCE_PRIORITY_BEGIN);
    expect(result.toolGuidance).not.toContain(RESOURCE_PRIORITY_END);
    expect(result.toolGuidance).not.toContain('<!-- order:');

    // Author prose and the human-readable ranking prose are preserved.
    expect(result.toolGuidance).toContain('Author-written guidance here.');
    expect(result.toolGuidance).toContain('strongly prefer the sources below');
    expect(result.toolGuidance).toContain('1. Literal Text');

    // The actionable directive is appended, derived from the ranked ids.
    expect(result.toolGuidance).toContain('### Applying the resource priority');
    expect(result.toolGuidance).toContain('1. server translation-helps: ult, then ust');
    expect(result.toolGuidance).not.toContain('fetch_scripture');
  });
});

describe('applyResourcePriority - transform with catalog names (#341 review)', () => {
  it('passes catalog display names through to the rendered directive', () => {
    const input = slotWithBlock('<!-- order: ["aquifer:WorldEnglishBible"] -->');
    const result = applyResourcePriority(input, new Map([['aquifer', 'Aquifer MCP']]));
    expect(result.applied).toBe(true);
    expect(result.toolGuidance).toContain('1. server Aquifer MCP (id aquifer): WorldEnglishBible');
  });

  it('applies an aquifer ranking without naming any translation-helps tool or resource', () => {
    const input = slotWithBlock(
      '<!-- order: ["aquifer:WorldEnglishBible","aquifer:BereanStandardBible"] -->'
    );
    const result = applyResourcePriority(input);
    expect(result.applied).toBe(true);
    expect(result.order).toEqual(['aquifer:WorldEnglishBible', 'aquifer:BereanStandardBible']);
    expect(result.toolGuidance).toContain(
      '1. server aquifer: WorldEnglishBible, then BereanStandardBible'
    );
    expect(result.toolGuidance).not.toContain('fetch_scripture');
    expect(result.toolGuidance).not.toContain('`ult`');
  });
});

describe('applyResourcePriority - surrounding prose', () => {
  it('keeps author prose after the block, with the directive adjacent to the ranking', () => {
    const input = slotWithBlock(VALID_ORDER, { trail: 'Trailing author note.' });
    const result = applyResourcePriority(input);
    const directiveIdx = result.toolGuidance.indexOf('### Applying the resource priority');
    const trailIdx = result.toolGuidance.indexOf('Trailing author note.');
    expect(directiveIdx).toBeGreaterThan(-1);
    expect(trailIdx).toBeGreaterThan(-1);
    expect(directiveIdx).toBeLessThan(trailIdx);
  });

  it("does not disturb the author's own HTML comment outside the block", () => {
    const input = `<!-- author note: keep me -->\n\n${slotWithBlock(VALID_ORDER)}`;
    const result = applyResourcePriority(input);
    expect(result.toolGuidance).toContain('<!-- author note: keep me -->');
  });

  it('does not leave runs of blank lines behind after stripping markers', () => {
    const result = applyResourcePriority(
      slotWithBlock(VALID_ORDER, { lead: 'Lead.', trail: 'Trail.' })
    );
    expect(result.toolGuidance).not.toMatch(/\n{3,}/);
  });

  it("preserves the author's own blank runs outside the block", () => {
    const input = `Author line one.\n\n\n\nAuthor line two.\n\n${slotWithBlock(VALID_ORDER)}`;
    const result = applyResourcePriority(input);
    expect(result.applied).toBe(true);
    // The 4-newline run in author content is left intact (not normalized).
    expect(result.toolGuidance).toContain('Author line one.\n\n\n\nAuthor line two.');
  });
});

describe('applyResourcePriority - edge cases', () => {
  it('strips markers but appends no directive when the order is empty', () => {
    const result = applyResourcePriority(slotWithBlock('<!-- order: [] -->'));
    expect(result.applied).toBe(false);
    expect(result.order).toEqual([]);
    expect(result.toolGuidance).not.toContain('<!-- ');
    expect(result.toolGuidance).not.toContain('### Applying the resource priority');
  });

  it('strips markers and does not apply when the order is corrupt', () => {
    const result = applyResourcePriority(slotWithBlock('<!-- order: [oops] -->'));
    expect(result.applied).toBe(false);
    expect(result.order).toBe('corrupt');
    expect(result.toolGuidance).not.toContain(RESOURCE_PRIORITY_BEGIN);
    expect(result.toolGuidance).not.toContain('### Applying the resource priority');
  });

  it('strips an orphan opening marker without a directive, preserving prose', () => {
    const orphan = `${RESOURCE_PRIORITY_BEGIN}\n${VALID_ORDER}\n### Resource priorities\n1. Literal Text`;
    const result = applyResourcePriority(orphan);
    expect(result.order).toBe('corrupt');
    expect(result.applied).toBe(false);
    expect(result.toolGuidance).not.toContain(RESOURCE_PRIORITY_BEGIN);
    expect(result.toolGuidance).not.toContain('<!-- order:');
    expect(result.toolGuidance).toContain('1. Literal Text');
  });
});

describe('applyResourcePriority - corrupt-comment stripping and spacing', () => {
  it('strips a malformed order comment (no array) so it never leaks to the model', () => {
    const result = applyResourcePriority(slotWithBlock('<!-- order: not-json -->'));
    expect(result.order).toBe('corrupt');
    expect(result.applied).toBe(false);
    expect(result.toolGuidance).not.toContain('<!-- order:');
    expect(result.toolGuidance).not.toContain(RESOURCE_PRIORITY_BEGIN);
  });

  it('preserves indentation on the first content line after the block', () => {
    const input = slotWithBlock(VALID_ORDER, { trail: '    indented author line' });
    const result = applyResourcePriority(input);
    expect(result.toolGuidance).toContain('    indented author line');
  });

  it("treats multiple blocks as corrupt and strips every block's markers", () => {
    const two = `${slotWithBlock(VALID_ORDER)}\n\n${slotWithBlock('<!-- order: ["aquifer:x"] -->')}`;
    const result = applyResourcePriority(two);
    expect(result.order).toBe('corrupt');
    expect(result.applied).toBe(false);
    expect(result.toolGuidance).not.toContain(RESOURCE_PRIORITY_BEGIN);
    expect(result.toolGuidance).not.toContain(RESOURCE_PRIORITY_END);
    expect(result.toolGuidance).not.toContain('<!-- order:');
    // Author-visible prose from the blocks survives.
    expect(result.toolGuidance).toContain('strongly prefer the sources below');
  });

  it('leaves an author comment OUTSIDE any block untouched even in the multi-block path', () => {
    const two = `<!-- keep me -->\n\n${slotWithBlock(VALID_ORDER)}\n\n${slotWithBlock(VALID_ORDER)}`;
    const result = applyResourcePriority(two);
    expect(result.order).toBe('corrupt');
    expect(result.toolGuidance).toContain('<!-- keep me -->');
  });
});

describe('applyResourcePriority - ambiguous structures', () => {
  it('strips a truncated order comment (missing -->) so it never leaks', () => {
    const truncated = `${RESOURCE_PRIORITY_BEGIN}\n<!-- order: ["translation-helps:ult"]\n### Resource priorities\n1. ult\n${RESOURCE_PRIORITY_END}`;
    const result = applyResourcePriority(truncated);
    expect(result.order).toBe('corrupt');
    expect(result.applied).toBe(false);
    expect(result.toolGuidance).not.toContain('<!-- order:');
    expect(result.toolGuidance).not.toContain(RESOURCE_PRIORITY_BEGIN);
    expect(result.toolGuidance).not.toContain(RESOURCE_PRIORITY_END);
  });

  it('strips a stray closing marker that appears before the opener', () => {
    const strayCloser = `${RESOURCE_PRIORITY_END}\n\n${slotWithBlock(VALID_ORDER)}`;
    const result = applyResourcePriority(strayCloser);
    expect(result.order).toBe('corrupt');
    expect(result.applied).toBe(false);
    expect(result.toolGuidance).not.toContain(RESOURCE_PRIORITY_END);
    expect(result.toolGuidance).not.toContain(RESOURCE_PRIORITY_BEGIN);
    expect(result.toolGuidance).not.toContain('<!-- order:');
  });

  it('does not leak a truncated opener that has no closing -->', () => {
    const truncatedOpener = `<!-- bt:resource-priorities\n${VALID_ORDER}\n### Resource priorities\n1. ult\n${RESOURCE_PRIORITY_END}`;
    const result = applyResourcePriority(truncatedOpener);
    expect(result.order).toBe('corrupt');
    expect(result.applied).toBe(false);
    expect(result.toolGuidance).not.toContain('<!-- bt:resource-priorities');
    expect(result.toolGuidance).not.toContain('<!-- order:');
  });

  it('treats nested opening markers as corrupt and strips every marker', () => {
    const nested = `${RESOURCE_PRIORITY_BEGIN}\n${RESOURCE_PRIORITY_BEGIN}\n${VALID_ORDER}\n### Resource priorities\n1. ult\n${RESOURCE_PRIORITY_END}`;
    const result = applyResourcePriority(nested);
    expect(result.order).toBe('corrupt');
    expect(result.applied).toBe(false);
    expect(result.toolGuidance).not.toContain(RESOURCE_PRIORITY_BEGIN);
    expect(result.toolGuidance).not.toContain('<!-- order:');
    expect(parseResourcePriorityOrder(nested)).toBe('corrupt');
  });

  it('treats a single block with two order comments as corrupt and strips both', () => {
    const twoOrders = `${RESOURCE_PRIORITY_BEGIN}\n<!-- order: ["translation-helps:ult"] -->\n<!-- order: ["aquifer:x"] -->\n### Resource priorities\n1. x\n${RESOURCE_PRIORITY_END}`;
    const result = applyResourcePriority(twoOrders);
    expect(result.order).toBe('corrupt');
    expect(result.applied).toBe(false);
    expect(result.toolGuidance).not.toContain('<!-- order:');
    expect(parseResourcePriorityOrder(twoOrders)).toBe('corrupt');
  });
});
