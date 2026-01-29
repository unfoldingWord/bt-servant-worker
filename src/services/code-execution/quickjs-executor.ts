/**
 * QuickJS Sandbox Executor
 *
 * Runs JavaScript code in a WASM-based QuickJS sandbox with:
 * - Injected host functions for MCP tool calls
 * - Console capture
 * - Timeout enforcement
 * - No access to Worker APIs, fetch, or environment
 */

import { newQuickJSWASMModule, QuickJSContext } from 'quickjs-emscripten';
import { CodeExecutionError, TimeoutError } from '../../utils/errors.js';
import { RequestLogger } from '../../utils/logger.js';
import { CodeExecutionOptions, CodeExecutionResult, ConsoleLog, HostFunction } from './types.js';

/** Number of VM cycles between timeout checks (performance vs responsiveness trade-off) */
const INTERRUPT_CHECK_CYCLES = 10000;

let quickjsModule: Awaited<ReturnType<typeof newQuickJSWASMModule>> | null = null;

async function getQuickJSModule() {
  if (!quickjsModule) {
    quickjsModule = await newQuickJSWASMModule();
  }
  return quickjsModule;
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
 */
function setVMResult(vm: QuickJSContext, id: number, value: unknown): void {
  const jsonValue = JSON.stringify(value);
  const safeStringLiteral = JSON.stringify(jsonValue);
  vm.evalCode(`__pendingResults__[${id}] = JSON.parse(${safeStringLiteral});`);
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

    const promise = new Promise<unknown>((resolve, reject) => {
      pendingCalls.push({ id, fn: hostFn, args: dumpedArgs, resolve, reject });
    });

    promise
      .then((result) => {
        try {
          setVMResult(vm, id, result);
        } catch (serializeError) {
          const msg =
            serializeError instanceof Error ? serializeError.message : 'Serialization failed';
          setVMResult(vm, id, { __error__: msg });
        }
      })
      .catch((error) => {
        const msg = error instanceof Error ? error.message : String(error);
        setVMResult(vm, id, { __error__: msg });
      });

    return vm.newNumber(id);
  });

  vm.setProp(vm.global, hostFn.name, fnHandle);
  fnHandle.dispose();
}

function setupHostFunctions(vm: QuickJSContext, hostFunctions: HostFunction[]): PendingCall[] {
  const pendingCalls: PendingCall[] = [];
  const callIdRef = { id: 0 };

  vm.evalCode('var __pendingResults__ = {}; var __result__ = undefined;');

  for (const hostFn of hostFunctions) {
    registerHostFunction(vm, hostFn, pendingCalls, callIdRef);
  }

  return pendingCalls;
}

async function processPendingCalls(vm: QuickJSContext, pendingCalls: PendingCall[]): Promise<void> {
  await Promise.all(
    pendingCalls.map(async (call) => {
      try {
        call.resolve(await call.fn.fn(...call.args));
      } catch (error) {
        call.reject(error instanceof Error ? error : new Error(String(error)));
      }
    })
  );
  vm.runtime.executePendingJobs();
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

function extractResult(vm: QuickJSContext): unknown {
  const finalResult = vm.evalCode('__result__', 'get-result.js');

  if (finalResult.error) {
    const errorValue = vm.dump(finalResult.error);
    finalResult.error.dispose();
    throw new CodeExecutionError(String(errorValue));
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
    host_functions: options.hostFunctions.map((f) => f.name),
  });

  try {
    const module = await getQuickJSModule();
    vm = module.newContext();

    setupConsole(vm, logs);
    const pendingCalls = setupHostFunctions(vm, options.hostFunctions);

    const interrupt = createInterruptHandler(startTime, options.timeout_ms);
    vm.runtime.setInterruptHandler(interrupt.handler);

    const result = vm.evalCode(code, 'user-code.js');

    if (interrupt.isInterrupted()) {
      result.dispose();
      throw new TimeoutError(`Code execution exceeded ${options.timeout_ms}ms`);
    }

    await processPendingCalls(vm, pendingCalls);
    const value = extractResult(vm);

    logger.log('code_execution_complete', {
      duration_ms: Date.now() - startTime,
      console_logs_count: logs.length,
      success: true,
    });

    return buildSuccessResult(value, logs, startTime);
  } catch (error) {
    logger.error('code_execution_error', error, { duration_ms: Date.now() - startTime });
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
