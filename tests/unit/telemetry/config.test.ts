/* eslint-disable max-lines-per-function */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  isTelemetryEnabled,
  otlpExporterConfig,
  RedactingSpanExporter,
  redactSpan,
  resolveTelemetryConfig,
  TELEMETRY_SERVICE_NAME,
} from '../../../src/services/telemetry/config.js';
import { Env } from '../../../src/config/types.js';
import { trackedResponse } from '../../helpers/tracked-response.js';

// Minimal Env carrying only the fields the telemetry config reads.
function makeEnv(overrides: Partial<Env> = {}): Env {
  return { ENVIRONMENT: 'test', ...overrides } as Env;
}

// The Trigger arg is unused by resolveTelemetryConfig; a placeholder satisfies the type.
const trigger = {} as never;

// The exporter object regardless of TraceConfig union variant.
function exporterObj(config: ReturnType<typeof resolveTelemetryConfig>): {
  url?: unknown;
  export?: unknown;
  shutdown?: unknown;
} {
  if (!('exporter' in config)) throw new Error('expected an exporter-based TraceConfig');
  return config.exporter as { url?: unknown; export?: unknown; shutdown?: unknown };
}

describe('isTelemetryEnabled', () => {
  it('is false when neither endpoint nor token is set', () => {
    expect(isTelemetryEnabled(makeEnv())).toBe(false);
  });

  it('is false when only the endpoint is set', () => {
    expect(isTelemetryEnabled(makeEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: 'https://c.example' }))).toBe(
      false
    );
  });

  it('is false when only the token is set', () => {
    expect(isTelemetryEnabled(makeEnv({ OTEL_COLLECTOR_TOKEN: 'tok' }))).toBe(false);
  });

  it('is true only when both are set', () => {
    expect(
      isTelemetryEnabled(
        makeEnv({
          OTEL_EXPORTER_OTLP_ENDPOINT: 'https://c.example',
          OTEL_COLLECTOR_TOKEN: 'tok',
        })
      )
    ).toBe(true);
  });
});

describe('otlpExporterConfig', () => {
  it('builds the traces URL (trimming a trailing slash) and a Bearer header', () => {
    const cfg = otlpExporterConfig(
      makeEnv({
        OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector.example.com/',
        OTEL_COLLECTOR_TOKEN: 'secret-token',
      })
    );
    expect(cfg.url).toBe('https://collector.example.com/v1/traces');
    expect(cfg.headers?.Authorization).toBe('Bearer secret-token');
  });
});

