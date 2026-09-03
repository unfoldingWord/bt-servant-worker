/**
 * Shared harness for orchestrator tests that mock the Anthropic SDK and feed
 * `fetch` a canned SSE body (used by `orchestrator-sse-ping.test.ts` and
 * `orchestrator-status-locale.test.ts`).
 *
 * Each test file still declares
 * `vi.mock('@anthropic-ai/sdk', () => ({ default: vi.fn() }))` itself:
 * `vi.mock` is hoisted per test file and cannot live in a helper.
 */

import { vi } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import type { ToolCatalog } from '../../src/services/mcp/index.js';
import type { RequestLogger } from '../../src/utils/logger.js';
import type { StreamCallbacks } from '../../src/types/engine.js';
import type { StatusUpdate } from '../../src/i18n/ui-strings.js';
import type { Env } from '../../src/config/types.js';

export function createMockEnv(overrides: Partial<Env> = {}): Env {
  return { ANTHROPIC_API_KEY: 'test-key', ...overrides } as Env;
}

export function createMockCatalog(): ToolCatalog {
  return { tools: [], serverMap: new Map() };
}

export function createMockLogger(): RequestLogger {
  return { log: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as RequestLogger;
}

export interface CapturedCallbacks {
  callbacks: StreamCallbacks;
  /** Every `onStatus` payload, in order. */
  statuses: StatusUpdate[];
  /** Every `onProgress` chunk, in order. */
  progress: string[];
}

/** Callbacks that record what the orchestrator emits. */
export function createMockCallbacks(): CapturedCallbacks {
  const statuses: StatusUpdate[] = [];
  const progress: string[] = [];
  return {
    statuses,
    progress,
    callbacks: {
      onStatus: vi.fn((status: StatusUpdate) => statuses.push(status)),
      onProgress: vi.fn((text: string) => progress.push(text)),
      onComplete: vi.fn(),
      onError: vi.fn(),
    },
  };
}

/** One `data:` frame per event, separated by blank lines as the SSE parser expects. */
export function buildSSEFrames(events: readonly object[]): string {
  return events.map((event) => `data: ${JSON.stringify(event)}\n`).join('\n');
}

/** Mock the SDK constructor and make every `fetch` answer with `body` as an SSE response. */
export function mockAnthropicFetch(body: string): void {
  (Anthropic as unknown as ReturnType<typeof vi.fn>).mockImplementation(function MockAnthropic(
    this: object
  ) {
    return this;
  } as unknown as () => object);

  vi.spyOn(globalThis, 'fetch').mockImplementation(
    async () =>
      new Response(body, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
  );
}
