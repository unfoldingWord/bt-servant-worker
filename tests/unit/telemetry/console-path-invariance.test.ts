/**
 * CONSOLE PATH INVARIANCE — the safety net for A1 (docs/plans/production-otel.md).
 *
 * `logger.log()` serializes ONE `LogEntry` to `console.log` and then hands the SAME
 * object to the OTLP sink. `bt-servant-telemetry` consumes the console side via a Tail
 * Worker and derives its own `user_hash` from `obj.user_id`, so any change to what
 * `console.log` emits silently corrupts that app's cohort tables — renaming the field
 * nulls every hash, reusing the name double-hashes and resets every cohort to zero.
 *
 * These tests exist so that failure mode is loud and immediate. They assert the console
 * bytes directly, NOT the OTLP attributes, and they must keep passing unchanged until
 * Phase C4 removes the tail consumer. If you are here because one of them went red:
 * you have almost certainly just broken the production dashboard at telemetry.btservant.ai.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequestLogger, setLogSink, type LogEntry } from '../../../src/utils/logger.js';
import { buildLogAttributes } from '../../../src/services/telemetry/logs.js';

const FIXED_MS = 1_760_000_000_000;

/** Capture exactly what reaches console.<method>, as the raw string. */
function captureConsole(method: 'log' | 'warn' | 'error') {
  const lines: string[] = [];
  const spy = vi.spyOn(console, method).mockImplementation((line: unknown) => {
    lines.push(String(line));
  });
  return { lines, restore: () => spy.mockRestore() };
}

/** Deterministic timestamps, and no sink leaking between cases. */
function useConsoleFixture(): void {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_MS);
    setLogSink(null);
  });
  afterEach(() => {
    vi.useRealTimers();
    setLogSink(null);
    vi.restoreAllMocks();
  });
}

/**
 * Golden cases — the exact bytes the tail consumer parses.
 *
 * `userId` present means the case exercises the TWO-ARG
 * `createRequestLogger(requestId, userId)` form, where `user_id` is appended by
 * `buildLogEntry` rather than arriving in the data payload. That form is live at
 * `handleDORequest` (src/index.ts): a different code path, the same contract — the
 * consumer cannot tell them apart and must not have to.
 */
