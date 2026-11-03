/**
 * #421 / #158: a text turn's user-facing text is the final iteration only.
 *
 * Gateways send every `responses[]` item and every `progress` text as its own
 * message. Narration the model writes before a tool round must not be one of
 * those messages. Voice turns already slice for TTS and suppress progress
 * text; they stay on that path.
 *
 * `saveConversation` stores `orchResult.responses.join('\n')` as
 * `assistant_response`. The array this file asserts is therefore the history
 * string the next turn will see.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import { orchestrate } from '../../src/services/claude/orchestrator.js';
import { UI_STRINGS } from '../../src/i18n/ui-strings.js';
import { UserDO } from '../../src/durable-objects/user-do.js';
import { DEFAULT_PROMPT_VALUES } from '../../src/types/prompt-overrides.js';
import {
  createWebhookCallbacks,
  ProgressCallbackSender,
} from '../../src/services/progress/callback.js';
import {
  buildSSEFrames,
  createMockCallbacks,
  createMockCatalog,
  createMockEnv,
  createMockLogger,
} from '../helpers/anthropic-sse.js';
import { createTimingContext } from '../../src/utils/timing.js';
import type { Env } from '../../src/config/types.js';
import type {
  ChatHistoryEntry,
  ChatRequest,
  ChatResponse,
  StreamCallbacks,
} from '../../src/types/engine.js';
import type { AudioContext } from '../../src/services/audio/types.js';
import type { RequestLogger } from '../../src/utils/logger.js';
import type { ProgressMode } from '../../src/types/engine.js';

vi.mock('@anthropic-ai/sdk', () => ({ default: vi.fn() }));

const NARRATION = 'Let me fetch the article.';
const ANSWER = 'Sheol is the grave.';
const APOLOGY = "Sorry, I couldn't finish an answer just now. Please try again.";

interface LoggedEvent {
  level: 'log' | 'warn';
  event: string;
  data: Record<string, unknown>;
}

interface ScriptedFetch {
  anthropicBodies: Array<Record<string, unknown>>;
  posts: Array<Record<string, unknown>>;
}

function createSinkLogger(sink: LoggedEvent[]): RequestLogger {
  const push =
    (level: LoggedEvent['level']) =>
    (event: string, data?: Record<string, unknown>): void => {
      sink.push({ level, event, data: data ?? {} });
    };
  return {
    log: vi.fn(push('log')),
    warn: vi.fn(push('warn')),
    error: vi.fn(),
  } as unknown as RequestLogger;
}

function createMessage(
  id: string,
  stopReason: 'tool_use' | 'end_turn',
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

function toolUse(id: string): Anthropic.ContentBlock {
  return {
    type: 'tool_use',
    id,
    name: 'get_tool_definitions',
    input: { tool_names: ['search'] },
  } as Anthropic.ContentBlock;
}

function textBlock(text: string): Anthropic.ContentBlock {
  return { type: 'text', text } as Anthropic.ContentBlock;
}

function narrationThenTool(id: string): Anthropic.Message {
  return createMessage(`msg_${id}`, 'tool_use', [textBlock(NARRATION), toolUse(id)]);
}

function answer(text: string): Anthropic.Message {
  return createMessage(`msg_${text.length}`, 'end_turn', [textBlock(text)]);
}

function silentEnd(): Anthropic.Message {
  return createMessage('msg_silent', 'end_turn', []);
}

/** SSE body the streaming parser accepts for one canned message. */
function sseFor(message: Anthropic.Message): string {
  const events: object[] = [{ type: 'message_start', message: { ...message, content: [] } }];
  message.content.forEach((block, index) => {
    if (block.type === 'text') {
      events.push({
        type: 'content_block_start',
        index,
        content_block: { type: 'text', text: '' },
      });
      events.push({
        type: 'content_block_delta',
        index,
        delta: { type: 'text_delta', text: block.text },
      });
      events.push({ type: 'content_block_stop', index });
    }
    if (block.type === 'tool_use') {
      events.push({
        type: 'content_block_start',
        index,
        content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} },
      });
      events.push({
        type: 'content_block_delta',
        index,
        delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) },
      });
      events.push({ type: 'content_block_stop', index });
    }
  });
  events.push({
    type: 'message_delta',
    delta: { stop_reason: message.stop_reason, stop_sequence: null },
    usage: message.usage,
  });
  events.push({ type: 'message_stop' });
  return buildSSEFrames(events);
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function installScript(
  rounds: Anthropic.Message[],
  posts: Array<Record<string, unknown>>
): ScriptedFetch {
  const anthropicBodies: Array<Record<string, unknown>> = [];
  let call = 0;
  (Anthropic as unknown as ReturnType<typeof vi.fn>).mockImplementation(function MockAnthropic(
    this: object
  ) {
    return this;
  } as unknown as () => object);

  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = requestUrl(input);
    const raw = (init as RequestInit | undefined)?.body;
    const parsed = typeof raw === 'string' ? (JSON.parse(raw) as Record<string, unknown>) : {};
    if (!url.includes('api.anthropic.com')) {
      posts.push(parsed);
      return new Response('ok');
    }
    anthropicBodies.push(parsed);
    const message = rounds[Math.min(call, rounds.length - 1)]!;
    call += 1;
    return new Response(sseFor(message), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  });
  return { anthropicBodies, posts };
}

