import { describe, it, expect } from 'vitest';
import {
  executeCode,
  createMCPHostFunctions,
} from '../../src/services/code-execution/quickjs-executor.js';
import { createRequestLogger } from '../../src/utils/logger.js';

// Create a minimal logger for tests
function createTestLogger() {
  return createRequestLogger('test-request-id', 'test-user');
}

describe('QuickJS basic execution', () => {
  it('should execute simple code and return __result__', async () => {
    const logger = createTestLogger();
    const result = await executeCode(
      '__result__ = 42;',
      { timeout_ms: 5000, hostFunctions: [] },
      logger
    );

    expect(result.success).toBe(true);
    expect(result.result).toBe(42);
  });

  it('should capture console.log output', async () => {
    const logger = createTestLogger();
    const result = await executeCode(
      'console.log("hello"); __result__ = "done";',
      { timeout_ms: 5000, hostFunctions: [] },
      logger
    );

    expect(result.success).toBe(true);
    expect(result.logs.length).toBeGreaterThan(0);
    expect(result.logs[0].message).toBe('hello');
    expect(result.logs[0].level).toBe('log');
  });
});

describe('QuickJS top-level await with native Promises', () => {
  it('should support top-level await syntax', async () => {
    const logger = createTestLogger();
    const code = `
      const promise = Promise.resolve(123);
      const value = await promise;
      __result__ = value;
    `;

    const result = await executeCode(code, { timeout_ms: 5000, hostFunctions: [] }, logger);

    expect(result.success).toBe(true);
    expect(result.result).toBe(123);
  });
});

describe('QuickJS await with host functions', () => {
  it('should support await with single host function call', async () => {
    const logger = createTestLogger();
    const hostFunctions = [
      {
        name: 'test_tool',
        fn: async (arg: unknown) => {
          const input = arg as { value: number };
          return { doubled: input.value * 2 };
        },
      },
    ];

    const code = `
      const result = await test_tool({ value: 21 });
      __result__ = result;
    `;

    const result = await executeCode(code, { timeout_ms: 5000, hostFunctions }, logger);

    expect(result.success).toBe(true);
    expect(result.result).toEqual({ doubled: 42 });
  });

  it('should support multiple chained awaits', async () => {
    const logger = createTestLogger();
    const hostFunctions = [
      {
        name: 'add',
        fn: async (arg: unknown) => {
          const input = arg as { a: number; b: number };
          return input.a + input.b;
        },
      },
    ];

    const code = `
      const first = await add({ a: 1, b: 2 });
      const second = await add({ a: first, b: 3 });
      __result__ = second;
    `;

    const result = await executeCode(code, { timeout_ms: 5000, hostFunctions }, logger);

    expect(result.success).toBe(true);
    expect(result.result).toBe(6);
  });
});

describe('QuickJS createMCPHostFunctions', () => {
  it('should create host functions from tool caller', () => {
    const toolCaller = async (name: string, args: unknown) => ({ tool: name, args });
    const toolNames = ['tool1', 'tool2'];

    const hostFunctions = createMCPHostFunctions(toolCaller, toolNames);

    expect(hostFunctions.length).toBe(2);
    expect(hostFunctions[0].name).toBe('tool1');
    expect(hostFunctions[1].name).toBe('tool2');
  });
});

describe('QuickJS error handling', () => {
  it('should return error for syntax errors', async () => {
    const logger = createTestLogger();
    const result = await executeCode(
      'this is not valid javascript!!!',
      { timeout_ms: 5000, hostFunctions: [] },
      logger
    );

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('should return error when exception is thrown in async code', async () => {
    const logger = createTestLogger();
    // Thrown errors inside the async wrapper are captured and propagated as failures
    const result = await executeCode(
      'throw new Error("test error"); __result__ = "never reached";',
      { timeout_ms: 5000, hostFunctions: [] },
      logger
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('test error');
  });
});
