/**
 * QuickJS Sandbox Executor
 *
 * Runs JavaScript code in a WASM-based QuickJS sandbox with:
 * - Injected host functions for MCP tool calls
 * - Console capture
 * - Timeout enforcement
 * - No access to Worker APIs, fetch, or environment
 */

import { getQuickJSWASMModule, QuickJSContext } from '@cf-wasm/quickjs/workerd';
import { CodeExecutionError, MCPCallLimitError, TimeoutError } from '../../utils/errors.js';
import { RequestLogger } from '../../utils/logger.js';
import { CodeExecutionOptions, CodeExecutionResult, ConsoleLog, HostFunction } from './types.js';

/**
 * Number of VM cycles between timeout checks.
 *
 * Trade-off between performance and timeout responsiveness:
 * - Lower values: More responsive timeouts, but higher overhead from Date.now() calls
 * - Higher values: Better performance, but timeout may overshoot by more cycles
 *
 * 10,000 cycles provides a good balance:
 * - Checks approximately every 1-5ms on typical hardware
 * - Responsive enough for the 30-second default timeout
 * - Minimal performance overhead (<1% of execution time)
 */
const INTERRUPT_CHECK_CYCLES = 10000;

/** Default maximum number of MCP calls per code execution */
const DEFAULT_MAX_MCP_CALLS = 10;

/** Threshold (as decimal) at which to warn about approaching MCP call limit */
const MCP_CALL_WARNING_THRESHOLD = 0.8;

/**
 * Counter for tracking MCP calls during code execution
 */
interface MCPCallCounter {
  count: number;
  limit: number;
}

// Note: Don't cache the module - it causes assertion failures on context disposal
// in Cloudflare Workers. Creating a fresh module per execution is safer.
async function getQuickJSModule() {
  return await getQuickJSWASMModule();
}

function setupConsole(vm: QuickJSContext, logs: ConsoleLog[]): void {
  const consoleHandle = vm.newObject();
  const logLevels = ['log', 'info', 'warn', 'error'] as const;

  for (const level of logLevels) {
    const fnHandle = vm.newFunction(level, (...args) => {
      const message = args
        .map((arg) => {
          const val = vm.dump(arg);
          return typeof val === 'string' ? val : JSON.stringify(val);
        })
        .join(' ');
      logs.push({ level, message, timestamp: Date.now() });
    });
    vm.setProp(consoleHandle, level, fnHandle);
    fnHandle.dispose();
  }

  vm.setProp(vm.global, 'console', consoleHandle);
  consoleHandle.dispose();
}

interface PendingCall {
  id: number;
  fn: HostFunction;
  args: unknown[];
}

/**
 * Safely set a result value in the VM's __pendingResults__ object.
 *
 * Uses double JSON encoding to prevent code injection:
 * 1. JSON.stringify converts the value to a JSON string
 * 2. JSON.stringify again escapes that string for safe interpolation
 * 3. JSON.parse in the VM reconstructs the original value
 *
 * This eliminates the risk of special characters breaking out of the value context.
 *
 * @throws {Error} If the value cannot be serialized or set in the VM
 */
function setVMResult(vm: QuickJSContext, id: number, value: unknown): void {
  let jsonValue: string;
  try {
    jsonValue = JSON.stringify(value);
  } catch (e) {
    throw new Error(
      `Failed to serialize value for VM: ${e instanceof Error ? e.message : String(e)}`
    );
  }

  const safeStringLiteral = JSON.stringify(jsonValue);
  const result = vm.evalCode(`__pendingResults__[${id}] = JSON.parse(${safeStringLiteral});`);
  // Must dispose the result handle to prevent GC assertion failure
  if (result.error) {
    const errorValue = vm.dump(result.error);
    result.error.dispose();
    throw new Error(`Failed to set VM result: ${formatErrorValue(errorValue)}`);
  }
  result.value.dispose();
}