function baseOptions(
  logger: RequestLogger,
  callbacks: StreamCallbacks,
  env: Env = createMockEnv()
) {
  return {
    env,
    catalog: createMockCatalog(),
    history: [] as ChatHistoryEntry[],
    preferences: { response_language: 'en', first_interaction: false },
    logger,
    callbacks,
  };
}

function droppedEvent(sink: LoggedEvent[]): LoggedEvent | undefined {
  return sink.find((event) => event.event === 'intermediate_responses_dropped');
}

describe('text turns emit only the final iteration (#421)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('keeps the final answer in responses, history, and progress, and still emits status', async () => {
    const sink: LoggedEvent[] = [];
    const posts: Array<Record<string, unknown>> = [];
    const script = installScript([narrationThenTool('tool_1'), answer(ANSWER)], posts);
    const { callbacks, statuses, progress } = createMockCallbacks();
    const iterationComplete = vi.fn();
    callbacks.onIterationComplete = iterationComplete;

    const result = await orchestrate(
      'what is sheol?',
      baseOptions(createSinkLogger(sink), callbacks)
    );

    // saveConversation joins this array into assistant_response.
    expect(result.responses).toEqual([ANSWER]);
    expect(result.responses.join('\n')).toBe(ANSWER);
    expect(result.finalIterationStartIndex).toBe(0);
    expect(progress.join('')).toBe(ANSWER);
    expect(progress.join('')).not.toContain(NARRATION);
    expect(iterationComplete).not.toHaveBeenCalled();
    expect(statuses.map((status) => status.key)).toContain('status_executing_tools');
    expect(droppedEvent(sink)?.data).toEqual({ count: 1, lengths: [NARRATION.length] });
    expect(JSON.stringify(droppedEvent(sink)?.data)).not.toContain(NARRATION);
    expect(result.telemetry.droppedResponseCount).toBe(1);
    expect(result.telemetry.droppedResponseLengths).toEqual([NARRATION.length]);
    expect(script.anthropicBodies).toHaveLength(2);
  });
});

describe('follow-up turns see only the final answer (#421)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('feeds the next turn only the final answer, not the dropped narration', async () => {
    const posts: Array<Record<string, unknown>> = [];
    installScript([narrationThenTool('tool_1'), answer(ANSWER)], posts);
    const { callbacks } = createMockCallbacks();
    const first = await orchestrate('what is sheol?', baseOptions(createMockLogger(), callbacks));

    const history: ChatHistoryEntry[] = [
      {
        user_message: 'what is sheol?',
        assistant_response: first.responses.join('\n'),
        timestamp: 1,
      },
    ];
    const followUp = installScript([answer('The grave, not a place of torment.')], posts);
    await orchestrate('say more', {
      ...baseOptions(createMockLogger(), createMockCallbacks().callbacks),
      history,
    });

    const prior = followUp.anthropicBodies[0]?.messages as Array<{
      role: string;
      content: unknown;
    }>;
    const assistant = prior.find((message) => message.role === 'assistant');
    expect(assistant?.content).toBe(ANSWER);
    expect(JSON.stringify(prior)).not.toContain(NARRATION);
  });
});