const GOLDEN = [
  {
    label: 'request_received',
    event: 'request_received',
    requestId: 'req-123',
    userId: undefined as string | undefined,
    // prettier-ignore
    payload: {
      user_id: 'whatsapp:15551234567', client_id: 'whatsapp', org: 'unfoldingWord',
      transport: 'whatsapp', chat_type: 'private', chat_id: 'chat-9', thread_id: 'thread-1',
    },
    expected: JSON.stringify({
      event: 'request_received',
      request_id: 'req-123',
      timestamp: FIXED_MS,
      user_id: 'whatsapp:15551234567',
      client_id: 'whatsapp',
      org: 'unfoldingWord',
      transport: 'whatsapp',
      chat_type: 'private',
      chat_id: 'chat-9',
      thread_id: 'thread-1',
    }),
  },
  {
    // The PR-1 <-> PR-1b contract. bt-servant-telemetry parses this exact JSON off
    // the tail stream; if the shape drifts, ingest silently drops fields.
    label: 'chat_turn',
    event: 'chat_turn',
    requestId: 'req-789',
    userId: undefined as string | undefined,
    // prettier-ignore
    payload: {
      turn_id: 'turn-abc', user_id: 'whatsapp:15551234567', org: 'unfoldingWord',
      client_id: 'whatsapp', transport: 'whatsapp', chat_type: 'private',
      response_language: 'en', user_country: 'US', edge_country: 'US',
      mode: 'dbs-coach', mode_switched_to: null, language: 'hindi',
      language_source: 'trigger', model: 'claude-sonnet-4-20250514',
      iterations: 3, exit_reason: 'done', stop_reason: 'end_turn', mcp_calls_made: 2,
      input_tokens: 120, output_tokens: 340, cache_creation_input_tokens: 0,
      cache_read_input_tokens: 1500, billable_input_tokens: 270,
      duration_ms: 4200, had_inbound_voice: false, had_outbound_voice: true,
    },
    expected: JSON.stringify({
      event: 'chat_turn',
      request_id: 'req-789',
      timestamp: FIXED_MS,
      turn_id: 'turn-abc',
      user_id: 'whatsapp:15551234567',
      org: 'unfoldingWord',
      client_id: 'whatsapp',
      transport: 'whatsapp',
      chat_type: 'private',
      response_language: 'en',
      user_country: 'US',
      edge_country: 'US',
      mode: 'dbs-coach',
      mode_switched_to: null,
      language: 'hindi',
      language_source: 'trigger',
      model: 'claude-sonnet-4-20250514',
      iterations: 3,
      exit_reason: 'done',
      stop_reason: 'end_turn',
      mcp_calls_made: 2,
      input_tokens: 120,
      output_tokens: 340,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 1500,
      billable_input_tokens: 270,
      duration_ms: 4200,
      had_inbound_voice: false,
      had_outbound_voice: true,
    }),
  },
  {
    // Same record with its conversation text. The two text fields ride the
    // console path VERBATIM — bt-servant-telemetry scrubs them before anything
    // leaves for PostHog — while redact.test.ts pins that the OTLP path only ever
    // sees `string(<len>)` for both keys.
    label: 'chat_turn (with conversation text)',
    event: 'chat_turn',
    requestId: 'req-790',
    userId: undefined as string | undefined,
    // prettier-ignore
    payload: {
      turn_id: 'turn-txt', user_id: 'whatsapp:15551234567', org: 'unfoldingWord',
      client_id: 'whatsapp', transport: 'whatsapp', chat_type: 'private',
      response_language: 'en', user_country: 'US', edge_country: 'US',
      mode: null, mode_switched_to: null, language: null,
      language_source: 'default', model: 'claude-sonnet-4-20250514',
      iterations: 1, exit_reason: 'done', stop_reason: 'end_turn', mcp_calls_made: 0,
      input_tokens: 12, output_tokens: 34, cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0, billable_input_tokens: 12,
      duration_ms: 900, had_inbound_voice: false, had_outbound_voice: false,
      user_message: 'What does John 3:16 mean? My pastor Bob asked.',
      assistant_reply: 'John 3:16 says that God loved the world…',
      engine_version: '2.49.0',
      tool_calls: [{ name: 'fetch_scripture', server_id: 'translation-helps', started_at: 1750000000000, duration_ms: 812, ok: true }],
    },
    expected: JSON.stringify({
      event: 'chat_turn',
      request_id: 'req-790',
      timestamp: FIXED_MS,
      turn_id: 'turn-txt',
      user_id: 'whatsapp:15551234567',
      org: 'unfoldingWord',
      client_id: 'whatsapp',
      transport: 'whatsapp',
      chat_type: 'private',
      response_language: 'en',
      user_country: 'US',
      edge_country: 'US',
      mode: null,
      mode_switched_to: null,
      language: null,
      language_source: 'default',
      model: 'claude-sonnet-4-20250514',
      iterations: 1,
      exit_reason: 'done',
      stop_reason: 'end_turn',
      mcp_calls_made: 0,
      input_tokens: 12,
      output_tokens: 34,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      billable_input_tokens: 12,
      duration_ms: 900,
      had_inbound_voice: false,
      had_outbound_voice: false,
      user_message: 'What does John 3:16 mean? My pastor Bob asked.',
      assistant_reply: 'John 3:16 says that God loved the world…',
      engine_version: '2.49.0',
      tool_calls: [
        {
          name: 'fetch_scripture',
          server_id: 'translation-helps',
          started_at: 1750000000000,
          duration_ms: 812,
          ok: true,
        },
      ],
    }),
  },
  {
    label: 'request_timing_summary',
    event: 'request_timing_summary',
    requestId: 'req-456',
    userId: undefined as string | undefined,
    payload: {
      user_id: 'telegram:99',
      org: 'unfoldingWord',
      transport: 'telegram',
      total_ms: 1234,
    },
    expected: JSON.stringify({
      event: 'request_timing_summary',
      request_id: 'req-456',
      timestamp: FIXED_MS,
      user_id: 'telegram:99',
      org: 'unfoldingWord',
      transport: 'telegram',
      total_ms: 1234,
    }),
  },
  {
    // #404 union case: the SAME `chat_turn` record as the case above, plus the
    // two fields #404 adds. #402's fields (turn_id, per-turn LLM facts) are
    // unchanged and stay in place; `input_language` /
    // `input_language_confidence` sit right after `response_language`, so the
    // tail consumer's existing keys keep both their names and their order.
    label: 'chat_turn (with #404 input_language fields)',
    event: 'chat_turn',
    requestId: 'req-turn-1',
    userId: undefined as string | undefined,
    // prettier-ignore
    payload: {
      turn_id: 'turn-def', user_id: 'web:u-42', org: 'unfoldingWord',
      client_id: 'web', transport: 'stream', chat_type: 'private',
      response_language: 'pt', input_language: 'pt', input_language_confidence: 0.87,
      user_country: null, edge_country: 'BR',
      mode: 'dbs-coach', mode_switched_to: null, language: 'portuguese',
      language_source: 'trigger', model: 'claude-sonnet-4-20250514',
      iterations: 3, exit_reason: 'done', stop_reason: 'end_turn', mcp_calls_made: 2,
      input_tokens: 120, output_tokens: 340, cache_creation_input_tokens: 0,
      cache_read_input_tokens: 1500, billable_input_tokens: 270,
      duration_ms: 4200, had_inbound_voice: false, had_outbound_voice: true,
    },
    expected: JSON.stringify({
      event: 'chat_turn',
      request_id: 'req-turn-1',
      timestamp: FIXED_MS,
      turn_id: 'turn-def',
      user_id: 'web:u-42',
      org: 'unfoldingWord',
      client_id: 'web',
      transport: 'stream',
      chat_type: 'private',
      response_language: 'pt',
      input_language: 'pt',
      input_language_confidence: 0.87,
      user_country: null,
      edge_country: 'BR',
      mode: 'dbs-coach',
      mode_switched_to: null,
      language: 'portuguese',
      language_source: 'trigger',
      model: 'claude-sonnet-4-20250514',
      iterations: 3,
      exit_reason: 'done',
      stop_reason: 'end_turn',
      mcp_calls_made: 2,
      input_tokens: 120,
      output_tokens: 340,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 1500,
      billable_input_tokens: 270,
      duration_ms: 4200,
      had_inbound_voice: false,
      had_outbound_voice: true,
    }),
  },
  {
    label: 'do_request_received (two-arg logger form)',
    event: 'do_request_received',
    requestId: 'req-do-1',
    userId: 'telegram:31337' as string | undefined,
    // prettier-ignore
    payload: {
      do_key: 'user:unfoldingWord:telegram:31337', org: 'unfoldingWord',
      path: '/chat', method: 'POST',
    },
    expected: JSON.stringify({
      event: 'do_request_received',
      request_id: 'req-do-1',
      timestamp: FIXED_MS,
      do_key: 'user:unfoldingWord:telegram:31337',
      org: 'unfoldingWord',
      path: '/chat',
      method: 'POST',
      user_id: 'telegram:31337',
    }),
  },
];

