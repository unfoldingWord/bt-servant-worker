/**
 * E2E tests for UserSession Durable Object
 *
 * These tests run in the actual Cloudflare Workers runtime (via miniflare)
 * and test the real Durable Object implementation.
 */

/* eslint-disable max-lines-per-function */
import { env } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';

describe('UserSession Durable Object', () => {
  let stub: DurableObjectStub;

  beforeEach(() => {
    // Create a new Durable Object instance for each test
    const id = env.USER_SESSION.newUniqueId();
    stub = env.USER_SESSION.get(id);
  });

  describe('GET /preferences', () => {
    it('returns default preferences for new user', async () => {
      const response = await stub.fetch('http://fake-host/preferences');
      const data = (await response.json()) as Record<string, unknown>;

      expect(response.status).toBe(200);
      expect(data).toEqual({
        response_language: 'en',
      });
    });
  });

  describe('PUT /preferences - valid updates', () => {
    it('updates response_language with valid ISO 639-1 code', async () => {
      const response = await stub.fetch('http://fake-host/preferences', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ response_language: 'es' }),
      });
      const data = (await response.json()) as Record<string, unknown>;

      expect(response.status).toBe(200);
      expect(data.response_language).toBe('es');
    });

    it('persists preferences across requests', async () => {
      // Update preference
      await stub.fetch('http://fake-host/preferences', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ response_language: 'fr' }),
      });

      // Read it back
      const response = await stub.fetch('http://fake-host/preferences');
      const data = (await response.json()) as Record<string, unknown>;

      expect(data.response_language).toBe('fr');
    });
  });

  describe('PUT /preferences - invalid language codes', () => {
    it('rejects language code that is too long', async () => {
      const response = await stub.fetch('http://fake-host/preferences', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ response_language: 'english' }),
      });
      const data = (await response.json()) as Record<string, unknown>;

      expect(response.status).toBe(400);
      expect(data.error).toBe('Invalid response_language');
    });

    it('rejects uppercase language code', async () => {
      const response = await stub.fetch('http://fake-host/preferences', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ response_language: 'EN' }),
      });

      expect(response.status).toBe(400);
    });

    it('rejects language code that is too short', async () => {
      const response = await stub.fetch('http://fake-host/preferences', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ response_language: 'e' }),
      });

      expect(response.status).toBe(400);
    });

    it('rejects language code with numbers', async () => {
      const response = await stub.fetch('http://fake-host/preferences', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ response_language: '12' }),
      });

      expect(response.status).toBe(400);
    });

    it('rejects SQL injection attempt', async () => {
      const response = await stub.fetch('http://fake-host/preferences', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ response_language: "'; DROP TABLE users;--" }),
      });

      expect(response.status).toBe(400);
    });
  });

  describe('GET /history', () => {
    it('returns empty history for new user', async () => {
      const response = await stub.fetch('http://fake-host/history?user_id=test-user');
      const data = (await response.json()) as Record<string, unknown>;

      expect(response.status).toBe(200);
      expect(data.entries).toEqual([]);
      expect(data.total_count).toBe(0);
    });

    it('respects limit parameter', async () => {
      const response = await stub.fetch('http://fake-host/history?user_id=test-user&limit=10');
      const data = (await response.json()) as Record<string, unknown>;

      expect(response.status).toBe(200);
      expect(data.limit).toBe(10);
    });

    it('caps limit at MAX_HISTORY_ENTRIES (50)', async () => {
      const response = await stub.fetch('http://fake-host/history?user_id=test-user&limit=100');
      const data = (await response.json()) as Record<string, unknown>;

      expect(response.status).toBe(200);
      expect(data.limit).toBe(50);
    });
  });
});

describe('UserSession chat validation', () => {
  let stub: DurableObjectStub;

  beforeEach(() => {
    const id = env.USER_SESSION.newUniqueId();
    stub = env.USER_SESSION.get(id);
  });

  describe('POST /chat', () => {
    it('rejects empty message', async () => {
      const response = await stub.fetch('http://fake-host/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: 'test-client',
          user_id: 'test-user',
          message: '',
          message_type: 'text',
        }),
      });
      const data = (await response.json()) as Record<string, unknown>;

      expect(response.status).toBe(400);
      expect(data.error).toBe('Message is required');
    });

    it('rejects whitespace-only message', async () => {
      const response = await stub.fetch('http://fake-host/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: 'test-client',
          user_id: 'test-user',
          message: '   ',
          message_type: 'text',
        }),
      });
      const data = (await response.json()) as Record<string, unknown>;

      expect(response.status).toBe(400);
      expect(data.error).toBe('Message is required');
    });
  });
});