describe('a final round with no text still answers (#158)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('makes one more call with tools off and sends that text', async () => {
    const posts: Array<Record<string, unknown>> = [];
    const script = installScript([narrationThenTool('tool_1'), silentEnd(), answer(ANSWER)], posts);
    const { callbacks, progress } = createMockCallbacks();
    const result = await orchestrate('what is sheol?', baseOptions(createMockLogger(), callbacks));

    expect(script.anthropicBodies).toHaveLength(3);
    expect(script.anthropicBodies[2]).not.toHaveProperty('tools');
    const instruction = JSON.stringify(script.anthropicBodies[2]?.messages);
    expect(instruction).toContain('Answer the user now from what you already gathered');
    expect(instruction).toContain('Respond in en.');
    expect(result.responses).toEqual([ANSWER]);
    expect(result.responses.join('')).not.toContain(NARRATION);
    expect(progress.join('')).toBe(ANSWER);
  });
});

describe('an empty recovery call apologizes instead of sending narration (#158)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('sends an apology when the extra call is also empty', async () => {
    const sink: LoggedEvent[] = [];
    const posts: Array<Record<string, unknown>> = [];
    const script = installScript([narrationThenTool('tool_1'), silentEnd(), silentEnd()], posts);
    const { callbacks } = createMockCallbacks();
    const result = await orchestrate(
      'what is sheol?',
      baseOptions(createSinkLogger(sink), callbacks)
    );

    expect(script.anthropicBodies).toHaveLength(3);
    expect(result.responses).toEqual([APOLOGY]);
    expect(result.responses.join('')).not.toContain(NARRATION);
    expect(
      sink.some((event) => event.level === 'warn' && event.event === 'empty_final_answer')
    ).toBe(true);
    expect(UI_STRINGS.en.notice_empty_answer).toBe(APOLOGY);
  });
});

describe('recovery still runs when the loop ends exactly at the cap (#158)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('still makes the one no-tools call when the loop finishes exactly at the cap with no text', async () => {
    const posts: Array<Record<string, unknown>> = [];
    const script = installScript([narrationThenTool('tool_1'), silentEnd(), answer(ANSWER)], posts);
    const { callbacks } = createMockCallbacks();
    const result = await orchestrate(
      'what is sheol?',
      baseOptions(
        createMockLogger(),
        callbacks,
        createMockEnv({ MAX_ORCHESTRATION_ITERATIONS: '2' })
      )
    );

    // The loop used both iterations (narration+tool, then an empty end_turn).
    // The recovery call is the third request and does not need room left in the cap.
    expect(script.anthropicBodies).toHaveLength(3);
    expect(script.anthropicBodies[2]).not.toHaveProperty('tools');
    expect(result.responses).toEqual([ANSWER]);
    expect(result.telemetry.exitReason).toBe('done');
    expect(result.responses.join('')).not.toContain(NARRATION);
    expect(result.responses.join('')).not.toContain(UI_STRINGS.en.notice_max_iterations);
  });
});

describe('the recovery instruction names the response language (#158)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('tells the recovery call to answer in the turn response language', async () => {
    const posts: Array<Record<string, unknown>> = [];
    const script = installScript([narrationThenTool('tool_1'), silentEnd(), answer(ANSWER)], posts);
    const { callbacks } = createMockCallbacks();
    await orchestrate('o que é sheol?', {
      ...baseOptions(createMockLogger(), callbacks),
      preferences: { response_language: 'pt', first_interaction: false },
    });

    const instruction = JSON.stringify(script.anthropicBodies[2]?.messages);
    expect(instruction).toContain('Answer the user now from what you already gathered');
    expect(instruction).toContain('Respond in pt.');
  });
});

