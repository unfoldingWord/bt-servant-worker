/**
 * Claude Orchestrator
 *
 * Main orchestration loop that:
 * 1. Sends messages to Claude with tool definitions
 * 2. Executes tool calls (in parallel when possible)
 * 3. Loops until Claude returns a final text response
 * 4. Supports streaming via callbacks
 */

import Anthropic from '@anthropic-ai/sdk';
import { Env } from '../../config/types.js';
import { ChatHistoryEntry, StreamCallbacks } from '../../types/engine.js';
import { DEFAULT_ORG_CONFIG, OrgConfig } from '../../types/org-config.js';
import {
  ClaudeAPIError,
  MCPBudgetExceededError,
  MCPError,
  ValidationError,
} from '../../utils/errors.js';
import { RequestLogger } from '../../utils/logger.js';
import { createMCPHostFunctions, executeCode } from '../code-execution/index.js';
import {
  callMCPTool,
  createBudget,
  createHealthTracker,
  DEFAULT_BUDGET_LIMIT,
  DEFAULT_DOWNSTREAM_PER_CALL,
  getBudgetStatus,
  getHealthSummary,
  getToolNames,
  HealthTracker,
  isBudgetExceeded,
  isServerHealthy,
  MCPCallBudget,
  recordMCPCall,
  ToolCatalog,
  wouldExceedBudget,
} from '../mcp/index.js';
import { buildSystemPrompt, historyToMessages } from './system-prompt.js';
import { buildAllTools, getToolDefinitions } from './tools.js';

/** Default max response size for MCP calls (1MB) */
const DEFAULT_MAX_MCP_RESPONSE_SIZE = 1048576;

/** Default Claude model - can be overridden via CLAUDE_MODEL env var */
const DEFAULT_MODEL = 'claude-sonnet-4-20250514';

/** Default max tokens - can be overridden via CLAUDE_MAX_TOKENS env var */
const DEFAULT_MAX_TOKENS = 4096;

/** Maximum allowed code length to prevent DoS via huge payloads (100KB) */
const MAX_CODE_LENGTH = 100_000;

/** Maximum number of tool names that can be requested at once */
const MAX_TOOL_NAMES = 100;

/** Maximum length of input to include in error messages */
const MAX_ERROR_INPUT_LENGTH = 100;

/** Truncate input for safe inclusion in error messages */
function truncateInput(input: unknown): string {
  const str = JSON.stringify(input);
  return str.length <= MAX_ERROR_INPUT_LENGTH ? str : str.slice(0, MAX_ERROR_INPUT_LENGTH) + '...';
}

interface OrchestratorOptions {
  env: Env;
  catalog: ToolCatalog;
  history: ChatHistoryEntry[];
  preferences: { response_language: string; first_interaction: boolean };
  orgConfig?: OrgConfig;
  logger: RequestLogger;
  callbacks?: StreamCallbacks | undefined;
}

interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/**
 * Type guard for execute_code input with semantic validation.
 * Checks structure, non-empty code, and length limits.
 */
function isExecuteCodeInput(input: unknown): input is { code: string } {
  if (
    typeof input !== 'object' ||
    input === null ||
    !('code' in input) ||
    typeof (input as { code: unknown }).code !== 'string'
  ) {
    return false;
  }
  const code = (input as { code: string }).code;
  return code.length > 0 && code.length <= MAX_CODE_LENGTH;
}

/**
 * Type guard for get_tool_definitions input with semantic validation.
 * Checks structure, non-empty array, length limits, and non-empty tool names.
 */
function isGetToolDefinitionsInput(input: unknown): input is { tool_names: string[] } {
  if (
    typeof input !== 'object' ||
    input === null ||
    !('tool_names' in input) ||
    !Array.isArray((input as { tool_names: unknown }).tool_names)
  ) {
    return false;
  }
  const names = (input as { tool_names: string[] }).tool_names;
  return (
    names.length > 0 &&
    names.length <= MAX_TOOL_NAMES &&
    names.every((n) => typeof n === 'string' && n.length > 0)
  );
}

interface OrchestrationContext {
  client: Anthropic;
  model: string;
  maxTokens: number;
  systemPrompt: string;
  tools: Anthropic.Tool[];
  messages: Anthropic.MessageParam[];
  responses: string[];
  codeExecTimeout: number;
  maxMcpCalls: number;
  maxMcpResponseSize: number;
  catalog: ToolCatalog;
  logger: RequestLogger;
  callbacks?: StreamCallbacks | undefined;
  mcpBudget: MCPCallBudget;
  healthTracker: HealthTracker;
}

