import { describe, it, expect } from 'vitest';
import {
  createBudget,
  recordMCPCall,
  getBudgetStatus,
  isBudgetExceeded,
  wouldExceedBudget,
  DEFAULT_BUDGET_LIMIT,
  DEFAULT_DOWNSTREAM_PER_CALL,
} from '../../src/services/mcp/budget.js';
import type { MCPResponseMetadata } from '../../src/services/mcp/types.js';

describe('createBudget', () => {
  it('creates a budget with default values', () => {
    const budget = createBudget();

    expect(budget.estimatedDownstreamCalls).toBe(0);
    expect(budget.actualDownstreamCalls).toBe(0);
    expect(budget.mcpCallCount).toBe(0);
    expect(budget.limit).toBe(DEFAULT_BUDGET_LIMIT);
    expect(budget.defaultDownstreamPerCall).toBe(DEFAULT_DOWNSTREAM_PER_CALL);
  });

  it('creates a budget with custom values', () => {
    const budget = createBudget(200, 15);

    expect(budget.limit).toBe(200);
    expect(budget.defaultDownstreamPerCall).toBe(15);
  });
});

describe('recordMCPCall', () => {
  it('increments mcp call count', () => {
    const budget = createBudget();
    recordMCPCall(budget);

    expect(budget.mcpCallCount).toBe(1);
  });

  it('uses default estimate when no metadata provided', () => {
    const budget = createBudget(100, 10);
    recordMCPCall(budget);

    expect(budget.estimatedDownstreamCalls).toBe(10);
    expect(budget.actualDownstreamCalls).toBe(0);
  });

  it('uses actual count from metadata when provided', () => {
    const budget = createBudget(100, 10);
    const metadata: MCPResponseMetadata = { downstream_api_calls: 5 };
    recordMCPCall(budget, metadata);

    expect(budget.estimatedDownstreamCalls).toBe(0);
    expect(budget.actualDownstreamCalls).toBe(5);
  });

  it('accumulates calls over multiple invocations', () => {
    const budget = createBudget(100, 10);

    recordMCPCall(budget); // estimated: 10
    recordMCPCall(budget, { downstream_api_calls: 3 }); // actual: 3
    recordMCPCall(budget); // estimated: 10

    expect(budget.mcpCallCount).toBe(3);
    expect(budget.estimatedDownstreamCalls).toBe(20);
    expect(budget.actualDownstreamCalls).toBe(3);
  });
});

describe('getBudgetStatus', () => {
  it('returns correct remaining calls', () => {
    const budget = createBudget(100, 10);
    recordMCPCall(budget); // 10 estimated

    const status = getBudgetStatus(budget);

    expect(status.remaining).toBe(90);
    expect(status.totalDownstreamCalls).toBe(10);
  });

  it('calculates correct percent used', () => {
    const budget = createBudget(100, 25);
    recordMCPCall(budget); // 25 estimated = 25%

    const status = getBudgetStatus(budget);

    expect(status.percentUsed).toBe(25);
  });

  it('returns warning at 75% usage', () => {
    const budget = createBudget(100, 76);
    recordMCPCall(budget);

    const status = getBudgetStatus(budget);

    expect(status.warning).toContain('Budget warning');
  });

  it('returns critical warning at 90% usage', () => {
    const budget = createBudget(100, 91);
    recordMCPCall(budget);

    const status = getBudgetStatus(budget);

    expect(status.warning).toContain('critically low');
  });

  it('indicates when using estimates', () => {
    const budget = createBudget(100, 10);
    recordMCPCall(budget);

    const status = getBudgetStatus(budget);

    expect(status.usingEstimates).toBe(true);
  });

  it('indicates when using actual data only', () => {
    const budget = createBudget(100, 10);
    recordMCPCall(budget, { downstream_api_calls: 5 });

    const status = getBudgetStatus(budget);

    expect(status.usingEstimates).toBe(false);
  });

  it('indicates mixed estimates when using both', () => {
    const budget = createBudget(100, 10);
    recordMCPCall(budget, { downstream_api_calls: 5 });
    recordMCPCall(budget); // No metadata = estimate

    const status = getBudgetStatus(budget);

    expect(status.usingEstimates).toBe(true);
  });
});

describe('isBudgetExceeded', () => {
  it('returns false when under limit', () => {
    const budget = createBudget(100, 10);
    recordMCPCall(budget);

    expect(isBudgetExceeded(budget)).toBe(false);
  });

  it('returns true when at limit', () => {
    const budget = createBudget(100, 100);
    recordMCPCall(budget);

    expect(isBudgetExceeded(budget)).toBe(true);
  });

  it('returns true when over limit', () => {
    const budget = createBudget(100, 60);
    recordMCPCall(budget);
    recordMCPCall(budget);

    expect(isBudgetExceeded(budget)).toBe(true);
  });

  it('combines actual and estimated calls', () => {
    const budget = createBudget(100, 30);
    recordMCPCall(budget, { downstream_api_calls: 50 });
    recordMCPCall(budget, { downstream_api_calls: 50 });

    expect(isBudgetExceeded(budget)).toBe(true);
  });
});

describe('wouldExceedBudget', () => {
  it('returns false when next call would be under limit', () => {
    const budget = createBudget(100, 10);
    recordMCPCall(budget); // 10 estimated, 90 remaining

    expect(wouldExceedBudget(budget)).toBe(false); // 10 + 10 = 20, under 100
  });

  it('returns true when next call would exceed limit', () => {
    const budget = createBudget(100, 10);
    for (let i = 0; i < 9; i++) {
      recordMCPCall(budget);
    }
    // Now at 90 estimated, next call would be 100 which equals limit

    expect(wouldExceedBudget(budget)).toBe(false); // 90 + 10 = 100, equals limit

    recordMCPCall(budget); // Now at 100
    expect(wouldExceedBudget(budget)).toBe(true); // 100 + 10 = 110, over limit
  });

  it('uses default estimate for projection', () => {
    const budget = createBudget(100, 50);
    recordMCPCall(budget, { downstream_api_calls: 40 }); // 40 actual

    // 40 + 50 (default) = 90, under limit
    expect(wouldExceedBudget(budget)).toBe(false);

    recordMCPCall(budget, { downstream_api_calls: 20 }); // 60 actual

    // 60 + 50 (default) = 110, over limit
    expect(wouldExceedBudget(budget)).toBe(true);
  });
});