describe("voice turns keep today's narration path (#428)", () => {
  afterEach(() => vi.restoreAllMocks());

  it('still returns every iteration and streams the narration', async () => {
    const sink: LoggedEvent[] = [];
    const posts: Array<Record<string, unknown>> = [];
    installScript([narrationThenTool('tool_1'), answer(ANSWER)], posts);
    const { callbacks, progress } = createMockCallbacks();
    const iterationComplete = vi.fn();
    callbacks.onIterationComplete = iterationComplete;

    const result = await orchestrate('what is sheol?', {
      ...baseOptions(createSinkLogger(sink), callbacks),
      isVoiceMessage: true,
    });

    expect(result.responses).toEqual([NARRATION, ANSWER]);
    expect(result.finalIterationStartIndex).toBe(1);
    expect(result.responses.slice(result.finalIterationStartIndex)).toEqual([ANSWER]);
    expect(progress).toContain(NARRATION);
    expect(progress).toContain('\n');
    expect(progress).toContain(ANSWER);
    expect(iterationComplete).toHaveBeenCalledTimes(1);
    expect(droppedEvent(sink)).toBeUndefined();
    expect(result.telemetry.droppedResponseCount).toBe(0);
    expect(result.telemetry.droppedResponseLengths).toEqual([]);
  });
});

const WEBHOOK = {
  url: 'https://gateway.example/progress',
  user_id: 'user-1',
  message_key: 'msg-1',
  token: 'token',
};

function completeFrom(responses: string[]): ChatResponse {
  return { responses, response_language: 'en', voice_audio_base64: null };
}

async function runWebhookMode(mode: ProgressMode): Promise<Array<Record<string, unknown>>> {
  const posts: Array<Record<string, unknown>> = [];
  installScript([narrationThenTool('tool_1'), answer(ANSWER)], posts);
  const logger = createMockLogger();
  const sender = new ProgressCallbackSender(WEBHOOK, logger);
  const callbacks = createWebhookCallbacks(sender, logger, { mode, throttleSeconds: 1 });
  const result = await orchestrate('what is sheol?', baseOptions(logger, callbacks));
  await callbacks.onComplete(completeFrom(result.responses));
  return posts;
}

function ofType(
  posts: Array<Record<string, unknown>>,
  type: string
): Array<Record<string, unknown>> {
  return posts.filter((post) => post.type === type);
}

describe('each progress mode sends only final-iteration text (#421)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('iteration mode sends status and one complete answer, no progress narration', async () => {
    const posts = await runWebhookMode('iteration');
    expect(ofType(posts, 'progress')).toEqual([]);
    expect(ofType(posts, 'status').length).toBeGreaterThan(0);
    expect(ofType(posts, 'complete')).toEqual([
      expect.objectContaining({ type: 'complete', text: ANSWER }),
    ]);
    expect(JSON.stringify(posts)).not.toContain(NARRATION);
  });

  it('sentence mode streams the final sentence and does not repeat it on complete', async () => {
    const posts = await runWebhookMode('sentence');
    expect(ofType(posts, 'progress').map((post) => post.text)).toEqual([ANSWER]);
    expect(ofType(posts, 'complete')).toEqual([]);
    expect(ofType(posts, 'status').length).toBeGreaterThan(0);
    expect(JSON.stringify(posts)).not.toContain(NARRATION);
  });

  it('periodic mode holds the final text for the throttle, so the answer leaves on complete', async () => {
    const posts = await runWebhookMode('periodic');
    expect(ofType(posts, 'progress')).toEqual([]);
    expect(ofType(posts, 'complete')).toEqual([
      expect.objectContaining({ type: 'complete', text: ANSWER }),
    ]);
    expect(ofType(posts, 'status').length).toBeGreaterThan(0);
    expect(JSON.stringify(posts)).not.toContain(NARRATION);
  });

  it('complete mode sends only the final answer, still with no status and no progress', async () => {
    const posts = await runWebhookMode('complete');
    expect(ofType(posts, 'progress')).toEqual([]);
    expect(ofType(posts, 'status')).toEqual([]);
    expect(ofType(posts, 'complete')).toEqual([
      expect.objectContaining({ type: 'complete', text: ANSWER }),
    ]);
  });
});

const NOTICE = UI_STRINGS.en.notice_max_iterations;

