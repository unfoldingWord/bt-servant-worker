/**
 * Callback-path wiring for the per-mode first-contact welcome (#311).
 *
 * The WhatsApp/webhook transport delivers each send as a discrete message and
 * slices the model's answer against a running `lastSentText` cursor. The bug
 * this covers: prepending the welcome into the final `responses` array made
 * `buildOnComplete` slice `join('\n')` (welcome + answer) against a cursor that
 * only ever saw the model's text — garbling the final message.
 *
 * The fix delivers the welcome via its OWN `onWelcome` send, ahead of the
 * model, and keeps it OUT of the `responses` the completion callback slices.
 * These tests drive `createWebhookCallbacks` with a real `ProgressCallbackSender`
 * whose POSTs are captured, and assert the welcome is its own message and the
 * model deltas keep their prefix invariant.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createWebhookCallbacks,
  ProgressCallbackSender,
} from '../../src/services/progress/callback.js';
import type { RequestLogger } from '../../src/utils/logger.js';
import type { ChatResponse } from '../../src/types/engine.js';

const WELCOME =
  'Welcome to Spoken mode!\n\nShare this mode: https://wa.me/15558196461?text=%23spoken';

function noopLogger(): RequestLogger {
  return { log: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as RequestLogger;
}

interface CapturedPost {
  type: string;
  text?: string;
}

function setup(status = 200, suppressProgressText = false) {
  const posts: CapturedPost[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: unknown, init: { body: string }) => {
      posts.push(JSON.parse(init.body) as CapturedPost);
      return new Response(null, { status });
    })
  );
  const logger = noopLogger();
  const sender = new ProgressCallbackSender(
    { url: 'https://callback.example', user_id: 'u', message_key: 'k', token: 't' },
    logger
  );
  const callbacks = createWebhookCallbacks(sender, logger, {
    mode: 'iteration',
    throttleSeconds: 5,
    suppressProgressText,
  });
  return { posts, callbacks };
}

function completion(responses: string[]): ChatResponse {
  return {
    responses,
    response_language: 'en',
    voice_audio_base64: null,
    voice_audio_url: null,
  };
}

describe('#311 callback wiring — welcome as its own message', () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it('delivers the welcome as its own webhook message before the model answer', async () => {
    const { posts, callbacks } = setup();

    // Welcome first (processChat sends it before orchestration runs).
    await callbacks.onWelcome!(WELCOME);
    // Then a single-iteration model answer.
    callbacks.onIterationComplete!('The answer.');
    callbacks.onComplete(completion(['The answer.']));

    await vi.waitFor(() => expect(posts.length).toBeGreaterThanOrEqual(2));

    // The very first message carries the welcome + share link, on its own.
    expect(posts[0]?.text).toBe(WELCOME);
    // The model's delta is a separate message and never carries the welcome.
    const modelPosts = posts.slice(1);
    expect(modelPosts.map((p) => p.text)).toContain('The answer.');
    for (const p of modelPosts) {
      expect(p.text ?? '').not.toContain('Welcome to Spoken mode!');
      expect(p.text ?? '').not.toContain('wa.me');
    }
  });

  it('does NOT garble a multi-iteration (tool-using) turn — model deltas keep their prefix invariant', async () => {
    const { posts, callbacks } = setup();

    await callbacks.onWelcome!(WELCOME);
    // Iteration deltas arrive as cumulative model text (join of ctx.responses).
    callbacks.onIterationComplete!('Let me search');
    callbacks.onIterationComplete!('Let me search\nHere is the answer');
    // Completion receives MODEL responses only (the welcome is NOT prepended).
    callbacks.onComplete(completion(['Let me search', 'Here is the answer']));

    await vi.waitFor(() => expect(posts.length).toBeGreaterThanOrEqual(3));

    // posts[0] is the welcome; the rest are the model's clean, additive deltas.
    expect(posts[0]?.text).toBe(WELCOME);
    const modelDeltas = posts.slice(1).map((p) => p.text ?? '');
    // Reassembling the model deltas yields exactly the model's answer — no
    // welcome prefix bleeding in, no dropped/duplicated characters.
    expect(modelDeltas.join('')).toBe('Let me search\nHere is the answer');
    for (const text of modelDeltas) {
      expect(text).not.toContain('Welcome to Spoken mode!');
    }
  });

  it('onWelcome rejects on a webhook failure so the caller can withhold the flag', async () => {
    const { callbacks } = setup(503);
    await expect(callbacks.onWelcome!(WELCOME)).rejects.toThrow(/503/);
  });

  it('#428: welcome still delivers when intermediate text progress is suppressed (voice turn)', async () => {
    const { posts, callbacks } = setup(200, true);

    // Voice turns suppress the iteration-narration channel entirely...
    expect(callbacks.onIterationComplete).toBeUndefined();

    // ...but a first-contact voice message must still get its welcome.
    await callbacks.onWelcome!(WELCOME);
    callbacks.onComplete(completion(['The answer.']));

    await vi.waitFor(() => expect(posts.length).toBe(2));
    expect(posts[0]?.text).toBe(WELCOME);
    expect(posts[1]?.type).toBe('complete');
    expect(posts[1]?.text).toBe('The answer.');
  });
});