describe('UserSession MCP Server Admin', () => {
  let stub: DurableObjectStub;

  beforeEach(() => {
    // Use org-prefixed ID like the real admin routes do
    const id = env.USER_SESSION.idFromName('org:test-org');
    stub = env.USER_SESSION.get(id);
  });

  describe('GET /mcp-servers', () => {
    it('returns empty array for org with no servers', async () => {
      const response = await stub.fetch('http://fake-host/mcp-servers?org=test-org');
      const data = (await response.json()) as { org: string; servers: unknown[] };

      expect(response.status).toBe(200);
      expect(data.org).toBe('test-org');
      expect(data.servers).toEqual([]);
    });
  });

  describe('POST /mcp-servers', () => {
    it('adds a valid MCP server', async () => {
      const server = {
        id: 'test-server',
        name: 'Test Server',
        url: 'https://example.com/mcp',
        enabled: true,
        priority: 1,
      };

      const response = await stub.fetch('http://fake-host/mcp-servers?org=test-org', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(server),
      });
      const data = (await response.json()) as { servers: { id: string }[] };

      expect(response.status).toBe(200);
      expect(data.servers).toHaveLength(1);
      expect(data.servers[0].id).toBe('test-server');
    });

    it('rejects server with invalid URL', async () => {
      const server = {
        id: 'test-server',
        name: 'Test Server',
        url: 'not-a-valid-url',
        enabled: true,
        priority: 1,
      };

      const response = await stub.fetch('http://fake-host/mcp-servers?org=test-org', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(server),
      });

      expect(response.status).toBe(400);
    });

    it('rejects server with invalid ID format', async () => {
      const server = {
        id: 'invalid id with spaces!',
        name: 'Test Server',
        url: 'https://example.com/mcp',
        enabled: true,
        priority: 1,
      };

      const response = await stub.fetch('http://fake-host/mcp-servers?org=test-org', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(server),
      });

      expect(response.status).toBe(400);
    });

    it('accepts http URLs for local development', async () => {
      // HTTP URLs are allowed for local development scenarios
      const server = {
        id: 'test-server',
        name: 'Test Server',
        url: 'http://example.com/mcp',
        enabled: true,
        priority: 1,
      };

      const response = await stub.fetch('http://fake-host/mcp-servers?org=test-org', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(server),
      });

      expect(response.status).toBe(200);
    });
  });

  describe('PUT /mcp-servers', () => {
    it('replaces all servers for an org', async () => {
      const servers = [
        { id: 'server-1', name: 'Server 1', url: 'https://a.com', enabled: true, priority: 1 },
        { id: 'server-2', name: 'Server 2', url: 'https://b.com', enabled: true, priority: 2 },
      ];

      const response = await stub.fetch('http://fake-host/mcp-servers?org=test-org', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(servers),
      });
      const data = (await response.json()) as { servers: unknown[] };

      expect(response.status).toBe(200);
      expect(data.servers).toHaveLength(2);
    });

    it('rejects non-array body', async () => {
      const response = await stub.fetch('http://fake-host/mcp-servers?org=test-org', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'single-server' }),
      });

      expect(response.status).toBe(400);
    });
  });

  describe('DELETE /mcp-servers/:serverId', () => {
    it('removes a server by ID', async () => {
      // Use unique org to avoid state conflicts with other tests
      const deleteStub = env.USER_SESSION.get(env.USER_SESSION.idFromName('org:delete-test-org'));

      // First add a server
      await deleteStub.fetch('http://fake-host/mcp-servers?org=delete-test-org', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: 'to-delete',
          name: 'Delete Me',
          url: 'https://delete.com',
          enabled: true,
          priority: 1,
        }),
      });

      // Then delete it
      const response = await deleteStub.fetch(
        'http://fake-host/mcp-servers/to-delete?org=delete-test-org',
        { method: 'DELETE' }
      );
      const data = (await response.json()) as { servers: unknown[] };

      expect(response.status).toBe(200);
      expect(data.servers).toHaveLength(0);
    });
  });

  describe('org isolation', () => {
    it('servers from one org are not visible to another', async () => {
      // Add server to test-org
      const org1Stub = env.USER_SESSION.get(env.USER_SESSION.idFromName('org:test-org-1'));
      await org1Stub.fetch('http://fake-host/mcp-servers?org=test-org-1', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: 'org1-server',
          name: 'Org 1 Server',
          url: 'https://org1.com',
          enabled: true,
          priority: 1,
        }),
      });

      // Check test-org-2 doesn't see it
      const org2Stub = env.USER_SESSION.get(env.USER_SESSION.idFromName('org:test-org-2'));
      const response = await org2Stub.fetch('http://fake-host/mcp-servers?org=test-org-2');
      const data = (await response.json()) as { servers: unknown[] };

      expect(data.servers).toHaveLength(0);
    });
  });
});

