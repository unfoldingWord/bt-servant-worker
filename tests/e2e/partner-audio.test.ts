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

import { env, runInDurableObject, SELF } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PublicPartnerKey } from '../../src/types/partner-keys';
import { setupAnthropicFetchCapture } from '../helpers/anthropic-capture.js';
import { PARTNER_KEY_STORE_NAME } from '../../src/services/partner-keys/store';

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

  it('HEAD is allowed like GET and scoped the same way', async () => {
    const a = await createKey();
    const b = await createKey();
    const ownA = `audio/${ORG}/partner:${a.key.userNamespace}:u1/head.opus`;
    const ofB = `audio/${ORG}/partner:${b.key.userNamespace}:u1/head.opus`;
    const voiceA = `voice-submissions/${ORG}/partner:${a.key.userNamespace}:c1/u1/head.ogg`;
    for (const k of [ownA, ofB, voiceA]) await putAudio(k);
    const head = (path: string) =>
      SELF.fetch(`${W}${path}`, { method: 'HEAD', headers: bearer(a.apiKey) });

    expect((await head(`/api/v1/audio/${ownA}`)).status).toBe(200);
    expect((await head(`/api/v1/voice-submissions/${voiceA}`)).status).toBe(200);
    expect((await head(`/api/v1/audio/${ofB}`)).status).toBe(404);
    // HEAD on a route outside the allowlist is refused like any other verb.
    expect((await head(`/api/v1/orgs/${ORG}/users/u1/history`)).status).toBe(403);
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

/** A shared-key user `leg1` whose history references a TTS reply, a voice message and a missing object. */
async function seedLegacyUser(): Promise<{ tts: string; voice: string }> {
  const chat = await SELF.fetch(CHAT, {
    method: 'POST',
    headers: JSON_INTERNAL,
    body: JSON.stringify({
      client_id: 'shema',
      org: ORG,
      user_id: 'leg1',
      message: 'hi',
      message_type: 'text',
    }),
  });
  expect(chat.status).toBe(200);
  const tts = `audio/${ORG}/leg1/t1.opus`;
  const voice = `voice-submissions/${ORG}/leg1/leg1/v1.ogg`;
  await putAudio(tts);
  await putAudio(voice);
  const source = env.USER_DO.get(env.USER_DO.idFromName(`user:${ORG}:leg1`));
  await runInDurableObject(source, async (_i, state) => {
    await state.storage.put('history', [
      { user_message: 'a', assistant_response: 'b', timestamp: 1, voice_audio_key: tts },
      { user_message: 'c', assistant_response: 'd', timestamp: 2, inbound_voice_audio_key: voice },
      {
        user_message: 'e',
        assistant_response: 'f',
        timestamp: 3,
        voice_audio_key: `audio/${ORG}/leg1/gone.opus`,
      },
    ]);
  });
  return { tts, voice };
}

async function importLeg1(keyId: string): Promise<Record<string, unknown> | undefined> {
  const res = await SELF.fetch(`${KEYS}/${keyId}/_import-legacy-users`, {
    method: 'POST',
    headers: JSON_INTERNAL,
    body: JSON.stringify({ legacyClientId: 'shema', userIds: ['leg1'] }),
  });
  return ((await res.json()) as { results: Record<string, unknown>[] }).results[0];
}

async function historyOf(doName: string): Promise<Record<string, unknown>[]> {
  const stub = env.USER_DO.get(env.USER_DO.idFromName(doName));
  return runInDurableObject(
    stub,
    async (_i, state) => (await state.storage.get<Record<string, unknown>[]>('history')) ?? []
  );
}

describe('legacy import moves referenced audio into the partner partition', () => {
  it('copies the objects, rewrites the history keys and drops a missing one', async () => {
    await seedLegacyUser();
    const { key, apiKey } = await createKey();
    expect(await importLeg1(key.id)).toMatchObject({
      status: 'copied',
      audio: { copied: 2, existing: 0, missing: 1 },
    });
    const owner = `partner:${key.userNamespace}:leg1`;
    const [first, second, third] = await historyOf(`user:${ORG}:${owner}`);
    expect(first?.voice_audio_key).toBe(`audio/${ORG}/${owner}/t1.opus`);
    expect(second?.inbound_voice_audio_key).toBe(`voice-submissions/${ORG}/${owner}/leg1/v1.ogg`);
    expect(third).not.toHaveProperty('voice_audio_key');
    expect(third?.user_message).toBe('e');
    expect((await get(`/api/v1/audio/${String(first?.voice_audio_key)}`, apiKey)).status).toBe(200);
    const voiceCopy = String(second?.inbound_voice_audio_key);
    expect((await get(`/api/v1/voice-submissions/${voiceCopy}`, apiKey)).status).toBe(200);
  });

  it("leaves the source objects in place (and still not the partner's)", async () => {
    const { tts, voice } = await seedLegacyUser();
    const { key, apiKey } = await createKey();
    await importLeg1(key.id);
    expect(await env.AUDIO_BUCKET.head(tts)).not.toBeNull();
    expect(await env.AUDIO_BUCKET.head(voice)).not.toBeNull();
    expect((await get(`/api/v1/audio/${tts}`, apiKey)).status).toBe(404);
  });
});

describe('re-running the legacy import never deletes audio an earlier run wrote', () => {
  it("the reviewer's case: import, re-run -> destination_not_empty, the first copies remain", async () => {
    await seedLegacyUser();
    const { key, apiKey } = await createKey();
    expect(await importLeg1(key.id)).toMatchObject({ status: 'copied' });
    const owner = `partner:${key.userNamespace}:leg1`;
    const ttsCopy = `audio/${ORG}/${owner}/t1.opus`;
    const voiceCopy = `voice-submissions/${ORG}/${owner}/leg1/v1.ogg`;

    expect(await importLeg1(key.id)).toEqual({ userId: 'leg1', status: 'destination_not_empty' });
    expect(await env.AUDIO_BUCKET.head(ttsCopy)).not.toBeNull();
    expect(await env.AUDIO_BUCKET.head(voiceCopy)).not.toBeNull();
    expect((await get(`/api/v1/audio/${ttsCopy}`, apiKey)).status).toBe(200);
  });

  it('the UserDO preflight answers 200 for an empty idle DO and 409 with the reason otherwise', async () => {
    const empty = env.USER_DO.get(env.USER_DO.idFromName(`user:${ORG}:preflight-empty`));
    expect((await empty.fetch('https://user-do/admin/user-data/importable')).status).toBe(200);
    await seedLegacyUser();
    const used = env.USER_DO.get(env.USER_DO.idFromName(`user:${ORG}:leg1`));
    const res = await used.fetch('https://user-do/admin/user-data/importable');
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ ok: false, reason: 'destination_not_empty' });
  });
});

