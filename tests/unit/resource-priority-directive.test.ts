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

describe('renderResourcePriorityDirective', () => {
  it('lists ranked resources with their server and cites the scripture lever', () => {
    const directive = renderResourcePriorityDirective([
      'translation-helps:ult',
      'translation-helps:ust',
    ]);
    expect(directive).toContain('### Applying the resource priority');
    expect(directive).toContain('1. ult — translation-helps');
    expect(directive).toContain('2. ust — translation-helps');
    expect(directive).toContain('`fetch_scripture`');
  });

  it('keeps the coverage qualifier in the disclosure sentence', () => {
    const directive = renderResourcePriorityDirective(['translation-helps:ult']);
    // Disclosure fires only when bypassing the top source THAT COVERS the
    // question — matching the portal prose; not on any non-top source.
    expect(directive).toContain('highest-ranked source that covers the question, say so');
  });

  it('keeps the same name under different servers as distinct ranked entries', () => {
    const directive = renderResourcePriorityDirective(['translation-helps:ult', 'aquifer:ult']);
    expect(directive).toContain('1. ult — translation-helps');
    expect(directive).toContain('2. ult — aquifer');
  });

  it('de-duplicates by full composite id, preserving first-seen position', () => {
    const directive = renderResourcePriorityDirective([
      'translation-helps:ult',
      'translation-helps:ult',
      'translation-helps:ust',
    ]);
    expect(directive).toContain('1. ult — translation-helps');
    expect(directive).toContain('2. ust — translation-helps');
    expect(directive).not.toContain('3.');
  });

  it('returns empty string when no usable ids remain', () => {
    expect(renderResourcePriorityDirective([])).toBe('');
    expect(renderResourcePriorityDirective(['translation-helps:', ''])).toBe('');
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

    // The actionable directive is appended, naming the concrete lever + entries.
    expect(result.toolGuidance).toContain('### Applying the resource priority');
    expect(result.toolGuidance).toContain('ult — translation-helps');
    expect(result.toolGuidance).toContain('`fetch_scripture`');
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