function registerHostFunction(
  vm: QuickJSContext,
  hostFn: HostFunction,
  pendingCalls: PendingCall[],
  callIdRef: { id: number }
): void {
  const fnHandle = vm.newFunction(hostFn.name, (...args) => {
    const id = callIdRef.id++;
    const dumpedArgs = args.map((arg) => vm.dump(arg));

    // Create a QuickJS Promise that user code can await
    // Store the resolver in __resolvers__[id] so we can resolve it later
    const promiseResult = vm.evalCode(
      `new Promise((resolve, reject) => { __resolvers__[${id}] = { resolve, reject }; })`
    );

    if (promiseResult.error) {
      promiseResult.error.dispose();
      throw new Error('Failed to create promise in sandbox');
    }

    const promiseHandle = promiseResult.value;

    // Queue the async call for later execution (resolver called in processPendingCalls)
    pendingCalls.push({ id, fn: hostFn, args: dumpedArgs });

    // Return the QuickJS promise handle (user code can await this)
    return promiseHandle;
  });

  vm.setProp(vm.global, hostFn.name, fnHandle);
  fnHandle.dispose();
}

function setupHostFunctions(vm: QuickJSContext, hostFunctions: HostFunction[]): PendingCall[] {
  const pendingCalls: PendingCall[] = [];
  const callIdRef = { id: 0 };

  // Initialize global variables for async coordination:
  // - __pendingResults__: Stores results from host function calls
  // - __resolvers__: Stores { resolve, reject } objects for promises returned by host functions
  // - __result__: Final return value set by user code
  // - __executionError__: Captures errors from the async IIFE wrapper's .catch() handler
  const initResult = vm.evalCode(
    'var __pendingResults__ = {}; var __resolvers__ = {}; var __result__ = undefined; var __executionError__ = undefined;'
  );
  // Must dispose the result handle to prevent GC assertion failure
  if (initResult.error) {
    initResult.error.dispose();
  } else {
    initResult.value.dispose();
  }

  for (const hostFn of hostFunctions) {
    registerHostFunction(vm, hostFn, pendingCalls, callIdRef);
  }

  return pendingCalls;
}

function resolvePendingCall(vm: QuickJSContext, callId: number, result: unknown): void {
  setVMResult(vm, callId, result);
  const resolveCode = `__resolvers__[${callId}].resolve(__pendingResults__[${callId}]);`;
  const resolveResult = vm.evalCode(resolveCode);
  if (resolveResult.error) {
    resolveResult.error.dispose();
  } else {
    resolveResult.value.dispose();
  }
}

function rejectPendingCall(vm: QuickJSContext, callId: number, error: unknown): void {
  let msg = error instanceof Error ? error.message : String(error);
  try {
    setVMResult(vm, callId, { __error__: msg });
  } catch {
    msg = 'Error: Result serialization failed';
  }
  const rejectCode = `__resolvers__[${callId}].reject(new Error(${JSON.stringify(msg)}));`;
  const rejectResult = vm.evalCode(rejectCode);
  if (rejectResult.error) {
    rejectResult.error.dispose();
  } else {
    rejectResult.value.dispose();
  }
}

/**
 * Log MCP call execution and warn when approaching the limit.
 * Call numbers are 1-indexed for human readability (call_number: 1 = first call).
 */
function logMcpCall(logger: RequestLogger, mcpCounter: MCPCallCounter, toolName: string): void {
  logger.log('mcp_call_executed', {
    tool_name: toolName,
    call_number: mcpCounter.count,
    limit: mcpCounter.limit,
  });
  const warningThreshold = mcpCounter.limit * MCP_CALL_WARNING_THRESHOLD;
  if (mcpCounter.count >= warningThreshold && mcpCounter.count < mcpCounter.limit) {
    logger.warn('mcp_call_limit_warning', {
      calls_made: mcpCounter.count,
      limit: mcpCounter.limit,
      remaining: mcpCounter.limit - mcpCounter.count,
    });
  }
}

/**
 * Execute a single pending MCP call, tracking it in the counter and resolving/rejecting the VM promise.
 */
async function executePendingCall(
  vm: QuickJSContext,
  call: PendingCall,
  mcpCounter: MCPCallCounter,
  logger: RequestLogger
): Promise<void> {
  mcpCounter.count++;
  logMcpCall(logger, mcpCounter, call.fn.name);
  try {
    const result = await call.fn.fn(...call.args);
    resolvePendingCall(vm, call.id, result);
  } catch (error) {
    rejectPendingCall(vm, call.id, error);
  }
}

