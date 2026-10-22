/**
 * Ranking a book's passages for a search, by meaning and by the words written.
 *
 * Meaning alone (bookSearch.ts's vectors) finds a scene described in other
 * words, but it is weak at the plainest searches: a name, one word, a line
 * quoted exactly. So every passage is also scored on the query's own words
 * (bookSearchText.ts): how many of them it holds, weighted by how rare each
 * is in this book, and whether they stand together as written. The two are
 * added; the words count for more, so a passage that holds what was typed
 * comes before one that only resembles it, and among those the meaning
 * decides.
 *
 * A word the book never uses is taken as a slip of the keyboard when the
 * book has a word one or two letters from it ("Lenia", "Lenina").
 */

import type { BookPassage } from "./bookText";
import {
  exactMatch,
  isStopword,
  MARKED,
  queryTerm,
  queryWords,
  termMatch,
  textWords,
  wordMatch,
  type QueryTerm,
  type TextWord,
} from "../../../lib/bookSearchText";

export interface RankedPassage {
  at: number;
  score: number;
}

export interface PassageRanking {
  ranked: RankedPassage[];
  /** The query's words worth marking, as `queryWords` gives them. */
  terms: string[];
  /** All of the query's words, in order, when a hit holds them so. */
  phrase: string[];
  /** A quoted search, answered by its words exactly as written. */
  exact: boolean;
}

/** The most a search returns. */
export const MOST_HITS = 40;
/** The fewest, when there are that many passages: a few by meaning at least. */
const FEWEST_HITS = 6;
/** A passage scoring under this share of the best is not worth showing. */
const KEEP_SHARE = 0.55;
/** A word in more than this share of the passages is too common to mark. */
const COMMON_SHARE = 0.2;
/** How much the words weigh against the meaning. */
const MEANING_WEIGHT = 0.6;
const WORDS_WEIGHT = 1;
/** BM25's term saturation and length normalisation. */
const K1 = 1.2;
const B = 0.5;

interface BookWords {
  /** Each passage's words. */
  passages: TextWord[][];
  /** Each word the book uses (folded), and in how many passages. */
  vocabulary: Map<string, number>;
  averageLength: number;
}

const bookWords = new WeakMap<BookPassage[], BookWords>();

/** The book's words, read once per loaded index. */
function wordsOfBook(passages: BookPassage[]): BookWords {
  let words = bookWords.get(passages);
  if (!words) {
    const vocabulary = new Map<string, number>();
    const perPassage = passages.map((passage) => {
      const found = textWords(passage.text);
      for (const word of new Set(found.map((entry) => entry.word)))
        vocabulary.set(word, (vocabulary.get(word) ?? 0) + 1);
      return found;
    });
    words = {
      passages: perPassage,
      vocabulary,
      averageLength:
        perPassage.reduce((sum, entry) => sum + entry.length, 0) /
        Math.max(1, perPassage.length),
    };
    bookWords.set(passages, words);
  }
  return words;
}

/** Optimal string alignment distance, or `limit + 1` once it must exceed it. */
function distance(a: string, b: string, limit: number): number {
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  let before = new Array<number>(b.length + 1).fill(0);
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    let least = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let value = Math.min(
        previous[j]! + 1,
        current[j - 1]! + 1,
        previous[j - 1]! + cost,
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
        value = Math.min(value, before[j - 2]! + 1);
      current.push(value);
      least = Math.min(least, value);
    }
    if (least > limit) return limit + 1;
    before = previous;
    previous = current;
  }
  return previous[b.length]!;
}

/**
 * The book's own spelling of a word it never uses: the beginning of one of
 * its words, a letter or two away and starting with the same letter,
 * preferring the closest, then the one as long as what was typed, then the
 * word in more passages. Short words and numbers are left alone; a slip there is
 * as likely to be another word.
 */
