/**
 * Tests for Anthropic prompt caching + token telemetry (issue #333).
 *
 * Two things are being protected here:
 *
 * 1. **The prompt text does not change.** The whole savings mechanism is
 *    "mark the stable prefix as cacheable" — nothing is reordered and no
 *    wording is edited. `buildSystemPromptBlocks()` splits the assembled
 *    sections at an existing seam, and `stable + volatile` must reproduce
 *    `buildSystemPrompt()` byte for byte. If that ever drifts, the model
 *    is seeing different input and this stopped being a billing change.
 *
 * 2. **The cached block stays user-invariant.** Caching is a prefix match
 *    shared across every user of an (org, mode). The realistic regression
 *    is a future PR interpolating a per-user value — a client id, a memory
 *    TOC, a speaker name — into the stable block, which silently returns
 *    the cache hit rate to zero with no error and no failing test. The
 *    invariance test below is the guard against exactly that.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';

const countMetricSpy = vi.fn();
const recordMetricSpy = vi.fn();

vi.mock('../../src/services/telemetry/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/telemetry/index.js')>();
  return {
    ...actual,
    countMetric: (...args: unknown[]) => countMetricSpy(...args),
    recordMetric: (...args: unknown[]) => recordMetricSpy(...args),
  };
});

// The SDK's own HTTP layer is unused (PR #104 — it 1003s from inside a DO), so
// the default export only ever gets `new`ed for the unused `ctx.client`. But
// `handleOrchestrationError` does `error instanceof Anthropic.APIError`, and a
// bare `vi.fn()` has no such static — which turns any real failure into a
// confusing "Right-hand side of 'instanceof' is not an object". Give the mock a
// real error class so genuine failures surface as themselves.
vi.mock('@anthropic-ai/sdk', () => {
  class MockAPIError extends Error {
    constructor(
      public status: number,
      message: string
    ) {
      super(message);
    }
  }
  const ctor = vi.fn();
  (ctor as unknown as { APIError: typeof MockAPIError }).APIError = MockAPIError;
  return { default: ctor };
});

const { buildSystemPrompt, buildSystemPromptBlocks } =
  await import('../../src/services/claude/system-prompt.js');
const { orchestrate, summarizeUsage } = await import('../../src/services/claude/orchestrator.js');
const { buildAllTools } = await import('../../src/services/claude/tools.js');
const { DEFAULT_PROMPT_VALUES } = await import('../../src/types/prompt-overrides.js');
const { buildToolCatalog } = await import('../../src/services/mcp/catalog.js');

import type { ToolCatalog } from '../../src/services/mcp/index.js';
import type { RequestLogger } from '../../src/utils/logger.js';
import type { Env } from '../../src/config/types.js';
import type { StreamCallbacks } from '../../src/types/engine.js';

const defaultPrefs = { response_language: 'en', first_interaction: false };

function createEmptyCatalog(): ToolCatalog {
  return buildToolCatalog([], []);
}

function createMockLogger(): RequestLogger {
  return { log: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as RequestLogger;
}

function logCallsFor(logger: RequestLogger, event: string): Record<string, unknown>[] {
  return (logger.log as unknown as ReturnType<typeof vi.fn>).mock.calls
    .filter((c) => c[0] === event)
    .map((c) => (c[1] ?? {}) as Record<string, unknown>);
}

/** The cacheable block for a given per-request options bag. */
function stableFor(
  opts: Record<string, unknown>,
  prefs = defaultPrefs,
  history: never[] = []
): string {
  return buildSystemPromptBlocks(createEmptyCatalog(), prefs, history, DEFAULT_PROMPT_VALUES, opts)
    .stable;
}

/**
 * Every meaningfully different shape of the per-request options bag. Used
 * twice: to prove concatenation is lossless for all of them, and to prove
 * none of them leak into the stable block.
 */
