/**
 * E2E tests for the per-mode first-contact welcome (#311).
 *
 * Drives real `/chat/final` turns through a UserDO with the Anthropic call
 * intercepted at `globalThis.fetch` (the mock answers a single `ok` text
 * block). A `#<slug>` trigger that resolves a NEW mode for the user emits a
 * one-time welcome — the mode's authored `welcome_message` plus a deterministic
 * `wa.me` share line — as its own `responses` entry ahead of the model answer,
 * and sets a `mode_welcomed:<slug>` DO storage flag so it never repeats.
 */

import { env, runInDurableObject } from 'cloudflare:test';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  buildChatBody,
  postChatFinalJson,
  setupAnthropicFetchCapture,
} from '../helpers/anthropic-capture.js';
import type { ChatRequest } from '../../src/types/engine.js';
import type { OrgModes, PromptMode } from '../../src/types/prompt-overrides.js';
import type { UserPreferencesInternal } from '../../src/types/engine.js';

// The SDK constructor must be stubbed (hoisted per file) even though the turn
// is intercepted at globalThis.fetch; see anthropic-capture.ts.
vi.mock('@anthropic-ai/sdk', () => ({ default: vi.fn() }));

const SPOKEN: PromptMode = {
  name: 'spoken',
  label: 'Spoken',
  published: true,
  welcome_message: 'Welcome to Spoken mode!',
  overrides: {},
};

const FIA: PromptMode = {
  name: 'fia-coach',
  label: 'FIA Coach',
  published: true,
  welcome_message: 'FIA coaching starts here.',
  overrides: {},
};

// A published mode that did NOT opt in — no welcome_message.
const SILENT: PromptMode = {
  name: 'silent',
  label: 'Silent',
  published: true,
  overrides: {},
};

const ORG_MODES: OrgModes = { modes: [SPOKEN, FIA, SILENT] };

/** A text chat body carrying the org modes and a leading `#`-trigger message. */
function triggerBody(message: string): ChatRequest {
  return buildChatBody({ message, _org_modes: ORG_MODES });
}

/** Read the raw `mode_welcomed:<slug>` flag straight from DO storage. */
function readWelcomedFlag(stub: DurableObjectStub, slug: string): Promise<boolean | undefined> {
  return runInDurableObject(stub, (_instance, state) =>
    state.storage.get<boolean>(`mode_welcomed:${slug}`)
  );
}

/** Seed a raw preferences record directly into DO storage. */
function seedStoredPreferences(
  stub: DurableObjectStub,
  prefs: UserPreferencesInternal
): Promise<void> {
  return runInDurableObject(stub, (_instance, state) => state.storage.put('preferences', prefs));
}

describe('per-mode first-contact welcome (#311)', () => {
  let stub: DurableObjectStub;

  beforeEach(() => {
    stub = env.USER_DO.get(env.USER_DO.newUniqueId());
    setupAnthropicFetchCapture();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('emits the welcome as its own responses entry on first #mode scan and sets the flag', async () => {
    const result = await postChatFinalJson(stub, triggerBody('#spoken hi'));

    // Welcome rides ahead of the model answer ('ok' from the mock).
    expect(result.responses).toHaveLength(2);
    expect(result.responses[0]).toContain('Welcome to Spoken mode!');
    expect(result.responses[1]).toBe('ok');

    // Deterministic wa.me share link is present with the mode's #trigger.
    expect(result.responses[0]).toContain('https://wa.me/15558196461?text=%23spoken');

    // One-time flag is now set.
    expect(await readWelcomedFlag(stub, 'spoken')).toBe(true);
  });

  it('does NOT re-emit the welcome on a second turn in the same mode', async () => {
    await postChatFinalJson(stub, triggerBody('#spoken hi'));
    // Second turn: mode already active + already welcomed.
    const second = await postChatFinalJson(stub, triggerBody('#spoken again'));

    expect(second.responses).toHaveLength(1);
    expect(second.responses[0]).toBe('ok');
  });

  it('emits a welcome for a DIFFERENT mode the user switches into', async () => {
    await postChatFinalJson(stub, triggerBody('#spoken hi'));
    const switched = await postChatFinalJson(stub, triggerBody('#fia-coach hello'));

    expect(switched.responses).toHaveLength(2);
    expect(switched.responses[0]).toContain('FIA coaching starts here.');
    expect(switched.responses[0]).toContain('https://wa.me/15558196461?text=%23fia-coach');
    expect(await readWelcomedFlag(stub, 'fia-coach')).toBe(true);
  });

  it('still welcomes an EXISTING user (first_interaction: false) on their first scan', async () => {
    await seedStoredPreferences(stub, { response_language: 'en', first_interaction: false });

    const result = await postChatFinalJson(stub, triggerBody('#spoken hi'));

    expect(result.responses).toHaveLength(2);
    expect(result.responses[0]).toContain('Welcome to Spoken mode!');
    expect(await readWelcomedFlag(stub, 'spoken')).toBe(true);
  });

  it('emits NO welcome for a mode without welcome_message (opt-in)', async () => {
    const result = await postChatFinalJson(stub, triggerBody('#silent hi'));

    expect(result.responses).toHaveLength(1);
    expect(result.responses[0]).toBe('ok');
    // No opt-in copy ⇒ no flag written either.
    expect(await readWelcomedFlag(stub, 'silent')).toBeUndefined();
  });
});
