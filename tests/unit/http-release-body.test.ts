import { describe, it, expect, vi } from 'vitest';
import { releaseBody } from '../../src/utils/http.js';
import { trackedResponse } from '../helpers/tracked-response.js';

describe('releaseBody', () => {
  it('cancels an unread body and leaves the status readable', async () => {
    const { response, wasCancelled } = trackedResponse(503);
    const onError = vi.fn();

    releaseBody(response, onError);

    await vi.waitFor(() => expect(wasCancelled()).toBe(true));
    expect(response.status).toBe(503);
    expect(onError).not.toHaveBeenCalled();
  });

  it('does nothing for a response without a body', () => {
    const onError = vi.fn();
    expect(() => releaseBody(new Response(null, { status: 202 }), onError)).not.toThrow();
    expect(onError).not.toHaveBeenCalled();
  });

  it('does nothing for a body that was already read', async () => {
    const response = new Response('{}');
    await response.text();
    const cancel = vi.spyOn(ReadableStream.prototype, 'cancel');
    const onError = vi.fn();

    releaseBody(response, onError);

    expect(cancel).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    cancel.mockRestore();
  });

  it('passes a failed cancel to onError instead of dropping it', async () => {
    const response = new Response('x');
    // A locked body cannot be cancelled: the cancel promise rejects.
    response.body?.getReader();
    const onError = vi.fn();

    releaseBody(response, onError);

    await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());
    expect(onError.mock.calls[0][0]).toBeInstanceOf(Error);
  });
});
