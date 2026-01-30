# QuickJS WASM Issue in Cloudflare Workers

**Status**: FIX DEPLOYED - Testing in production
**Created**: 2026-01-30
**Last Updated**: 2026-01-30

## Problem Summary

The `execute_code` tool, which runs JavaScript in a QuickJS sandbox to call MCP tools, fails in Cloudflare Workers production with:

```
Aborted(Assertion failed: list_empty(&rt->gc_obj_list), at: quickjs.c,1998,JS_FreeRuntime)
```

This error occurs during context disposal (`vm.dispose()`), indicating that QuickJS objects are not being properly cleaned up before the runtime is freed.

## Impact

- **MCP tools are non-functional** in production
- Claude can discover tools (9 tools found) but cannot execute them
- The entire code execution architecture is blocked

## Timeline of Fixes Attempted

### 1. Initial Problem - WASM Loading Failure

**Error**: `"both async and sync fetching of the wasm failed"`

**Cause**: `quickjs-emscripten` uses dynamic WASM fetching which Cloudflare Workers prohibits.

**Fix Applied**: Switched from `quickjs-emscripten` to `@cf-wasm/quickjs` which pre-bundles WASM for Cloudflare Workers.

**Result**: WASM now loads, but new error appeared.

### 2. Second Problem - GC Assertion Failure

**Error**: `"Assertion failed: list_empty(&rt->gc_obj_list)"`

**Cause**: QuickJS garbage collector has objects still in the GC list when we try to dispose the context.

**Fix Attempted**: Removed module caching (create fresh module per execution).

**Result**: Error persists.

### 3. Third Fix Attempt - Dispose evalCode Handles (2026-01-30)

**Root Cause Identified**: Every `vm.evalCode()` call returns a handle that must be disposed. We were ignoring the return value in several places:

- `setVMResult()` - stores async call results in VM
- `setupHostFunctions()` - initializes `__pendingResults__` object
- Main code evaluation in `executeCode()`

These undisposed handles left objects in the GC list, causing the assertion failure when disposing the context.

**Fix Applied** (commit `febdd0c`):

1. Capture and dispose `evalCode()` result in `setVMResult()`
2. Capture and dispose `evalCode()` result in `setupHostFunctions()`
3. Extract user code evaluation into `evaluateUserCode()` helper that properly disposes result

**Result**: Deployed to production. Awaiting verification.

## Technical Analysis

### Current Code Flow (`src/services/code-execution/quickjs-executor.ts`)

1. Get QuickJS module via `getQuickJSWASMModule()`
2. Create context: `module.newContext()`
3. Setup console (creates handles, disposes them)
4. Setup host functions (creates function handles, disposes them)
5. Set interrupt handler for timeouts
6. Execute user code: `vm.evalCode(code)`
7. Process pending async calls (MCP tool calls)
8. Extract result
9. Dispose context: `vm.dispose()` → **FAILS HERE**

### Likely Root Cause

The host function registration creates Promises that resolve asynchronously. Even though we call `processPendingCalls()` and `vm.runtime.executePendingJobs()`, the QuickJS context may still hold references to:

- Promise resolution callbacks
- Host function wrappers
- Return values from async operations

These references prevent proper cleanup before disposal.

### Key Code Section (lines 85-119)

```typescript
function registerHostFunction(
  vm: QuickJSContext,
  hostFn: HostFunction,
  pendingCalls: PendingCall[],
  callIdRef: { id: number }
): void {
  const fnHandle = vm.newFunction(hostFn.name, (...args) => {
    // Creates a Promise that resolves later
    const promise = new Promise<unknown>((resolve, reject) => {
      pendingCalls.push({ id, fn: hostFn, args: dumpedArgs, resolve, reject });
    });

    promise.then((result) => {
      // This sets a result in the VM - may create lingering references
      setVMResult(vm, id, result);
    });

    return vm.newNumber(id);
  });

  vm.setProp(vm.global, hostFn.name, fnHandle);
  fnHandle.dispose(); // Handle disposed, but Promise callbacks may persist
}
```

## Suggested Solutions to Try

### Option 1: Use Simpler evalCode API (Medium Effort)

`@cf-wasm/quickjs` provides a simplified `evalCode()` method:

