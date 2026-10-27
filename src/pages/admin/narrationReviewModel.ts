import type {
  NarrationLineReason,
  NarrationPronunciation,
  NarrationReviewLine,
} from "../../lib/narrationReviewApi";

/**
 * The book's line beside what the narrator heard in it, word for word.
 *
 * Whisper hears the take knowing nothing of the text, so a word it writes
 * differently is a word worth listening to: "Sergievi" heard as "Serciyevi"
 * passed the narrator's letter-for-letter check (one letter in a long line),
 * but it is exactly what a listener notices. Whisper also joins and splits
 * words its own way ("akşamüzeri" / "akşam üzeri"), and a word on the
 * pronunciation list is said as listed ("Sergievi" as "sergi evi"); neither
 * is a difference.
 */

export interface WordMark {
  /** The word's characters in the line's text. */
  start: number;
  end: number;
  /** Heard as written, heard as something else, or not heard at all. */
  status: "same" | "changed" | "missing";
  /** What was heard in its place, when it was heard as something else. */
  heard?: string;
  /** The aligner was unsure the word was said as written. */
  unsure?: boolean;
}

export interface LineComparison {
  words: WordMark[];
  /** Words heard where the book has none. */
  extra: string[];
  /** Whether anything was heard otherwise than the book has it. */
  differs: boolean;
  /**
   * How far what was heard is from the book, 0 to 1: the worst word's share
   * of letters heard otherwise, 1 for a word not heard. One letter in a
   * long word ("Heppner" as "Hepner") is usually how Whisper spells; a
   * word that sounds like another ("büsbütün" as "müsbütün") is worth a listen.
   */
  severity: number;
}

/** Edits between two strings: letters put in, taken out or changed. */
function distance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++)
      current[j] = Math.min(
        previous[j]! + 1,
        current[j - 1]! + 1,
        previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    previous = current;
  }
  return previous[b.length]!;
}

