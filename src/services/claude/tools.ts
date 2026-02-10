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
    description: `Execute JavaScript code in a sandboxed QuickJS environment.

SYNTAX: ES2020 JavaScript (not TypeScript). Your code runs in an async context, so you can use await directly.

PATTERN:
const result = await tool_name({ param: "value" });
__result__ = result;

AVAILABLE: console.log/info/warn/error, JSON, all MCP tool functions
NOT AVAILABLE: fetch, require, import, process, eval, Function constructor

RESOURCE LIMITS:
- Maximum 10 MCP tool calls per execute_code invocation (hard limit - execution fails if exceeded)
- 30 second timeout per execution
- If you need more data, fetch a batch, inform the user what you got, and offer to continue

The code MUST set __result__ to return a value.`,
    input_schema: {
      type: 'object',
      properties: {
        code: {
          type: 'string',
          description:
            'ES2020 JavaScript code. Use await for MCP tool calls. Must set __result__ to return a value.',
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
 * Build read_memory tool definition
 */
export function buildReadMemoryTool(): Anthropic.Tool {
  return {
    name: 'read_memory',
    description:
      'Read from persistent user memory. Call with no arguments to get the full memory document, or pass specific section names to read only those sections.',
    input_schema: {
      type: 'object',
      properties: {
        sections: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional list of section names to read. Omit to read full memory.',
        },
      },
      required: [],
    },
  };
}

/**
 * Build update_memory tool definition
 */
export function buildUpdateMemoryTool(): Anthropic.Tool {
  return {
    name: 'update_memory',
    description: `Create, update, or delete sections in the user's persistent memory. Pass an object where keys are section names and values are either markdown content (to create/update) or null (to delete). Multiple sections can be updated in a single call. The sections object must contain at least one entry.`,
    input_schema: {
      type: 'object',
      properties: {
        sections: {
          type: 'object',
          additionalProperties: {
            oneOf: [{ type: 'string' }, { type: 'null' }],
          },
          description:
            'Object of section updates. String values create/replace sections. Null values delete sections.',
        },
      },
      required: ['sections'],
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
  return [
    buildExecuteCodeTool(),
    buildGetToolDefinitionsTool(),
    buildReadMemoryTool(),
    buildUpdateMemoryTool(),
  ];
}

/**
 * Check if a tool is a built-in tool (not an MCP tool)
 */
export function isBuiltInTool(toolName: string): boolean {
  return (
    toolName === 'execute_code' ||
    toolName === 'get_tool_definitions' ||
    toolName === 'read_memory' ||
    toolName === 'update_memory'
  );
}

/** Maximum number of sections in a single read_memory request */
const MAX_READ_SECTIONS = 50;

/** Maximum number of sections in a single update_memory request */
const MAX_UPDATE_SECTIONS = 50;

/**
 * Type guard for read_memory input.
 * sections is optional; if present, must be a non-empty string array.
 */
export function isReadMemoryInput(input: unknown): input is { sections?: string[] } {
  if (typeof input !== 'object' || input === null) return false;
  if (!('sections' in input)) return true; // no sections = read full
  const sections = (input as { sections: unknown }).sections;
  if (!Array.isArray(sections)) return false;
  if (sections.length === 0) return false; // empty array not allowed — omit parameter for full reads
  return (
    sections.length <= MAX_READ_SECTIONS &&
    sections.every((s) => typeof s === 'string' && s.length > 0)
  );
}

/**
 * Type guard for update_memory input.
 * sections is required, keys are section names, values are string|null.
 */
export function isUpdateMemoryInput(
  input: unknown
): input is { sections: Record<string, string | null> } {
  if (typeof input !== 'object' || input === null) return false;
  if (!('sections' in input)) return false;
  const sections = (input as { sections: unknown }).sections;
  if (typeof sections !== 'object' || sections === null || Array.isArray(sections)) return false;
  const entries = Object.entries(sections as Record<string, unknown>);
  if (entries.length === 0 || entries.length > MAX_UPDATE_SECTIONS) return false;
  return entries.every(([key, val]) => key.length > 0 && (typeof val === 'string' || val === null));
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
