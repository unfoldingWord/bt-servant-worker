/**
 * Shared helpers for relay unit / orchestrator tests (#462).
 */

import { vi } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import {
  RelayCollector,
  RelayRegistry,
  type RelayBlock,
  type RelayLogger,
} from '../../src/services/claude/relay.js';
import type { ToolCatalog } from '../../src/services/mcp/types.js';
import type { RequestLogger } from '../../src/utils/logger.js';
import type { Env } from '../../src/config/types.js';
import type { StreamCallbacks } from '../../src/types/engine.js';

export interface LoggedEvent {
  event: string;
  data: Record<string, unknown>;
}

export function mockRelayLogger(): RelayLogger & { warns: LoggedEvent[] } {
  const warns: LoggedEvent[] = [];
  return {
    warns,
    warn: vi.fn((event: string, data: Record<string, unknown> = {}) => {
      warns.push({ event, data });
    }),
  };
}

export function registryWith(blocks: RelayBlock[]): RelayRegistry {
  const reg = new RelayRegistry();
  const collector = new RelayCollector();
  for (const b of blocks) collector.add(b);
  collector.close();
  reg.ingestCollectors([collector], mockRelayLogger());
  return reg;
}

export function createMockLogger(sink: LoggedEvent[] = []): RequestLogger {
  return {
    log: vi.fn((event: string, data: Record<string, unknown> = {}) => sink.push({ event, data })),
    warn: vi.fn((event: string, data: Record<string, unknown> = {}) => sink.push({ event, data })),
    error: vi.fn(),
  } as unknown as RequestLogger;
}

export function obsCatalog(): ToolCatalog {
  return {
    tools: [
      {
        name: 'fetch_obs_study_manual',
        description: 'OBS study manual',
        inputSchema: { type: 'object' as const, properties: {} },
        serverId: 'obs-5m-mcp',
        serverUrl: 'https://example.invalid/mcp',
      },
    ],
    serverMap: new Map([
      [
        'obs-5m-mcp',
        {
          id: 'obs-5m-mcp',
          name: 'OBS 5M',
          url: 'https://example.invalid/mcp',
          enabled: true,
          priority: 1,
        },
      ],
    ]),
  } as ToolCatalog;
}

export function createMockMessage(
  id: string,
  stopReason: 'tool_use' | 'end_turn' | 'max_tokens',
  content: Anthropic.ContentBlock[]
): Anthropic.Message {
  return {
    id,
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-4-20250514',
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: 10,
      output_tokens: 20,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
    content,
  } as Anthropic.Message;
}

export function buildSSEBody(message: Anthropic.Message, splitText = false): string {
  const lines: string[] = [];
  lines.push(
    `data: ${JSON.stringify({ type: 'message_start', message: { ...message, content: [] } })}\n`
  );
  message.content.forEach((block, index) => appendSSEBlock(lines, block, index, splitText));
  lines.push(
    `data: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: message.stop_reason, stop_sequence: message.stop_sequence }, usage: message.usage })}\n`
  );
  lines.push(`data: ${JSON.stringify({ type: 'message_stop' })}\n`);
  return lines.join('\n');
}

function appendSSEBlock(
  lines: string[],
  block: Anthropic.ContentBlock,
  index: number,
  splitText: boolean
): void {
  if (block.type === 'text') {
    lines.push(
      `data: ${JSON.stringify({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } })}\n`
    );
    if (block.text) {
      const chunks = splitText ? block.text.split('') : [block.text];
      for (const ch of chunks) {
        lines.push(
          `data: ${JSON.stringify({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: ch } })}\n`
        );
      }
    }
    lines.push(`data: ${JSON.stringify({ type: 'content_block_stop', index })}\n`);
    return;
  }
  if (block.type !== 'tool_use') return;
  lines.push(
    `data: ${JSON.stringify({ type: 'content_block_start', index, content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} } })}\n`
  );
  lines.push(
    `data: ${JSON.stringify({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } })}\n`
  );
  lines.push(`data: ${JSON.stringify({ type: 'content_block_stop', index })}\n`);
}

export function mockAnthropicSSE(messages: Anthropic.Message[], splitText = false): void {
  let call = 0;
  (Anthropic as unknown as ReturnType<typeof vi.fn>).mockImplementation(function Mock(
    this: object
  ) {
    return this;
  } as unknown as () => object);
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    const msg = messages[Math.min(call, messages.length - 1)]!;
    call += 1;
    return new Response(buildSSEBody(msg, splitText), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  });
}

/**
 * Build an SSE body where each text block is streamed as the given chunks
 * (in content order). Non-text blocks use the normal single-delta path.
 * Used to prove whitespace gating does not depend on delta boundaries (#462 C2).
 */
export function buildSSEBodyWithTextChunks(
  message: Anthropic.Message,
  textChunksByBlock: string[][]
): string {
  const lines: string[] = [];
  lines.push(
    `data: ${JSON.stringify({ type: 'message_start', message: { ...message, content: [] } })}\n`
  );
  let textBlockOrdinal = 0;
  message.content.forEach((block, index) => {
    if (block.type === 'text') {
      const chunks = textChunksByBlock[textBlockOrdinal] ?? [block.text];
      textBlockOrdinal += 1;
      lines.push(
        `data: ${JSON.stringify({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } })}\n`
      );
      for (const ch of chunks) {
        lines.push(
          `data: ${JSON.stringify({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: ch } })}\n`
        );
      }
      lines.push(`data: ${JSON.stringify({ type: 'content_block_stop', index })}\n`);
      return;
    }
    appendSSEBlock(lines, block, index, false);
  });
  lines.push(
    `data: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: message.stop_reason, stop_sequence: message.stop_sequence }, usage: message.usage })}\n`
  );
  lines.push(`data: ${JSON.stringify({ type: 'message_stop' })}\n`);
  return lines.join('\n');
}