const WORD = /[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu;

export function turkishLower(value: string): string {
  return value.replace(/I/g, "ı").replace(/İ/g, "i").toLowerCase();
}

/** How a word is looked up in the pronunciation list (pronunciationKey on the server). */
export function pronunciationKey(word: string): string {
  return turkishLower(word.normalize("NFC").split(/['’]/)[0] ?? "");
}

const ONES = [
  "",
  "bir",
  "iki",
  "üç",
  "dört",
  "beş",
  "altı",
  "yedi",
  "sekiz",
  "dokuz",
];
const TENS = [
  "",
  "on",
  "yirmi",
  "otuz",
  "kırk",
  "elli",
  "altmış",
  "yetmiş",
  "seksen",
  "doksan",
];

/** Digits as Turkish says them, joined: Whisper writes "25" where the book has "yirmi beş". */
function numberSound(digits: string): string {
  let n = Number(digits);
  if (!Number.isSafeInteger(n) || digits.length > 12) return digits;
  if (n === 0) return "sıfır";
  const below = (value: number) => {
    const hundreds = Math.floor(value / 100);
    const rest = value % 100;
    return (
      (hundreds ? (hundreds === 1 ? "" : ONES[hundreds]) + "yüz" : "") +
      TENS[Math.floor(rest / 10)] +
      ONES[rest % 10]
    );
  };
  let out = "";
  for (const [scale, name] of [
    [1e9, "milyar"],
    [1e6, "milyon"],
    [1e3, "bin"],
  ] as const) {
    const count = Math.floor(n / scale);
    if (count) out += (count === 1 && scale === 1e3 ? "" : below(count)) + name;
    n %= scale;
  }
  return out + below(n);
}

/**
 * A word reduced to what can be heard of it: its letters, in lower case,
 * numbers spelled out, and the circumflex Whisper never writes ("imkân" is
 * heard as "imkan") taken off.
 */
const sound = (word: string) =>
  turkishLower(word.normalize("NFC"))
    .replace(/[âÂ]/g, "a")
    .replace(/[îÎ]/g, "i")
    .replace(/[ûÛ]/g, "u")
    .replace(/\d+/g, numberSound)
    .replace(/[^\p{L}\p{N}]/gu, "");

/** "Gülümseme ile" and "gülümsemeyle" are one thing said; Whisper writes the second. */
const withoutIle = (sounds: string[]) =>
  sounds
    .filter((value) => value !== "ile")
    .join("")
    .replace(/y?l[ae](?=$)/, "");

/** A phrase Whisper writes on silence and noise ("Altyazı M.K."), never anything said. */
const PHANTOM = /\s*Altyazı\s+M\.?\s*K\.?\s*$/iu;

interface Token {
  text: string;
  sound: string;
  start: number;
  end: number;
}

function tokens(text: string, sayAs?: (word: string) => string): Token[] {
  return [...text.matchAll(WORD)].map((match) => ({
    text: match[0],
    sound: sound(sayAs ? sayAs(match[0]) : match[0]),
    start: match.index ?? 0,
    end: (match.index ?? 0) + match[0].length,
  }));
}

/** The longest common subsequence of two token lists, as pairs of indexes. */
function common(a: Token[], b: Token[]): Array<[number, number]> {
  const lengths = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      lengths[i]![j] =
        a[i]!.sound === b[j]!.sound
          ? lengths[i + 1]![j + 1]! + 1
          : Math.max(lengths[i + 1]![j]!, lengths[i]![j + 1]!);
  const pairs: Array<[number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i]!.sound === b[j]!.sound) {
      pairs.push([i, j]);
      i++;
      j++;
    } else if (lengths[i + 1]![j]! >= lengths[i]![j + 1]!) i++;
    else j++;
  }
  return pairs;
}

export function compareLine(
  line: Pick<NarrationReviewLine, "text" | "heard" | "start" | "unsure">,
  pronunciations: NarrationPronunciation[] = [],
): LineComparison {
  const listed = new Map(pronunciations.map((row) => [row.word, row.spoken]));
  // As the narrator says it (say_as in text.py): a suffix after an apostrophe stays.
  const sayAs = (word: string) => {
    const spoken = listed.get(pronunciationKey(word));
    const suffix = /['’].*$/.exec(word)?.[0] ?? "";
    return spoken === undefined ? word : spoken + suffix;
  };
  const book = tokens(line.text, sayAs);
  const heard = tokens(line.heard.replace(PHANTOM, ""));
  const words: WordMark[] = book.map((token) => ({
    start: token.start,
    end: token.end,
    status: "same",
  }));
  const extra: string[] = [];
  let severity = 0;

  // Between two words heard as written, what the book has and what was heard.
  const gap = (
    bookFrom: number,
    bookTo: number,
    heardFrom: number,
    heardTo: number,
  ) => {
    const ours = book.slice(bookFrom, bookTo);
    const theirs = heard.slice(heardFrom, heardTo);
    if (ours.length === 0 && theirs.length === 0) return;
    // Joined or split differently, the same sounds.
    const a = ours.map((t) => t.sound);
    const b = theirs.map((t) => t.sound);
    if (a.join("") === b.join("")) return;
    if (a.includes("ile") && withoutIle(a) === withoutIle(b)) return;
    if (ours.length === 0) {
      extra.push(...theirs.map((t) => t.text));
      severity = Math.max(severity, 0.5);
      return;
    }
    const ourSound = a.join("");
    const theirSound = b.join("");
    severity = Math.max(
      severity,
      theirSound
        ? distance(ourSound, theirSound) /
            Math.max(ourSound.length, theirSound.length)
        : 1,
    );
    const said = theirs.map((t) => t.text).join(" ");
    for (let k = bookFrom; k < bookTo; k++) {
      words[k] = {
        ...words[k]!,
        status: said ? "changed" : "missing",
        ...(said ? { heard: said } : {}),
      };
    }
  };

  let bookAt = 0;
  let heardAt = 0;
  for (const [i, j] of common(book, heard)) {
    gap(bookAt, i, heardAt, j);
    bookAt = i + 1;
    heardAt = j + 1;
  }
  gap(bookAt, book.length, heardAt, heard.length);

  // The aligner's doubts are in the block's characters; the line starts at `start`.
  for (const [from, to] of line.unsure) {
    for (const word of words)
      if (word.start < to - line.start && word.end > from - line.start)
        word.unsure = true;
  }

  return {
    words,
    extra,
    differs: extra.length > 0 || words.some((word) => word.status !== "same"),
    severity: Math.round(severity * 100) / 100,
  };
}

export type ReviewFilter = "issues" | "all";

/** What a line is worth a listen for: the narrator's own doubts, then what was heard otherwise. */
export function lineIssues(
  line: NarrationReviewLine,
  comparison: LineComparison,
): Array<NarrationLineReason | "heard-otherwise"> {
  const issues: Array<NarrationLineReason | "heard-otherwise"> = [
    ...line.reasons,
  ];
  if (comparison.differs && !issues.includes("skipped-words"))
    issues.push("heard-otherwise");
  return issues;
}

/** A line asked for again whose new reading has not come yet. */
export const awaitingRetake = (line: NarrationReviewLine) =>
  line.asked > line.retakes;

/** "1:05:09": a place in a section's audio. */
export function formatAt(ms: number): string {
  const total = Math.floor(ms / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const two = (value: number) => String(value).padStart(2, "0");
  return hours > 0
    ? `${hours}:${two(minutes)}:${two(seconds)}`
    : `${minutes}:${two(seconds)}`;
}
