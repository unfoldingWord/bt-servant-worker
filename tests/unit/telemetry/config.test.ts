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

// Narrow the TraceConfig union to the exporter variant for assertions.
function exporterOf(config: ReturnType<typeof resolveTelemetryConfig>): {
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

describe('resolveTelemetryConfig (disabled — no-op)', () => {
  const config = resolveTelemetryConfig(makeEnv({ ENVIRONMENT: 'staging' }), trigger);

  it('uses a 0% head sampler so no spans are recorded or exported', () => {
    expect(config.sampling?.headSampler).toEqual({ ratio: 0 });
  });

  it('carries service name, namespace (environment), and version', () => {
    expect(config.service.name).toBe(TELEMETRY_SERVICE_NAME);
    expect(config.service.namespace).toBe('staging');
    expect(typeof config.service.version).toBe('string');
  });

  it('points the exporter at a never-contacted localhost placeholder', () => {
    expect(exporterOf(config).url).toBe('http://localhost:4318/v1/traces');
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
    expect(exporterOf(config).url).toBe('https://collector.example.com/v1/traces');
  });

  it('sends the collector token as a Bearer Authorization header', () => {
    expect(exporterOf(config).headers?.Authorization).toBe('Bearer secret-token');
  });

  it('reports the environment as the service namespace', () => {
    expect(config.service.namespace).toBe('production');
  });
});
