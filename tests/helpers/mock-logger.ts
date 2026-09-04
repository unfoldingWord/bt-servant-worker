import { vi } from 'vitest';
import type { RequestLogger } from '../../src/utils/logger.js';

/** Minimal request-logger stub for unit tests that only assert on log calls. */
export function createMockLogger(): RequestLogger {
  return { log: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as RequestLogger;
}
