import { describe, it, expect } from 'vitest';
import {
  createHealthTracker,
  recordSuccess,
  recordFailure,
  isServerHealthy,
  getHealthSummary,
  getServerMetrics,
  CONSECUTIVE_FAILURE_THRESHOLD,
} from '../../src/services/mcp/health.js';

describe('createHealthTracker', () => {
  it('creates an empty health tracker', () => {
    const tracker = createHealthTracker();

    expect(tracker.servers.size).toBe(0);
  });
});

describe('recordSuccess', () => {
  it('creates metrics for a new server', () => {
    const tracker = createHealthTracker();
    recordSuccess(tracker, 'server-1', 100);

    const metrics = getServerMetrics(tracker, 'server-1');
    expect(metrics).toBeDefined();
    expect(metrics?.serverId).toBe('server-1');
  });

  it('increments total calls', () => {
    const tracker = createHealthTracker();
    recordSuccess(tracker, 'server-1', 100);
    recordSuccess(tracker, 'server-1', 150);

    const metrics = getServerMetrics(tracker, 'server-1');
    expect(metrics?.totalCalls).toBe(2);
  });

  it('accumulates response time', () => {
    const tracker = createHealthTracker();
    recordSuccess(tracker, 'server-1', 100);
    recordSuccess(tracker, 'server-1', 150);

    const metrics = getServerMetrics(tracker, 'server-1');
    expect(metrics?.totalResponseTimeMs).toBe(250);
  });

  it('resets consecutive failures', () => {
    const tracker = createHealthTracker();
    recordFailure(tracker, 'server-1', new Error('fail'));
    recordFailure(tracker, 'server-1', new Error('fail'));

    let metrics = getServerMetrics(tracker, 'server-1');
    expect(metrics?.consecutiveFailures).toBe(2);

    recordSuccess(tracker, 'server-1', 100);

    metrics = getServerMetrics(tracker, 'server-1');
    expect(metrics?.consecutiveFailures).toBe(0);
  });

  it('updates lastSuccessAt timestamp', () => {
    const tracker = createHealthTracker();
    const before = Date.now();
    recordSuccess(tracker, 'server-1', 100);
    const after = Date.now();

    const metrics = getServerMetrics(tracker, 'server-1');
    expect(metrics?.lastSuccessAt).toBeGreaterThanOrEqual(before);
    expect(metrics?.lastSuccessAt).toBeLessThanOrEqual(after);
  });
});

describe('recordFailure', () => {
  it('creates metrics for a new server', () => {
    const tracker = createHealthTracker();
    recordFailure(tracker, 'server-1', new Error('test error'));

    const metrics = getServerMetrics(tracker, 'server-1');
    expect(metrics).toBeDefined();
  });

  it('increments total calls and failed calls', () => {
    const tracker = createHealthTracker();
    recordFailure(tracker, 'server-1', new Error('fail'));
    recordFailure(tracker, 'server-1', new Error('fail'));

    const metrics = getServerMetrics(tracker, 'server-1');
    expect(metrics?.totalCalls).toBe(2);
    expect(metrics?.failedCalls).toBe(2);
  });

  it('increments consecutive failures', () => {
    const tracker = createHealthTracker();
    recordFailure(tracker, 'server-1', new Error('fail'));
    recordFailure(tracker, 'server-1', new Error('fail'));

    const metrics = getServerMetrics(tracker, 'server-1');
    expect(metrics?.consecutiveFailures).toBe(2);
  });

  it('stores last error message from Error object', () => {
    const tracker = createHealthTracker();
    recordFailure(tracker, 'server-1', new Error('specific error'));

    const metrics = getServerMetrics(tracker, 'server-1');
    expect(metrics?.lastError).toBe('specific error');
  });

  it('stores last error message from string', () => {
    const tracker = createHealthTracker();
    recordFailure(tracker, 'server-1', 'string error');

    const metrics = getServerMetrics(tracker, 'server-1');
    expect(metrics?.lastError).toBe('string error');
  });

  it('updates lastFailureAt timestamp', () => {
    const tracker = createHealthTracker();
    const before = Date.now();
    recordFailure(tracker, 'server-1', new Error('fail'));
    const after = Date.now();

    const metrics = getServerMetrics(tracker, 'server-1');
    expect(metrics?.lastFailureAt).toBeGreaterThanOrEqual(before);
    expect(metrics?.lastFailureAt).toBeLessThanOrEqual(after);
  });
});

