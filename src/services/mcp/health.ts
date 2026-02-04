/**
 * MCP Server Health Tracking
 *
 * Passively monitors MCP server health during normal tool calls.
 * No extra network overhead - health is inferred from actual call results.
 *
 * Implements a circuit breaker pattern: after N consecutive failures,
 * a server is marked unhealthy and calls are skipped until recovery.
 */

/** Number of consecutive failures before marking a server unhealthy */
export const CONSECUTIVE_FAILURE_THRESHOLD = 3;

/**
 * Health metrics for a single MCP server
 */
export interface ServerHealthMetrics {
  /** Server identifier */
  serverId: string;
  /** Total number of calls made to this server */
  totalCalls: number;
  /** Number of failed calls */
  failedCalls: number;
  /** Total response time in milliseconds (for averaging) */
  totalResponseTimeMs: number;
  /** Current streak of consecutive failures (resets on success) */
  consecutiveFailures: number;
  /** Timestamp of last successful call */
  lastSuccessAt?: number;
  /** Timestamp of last failure */
  lastFailureAt?: number;
  /** Last error message (for debugging) */
  lastError?: string;
}

/**
 * Summary of server health for logging/reporting
 */
export interface ServerHealthSummary {
  serverId: string;
  healthy: boolean;
  totalCalls: number;
  failureRate: number;
  averageResponseTimeMs: number;
  consecutiveFailures: number;
  lastError: string | undefined;
}

/**
 * Health tracker that maintains metrics for all MCP servers
 */
export interface HealthTracker {
  servers: Map<string, ServerHealthMetrics>;
}

/**
 * Creates a new health tracker
 */
export function createHealthTracker(): HealthTracker {
  return {
    servers: new Map(),
  };
}

/**
 * Gets or creates metrics for a server
 */
function getOrCreateMetrics(tracker: HealthTracker, serverId: string): ServerHealthMetrics {
  let metrics = tracker.servers.get(serverId);
  if (!metrics) {
    metrics = {
      serverId,
      totalCalls: 0,
      failedCalls: 0,
      totalResponseTimeMs: 0,
      consecutiveFailures: 0,
    };
    tracker.servers.set(serverId, metrics);
  }
  return metrics;
}

/**
 * Records a successful MCP call
 */
export function recordSuccess(
  tracker: HealthTracker,
  serverId: string,
  responseTimeMs: number
): void {
  const metrics = getOrCreateMetrics(tracker, serverId);
  metrics.totalCalls++;
  metrics.totalResponseTimeMs += responseTimeMs;
  metrics.consecutiveFailures = 0;
  metrics.lastSuccessAt = Date.now();
}

/**
 * Records a failed MCP call
 */
export function recordFailure(
  tracker: HealthTracker,
  serverId: string,
  error: Error | string
): void {
  const metrics = getOrCreateMetrics(tracker, serverId);
  metrics.totalCalls++;
  metrics.failedCalls++;
  metrics.consecutiveFailures++;
  metrics.lastFailureAt = Date.now();
  metrics.lastError = typeof error === 'string' ? error : error.message;
}

/**
 * Checks if a server is considered healthy.
 * A server is unhealthy if it has exceeded the consecutive failure threshold.
 */
export function isServerHealthy(tracker: HealthTracker, serverId: string): boolean {
  const metrics = tracker.servers.get(serverId);
  if (!metrics) {
    return true; // Unknown servers are assumed healthy
  }
  return metrics.consecutiveFailures < CONSECUTIVE_FAILURE_THRESHOLD;
}

/**
 * Gets health summary for all tracked servers
 */
export function getHealthSummary(tracker: HealthTracker): ServerHealthSummary[] {
  const summaries: ServerHealthSummary[] = [];

  for (const metrics of tracker.servers.values()) {
    const failureRate = metrics.totalCalls > 0 ? metrics.failedCalls / metrics.totalCalls : 0;
    const avgResponseTime =
      metrics.totalCalls - metrics.failedCalls > 0
        ? metrics.totalResponseTimeMs / (metrics.totalCalls - metrics.failedCalls)
        : 0;

    summaries.push({
      serverId: metrics.serverId,
      healthy: metrics.consecutiveFailures < CONSECUTIVE_FAILURE_THRESHOLD,
      totalCalls: metrics.totalCalls,
      failureRate,
      averageResponseTimeMs: Math.round(avgResponseTime),
      consecutiveFailures: metrics.consecutiveFailures,
      lastError: metrics.lastError,
    });
  }

  return summaries;
}

/**
 * Gets raw metrics for a specific server (for testing/debugging)
 */
export function getServerMetrics(
  tracker: HealthTracker,
  serverId: string
): ServerHealthMetrics | undefined {
  return tracker.servers.get(serverId);
}
