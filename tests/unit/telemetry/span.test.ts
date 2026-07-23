import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { trace, SpanStatusCode, type Tracer, type TracerProvider } from '@opentelemetry/api';
import { withSpan, withSpanSync, recordSpanError } from '../../../src/services/telemetry/span.js';

/** A minimal recording Span stub that captures the calls withSpan makes. */
class FakeSpan {
  attributes: Record<string, unknown> = {};
  status: { code: number } | undefined;
  ended = false;
  recordExceptionCalls = 0;
  constructor(public name: string) {}
  setAttribute(key: string, value: unknown): this {
    this.attributes[key] = value;
    return this;
  }
  setAttributes(attrs: Record<string, unknown>): this {
    Object.assign(this.attributes, attrs);
    return this;
  }
  setStatus(status: { code: number }): this {
    this.status = status;
    return this;
  }
  recordException(): void {
    // withSpan must NEVER call this (it would leak exception.message/stacktrace).
    this.recordExceptionCalls += 1;
  }
  end(): void {
    this.ended = true;
  }
}

const spans: FakeSpan[] = [];

/** Install a fake global tracer provider whose startActiveSpan runs fn with a FakeSpan. */
function installFakeTracer(): void {
  const tracer = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    startActiveSpan(name: string, ...rest: any[]): unknown {
      const fn = rest[rest.length - 1] as (span: FakeSpan) => unknown;
      const span = new FakeSpan(name);
      spans.push(span);
      return fn(span);
    },
  } as unknown as Tracer;
  const provider = { getTracer: () => tracer } as unknown as TracerProvider;
  trace.setGlobalTracerProvider(provider);
}

beforeEach(() => {
  spans.length = 0;
  installFakeTracer();
});

afterEach(() => {
  trace.disable();
});

describe('withSpan', () => {
  it('creates a span with the given static name and returns fn result', async () => {
    const result = await withSpan('orchestration', { max_iterations: 10 }, async () => 'done');
    expect(result).toBe('done');
    expect(spans).toHaveLength(1);
    expect(spans[0]?.name).toBe('orchestration');
    expect(spans[0]?.ended).toBe(true);
  });

  it('runs attributes through the fail-closed policy', async () => {
    await withSpan(
      'tool_dispatch',
      { tool_name: 'read_memory', user_message: 'what does John 3:16 mean' },
      async () => undefined
    );
    expect(spans[0]?.attributes.tool_name).toBe('read_memory');
    // Unknown key summarized, never raw content.
    expect(spans[0]?.attributes.user_message).toMatch(/^string\(\d+\)$/);
    expect(spans[0]?.attributes.user_message).not.toContain('John');
  });

  it('records only error_name + error status on throw, never the raw exception, and re-throws', async () => {
    class MCPError extends Error {
      constructor() {
        super('remote said: user secret leaked in message');
        this.name = 'MCPError';
      }
    }
    await expect(
      withSpan('code_exec', {}, async () => {
        throw new MCPError();
      })
    ).rejects.toBeInstanceOf(MCPError);

    const span = spans[0]!;
    expect(span.attributes.error_name).toBe('MCPError');
    expect(span.status).toEqual({ code: SpanStatusCode.ERROR });
    expect(span.recordExceptionCalls).toBe(0); // never leak message/stack
    expect(span.ended).toBe(true);
    // The raw message must not have landed on any attribute.
    expect(JSON.stringify(span.attributes)).not.toContain('secret');
  });

  it('ends the span even when fn throws', async () => {
    await expect(
      withSpan('memory.write', {}, async () => {
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');
    expect(spans[0]?.ended).toBe(true);
  });
});

describe('withSpanSync', () => {
  it('runs a synchronous fn and returns its value', () => {
    const result = withSpanSync('do.enqueue', { max_depth: 5 }, () => 3);
    expect(result).toBe(3);
    expect(spans[0]?.name).toBe('do.enqueue');
    expect(spans[0]?.attributes.max_depth).toBe(5);
    expect(spans[0]?.ended).toBe(true);
  });

  it('records error_name + status and re-throws on a synchronous throw', () => {
    const throwTypeError = (): never => {
      throw new TypeError('nope');
    };
    expect(() => withSpanSync('do.enqueue', {}, throwTypeError)).toThrow('nope');
    expect(spans[0]?.attributes.error_name).toBe('TypeError');
    expect(spans[0]?.status).toEqual({ code: SpanStatusCode.ERROR });
    expect(spans[0]?.ended).toBe(true);
  });
});

describe('recordSpanError', () => {
  it('sets bounded error_name + error status without touching the message', () => {
    const span = new FakeSpan('x');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    recordSpanError(span as any, new RangeError('too big: content here'));
    expect(span.attributes.error_name).toBe('RangeError');
    expect(span.status).toEqual({ code: SpanStatusCode.ERROR });
    expect(JSON.stringify(span.attributes)).not.toContain('content here');
  });

  it('falls back to a generic name for non-Error throws', () => {
    const span = new FakeSpan('x');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    recordSpanError(span as any, 'just a string');
    expect(span.attributes.error_name).toBe('Error');
  });
});
