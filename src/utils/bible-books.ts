/**
 * Bible books the worker already accepts for USFM filenames.
 *
 * `BOOK_INDEX` is the Paratext book-id table (Genesis is 01, Matthew is 41,
 * Revelation is 67). Status lines may name one of these codes, in any case,
 * or the English name of that same book. The worker has no localized book
 * names, so a name in another language is not recognized here.
 */

interface BibleBook {
  readonly code: string;
  readonly index: string;
  readonly names: readonly string[];
}

const BIBLE_BOOKS: readonly BibleBook[] = [
  { code: 'GEN', index: '01', names: ['Genesis'] },
  { code: 'EXO', index: '02', names: ['Exodus'] },
  { code: 'LEV', index: '03', names: ['Leviticus'] },
  { code: 'NUM', index: '04', names: ['Numbers'] },
  { code: 'DEU', index: '05', names: ['Deuteronomy'] },
  { code: 'JOS', index: '06', names: ['Joshua'] },
  { code: 'JDG', index: '07', names: ['Judges'] },
  { code: 'RUT', index: '08', names: ['Ruth'] },
  { code: '1SA', index: '09', names: ['1 Samuel'] },
  { code: '2SA', index: '10', names: ['2 Samuel'] },
  { code: '1KI', index: '11', names: ['1 Kings'] },
  { code: '2KI', index: '12', names: ['2 Kings'] },
  { code: '1CH', index: '13', names: ['1 Chronicles'] },
  { code: '2CH', index: '14', names: ['2 Chronicles'] },
  { code: 'EZR', index: '15', names: ['Ezra'] },
  { code: 'NEH', index: '16', names: ['Nehemiah'] },
  { code: 'EST', index: '17', names: ['Esther'] },
  { code: 'JOB', index: '18', names: ['Job'] },
  { code: 'PSA', index: '19', names: ['Psalm', 'Psalms'] },
  { code: 'PRO', index: '20', names: ['Proverbs'] },
  { code: 'ECC', index: '21', names: ['Ecclesiastes'] },
  { code: 'SNG', index: '22', names: ['Song of Songs', 'Song of Solomon'] },
  { code: 'ISA', index: '23', names: ['Isaiah'] },
  { code: 'JER', index: '24', names: ['Jeremiah'] },
  { code: 'LAM', index: '25', names: ['Lamentations'] },
  { code: 'EZK', index: '26', names: ['Ezekiel'] },
  { code: 'DAN', index: '27', names: ['Daniel'] },
  { code: 'HOS', index: '28', names: ['Hosea'] },
  { code: 'JOL', index: '29', names: ['Joel'] },
  { code: 'AMO', index: '30', names: ['Amos'] },
  { code: 'OBA', index: '31', names: ['Obadiah'] },
  { code: 'JON', index: '32', names: ['Jonah'] },
  { code: 'MIC', index: '33', names: ['Micah'] },
  { code: 'NAM', index: '34', names: ['Nahum'] },
  { code: 'HAB', index: '35', names: ['Habakkuk'] },
  { code: 'ZEP', index: '36', names: ['Zephaniah'] },
  { code: 'HAG', index: '37', names: ['Haggai'] },
  { code: 'ZEC', index: '38', names: ['Zechariah'] },
  { code: 'MAL', index: '39', names: ['Malachi'] },
  { code: 'MAT', index: '41', names: ['Matthew'] },
  { code: 'MRK', index: '42', names: ['Mark'] },
  { code: 'LUK', index: '43', names: ['Luke'] },
  { code: 'JHN', index: '44', names: ['John'] },
  { code: 'ACT', index: '45', names: ['Acts'] },
  { code: 'ROM', index: '46', names: ['Romans'] },
  { code: '1CO', index: '47', names: ['1 Corinthians'] },
  { code: '2CO', index: '48', names: ['2 Corinthians'] },
  { code: 'GAL', index: '49', names: ['Galatians'] },
  { code: 'EPH', index: '50', names: ['Ephesians'] },
  { code: 'PHP', index: '51', names: ['Philippians'] },
  { code: 'COL', index: '52', names: ['Colossians'] },
  { code: '1TH', index: '53', names: ['1 Thessalonians'] },
  { code: '2TH', index: '54', names: ['2 Thessalonians'] },
  { code: '1TI', index: '55', names: ['1 Timothy'] },
  { code: '2TI', index: '56', names: ['2 Timothy'] },
  { code: 'TIT', index: '57', names: ['Titus'] },
  { code: 'PHM', index: '58', names: ['Philemon'] },
  { code: 'HEB', index: '59', names: ['Hebrews'] },
  { code: 'JAS', index: '60', names: ['James'] },
  { code: '1PE', index: '61', names: ['1 Peter'] },
  { code: '2PE', index: '62', names: ['2 Peter'] },
  { code: '1JN', index: '63', names: ['1 John'] },
  { code: '2JN', index: '64', names: ['2 John'] },
  { code: '3JN', index: '65', names: ['3 John'] },
  { code: 'JUD', index: '66', names: ['Jude'] },
  { code: 'REV', index: '67', names: ['Revelation'] },
];

/** Bookcode → 2-digit Paratext index, e.g. `"44JHN.SFM"`. */
export const BOOK_INDEX: Record<string, string> = Object.fromEntries(
  BIBLE_BOOKS.map((book) => [book.code, book.index])
);

const BOOK_CODES = new Set(BIBLE_BOOKS.map((book) => book.code));
const BOOK_NAMES = new Set(
  BIBLE_BOOKS.flatMap((book) => book.names.map((name) => name.toLowerCase()))
);

/** True when `text` is a Paratext code in {@link BOOK_INDEX}, ignoring case. */
export function isKnownBookCode(text: string): boolean {
  return BOOK_CODES.has(text.toUpperCase());
}

/**
 * True when `book` is a known code or the English name of one of those books.
 * Comparison ignores case and repeated spaces. Localized names are not known.
 */
export function isKnownBibleBook(book: string): boolean {
  const name = book.trim().replace(/\s+/g, ' ');
  if (!name) return false;
  return isKnownBookCode(name) || BOOK_NAMES.has(name.toLowerCase());
}
