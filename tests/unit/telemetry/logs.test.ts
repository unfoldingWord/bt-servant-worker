/* eslint-disable max-lines-per-function */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  buildLogAttributes,
  redactLogRecord,
  BufferingLogRecordProcessor,
  FetchLogExporter,
  initLogTelemetry,
  flushLogTelemetry,
  resetLogTelemetryForTests,
} from '../../../src/services/telemetry/logs.js';
import type { LogRecordExporter, ReadableLogRecord } from '@opentelemetry/sdk-logs';
import { createRequestLogger } from '../../../src/utils/logger.js';
import { Env } from '../../../src/config/types.js';

function makeEnv(overrides: Partial<Env> = {}): Env {
  return { ENVIRONMENT: 'test', ...overrides } as Env;
}

const ENABLED = makeEnv({
  OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector.example',
  OTEL_COLLECTOR_TOKEN: 'secret-token',
});

/** A ReadableLogRecord stub carrying only the fields under test. */
function record(attributes: Record<string, unknown>): ReadableLogRecord {
  return { attributes } as unknown as ReadableLogRecord;
}

/** A fuller ReadableLogRecord that the OTLP serializer can actually encode. */
function serializableRecord(attributes: Record<string, unknown>): ReadableLogRecord {
  return {
    hrTime: [0, 0],
    hrTimeObserved: [0, 0],
    severityNumber: 9,
    severityText: 'INFO',
    body: 'test_event',
    resource: { attributes: {} },
    instrumentationScope: { name: 'test', version: '1' },
    attributes,
    droppedAttributesCount: 0,
  } as unknown as ReadableLogRecord;
}

/** Decode a serialized OTLP/JSON logs payload back to an object. */
function decodeBody(body: unknown): {
  resourceLogs: Array<{
    scopeLogs: Array<{ logRecords: Array<Record<string, unknown>> }>;
  }>;
} {
  const bytes = body as Uint8Array;
  return JSON.parse(new TextDecoder().decode(bytes));
}

afterEach(() => {
  resetLogTelemetryForTests();
  vi.restoreAllMocks();
});

describe('buildLogAttributes', () => {
  it('omits event and timestamp (they become the record body/timestamp)', () => {
    const attrs = buildLogAttributes({
      event: 'thing_happened',
      request_id: 'r1',
      timestamp: 123,
    });
    expect(attrs).not.toHaveProperty('event');
    expect(attrs).not.toHaveProperty('timestamp');
    expect(attrs.request_id).toBe('r1');
  });

  it('masks values under sensitive keys', () => {
    const attrs = buildLogAttributes({
      event: 'e',
      request_id: 'r1',
      timestamp: 1,
      api_key: 'sk-live-abc',
      auth_token: 'bearer xyz',
    });
    expect(attrs.api_key).toBe('[REDACTED]');
    expect(attrs.auth_token).toBe('[REDACTED]');
  });

  it('keeps identifier attributes (request_id, user_id) for correlation', () => {
    const attrs = buildLogAttributes({
      event: 'e',
      request_id: 'r1',
      timestamp: 1,
      user_id: 'u-42',
      duration_ms: 17,
    });
    expect(attrs.request_id).toBe('r1');
    expect(attrs.user_id).toBe('u-42');
    expect(attrs.duration_ms).toBe(17);
  });

  it('summarizes nested objects to keys+types, never nested raw values', () => {
    const attrs = buildLogAttributes({
      event: 'e',
      request_id: 'r1',
      timestamp: 1,
      details: { book: 'John', note: 'secret user note' },
    });
    expect(typeof attrs.details).toBe('string');
    const parsed = JSON.parse(attrs.details as string);
    // Values are type+size summaries, not the raw strings.
    expect(parsed.book).toBe('string(4)');
    expect(parsed.note).toBe('string(16)');
    expect(attrs.details as string).not.toContain('John');
    expect(attrs.details as string).not.toContain('secret user note');
  });

  it('skips null/undefined values', () => {
    const attrs = buildLogAttributes({
      event: 'e',
      request_id: 'r1',
      timestamp: 1,
      maybe: undefined,
      nope: null,
    });
    expect(attrs).not.toHaveProperty('maybe');
    expect(attrs).not.toHaveProperty('nope');
  });
});