/**
 * Process all pending MCP calls in batches until no more remain.
 * @throws {MCPCallLimitError} If a batch would exceed the configured limit
 */
async function processPendingCalls(
  vm: QuickJSContext,
  pendingCalls: PendingCall[],
  mcpCounter: MCPCallCounter,
  logger: RequestLogger
): Promise<void> {
  do {
    if (pendingCalls.length > 0) {
      const batch = pendingCalls.splice(0, pendingCalls.length);
      if (mcpCounter.count + batch.length > mcpCounter.limit) {
        logger.warn('mcp_call_limit_exceeded', {
          calls_made: mcpCounter.count,
          calls_attempted: mcpCounter.count + batch.length,
          limit: mcpCounter.limit,
        });
        throw new MCPCallLimitError(mcpCounter.count, mcpCounter.limit);
      }
      await Promise.all(batch.map((call) => executePendingCall(vm, call, mcpCounter, logger)));
    }
    vm.runtime.executePendingJobs();
  } while (pendingCalls.length > 0);
}

function createInterruptHandler(startTime: number, timeoutMs: number) {
  let interrupted = false;
  let cycleCount = 0;

  const handler = () => {
    cycleCount++;
    if (cycleCount % INTERRUPT_CHECK_CYCLES === 0 && Date.now() - startTime > timeoutMs) {
      interrupted = true;
      return true;
    }
    return false;
  };

  return { handler, isInterrupted: () => interrupted };
}

function formatErrorValue(errorValue: unknown): string {
  if (typeof errorValue === 'string') {
    return errorValue;
  }
  if (errorValue && typeof errorValue === 'object') {
    const err = errorValue as Record<string, unknown>;
    // QuickJS errors typically have message and stack properties
    if (err.message) {
      return err.stack ? `${err.message}\n${err.stack}` : String(err.message);
    }
    // Handle circular references, functions, symbols, etc.
    try {
      return JSON.stringify(errorValue);
    } catch {
      return String(errorValue);
    }
  }
  return String(errorValue);
}

function evaluateUserCode(vm: QuickJSContext, code: string): void {
  // Wrap in async IIFE with .catch() to capture rejected promises.
  // Without this, thrown errors would silently fail (success: true, result: undefined).
  // The .catch() stores the error in __executionError__ for later extraction.
  const wrappedCode = `(async () => { ${code} })().catch(e => { __executionError__ = e instanceof Error ? e.message : String(e); });`;
  const result = vm.evalCode(wrappedCode, 'user-code.js');
  // Must dispose the result handle to prevent GC assertion failure
  if (result.error) {
    const errorValue = vm.dump(result.error);
    result.error.dispose();
    throw new CodeExecutionError(formatErrorValue(errorValue));
  }
  result.value.dispose();
}

function checkExecutionError(vm: QuickJSContext): void {
  const errorResult = vm.evalCode('__executionError__', 'get-error.js');

  if (errorResult.error) {
    errorResult.error.dispose();
    return; // Can't read error state, assume no error
  }

  const errorValue = vm.dump(errorResult.value);
  errorResult.value.dispose();

  if (errorValue !== undefined) {
    throw new CodeExecutionError(formatErrorValue(errorValue));
  }
}

function extractResult(vm: QuickJSContext): unknown {
  const finalResult = vm.evalCode('__result__', 'get-result.js');

  if (finalResult.error) {
    const errorValue = vm.dump(finalResult.error);
    finalResult.error.dispose();
    throw new CodeExecutionError(formatErrorValue(errorValue));
  }

  const value = vm.dump(finalResult.value);
  finalResult.value.dispose();
  return value;
}

function buildSuccessResult(
  value: unknown,
  logs: ConsoleLog[],
  startTime: number,
  mcpCounter: MCPCallCounter
): CodeExecutionResult {
  const result: CodeExecutionResult = {
    success: true,
    result: value,
    logs,
    duration_ms: Date.now() - startTime,
  };
  // Only include call info when MCP calls were made
  if (mcpCounter.count > 0) {
    result.callsMade = mcpCounter.count;
    result.callLimit = mcpCounter.limit;
  }
  return result;
}

