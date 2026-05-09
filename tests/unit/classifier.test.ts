import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { classifyTriggers, ClassifierContext } from '../../src/services/classifier/index.js';

// ─── Mock logger ────────────────────────────────────────────────────────────

function createMockLogger() {
  return {
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    flush: vi.fn(),
    requestId: 'test-req-id',
  } as unknown as ClassifierContext['logger'];
}

// ─── Helpers ────────────────────────────────────────────────────────────────

const modes = [
  { name: 'spoken', label: 'Spoken' },
  { name: 'mast-methodology', label: 'MAST Methodology' },
];

const languages = [
  { name: 'arabic', label: 'Arabic' },
  { name: 'french', label: 'French' },
];

function buildCtx(overrides?: Partial<ClassifierContext>): ClassifierContext {
  return {
    apiKey: 'test-key',
    availableModes: modes,
    availableLanguages: languages,
    logger: createMockLogger(),
    ...overrides,
  };
}

/** Build a mock Anthropic Messages API response with the given JSON content. */
function mockApiResponse(json: {
  mode: string | null;
  mode_raw?: string | null;
  language: string | null;
  language_raw?: string | null;
  stripped_message: string;
}): Response {
  return new Response(
    JSON.stringify({
      content: [{ type: 'text', text: JSON.stringify(json) }],
    }),
    { status: 200, headers: { 'content-type': 'application/json' } }
  );
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('classifyTriggers - pre-filter bypass', () => {
  it('skips LLM call when message has no # or @ in first 100 chars', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const result = await classifyTriggers('How do I translate Genesis 1:1?', buildCtx());

    expect(result.classifierRan).toBe(false);
    expect(result.strippedMessage).toBe('How do I translate Genesis 1:1?');
    expect(result.modeName).toBeUndefined();
    expect(result.languageName).toBeUndefined();
    expect(result.warnings).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('skips LLM call when no modes and no languages are available', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const ctx = buildCtx({ availableModes: [], availableLanguages: [] });
    const result = await classifyTriggers('#spoken How do I translate?', ctx);

    expect(result.classifierRan).toBe(false);
    expect(result.strippedMessage).toBe('#spoken How do I translate?');
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});

describe('classifyTriggers - happy path', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('extracts both #mode and @language', async () => {
    fetchSpy.mockResolvedValueOnce(
      mockApiResponse({
        mode: 'spoken',
        language: 'arabic',
        stripped_message: 'How do I translate Genesis 1:1?',
      })
    );

    const result = await classifyTriggers(
      '#spoken @arabic How do I translate Genesis 1:1?',
      buildCtx()
    );

    expect(result.classifierRan).toBe(true);
    expect(result.modeName).toBe('spoken');
    expect(result.languageName).toBe('arabic');
    expect(result.strippedMessage).toBe('How do I translate Genesis 1:1?');
    expect(result.warnings).toEqual([]);
    expect(result.classifierLatencyMs).toBeDefined();
  });

  it('extracts only #mode when no @language is present', async () => {
    fetchSpy.mockResolvedValueOnce(
      mockApiResponse({
        mode: 'mast-methodology',
        language: null,
        stripped_message: 'What steps do I follow?',
      })
    );

    const result = await classifyTriggers('#mast What steps do I follow?', buildCtx());

    expect(result.modeName).toBe('mast-methodology');
    expect(result.languageName).toBeUndefined();
    expect(result.strippedMessage).toBe('What steps do I follow?');
  });

  it('extracts only @language when no #mode is present', async () => {
    fetchSpy.mockResolvedValueOnce(
      mockApiResponse({ mode: null, language: 'french', stripped_message: 'Translate this verse' })
    );

    const result = await classifyTriggers('@french Translate this verse', buildCtx());

    expect(result.modeName).toBeUndefined();
    expect(result.languageName).toBe('french');
    expect(result.strippedMessage).toBe('Translate this verse');
  });
});

describe('classifyTriggers - unknown token fallback', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('returns warning when mode is not recognized (LLM returns non-null match attempt)', async () => {
    fetchSpy.mockResolvedValueOnce(
      mockApiResponse({ mode: 'nonexistent', language: null, stripped_message: 'hello' })
    );

    const result = await classifyTriggers('#nonexistent hello', buildCtx());

    expect(result.modeName).toBeUndefined();
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('not recognized');
    expect(result.warnings[0]).toContain('#nonexistent');
  });

  it('returns warning when mode token detected but LLM returns null match', async () => {
    fetchSpy.mockResolvedValueOnce(
      mockApiResponse({
        mode: null,
        mode_raw: 'spokne',
        language: null,
        stripped_message: 'hello',
      })
    );

    const result = await classifyTriggers('#spokne hello', buildCtx());

    expect(result.modeName).toBeUndefined();
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('not recognized');
    expect(result.warnings[0]).toContain('#spokne');
  });

  it('returns warning when language is not recognized', async () => {
    fetchSpy.mockResolvedValueOnce(
      mockApiResponse({
        mode: null,
        language: null,
        language_raw: 'klingon',
        stripped_message: 'hello',
      })
    );

    const result = await classifyTriggers('@klingon hello', buildCtx());

    expect(result.languageName).toBeUndefined();
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('not recognized');
    expect(result.warnings[0]).toContain('@klingon');
  });
});

describe('classifyTriggers - API error handling', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('degrades gracefully on API error (non-200)', async () => {
    fetchSpy.mockResolvedValueOnce(new Response('Internal Server Error', { status: 500 }));

    const ctx = buildCtx();
    const result = await classifyTriggers('#spoken hello', ctx);

    expect(result.classifierRan).toBe(true);
    expect(result.strippedMessage).toBe('#spoken hello');
    expect(result.modeName).toBeUndefined();
    expect(ctx.logger.error).toHaveBeenCalled();
  });

  it('degrades gracefully on network error', async () => {
    fetchSpy.mockRejectedValueOnce(new Error('Network failure'));

    const ctx = buildCtx();
    const result = await classifyTriggers('#spoken hello', ctx);

    expect(result.classifierRan).toBe(true);
    expect(result.strippedMessage).toBe('#spoken hello');
    expect(result.modeName).toBeUndefined();
    expect(ctx.logger.error).toHaveBeenCalled();
  });
});

describe('classifyTriggers - response parsing errors', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('degrades gracefully on malformed LLM response', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ content: [{ type: 'text', text: 'not valid json' }] }), {
        status: 200,
      })
    );

    const ctx = buildCtx();
    const result = await classifyTriggers('#spoken hello', ctx);

    expect(result.classifierRan).toBe(true);
    expect(result.strippedMessage).toBe('#spoken hello');
    expect(ctx.logger.warn).toHaveBeenCalled();
  });

  it('degrades gracefully on missing stripped_message in response', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ content: [{ type: 'text', text: '{"mode":"spoken"}' }] }), {
        status: 200,
      })
    );

    const ctx = buildCtx();
    const result = await classifyTriggers('#spoken hello', ctx);

    expect(result.classifierRan).toBe(true);
    expect(result.strippedMessage).toBe('#spoken hello');
    expect(ctx.logger.warn).toHaveBeenCalled();
  });
});
