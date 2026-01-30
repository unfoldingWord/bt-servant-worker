/**
 * Claude tool definitions
 *
 * Claude has access to two meta-tools:
 * - execute_code: Run JS in QuickJS sandbox with MCP tool access
 * - get_tool_definitions: Get full schemas for MCP tools
 *
 * MCP tools are NOT exposed directly to Claude. Instead:
 * - System prompt shows a compact catalog (name + summary)
 * - Claude calls get_tool_definitions to learn full schemas
 * - Claude uses execute_code to call MCP tools
 */

import Anthropic from '@anthropic-ai/sdk';
import { JSONSchema, ToolCatalog } from '../mcp/types.js';

/**
 * Build execute_code tool definition
 */
export function buildExecuteCodeTool(): Anthropic.Tool {
  return {
    name: 'execute_code',
    description: `Execute JavaScript code in a sandboxed environment. The sandbox has access to MCP tool functions that can be called directly (e.g., fetch_scripture({book: "John", chapter: 3, verse: 16})). Use this for complex operations that require multiple tool calls or data transformation. The code should set __result__ to the final value to return.`,
    input_schema: {
      type: 'object',
      properties: {
        code: {
          type: 'string',
          description:
            'JavaScript code to execute. Available globals: console (log/info/warn/error), and all MCP tool functions. Set __result__ to the value to return.',
        },
      },
      required: ['code'],
    },
  };
}

/**
 * Build get_tool_definitions tool definition
 */
export function buildGetToolDefinitionsTool(): Anthropic.Tool {
  return {
    name: 'get_tool_definitions',
    description:
      'Get the full JSON Schema definitions for one or more MCP tools. Use this to understand the exact parameters a tool accepts before calling it.',
    input_schema: {
      type: 'object',
      properties: {
        tool_names: {
          type: 'array',
          items: { type: 'string' },
          description: 'Names of the tools to get definitions for',
        },
      },
      required: ['tool_names'],
    },
  };
}

/**
 * Build all tool definitions for Claude
 *
 * NOTE: We intentionally do NOT expose MCP tools as direct Claude tools.
 * This follows the lasker-api pattern where:
 * - System prompt shows a compact catalog of MCP tools (name + summary)
 * - Claude uses get_tool_definitions to learn full schemas
 * - Claude calls MCP tools via execute_code
 *
 * Benefits:
 * - Dramatically reduces tokens when tool count grows (50+ tools)
 * - Forces Claude to be intentional about which tools to use
 * - Full schemas are loaded on-demand, not upfront
 */
export function buildAllTools(_catalog: ToolCatalog): Anthropic.Tool[] {
  // Only expose meta-tools, not individual MCP tools
  return [buildExecuteCodeTool(), buildGetToolDefinitionsTool()];
}

/**
 * Check if a tool is a built-in tool (not an MCP tool)
 */
export function isBuiltInTool(toolName: string): boolean {
  return toolName === 'execute_code' || toolName === 'get_tool_definitions';
}

/**
 * Get tool definitions from catalog
 */
export function getToolDefinitions(
  catalog: ToolCatalog,
  toolNames: string[]
): Record<string, JSONSchema> {
  const definitions: Record<string, JSONSchema> = {};

  for (const name of toolNames) {
    const tool = catalog.tools.find((t) => t.name === name);
    if (tool) {
      // eslint-disable-next-line security/detect-object-injection -- name is from controlled toolNames array
      definitions[name] = tool.inputSchema;
    }
  }

  return definitions;
}