describe('isServerHealthy', () => {
  it('returns true for unknown servers', () => {
    const tracker = createHealthTracker();

    expect(isServerHealthy(tracker, 'unknown-server')).toBe(true);
  });

  it('returns true when under failure threshold', () => {
    const tracker = createHealthTracker();
    for (let i = 0; i < CONSECUTIVE_FAILURE_THRESHOLD - 1; i++) {
      recordFailure(tracker, 'server-1', new Error('fail'));
    }

    expect(isServerHealthy(tracker, 'server-1')).toBe(true);
  });

  it('returns false when at failure threshold', () => {
    const tracker = createHealthTracker();
    for (let i = 0; i < CONSECUTIVE_FAILURE_THRESHOLD; i++) {
      recordFailure(tracker, 'server-1', new Error('fail'));
    }

    expect(isServerHealthy(tracker, 'server-1')).toBe(false);
  });

  it('returns true after recovery (success resets consecutive failures)', () => {
    const tracker = createHealthTracker();
    for (let i = 0; i < CONSECUTIVE_FAILURE_THRESHOLD; i++) {
      recordFailure(tracker, 'server-1', new Error('fail'));
    }

    expect(isServerHealthy(tracker, 'server-1')).toBe(false);

    recordSuccess(tracker, 'server-1', 100);

    expect(isServerHealthy(tracker, 'server-1')).toBe(true);
  });
});

describe('getHealthSummary', () => {
  it('returns empty array for no tracked servers', () => {
    const tracker = createHealthTracker();
    const summary = getHealthSummary(tracker);
    expect(summary).toEqual([]);
  });

  it('returns summary for all tracked servers', () => {
    const tracker = createHealthTracker();
    recordSuccess(tracker, 'server-1', 100);
    recordSuccess(tracker, 'server-2', 200);
    const summary = getHealthSummary(tracker);
    expect(summary).toHaveLength(2);
    expect(summary.map((s) => s.serverId).sort()).toEqual(['server-1', 'server-2']);
  });
});

describe('getHealthSummary calculations', () => {
  it('calculates correct failure rate', () => {
    const tracker = createHealthTracker();
    recordSuccess(tracker, 'server-1', 100);
    recordSuccess(tracker, 'server-1', 100);
    recordFailure(tracker, 'server-1', new Error('fail'));
    recordSuccess(tracker, 'server-1', 100);
    const summary = getHealthSummary(tracker);
    const serverSummary = summary.find((s) => s.serverId === 'server-1');
    expect(serverSummary?.failureRate).toBe(0.25);
    expect(serverSummary?.totalCalls).toBe(4);
  });

  it('calculates correct average response time (excluding failures)', () => {
    const tracker = createHealthTracker();
    recordSuccess(tracker, 'server-1', 100);
    recordSuccess(tracker, 'server-1', 200);
    recordFailure(tracker, 'server-1', new Error('fail'));
    const summary = getHealthSummary(tracker);
    const serverSummary = summary.find((s) => s.serverId === 'server-1');
    expect(serverSummary?.averageResponseTimeMs).toBe(150);
  });
});

describe('getHealthSummary health status', () => {
  it('indicates healthy status correctly', () => {
    const tracker = createHealthTracker();
    recordSuccess(tracker, 'server-1', 100);
    for (let i = 0; i < CONSECUTIVE_FAILURE_THRESHOLD; i++) {
      recordFailure(tracker, 'server-2', new Error('fail'));
    }
    const summary = getHealthSummary(tracker);
    const server1 = summary.find((s) => s.serverId === 'server-1');
    const server2 = summary.find((s) => s.serverId === 'server-2');
    expect(server1?.healthy).toBe(true);
    expect(server2?.healthy).toBe(false);
  });

  it('includes last error for unhealthy servers', () => {
    const tracker = createHealthTracker();
    for (let i = 0; i < CONSECUTIVE_FAILURE_THRESHOLD; i++) {
      recordFailure(tracker, 'server-1', new Error('connection refused'));
    }
    const summary = getHealthSummary(tracker);
    const serverSummary = summary.find((s) => s.serverId === 'server-1');
    expect(serverSummary?.lastError).toBe('connection refused');
  });
});

describe('getServerMetrics', () => {
  it('returns undefined for unknown server', () => {
    const tracker = createHealthTracker();

    expect(getServerMetrics(tracker, 'unknown')).toBeUndefined();
  });

  it('returns full metrics for known server', () => {
    const tracker = createHealthTracker();
    recordSuccess(tracker, 'server-1', 100);

    const metrics = getServerMetrics(tracker, 'server-1');

    expect(metrics).toBeDefined();
    expect(metrics?.serverId).toBe('server-1');
    expect(metrics?.totalCalls).toBe(1);
    expect(metrics?.failedCalls).toBe(0);
    expect(metrics?.totalResponseTimeMs).toBe(100);
    expect(metrics?.consecutiveFailures).toBe(0);
  });
});
