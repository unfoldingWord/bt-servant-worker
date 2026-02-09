import { describe, it, expect } from 'vitest';
import {
  buildExecuteCodeTool,
  buildGetToolDefinitionsTool,
  buildReadMemoryTool,
  buildUpdateMemoryTool,
  buildAllTools,
  isBuiltInTool,
  isReadMemoryInput,
  isUpdateMemoryInput,
  getToolDefinitions,
} from '../../src/services/claude/tools.js';
import { buildToolCatalog } from '../../src/services/mcp/catalog.js';

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
  it('should only include meta-tools, not MCP tools (lasker-api pattern)', () => {
    // NOTE: MCP tools are NOT exposed directly to Claude anymore.
    // They're shown in the system prompt catalog and called via execute_code.
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

    // Meta-tools + memory tools, not MCP tools
    expect(tools.length).toBe(4);
    expect(tools.map((t) => t.name)).toContain('execute_code');
    expect(tools.map((t) => t.name)).toContain('get_tool_definitions');
    expect(tools.map((t) => t.name)).toContain('read_memory');
    expect(tools.map((t) => t.name)).toContain('update_memory');
    expect(tools.map((t) => t.name)).not.toContain('mcp_tool');
  });
});

describe('isBuiltInTool', () => {
  it('should identify built-in tools', () => {
    expect(isBuiltInTool('execute_code')).toBe(true);
    expect(isBuiltInTool('get_tool_definitions')).toBe(true);
    expect(isBuiltInTool('read_memory')).toBe(true);
    expect(isBuiltInTool('update_memory')).toBe(true);
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

describe('buildReadMemoryTool', () => {
  it('returns valid tool definition', () => {
    const tool = buildReadMemoryTool();
    expect(tool.name).toBe('read_memory');
    expect(tool.description).toContain('persistent user memory');
    expect(tool.input_schema.type).toBe('object');
  });
});

describe('buildUpdateMemoryTool', () => {
  it('returns valid tool definition', () => {
    const tool = buildUpdateMemoryTool();
    expect(tool.name).toBe('update_memory');
    expect(tool.description).toContain('persistent memory');
    expect(tool.input_schema.required).toContain('sections');
  });
});

describe('isReadMemoryInput', () => {
  it('accepts empty object (read full)', () => {
    expect(isReadMemoryInput({})).toBe(true);
  });

  it('rejects empty sections array', () => {
    expect(isReadMemoryInput({ sections: [] })).toBe(false);
  });

  it('accepts sections array with names', () => {
    expect(isReadMemoryInput({ sections: ['Progress', 'Notes'] })).toBe(true);
  });

  it('rejects non-object', () => {
    expect(isReadMemoryInput('string')).toBe(false);
    expect(isReadMemoryInput(null)).toBe(false);
  });

  it('rejects non-array sections', () => {
    expect(isReadMemoryInput({ sections: 'Progress' })).toBe(false);
  });

  it('rejects non-string array elements', () => {
    expect(isReadMemoryInput({ sections: [42] })).toBe(false);
  });

  it('rejects empty string section names', () => {
    expect(isReadMemoryInput({ sections: [''] })).toBe(false);
  });
});

describe('isUpdateMemoryInput', () => {
  it('accepts valid string updates', () => {
    expect(isUpdateMemoryInput({ sections: { Progress: 'Phase 1 done' } })).toBe(true);
  });

  it('accepts null values for deletion', () => {
    expect(isUpdateMemoryInput({ sections: { Old: null } })).toBe(true);
  });

  it('accepts mixed string and null values', () => {
    expect(isUpdateMemoryInput({ sections: { A: 'new', B: null } })).toBe(true);
  });

  it('rejects missing sections', () => {
    expect(isUpdateMemoryInput({})).toBe(false);
  });

  it('rejects empty sections object', () => {
    expect(isUpdateMemoryInput({ sections: {} })).toBe(false);
  });

  it('rejects non-object sections', () => {
    expect(isUpdateMemoryInput({ sections: 'bad' })).toBe(false);
    expect(isUpdateMemoryInput({ sections: [] })).toBe(false);
  });

  it('rejects non-string non-null values', () => {
    expect(isUpdateMemoryInput({ sections: { A: 42 } })).toBe(false);
  });

  it('rejects empty key names', () => {
    expect(isUpdateMemoryInput({ sections: { '': 'value' } })).toBe(false);
  });
});
