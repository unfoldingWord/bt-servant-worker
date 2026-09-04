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
 *      references, trigger-only turns, emoji, URLs, one repeated token —
 *      resolve to `null`, not a guess.
 *   3. Languages OUTSIDE tinyld/light's 24-language set (Indonesian, Swahili)
 *      and mixed-language sentences resolve to `null` rather than to a
 *      phantom in-set language; the one English fixture that costs is
 *      recorded as a deliberate recall loss.
 *   4. Prose that merely contains numbers (`Reunião 15:30`, `2 pessoas e 5
 *      minutos`) is detected, not stripped.
 *   5. The text handed to tinyld is capped at MAX_DETECT_CHARS.
 *   6. tinyld/light emits an ISO 639-1 code for every language in its set,
 *      which is why detect.ts carries no shape check of its own.
 *   7. A detector failure is observable (one `language_detect_failed` warn on
 *      the request logger) and degrades to `null`; it never throws.
 */
import { describe, it, expect, vi } from 'vitest';
import * as tinyld from 'tinyld/light';
import {
  detectWrittenLanguage,
  prepareForDetection,
  stripNonLinguistic,
  MAX_DETECT_CHARS,
  LATIN_LEXICAL_EVIDENCE_SHORT_WORD_MAX_LETTERS,
  LATIN_PREDOMINANCE_RATIO,
  MIN_ACCURACY,
  MIN_CONFIDENCE,
  MIN_DISTINCT_WORDS,
  MIN_LETTERS,
} from '../../src/services/language/detect.js';
import { createMockLogger } from '../helpers/mock-logger.js';

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

/** Scripts written without word spacing: the distinct-word rule must not gate them. */
const ZH = [
  '我正在把马可福音翻译成我的母语，请帮我理解这段经文。',
  '请你用简单的话解释约翰福音三章十六节的意思。',
];
const JA = [
  '私はマルコの福音書を母語に翻訳しています。この箇所を理解するのを手伝ってください。',
  'ヨハネによる福音書三章十六節の意味を簡単な言葉で説明してください。',
];
const TH = [
  // With a clause space: two \p{L}+ tokens, which a naive distinct-word rule would reject.
  'ฉันกำลังแปลพระกิตติคุณมาระโกเป็นภาษาแม่ของฉัน ช่วยอธิบายข้อนี้หน่อย',
  'คุณช่วยอธิบายความหมายของยอห์น 3:16 ด้วยคำง่ายๆ ได้ไหม',
  'ฉันกำลังแปลพระกิตติคุณมาระโกเป็นภาษาแม่ของฉัน',
];

/** A word-spaced non-Latin script: the distinct-word floor still applies and real prose passes it. */
const RU = ['Я перевожу Евангелие от Марка на свой родной язык.'];

/**
 * `[expected code, fixtures]`: plain prose sentences of 20–200 characters.
 * Every Latin-script fixture carries a short word or a diacritic, which the
 * lexical-evidence rule requires; a fixture failing here for lack of one is a
 * finding to report, not a reason to weaken the rule.
 */
