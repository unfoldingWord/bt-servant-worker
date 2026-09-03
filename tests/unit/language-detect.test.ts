/**
 * Unit cover for `detectWrittenLanguage` (#404).
 *
 * The detector is deterministic (no LLM, no network). These tests pin three
 * properties the auto-follow logic in UserDO depends on:
 *
 *   1. Portuguese / English / Spanish prose of 20–200 chars resolves to the
 *      right ISO 639-1 code AT OR ABOVE the confidence cutoff, and Spanish
 *      never resolves to `pt` (the pt/es confusion is the failure mode that
 *      would flip a Portuguese user's preference on a Spanish paste).
 *   2. Inputs with too little linguistic signal — short acks, bare scripture
 *      references, trigger tokens, emoji, URLs — resolve to `null`, not a guess.
 *   3. A detector failure is observable (one `language_detect_failed` warn)
 *      and degrades to `null`; it never throws into processChat.
 */
import { describe, it, expect, vi } from 'vitest';
import * as tinyld from 'tinyld/light';
import {
  detectWrittenLanguage,
  stripNonLinguistic,
  MIN_CONFIDENCE,
  MIN_LETTERS,
} from '../../src/services/language/detect.js';
import type { RequestLogger } from '../../src/utils/logger.js';

vi.mock('tinyld/light', async (importOriginal) => {
  const actual = await importOriginal<typeof import('tinyld/light')>();
  return { ...actual, detectAll: vi.fn(actual.detectAll) };
});

function createMockLogger(): RequestLogger {
  return { log: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as RequestLogger;
}

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

describe('detectWrittenLanguage — fixture set', () => {
  it.each(PT)('detects Portuguese at or above the cutoff: %s', (text) => {
    expect(text.length).toBeGreaterThanOrEqual(20);
    expect(text.length).toBeLessThanOrEqual(200);
    const result = detectWrittenLanguage(text);
    expect(result).not.toBeNull();
    expect(result?.code).toBe('pt');
    expect(result?.confidence).toBeGreaterThanOrEqual(MIN_CONFIDENCE);
  });

  it.each(EN)('detects English at or above the cutoff: %s', (text) => {
    expect(text.length).toBeGreaterThanOrEqual(20);
    expect(text.length).toBeLessThanOrEqual(200);
    const result = detectWrittenLanguage(text);
    expect(result).not.toBeNull();
    expect(result?.code).toBe('en');
    expect(result?.confidence).toBeGreaterThanOrEqual(MIN_CONFIDENCE);
  });

  it.each(ES)('detects Spanish at or above the cutoff and never as pt: %s', (text) => {
    expect(text.length).toBeGreaterThanOrEqual(20);
    expect(text.length).toBeLessThanOrEqual(200);
    const result = detectWrittenLanguage(text);
    expect(result).not.toBeNull();
    expect(result?.code).toBe('es');
    expect(result?.code).not.toBe('pt');
    expect(result?.confidence).toBeGreaterThanOrEqual(MIN_CONFIDENCE);
  });

  it('returns null rather than a guess on a pt/it/es near-tie', () => {
    // Measured during library selection: tinyld/light scores this sentence
    // pt 0.066 / it 0.062 / es 0.062 — a margin far below the cutoff. The
    // auto-follow must not flip a preference on a coin toss like that.
    expect(
      detectWrittenLanguage('Como devo traduzir a palavra aliança no Antigo Testamento?')
    ).toBeNull();
  });

  it('always returns a two-letter ISO 639-1 code', () => {
    for (const text of [...PT, ...EN, ...ES]) {
      const result = detectWrittenLanguage(text);
      expect(result?.code).toMatch(/^[a-z]{2}$/);
      expect(result?.confidence).toBeGreaterThan(0);
      expect(result?.confidence).toBeLessThanOrEqual(1);
    }
  });
});

describe('detectWrittenLanguage — inputs without enough linguistic signal', () => {
  it.each([
    ['short ack', 'ok'],
    ['bare scripture reference', 'João 3:16'],
    ['trigger token + reference', '#fia Gen 1:1-5'],
    ['emoji only', '🙏'],
    ['bare URL', 'https://example.com/pt/joao/3'],
    ['numbered book reference', '1 Cor 13'],
    ['empty string', ''],
    ['whitespace', '   \n\t '],
  ])('returns null for %s', (_label, text) => {
    expect(detectWrittenLanguage(text)).toBeNull();
  });

  it(`requires at least ${MIN_LETTERS} letters after stripping`, () => {
    const belowMin = 'obrigado amigo';
    expect(belowMin.replace(/\P{L}/gu, '').length).toBeLessThan(MIN_LETTERS);
    expect(detectWrittenLanguage(belowMin)).toBeNull();
  });
});

describe('detectWrittenLanguage — pre-strip', () => {
  it('detects pt when a reference is stripped and a Portuguese sentence remains', () => {
    const result = detectWrittenLanguage(
      '#fia João 3:16 e Gen 1:1-5 — você pode me explicar o significado destas passagens?'
    );
    expect(result?.code).toBe('pt');
  });

  it('detects pt when a URL and emoji are stripped and a Portuguese sentence remains', () => {
    const result = detectWrittenLanguage(
      'https://bible.com/pt/JHN.3 🙏 preciso de ajuda para entender esta passagem difícil.'
    );
    expect(result?.code).toBe('pt');
  });

  it('stripNonLinguistic removes URLs, references, trigger tokens and emoji', () => {
    const stripped = stripNonLinguistic(
      '#fia @hindi Gen 1:1-5 João 3:16 1 Cor 13 https://x.example/a?b=1 🙏 palavras restantes'
    );
    expect(stripped).not.toMatch(/https?:/);
    expect(stripped).not.toMatch(/#fia|@hindi/);
    expect(stripped).not.toMatch(/Gen|João|Cor|\d/);
    expect(stripped).not.toMatch(/🙏/);
    expect(stripped.trim()).toBe('palavras restantes');
  });
});

describe('detectWrittenLanguage — never throws', () => {
  it('returns null and warns exactly once when the detector throws', () => {
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

  it('returns null without throwing when the detector throws and no logger is supplied', () => {
    vi.mocked(tinyld.detectAll).mockImplementationOnce(() => {
      throw new Error('detector exploded');
    });
    let result: unknown = 'unset';
    expect(() => {
      result = detectWrittenLanguage(EN[0] as string);
    }).not.toThrow();
    expect(result).toBeNull();
  });
});
