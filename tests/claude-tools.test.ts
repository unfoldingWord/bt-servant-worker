import { describe, it, expect } from 'vitest';
import {
  buildExecuteCodeTool,
  buildGetToolDefinitionsTool,
  buildAllTools,
  isBuiltInTool,
  getToolDefinitions,
} from '../src/services/claude/tools.js';
import { buildToolCatalog } from '../src/services/mcp/catalog.js';

describe('buildExecuteCodeTool', () => {
  it('should return valid tool definition', () => {
    const tool = buildExecuteCodeTool();

    expect(tool.name).toBe('execute_code');
    expect(tool.description).toContain('JavaScript code');
    expect(tool.input_schema.type).toBe('object');
    expect(tool.input_schema.required).toContain('code');
  });
});

describe('buildGetToolDefinitionsTool', () => {
  it('should return valid tool definition', () => {
    const tool = buildGetToolDefinitionsTool();

    expect(tool.name).toBe('get_tool_definitions');
    expect(tool.description).toContain('JSON Schema');
    expect(tool.input_schema.type).toBe('object');
    expect(tool.input_schema.required).toContain('tool_names');
  });
});

describe('buildAllTools', () => {
  it('should include built-in tools and MCP tools', () => {
    const catalog = buildToolCatalog(
      [
        {
          serverId: 's1',
          serverName: 'S1',
          tools: [
            { name: 'mcp_tool', description: 'An MCP tool', inputSchema: { type: 'object' } },
          ],
        },
      ],
      [{ id: 's1', name: 'S1', url: 'http://test', enabled: true, priority: 1 }]
    );

    const tools = buildAllTools(catalog);

    expect(tools.length).toBe(3);
    expect(tools.map((t) => t.name)).toContain('execute_code');
    expect(tools.map((t) => t.name)).toContain('get_tool_definitions');
    expect(tools.map((t) => t.name)).toContain('mcp_tool');
  });
});

describe('isBuiltInTool', () => {
  it('should identify built-in tools', () => {
    expect(isBuiltInTool('execute_code')).toBe(true);
    expect(isBuiltInTool('get_tool_definitions')).toBe(true);
    expect(isBuiltInTool('some_mcp_tool')).toBe(false);
  });
});

describe('getToolDefinitions', () => {
  it('should return definitions for requested tools', () => {
    const catalog = buildToolCatalog(
      [
        {
          serverId: 's1',
          serverName: 'S1',
          tools: [
            {
              name: 'tool1',
              description: 'Tool 1',
              inputSchema: { type: 'object', properties: { a: { type: 'string' } } },
            },
            {
              name: 'tool2',
              description: 'Tool 2',
              inputSchema: { type: 'object', properties: { b: { type: 'number' } } },
            },
          ],
        },
      ],
      [{ id: 's1', name: 'S1', url: 'http://test', enabled: true, priority: 1 }]
    );

    const defs = getToolDefinitions(catalog, ['tool1']);

    expect(Object.keys(defs)).toEqual(['tool1']);
    expect(defs['tool1']).toBeDefined();
  });

  it('should skip unknown tools', () => {
    const catalog = buildToolCatalog([], []);
    const defs = getToolDefinitions(catalog, ['nonexistent']);

    expect(Object.keys(defs)).toHaveLength(0);
  });
});
