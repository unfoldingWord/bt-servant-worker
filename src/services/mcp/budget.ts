/**
 * MCP Budget Tracking
 *
 * Tracks cumulative downstream API calls per user request to prevent
 * runaway resource consumption. Each MCP call may trigger multiple
 * downstream API calls (e.g., translation-helps-mcp makes ~12 Door43 calls).
 *
 * When MCP servers return metadata with actual downstream call counts,
 * those are used. Otherwise, a configurable default estimate is applied.
 */

import { MCPResponseMetadata } from './types.js';

/** Default downstream calls estimate when MCP server doesn't report metadata */
export const DEFAULT_DOWNSTREAM_PER_CALL = 12;

/** Default budget limit for downstream API calls per request */
export const DEFAULT_BUDGET_LIMIT = 120;

/**
 * Tracks the budget for downstream API calls within a single user request
 */
export interface MCPCallBudget {
  /** Total estimated downstream calls (used when no metadata available) */
  estimatedDownstreamCalls: number;
  /** Total actual downstream calls (from MCP server metadata) */
  actualDownstreamCalls: number;
  /** Number of MCP tool calls made */
  mcpCallCount: number;
  /** Maximum allowed downstream calls */
  limit: number;
  /** Default estimate per MCP call when metadata unavailable */
  defaultDownstreamPerCall: number;
}

export interface BudgetStatus {
  /** Remaining downstream calls in the budget */
  remaining: number;
  /** Percentage of budget used (0-100+) */
  percentUsed: number;
  /** Warning message if budget is running low (undefined when no warning) */
  warning: string | undefined;
  /** Total downstream calls (actual when available, estimated otherwise) */
  totalDownstreamCalls: number;
  /** Whether budget tracking is using estimates vs actual data */
  usingEstimates: boolean;
}

/**
 * Creates a new budget tracker for a user request
 */
export function createBudget(
  limit: number = DEFAULT_BUDGET_LIMIT,
  defaultPerCall: number = DEFAULT_DOWNSTREAM_PER_CALL
): MCPCallBudget {
  return {
    estimatedDownstreamCalls: 0,
    actualDownstreamCalls: 0,
    mcpCallCount: 0,
    limit,
    defaultDownstreamPerCall: defaultPerCall,
  };
}

/**
 * Records an MCP call and updates the budget
 *
 * @param budget - The budget to update
 * @param metadata - Optional metadata from the MCP server response
 */
export function recordMCPCall(budget: MCPCallBudget, metadata?: MCPResponseMetadata): void {
  budget.mcpCallCount++;

  if (metadata?.downstream_api_calls !== undefined) {
    budget.actualDownstreamCalls += metadata.downstream_api_calls;
  } else {
    budget.estimatedDownstreamCalls += budget.defaultDownstreamPerCall;
  }
}

/**
 * Gets the current budget status
 */
export function getBudgetStatus(budget: MCPCallBudget): BudgetStatus {
  const hasActualData = budget.actualDownstreamCalls > 0;
  const totalDownstreamCalls = budget.actualDownstreamCalls + budget.estimatedDownstreamCalls;
  const remaining = budget.limit - totalDownstreamCalls;
  const percentUsed = (totalDownstreamCalls / budget.limit) * 100;

  let warning: string | undefined;
  if (percentUsed >= 90) {
    warning = `Budget critically low: ${remaining} downstream calls remaining (${percentUsed.toFixed(0)}% used)`;
  } else if (percentUsed >= 75) {
    warning = `Budget warning: ${remaining} downstream calls remaining (${percentUsed.toFixed(0)}% used)`;
  }

  return {
    remaining,
    percentUsed,
    warning,
    totalDownstreamCalls,
    usingEstimates: !hasActualData || budget.estimatedDownstreamCalls > 0,
  };
}

/**
 * Checks if the budget has been exceeded
 */
export function isBudgetExceeded(budget: MCPCallBudget): boolean {
  const totalDownstreamCalls = budget.actualDownstreamCalls + budget.estimatedDownstreamCalls;
  return totalDownstreamCalls >= budget.limit;
}

/**
 * Checks if making another MCP call would exceed the budget.
 * Uses the default estimate to project whether the next call is safe.
 */
export function wouldExceedBudget(budget: MCPCallBudget): boolean {
  const totalDownstreamCalls = budget.actualDownstreamCalls + budget.estimatedDownstreamCalls;
  const projectedTotal = totalDownstreamCalls + budget.defaultDownstreamPerCall;
  return projectedTotal > budget.limit;
}