describe('stopping at the cap drops the unfinished narration (#421)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('drops the unfinished round, answers once without tools, then sends the limit notice', async () => {
    const sink: LoggedEvent[] = [];
    const posts: Array<Record<string, unknown>> = [];
    const script = installScript([narrationThenTool('tool_1'), answer(ANSWER)], posts);
    const { callbacks, progress } = createMockCallbacks();
    const result = await orchestrate(
      'what is sheol?',
      baseOptions(
        createSinkLogger(sink),
        callbacks,
        createMockEnv({ MAX_ORCHESTRATION_ITERATIONS: '1' })
      )
    );

    expect(script.anthropicBodies).toHaveLength(2);
    expect(script.anthropicBodies[1]).not.toHaveProperty('tools');
    expect(result.telemetry.exitReason).toBe('max_iterations');
    expect(result.responses).toEqual([ANSWER, NOTICE]);
    expect(result.responses.join('')).not.toContain(NARRATION);
    expect(progress.join('')).not.toContain(NARRATION);
    expect(progress.join('')).toContain(ANSWER);
    expect(progress.join('')).toContain(NOTICE);
    expect(droppedEvent(sink)?.data).toEqual({ count: 1, lengths: [NARRATION.length] });
  });
});

describe('an empty recovery at the cap still apologizes (#158)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('apologizes when that recovery call is also empty, and still sends the limit notice', async () => {
    const sink: LoggedEvent[] = [];
    const posts: Array<Record<string, unknown>> = [];
    const script = installScript([narrationThenTool('tool_1'), silentEnd()], posts);
    const { callbacks } = createMockCallbacks();
    const result = await orchestrate(
      'what is sheol?',
      baseOptions(
        createSinkLogger(sink),
        callbacks,
        createMockEnv({ MAX_ORCHESTRATION_ITERATIONS: '1' })
      )
    );

    expect(script.anthropicBodies).toHaveLength(2);
    expect(result.responses).toEqual([APOLOGY, NOTICE]);
    expect(result.responses.join('')).not.toContain(NARRATION);
    expect(
      sink.some((event) => event.level === 'warn' && event.event === 'empty_final_answer')
    ).toBe(true);
  });
});

describe('voice at the cap is unchanged (#428)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('a voice turn at the cap still speaks the last round and the notice, with no extra call', async () => {
    const posts: Array<Record<string, unknown>> = [];
    const script = installScript([narrationThenTool('tool_1'), answer(ANSWER)], posts);
    const { callbacks, progress } = createMockCallbacks();
    const result = await orchestrate('what is sheol?', {
      ...baseOptions(
        createMockLogger(),
        callbacks,
        createMockEnv({ MAX_ORCHESTRATION_ITERATIONS: '1' })
      ),
      isVoiceMessage: true,
    });

    expect(script.anthropicBodies).toHaveLength(1);
    expect(result.responses).toEqual([NARRATION, NOTICE]);
    expect(progress).toContain(NARRATION);
    expect(progress).toContain(NOTICE);
    expect(result.telemetry.droppedResponseCount).toBe(0);
  });
});

const ANSWER_PREFIX = 'Sheol is ';
const ANSWER_SUFFIX = 'the grave.';

function defer(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Final-round SSE that yields the prefix, waits, then yields the suffix. */
function pausedAnswerStream(
  gate: Promise<void>,
  markPaused: () => void
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const message = {
    id: 'msg_slow',
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-4-20250514',
    stop_reason: null,
    stop_sequence: null,
    usage: {
      input_tokens: 10,
      output_tokens: 20,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
    content: [],
  };
  const head = buildSSEFrames([
    { type: 'message_start', message },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ANSWER_PREFIX } },
  ]);
  const tail = buildSSEFrames([
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ANSWER_SUFFIX } },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: message.usage,
    },
    { type: 'message_stop' },
  ]);
  let opened = false;
  return new ReadableStream({
    async pull(controller) {
      if (opened) return;
      opened = true;
      controller.enqueue(encoder.encode(head));
      markPaused();
      await gate;
      controller.enqueue(encoder.encode(tail));
      controller.close();
    },
  });
}