/** Mock Anthropic fetch with per-message text-chunk plans (same order as messages). */
export function mockAnthropicSSEWithTextChunks(
  messages: Anthropic.Message[],
  chunkPlans: Array<string[][] | undefined>
): void {
  let call = 0;
  (Anthropic as unknown as ReturnType<typeof vi.fn>).mockImplementation(function Mock(
    this: object
  ) {
    return this;
  } as unknown as () => object);
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    const idx = Math.min(call, messages.length - 1);
    const msg = messages[idx]!;
    const plan = chunkPlans[idx];
    call += 1;
    const body = plan ? buildSSEBodyWithTextChunks(msg, plan) : buildSSEBody(msg, false);
    return new Response(body, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  });
}

export function captureOutboundSSE(
  messages: Anthropic.Message[],
  outbound: Array<Array<{ role: string; content: unknown }>>,
  splitText = false
): void {
  let call = 0;
  (Anthropic as unknown as ReturnType<typeof vi.fn>).mockImplementation(function Mock(
    this: object
  ) {
    return this;
  } as unknown as () => object);
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    if (init?.body) {
      outbound.push(
        (JSON.parse(String(init.body)) as { messages: Array<{ role: string; content: unknown }> })
          .messages
      );
    }
    const msg = messages[Math.min(call, messages.length - 1)]!;
    call += 1;
    return new Response(buildSSEBody(msg, splitText), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  });
}

export function baseOpts(
  logger: RequestLogger,
  overrides: {
    env?: Partial<Env>;
    catalog?: ToolCatalog;
    callbacks?: StreamCallbacks;
  } = {}
) {
  return {
    env: { ANTHROPIC_API_KEY: 'test-key', ...overrides.env } as Env,
    catalog: overrides.catalog ?? obsCatalog(),
    history: [],
    preferences: { response_language: 'en', first_interaction: true },
    logger,
    callbacks: overrides.callbacks,
  };
}

export function progressCallbacks(progress: string[]): StreamCallbacks {
  return {
    onProgress: (t) => progress.push(t),
    onStatus: vi.fn(),
    onComplete: vi.fn(),
    onError: vi.fn(),
  };
}

export function mcpRelayResult(id: string, text: string) {
  return {
    result: { ok: true },
    metadata: { 'bt/relay': [{ id, text }] },
    responseTimeMs: 1,
  };
}

/** Anthropic SSE + webhook dual-fetch mock for iteration-mode tests. */
export function mockAnthropicAndWebhookFetch(
  messages: Anthropic.Message[],
  webhookHost: string
): ReturnType<typeof vi.fn> {
  let call = 0;
  const fetchMock = vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
    if (String(url).includes(webhookHost)) return new Response('ok');
    const msg = messages[Math.min(call, messages.length - 1)]!;
    call += 1;
    return new Response(buildSSEBody(msg), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  (Anthropic as unknown as ReturnType<typeof vi.fn>).mockImplementation(function Mock(
    this: object
  ) {
    return this;
  } as unknown as () => object);
  return fetchMock;
}

export function webhookTextBodies(
  fetchMock: ReturnType<typeof vi.fn>,
  host: string
): Array<{ type: string; text?: string }> {
  return fetchMock.mock.calls
    .filter((c) => String(c[0]).includes(host))
    .map((c) => JSON.parse(String((c[1] as RequestInit).body)) as { type: string; text?: string });
}

export function reconstructIterationText(bodies: Array<{ type: string; text?: string }>): string {
  const joined = bodies
    .filter((b) => b.type === 'progress')
    .map((b) => b.text ?? '')
    .join('');
  return joined + (bodies.find((b) => b.type === 'complete')?.text ?? '');
}

/** Timed SSE frames for stall / abort tests. */
export function mockTimedSSEFrames(
  frames: string[],
  opts: { gapMs: number; close: boolean }
): void {
  (Anthropic as unknown as ReturnType<typeof vi.fn>).mockImplementation(function Mock(
    this: object
  ) {
    return this;
  } as unknown as () => object);
  const encoder = new TextEncoder();
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        frames.forEach((f, i) => {
          setTimeout(() => {
            if (init?.signal?.aborted) return;
            controller.enqueue(encoder.encode(f));
            if (opts.close && i === frames.length - 1) controller.close();
          }, i * opts.gapMs);
        });
      },
    });
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  });
}

export function sseFrame(event: object): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

/** SSE body that ends after a text delta with no content_block_stop (clean EOF). */
export function buildCleanEofSSEBody(text: string): string {
  return [
    `data: ${JSON.stringify({
      type: 'message_start',
      message: {
        id: 'm1',
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-4-20250514',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    })}\n`,
    `data: ${JSON.stringify({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    })}\n`,
    `data: ${JSON.stringify({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text },
    })}\n`,
    `data: ${JSON.stringify({
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 2 },
    })}\n`,
    `data: ${JSON.stringify({ type: 'message_stop' })}\n`,
  ].join('\n');
}
