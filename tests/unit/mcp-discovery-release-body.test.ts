/**
 * The JSON-RPC client must release the body of every response it does not read:
 * an error status or an oversized Content-Length throws before the body is touched,
 * and the Workers runtime keeps such a connection open until the invocation ends.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { callMCPTool, discoverServerTools } from '../../src/services/mcp/discovery.js';
import { MCPServerConfig } from '../../src/services/mcp/types.js';
import { createRequestLogger } from '../../src/utils/logger.js';
import { trackedResponse } from '../helpers/tracked-response.js';

const logger = createRequestLogger('test-request');

const SERVER: MCPServerConfig = {
  id: 'translation-helps',
  name: 'Translation Helps MCP',
  url: 'https://mock-mcp.example.com/api/mcp',
  enabled: true,
  priority: 1,
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('JSON-RPC MCP client releases response bodies it does not read', () => {
  it('on an error status from tools/call', async () => {
    const { response, wasCancelled } = trackedResponse(503);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));

    await expect(callMCPTool(SERVER, 'get_note', {}, logger)).rejects.toThrow('503');

    await vi.waitFor(() => expect(wasCancelled()).toBe(true));
  });

  it('on a Content-Length over the size limit', async () => {
    const { response, wasCancelled } = trackedResponse(200, {
      headers: { 'Content-Length': '1000000000' },
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));

    await expect(callMCPTool(SERVER, 'get_note', {}, logger)).rejects.toThrow();

    await vi.waitFor(() => expect(wasCancelled()).toBe(true));
  });

  it('on an error status from tools/list during discovery', async () => {
    const { response, wasCancelled } = trackedResponse(500);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));

    const manifest = await discoverServerTools(SERVER, logger);

    expect(manifest.tools).toEqual([]);
    expect(manifest.error).toContain('500');

    await vi.waitFor(() => expect(wasCancelled()).toBe(true));
  });
});
