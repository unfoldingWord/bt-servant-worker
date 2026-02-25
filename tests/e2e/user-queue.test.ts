/**
 * E2E tests for UserQueue Durable Object
 *
 * These tests run in the actual Cloudflare Workers runtime (via miniflare)
 * and test the UserQueue implementation (alarm-based per-user message queue).
 */

/* eslint-disable max-lines-per-function */
import { env } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';
import { EnqueueResponse, PollResponse, QueueStatusResponse } from '../../src/types/queue.js';

describe('UserQueue Durable Object', () => {
  let stub: DurableObjectStub;

  beforeEach(() => {
    const id = env.USER_QUEUE.newUniqueId();
    stub = env.USER_QUEUE.get(id);
  });

  describe('GET /status', () => {
    it('returns empty queue for new instance', async () => {
      const response = await stub.fetch('http://fake-host/status');
      const data = (await response.json()) as QueueStatusResponse;

      expect(response.status).toBe(200);
      expect(data.queue_length).toBe(0);
      expect(data.processing).toBe(false);
      expect(data.stored_response_count).toBe(0);
    });
  });

  describe('POST /enqueue', () => {
    it('returns 202 with message_id and queue_position', async () => {
      const response = await stub.fetch('http://fake-host/enqueue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user_id: 'test-user',
          client_id: 'test-client',
          message: 'Hello',
          message_type: 'text',
          org: 'test-org',
          delivery: 'sse',
        }),
      });

      expect(response.status).toBe(202);
      const data = (await response.json()) as EnqueueResponse;
      expect(data.message_id).toBeDefined();
      expect(typeof data.message_id).toBe('string');
      expect(data.message_id.length).toBeGreaterThan(0);
      expect(data.queue_position).toBe(1);
    });

    it('increments queue position for multiple enqueues (FIFO ordering)', async () => {
      const response1 = await stub.fetch('http://fake-host/enqueue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user_id: 'test-user',
          client_id: 'test-client',
          message: 'First message',
          message_type: 'text',
          org: 'test-org',
          delivery: 'sse',
        }),
      });
      const data1 = (await response1.json()) as EnqueueResponse;

      const response2 = await stub.fetch('http://fake-host/enqueue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user_id: 'test-user',
          client_id: 'test-client',
          message: 'Second message',
          message_type: 'text',
          org: 'test-org',
          delivery: 'sse',
        }),
      });
      const data2 = (await response2.json()) as EnqueueResponse;

      expect(data1.queue_position).toBe(1);
      expect(data2.queue_position).toBe(2);
      expect(data1.message_id).not.toBe(data2.message_id);
    });

    it('returns 429 when queue depth limit is exceeded', async () => {
      // Default MAX_QUEUE_DEPTH is 50. Fire 51 concurrent requests so the DO's
      // input gate serializes them all before the alarm gets a chance to drain.
      const makeRequest = (i: number) =>
        stub.fetch('http://fake-host/enqueue', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            user_id: 'test-user',
            client_id: 'test-client',
            message: `Message ${i}`,
            message_type: 'text',
            org: 'test-org',
            delivery: 'sse',
          }),
        });

      const responses = await Promise.all(Array.from({ length: 51 }, (_, i) => makeRequest(i)));
      const statuses = responses.map((r) => r.status);

      // First 50 should be 202, the 51st should be 429
      const accepted = statuses.filter((s) => s === 202);
      const rejected = statuses.filter((s) => s === 429);

      expect(accepted.length).toBe(50);
      expect(rejected.length).toBe(1);

      // Verify the rejected response has the right shape
      const rejectedResponse = responses.find((r) => r.status === 429)!;
      const data = (await rejectedResponse.json()) as { error: string; code: string };
      expect(data.code).toBe('QUEUE_DEPTH_EXCEEDED');
      expect(rejectedResponse.headers.get('Retry-After')).toBe('5');
    });

    it('rejects enqueue with missing required fields', async () => {
      const response = await stub.fetch('http://fake-host/enqueue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          // Missing user_id, message, etc.
          client_id: 'test-client',
        }),
      });

      expect(response.status).toBe(400);
    });

    it('reflects queue length in status after enqueue', async () => {
      await stub.fetch('http://fake-host/enqueue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user_id: 'test-user',
          client_id: 'test-client',
          message: 'Hello',
          message_type: 'text',
          org: 'test-org',
          delivery: 'sse',
        }),
      });

      const statusResponse = await stub.fetch('http://fake-host/status');
      const statusData = (await statusResponse.json()) as QueueStatusResponse;

      // Queue length should be >= 1 (may have started processing via alarm)
      expect(statusData.queue_length + (statusData.processing ? 1 : 0)).toBeGreaterThanOrEqual(1);
    });
  });

  describe('GET /stream', () => {
    it('returns 400 without message_id param', async () => {
      const response = await stub.fetch('http://fake-host/stream');

      expect(response.status).toBe(400);
      const data = (await response.json()) as { error: string };
      expect(data.error).toContain('message_id');
    });

    // NOTE: Testing live SSE streams (open-ended TransformStream responses) is not
    // possible in miniflare because stub.fetch() waits for the entire response body
    // to complete before resolving. The SSE Content-Type and streaming behavior are
    // verified by the implementation and by manual testing with `pnpm dev`.
  });

  describe('GET /poll', () => {
    it('returns 400 without message_id param', async () => {
      const response = await stub.fetch('http://fake-host/poll');

      expect(response.status).toBe(400);
      const data = (await response.json()) as { error: string };
      expect(data.error).toContain('message_id');
    });

    it('returns empty events for unknown message_id', async () => {
      const response = await stub.fetch('http://fake-host/poll?message_id=nonexistent&cursor=0');

      expect(response.status).toBe(200);
      const data = (await response.json()) as PollResponse;
      expect(data.message_id).toBe('nonexistent');
      expect(data.events).toEqual([]);
      expect(data.done).toBe(false);
      expect(data.cursor).toBe(0);
    });

    it('returns events after enqueue with default cursor', async () => {
      // Enqueue a message first
      const enqueueResponse = await stub.fetch('http://fake-host/enqueue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user_id: 'test-user',
          client_id: 'test-client',
          message: 'Hello',
          message_type: 'text',
          org: 'test-org',
          delivery: 'sse',
        }),
      });
      const { message_id } = (await enqueueResponse.json()) as EnqueueResponse;

      // Poll immediately — message is queued but likely not processed yet
      const pollResponse = await stub.fetch(
        `http://fake-host/poll?message_id=${message_id}&cursor=0`
      );

      expect(pollResponse.status).toBe(200);
      const data = (await pollResponse.json()) as PollResponse;
      expect(data.message_id).toBe(message_id);
      // Events may be empty (not yet processed) or have data (alarm ran fast)
      expect(Array.isArray(data.events)).toBe(true);
      expect(typeof data.done).toBe('boolean');
      expect(typeof data.cursor).toBe('number');
    });
  });

  describe('Unknown paths', () => {
    it('returns 404 for unknown path', async () => {
      const response = await stub.fetch('http://fake-host/nonexistent');

      expect(response.status).toBe(404);
    });
  });
});