/**
 * Real chat tests that call the Anthropic API.
 * These tests verify the full chat flow with Claude.
 *
 * Requirements:
 * - ANTHROPIC_API_KEY must be set in .dev.vars (local) or environment (CI)
 * - These tests cost money (API calls)
 * - These tests are slower (2-10+ seconds each)
 *
 * These tests check for the API key at runtime via the miniflare bindings.
 */
describe('UserSession real chat (requires ANTHROPIC_API_KEY)', () => {
  let stub: DurableObjectStub;

  beforeEach(() => {
    const id = env.USER_SESSION.newUniqueId();
    stub = env.USER_SESSION.get(id);
  });

  // Check API key from miniflare bindings at runtime
  const skipIfNoApiKey = () => {
    // @ts-expect-error - ANTHROPIC_API_KEY is set via miniflare bindings
    if (!env.ANTHROPIC_API_KEY) {
      return true;
    }
    return false;
  };

  it('responds to a simple message with valid structure', async (ctx) => {
    if (skipIfNoApiKey()) {
      ctx.skip();
      return;
    }
    const response = await stub.fetch('http://fake-host/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: 'e2e-test',
        user_id: 'e2e-test-user',
        message: 'Say "test successful" and nothing else.',
        message_type: 'text',
      }),
    });

    expect(response.status).toBe(200);

    const data = (await response.json()) as {
      responses: string[];
      response_language: string;
      voice_audio_base64: string | null;
    };

    // Verify response structure
    expect(data).toHaveProperty('responses');
    expect(data).toHaveProperty('response_language');
    expect(data).toHaveProperty('voice_audio_base64');

    // Verify responses is a non-empty array
    expect(Array.isArray(data.responses)).toBe(true);
    expect(data.responses.length).toBeGreaterThan(0);

    // Verify response_language is a string
    expect(typeof data.response_language).toBe('string');
  }, 30000); // 30 second timeout for API call

  it('saves chat to history after successful response', async (ctx) => {
    if (skipIfNoApiKey()) {
      ctx.skip();
      return;
    }
    const testMessage = 'Reply with exactly: history test';

    // Send a chat message
    const chatResponse = await stub.fetch('http://fake-host/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: 'e2e-test',
        user_id: 'e2e-history-user',
        message: testMessage,
        message_type: 'text',
      }),
    });

    expect(chatResponse.status).toBe(200);

    // Check history now has an entry
    const historyResponse = await stub.fetch('http://fake-host/history?user_id=e2e-history-user');
    const historyData = (await historyResponse.json()) as {
      entries: Array<{ user_message: string; assistant_response: string }>;
      total_count: number;
    };

    expect(historyData.total_count).toBe(1);
    expect(historyData.entries.length).toBe(1);
    expect(historyData.entries[0].user_message).toBe(testMessage);
    expect(historyData.entries[0].assistant_response.length).toBeGreaterThan(0);
  }, 30000); // 30 second timeout for API call

  it('works without MCP servers configured', async (ctx) => {
    if (skipIfNoApiKey()) {
      ctx.skip();
      return;
    }
    // This test verifies Claude responds even when no MCP tools are available
    const response = await stub.fetch('http://fake-host/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: 'e2e-test',
        user_id: 'e2e-no-mcp-user',
        message: 'What is 2+2? Reply with just the number.',
        message_type: 'text',
      }),
    });

    expect(response.status).toBe(200);

    const data = (await response.json()) as { responses: string[] };
    expect(data.responses.length).toBeGreaterThan(0);
    // Claude should be able to answer basic questions without tools
    expect(data.responses.join(' ')).toMatch(/4/);
  }, 30000); // 30 second timeout for API call
});