function buildErrorResult(
  error: unknown,
  logs: ConsoleLog[],
  startTime: number,
  mcpCounter?: MCPCallCounter
): CodeExecutionResult {
  const errorMessage = error instanceof Error ? error.message : 'Unknown error';

  // Handle MCPCallLimitError specially with structured error info
  if (error instanceof MCPCallLimitError) {
    return {
      success: false,
      error: errorMessage,
      errorCode: 'MCP_CALL_LIMIT_EXCEEDED',
      callsMade: error.callsMade,
      callLimit: error.limit,
      logs,
      duration_ms: Date.now() - startTime,
    };
  }

  return {
    success: false,
    error: errorMessage,
    logs,
    duration_ms: Date.now() - startTime,
    ...(mcpCounter && { callsMade: mcpCounter.count, callLimit: mcpCounter.limit }),
  };
}

function logExecutionError(
  logger: RequestLogger,
  error: unknown,
  startTime: number,
  mcpCounter: MCPCallCounter,
  code: string
): void {
  const baseData = {
    duration_ms: Date.now() - startTime,
    mcp_calls_made: mcpCounter.count,
    mcp_calls_limit: mcpCounter.limit,
    code,
  };
  if (error instanceof MCPCallLimitError) {
    logger.warn('code_execution_limit_error', { ...baseData, error: 'MCP_CALL_LIMIT_EXCEEDED' });
  } else {
    logger.error('code_execution_error', error, baseData);
  }
}

interface VMExecutionContext {
  vm: QuickJSContext;
  code: string;
  options: CodeExecutionOptions;
  logs: ConsoleLog[];
  mcpCounter: MCPCallCounter;
  logger: RequestLogger;
}

async function runCodeInVM(ctx: VMExecutionContext): Promise<unknown> {
  const startTime = Date.now();
  setupConsole(ctx.vm, ctx.logs);
  const pendingCalls = setupHostFunctions(ctx.vm, ctx.options.hostFunctions);
  const interrupt = createInterruptHandler(startTime, ctx.options.timeout_ms);
  ctx.vm.runtime.setInterruptHandler(interrupt.handler);
  evaluateUserCode(ctx.vm, ctx.code);
  if (interrupt.isInterrupted()) {
    throw new TimeoutError(`Code execution exceeded ${ctx.options.timeout_ms}ms`);
  }
  ctx.vm.runtime.executePendingJobs();
  await processPendingCalls(ctx.vm, pendingCalls, ctx.mcpCounter, ctx.logger);
  checkExecutionError(ctx.vm);
  return extractResult(ctx.vm);
}

/**
 * Execute JavaScript code in QuickJS sandbox
 */
export async function executeCode(
  code: string,
  options: CodeExecutionOptions,
  logger: RequestLogger
): Promise<CodeExecutionResult> {
  const startTime = Date.now();
  const logs: ConsoleLog[] = [];
  let vm: QuickJSContext | null = null;
  const mcpCounter: MCPCallCounter = {
    count: 0,
    limit: options.maxMcpCalls ?? DEFAULT_MAX_MCP_CALLS,
  };
  logger.log('code_execution_start', {
    code_length: code.length,
    code,
    host_functions: options.hostFunctions.map((f) => f.name),
    max_mcp_calls: mcpCounter.limit,
  });

  try {
    const module = await getQuickJSModule();
    vm = module.newContext();
    const value = await runCodeInVM({ vm, code, options, logs, mcpCounter, logger });
    logger.log('code_execution_complete', {
      duration_ms: Date.now() - startTime,
      console_logs_count: logs.length,
      mcp_calls_made: mcpCounter.count,
      mcp_calls_limit: mcpCounter.limit,
      success: true,
    });
    return buildSuccessResult(value, logs, startTime, mcpCounter);
  } catch (error) {
    logExecutionError(logger, error, startTime, mcpCounter, code);
    return buildErrorResult(error, logs, startTime, mcpCounter);
  } finally {
    vm?.dispose();
  }
}

/**
 * Create host functions from MCP tool catalog
 */
export function createMCPHostFunctions(
  toolCaller: (toolName: string, args: unknown) => Promise<unknown>,
  toolNames: string[]
): HostFunction[] {
  return toolNames.map((name) => ({
    name,
    fn: async (...args: unknown[]) => {
      const toolArgs = args.length === 1 ? args[0] : args;
      return toolCaller(name, toolArgs);
    },
  }));
}
