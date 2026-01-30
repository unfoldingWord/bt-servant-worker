import { describe, it, expect } from 'vitest';
import {
  buildToolCatalog,
  findTool,
  getToolNames,
  generateToolDescriptions,
} from '../../src/services/mcp/catalog.js';
import type { MCPServerConfig, MCPServerManifest } from '../../src/services/mcp/types.js';

describe('buildToolCatalog', () => {
  const mockServer: MCPServerConfig = {
    id: 'test-server',
    name: 'Test Server',
    url: 'https://test.example.com',
    enabled: true,
    priority: 1,
  };

  const mockManifest: MCPServerManifest = {
    serverId: 'test-server',
    serverName: 'Test Server',
    tools: [
      {
        name: 'fetch_scripture',
        description: 'Fetches scripture passages',
        inputSchema: {
          type: 'object',
          properties: {
            book: { type: 'string', description: 'Book name' },
            chapter: { type: 'number', description: 'Chapter number' },
          },
          required: ['book', 'chapter'],
        },
      },
    ],
  };

  it('should build catalog from manifests', () => {
    const catalog = buildToolCatalog([mockManifest], [mockServer]);

    expect(catalog.tools).toHaveLength(1);
    expect(catalog.tools[0]?.name).toBe('fetch_scripture');
    expect(catalog.tools[0]?.serverId).toBe('test-server');
    expect(catalog.serverMap.get('test-server')).toEqual(mockServer);
  });

  it('should handle name collisions by prefixing with server ID', () => {
    const secondServer: MCPServerConfig = {
      ...mockServer,
      id: 'second-server',
    };
    const secondManifest: MCPServerManifest = {
      serverId: 'second-server',
      serverName: 'Second Server',
      tools: [{ ...mockManifest.tools[0]!, name: 'fetch_scripture' }],
    };

    const catalog = buildToolCatalog([mockManifest, secondManifest], [mockServer, secondServer]);

    expect(catalog.tools).toHaveLength(2);
    expect(catalog.tools.map((t) => t.name)).toContain('fetch_scripture');
    expect(catalog.tools.map((t) => t.name)).toContain('second-server_fetch_scripture');
  });
});

describe('findTool', () => {
  it('should find tool by name', () => {
    const catalog = buildToolCatalog(
      [
        {
          serverId: 's1',
          serverName: 'S1',
          tools: [{ name: 'tool1', description: 'desc', inputSchema: { type: 'object' } }],
        },
      ],
      [{ id: 's1', name: 'S1', url: 'http://test', enabled: true, priority: 1 }]
    );

    expect(findTool(catalog, 'tool1')).toBeDefined();
    expect(findTool(catalog, 'nonexistent')).toBeUndefined();
  });
});

describe('getToolNames', () => {
  it('should return all tool names', () => {
    const catalog = buildToolCatalog(
      [
        {
          serverId: 's1',
          serverName: 'S1',
          tools: [
            { name: 'tool1', description: 'd1', inputSchema: { type: 'object' } },
            { name: 'tool2', description: 'd2', inputSchema: { type: 'object' } },
          ],
        },
      ],
      [{ id: 's1', name: 'S1', url: 'http://test', enabled: true, priority: 1 }]
    );

    expect(getToolNames(catalog)).toEqual(['tool1', 'tool2']);
  });
});

describe('generateToolDescriptions', () => {
  it('should generate compact catalog format (lasker-api pattern)', () => {
    // NOTE: The new format shows name + one-liner only (no parameter details).
    // Full schemas are retrieved via get_tool_definitions.
    const catalog = buildToolCatalog(
      [
        {
          serverId: 's1',
          serverName: 'S1',
          tools: [
            {
              name: 'fetchData',
              description: 'Fetches data from source',
              inputSchema: {
                type: 'object',
                properties: {
                  id: { type: 'string', description: 'The item ID' },
                },
                required: ['id'],
              },
            },
          ],
        },
      ],
      [{ id: 's1', name: 'S1', url: 'http://test', enabled: true, priority: 1 }]
    );

    const desc = generateToolDescriptions(catalog);
    expect(desc).toContain('fetchData');
    expect(desc).toContain('Fetches data from source');
    // New format does NOT include parameter details - they're fetched on-demand
    expect(desc).toContain('| Tool | Description |');
    expect(desc).toContain('get_tool_definitions');
  });

  it('should return message when no tools available', () => {
    const catalog = buildToolCatalog([], []);
    const desc = generateToolDescriptions(catalog);
    expect(desc).toBe('No MCP tools are currently available.');
  });
});
