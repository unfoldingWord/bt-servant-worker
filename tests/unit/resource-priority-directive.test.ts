import { describe, it, expect } from 'vitest';
import {
  applyResourcePriority,
  parseResourcePriorityOrder,
  renderResourcePriorityDirective,
  resourceNameFromId,
  RESOURCE_PRIORITY_BEGIN,
  RESOURCE_PRIORITY_END,
} from '../../src/services/claude/resource-priority.js';

/**
 * Build a `## Tool Guidance` SLOT BODY (what `parseModeDocument` hands the
 * orchestrator — no `## Tool Guidance` heading line) that carries the portal's
 * generated block for `order`, plus optional surrounding author prose.
 */
function slotWithBlock(orderLine: string, opts?: { lead?: string }): string {
  const lead = opts?.lead ? `${opts.lead}\n\n` : '';
  return `${lead}${RESOURCE_PRIORITY_BEGIN}
${orderLine}
### Resource priorities
When answering from resources, strongly prefer the sources below, in this order.
1. Literal Text — unfoldingWord (Bible)
2. Simplified Text — unfoldingWord (Bible)

When your answer draws on anything other than the highest-ranked source, say so.
${RESOURCE_PRIORITY_END}`;
}

const VALID_ORDER = '<!-- order: ["translation-helps:ult","translation-helps:ust"] -->';

describe('parseResourcePriorityOrder', () => {
  it('returns null when there is no block', () => {
    expect(parseResourcePriorityOrder('just some tool guidance')).toBeNull();
    expect(parseResourcePriorityOrder('')).toBeNull();
  });

  it('parses a well-formed order into ids', () => {
    expect(parseResourcePriorityOrder(slotWithBlock(VALID_ORDER))).toEqual([
      'translation-helps:ult',
      'translation-helps:ust',
    ]);
  });

  it('reports corrupt when the block is present but the order line is unreadable', () => {
    // Present block, no order comment at all.
    const noOrder = slotWithBlock('(the order line was hand-deleted)');
    expect(parseResourcePriorityOrder(noOrder)).toBe('corrupt');
    // Present order comment, but not valid JSON.
    expect(parseResourcePriorityOrder(slotWithBlock('<!-- order: [oops] -->'))).toBe('corrupt');
    // Valid JSON but not an array of strings.
    expect(parseResourcePriorityOrder(slotWithBlock('<!-- order: [1,2] -->'))).toBe('corrupt');
  });

  it('parses an empty order as an empty array (not corrupt)', () => {
    expect(parseResourcePriorityOrder(slotWithBlock('<!-- order: [] -->'))).toEqual([]);
  });

  it('captures greedily to the last bracket so an id containing "]" survives', () => {
    const order = parseResourcePriorityOrder(slotWithBlock('<!-- order: ["aquifer:Notes]"] -->'));
    expect(order).toEqual(['aquifer:Notes]']);
  });
});

describe('resourceNameFromId', () => {
  it('returns the segment after the first colon', () => {
    expect(resourceNameFromId('translation-helps:ult')).toBe('ult');
  });
  it('keeps later colons with the name', () => {
    expect(resourceNameFromId('aquifer:Some:Name')).toBe('Some:Name');
  });
  it('returns the whole id when there is no colon', () => {
    expect(resourceNameFromId('noColon')).toBe('noColon');
  });
});

describe('renderResourcePriorityDirective', () => {
  it('lists the resource names in order and cites the scripture lever', () => {
    const directive = renderResourcePriorityDirective([
      'translation-helps:ult',
      'translation-helps:ust',
    ]);
    expect(directive).toContain('### Applying the resource priority');
    expect(directive).toContain('ult, ust');
    expect(directive).toContain('`fetch_scripture`');
  });

  it('de-duplicates names in first-seen order', () => {
    const directive = renderResourcePriorityDirective([
      'translation-helps:ult',
      'aquifer:ult',
      'translation-helps:ust',
    ]);
    expect(directive).toContain('ult, ust');
    expect(directive).not.toContain('ult, ult');
  });

  it('returns empty string when no usable names remain', () => {
    expect(renderResourcePriorityDirective([])).toBe('');
    expect(renderResourcePriorityDirective([':', ''])).toBe('');
  });
});

describe('applyResourcePriority', () => {
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

    // The actionable directive is appended, naming the concrete lever + names.
    expect(result.toolGuidance).toContain('### Applying the resource priority');
    expect(result.toolGuidance).toContain('ult, ust');
    expect(result.toolGuidance).toContain('`fetch_scripture`');
  });

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

  it('does not leave runs of blank lines behind after stripping markers', () => {
    const result = applyResourcePriority(slotWithBlock(VALID_ORDER));
    expect(result.toolGuidance).not.toMatch(/\n{3,}/);
  });
});
