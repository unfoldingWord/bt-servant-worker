import { describe, expect, it, vi } from 'vitest';
import { pollUntilDone } from '../../src/services/ptxprint/poll.js';
import { JobStatusResult } from '../../src/services/ptxprint/types.js';
import { createRequestLogger } from '../../src/utils/logger.js';

const logger = createRequestLogger('test-request');

function statusFn(sequence: JobStatusResult[]) {
  let i = 0;
  return vi.fn(async (): Promise<JobStatusResult> => {
    const idx = Math.min(i, sequence.length - 1);
    i++;
    // eslint-disable-next-line security/detect-object-injection -- bounded array index
    return sequence[idx]!;
  });
}

describe('pollUntilDone — terminal states', () => {
  it('returns immediately when the first poll is terminal-succeeded', async () => {
    const fn = statusFn([{ state: 'succeeded', pdf_url: 'https://x/y.pdf' }]);
    const result = await pollUntilDone('job-1', fn, logger, {
      intervalMs: 10,
      timeoutMs: 1000,
    });
    expect(result.outcome).toBe('succeeded');
    expect(result.polls).toBe(1);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(result.lastStatus?.pdf_url).toBe('https://x/y.pdf');
  });

  it('returns failed on terminal failed state', async () => {
    const fn = statusFn([
      {
        state: 'failed',
        failure_mode: 'hard',
        errors: ['xelatex blew up'],
      },
    ]);
    const result = await pollUntilDone('job-2', fn, logger, {
      intervalMs: 10,
      timeoutMs: 1000,
    });
    expect(result.outcome).toBe('failed');
    expect(result.lastStatus?.errors).toEqual(['xelatex blew up']);
  });
});

describe('pollUntilDone — multi-poll and timeout', () => {
  it('polls multiple times before reaching a terminal state', async () => {
    const fn = statusFn([
      { state: 'queued' },
      { state: 'running', progress: { current_phase: 'pass-1' } },
      { state: 'running', progress: { current_phase: 'pass-2' } },
      { state: 'succeeded', pdf_url: 'https://x/y.pdf' },
    ]);
    const result = await pollUntilDone('job-3', fn, logger, {
      intervalMs: 5,
      timeoutMs: 1000,
    });
    expect(result.outcome).toBe('succeeded');
    expect(result.polls).toBe(4);
    expect(fn).toHaveBeenCalledTimes(4);
  });

  it('returns timeout when ceiling reached without terminal state', async () => {
    const fn = statusFn([{ state: 'running' }]);
    const result = await pollUntilDone('job-4', fn, logger, {
      intervalMs: 20,
      timeoutMs: 60,
    });
    expect(result.outcome).toBe('timeout');
    expect(result.state).toBe('running');
    expect(result.polls).toBeGreaterThanOrEqual(1);
  });

  it('rethrows when getJobStatus throws (no silent swallow)', async () => {
    const fn = vi.fn(async () => {
      throw new Error('network down');
    });
    await expect(
      pollUntilDone('job-5', fn, logger, { intervalMs: 5, timeoutMs: 100 })
    ).rejects.toThrow(/network down/);
  });
});
