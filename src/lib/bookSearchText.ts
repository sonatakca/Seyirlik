/**
 * How a book search reads words: the one definition the server ranks with and
 * the reader marks with, so what is marked on the page is exactly what was
 * found.
 *
 * Words are compared folded: case, accents and the Turkish letters a keyboard
 * may lack (ı and i, ş and s, ğ and g…) are all one, and the soft hyphens the
 * reader sets inside words are not there. A word of the query finds the words
 * of the book that begin with it, so "tilki" finds "tilkiyi" and "Bernard"
 * finds "Bernard’ın"; a long one also finds its own stem with other endings,
 * so "evcilleştirmenin" finds "evcilleştirdi".
 *
 * Every match is reported in the original text's own offsets.
 */

const SOFT_HYPHEN = "\u00ad";
const WORD = /[\p{L}\p{N}]+/gu;
const APOSTROPHES = /['’ʼ`´]/;

export interface FoldedText {
  /** The text folded: lower case, no accents, no soft hyphens. */
  text: string;
  /** For each folded character, where it came from; one more at the end. */
  at: number[];
}

const folds = new Map<string, string>();

function foldChar(char: string): string {
  let folded = folds.get(char);
  if (folded === undefined) {
    folded = char
      .normalize("NFD")
      .replace(/\p{M}/gu, "")
      .toLowerCase()
      .replace(/ı/g, "i");
    folds.set(char, folded);
  }
  return folded;
}

export function foldText(text: string): FoldedText {
  let folded = "";
  const at: number[] = [];
  let index = 0;
  for (const char of text) {
    if (char !== SOFT_HYPHEN) {
      const piece = foldChar(char);
      folded += piece;
      for (let k = 0; k < piece.length; k++) at.push(index);
    }
    index += char.length;
  }
  at.push(text.length);
  return { text: folded, at };
}

/** A query word as it is searched for, folded. */
export function foldWord(word: string): string {
  return foldText(word).text;
}

/**
 * A word in lower case with its letters as written: "ölüyor" is not
 * "oluyor". Only i and ı stay one, since casing and keyboards confuse them.
 */
export function plainWord(word: string): string {
  return word
    .replace(/\u00ad/g, "")
    .toLowerCase()
    .replace(/\u0307/g, "")
    .replace(/ı/g, "i");
}

export interface QueryTerm {
  plain: string;
  folded: string;
  /**
   * Written with letters a fold would lose (ö, ş, ç…): the book's words
   * spelled that way answer it best, and only those are marked.
   */
  strict: boolean;
}

export function queryTerm(word: string): QueryTerm {
  const plain = plainWord(word);
  const folded = foldWord(word);
  return { plain, folded, strict: plain !== folded };
}

/**
 * The words a query searches for, in lower case, in the order written. What
 * follows an apostrophe is a Turkish ending ("Bernard'ın"), not a word of its
 * own. Quotation marks are not words.
 */
export function queryWords(query: string): string[] {
  const words: string[] = [];
  for (const raw of query.split(/\s+/)) {
    const [head] = raw.split(APOSTROPHES);
    for (const match of (head ?? "").matchAll(WORD))
      words.push(plainWord(match[0]));
  }
  return words;
}

/**
 * Words that carry no subject of their own, Turkish and English: a search
 * neither marks them nor ranks by them, unless they are all it has. Inside a
 * line quoted as written they still count (see `markText`'s phrase).
 */
const STOPWORDS = new Set(
  (
    "acaba ama ancak aslinda az bana bazi belki ben beni benim bir biri birkac " +
    "birsey biz bize bizi bu buna bunu bunun cok cunku da daha de defa degil " +
    "diye eger en gibi hem hep hepsi her hic icin ile ilk ise kadar kez ki kim " +
    "mi mu na nasil ne neden nerde nerede nereye nicin niye o olan olarak oldu " +
    "olur ona onu onun once sana sanki sen seni senin siz size sonra su sey " +
    "simdi tum var ve veya ya yani yok " +
    "a about after an and are as at be been before but by can could did do " +
    "does for from had has have he her him his how i if in into is it its me " +
    "my no not of on or our out over she so than that the their them then " +
    "there these they this those to up very was we were what when where which " +
    "who why will with would you your"
  ).split(" "),
);

/** A word, folded, that says nothing a search could find it by. */
export function isStopword(folded: string): boolean {
  return STOPWORDS.has(folded);
}

export interface TextWord {
  /** Folded. */
  word: string;
  /** In lower case, its letters as written. */
  plain: string;
  /** Offsets in the original text. */
  start: number;
  end: number;
}

/** The text's words, folded, with where each stands in the original. */
export function textWords(text: string): TextWord[] {
  const folded = foldText(text);
  return Array.from(folded.text.matchAll(WORD), (match) => {
    const start = folded.at[match.index]!;
    // Just past its last letter: a soft hyphen after it is not the word's.
    const last = folded.at[match.index + match[0].length - 1]!;
    const end = last + (text.codePointAt(last)! > 0xffff ? 2 : 1);
    return {
      word: match[0],
      plain: plainWord(text.slice(start, end)),
      start,
      end,
    };
  });
}

/**
 * A Turkish stem's last consonant softens before an ending that begins with
 * a vowel: kitap, kitabı; kırbaç, kırbacı; ağaç, ağacın; renk, rengi. Folded
 * (ç is c, ğ is g) and as written.
 */
const SOFTENED: Record<string, string[]> = {
  p: ["b"],
  t: ["d"],
  k: ["g", "ğ"],
  c: ["c"],
  ç: ["c"],
};

function startsWithStem(word: string, term: string): boolean {
  if (word.startsWith(term)) return true;
  if (term.length < 4 || word.length <= term.length) return false;
  const soft = SOFTENED[term[term.length - 1]!];
  const stem = term.slice(0, -1);
  return Boolean(soft?.some((letter) => word.startsWith(stem + letter)));
}

/**
 * How well a word of the book answers a word of the query: 1 when it is the
 * word or begins with it, less when it only shares its stem, 0 otherwise.
 * One or two letters must be the whole word ("o", "ve"), or they would be
 * found inside everything.
 */
export function wordMatch(term: string, word: string): number {
  if (term.length <= 2) return word === term ? 1 : 0;
  if (startsWithStem(word, term)) return 1;
  // Turkish piles endings onto a stem: a long word of the query finds its
  // stem with other endings.
  if (term.length >= 6) {
    const stem = term.slice(0, Math.max(5, Math.ceil(term.length * 0.6)));
    if (word.startsWith(stem)) return 0.6;
  }
  // A short word written with an ending the book did not use: "kürkü", "kürk".
  if (term.length >= 4 && word.length >= 3 && term.startsWith(word))
    return term.length - word.length === 1 ? 0.6 : 0;
  return 0;
}

/**
 * `wordMatch` for a query word against a word of the book. A word written
 * with letters the book's word lacks ("ölüyor" for "oluyor") answers it only
 * weakly, under MARKED, so it ranks low and is never marked.
 */
export function termMatch(term: QueryTerm, word: TextWord): number {
  const quality = wordMatch(term.folded, word.word);
  if (quality === 0 || !term.strict) return quality;
  return wordMatch(term.plain, word.plain) > 0 ? quality : quality * 0.4;
}

/**
 * A quoted search's rule: the word itself, no other endings; written with
 * Turkish letters, with those letters.
 */
export function exactMatch(term: QueryTerm, word: TextWord): number {
  return word.word === term.folded &&
    (!term.strict || word.plain === term.plain)
    ? 1
    : 0;
}

/** The least `termMatch` a word is marked for. */
export const MARKED = 0.5;

export interface TextMark {
  start: number;
  end: number;
}

/**
 * Where the text answers a search: every run of `phraseWords` in order, and
 * every word that answers one of `termWords` (both as `queryWords` gives
 * them), as ranges of the original text; `exact` for a quoted search, whose
 * words answer only as written (`exactMatch`). Marks only a space apart
 * join, so a phrase reads as one.
 */
export function markText(
  text: string,
  termWords: readonly string[],
  phraseWords: readonly string[] = [],
  exact = false,
): TextMark[] {
  if (termWords.length === 0 && phraseWords.length < 2) return [];
  const answers = exact ? exactMatch : termMatch;
  const terms = termWords.map(queryTerm);
  const phrase = phraseWords.map(queryTerm);
  const words = textWords(text);
  const marks: TextMark[] = [];

  if (phrase.length >= 2) {
    for (let i = 0; i + phrase.length <= words.length; i++) {
      if (phrase.every((term, k) => answers(term, words[i + k]!) >= MARKED)) {
        marks.push({
          start: words[i]!.start,
          end: words[i + phrase.length - 1]!.end,
        });
        i += phrase.length - 1;
      }
    }
  }

  for (const word of words) {
    if (
      terms.some((term) => answers(term, word) >= MARKED) &&
      !marks.some((mark) => word.start >= mark.start && word.end <= mark.end)
    )
      marks.push({ start: word.start, end: word.end });
  }

  marks.sort((a, b) => a.start - b.start);
  const joined: TextMark[] = [];
  for (const mark of marks) {
    const last = joined[joined.length - 1];
    if (last && /^[\s\u00ad]*$/.test(text.slice(last.end, mark.start)))
      last.end = Math.max(last.end, mark.end);
    else joined.push({ ...mark });
  }
  return joined;
}

/**
 * The stretch of the text where the marks gather most: the reader is shown
 * this part of a passage, and is taken to it. The first mark of the densest
 * window of `span` characters, counting each different word once.
 */
export function focusMark(
  text: string,
  marks: readonly TextMark[],
  span = 220,
): TextMark | null {
  let best: TextMark | null = null;
  let bestScore = 0;
  for (let i = 0; i < marks.length; i++) {
    const seen = new Set<string>();
    let length = 0;
    for (let k = i; k < marks.length; k++) {
      if (marks[k]!.end - marks[i]!.start > span) break;
      seen.add(foldWord(text.slice(marks[k]!.start, marks[k]!.end)));
      length += marks[k]!.end - marks[k]!.start;
    }
    // Different words first; then how much of the text they cover.
    const score = seen.size * 1_000 + length;
    if (score > bestScore) {
      best = marks[i]!;
      bestScore = score;
    }
  }
  return best;
}

/** How much of a passage is shown before the words it was found by. */
const LEAD_IN = 70;

export interface ExcerptPart {
  text: string;
  marked: boolean;
}

/**
 * What a hit shows: the passage from a little before the words it was found
 * by, which are marked, so the reader sees why it was found. A passage
 * found by its meaning alone is shown from its start.
 */
export function searchExcerpt(
  text: string,
  found: {
    terms: readonly string[];
    phrase: readonly string[];
    exact?: boolean;
  },
): { cut: boolean; parts: ExcerptPart[] } {
  const marks = markText(text, found.terms, found.phrase, found.exact);
  const focus = focusMark(text, marks);
  let start = 0;
  if (focus && focus.start > LEAD_IN) {
    // From the start of a word, or of the paragraph if that is near.
    const paragraph = text.lastIndexOf("\n", focus.start - 1) + 1;
    start =
      focus.start - paragraph <= LEAD_IN
        ? paragraph
        : text.indexOf(" ", focus.start - LEAD_IN) + 1 || focus.start;
  }
  const parts: ExcerptPart[] = [];
  let at = start;
  for (const mark of marks) {
    if (mark.end <= start) continue;
    const from = Math.max(mark.start, start);
    if (from > at) parts.push({ text: text.slice(at, from), marked: false });
    parts.push({ text: text.slice(from, mark.end), marked: true });
    at = mark.end;
  }
  if (at < text.length) parts.push({ text: text.slice(at), marked: false });
  return { cut: start > 0, parts };
}