function extractToolCalls(content: Anthropic.ContentBlock[]): ToolUseBlock[] {
  return content.filter((block): block is ToolUseBlock => block.type === 'tool_use');
}

function extractTextResponses(content: Anthropic.ContentBlock[]): string[] {
  const texts: string[] = [];
  for (const block of content) {
    if (block.type === 'text' && block.text.trim()) {
      texts.push(block.text);
    }
  }
  return texts;
}

async function callClaude(ctx: OrchestrationContext): Promise<Anthropic.Message> {
  if (ctx.callbacks) {
    return streamClaudeResponse(ctx);
  }
  return ctx.client.messages.create({
    model: ctx.model,
    max_tokens: ctx.maxTokens,
    system: ctx.systemPrompt,
    messages: ctx.messages,
    tools: ctx.tools,
  });
}

async function streamClaudeResponse(ctx: OrchestrationContext): Promise<Anthropic.Message> {
  const stream = ctx.client.messages.stream({
    model: ctx.model,
    max_tokens: ctx.maxTokens,
    system: ctx.systemPrompt,
    messages: ctx.messages,
    tools: ctx.tools,
  });
  stream.on('text', (text) => ctx.callbacks?.onProgress(text));
  return stream.finalMessage();
}

async function processIteration(ctx: OrchestrationContext, iteration: number): Promise<boolean> {
  ctx.logger.log('claude_request', {
    iteration,
    message_count: ctx.messages.length,
  });

  // Add separator before subsequent iterations for streaming
  if (iteration > 0 && ctx.callbacks) {
    ctx.callbacks.onProgress('\n');
  }

  const startTime = Date.now();
  const response = await callClaude(ctx);
  const duration = Date.now() - startTime;

  const toolCalls = extractToolCalls(response.content);

  ctx.logger.log('claude_response', {
    iteration,
    stop_reason: response.stop_reason,
    tool_calls_count: toolCalls.length,
    duration_ms: duration,
  });

  ctx.responses.push(...extractTextResponses(response.content));

  if (response.stop_reason === 'end_turn' || toolCalls.length === 0) {
    return true;
  }

  ctx.callbacks?.onStatus(`Executing ${toolCalls.length} tool(s)...`);

  const toolResults = await executeToolCalls(toolCalls, ctx);

  ctx.messages.push({
    role: 'assistant',
    content: response.content as Anthropic.ContentBlock[],
  });
  ctx.messages.push({ role: 'user', content: toolResults });

  return false;
}

/** Default code execution timeout in milliseconds (30 seconds) */
const DEFAULT_CODE_EXEC_TIMEOUT_MS = 30_000;

/** Default maximum orchestration iterations */
const DEFAULT_MAX_ITERATIONS = 10;

/**
 * Parse and validate an integer environment variable.
 * Returns the parsed value if valid, or the default if missing/invalid.
 * Logs a warning if the value is present but malformed.
 */
function parseIntEnvVar(
  value: string | undefined,
  key: string,
  defaultValue: number,
  logger: RequestLogger
): number {
  if (!value) {
    logger.log('config_default', { key, value: defaultValue });
    return defaultValue;
  }

  const parsed = parseInt(value, 10);
  if (isNaN(parsed) || parsed <= 0) {
    logger.warn('config_invalid', {
      key,
      provided: value,
      reason: isNaN(parsed) ? 'not a number' : 'must be positive',
      using_default: defaultValue,
    });
    return defaultValue;
  }

  return parsed;
}

function parseClaudeConfig(env: Env, logger: RequestLogger) {
  const model = env.CLAUDE_MODEL ?? DEFAULT_MODEL;
  if (!env.CLAUDE_MODEL) {
    logger.log('config_default', { key: 'CLAUDE_MODEL', value: model });
  }
  const maxTokens = parseIntEnvVar(
    env.CLAUDE_MAX_TOKENS,
    'CLAUDE_MAX_TOKENS',
    DEFAULT_MAX_TOKENS,
    logger
  );
  return { model, maxTokens };
}

