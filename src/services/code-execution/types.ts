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

/**
 * Options for code execution
 */
export interface CodeExecutionOptions {
  timeout_ms: number;
  hostFunctions: HostFunction[];
}