const FIXTURES: ReadonlyArray<[string, readonly string[]]> = [
  ['pt', PT],
  ['en', EN],
  ['es', ES],
  ['zh', ZH],
  ['ja', JA],
  ['th', TH],
  ['ru', RU],
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

describe('detectWrittenLanguage — documented recall losses (precision over recall)', () => {
  it('an English sentence below MIN_ACCURACY is null', () => {
    // tinyld scores this sentence en 0.041 — inside the band where the light
    // set lands on languages it does not know (Indonesian → tr 0.057). No
    // accuracy or margin cut separates the two, so the band is set to null
    // both: "und" for one English sentence is a truthful record, "tr" for an
    // Indonesian speaker is not. Lowering MIN_ACCURACY below 0.057 to recover
    // this sentence would re-admit the Indonesian misread.
    expect(MIN_ACCURACY).toBe(0.06);
    expect(
      detectWrittenLanguage(
        'We need help understanding this difficult passage.',
        createMockLogger()
      )
    ).toBeNull();
  });

  it.each([
    'Biblical translators frequently discuss covenant terminology during weekly workshops together.',
    'Translation teams gather weekly, comparing several versions before deciding anything.',
  ])('real English with no word of ≤ 3 letters and no diacritic is null: %s', (text) => {
    // The Latin lexical-evidence gate cannot tell these from a keyboard-row
    // list (both unique-gram to an in-set code @ 1.0 or clear the floors), so
    // it nulls both. Accepted for telemetry: such sentences are rare in chat,
    // and "und" is a truthful record where "ro" for gibberish is not.
    expect(detectWrittenLanguage(text, createMockLogger())).toBeNull();
  });
});

describe('detectWrittenLanguage — mixed-script bypass attempts', () => {
  it.each([
    [
      'keyboard rows + の (ja @ 1.0 without Latin-scoped predicates)',
      'qwerty asdfgh zxcvbn poiuyt lkjhgf の',
    ],
    ['keyboard rows + 书 (zh @ 1.0)', 'qwerty asdfgh zxcvbn poiuyt lkjhgf 书'],
    ['keyboard rows + が (ja @ 1.0)', 'qwerty asdfgh zxcvbn poiuyt lkjhgf が'],
    ['low-entropy list + の (ja @ 1.0)', 'aaaa bbbb cccc dddd eeee ffff の'],
    [
      'one repeated Latin token + の (ja @ 1.0 if the word floor keyed on any CJK letter)',
      'xyzzy xyzzy xyzzy xyzzy の',
    ],
    [
      'one repeated Cyrillic token (ru @ 1.0 if the word floor keyed on Latin predominance alone)',
      'привет привет привет привет привет',
    ],
    [
      'keyboard rows + eight 的 (Latin share < 0.8, so a predominance-only gate switched off)',
      'qwerty asdfgh zxcvbn poiuyt lkjhgf 的的的的的的的的',
    ],
    ['one repeated Latin token + eight 的', 'xyzzy xyzzy xyzzy xyzzy 的的的的的的的的'],
    ['keyboard rows + sixty 的', `qwerty asdfgh zxcvbn poiuyt lkjhgf ${'的'.repeat(60)}`],
  ])('returns null for %s', (_label, text) => {
    // The Latin subsequence is judged on its own whenever it has ≥ 20 letters
    // (word floor + Latin-scoped lexical evidence), however much CJK is added;
    // one appended CJK character is not evidence either. Word-spaced non-Latin
    // text keeps the word floor.
    expect(detectWrittenLanguage(text, createMockLogger())).toBeNull();
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

  it(`requires at least ${MIN_DISTINCT_WORDS} distinct words, so one repeated token is not a language`, () => {
    // Without the rule tinyld reads these as pl @ 0.99 and hu @ 0.53: every
    // repetition is another vote for whatever the token's n-grams resemble.
    for (const text of [
      'xyzzy xyzzy xyzzy xyzzy xyzzy',
      'asdf asdf asdf asdf asdf asdf asdf asdf',
    ]) {
      expect(detectWrittenLanguage(text, createMockLogger())).toBeNull();
    }
  });

  it.each([
    ['punctuation variants', 'xyzzy, xyzzy. xyzzy! xyzzy?'],
    ['punctuation and case variants', 'Xyzzy, xyzzy. XYZZY! xyZZy?'],
  ])('collapses %s of one token to one word before the distinct-word check', (_label, text) => {
    // Splitting on whitespace alone counted these as four distinct words and
    // tinyld then reported Polish confidently (pl @ 0.99).
    expect(detectWrittenLanguage(text, createMockLogger())).toBeNull();
  });

  it(`requires at least ${MIN_LETTERS} letters after stripping`, () => {
    const belowMin = 'obrigado amigo';
    expect(belowMin.replace(/\P{L}/gu, '').length).toBeLessThan(MIN_LETTERS);
    expect(detectWrittenLanguage(belowMin, createMockLogger())).toBeNull();
  });
});

describe('detectWrittenLanguage — lexical evidence for Latin script', () => {
  it.each([
    ['a keyboard-row list that unique-grams to ro @ 1.0', 'qwerty asdfgh zxcvbn poiuyt lkjhgf'],
    ['a low-entropy list that clears both floors as nl 0.069', 'aaaa bbbb cccc dddd eeee ffff'],
    ['a keyboard-row list that unique-grams to de @ 1.0', 'zxcvbnm asdfghjkl qwertyuiop mnbvcxz'],
    ['a keyboard-column list that unique-grams to de @ 1.0', 'plokij mnjuhy bgtvfr cdexsw'],
  ])(
    `requires lexical evidence in Latin script (a word of ≤ ${LATIN_LEXICAL_EVIDENCE_SHORT_WORD_MAX_LETTERS} letters or a diacritic): %s`,
    (_label, text) => {
      expect(detectWrittenLanguage(text, createMockLogger())).toBeNull();
    }
  );

  it.each([
    [
      'zh',
      'Chinese prose mentioning Bible',
      '我正在读 Bible 的马可福音，请帮我理解这段经文的意思。',
    ],
    [
      'ja',
      'Japanese prose mentioning ChatGPT',
      '私は ChatGPT を使ってマルコの福音書を母語に翻訳しています。',
    ],
    [
      'pt',
      'Portuguese prose with one CJK character',
      'Estou traduzindo o evangelho de Marcos 書 para a minha língua materna.',
    ],
  ])(
    `applies the lexical gate only when ≥ ${LATIN_PREDOMINANCE_RATIO * 100}% of letters are Latin: %s (%s)`,
    (code, _label, text) => {
      expect(detectWrittenLanguage(text, createMockLogger())?.code).toBe(code);
    }
  );
});

describe('detectWrittenLanguage — languages outside the tinyld/light set', () => {
  it.each([
    ['Indonesian', 'Saya sedang menerjemahkan Injil Markus ke dalam bahasa ibu saya.'],
    ['Indonesian', 'Bisakah Anda menjelaskan arti Yohanes 3:16 dengan kata-kata sederhana?'],
    ['Indonesian', 'Kami membutuhkan bantuan untuk memahami bagian yang sulit ini.'],
    ['Swahili', 'Ninatafsiri Injili ya Marko katika lugha yangu ya asili.'],
    ['Swahili', 'Unaweza kunieleza maana ya Yohana 3:16 kwa maneno rahisi?'],
    ['Swahili', 'Tunahitaji msaada wa kuelewa kifungu hiki kigumu.'],
    [
      'mixed English / Portuguese',
      'Can you explain este versículo for me, por favor, in simple words?',
    ],
  ])('returns null rather than a phantom in-set language for %s: %s', (_label, text) => {
    expect(detectWrittenLanguage(text, createMockLogger())).toBeNull();
  });
});

describe('detectWrittenLanguage — pre-strip', () => {
  it.each([
    ['a clock time', 'Reunião 15:30 na igreja, quem vem?'],
    // Padded past the 20-letter floor: the reviewer's original
    // 'temos 2 pessoas e 5 minutos' has 19 letters and is null for that reason alone.
    ['counts', 'temos 2 pessoas e 5 minutos para isso agora mesmo, amigos'],
  ])('keeps prose that merely contains numbers (%s) and detects pt', (_label, text) => {
    expect(detectWrittenLanguage(text, createMockLogger())?.code).toBe('pt');
  });

  it('leaves scripture references in place: digits never count as letters and book names are words', () => {
    expect(stripNonLinguistic('João 3:16 e Gen 1:1-5')).toBe('João 3:16 e Gen 1:1-5');
  });

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

  it('stripNonLinguistic removes URLs, residual hashtags / handles and emoji', () => {
    expect(stripNonLinguistic('#fia @hindi https://x.example/a?b=1 🙏 palavras restantes')).toBe(
      'palavras restantes'
    );
  });
});

describe('detectWrittenLanguage — input cap', () => {
  it(`hands the detector at most ${MAX_DETECT_CHARS} characters and still returns a read`, () => {
    const long = Array.from({ length: 400 }, () => PT[1] as string).join(' ');
    expect(long.length).toBeGreaterThan(MAX_DETECT_CHARS * 10);
    // The cap is applied to the raw text first; the strip may then trim a
    // trailing space, so the prepared length is at most the cap.
    expect(prepareForDetection(long).length).toBeLessThanOrEqual(MAX_DETECT_CHARS);
    expect(prepareForDetection(long).length).toBeGreaterThan(MAX_DETECT_CHARS - 10);

    vi.mocked(tinyld.detectAll).mockClear();
    const result = detectWrittenLanguage(long, createMockLogger());

    expect(result?.code).toBe('pt');
    expect(vi.mocked(tinyld.detectAll)).toHaveBeenCalledTimes(1);
    const handed = vi.mocked(tinyld.detectAll).mock.calls[0]?.[0] ?? '';
    expect(handed.length).toBeLessThanOrEqual(MAX_DETECT_CHARS);
    expect(handed.length).toBeGreaterThan(MAX_DETECT_CHARS - 10);
  });

  it('caps a single 20,000-letter token before any regex runs and never reaches the detector', () => {
    const token = 'a'.repeat(20_000);
    expect(prepareForDetection(token)).toHaveLength(MAX_DETECT_CHARS);

    vi.mocked(tinyld.detectAll).mockClear();
    expect(detectWrittenLanguage(token, createMockLogger())).toBeNull();
    // One distinct word: rejected by MIN_DISTINCT_WORDS, so tinyld is not called at all.
    expect(vi.mocked(tinyld.detectAll)).not.toHaveBeenCalled();
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