function parseOrchestrationConfig(env: Env, logger: RequestLogger) {
  const codeExecTimeout = parseIntEnvVar(
    env.CODE_EXEC_TIMEOUT_MS,
    'CODE_EXEC_TIMEOUT_MS',
    DEFAULT_CODE_EXEC_TIMEOUT_MS,
    logger
  );
  const maxIterations = parseIntEnvVar(
    env.MAX_ORCHESTRATION_ITERATIONS,
    'MAX_ORCHESTRATION_ITERATIONS',
    DEFAULT_MAX_ITERATIONS,
    logger
  );
  const maxMcpCalls = parseIntEnvVar(
    env.MAX_MCP_CALLS_PER_EXECUTION,
    'MAX_MCP_CALLS_PER_EXECUTION',
    10,
    logger
  );
  return { codeExecTimeout, maxIterations, maxMcpCalls };
}

function parseMcpBudgetConfig(env: Env, logger: RequestLogger) {
  const maxDownstreamCalls = parseIntEnvVar(
    env.MAX_DOWNSTREAM_CALLS_PER_REQUEST,
    'MAX_DOWNSTREAM_CALLS_PER_REQUEST',
    DEFAULT_BUDGET_LIMIT,
    logger
  );
  const defaultDownstreamPerCall = parseIntEnvVar(
    env.DEFAULT_DOWNSTREAM_PER_MCP_CALL,
    'DEFAULT_DOWNSTREAM_PER_MCP_CALL',
    DEFAULT_DOWNSTREAM_PER_CALL,
    logger
  );
  const maxMcpResponseSize = parseIntEnvVar(
    env.MAX_MCP_RESPONSE_SIZE_BYTES,
    'MAX_MCP_RESPONSE_SIZE_BYTES',
    DEFAULT_MAX_MCP_RESPONSE_SIZE,
    logger
  );
  return { maxDownstreamCalls, defaultDownstreamPerCall, maxMcpResponseSize };
}

function parseEnvConfig(env: Env, logger: RequestLogger) {
  const claudeConfig = parseClaudeConfig(env, logger);
  const orchestrationConfig = parseOrchestrationConfig(env, logger);
  const mcpBudgetConfig = parseMcpBudgetConfig(env, logger);

  return {
    ...claudeConfig,
    ...orchestrationConfig,
    ...mcpBudgetConfig,
  };
}

function createOrchestrationContext(
  userMessage: string,
  options: OrchestratorOptions,
  config: ReturnType<typeof parseEnvConfig>
): OrchestrationContext {
  const { env, catalog, history, preferences, orgConfig, logger, callbacks } = options;

  // Use LLM limit from org config (default: 5)
  const llmMax = orgConfig?.max_history_llm ?? DEFAULT_ORG_CONFIG.max_history_llm;

  return {
    client: new Anthropic({ apiKey: env.ANTHROPIC_API_KEY }),
    model: config.model,
    maxTokens: config.maxTokens,
    systemPrompt: buildSystemPrompt(catalog, preferences, history),
    tools: buildAllTools(catalog),
    messages: [...historyToMessages(history, llmMax), { role: 'user', content: userMessage }],
    responses: [],
    codeExecTimeout: config.codeExecTimeout,
    maxMcpCalls: config.maxMcpCalls,
    maxMcpResponseSize: config.maxMcpResponseSize,
    catalog,
    logger,
    callbacks,
    mcpBudget: createBudget(config.maxDownstreamCalls, config.defaultDownstreamPerCall),
    healthTracker: createHealthTracker(),
  };
}

async function runOrchestrationLoop(
  ctx: OrchestrationContext,
  maxIterations: number
): Promise<void> {
  for (let i = 0; i < maxIterations; i++) {
    const done = await processIteration(ctx, i);
    if (done) break;
  }

  // Log health summary and budget status at end of orchestration
  logOrchestrationSummary(ctx);
}

function logOrchestrationSummary(ctx: OrchestrationContext): void {
  const healthSummary = getHealthSummary(ctx.healthTracker);
  const budgetStatus = getBudgetStatus(ctx.mcpBudget);

  ctx.logger.log('orchestration_summary', {
    mcp_call_count: ctx.mcpBudget.mcpCallCount,
    budget: {
      total_downstream_calls: budgetStatus.totalDownstreamCalls,
      limit: ctx.mcpBudget.limit,
      percent_used: Math.round(budgetStatus.percentUsed),
      using_estimates: budgetStatus.usingEstimates,
    },
    server_health:
      healthSummary.length > 0
        ? healthSummary.map((s) => ({
            server_id: s.serverId,
            healthy: s.healthy,
            total_calls: s.totalCalls,
            failure_rate: Math.round(s.failureRate * 100),
            avg_response_ms: s.averageResponseTimeMs,
          }))
        : undefined,
  });

  if (budgetStatus.warning) {
    ctx.logger.warn('budget_warning', { message: budgetStatus.warning });
  }
}

