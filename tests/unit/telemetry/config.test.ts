/* eslint-disable max-lines-per-function */
import { describe, it, expect } from 'vitest';
import {
  isTelemetryEnabled,
  otlpExporterConfig,
  redactSpan,
  resolveTelemetryConfig,
  TELEMETRY_SERVICE_NAME,
} from '../../../src/services/telemetry/config.js';
import { Env } from '../../../src/config/types.js';

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
