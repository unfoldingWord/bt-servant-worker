import { describe, it, expect } from 'vitest';
import {
  isTelemetryEnabled,
  resolveTelemetryConfig,
  TELEMETRY_SERVICE_NAME,
} from '../../../src/services/telemetry/index.js';
import { Env } from '../../../src/config/types.js';

// Minimal Env carrying only the fields the telemetry config reads.
function makeEnv(overrides: Partial<Env> = {}): Env {
  return { ENVIRONMENT: 'test', ...overrides } as Env;
}

// The Trigger arg is unused by resolveTelemetryConfig; a placeholder satisfies the type.
const trigger = {} as never;

// Narrow the TraceConfig union to the OTLP exporter variant for assertions.
function otlpExporterOf(config: ReturnType<typeof resolveTelemetryConfig>): {
  url: string;
  headers?: Record<string, string>;
} {
  if (!('exporter' in config)) throw new Error('expected an exporter-based TraceConfig');
  return config.exporter as { url: string; headers?: Record<string, string> };
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
    const exp = ('exporter' in config ? config.exporter : undefined) as
      | { url?: string; export?: unknown; shutdown?: unknown }
      | undefined;
    expect(exp).toBeDefined();
    expect(exp?.url).toBeUndefined();
    expect(typeof exp?.export).toBe('function');
    expect(typeof exp?.shutdown).toBe('function');
  });

  it('no-op exporter reports success synchronously without exporting', () => {
    const exp = (
      config as {
        exporter: { export: (s: unknown, cb: (r: { code: number }) => void) => void };
      }
    ).exporter;
    let result: { code: number } | undefined;
    exp.export([], (r) => {
      result = r;
    });
    expect(result).toEqual({ code: 0 });
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

  it('does not override the head sampler (defaults to sampling on)', () => {
    expect(config.sampling?.headSampler).toBeUndefined();
  });

  it('builds the OTLP traces URL, trimming a trailing slash', () => {
    expect(otlpExporterOf(config).url).toBe('https://collector.example.com/v1/traces');
  });

  it('sends the collector token as a Bearer Authorization header', () => {
    expect(otlpExporterOf(config).headers?.Authorization).toBe('Bearer secret-token');
  });

  it('reports the environment as the service namespace', () => {
    expect(config.service.namespace).toBe('production');
  });
});

describe('span redaction (postProcessor)', () => {
  // Redaction runs in both states; use the enabled config so it is the real export path.
  const config = resolveTelemetryConfig(
    makeEnv({
      OTEL_EXPORTER_OTLP_ENDPOINT: 'https://c.example',
      OTEL_COLLECTOR_TOKEN: 'tok',
    }),
    trigger
  );
  const postProcessor = config.postProcessor;

  it('is configured', () => {
    expect(typeof postProcessor).toBe('function');
  });

  it('reduces url.full to scheme://host and drops url.path + url.query', () => {
    const span = {
      attributes: {
        'url.full': 'https://api.anthropic.com/v1/messages?user=alice&thread=42',
        'url.path': '/v1/messages',
        'url.query': '?user=alice&thread=42',
        'server.address': 'api.anthropic.com',
        'http.request.method': 'POST',
      } as Record<string, unknown>,
    };
    postProcessor!([span] as never);
    expect(span.attributes['url.full']).toBe('https://api.anthropic.com');
    expect(span.attributes['url.path']).toBeUndefined();
    expect(span.attributes['url.query']).toBeUndefined();
    // Non-URL attributes are untouched.
    expect(span.attributes['server.address']).toBe('api.anthropic.com');
    expect(span.attributes['http.request.method']).toBe('POST');
  });

  it('reduces http.url (cache spans) to origin and drops http.target', () => {
    const span = {
      attributes: {
        'http.url': 'https://bt-servant.example.workers.dev/public/ptxprint/abc123?sig=secret',
        'http.target': '/public/ptxprint/abc123?sig=secret',
      } as Record<string, unknown>,
    };
    postProcessor!([span] as never);
    expect(span.attributes['http.url']).toBe('https://bt-servant.example.workers.dev');
    expect(span.attributes['http.target']).toBeUndefined();
  });

  it('leaves a non-URL url.full value unchanged rather than blanking it', () => {
    const span = { attributes: { 'url.full': 'not-a-url' } as Record<string, unknown> };
    postProcessor!([span] as never);
    expect(span.attributes['url.full']).toBe('not-a-url');
  });
});
