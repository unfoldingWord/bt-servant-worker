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
import { CodeExecutionError, TimeoutError } from '../../utils/errors.js';
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
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
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
    pendingCalls.push({ id, fn: hostFn, args: dumpedArgs, resolve: () => {}, reject: () => {} });

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
  // - __resolvers__: Stores Promise resolve/reject functions
  // - __result__: Final return value set by user code
  // - __executionError__: Captures errors from rejected promises in user code
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

async function processPendingCalls(vm: QuickJSContext, pendingCalls: PendingCall[]): Promise<void> {
  // Always run pending jobs at least once to handle native Promises (no host calls)
  // Then loop to handle chained awaits with host function calls
  do {
    // Process any pending host function calls
    if (pendingCalls.length > 0) {
      // Take current batch of pending calls
      const batch = pendingCalls.splice(0, pendingCalls.length);

      // Execute all async calls and resolve their QuickJS promises
      await Promise.all(
        batch.map(async (call) => {
          try {
            const result = await call.fn.fn(...call.args);
            // Store result and resolve the QuickJS promise
            setVMResult(vm, call.id, result);
            const resolveCode = `__resolvers__[${call.id}].resolve(__pendingResults__[${call.id}]);`;
            const resolveResult = vm.evalCode(resolveCode);
            if (resolveResult.error) {
              resolveResult.error.dispose();
            } else {
              resolveResult.value.dispose();
            }
          } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            // Reject the QuickJS promise - setVMResult may fail if msg is not serializable,
            // but we still want to reject the promise with whatever message we can
            try {
              setVMResult(vm, call.id, { __error__: msg });
            } catch {
              // Serialization failed, continue to reject the promise anyway
            }
            const rejectCode = `__resolvers__[${call.id}].reject(new Error(${JSON.stringify(msg)}));`;
            const rejectResult = vm.evalCode(rejectCode);
            if (rejectResult.error) {
              rejectResult.error.dispose();
            } else {
              rejectResult.value.dispose();
            }
          }
        })
      );
    }

    // Resume async code - this may add new items to pendingCalls
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
    return JSON.stringify(errorValue);
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
  startTime: number
): CodeExecutionResult {
  return { success: true, result: value, logs, duration_ms: Date.now() - startTime };
}

function buildErrorResult(
  error: unknown,
  logs: ConsoleLog[],
  startTime: number
): CodeExecutionResult {
  const errorMessage = error instanceof Error ? error.message : 'Unknown error';
  return { success: false, error: errorMessage, logs, duration_ms: Date.now() - startTime };
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

  logger.log('code_execution_start', {
    code_length: code.length,
    code_preview: code.length <= 500 ? code : code.slice(0, 500) + '...[truncated]',
    host_functions: options.hostFunctions.map((f) => f.name),
  });

  try {
    const module = await getQuickJSModule();
    vm = module.newContext();

    setupConsole(vm, logs);
    const pendingCalls = setupHostFunctions(vm, options.hostFunctions);

    const interrupt = createInterruptHandler(startTime, options.timeout_ms);
    vm.runtime.setInterruptHandler(interrupt.handler);

    evaluateUserCode(vm, code);

    if (interrupt.isInterrupted()) {
      throw new TimeoutError(`Code execution exceeded ${options.timeout_ms}ms`);
    }

    await processPendingCalls(vm, pendingCalls);

    // Check for errors from rejected promises in user code
    checkExecutionError(vm);

    const value = extractResult(vm);

    logger.log('code_execution_complete', {
      duration_ms: Date.now() - startTime,
      console_logs_count: logs.length,
      success: true,
    });

    return buildSuccessResult(value, logs, startTime);
  } catch (error) {
    logger.error('code_execution_error', error, {
      duration_ms: Date.now() - startTime,
      code_preview: code.length <= 500 ? code : code.slice(0, 500) + '...[truncated]',
    });
    return buildErrorResult(error, logs, startTime);
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
