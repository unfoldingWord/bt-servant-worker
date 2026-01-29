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
import { ClaudeAPIError } from '../../utils/errors.js';
import { RequestLogger } from '../../utils/logger.js';
import { createMCPHostFunctions, executeCode } from '../code-execution/index.js';
import { callMCPTool, getToolNames, ToolCatalog } from '../mcp/index.js';
import { buildSystemPrompt, historyToMessages } from './system-prompt.js';
import { buildAllTools, getToolDefinitions } from './tools.js';

const MODEL = 'claude-sonnet-4-20250514';
const MAX_TOKENS = 4096;

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

interface OrchestrationContext {
  client: Anthropic;
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
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: ctx.systemPrompt,
    messages: ctx.messages,
    tools: ctx.tools,
  });
}

async function streamClaudeResponse(ctx: OrchestrationContext): Promise<Anthropic.Message> {
  const stream = ctx.client.messages.stream({
    model: MODEL,
    max_tokens: MAX_TOKENS,
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

/**
 * Main orchestration function
 */
export async function orchestrate(
  userMessage: string,
  options: OrchestratorOptions
): Promise<string[]> {
  const { env, catalog, history, preferences, logger, callbacks } = options;
  const maxIterations = parseInt(env.MAX_ORCHESTRATION_ITERATIONS, 10) || 10;

  const ctx: OrchestrationContext = {
    client: new Anthropic({ apiKey: env.ANTHROPIC_API_KEY }),
    systemPrompt: buildSystemPrompt(catalog, preferences, history),
    tools: buildAllTools(catalog),
    messages: [...historyToMessages(history), { role: 'user', content: userMessage }],
    responses: [],
    codeExecTimeout: parseInt(env.CODE_EXEC_TIMEOUT_MS, 10) || 5000,
    catalog,
    logger,
    callbacks,
  };

  callbacks?.onStatus('Processing your request...');

  try {
    for (let i = 0; i < maxIterations; i++) {
      const done = await processIteration(ctx, i);
      if (done) break;
    }
  } catch (error) {
    logger.error('claude_error', error);
    if (error instanceof Anthropic.APIError) {
      throw new ClaudeAPIError(error.message, error.status);
    }
    throw error;
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
    return handleExecuteCode(toolCall.input as { code: string }, ctx);
  }
  if (toolCall.name === 'get_tool_definitions') {
    return getToolDefinitions(ctx.catalog, (toolCall.input as { tool_names: string[] }).tool_names);
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
  if (!tool) throw new Error(`Unknown tool: ${toolName}`);

  const server = ctx.catalog.serverMap.get(tool.serverId);
  if (!server) throw new Error(`Server not found for tool: ${toolName}`);

  return callMCPTool(server, toolName, input, ctx.logger);
}