function installSlowFetch(
  posts: Array<Record<string, unknown>>,
  gate: Promise<void>,
  markPaused: () => void
): void {
  let call = 0;
  (Anthropic as unknown as ReturnType<typeof vi.fn>).mockImplementation(function MockAnthropic(
    this: object
  ) {
    return this;
  } as unknown as () => object);
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = requestUrl(input);
    const raw = (init as RequestInit | undefined)?.body;
    const parsed = typeof raw === 'string' ? (JSON.parse(raw) as Record<string, unknown>) : {};
    if (!url.includes('api.anthropic.com')) {
      posts.push(parsed);
      return new Response('ok');
    }
    call += 1;
    const body = call === 1 ? sseFor(narrationThenTool('tool_1')) : null;
    if (body) {
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    return new Response(pausedAnswerStream(gate, markPaused), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  });
}

async function runSlowFinalRound(): Promise<{
  posts: Array<Record<string, unknown>>;
  callbacks: StreamCallbacks;
  result: Awaited<ReturnType<typeof orchestrate>>;
}> {
  const posts: Array<Record<string, unknown>> = [];
  const paused = defer();
  const gate = defer();
  installSlowFetch(posts, gate.promise, paused.resolve);
  const logger = createMockLogger();
  const sender = new ProgressCallbackSender(WEBHOOK, logger);
  const callbacks = createWebhookCallbacks(sender, logger, {
    mode: 'periodic',
    throttleSeconds: 1,
  });
  const pending = orchestrate('what is sheol?', baseOptions(logger, callbacks));
  await paused.promise;
  // The parser consumes the prefix on a microtask after the stream yields.
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(1000);
  gate.resolve();
  return { posts, callbacks, result: await pending };
}

describe('periodic mode with a slow final round (#421)', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('lets the throttle elapse before the final round ends, then complete sends only the rest', async () => {
    vi.useFakeTimers();
    const { posts, callbacks, result } = await runSlowFinalRound();
    expect(ofType(posts, 'progress').map((post) => post.text)).toEqual([ANSWER_PREFIX]);
    await callbacks.onComplete(completeFrom(result.responses));
    await vi.advanceTimersByTimeAsync(0);
    expect(ofType(posts, 'complete')).toEqual([
      expect.objectContaining({ type: 'complete', text: ANSWER_SUFFIX }),
    ]);
    expect(result.responses).toEqual([ANSWER]);
    expect(JSON.stringify(posts)).not.toContain(NARRATION);
  });
});

function requestAudioBlock(id: string): Anthropic.ContentBlock {
  return { type: 'tool_use', id, name: 'request_audio', input: {} } as Anthropic.ContentBlock;
}

function freshAudioContext(): AudioContext {
  const audio: AudioContext = {
    audioRequested: false,
    requestAudio: () => {
      audio.audioRequested = true;
    },
  };
  return audio;
}

function spokenText(result: Awaited<ReturnType<typeof orchestrate>>): string[] {
  const userDo = new UserDO(
    {
      storage: {
        get: vi.fn(async () => undefined),
        put: vi.fn(async () => undefined),
        delete: vi.fn(async () => undefined),
      },
      blockConcurrencyWhile: <T>(fn: () => Promise<T>) => fn(),
    } as unknown as DurableObjectState,
    createMockEnv()
  );
  return (
    userDo as unknown as {
      extractTtsResponses(
        orchResult: { responses: string[]; finalIterationStartIndex: number },
        logger: RequestLogger
      ): string[];
    }
  ).extractTtsResponses(result, createMockLogger());
}

describe('a text turn that asks for audio speaks only the final answer (#421)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('gives TTS the final text and does not send the narration as progress', async () => {
    const posts: Array<Record<string, unknown>> = [];
    const audio = freshAudioContext();
    const round = createMessage('msg_audio', 'tool_use', [
      textBlock(NARRATION),
      requestAudioBlock('audio_1'),
    ]);
    installScript([round, answer(ANSWER)], posts);
    const { callbacks, progress } = createMockCallbacks();
    const result = await orchestrate('read sheol aloud', {
      ...baseOptions(createMockLogger(), callbacks),
      audioContext: audio,
    });
    const spoken = spokenText(result);

    expect(audio.audioRequested).toBe(true);
    expect(result.responses).toEqual([ANSWER]);
    expect(progress.join('')).toBe(ANSWER);
    expect(spoken).toEqual([ANSWER]);
  });
});

const WELCOME = 'Welcome to Spoken mode!';
const AUDIO_KEY = 'voice-submissions/unfoldingWord/u1/u1/story.ogg';