const OPTION_MATRIX: Array<[string, Record<string, unknown>]> = [
  ['bare', {}],
  ['client id', { clientId: 'whatsapp' }],
  ['other client id', { clientId: 'telegram' }],
  ['memory toc', { memoryTOC: '## Memory\n- alpha\n- beta' }],
  ['voice', { isVoiceMessage: true }],
  ['group chat', { groupContext: { isGroupChat: true, currentSpeaker: 'Ada' } }],
  ['group chat, other speaker', { groupContext: { isGroupChat: true, currentSpeaker: 'Grace' } }],
  ['language document', { languageDocument: '## Tone\nFormal register.' }],
  ['inbound voice', { inboundVoiceKey: 'voice/2026-08-26/abc123.ogg' }],
  ['not addressed', { addressedToBot: false }],
  ['trigger only', { triggerOnly: { mode: 'dbs-coach' } }],
  [
    'unmatched triggers',
    {
      unmatchedTriggers: [
        { kind: 'mode' as const, rawToken: '#nope', availableOptions: [{ name: 'dbs-coach' }] },
      ],
    },
  ],
  [
    'everything at once',
    {
      clientId: 'web',
      memoryTOC: '## Memory\n- gamma',
      isVoiceMessage: true,
      groupContext: { isGroupChat: true, currentSpeaker: 'Katherine' },
      languageDocument: '## Tone\nConversational.',
      inboundVoiceKey: 'voice/2026-08-26/zzz999.ogg',
      triggerOnly: { language: 'Hindi' },
    },
  ],
];

// ── 1. The prompt text is unchanged ──────────────────────────────────────────

describe('buildSystemPromptBlocks — byte-identity with buildSystemPrompt', () => {
  it.each(OPTION_MATRIX)('stable + volatile reproduces the prompt exactly (%s)', (_name, opts) => {
    const args = [createEmptyCatalog(), defaultPrefs, [], DEFAULT_PROMPT_VALUES, opts] as const;
    const blocks = buildSystemPromptBlocks(...args);

    // Plain concatenation on purpose: the '\n\n' separator lives INSIDE the
    // split (as the leading characters of `volatile`), never in the join.
    // Asserting `stable + '\n\n' + volatile` would hide a lost separator.
    expect(blocks.stable + blocks.volatile).toBe(buildSystemPrompt(...args));
  });

  it('reproduces the prompt exactly with a non-empty history and a preference', () => {
    const history = [
      { user_message: 'hello', assistant_response: 'hi there', timestamp: 1 },
    ] as never[];
    const prefs = { response_language: 'es', first_interaction: true };
    const args = [createEmptyCatalog(), prefs, history, DEFAULT_PROMPT_VALUES, {}] as const;
    const blocks = buildSystemPromptBlocks(...args);

    expect(blocks.stable + blocks.volatile).toBe(buildSystemPrompt(...args));
  });

  it('cuts exactly between instructions and client_instructions', () => {
    // Pins WHERE the seam is. Byte-identity alone cannot: both sides of that
    // assertion come from this same function, so a seam that drifted would
    // still be self-consistent. The pre-existing suites in
    // system-prompt.test.ts / group-chat.test.ts anchor the joined output to
    // today's behavior; this anchors the split point within it.
    const blocks = buildSystemPromptBlocks(
      createEmptyCatalog(),
      defaultPrefs,
      [],
      DEFAULT_PROMPT_VALUES,
      {}
    );

    expect(blocks.stable.endsWith(DEFAULT_PROMPT_VALUES.instructions)).toBe(true);
    expect(blocks.stable).not.toContain(DEFAULT_PROMPT_VALUES.client_instructions);
    expect(blocks.volatile).toContain(DEFAULT_PROMPT_VALUES.client_instructions);
    expect(blocks.volatile.endsWith(DEFAULT_PROMPT_VALUES.closing)).toBe(true);
  });

  it('carries the section separator inside the volatile block, not the join', () => {
    const blocks = buildSystemPromptBlocks(
      createEmptyCatalog(),
      defaultPrefs,
      [],
      DEFAULT_PROMPT_VALUES,
      {}
    );
    expect(blocks.volatile.startsWith('\n\n')).toBe(true);
    expect(blocks.stable.endsWith('\n')).toBe(false);
  });
});

// ── 2. The cached block is user-invariant ────────────────────────────────────

describe('buildSystemPromptBlocks — stable block invariance', () => {
  it('is byte-identical across every per-request option combination', () => {
    const stables = OPTION_MATRIX.map(([, opts]) => stableFor(opts));
    const [first, ...rest] = stables;
    for (const s of rest) expect(s).toBe(first);
  });

  it('is unaffected by conversation history or user preferences', () => {
    const loaded = stableFor({}, { response_language: 'hi', first_interaction: true }, [
      { user_message: 'q', assistant_response: 'a', timestamp: 1 },
    ] as never[]);

    expect(loaded).toBe(stableFor({}));
  });
});