function handleOrchestrationError(error: unknown, logger: RequestLogger): never {
  logger.error('claude_error', error);
  if (error instanceof Anthropic.APIError) {
    throw new ClaudeAPIError(error.message, error.status);
  }
  throw error;
}

/**
 * Main orchestration function
 */
export async function orchestrate(
  userMessage: string,
  options: OrchestratorOptions
): Promise<string[]> {
  const config = parseEnvConfig(options.env, options.logger);
  const ctx = createOrchestrationContext(userMessage, options, config);

  ctx.callbacks?.onStatus('Processing your request...');

  try {
    await runOrchestrationLoop(ctx, config.maxIterations);
  } catch (error) {
    handleOrchestrationError(error, ctx.logger);
  }

  return ctx.responses;
}

async function executeToolCalls(
  toolCalls: ToolUseBlock[],
  ctx: OrchestrationContext
): Promise<Anthropic.ToolResultBlockParam[]> {
  return Promise.all(toolCalls.map((tc) => executeSingleTool(tc, ctx)));
}

async function executeSingleTool(
  toolCall: ToolUseBlock,
  ctx: OrchestrationContext
): Promise<Anthropic.ToolResultBlockParam> {
  ctx.logger.log('tool_execution_start', {
    tool_name: toolCall.name,
    tool_id: toolCall.id,
  });
  ctx.callbacks?.onToolUse?.(toolCall.name, toolCall.input);

  const startTime = Date.now();

  try {
    const result = await dispatchToolCall(toolCall, ctx);
    logToolSuccess(ctx, toolCall, startTime);
    ctx.callbacks?.onToolResult?.(toolCall.name, result);
    return { type: 'tool_result', tool_use_id: toolCall.id, content: JSON.stringify(result) };
  } catch (error) {
    return handleToolError(ctx, toolCall, error, startTime);
  }
}

async function dispatchToolCall(
  toolCall: ToolUseBlock,
  ctx: OrchestrationContext
): Promise<unknown> {
  if (toolCall.name === 'execute_code') {
    if (!isExecuteCodeInput(toolCall.input)) {
      throw new ValidationError(
        `Invalid input for execute_code: expected { code: string }, got ${truncateInput(toolCall.input)}`
      );
    }
    return handleExecuteCode(toolCall.input, ctx);
  }
  if (toolCall.name === 'get_tool_definitions') {
    if (!isGetToolDefinitionsInput(toolCall.input)) {
      throw new ValidationError(
        `Invalid input for get_tool_definitions: expected { tool_names: string[] }, got ${truncateInput(toolCall.input)}`
      );
    }
    return getToolDefinitions(ctx.catalog, toolCall.input.tool_names);
  }
  return handleMCPToolCall(toolCall.name, toolCall.input, ctx);
}

function logToolSuccess(
  ctx: OrchestrationContext,
  toolCall: ToolUseBlock,
  startTime: number
): void {
  ctx.logger.log('tool_execution_complete', {
    tool_name: toolCall.name,
    tool_id: toolCall.id,
    duration_ms: Date.now() - startTime,
    success: true,
  });
}

function handleToolError(
  ctx: OrchestrationContext,
  toolCall: ToolUseBlock,
  error: unknown,
  startTime: number
): Anthropic.ToolResultBlockParam {
  const errorMessage = error instanceof Error ? error.message : 'Unknown error';
  ctx.logger.error('tool_execution_error', error, {
    tool_name: toolCall.name,
    tool_id: toolCall.id,
    duration_ms: Date.now() - startTime,
  });
  ctx.callbacks?.onToolResult?.(toolCall.name, { error: errorMessage });
  return {
    type: 'tool_result',
    tool_use_id: toolCall.id,
    content: JSON.stringify({ error: errorMessage }),
    is_error: true,
  };
}

