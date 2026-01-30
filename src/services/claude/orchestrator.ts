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
import { ClaudeAPIError, MCPError, ValidationError } from '../../utils/errors.js';
import { RequestLogger } from '../../utils/logger.js';
import { createMCPHostFunctions, executeCode } from '../code-execution/index.js';
import { callMCPTool, getToolNames, ToolCatalog } from '../mcp/index.js';
import { buildSystemPrompt, historyToMessages } from './system-prompt.js';
import { buildAllTools, getToolDefinitions } from './tools.js';

/** Default Claude model - can be overridden via CLAUDE_MODEL env var */
const DEFAULT_MODEL = 'claude-sonnet-4-20250514';

/** Default max tokens - can be overridden via CLAUDE_MAX_TOKENS env var */
const DEFAULT_MAX_TOKENS = 4096;

/** Maximum allowed code length to prevent DoS via huge payloads (100KB) */
const MAX_CODE_LENGTH = 100_000;

/** Maximum number of tool names that can be requested at once */
const MAX_TOOL_NAMES = 100;

interface OrchestratorOptions {
  env: Env;
  catalog: ToolCatalog;
  history: ChatHistoryEntry[];
  preferences: { response_language: string; first_interaction: boolean };
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
  catalog: ToolCatalog;
  logger: RequestLogger;
  callbacks?: StreamCallbacks | undefined;
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

function parseEnvConfig(env: Env, logger: RequestLogger) {
  const model = env.CLAUDE_MODEL ?? DEFAULT_MODEL;
  const maxTokens = parseInt(env.CLAUDE_MAX_TOKENS ?? '', 10) || DEFAULT_MAX_TOKENS;
  const codeExecTimeout = parseInt(env.CODE_EXEC_TIMEOUT_MS, 10) || 5000;
  const maxIterations = parseInt(env.MAX_ORCHESTRATION_ITERATIONS, 10) || 10;

  // Log when using defaults (helps debug configuration issues)
  if (!env.CLAUDE_MODEL) {
    logger.log('config_default', { key: 'CLAUDE_MODEL', value: model });
  }
  if (!env.CLAUDE_MAX_TOKENS) {
    logger.log('config_default', { key: 'CLAUDE_MAX_TOKENS', value: maxTokens });
  }

  return { model, maxTokens, codeExecTimeout, maxIterations };
}

function createOrchestrationContext(
  userMessage: string,
  options: OrchestratorOptions,
  config: ReturnType<typeof parseEnvConfig>
): OrchestrationContext {
  const { env, catalog, history, preferences, logger, callbacks } = options;

  return {
    client: new Anthropic({ apiKey: env.ANTHROPIC_API_KEY }),
    model: config.model,
    maxTokens: config.maxTokens,
    systemPrompt: buildSystemPrompt(catalog, preferences, history),
    tools: buildAllTools(catalog),
    messages: [...historyToMessages(history), { role: 'user', content: userMessage }],
    responses: [],
    codeExecTimeout: config.codeExecTimeout,
    catalog,
    logger,
    callbacks,
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
        `Invalid input for execute_code: expected { code: string }, got ${JSON.stringify(toolCall.input)}`
      );
    }
    return handleExecuteCode(toolCall.input, ctx);
  }
  if (toolCall.name === 'get_tool_definitions') {
    if (!isGetToolDefinitionsInput(toolCall.input)) {
      throw new ValidationError(
        `Invalid input for get_tool_definitions: expected { tool_names: string[] }, got ${JSON.stringify(toolCall.input)}`
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
    { timeout_ms: ctx.codeExecTimeout, hostFunctions },
    ctx.logger
  );

  if (!result.success) {
    return { error: result.error, logs: result.logs };
  }
  return { result: result.result, logs: result.logs, duration_ms: result.duration_ms };
}

async function handleMCPToolCall(
  toolName: string,
  input: unknown,
  ctx: OrchestrationContext
): Promise<unknown> {
  const tool = ctx.catalog.tools.find((t) => t.name === toolName);
  if (!tool) {
    throw new ValidationError(`Unknown tool: ${toolName}`);
  }

  const server = ctx.catalog.serverMap.get(tool.serverId);
  if (!server) {
    throw new MCPError(`Server not found for tool: ${toolName}`, tool.serverId);
  }

  return callMCPTool(server, toolName, input, ctx.logger);
}
