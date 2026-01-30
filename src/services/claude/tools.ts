/**
 * Claude tool definitions
 *
 * These are the tools Claude can use:
 * - execute_code: Run JS in QuickJS sandbox with MCP tool access
 * - get_tool_definitions: Get full schemas for MCP tools
 * - Direct MCP tools: Individual tools from MCP servers
 */

import Anthropic from '@anthropic-ai/sdk';
import { CatalogTool, JSONSchema, ToolCatalog } from '../mcp/types.js';

/**
 * Convert JSON Schema to Anthropic tool input schema format
 */
function toAnthropicSchema(schema: JSONSchema): Anthropic.Tool.InputSchema {
  return schema as Anthropic.Tool.InputSchema;
}

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
 * Build Anthropic tool definition from MCP catalog tool
 */
function buildMCPTool(tool: CatalogTool): Anthropic.Tool {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: toAnthropicSchema(tool.inputSchema),
  };
}

/**
 * Build all tool definitions for Claude
 */
export function buildAllTools(catalog: ToolCatalog): Anthropic.Tool[] {
  const tools: Anthropic.Tool[] = [buildExecuteCodeTool(), buildGetToolDefinitionsTool()];

  // Add all MCP tools as direct tools
  for (const tool of catalog.tools) {
    tools.push(buildMCPTool(tool));
  }

  return tools;
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