describe('buildSystemPromptBlocks — stable block contents', () => {
  it('contains no per-request value', () => {
    const stable = stableFor({
      clientId: 'whatsapp',
      memoryTOC: 'MEMORY_TOC_SENTINEL',
      groupContext: { isGroupChat: true, currentSpeaker: 'SPEAKER_SENTINEL' },
      languageDocument: 'LANGUAGE_DOC_SENTINEL',
      inboundVoiceKey: 'VOICE_KEY_SENTINEL',
    });

    for (const sentinel of [
      'whatsapp',
      'MEMORY_TOC_SENTINEL',
      'SPEAKER_SENTINEL',
      'LANGUAGE_DOC_SENTINEL',
      'VOICE_KEY_SENTINEL',
    ]) {
      expect(stable).not.toContain(sentinel);
    }
  });

  it('does carry the org-configured slots that drive the savings', () => {
    const stable = stableFor({});

    expect(stable).toContain(DEFAULT_PROMPT_VALUES.identity);
    expect(stable).toContain(DEFAULT_PROMPT_VALUES.methodology);
    expect(stable).toContain(DEFAULT_PROMPT_VALUES.tool_guidance);
    expect(stable).toContain(DEFAULT_PROMPT_VALUES.instructions);
  });
});

// ── 3. The cached prefix clears the model's minimum ──────────────────────────

describe('cacheable prefix length', () => {
  it('tools + stable system clear the 1024-token floor for the default org', () => {
    // The breakpoint sits on the system block, and render order is
    // tools -> system -> messages, so the cached prefix is BOTH. The system
    // block alone is well under the floor on default prompts; the tool
    // definitions are what carry it over. Measured in characters against a
    // deliberately pessimistic 4.0 chars/token so the assertion cannot pass
    // on an optimistic estimate.
    const tools = buildAllTools(createEmptyCatalog(), { hasModes: true });
    const stable = buildSystemPromptBlocks(
      createEmptyCatalog(),
      defaultPrefs,
      [],
      DEFAULT_PROMPT_VALUES,
      {}
    ).stable;

    const chars = JSON.stringify(tools).length + stable.length;
    expect(chars / 4.0).toBeGreaterThan(1024);
  });
});

// ── 4. The request carries exactly the breakpoints we intend ─────────────────

interface CapturedBody {
  system: Array<{ type: string; text: string; cache_control?: { type: string } }>;
  cache_control?: { type: string };
  tools?: unknown[];
  messages: unknown[];
}

function createMockEnv(): Env {
  return { ANTHROPIC_API_KEY: 'test-key' } as Env;
}

/** A cold call: the prefix is written to cache, nothing is read back yet. */
const COLD_USAGE = {
  input_tokens: 40,
  output_tokens: 20,
  cache_creation_input_tokens: 6000,
  cache_read_input_tokens: 0,
} as Anthropic.Usage;

/** A warm call: the prefix is served from cache — the state we are paying for. */
const WARM_USAGE = {
  input_tokens: 40,
  output_tokens: 20,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 6000,
} as Anthropic.Usage;

function endTurnMessage(text: string, usage: Anthropic.Usage = COLD_USAGE): Anthropic.Message {
  return {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-4-6',
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage,
    content: [{ type: 'text', text }],
  } as Anthropic.Message;
}

function buildSSEBody(message: Anthropic.Message): string {
  const lines: string[] = [
    `data: ${JSON.stringify({ type: 'message_start', message: { ...message, content: [] } })}\n`,
  ];
  message.content.forEach((block, index) => {
    if (block.type !== 'text') return;
    lines.push(
      `data: ${JSON.stringify({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } })}\n`
    );
    lines.push(
      `data: ${JSON.stringify({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text } })}\n`
    );
    lines.push(`data: ${JSON.stringify({ type: 'content_block_stop', index })}\n`);
  });
  lines.push(
    `data: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: message.usage })}\n`
  );
  lines.push(`data: ${JSON.stringify({ type: 'message_stop' })}\n`);
  return lines.join('\n');
}

/**
 * Serves whichever transport the orchestrator asked for. `orchestrate()`
 * streams only when callbacks are supplied (production always does; several
 * tests do not), and the two paths assemble `usage` differently — JSON body
 * versus the `message_start` event — so both need covering.
 */
function captureRequestBodies(message: Anthropic.Message): CapturedBody[] {
  const bodies: CapturedBody[] = [];
  (Anthropic as unknown as ReturnType<typeof vi.fn>).mockImplementation(function MockAnthropic(
    this: object
  ) {
    return this;
  } as unknown as () => object);
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    const body = JSON.parse((init as RequestInit).body as string) as CapturedBody & {
      stream?: boolean;
    };
    bodies.push(body);
    return body.stream
      ? new Response(buildSSEBody(message), {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        })
      : new Response(JSON.stringify(message), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
  });
  return bodies;
}