describe('redactSpan', () => {
  it('reduces url.full to origin and drops url.path/url.query/http.target', () => {
    const span = {
      name: 'fetch POST api.anthropic.com',
      attributes: {
        'url.full': 'https://api.anthropic.com/v1/messages?user=alice&thread=42',
        'url.path': '/v1/messages',
        'url.query': '?user=alice&thread=42',
        'http.target': '/v1/messages?user=alice',
        'server.address': 'api.anthropic.com',
      } as Record<string, unknown>,
    };
    redactSpan(span);
    expect(span.attributes['url.full']).toBe('https://api.anthropic.com');
    expect(span.attributes['url.path']).toBeUndefined();
    expect(span.attributes['url.query']).toBeUndefined();
    expect(span.attributes['http.target']).toBeUndefined();
    // Non-URL attributes and the (host-only) span name are untouched.
    expect(span.attributes['server.address']).toBe('api.anthropic.com');
    expect(span.name).toBe('fetch POST api.anthropic.com');
  });

  it('reduces http.url (cache spans) to origin', () => {
    const span = {
      name: 'Cache default get',
      attributes: {
        'http.url': 'https://bt-servant.example.workers.dev/public/ptxprint/abc?sig=secret',
      } as Record<string, unknown>,
    };
    redactSpan(span);
    expect(span.attributes['http.url']).toBe('https://bt-servant.example.workers.dev');
  });

  it('drops user-derived DO attributes and strips the DO fetch name suffix', () => {
    const span = {
      name: 'Durable Object Fetch user:unfoldingWord:alice',
      attributes: {
        'do.id': 'a1b2c3deadbeef',
        'do.name': 'user:unfoldingWord:alice',
        'do.id.name': 'user:unfoldingWord:alice',
      } as Record<string, unknown>,
    };
    redactSpan(span);
    expect(span.name).toBe('Durable Object Fetch');
    expect(span.attributes['do.id']).toBeUndefined();
    expect(span.attributes['do.name']).toBeUndefined();
    expect(span.attributes['do.id.name']).toBeUndefined();
  });

  it('strips the Durable Object Alarm name suffix', () => {
    const span = { name: 'Durable Object Alarm user:unfoldingWord:bob', attributes: {} };
    redactSpan(span);
    expect(span.name).toBe('Durable Object Alarm');
  });

  it('drops KV org/tenant key attributes (db.statement, db.cf.kv.key) but keeps binding/op', () => {
    const span = {
      name: 'KV ORG_CONFIG get',
      attributes: {
        'db.statement': 'get unfoldingWord',
        'db.cf.kv.key': 'unfoldingWord',
        'db.name': 'ORG_CONFIG',
        'db.operation': 'get',
      } as Record<string, unknown>,
    };
    redactSpan(span);
    expect(span.attributes['db.statement']).toBeUndefined();
    expect(span.attributes['db.cf.kv.key']).toBeUndefined();
    expect(span.attributes['db.name']).toBe('ORG_CONFIG');
    expect(span.attributes['db.operation']).toBe('get');
    expect(span.name).toBe('KV ORG_CONFIG get');
  });

  it('leaves a non-URL url.full value and unrelated span names unchanged', () => {
    const span = {
      name: 'fetch GET api.anthropic.com',
      attributes: { 'url.full': 'not-a-url' } as Record<string, unknown>,
    };
    redactSpan(span);
    expect(span.attributes['url.full']).toBe('not-a-url');
    expect(span.name).toBe('fetch GET api.anthropic.com');
  });

  it('strips exception.message/stacktrace from top-level attributes, keeping exception.type', () => {
    const span = {
      name: 'fetch POST api.anthropic.com',
      attributes: {
        'exception.type': 'MCPError',
        'exception.message': 'remote said: user secret leaked in message',
        'exception.stacktrace': 'MCPError: user secret\n  at handler (mcp.ts:1:1)',
      } as Record<string, unknown>,
    };
    redactSpan(span);
    expect(span.attributes['exception.type']).toBe('MCPError');
    expect(span.attributes['exception.message']).toBeUndefined();
    expect(span.attributes['exception.stacktrace']).toBeUndefined();
  });

  it('strips exception.message/stacktrace from span EVENTS (where recordException writes them)', () => {
    // recordException(err) records an "exception" event, NOT top-level attributes.
    const span = {
      name: 'Durable Object Fetch',
      attributes: {} as Record<string, unknown>,
      events: [
        {
          name: 'exception',
          attributes: {
            'exception.type': 'TypeError',
            'exception.message': 'user chat content that must not egress',
            'exception.stacktrace': 'TypeError: user chat content\n  at do (user-do.ts:1:1)',
          } as Record<string, unknown>,
        },
      ],
    };
    redactSpan(span);
    const eventAttrs = span.events[0]!.attributes;
    expect(eventAttrs['exception.type']).toBe('TypeError');
    expect(eventAttrs['exception.message']).toBeUndefined();
    expect(eventAttrs['exception.stacktrace']).toBeUndefined();
    // Whole-span scan: no exception free-text survives anywhere.
    expect(JSON.stringify(span)).not.toContain('must not egress');
    expect(JSON.stringify(span)).not.toContain('user chat content');
  });

  it('handles spans with no events and events with no attributes without throwing', () => {
    const span = {
      name: 'code_exec',
      attributes: {} as Record<string, unknown>,
      events: [{ name: 'phase_marker' }],
    };
    expect(() => redactSpan(span)).not.toThrow();
  });
});

