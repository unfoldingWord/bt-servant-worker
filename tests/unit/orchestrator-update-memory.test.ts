/**
 * Tests for coerceStringifiedSections — the update_memory recovery path for
 * the model-drift pattern where `sections` arrives as a JSON-stringified
 * object instead of an object literal. See issue #144.
 */

import { describe, it, expect, vi } from 'vitest';
import { coerceStringifiedSections } from '../../src/services/claude/orchestrator.js';
import { isUpdateMemoryInput } from '../../src/services/claude/tools.js';
import { ValidationError } from '../../src/utils/errors.js';
import { RequestLogger } from '../../src/utils/logger.js';

function createMockLogger(): RequestLogger {
  return { log: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as RequestLogger;
}

describe('coerceStringifiedSections — parse success', () => {
  it('parses a JSON-stringified sections object and emits a warn log', () => {
    const logger = createMockLogger();
    const stringified = JSON.stringify({ 'UTC Progress': '## UTC Progress\n- done' });

    const result = coerceStringifiedSections({ sections: stringified }, logger);

    expect(result).toEqual({ sections: { 'UTC Progress': '## UTC Progress\n- done' } });
    expect(logger.warn).toHaveBeenCalledWith(
      'update_memory_sections_coerced_from_string',
      expect.objectContaining({ raw_length: stringified.length, recovery: 'raw' })
    );
    expect(isUpdateMemoryInput(result)).toBe(true);
  });

  it('preserves pin/unpin arrays when coercing stringified sections', () => {
    const logger = createMockLogger();
    const stringified = JSON.stringify({ A: 'new' });

    const result = coerceStringifiedSections(
      { sections: stringified, pin: ['A'], unpin: ['B'] },
      logger
    );

    expect(result).toEqual({ sections: { A: 'new' }, pin: ['A'], unpin: ['B'] });
    expect(isUpdateMemoryInput(result)).toBe(true);
  });
});

describe('coerceStringifiedSections — trailing-brace recovery', () => {
  it('recovers from one extra trailing brace (model brace-depth drift)', () => {
    const logger = createMockLogger();
    const valid = { '## Passage': 'Phase: exegesis\nSelected on: 2025-01-30' };
    const withExtraBrace = JSON.stringify(valid) + '}';

    const result = coerceStringifiedSections({ sections: withExtraBrace }, logger);

    expect(result).toEqual({ sections: valid });
    expect(logger.warn).toHaveBeenCalledWith(
      'update_memory_sections_coerced_from_string',
      expect.objectContaining({ recovery: 'strip_trailing_brace_1' })
    );
    expect(isUpdateMemoryInput(result)).toBe(true);
  });

  it('recovers from two extra trailing braces', () => {
    const logger = createMockLogger();
    const valid = { '## A': 'content' };
    const withExtraBraces = JSON.stringify(valid) + '}}';

    const result = coerceStringifiedSections({ sections: withExtraBraces }, logger);

    expect(result).toEqual({ sections: valid });
    expect(logger.warn).toHaveBeenCalledWith(
      'update_memory_sections_coerced_from_string',
      expect.objectContaining({ recovery: 'strip_trailing_brace_2' })
    );
  });

  it('recovers from trailing whitespace + extra brace', () => {
    const logger = createMockLogger();
    const valid = { '## A': 'content' };
    const withTrailingJunk = JSON.stringify(valid) + '} \n';

    const result = coerceStringifiedSections({ sections: withTrailingJunk }, logger);

    expect(result).toEqual({ sections: valid });
    expect(logger.warn).toHaveBeenCalled();
  });
});

describe('coerceStringifiedSections — parse failure', () => {
  it('throws a sharpened ValidationError when stringified sections is unparseable', () => {
    const logger = createMockLogger();

    expect(() => coerceStringifiedSections({ sections: '{not valid json' }, logger)).toThrow(
      ValidationError
    );
  });

  it('sharpened error message mentions the JSON-string anti-pattern', () => {
    const logger = createMockLogger();

    try {
      coerceStringifiedSections({ sections: '{not valid json' }, logger);
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as Error).message).toContain('must be a JSON object, not a JSON string');
      expect((err as Error).message).toContain('do not call JSON.stringify');
    }
  });

  it('emits a debug log capturing the parse error', () => {
    const logger = createMockLogger();

    expect(() => coerceStringifiedSections({ sections: '{not valid json' }, logger)).toThrow();

    expect(logger.log).toHaveBeenCalledWith(
      'update_memory_sections_coerce_parse_failed',
      expect.objectContaining({ error: expect.any(String) })
    );
  });
});

describe('coerceStringifiedSections — passthrough cases', () => {
  it('passes through untouched when sections is already an object', () => {
    const logger = createMockLogger();
    const input = { sections: { A: 'content' }, pin: ['A'] };

    const result = coerceStringifiedSections(input, logger);

    expect(result).toBe(input);
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.log).not.toHaveBeenCalled();
  });

  it('passes through untouched when sections is missing', () => {
    const logger = createMockLogger();
    const input = { pin: ['A'] };

    const result = coerceStringifiedSections(input, logger);

    expect(result).toBe(input);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('passes through untouched when input is not an object', () => {
    const logger = createMockLogger();

    expect(coerceStringifiedSections(null, logger)).toBe(null);
    expect(coerceStringifiedSections('string', logger)).toBe('string');
    expect(coerceStringifiedSections(42, logger)).toBe(42);
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.log).not.toHaveBeenCalled();
  });
});

describe('coerceStringifiedSections — downstream-validator interaction', () => {
  it('rejects stringified arrays (only objects are valid sections)', () => {
    // Arrays are valid JSON but not valid sections; coercion should not accept them.
    const logger = createMockLogger();
    const stringified = JSON.stringify(['not', 'an', 'object']);

    expect(() => coerceStringifiedSections({ sections: stringified }, logger)).toThrow(
      ValidationError
    );
  });
});