interface WelcomeTurn {
  loadChatContext(): Promise<unknown>;
  classifyAndResolveTriggers(): Promise<unknown>;
  processChat(
    body: ChatRequest,
    workerOrigin: string,
    logger: RequestLogger,
    timing: ReturnType<typeof createTimingContext>,
    callbacks?: StreamCallbacks
  ): Promise<ChatResponse>;
}

function historyState(historyPuts: unknown[]): DurableObjectState {
  const storage = {
    get: vi.fn(async () => undefined),
    put: vi.fn(async (key: string, value: unknown) => {
      if (key === 'history') historyPuts.push(value);
    }),
    delete: vi.fn(async () => undefined),
    list: vi.fn(async () => new Map()),
    setAlarm: vi.fn(async () => undefined),
    transaction: vi.fn(async (fn: (txn: DurableObjectTransaction) => Promise<void>) => {
      await fn(storage as unknown as DurableObjectTransaction);
    }),
  };
  return {
    storage,
    blockConcurrencyWhile: <T>(fn: () => Promise<T>) => fn(),
  } as unknown as DurableObjectState;
}

function welcomeEnv(): Env {
  return {
    ...createMockEnv(),
    DEFAULT_ORG: 'unfoldingWord',
    AUDIO_BUCKET: { head: async () => ({ httpMetadata: { contentType: 'audio/ogg' } }) },
  } as unknown as Env;
}

function clipRound(): Anthropic.Message {
  return createMessage('msg_clip', 'tool_use', [
    textBlock(NARRATION),
    {
      type: 'tool_use',
      id: 'clip_1',
      name: 'attach_audio',
      input: { r2_key: AUDIO_KEY },
    } as Anthropic.ContentBlock,
  ]);
}

async function runWelcomeTurn(historyPuts: unknown[]): Promise<{
  calls: number;
  response: ChatResponse;
  progress: string[];
}> {
  const posts: Array<Record<string, unknown>> = [];
  const script = installScript([clipRound(), answer(ANSWER)], posts);
  const progress: string[] = [];
  const internals = new UserDO(historyState(historyPuts), welcomeEnv()) as unknown as WelcomeTurn;
  vi.spyOn(internals, 'loadChatContext').mockResolvedValue({
    messageText: 'what is sheol?',
    preferences: { response_language: 'en', first_interaction: true },
    locale: 'en',
    history: [],
    catalog: createMockCatalog(),
    orgModes: { modes: [] },
  });
  vi.spyOn(internals, 'classifyAndResolveTriggers').mockResolvedValue({
    messageText: 'what is sheol?',
    resolved: DEFAULT_PROMPT_VALUES,
    activeModeName: 'spoken',
    languageSource: 'none',
    welcome: {
      text: WELCOME,
      keys: { welcomed: 'mode_welcomed:spoken', pending: 'mode_welcome_pending:spoken' },
    },
  });
  const response = await internals.processChat(
    {
      client_id: 'web',
      user_id: 'u1',
      message_type: 'text',
      message: 'what is sheol?',
      org: 'unfoldingWord',
    },
    'https://w.example',
    createMockLogger(),
    createTimingContext(),
    {
      onStatus: () => undefined,
      onProgress: (text) => progress.push(text),
      onComplete: () => undefined,
      onError: () => undefined,
      deferInBandWelcomeRecord: () => undefined,
    }
  );
  return { calls: script.anthropicBodies.length, response, progress };
}

describe('in-band welcome stays out of history after a two-round text turn (#311, #421)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('puts the welcome and the final answer on complete, and stores only the answer', async () => {
    const historyPuts: unknown[] = [];
    const turn = await runWelcomeTurn(historyPuts);
    const stored = historyPuts.at(-1) as ChatHistoryEntry[];
    expect(turn.calls).toBe(2);
    expect(turn.response.responses).toEqual([WELCOME, ANSWER]);
    expect(turn.response.attachments?.[0]).toMatchObject({ type: 'audio', r2_key: AUDIO_KEY });
    expect(turn.progress.join('')).not.toContain(NARRATION);
    expect(stored[0]?.assistant_response).toBe(ANSWER);
    expect(stored[0]?.assistant_response).not.toContain(WELCOME);
  });
});
