/**
 * Status emitter (issue #405).
 *
 * Binds a turn's `StreamCallbacks.onStatus` to the user's locale so every
 * site that reports progress — the orchestrator loop, the DO's voice
 * pipeline — emits by key (`emit('status_transcribing')`) and never handles
 * text or locale itself.
 *
 * Neutral module on purpose: `services/claude/orchestrator.ts` and
 * `durable-objects/user-do.ts` both import it, and it imports neither.
 */

import type { StreamCallbacks } from '../types/engine.js';
import type { RequestLogger } from '../utils/logger.js';
import { statusUpdate, type StatusKey, type UiStringParams } from './ui-strings.js';

/** Emits one worker-authored status line by key. Never rejects. */
export type StatusEmitter = (key: StatusKey, params?: UiStringParams) => Promise<void>;

/**
 * Bind `callbacks.onStatus` to `locale`. `undefined` callbacks → `undefined`
 * (nothing to emit to; callers keep their `emit?.()` gating).
 *
 * A status line is a courtesy, never the turn: a callback that throws or
 * rejects is logged here and swallowed, so no call site needs its own guard.
 */
export function createStatusEmitter(
  callbacks: StreamCallbacks | undefined,
  locale: string,
  logger: RequestLogger
): StatusEmitter | undefined {
  if (!callbacks) return undefined;
  return async (key, params) => {
    try {
      await callbacks.onStatus(statusUpdate(locale, key, params));
    } catch (error) {
      logger.warn('status_callback_failed', {
        key,
        error: error instanceof Error ? error.message : String(error),
      });
      // Explicitly continue — the turn must not fail because a status line did.
    }
  };
}
