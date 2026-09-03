/**
 * Unit cover for `detectWrittenLanguage` (#404).
 *
 * The detector is deterministic (no LLM, no network). These tests pin the
 * properties the `chat_turn` telemetry depends on:
 *
 *   1. Portuguese / English / Spanish prose resolves to the right ISO 639-1
 *      code AT OR ABOVE the confidence cutoff — in particular Spanish never
 *      reads as `pt`, the pt/es confusion being the failure mode that would
 *      make the recorded input_language lie most often.
 *   2. Inputs with too little linguistic signal — short acks, bare scripture
 *      references, trigger-only turns, emoji, URLs — resolve to `null`, not a
 *      guess.
 *   3. The text handed to tinyld is capped at MAX_DETECT_CHARS.
 *   4. tinyld/light emits an ISO 639-1 code for every language in its set,
 *      which is why detect.ts carries no shape check of its own.
 *   5. A detector failure is observable (one `language_detect_failed` warn on
 *      the request logger) and degrades to `null`; it never throws.
 */
import { describe, it, expect, vi } from 'vitest';
import * as tinyld from 'tinyld/light';
import {
  detectWrittenLanguage,
  prepareForDetection,
  stripNonLinguistic,
  MAX_DETECT_CHARS,
  MIN_CONFIDENCE,
  MIN_LETTERS,
} from '../../src/services/language/detect.js';
import { createMockLogger } from '../helpers/anthropic-capture.js';

vi.mock('tinyld/light', async (importOriginal) => {
  const actual = await importOriginal<typeof import('tinyld/light')>();
  return { ...actual, detectAll: vi.fn(actual.detectAll) };
});

const PT = [
  'Você pode me explicar o significado de João 3:16 em palavras simples?',
  'Estou traduzindo o evangelho de Marcos para a minha língua materna.',
  'Qual é a diferença entre graça e misericórdia na Bíblia?',
  'Precisamos de ajuda para entender esta passagem difícil.',
  'Obrigado pela explicação, agora faz muito mais sentido para mim.',
  'Nossa equipe de tradução se reúne todas as semanas na igreja.',
  'Por favor, resuma o capítulo em três frases curtas.',
  'O que Paulo quis dizer com andar no Espírito em Gálatas?',
  'Não entendi bem o versículo anterior, você poderia repetir?',
  'Quero comparar duas traduções deste versículo antes de decidir.',
];

const EN = [
  'Can you explain what John 3:16 means in simple words?',
  'I am translating the gospel of Mark into my mother tongue.',
  'What is the difference between grace and mercy in the Bible?',
  'We need help understanding this difficult passage.',
  'Thank you for the explanation, it makes much more sense now.',
  'How should I translate the word covenant in the Old Testament?',
  'Our translation team meets every week at the church.',
  'Please summarize the chapter in three short sentences.',
  'What did Paul mean by walking in the Spirit in Galatians?',
  'I did not quite understand the previous verse, could you repeat it?',
];

const ES = [
  '¿Puedes explicarme qué significa Juan 3:16 con palabras sencillas?',
  'Estoy traduciendo el evangelio de Marcos a mi lengua materna.',
  '¿Cuál es la diferencia entre gracia y misericordia en la Biblia?',
  'Necesitamos ayuda para entender este pasaje difícil.',
  'Gracias por la explicación, ahora tiene mucho más sentido para mí.',
];

/** `[expected code, fixtures]`: plain prose sentences of 20–200 characters. */
const FIXTURES: ReadonlyArray<[string, readonly string[]]> = [
  ['pt', PT],
  ['en', EN],
  ['es', ES],
];

describe('detectWrittenLanguage — fixture set', () => {
  describe.each(FIXTURES)('%s', (code, fixtures) => {
    it.each(fixtures)(`detects ${code} at or above the cutoff: %s`, (text) => {
      const result = detectWrittenLanguage(text, createMockLogger());
      expect(result?.code).toBe(code);
      expect(result?.confidence).toBeGreaterThanOrEqual(MIN_CONFIDENCE);
      expect(result?.confidence).toBeLessThanOrEqual(1);
    });
  });

  it('returns null rather than a guess on a pt/it/es near-tie', () => {
    // Measured during library selection: tinyld/light scores this sentence
    // pt 0.066 / it 0.062 / es 0.062 — a margin far below the cutoff. Recording
    // "und" is more truthful than recording a coin toss.
    expect(
      detectWrittenLanguage(
        'Como devo traduzir a palavra aliança no Antigo Testamento?',
        createMockLogger()
      )
    ).toBeNull();
  });

  it('tinyld/light maps every language in its set to a two-letter ISO 639-1 code', () => {
    // This is why detect.ts has no code-shape guard of its own: the library
    // cannot emit anything that `isValidLanguageCode` would reject. A tinyld
    // bump that adds a three-letter-only language fails here, not in production.
    expect(tinyld.supportedLanguages.length).toBeGreaterThan(0);
    for (const iso3 of tinyld.supportedLanguages) {
      expect(tinyld.toISO2(iso3)).toMatch(/^[a-z]{2}$/);
    }
  });
});