describe('golden console output', () => {
  useConsoleFixture();

  it.each(GOLDEN)('emits the exact JSON the tail consumer parses for $label', (c) => {
    const { lines, restore } = captureConsole('log');
    createRequestLogger(c.requestId, c.userId).log(c.event, c.payload);
    restore();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe(c.expected);
  });
});

describe('golden console output — error path', () => {
  useConsoleFixture();

  it('keeps user_id, and carries the bounded error_name', () => {
    const { lines, restore } = captureConsole('error');
    createRequestLogger('req-789').error('request_error', new TypeError('boom'), {
      user_id: 'telegram:42',
      org: 'unfoldingWord',
    });
    restore();

    const parsed = JSON.parse(lines[0] as string) as Record<string, unknown>;
    expect(parsed.user_id).toBe('telegram:42');
    expect(parsed.event).toBe('request_error');
    expect(parsed.error).toBe('boom');
    expect(parsed.error_name).toBe('TypeError');
  });
});

/** A sink as badly behaved as one plausibly could be: reads everything, then tries to
 *  rewrite the identifier in place — exactly the mistake A1 must never make. */
const hostileSink = (_level: unknown, entry: LogEntry) => {
  buildLogAttributes(entry);
  try {
    (entry as Record<string, unknown>).user_id = 'MUTATED';
  } catch {
    /* frozen in some runtimes — the assertion in the test is what matters */
  }
};

describe('the OTLP sink cannot alter the console bytes', () => {
  useConsoleFixture();

  const emit = () => {
    // prettier-ignore
    createRequestLogger('req-abc').log('request_received', {
      user_id: 'whatsapp:15550009999', client_id: 'whatsapp', org: 'unfoldingWord',
      transport: 'whatsapp', chat_type: 'group', chat_id: 'c-1', thread_id: 't-1',
    });
  };

  it('produces byte-identical output with and without a sink registered', () => {
    const withoutSink = captureConsole('log');
    emit();
    withoutSink.restore();

    setLogSink(hostileSink);
    const withSink = captureConsole('log');
    emit();
    withSink.restore();

    expect(withSink.lines[0]).toBe(withoutSink.lines[0]);
    expect(withSink.lines[0]).toContain('"user_id":"whatsapp:15550009999"');
  });
});