```typescript
const result = QuickJS.evalCode(code, {
  shouldInterrupt: shouldInterruptAfterDeadline(Date.now() + timeout),
  memoryLimitBytes: 1024 * 1024,
});
```

**Challenge**: This API doesn't support injecting host functions. Would need to:

- Pre-process code to replace tool calls with fetch calls
- Or serialize tool definitions into the code itself
- Or find a way to inject globals before evalCode

**Pros**: Handles context lifecycle automatically
**Cons**: May not support our host function injection pattern

### Option 2: Official quickjs-emscripten Cloudflare Example (High Effort)

Follow the [official Cloudflare Workers example](https://github.com/justjake/quickjs-emscripten/tree/main/examples/cloudflare-workers):

1. Use `@jitl/quickjs-wasmfile-release-sync` variant
2. Copy WASM files into src directory
3. Configure custom variant with `newVariant()`
4. Import WASM as WebAssembly.Module

**Pros**: Official supported approach
**Cons**: More complex setup, requires WASM file management

### Option 3: Fix Context Disposal (Medium Effort)

Investigate and fix the disposal issue:

1. Add explicit cleanup of all pending promises before disposal
2. Track all created handles and ensure disposal
3. Use `vm.runtime.executePendingJobs()` more aggressively
4. Try `vm.runtime.setMemoryLimit()` or other cleanup methods
5. Check if there's a `vm.runtime.freeValue()` for lingering refs

**Research needed**:

- How does quickjs-emscripten handle async host functions?
- Are there lifecycle hooks for proper cleanup?
- Check quickjs-emscripten issues for similar problems

### Option 4: Bypass QuickJS for MCP Calls (Alternative Architecture)

Instead of running code in QuickJS that calls MCP tools, have Claude call MCP tools directly:

1. Expose MCP tools as Claude tools (not just in catalog)
2. Claude calls tools directly, not via execute_code
3. Keep QuickJS only for pure computation (no async host functions)

**Pros**: Simpler architecture, avoids WASM complexity
**Cons**: Changes the "lasker-api" pattern, may increase token usage

## Recommended Next Steps

1. **Immediate**: Try Option 3 first - add aggressive cleanup before disposal
2. **If that fails**: Try Option 1 - test if simpler API can work
3. **If that fails**: Try Option 2 - official example setup
4. **Fallback**: Consider Option 4 - architecture change

## Relevant Files

- `src/services/code-execution/quickjs-executor.ts` - Main executor
- `src/services/code-execution/types.ts` - Type definitions
- `src/services/claude/orchestrator.ts` - Where execute_code is called
- `package.json` - Currently using `@cf-wasm/quickjs@0.2.4`

## External Resources

- [@cf-wasm/quickjs npm](https://www.npmjs.com/package/@cf-wasm/quickjs)
- [quickjs-emscripten GitHub](https://github.com/justjake/quickjs-emscripten)
- [Cloudflare Workers example](https://github.com/justjake/quickjs-emscripten/tree/main/examples/cloudflare-workers)
- [quickjs-emscripten-core types](https://github.com/aspect-build/aspect-workflows-action/tree/main/node_modules/quickjs-emscripten-core)

## Testing Commands

```bash
# Test MCP discovery (should show 9 tools)
curl "https://bt-servant-worker.unfoldingword.workers.dev/api/v1/admin/orgs/unfoldingWord/mcp-servers?discover=true" \
  -H "Authorization: Bearer $ENGINE_API_KEY"

# Test chat (triggers tool execution, currently fails)
curl -X POST "https://bt-servant-worker.unfoldingword.workers.dev/api/v1/chat" \
  -H "Authorization: Bearer $ENGINE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"user_id": "test", "client_id": "test", "message": "List all languages", "message_type": "text"}'

# Watch logs
npx wrangler tail --format json
```

## Log Examples

### Successful MCP Discovery

```json
{"event":"mcp_discovery_complete","server_id":"translation-helps","tools_found":9,"duration_ms":22}
{"event":"mcp_catalog_built","server_count":1,"tool_count":9}
```

### Failed Code Execution

```json
{"event":"code_execution_start","code_length":113,"host_functions":["fetch_scripture","list_languages",...]}
{"event":"tool_execution_error","tool_name":"execute_code","error":"Aborted(Assertion failed: list_empty(&rt->gc_obj_list)..."}
```
