/**
 * A Response whose body reports whether it was cancelled, so a test can check that
 * code which does not read a body still releases it.
 */
export interface TrackedResponse {
  response: Response;
  wasCancelled: () => boolean;
}

export function trackedResponse(
  status: number,
  options: { text?: string; headers?: Record<string, string> } = {}
): TrackedResponse {
  const { text = '{}', headers } = options;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      // Left open, so a cancel reaches cancel() below; a test that reads the body
      // uses a plain Response instead.
      controller.enqueue(new TextEncoder().encode(text));
    },
    cancel() {
      cancelled = true;
    },
  });
  return { response: new Response(body, { status, headers }), wasCancelled: () => cancelled };
}