describe('the OTLP branch must not mutate the entry', () => {
  it('buildLogAttributes leaves a frozen entry untouched and does not throw', () => {
    const entry = Object.freeze({
      event: 'request_received',
      request_id: 'req-frozen',
      timestamp: FIXED_MS,
      user_id: 'telegram:7',
      client_id: 'telegram',
      total_ms: 10,
    }) as LogEntry;

    const before = JSON.stringify(entry);
    expect(() => buildLogAttributes(entry)).not.toThrow();
    expect(JSON.stringify(entry)).toBe(before);
  });
});

/**
 * CONSUMER CONTRACT — a faithful local stand-in for the field extraction in
 * `../bt-servant-telemetry/apps/web/src/ingest/redact.ts`. That module is a whitelist
 * parser: it reads only these keys off the parsed console JSON and drops everything else.
 * Vendored (not imported) because the two repos do not share a package.
 *
 * Keep in sync with that file. If it gains a field, add it here.
 */
function consumerRedact(rawJson: string) {
  const obj = JSON.parse(rawJson) as Record<string, unknown>;
  const asString = (v: unknown) => (typeof v === 'string' ? v : null);
  const asNumber = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const asBool = (v: unknown) => (typeof v === 'boolean' ? v : null);

  const clientId = asString(obj.client_id);
  const userId = asString(obj.user_id);

  return {
    event: asString(obj.event),
    ts: asNumber(obj.timestamp),
    level: asString(obj.level),
    org: asString(obj.org),
    // The real module computes HMAC-SHA-256(salt, `${clientId}:${userId}`) here. What
    // matters for this contract is that BOTH inputs are present and unchanged.
    hash_inputs: clientId && userId ? `${clientId}:${userId}` : null,
    client_id: clientId,
    request_id: asString(obj.request_id),
    total_ms: asNumber(obj.total_ms),
    duration_ms: asNumber(obj.duration_ms),
    chat_type: asString(obj.chat_type),
    transport: asString(obj.transport),
    tool_name: asString(obj.tool_name),
    server_id: asString(obj.server_id),
    first_interaction: asBool(obj.first_interaction),
  };
}

describe('consumer contract — all 14 CleanEvent fields survive', () => {
  useConsoleFixture();

  it('extracts every field the consumer reads', () => {
    const { lines, restore } = captureConsole('log');
    // prettier-ignore
    createRequestLogger('req-contract').log('tool_execution_complete', {
      user_id: 'whatsapp:15551112222', client_id: 'whatsapp', org: 'unfoldingWord',
      transport: 'whatsapp', chat_type: 'private', total_ms: 900, duration_ms: 120,
      tool_name: 'aquifer_search', server_id: 'aquifer', first_interaction: true,
    });
    restore();

    expect(consumerRedact(lines[0] as string)).toEqual({
      event: 'tool_execution_complete',
      ts: FIXED_MS,
      level: null,
      org: 'unfoldingWord',
      hash_inputs: 'whatsapp:whatsapp:15551112222',
      client_id: 'whatsapp',
      request_id: 'req-contract',
      total_ms: 900,
      duration_ms: 120,
      chat_type: 'private',
      transport: 'whatsapp',
      tool_name: 'aquifer_search',
      server_id: 'aquifer',
      first_interaction: true,
    });
  });
});

describe('consumer contract — hash inputs survive an active OTLP sink', () => {
  useConsoleFixture();

  const emit = () =>
    createRequestLogger('req-contract-2').log('request_received', {
      user_id: 'telegram:5150',
      client_id: 'telegram',
      org: 'unfoldingWord',
    });

  it('yields an identical CleanEvent with the sink registered', () => {
    const before = captureConsole('log');
    emit();
    before.restore();

    setLogSink((_level, entry) => void buildLogAttributes(entry));
    const after = captureConsole('log');
    emit();
    after.restore();

    const b = consumerRedact(before.lines[0] as string);
    const a = consumerRedact(after.lines[0] as string);
    expect(a).toEqual(b);
    // The salted HMAC the consumer computes is a pure function of this string. Identical
    // inputs are exactly what guarantees identical hash A on both ingest paths in Phase C.
    expect(a.hash_inputs).toBe('telegram:telegram:5150');
  });
});