function correction(
  word: string,
  vocabulary: Map<string, number>,
): string | null {
  if (word.length < 5 || /\d/.test(word)) return null;
  const limit = word.length >= 8 ? 2 : 1;
  let best: {
    text: string;
    distance: number;
    stretch: number;
    passages: number;
  } | null = null;
  for (const [known, passages] of vocabulary) {
    // A slip is rarely in the first letter; one there is another word.
    if (passages < 2 || known[0] !== word[0]) continue;
    // The word, or its beginning: "Lenia" is "Lenina", "Leninanın" too.
    for (
      let length = word.length - limit;
      length <= word.length + limit;
      length++
    ) {
      if (length < 4 || length > known.length) continue;
      const prefix = known.slice(0, length);
      const away = distance(word, prefix, limit);
      const stretch = Math.abs(length - word.length);
      if (
        away <= limit &&
        (!best ||
          away < best.distance ||
          (away === best.distance &&
            (stretch < best.stretch ||
              (stretch === best.stretch && passages > best.passages))))
      )
        best = { text: prefix, distance: away, stretch, passages };
    }
  }
  return best?.text ?? null;
}

/** 1 when the query's words stand in the passage as written; otherwise the share of its pairs that do. */
function together(sequence: QueryTerm[], words: TextWord[]): number {
  if (sequence.length < 2) return 0;
  const answers = (term: QueryTerm, at: number) =>
    at < words.length && termMatch(term, words[at]!) >= MARKED;
  const pairs = new Array<boolean>(sequence.length - 1).fill(false);
  for (let i = 0; i < words.length; i++) {
    let run = 0;
    while (run < sequence.length && answers(sequence[run]!, i + run)) run++;
    if (run === sequence.length) return 1;
    for (let k = 0; k < pairs.length; k++)
      if (
        !pairs[k] &&
        answers(sequence[k]!, i) &&
        answers(sequence[k + 1]!, i + 1)
      )
        pairs[k] = true;
  }
  return pairs.filter(Boolean).length / pairs.length;
}

/** A query in quotation marks, straight or curly. */
const QUOTED = /^\s*["“”„«»].*["“”«»]\s*$/s;

/** Whether the passage holds the query's words in order, each exactly as written. */
function holdsExactly(sequence: QueryTerm[], words: TextWord[]): boolean {
  for (let i = 0; i + sequence.length <= words.length; i++)
    if (sequence.every((term, k) => exactMatch(term, words[i + k]!) > 0))
      return true;
  return false;
}

/**
 * The passages for a query, best first. `meaning` is each passage's cosine
 * similarity to the query's vector, in passage order.
 */