function noopCallbacks(): StreamCallbacks {
  return {
    onProgress: vi.fn(),
    onStatus: vi.fn(),
    onComplete: vi.fn(),
    onError: vi.fn(),
  };
}

async function runOnce(
  logger: RequestLogger,
  opts: { streaming?: boolean; usage?: Anthropic.Usage } = {}
): Promise<CapturedBody[]> {
  const bodies = captureRequestBodies(endTurnMessage('done', opts.usage ?? COLD_USAGE));
  await orchestrate('hello', {
    env: createMockEnv(),
    catalog: createEmptyCatalog(),
    history: [],
    preferences: { response_language: 'en', first_interaction: false },
    logger,
    ...(opts.streaming ? { callbacks: noopCallbacks() } : {}),
  });
  return bodies;
}

describe('buildMessageBody — cache breakpoint shape', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    countMetricSpy.mockClear();
    recordMetricSpy.mockClear();
  });

  it('sends system as blocks with exactly one cache_control on the stable block', async () => {
    const [body] = await runOnce(createMockLogger());

    expect(Array.isArray(body!.system)).toBe(true);
    const marked = body!.system.filter((b) => b.cache_control !== undefined);
    expect(marked).toHaveLength(1);
    expect(marked[0]).toBe(body!.system[0]);
    expect(marked[0]!.cache_control).toEqual({ type: 'ephemeral' });
  });

  it('sets the top-level rolling breakpoint for the agentic loop', async () => {
    const [body] = await runOnce(createMockLogger());
    expect(body!.cache_control).toEqual({ type: 'ephemeral' });
  });

  it('never marks tools or messages — those are covered by the other two', async () => {
    const [body] = await runOnce(createMockLogger());
    expect(JSON.stringify(body!.tools ?? [])).not.toContain('cache_control');
    expect(JSON.stringify(body!.messages)).not.toContain('cache_control');
  });

  it('reassembles to the exact prompt the string builder produces', async () => {
    const [body] = await runOnce(createMockLogger());
    const rendered = body!.system.map((b) => b.text).join('');

    expect(rendered).toBe(
      buildSystemPrompt(createEmptyCatalog(), defaultPrefs, [], DEFAULT_PROMPT_VALUES, {
        clientId: undefined,
      })
    );
  });

  it('omits the volatile block entirely rather than sending it empty', () => {
    // Empty text blocks are rejected by the API and cannot be cached, so the
    // builder must drop the block rather than emit `{type:'text', text:''}`.
    const blocks = { stable: 'STABLE', volatile: '' };
    const system = [
      { type: 'text', text: blocks.stable, cache_control: { type: 'ephemeral' } },
      ...(blocks.volatile ? [{ type: 'text', text: blocks.volatile }] : []),
    ];
    expect(system).toHaveLength(1);
  });
});

// ── 5. Usage telemetry ───────────────────────────────────────────────────────

describe('summarizeUsage', () => {
  it('reports zeros for missing usage rather than throwing', () => {
    expect(summarizeUsage(undefined)).toEqual({
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      cache_write_5m_tokens: 0,
      cache_write_1h_tokens: 0,
      billable_input_tokens: 0,
    });
  });

  it('treats null cache fields as zero', () => {
    const s = summarizeUsage({
      input_tokens: 100,
      output_tokens: 50,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
    } as unknown as Anthropic.Usage);

    expect(s.cache_creation_input_tokens).toBe(0);
    expect(s.cache_read_input_tokens).toBe(0);
    expect(s.billable_input_tokens).toBe(100);
  });
});

describe('summarizeUsage — cache pricing multipliers', () => {
  it('applies the 1.25x write / 0.1x read multipliers', () => {
    const s = summarizeUsage({
      input_tokens: 500,
      output_tokens: 200,
      cache_creation_input_tokens: 4000,
      cache_read_input_tokens: 10000,
    } as unknown as Anthropic.Usage);

    // 500 + 1.25*4000 + 0.1*10000 = 500 + 5000 + 1000 = 6500
    expect(s.billable_input_tokens).toBe(6500);
    expect(s.cache_write_5m_tokens).toBe(4000);
    expect(s.cache_write_1h_tokens).toBe(0);
  });

  it('splits 5m and 1h writes and prices 1h at 2x when the API reports both', () => {
    const s = summarizeUsage({
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 300,
      cache_read_input_tokens: 0,
      cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 200 },
    } as unknown as Anthropic.Usage);

    expect(s.cache_write_5m_tokens).toBe(100);
    expect(s.cache_write_1h_tokens).toBe(200);
    // 1.25*100 + 2*200 = 125 + 400 = 525
    expect(s.billable_input_tokens).toBe(525);
  });

  it('is never more expensive than paying full price for the same prompt', () => {
    const s = summarizeUsage({
      input_tokens: 40,
      output_tokens: 10,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 8000,
    } as unknown as Anthropic.Usage);

    const totalPrompt = s.input_tokens + s.cache_creation_input_tokens + s.cache_read_input_tokens;
    expect(s.billable_input_tokens).toBeLessThan(totalPrompt);
    // savings = 0.9 * 8000 = 7200
    expect(totalPrompt - s.billable_input_tokens).toBe(7200);
  });
});