describe('buildLogAttributes — fail-closed content policy', () => {
  it('never egresses free-text values under non-allow-listed string keys', () => {
    const attrs = buildLogAttributes({
      event: 'process_chat_complete',
      request_id: 'r1',
      timestamp: 1,
      response: 'Here is the full translated passage the user asked about...',
      text_preview: 'transcribed user speech snippet',
      user_message: 'what does John 3:16 mean',
      description: 'a free-form description that could carry content',
    });
    // Summarized to length only — the raw content never appears.
    expect(attrs.response).toMatch(/^string\(\d+\)$/);
    expect(attrs.text_preview).toMatch(/^string\(\d+\)$/);
    expect(attrs.user_message).toMatch(/^string\(\d+\)$/);
    expect(attrs.description).toMatch(/^string\(\d+\)$/);
    for (const v of Object.values(attrs)) {
      expect(String(v)).not.toContain('translated passage');
      expect(String(v)).not.toContain('John 3:16');
      expect(String(v)).not.toContain('user speech');
    }
  });

  it('reduces URL values to origin, dropping path and signed query credentials', () => {
    const attrs = buildLogAttributes({
      event: 'webhook_failure',
      request_id: 'r1',
      timestamp: 1,
      url: 'https://hooks.example.com/callback/abc123?sig=SECRETSIGNATURE&token=xyz',
      source_url: 'https://cdn.example.com/private/user-42/audio.ogg?exp=999',
    });
    expect(attrs.url).toBe('https://hooks.example.com');
    expect(attrs.source_url).toBe('https://cdn.example.com');
    expect(String(attrs.url)).not.toContain('SECRETSIGNATURE');
    expect(String(attrs.source_url)).not.toContain('user-42');
  });

  it('passes numbers and booleans through raw (never content)', () => {
    const attrs = buildLogAttributes({
      event: 'e',
      request_id: 'r1',
      timestamp: 1,
      duration_ms: 1420,
      total_response_chars: 58,
      has_voice_audio: true,
    });
    expect(attrs.duration_ms).toBe(1420);
    expect(attrs.total_response_chars).toBe(58);
    expect(attrs.has_voice_audio).toBe(true);
  });

  it('passes allow-listed structural string keys through raw', () => {
    const attrs = buildLogAttributes({
      event: 'e',
      request_id: 'r1',
      timestamp: 1,
      book: 'John',
      language: 'es',
      transport: 'whatsapp',
      error_type: 'timeout',
      voice_audio_key: 'org/user/abc.ogg', // matches the `_key` safe suffix
    });
    expect(attrs.book).toBe('John');
    expect(attrs.language).toBe('es');
    expect(attrs.transport).toBe('whatsapp');
    expect(attrs.error_type).toBe('timeout');
    expect(attrs.voice_audio_key).toBe('org/user/abc.ogg');
  });

  it('truncates an oversized allow-listed string value', () => {
    const big = 'x'.repeat(600);
    const attrs = buildLogAttributes({ event: 'e', request_id: 'r1', timestamp: 1, error: big });
    expect(String(attrs.error)).toContain('[truncated, 600 chars]');
    expect(String(attrs.error).length).toBeLessThan(600);
  });
});

describe('redactLogRecord', () => {
  it('masks sensitive-keyed attributes in place (exporter defense in depth)', () => {
    const r = record({ request_id: 'r1', session_token: 'abc', normal: 'ok' });
    redactLogRecord(r);
    expect(r.attributes.session_token).toBe('[REDACTED]');
    expect(r.attributes.request_id).toBe('r1');
    expect(r.attributes.normal).toBe('ok');
  });

  it('tolerates a record with no attributes', () => {
    expect(() => redactLogRecord({} as unknown as ReadableLogRecord)).not.toThrow();
  });
});

describe('BufferingLogRecordProcessor', () => {
  function stubExporter(): LogRecordExporter & { batches: ReadableLogRecord[][] } {
    const batches: ReadableLogRecord[][] = [];
    return {
      batches,
      export(records, cb) {
        batches.push(records);
        cb({ code: 0 });
      },
      shutdown: vi.fn(() => Promise.resolve()),
    };
  }

  it('buffers records and does not export until flushed', () => {
    const exporter = stubExporter();
    const proc = new BufferingLogRecordProcessor(exporter);
    proc.onEmit(record({ a: 1 }) as never);
    proc.onEmit(record({ a: 2 }) as never);
    expect(exporter.batches).toHaveLength(0);
  });

  it('drains the whole buffer in one export batch and clears it', async () => {
    const exporter = stubExporter();
    const proc = new BufferingLogRecordProcessor(exporter);
    proc.onEmit(record({ a: 1 }) as never);
    proc.onEmit(record({ a: 2 }) as never);
    await proc.forceFlush();
    expect(exporter.batches).toHaveLength(1);
    expect(exporter.batches[0]).toHaveLength(2);
    // Second flush with an empty buffer must not export again.
    await proc.forceFlush();
    expect(exporter.batches).toHaveLength(1);
  });

  it('shutdown flushes then shuts down the exporter', async () => {
    const exporter = stubExporter();
    const proc = new BufferingLogRecordProcessor(exporter);
    proc.onEmit(record({ a: 1 }) as never);
    await proc.shutdown();
    expect(exporter.batches).toHaveLength(1);
    expect(exporter.shutdown).toHaveBeenCalledOnce();
  });
});

