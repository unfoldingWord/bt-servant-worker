/**
 * Lightweight request timing accumulator.
 * Records named phase durations for end-of-request summary logs.
 */

export interface TimingContext {
  phases: Record<string, number>;
  start: number;
}

export function createTimingContext(): TimingContext {
  return { phases: {}, start: Date.now() };
}

/**
 * Execute `fn` and record its wall-clock duration under `name`.
 */
export async function timePhase<T>(
  ctx: TimingContext,
  name: string,
  fn: () => Promise<T>
): Promise<T> {
  const t0 = Date.now();
  const result = await fn();
  ctx.phases[name] = Date.now() - t0;
  return result;
}