export function rankPassages(
  passages: BookPassage[],
  meaning: ArrayLike<number>,
  query: string,
): PassageRanking {
  const book = wordsOfBook(passages);
  const total = passages.length;

  // The query's words; in a search for a word or two (a name, most likely),
  // one the book never uses is taken for a slip. A longer query describes,
  // and its words are left as written: Turkish has too many words a letter
  // apart (yakıyor, yapıyor) to guess which was meant.
  const asked = queryWords(query);
  const quoted = QUOTED.test(query) && asked.length > 0;
  const written =
    quoted || asked.length > 2
      ? asked
      : asked.map((word) => {
          const { folded } = queryTerm(word);
          for (const known of book.vocabulary.keys())
            if (wordMatch(folded, known) > 0) return word;
          return correction(folded, book.vocabulary) ?? word;
        });
  const sequence = written.map(queryTerm);
  // Ranked and marked by the words with a subject; the little words count
  // only in the whole line, or when they are all there is.
  const subjects = written.filter(
    (word) => !isStopword(queryTerm(word).folded),
  );
  const unique = [...new Set(subjects.length > 0 ? subjects : written)];
  const terms = unique.map(queryTerm);

  // Meaning, from the median passage (0) to the best (1).
  const sorted = Array.from(meaning).sort((a, b) => b - a);
  const top = sorted[0] ?? 0;
  const floor = sorted[Math.floor(sorted.length / 2)] ?? 0;
  const meaningOf = (at: number) =>
    top > floor
      ? Math.min(1, Math.max(0, (meaning[at]! - floor) / (top - floor)))
      : 0;

  // Per passage and query word: the best answer, and how many words answer.
  const matches = book.passages.map((words) => {
    const best = new Float64Array(terms.length);
    const count = new Float64Array(terms.length);
    for (const word of words)
      for (let t = 0; t < terms.length; t++) {
        const quality = termMatch(terms[t]!, word);
        if (quality > 0) {
          count[t] += quality;
          if (quality > best[t]!) best[t] = quality;
        }
      }
    return { best, count };
  });
  const found = terms.map(
    (_, t) => matches.filter((match) => match.best[t]! > 0).length,
  );
  // Rarer words say more: BM25's inverse document frequency.
  const rarity = found.map((count) =>
    Math.log(1 + (total - count + 0.5) / (count + 0.5)),
  );
  const rarityTotal = rarity.reduce((sum, value) => sum + value, 0);

  const wordsScore = (at: number) => {
    if (rarityTotal <= 0) return 0;
    const { best, count } = matches[at]!;
    const length = book.passages[at]!.length;
    let held = 0;
    let frequency = 0;
    for (let t = 0; t < terms.length; t++) {
      held += rarity[t]! * best[t]!;
      const c = count[t]!;
      frequency +=
        (rarity[t]! * (c * (K1 + 1))) /
        (c + K1 * (1 - B + (B * length) / book.averageLength)) /
        (K1 + 1);
    }
    held /= rarityTotal;
    frequency /= rarityTotal;
    if (held === 0) return 0;
    if (sequence.length < 2) return 0.8 * held + 0.2 * frequency;
    return (
      0.65 * held +
      0.25 * together(sequence, book.passages[at]!) +
      0.1 * frequency
    );
  };

  // A query whose words are mostly not in the book describes it in other
  // words (or another language): what few of its words match, by chance,
  // count for less, and are not marked.
  const inBook =
    terms.length > 0
      ? found.filter((count) => count > 0).length / terms.length
      : 0;
  const describes = inBook < 0.5;
  const wordsWeight = WORDS_WEIGHT * inBook;

  const scored = passages.map((_, at) => ({
    at,
    score: MEANING_WEIGHT * meaningOf(at) + wordsWeight * wordsScore(at),
  }));
  scored.sort((a, b) => b.score - a.score);

  // Quoted: only the passages that hold the words exactly as written, if
  // any do; if none does, the search is answered as if unquoted.
  if (quoted) {
    const exactly = scored.filter(({ at }) =>
      holdsExactly(sequence, book.passages[at]!),
    );
    if (exactly.length > 0)
      return {
        ranked: exactly
          .slice(0, MOST_HITS)
          .map(({ at, score }) => ({ at, score })),
        terms: sequence.length === 1 ? written : [],
        phrase: sequence.length > 1 ? written : [],
        exact: true,
      };
  }

  const best = scored[0]?.score ?? 0;
  const ranked: RankedPassage[] = [];
  for (const entry of scored) {
    if (ranked.length >= MOST_HITS) break;
    if (ranked.length >= FEWEST_HITS && entry.score < best * KEEP_SHARE) break;
    ranked.push({ at: entry.at, score: entry.score });
  }

  if (describes) return { ranked, terms: [], phrase: [], exact: false };
  // Marked: the words rare enough to say something here, or, if none is,
  // all of them. Any of them may be what was searched for.
  const rare = unique.filter(
    (_, t) => found[t]! > 0 && found[t]! <= total * COMMON_SHARE,
  );
  const present = unique.filter((_, t) => found[t]! > 0);
  const phraseFound =
    sequence.length >= 2 &&
    ranked.some(({ at }) => together(sequence, book.passages[at]!) === 1);

  return {
    ranked,
    terms: rare.length > 0 ? rare : present,
    phrase: phraseFound ? written : [],
    exact: false,
  };
}
