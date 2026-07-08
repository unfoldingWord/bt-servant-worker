import { describe, it, expect } from 'vitest';
import {
  buildToolCatalog,
  findTool,
  getToolNames,
  generateToolCatalog,
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

// Compact fixture helpers keep each `it`/`describe` callback under the
// repo's 50-line-per-function lint cap.
function oneToolManifest(
  serverId: string,
  toolName: string,
  description: string
): MCPServerManifest {
  return {
    serverId,
    serverName: serverId,
    tools: [{ name: toolName, description, inputSchema: { type: 'object', properties: {} } }],
  };
}

function serverCfg(id: string, name: string): MCPServerConfig {
  return { id, name, url: `http://${id}`, enabled: true, priority: 1 };
}

describe('generateToolCatalog', () => {
  it('should generate compact catalog format (lasker-api pattern)', () => {
    // Name + one-liner only (no parameter details); full schemas via get_tool_definitions.
    const catalog = buildToolCatalog(
      [oneToolManifest('s1', 'fetchData', 'Fetches data from source')],
      [serverCfg('s1', 'S1')]
    );

    const desc = generateToolCatalog(catalog);
    expect(desc).toContain('fetchData');
    expect(desc).toContain('Fetches data from source');
    expect(desc).toContain('| Tool | Description |');
    expect(desc).toContain('get_tool_definitions');
    // Tools are grouped under a per-server heading (issue #306).
    expect(desc).toContain('### S1');
  });

  it('should return message when no tools available', () => {
    const catalog = buildToolCatalog([], []);
    const desc = generateToolCatalog(catalog);
    expect(desc).toBe('No MCP tools are currently available.');
  });
});

describe('generateToolCatalog server grouping (#306)', () => {
  it('groups tools under per-server headings in first-seen order', () => {
    const catalog = buildToolCatalog(
      [
        oneToolManifest('translation-helps', 'fetch_scripture', 'Fetch Bible text for a passage.'),
        oneToolManifest('aquifer', 'scripture', 'Fetch Bible text from Aquifer resources.'),
      ],
      [serverCfg('translation-helps', 'Translation Helps MCP'), serverCfg('aquifer', 'Aquifer MCP')]
    );

    const desc = generateToolCatalog(catalog);
    const thHeading = desc.indexOf('### Translation Helps MCP');
    const aqHeading = desc.indexOf('### Aquifer MCP');
    expect(thHeading).toBeGreaterThanOrEqual(0);
    expect(aqHeading).toBeGreaterThan(thHeading);
    // escapeMarkdown escapes the underscore, so fetch_scripture renders escaped.
    const thTool = desc.indexOf('fetch\\_scripture');
    expect(thTool).toBeGreaterThan(thHeading);
    expect(thTool).toBeLessThan(aqHeading);
    // Aquifer's own `scripture` tool sits under the Aquifer heading.
    expect(desc.indexOf('| scripture |', aqHeading)).toBeGreaterThan(aqHeading);
  });

  it('falls back to the server id when no display name is configured', () => {
    // Construct a catalog directly with a tool whose serverId is absent from
    // serverMap (buildToolCatalog would drop such tools) to exercise the
    // `?? serverId` heading fallback.
    const catalog = {
      tools: [
        {
          name: 'lonelyTool',
          description: 'A tool whose server config is missing.',
          inputSchema: { type: 'object', properties: {} },
          serverId: 'orphan-server',
          serverUrl: 'http://orphan',
        },
      ],
      serverMap: new Map<string, MCPServerConfig>(),
    };

    const desc = generateToolCatalog(catalog);
    expect(desc).toContain('### orphan-server');
    expect(desc).toContain('lonelyTool');
  });
});
