/**
 * Release the body of a response the caller will not read.
 *
 * The Workers runtime keeps a connection open until its response body is read or
 * cancelled, and allows only a few open connections per invocation. Past that limit
 * it cancels the oldest unread response and logs "A stalled HTTP response was
 * canceled to prevent deadlock", which can cut off a request that was still in use.
 * Every fetch whose body is not read calls this, whatever the status.
 *
 * Cancelling fails only for a body that is already locked or errored. The failure
 * goes to `onError` so the caller logs it with its own logger.
 */
export function releaseBody(response: Response, onError: (error: Error) => void): void {
  if (!response.body || response.bodyUsed) return;
  response.body.cancel().catch((err: unknown) => {
    onError(err instanceof Error ? err : new Error(String(err)));
  });
}