describe('resolveTelemetryConfig (disabled — guaranteed no-op)', () => {
  const config = resolveTelemetryConfig(makeEnv({ ENVIRONMENT: 'staging' }), trigger);

  it('carries service name, namespace (environment), and version', () => {
    expect(config.service.name).toBe(TELEMETRY_SERVICE_NAME);
    expect(config.service.namespace).toBe('staging');
    expect(typeof config.service.version).toBe('string');
  });

  it('uses a 0% head sampler', () => {
    expect(config.sampling?.headSampler).toEqual({ ratio: 0 });
  });

  it('uses a no-op exporter (no OTLP url, so no network is possible)', () => {
    const exp = exporterObj(config);
    expect(exp.url).toBeUndefined();
    expect(typeof exp.export).toBe('function');
    expect(typeof exp.shutdown).toBe('function');
  });

  it('no-op exporter reports success synchronously without exporting', () => {
    const exp = exporterObj(config) as {
      export: (s: unknown, cb: (r: { code: number }) => void) => void;
    };
    let result: { code: number } | undefined;
    exp.export([], (r) => {
      result = r;
    });
    expect(result).toEqual({ code: 0 });
  });

  it('neither accepts nor propagates trace context', () => {
    expect(config.fetch?.includeTraceContext).toBe(false);
    expect(config.handlers?.fetch?.acceptTraceContext).toBe(false);
  });
});

describe('resolveTelemetryConfig (enabled)', () => {
  const config = resolveTelemetryConfig(
    makeEnv({
      ENVIRONMENT: 'production',
      OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector.example.com/',
      OTEL_COLLECTOR_TOKEN: 'secret-token',
    }),
    trigger
  );

  it('uses a redacting SpanExporter (export + shutdown, not a raw url config)', () => {
    const exp = exporterObj(config);
    expect(typeof exp.export).toBe('function');
    expect(typeof exp.shutdown).toBe('function');
    // url is private on the wrapped OTLPExporter, so it is not visible on the config.
    expect(exp.url).toBeUndefined();
  });

  it('does not override the head sampler (defaults to sampling on)', () => {
    expect(config.sampling?.headSampler).toBeUndefined();
  });

  it('neither accepts nor propagates trace context', () => {
    expect(config.fetch?.includeTraceContext).toBe(false);
    expect(config.handlers?.fetch?.acceptTraceContext).toBe(false);
  });

  it('reports the environment as the service namespace', () => {
    expect(config.service.namespace).toBe('production');
  });
});

/** A finished span the OTLP JSON serializer accepts. */
function exportableSpan(attributes: Record<string, unknown>): Record<string, unknown> {
  return {
    name: 'Durable Object Fetch abc123',
    kind: 1,
    spanContext: () => ({
      traceId: '0af7651916cd43dd8448eb211c80319c',
      spanId: 'b7ad6b7169203331',
      traceFlags: 1,
    }),
    startTime: [1_700_000_000, 0],
    endTime: [1_700_000_001, 0],
    duration: [1, 0],
    ended: true,
    attributes,
    droppedAttributesCount: 0,
    events: [],
    droppedEventsCount: 0,
    links: [],
    droppedLinksCount: 0,
    status: { code: 0 },
    resource: resourceFromAttributes({ 'service.name': TELEMETRY_SERVICE_NAME }),
    instrumentationScope: { name: 'test', version: '1' },
  };
}

function exportSpans(
  exporter: RedactingSpanExporter,
  spans: Record<string, unknown>[]
): Promise<{ code: number }> {
  return new Promise((resolve) => exporter.export(spans, resolve));
}

/** A fetch that never answers and rejects the way native fetch does when its signal aborts. */
function untilAborted(signal: AbortSignal | undefined): Promise<Response> {
  return new Promise<Response>((_resolve, reject) => {
    signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
  });
}

