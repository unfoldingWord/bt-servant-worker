/**
 * Types for QuickJS sandboxed code execution
 */

/**
 * Result of code execution in QuickJS sandbox
 */
export interface CodeExecutionResult {
  success: boolean;
  result?: unknown;
  error?: string;
  /** Error code for structured error handling (e.g., 'MCP_CALL_LIMIT_EXCEEDED') */
  errorCode?: string;
  /** Number of MCP calls made before failure (when errorCode is set) */
  callsMade?: number;
  /** Configured MCP call limit (when errorCode is set) */
  callLimit?: number;
  logs: ConsoleLog[];
  duration_ms: number;
}

/**
 * Console log captured from sandbox
 */
export interface ConsoleLog {
  level: 'log' | 'info' | 'warn' | 'error';
  message: string;
  timestamp: number;
}

/**
 * Host function that can be called from within the sandbox
 */
export interface HostFunction {
  name: string;
  fn: (...args: unknown[]) => Promise<unknown>;
}

/** A host call that is about to run, before its result exists. */
export interface HostCallStart {
  name: string;
  args: unknown[];
}

/** Told which host calls a sandbox batch is about to run. Must not reject the batch. */
export type HostCallListener = (calls: readonly HostCallStart[]) => Promise<void> | void;

/**
 * Options for code execution
 */
export interface CodeExecutionOptions {
  timeout_ms: number;
  hostFunctions: HostFunction[];
  /** Maximum number of MCP calls allowed per execution (default: 10) */
  maxMcpCalls?: number;
  /**
   * Called once per batch of host calls, before they run. Parallel calls in
   * one batch are reported together. Failures are logged by the executor and
   * do not fail the sandbox.
   */
  onHostCalls?: HostCallListener;
}
