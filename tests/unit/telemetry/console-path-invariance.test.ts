/* eslint-disable max-lines-per-function */
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

describe('console path invariance (bt-servant-telemetry tail contract)', () => {
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

  describe('golden output', () => {
    it('emits the exact JSON shape the tail consumer parses for request_received', () => {
      const { lines, restore } = captureConsole('log');
      const logger = createRequestLogger('req-123');

      // prettier-ignore
      logger.log('request_received', {
        user_id: 'whatsapp:15551234567', client_id: 'whatsapp', org: 'unfoldingWord',
        transport: 'whatsapp', chat_type: 'private', chat_id: 'chat-9', thread_id: 'thread-1',
      });

      restore();
      expect(lines).toHaveLength(1);
      expect(lines[0]).toBe(
        JSON.stringify({
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
        })
      );
    });

    it('emits the exact JSON shape for request_timing_summary', () => {
      const { lines, restore } = captureConsole('log');
      const logger = createRequestLogger('req-456');

      logger.log('request_timing_summary', {
        user_id: 'telegram:99',
        org: 'unfoldingWord',
        transport: 'telegram',
        total_ms: 1234,
      });

      restore();
      expect(lines[0]).toBe(
        JSON.stringify({
          event: 'request_timing_summary',
          request_id: 'req-456',
          timestamp: FIXED_MS,
          user_id: 'telegram:99',
          org: 'unfoldingWord',
          transport: 'telegram',
          total_ms: 1234,
        })
      );
    });

    it('emits user_id from the two-arg createRequestLogger form (do_request_received)', () => {
      // `handleDORequest` (src/index.ts:1841) is the ONE live call site that passes userId
      // as the logger's second argument, so `user_id` is appended by buildLogEntry rather
      // than arriving via the data payload. Different code path, same tail contract — the
      // consumer cannot tell them apart and must not have to.
      const { lines, restore } = captureConsole('log');
      const logger = createRequestLogger('req-do-1', 'telegram:31337');

      logger.log('do_request_received', {
        do_key: 'user:unfoldingWord:telegram:31337',
        org: 'unfoldingWord',
        path: '/chat',
        method: 'POST',
      });

      restore();
      expect(lines[0]).toBe(
        JSON.stringify({
          event: 'do_request_received',
          request_id: 'req-do-1',
          timestamp: FIXED_MS,
          do_key: 'user:unfoldingWord:telegram:31337',
          org: 'unfoldingWord',
          path: '/chat',
          method: 'POST',
          user_id: 'telegram:31337',
        })
      );
    });

    it('keeps user_id on the error path too', () => {
      const { lines, restore } = captureConsole('error');
      const logger = createRequestLogger('req-789');

      logger.error('request_error', new TypeError('boom'), {
        user_id: 'telegram:42',
        org: 'unfoldingWord',
        transport: 'telegram',
      });

      restore();
      const parsed = JSON.parse(lines[0] as string) as Record<string, unknown>;
      expect(parsed.user_id).toBe('telegram:42');
      expect(parsed.event).toBe('request_error');
      expect(parsed.error).toBe('boom');
      expect(parsed.error_name).toBe('TypeError');
    });
  });

  describe('the OTLP sink cannot alter the console bytes', () => {
    it('produces byte-identical console output with and without a sink registered', () => {
      const logEvent = () => {
        const logger = createRequestLogger('req-abc');
        // prettier-ignore
        logger.log('request_received', {
          user_id: 'whatsapp:15550009999', client_id: 'whatsapp', org: 'unfoldingWord',
          transport: 'whatsapp', chat_type: 'group', chat_id: 'c-1', thread_id: 't-1',
        });
      };

      const withoutSink = captureConsole('log');
      logEvent();
      withoutSink.restore();

      // A sink that behaves as badly as a sink plausibly could: it reads everything and
      // (attempts to) rewrite the identifier in place, exactly the mistake A1 must not make.
      setLogSink((_level, entry) => {
        buildLogAttributes(entry);
        try {
          (entry as Record<string, unknown>).user_id = 'MUTATED';
        } catch {
          /* frozen in some runtimes — the assertion below is what matters */
        }
      });

      const withSink = captureConsole('log');
      logEvent();
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
        org: 'unfoldingWord',
        total_ms: 10,
      }) as LogEntry;

      const before = JSON.stringify(entry);
      expect(() => buildLogAttributes(entry)).not.toThrow();
      expect(JSON.stringify(entry)).toBe(before);
    });
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

describe('consumer contract (bt-servant-telemetry redact())', () => {
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

  it('every field the consumer extracts survives our console output', () => {
    const { lines, restore } = captureConsole('log');
    const logger = createRequestLogger('req-contract');

    // prettier-ignore
    logger.log('tool_execution_complete', {
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

  it('the hash inputs are unchanged when the OTLP sink is active', () => {
    const emit = () => {
      const logger = createRequestLogger('req-contract-2');
      logger.log('request_received', {
        user_id: 'telegram:5150',
        client_id: 'telegram',
        org: 'unfoldingWord',
      });
    };

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