describe('RedactingSpanExporter', () => {
  const config = { url: 'https://c.example/v1/traces', headers: { Authorization: 'Bearer t' } };

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('POSTs redacted OTLP JSON to the traces URL with the configured headers', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response(null, { status: 200 })));
    const exporter = new RedactingSpanExporter(config, fetchMock as unknown as typeof fetch);

    const result = await exportSpans(exporter, [exportableSpan({ user_id: 'u-1', keep: 'yes' })]);

    expect(result.code).toBe(0);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://c.example/v1/traces');
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer t');
    expect(headers['content-type']).toBe('application/json');
    expect(headers['user-agent']).toBe('Cloudflare Worker @microlabs/otel-cf-workers v1.0.0-rc.52');
    expect(init.body).toBeInstanceOf(Uint8Array);
    const body = new TextDecoder().decode(init.body as Uint8Array);
    expect(body).toContain('"keep"');
    expect(body).not.toContain('u-1');
    expect(body).toContain('"Durable Object Fetch"');
  });

  it('keeps the user-agent in step with the installed otel-cf-workers version', async () => {
    const { default: pkg } =
      (await import('../../../node_modules/@microlabs/otel-cf-workers/package.json')) as {
        default: { version: string };
      };
    const fetchMock = vi.fn(() => Promise.resolve(new Response(null, { status: 200 })));
    const exporter = new RedactingSpanExporter(config, fetchMock as unknown as typeof fetch);

    await exportSpans(exporter, [exportableSpan({})]);

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers['user-agent']).toBe(
      `Cloudflare Worker @microlabs/otel-cf-workers v${pkg.version}`
    );
  });

  it('aborts the trace POST after 10 s and reports FAILED', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    let signal: AbortSignal | undefined;
    const hanging = vi.fn((_url: string, init: RequestInit) => {
      signal = init.signal ?? undefined;
      return untilAborted(signal);
    });
    const exporter = new RedactingSpanExporter(config, hanging as unknown as typeof fetch);

    const result = exportSpans(exporter, [exportableSpan({})]);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    expect((await result).code).toBe(1);
    expect(signal?.aborted).toBe(true);
    vi.useRealTimers();
  });

  it('clears the abort timer once the collector answers', async () => {
    vi.useFakeTimers();
    const exporter = new RedactingSpanExporter(config, (() =>
      Promise.resolve(new Response(null, { status: 200 }))) as unknown as typeof fetch);

    expect((await exportSpans(exporter, [exportableSpan({})])).code).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });

  it.each([200, 503])('releases the collector response body (HTTP %i)', async (status) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { response, wasCancelled } = trackedResponse(status);
    const exporter = new RedactingSpanExporter(config, (() =>
      Promise.resolve(response)) as unknown as typeof fetch);

    await exportSpans(exporter, [exportableSpan({})]);

    await vi.waitFor(() => expect(wasCancelled()).toBe(true));
  });

  it('reports FAILED on a non-2xx response or a rejected fetch', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const failing = new RedactingSpanExporter(config, (() =>
      Promise.resolve(new Response(null, { status: 503 }))) as unknown as typeof fetch);
    const offline = new RedactingSpanExporter(config, (() =>
      Promise.reject(new Error('network down'))) as unknown as typeof fetch);

    expect((await exportSpans(failing, [exportableSpan({})])).code).toBe(1);
    expect((await exportSpans(offline, [exportableSpan({})])).code).toBe(1);
  });

  it('calls the fetcher detached from `this` (Workers illegal-invocation guard)', async () => {
    const capturing = vi.fn(() => Promise.resolve(new Response(null, { status: 200 })));
    const exporter = new RedactingSpanExporter(config, capturing as unknown as typeof fetch);

    await exportSpans(exporter, [exportableSpan({})]);

    // `mock.contexts` records the `this` receiver of each call; detached it is undefined.
    expect(capturing).toHaveBeenCalledOnce();
    expect(capturing.mock.contexts[0]).toBeUndefined();
  });
});
