/**
 * Partner API keys and audio (admin-portal#354; audio decided 2026-11-02).
 *
 * Partners use voice the way internal clients do: audio in (transcribed and
 * archived as a voice submission) and audio out (TTS reply). Both download
 * routes accept a partner key, but ONLY for audio in that partner's own
 * partition (partnerOwnsAudioKey): anything else answers like a missing
 * object (404). STT and TTS are stubbed at their module boundary; R2 is the
 * real (miniflare) AUDIO_BUCKET.
 */

import { env, SELF } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PublicPartnerKey } from '../../src/types/partner-keys';
import { setupAnthropicFetchCapture } from '../helpers/anthropic-capture.js';

vi.mock('@anthropic-ai/sdk', () => ({ default: vi.fn() }));
vi.mock('../../src/services/audio/cloudflare-stt.js', () => ({
  transcribeAudio: vi.fn(async () => ({ text: 'hello from a voice note', duration_ms: 5 })),
}));
vi.mock('../../src/services/audio/openai-tts.js', () => ({
  synthesizeSpeech: vi.fn(async () => ({
    audio_base64: 'AQIDBA==',
    audio_bytes: new Uint8Array([1, 2, 3, 4]),
    audio_format: 'opus',
    duration_ms: 7,
    input_chars: 3,
  })),
}));

const INTERNAL = { Authorization: 'Bearer test-api-key' };
const JSON_INTERNAL = { ...INTERNAL, 'Content-Type': 'application/json' };
const KEYS = 'https://worker/api/v1/admin/api-keys';
const CHAT = 'https://worker/api/v1/chat';
const ORG = 'org-354-audio-out';
const W = 'https://worker';

type CreateBody = { key: PublicPartnerKey; apiKey: string };

async function createKey(): Promise<CreateBody> {
  const res = await SELF.fetch(KEYS, {
    method: 'POST',
    headers: JSON_INTERNAL,
    body: JSON.stringify({
      org: ORG,
      name: 'Audio key',
      app: 'Audio app',
      createdBy: 'tester@example.org',
      allow_new_org: true,
    }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as CreateBody;
}

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
const get = (path: string, token: string) => SELF.fetch(`${W}${path}`, { headers: bearer(token) });

async function putAudio(key: string): Promise<void> {
  await env.AUDIO_BUCKET.put(key, new Uint8Array([9, 9]), {
    httpMetadata: { contentType: 'audio/ogg' },
  });
}

/** Every R2 key under `prefix`. */
async function keysUnder(prefix: string): Promise<string[]> {
  return (await env.AUDIO_BUCKET.list({ prefix })).objects.map((o) => o.key);
}

beforeEach(() => {
  setupAnthropicFetchCapture();
});
afterEach(() => vi.restoreAllMocks());

describe('partner voice in and audio out', () => {
  it('a voice message is accepted, archived in the partner partition and answered with audio the key can download', async () => {
    const { key, apiKey } = await createKey();
    const res = await SELF.fetch(CHAT, {
      method: 'POST',
      headers: { ...bearer(apiKey), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: 'partner-app',
        user_id: 'alice',
        message_type: 'audio',
        audio_base64: 'T2dnUw==',
        audio_format: 'ogg',
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { voice_audio_url: string | null };
    expect(body.voice_audio_url).not.toBeNull();
    const ttsPath = new URL(body.voice_audio_url ?? '').pathname;
    expect(ttsPath).toContain(`/api/v1/audio/audio/${ORG}/partner:${key.userNamespace}:alice/`);
    expect((await get(ttsPath, apiKey)).status).toBe(200);

    const [archived] = await keysUnder(
      `voice-submissions/${ORG}/partner:${key.userNamespace}:alice/`
    );
    expect(archived).toBeDefined();
    expect((await get(`/api/v1/voice-submissions/${archived}`, apiKey)).status).toBe(200);
  });
});

describe('partner audio downloads are limited to the partner partition', () => {
  it("another partner's audio and an internal user's audio answer 404, like a missing object", async () => {
    const a = await createKey();
    const b = await createKey();
    const ownA = `audio/${ORG}/partner:${a.key.userNamespace}:u1/own.opus`;
    const ofB = `audio/${ORG}/partner:${b.key.userNamespace}:u1/b.opus`;
    const internal = `audio/${ORG}/bob/internal.opus`;
    const internalVoice = `voice-submissions/${ORG}/bob/bob/voice.ogg`;
    const otherOrg = `audio/unfoldingWord/partner:${a.key.userNamespace}:u1/x.opus`;
    for (const k of [ownA, ofB, internal, internalVoice, otherOrg]) await putAudio(k);

    expect((await get(`/api/v1/audio/${ownA}`, a.apiKey)).status).toBe(200);
    for (const k of [ofB, internal, otherOrg]) {
      const res = await get(`/api/v1/audio/${k}`, a.apiKey);
      expect(res.status, k).toBe(404);
      expect(await res.json()).toEqual({ error: 'Audio not found' });
    }
    const voice = await get(`/api/v1/voice-submissions/${internalVoice}`, a.apiKey);
    expect(voice.status).toBe(404);
    expect(await voice.json()).toEqual({ error: 'Voice submission not found' });

    // Internal callers are unchanged: they may read any of it.
    for (const k of [ofB, internal]) {
      expect((await get(`/api/v1/audio/${k}`, 'test-api-key')).status).toBe(200);
    }
  });

  it('a key with an extra path segment cannot pass as the partner partition', async () => {
    const a = await createKey();
    const shifted = `audio/${ORG}/partner:${a.key.userNamespace}:u1/extra/x.opus`;
    await putAudio(shifted);
    expect((await get(`/api/v1/audio/${shifted}`, a.apiKey)).status).toBe(404);
  });

  it('partner keys still cannot reach any other GET route', async () => {
    const a = await createKey();
    const res = await get(`/api/v1/orgs/${ORG}/users/alice/history`, a.apiKey);
    expect(res.status).toBe(403);
  });
});