describe('FetchLogExporter', () => {
  it('POSTs OTLP JSON to /v1/logs with the bearer token and redacts records', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response(null, { status: 200 })));
    const exporter = new FetchLogExporter(
      'https://collector.example/v1/logs',
      'secret-token',
      fetchMock as unknown as typeof fetch
    );
    const r = serializableRecord({ event_attr: 'hi', secret_value: 'leak' });
    await new Promise<{ code: number }>((resolve) => exporter.export([r], resolve));

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://collector.example/v1/logs');
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer secret-token');
    expect(headers['Content-Type']).toBe('application/json');
    // Redaction ran before serialization.
    expect(r.attributes.secret_value).toBe('[REDACTED]');
  });

  it('reports FAILED (code 1) on a non-2xx response', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response(null, { status: 503 })));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const exporter = new FetchLogExporter(
      'https://c.example/v1/logs',
      't',
      fetchMock as unknown as typeof fetch
    );
    const result = await new Promise<{ code: number }>((resolve) =>
      exporter.export([serializableRecord({ a: 1 })], resolve)
    );
    expect(result.code).toBe(1);
  });

  it('reports FAILED (code 1) when fetch rejects', async () => {
    const fetchMock = vi.fn(() => Promise.reject(new Error('network down')));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const exporter = new FetchLogExporter(
      'https://c.example/v1/logs',
      't',
      fetchMock as unknown as typeof fetch
    );
    const result = await new Promise<{ code: number }>((resolve) =>
      exporter.export([serializableRecord({ a: 1 })], resolve)
    );
    expect(result.code).toBe(1);
  });
});

describe('telemetry logs wiring (init → emit → flush)', () => {
  beforeEach(() => resetLogTelemetryForTests());

  it('is a no-op when telemetry is disabled: no sink, no export', () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response(null, { status: 200 })));
    initLogTelemetry(makeEnv(), { fetchFn: fetchMock as unknown as typeof fetch });

    createRequestLogger('r1', 'u1').info('should_not_export', { foo: 'bar' });

    let flushInvoked = false;
    flushLogTelemetry(() => {
      flushInvoked = true;
    });
    expect(flushInvoked).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('when enabled, a logger.info call is exported as an OTLP log record', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response(null, { status: 200 })));
    initLogTelemetry(ENABLED, { fetchFn: fetchMock as unknown as typeof fetch });

    createRequestLogger('req-1', 'user-1').info('user_message_received', {
      transport: 'whatsapp',
      access_token: 'should-be-masked',
    });

    let flushPromise: Promise<unknown> | undefined;
    flushLogTelemetry((p) => {
      flushPromise = p;
    });
    await flushPromise;

    expect(fetchMock).toHaveBeenCalledOnce();
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const payload = decodeBody(init.body);
    const logRecords = payload.resourceLogs[0].scopeLogs[0].logRecords;
    expect(logRecords).toHaveLength(1);
    const rec = logRecords[0];
    // Body is the event name; severity is INFO.
    expect(rec.body).toEqual({ stringValue: 'user_message_received' });
    expect(rec.severityText).toBe('INFO');
    // Attributes carry correlation ids; the sensitive key is masked.
    const attrMap = Object.fromEntries(
      (rec.attributes as Array<{ key: string; value: Record<string, unknown> }>).map((a) => [
        a.key,
        a.value,
      ])
    );
    expect(attrMap.request_id).toEqual({ stringValue: 'req-1' });
    expect(attrMap.user_id).toEqual({ stringValue: 'user-1' });
    expect(attrMap.access_token).toEqual({ stringValue: '[REDACTED]' });
  });

  it('maps warn and error levels to OTLP severities', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response(null, { status: 200 })));
    initLogTelemetry(ENABLED, { fetchFn: fetchMock as unknown as typeof fetch });

    const logger = createRequestLogger('req-2');
    logger.warn('slow_thing');
    logger.error('boom', new Error('kaboom'));

    let flushPromise: Promise<unknown> | undefined;
    flushLogTelemetry((p) => {
      flushPromise = p;
    });
    await flushPromise;

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const payload = decodeBody(init.body);
    const severities = payload.resourceLogs[0].scopeLogs[0].logRecords.map((r) => r.severityText);
    expect(severities).toContain('WARN');
    expect(severities).toContain('ERROR');
  });
});