async function handleExecuteCode(
  input: { code: string },
  ctx: OrchestrationContext
): Promise<unknown> {
  const toolNames = getToolNames(ctx.catalog);
  const toolCaller = (name: string, args: unknown) => handleMCPToolCall(name, args, ctx);
  const hostFunctions = createMCPHostFunctions(toolCaller, toolNames);

  const result = await executeCode(
    input.code,
    { timeout_ms: ctx.codeExecTimeout, hostFunctions, maxMcpCalls: ctx.maxMcpCalls },
    ctx.logger
  );

  if (!result.success) {
    // Handle MCP call limit exceeded with structured error and guidance
    if (result.errorCode === 'MCP_CALL_LIMIT_EXCEEDED') {
      ctx.logger.log('tool_result_limit_error', {
        tool_name: 'execute_code',
        calls_made: result.callsMade,
        limit: result.callLimit,
        suggestion_sent: true,
      });
      return {
        error: result.error,
        errorCode: result.errorCode,
        callsMade: result.callsMade,
        limit: result.callLimit,
        logs: result.logs,
        suggestion:
          `You made ${result.callsMade} MCP calls but the limit is ${result.callLimit}. ` +
          'Ask user to narrow scope, or fetch summary instead of individual items. ' +
          'Offer to continue in batches.',
      };
    }
    return { error: result.error, logs: result.logs };
  }
  return { result: result.result, logs: result.logs, duration_ms: result.duration_ms };
}

function validateMCPToolCall(toolName: string, ctx: OrchestrationContext) {
  const tool = ctx.catalog.tools.find((t) => t.name === toolName);
  if (!tool) {
    throw new ValidationError(`Unknown tool: ${toolName}`);
  }

  const server = ctx.catalog.serverMap.get(tool.serverId);
  if (!server) {
    throw new MCPError(`Server not found for tool: ${toolName}`, tool.serverId);
  }

  return { tool, server };
}

function checkMCPBudgetBeforeCall(
  toolName: string,
  serverId: string,
  ctx: OrchestrationContext
): void {
  if (wouldExceedBudget(ctx.mcpBudget)) {
    const status = getBudgetStatus(ctx.mcpBudget);
    ctx.logger.warn('mcp_budget_exceeded', {
      tool_name: toolName,
      server_id: serverId,
      estimated_calls: status.totalDownstreamCalls,
      limit: ctx.mcpBudget.limit,
    });
    throw new MCPBudgetExceededError(status.totalDownstreamCalls, ctx.mcpBudget.limit);
  }
}

function checkServerHealth(toolName: string, serverId: string, ctx: OrchestrationContext): void {
  if (!isServerHealthy(ctx.healthTracker, serverId)) {
    ctx.logger.warn('mcp_server_unhealthy', { tool_name: toolName, server_id: serverId });
    throw new MCPError(
      `Server ${serverId} is currently unhealthy (too many consecutive failures)`,
      serverId
    );
  }
}

function logMCPBudgetStatus(
  toolName: string,
  hasMetadata: boolean,
  ctx: OrchestrationContext
): void {
  const budgetStatus = getBudgetStatus(ctx.mcpBudget);
  ctx.logger.log('mcp_budget_status', {
    tool_name: toolName,
    mcp_calls: ctx.mcpBudget.mcpCallCount,
    downstream_calls: budgetStatus.totalDownstreamCalls,
    percent_used: Math.round(budgetStatus.percentUsed),
    has_metadata: hasMetadata,
  });

  if (budgetStatus.warning) {
    ctx.logger.warn('mcp_budget_warning', { message: budgetStatus.warning });
  }

  if (isBudgetExceeded(ctx.mcpBudget)) {
    ctx.logger.warn('mcp_budget_exhausted', {
      downstream_calls: budgetStatus.totalDownstreamCalls,
      limit: ctx.mcpBudget.limit,
    });
  }
}

async function handleMCPToolCall(
  toolName: string,
  input: unknown,
  ctx: OrchestrationContext
): Promise<unknown> {
  const { server } = validateMCPToolCall(toolName, ctx);
  checkMCPBudgetBeforeCall(toolName, server.id, ctx);
  checkServerHealth(toolName, server.id, ctx);

  const callResult = await callMCPTool(server, toolName, input, ctx.logger, {
    healthTracker: ctx.healthTracker,
    maxResponseSizeBytes: ctx.maxMcpResponseSize,
  });

  recordMCPCall(ctx.mcpBudget, callResult.metadata);
  logMCPBudgetStatus(toolName, !!callResult.metadata, ctx);

  return callResult.result;
}