describe('legacy import rehomes audio attachments too', () => {
  it("rewrites an audio attachment's r2_key and url, drops a missing one, leaves others alone", async () => {
    await seedLegacyUser();
    const story = `voice-submissions/${ORG}/grp1/amara/story.ogg`;
    const gone = `voice-submissions/${ORG}/grp1/amara/gone.ogg`;
    await putAudio(story);
    const pdf = { type: 'pdf', url: 'https://worker/x.pdf', filename: 'x.pdf', size_bytes: 1 };
    const source = env.USER_DO.get(env.USER_DO.idFromName(`user:${ORG}:leg1`));
    await runInDurableObject(source, async (_i, state) => {
      const history = (await state.storage.get<Record<string, unknown>[]>('history')) ?? [];
      history.push({
        user_message: 'play it',
        assistant_response: 'here',
        timestamp: 4,
        attachments: [
          {
            type: 'audio',
            r2_key: story,
            url: `${W}/api/v1/voice-submissions/${story}`,
            mime_type: 'audio/ogg',
          },
          { type: 'audio', r2_key: gone, url: `${W}/api/v1/voice-submissions/${gone}` },
          pdf,
        ],
      });
      await state.storage.put('history', history);
    });
    const { key, apiKey } = await createKey();
    expect(await importLeg1(key.id)).toMatchObject({
      status: 'copied',
      audio: { copied: 3, existing: 0, missing: 2 },
    });
    const owner = `partner:${key.userNamespace}:leg1`;
    const history = await historyOf(`user:${ORG}:${owner}`);
    const copy = `voice-submissions/${ORG}/${owner}/amara/story.ogg`;
    expect(history.at(-1)?.attachments).toEqual([
      {
        type: 'audio',
        r2_key: copy,
        url: `${W}/api/v1/voice-submissions/${copy}`,
        mime_type: 'audio/ogg',
      },
      pdf,
    ]);
    expect((await get(`/api/v1/voice-submissions/${copy}`, apiKey)).status).toBe(200);
    expect(await env.AUDIO_BUCKET.head(story)).not.toBeNull();
  });
});

const keyStoreStub = () =>
  env.PARTNER_KEY_STORE.get(env.PARTNER_KEY_STORE.idFromName(PARTNER_KEY_STORE_NAME));

async function leaseOf(keyId: string): Promise<unknown> {
  return runInDurableObject(keyStoreStub(), async (_i, state) =>
    state.storage.get(`import-lease:${keyId}`)
  );
}

async function plantLease(keyId: string, expiresAt: number): Promise<void> {
  await runInDurableObject(keyStoreStub(), async (_i, state) => {
    await state.storage.put(`import-lease:${keyId}`, { holder: 'other-run', expiresAt });
  });
}

describe('one legacy import per key at a time', () => {
  it('a second import while one holds the lease gets 409 import_in_progress and touches nothing', async () => {
    await seedLegacyUser();
    const { key } = await createKey();
    await plantLease(key.id, Date.now() + 60_000);
    const res = await SELF.fetch(`${KEYS}/${key.id}/_import-legacy-users`, {
      method: 'POST',
      headers: JSON_INTERNAL,
      body: JSON.stringify({ legacyClientId: 'shema', userIds: ['leg1'] }),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'import_in_progress' });
    const owner = `partner:${key.userNamespace}:leg1`;
    expect(await keysUnder(`audio/${ORG}/${owner}/`)).toEqual([]);
    expect(await leaseOf(key.id)).toMatchObject({ holder: 'other-run' });
  });

  it('an expired lease (a run that died) does not block, and a finished run releases its lease', async () => {
    await seedLegacyUser();
    const { key } = await createKey();
    await plantLease(key.id, Date.now() - 1);
    expect(await importLeg1(key.id)).toMatchObject({ status: 'copied' });
    expect(await leaseOf(key.id)).toBeUndefined();
  });

  it('the lease is per key: another key imports while the first is held', async () => {
    await seedLegacyUser();
    const held = await createKey();
    const free = await createKey();
    await plantLease(held.key.id, Date.now() + 60_000);
    expect(await importLeg1(free.key.id)).toMatchObject({ status: 'copied' });
  });
});