describe('detectWrittenLanguage — inputs without enough linguistic signal', () => {
  it.each([
    ['short ack', 'ok'],
    ['bare scripture reference', 'João 3:16'],
    ['trigger-only turn, as the classifier hands it back', '@hindi'],
    ['trigger-only turn with two tokens', '#fia @hindi'],
    ['trigger token + reference', '#fia Gen 1:1-5'],
    ['emoji only', '🙏'],
    ['bare URL', 'https://example.com/pt/joao/3'],
    ['numbered book reference', '1 Cor 13'],
    ['empty string', ''],
    ['whitespace', '   \n\t '],
  ])('returns null for %s', (_label, text) => {
    expect(detectWrittenLanguage(text, createMockLogger())).toBeNull();
  });

  it(`requires at least ${MIN_LETTERS} letters after stripping`, () => {
    const belowMin = 'obrigado amigo';
    expect(belowMin.replace(/\P{L}/gu, '').length).toBeLessThan(MIN_LETTERS);
    expect(detectWrittenLanguage(belowMin, createMockLogger())).toBeNull();
  });
});

describe('detectWrittenLanguage — pre-strip', () => {
  it('detects pt when a reference is stripped and a Portuguese sentence remains', () => {
    const result = detectWrittenLanguage(
      '#fia João 3:16 e Gen 1:1-5 — você pode me explicar o significado destas passagens?',
      createMockLogger()
    );
    expect(result?.code).toBe('pt');
  });

  it('detects pt when a URL and emoji are stripped and a Portuguese sentence remains', () => {
    const result = detectWrittenLanguage(
      'https://bible.com/pt/JHN.3 🙏 preciso de ajuda para entender esta passagem difícil.',
      createMockLogger()
    );
    expect(result?.code).toBe('pt');
  });

  it('stripNonLinguistic removes URLs, references, residual hashtags / handles and emoji', () => {
    const stripped = stripNonLinguistic(
      '#fia @hindi Gen 1:1-5 João 3:16 1 Cor 13 https://x.example/a?b=1 🙏 palavras restantes'
    );
    expect(stripped).not.toMatch(/https?:/);
    expect(stripped).not.toMatch(/#fia|@hindi/);
    expect(stripped).not.toMatch(/Gen|João|Cor|\d/);
    expect(stripped).not.toMatch(/🙏/);
    expect(stripped).toBe('palavras restantes');
  });
});

describe('detectWrittenLanguage — input cap', () => {
  it(`hands the detector at most ${MAX_DETECT_CHARS} characters and still returns a read`, () => {
    const long = Array.from({ length: 400 }, () => PT[1] as string).join(' ');
    expect(long.length).toBeGreaterThan(MAX_DETECT_CHARS * 10);
    expect(prepareForDetection(long)).toHaveLength(MAX_DETECT_CHARS);

    vi.mocked(tinyld.detectAll).mockClear();
    const result = detectWrittenLanguage(long, createMockLogger());

    expect(result?.code).toBe('pt');
    expect(vi.mocked(tinyld.detectAll)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(tinyld.detectAll).mock.calls[0]?.[0]).toHaveLength(MAX_DETECT_CHARS);
  });

  it('caps a single 20,000-letter token the same way and does not throw', () => {
    vi.mocked(tinyld.detectAll).mockClear();
    expect(() => detectWrittenLanguage('a'.repeat(20_000), createMockLogger())).not.toThrow();
    expect(vi.mocked(tinyld.detectAll).mock.calls[0]?.[0]).toHaveLength(MAX_DETECT_CHARS);
  });
});

describe('detectWrittenLanguage — never throws', () => {
  it('returns null and warns exactly once on the request logger when the detector throws', () => {
    vi.mocked(tinyld.detectAll).mockImplementationOnce(() => {
      throw new Error('detector exploded');
    });
    const logger = createMockLogger();

    const result = detectWrittenLanguage(EN[0] as string, logger);

    expect(result).toBeNull();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      'language_detect_failed',
      expect.objectContaining({ error: 'detector exploded' })
    );
  });
});
