import { describe, it, expect } from 'vitest';
import { createTimingContext, timePhase } from '../../src/utils/timing.js';

describe('createTimingContext', () => {
  it('returns empty phases and a start timestamp', () => {
    const ctx = createTimingContext();
    expect(ctx.phases).toEqual({});
    expect(ctx.start).toBeLessThanOrEqual(Date.now());
    expect(ctx.start).toBeGreaterThan(Date.now() - 1000);
  });
});

describe('timePhase', () => {
  it('records duration and returns the result', async () => {
    const ctx = createTimingContext();
    const result = await timePhase(ctx, 'test_phase', async () => {
      return 42;
    });

    expect(result).toBe(42);
    expect(ctx.phases['test_phase']).toBeGreaterThanOrEqual(0);
    expect(typeof ctx.phases['test_phase']).toBe('number');
  });

  it('records multiple phases independently', async () => {
    const ctx = createTimingContext();
    await timePhase(ctx, 'phase_a', async () => 'a');
    await timePhase(ctx, 'phase_b', async () => 'b');

    expect(Object.keys(ctx.phases)).toEqual(['phase_a', 'phase_b']);
  });

  it('propagates errors from the wrapped function', async () => {
    const ctx = createTimingContext();

    await expect(
      timePhase(ctx, 'failing', async () => {
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');

    // Duration should still not be recorded on error (fn threw before recording)
    // Actually timePhase records after await, so on error the phase won't be set
    expect(ctx.phases['failing']).toBeUndefined();
  });

  it('overwrites a phase name if called twice with the same name', async () => {
    const ctx = createTimingContext();
    await timePhase(ctx, 'dup', async () => 1);
    await timePhase(ctx, 'dup', async () => 2);

    expect(typeof ctx.phases['dup']).toBe('number');
    expect(Object.keys(ctx.phases).filter((k) => k === 'dup')).toHaveLength(1);
  });
});