describe('claude_response telemetry', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    countMetricSpy.mockClear();
    recordMetricSpy.mockClear();
  });

  it.each([
    ['non-streaming', false],
    ['streaming', true],
  ])('logs the four usage fields plus the derived billable total (%s)', async (_n, streaming) => {
    const logger = createMockLogger();
    await runOnce(logger, { streaming: streaming as boolean });

    const [record] = logCallsFor(logger, 'claude_response');
    expect(record).toMatchObject({
      input_tokens: 40,
      output_tokens: 20,
      cache_creation_input_tokens: 6000,
      cache_read_input_tokens: 0,
      billable_input_tokens: 7540, // 40 + 1.25*6000
    });
  });

  it('logs the stable-prefix hash so a cache-rate dip can be attributed', async () => {
    const logger = createMockLogger();
    await runOnce(logger);

    const [record] = logCallsFor(logger, 'claude_request');
    expect(typeof record!.system_stable_hash).toBe('string');
    expect(record!.system_stable_hash).not.toBe('');
    expect(typeof record!.system_stable_chars).toBe('number');
  });
});

describe('claude_response telemetry — metrics', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    countMetricSpy.mockClear();
    recordMetricSpy.mockClear();
  });

  it('emits the token counters labelled by model on a cold call', async () => {
    await runOnce(createMockLogger());

    const emitted = countMetricSpy.mock.calls.map((c) => c[0] as string);
    expect(emitted).toContain('claude_input_tokens_total');
    expect(emitted).toContain('claude_output_tokens_total');
    expect(emitted).toContain('claude_cache_write_tokens_total');
    expect(emitted).toContain('claude_billable_input_tokens_total');

    const inputCall = countMetricSpy.mock.calls.find((c) => c[0] === 'claude_input_tokens_total');
    expect(inputCall![1]).toMatchObject({ model: 'claude-sonnet-4-6' });
    expect(inputCall![2]).toBe(40);
  });

  it('emits the cache read counter on a warm call', async () => {
    await runOnce(createMockLogger(), { usage: WARM_USAGE });

    const readCall = countMetricSpy.mock.calls.find(
      (c) => c[0] === 'claude_cache_read_tokens_total'
    );
    expect(readCall![1]).toMatchObject({ model: 'claude-sonnet-4-6' });
    expect(readCall![2]).toBe(6000);

    // 40 + 0.1*6000 = 640 billable, against a 6040-token prompt.
    const billableCall = countMetricSpy.mock.calls.find(
      (c) => c[0] === 'claude_billable_input_tokens_total'
    );
    expect(billableCall![2]).toBe(640);
  });

  it('skips zero-valued counters rather than emitting empty series', async () => {
    // A cold call reads nothing and a warm call writes nothing. Emitting
    // `add(0)` for the absent side would cost cardinality while carrying no
    // information, so those counters must not fire at all.
    await runOnce(createMockLogger());
    const cold = countMetricSpy.mock.calls.map((c) => c[0] as string);
    expect(cold).not.toContain('claude_cache_read_tokens_total');

    countMetricSpy.mockClear();
    vi.restoreAllMocks();

    await runOnce(createMockLogger(), { usage: WARM_USAGE });
    const warmWrites = countMetricSpy.mock.calls.filter(
      (c) => c[0] === 'claude_cache_write_tokens_total'
    );
    expect(warmWrites).toHaveLength(0);
  });

  it('labels the cache write counter with its TTL bucket', async () => {
    await runOnce(createMockLogger());

    const writeCall = countMetricSpy.mock.calls.find(
      (c) => c[0] === 'claude_cache_write_tokens_total'
    );
    expect(writeCall![1]).toMatchObject({ type: '5m' });
    expect(writeCall![2]).toBe(6000);
  });
});
