import type { NarrationScript, NarrationSection } from "./narrationScript";

/**
 * What the narrator heard in every line of a section, for an administrator
 * to compare with the book, and the words of the pronunciation list. The
 * narrator writes the lines (narrate.py, `assemble`); the review page reads
 * them with each line's text from the script beside them.
 */

/** Why a line was not taken as it should have been: see Verdict.reasons in narrator/seyirlik_narrator/verify.py. */
export const LINE_REASONS = [
  "length",
  "skipped-words",
  "pronunciation",
  "tone",
] as const;
export type LineReason = (typeof LINE_REASONS)[number];

export interface NarrationCheckLine {
  /** The narrator's chunk: "<section>-<block>-<index>". */
  chunk: string;
  block: number;
  /** The line's characters in its block's text. */
  start: number;
  end: number;
  /** Where it is heard in the section's audio, and for how long, in ms. */
  at: number;
  duration: number;
  /** What Whisper heard, knowing nothing of the text. */
  heard: string;
  /** What the voice was given, where a pronunciation changed the book's words. */
  spoken: string | null;
  /** How well what was heard matches what was to be said, 0 to 1. */
  match: number;
  /** How much louder its last words were than its middle one, in dB. */
  lift: number | null;
  reasons: LineReason[];
  /** Words the aligner was unsure were said as written: [start, end] in the block. */
  unsure: Array<[number, number]>;
  takes: number;
  /** The times a person asked for it to be read again, as this reading was made. */
  retakes: number;
}

export class CheckError extends Error {}

const MAX_LINES = 100_000;
const MAX_TEXT = 5_000;
const CHUNK = /^(\d{1,6})-(\d{1,7})-(\d{1,5})$/;

const whole = (
  value: unknown,
  max = Number.MAX_SAFE_INTEGER,
): value is number =>
  typeof value === "number" &&
  Number.isInteger(value) &&
  value >= 0 &&
  value <= max;
const finite = (value: unknown, min: number, max: number): value is number =>
  typeof value === "number" &&
  Number.isFinite(value) &&
  value >= min &&
  value <= max;
const text = (value: unknown): value is string =>
  typeof value === "string" && value.length <= MAX_TEXT;

/**
 * A section's lines as a narrator sends them, checked against the section the
 * server would read: every line in one of its blocks, inside that block's
 * text, and heard within the audio.
 */
export function checkLines(
  section: NarrationSection,
  lines: unknown,
  durationSeconds: number,
): NarrationCheckLine[] {
  if (!Array.isArray(lines) || lines.length > MAX_LINES)
    throw new CheckError("The lines are not a list.");
  const lengths = new Map(
    section.blocks.map((block) => [block.block, block.text.length]),
  );
  const end = durationSeconds * 1000 + 2_000;
  return lines.map((raw, index): NarrationCheckLine => {
    const bad = (why: string) => new CheckError(`Line ${index} ${why}.`);
    if (typeof raw !== "object" || raw === null || Array.isArray(raw))
      throw bad("is not a line");
    const line = raw as Record<string, unknown>;
    const chunk =
      typeof line.chunk === "string" ? CHUNK.exec(line.chunk) : null;
    if (!chunk || Number(chunk[1]) !== section.section)
      throw bad("names no chunk of this section");
    const length = lengths.get(line.block as number);
    if (
      !whole(line.block) ||
      length === undefined ||
      Number(chunk[2]) !== line.block
    )
      throw bad("is in a block this section does not read");
    if (
      !whole(line.start) ||
      !whole(line.end) ||
      line.start > line.end ||
      line.end > length
    )
      throw bad("is not inside its block's text");
    if (
      !whole(line.at) ||
      !whole(line.duration) ||
      line.at + line.duration > end + 60_000
    )
      throw bad("is not heard within the audio");
    if (
      !text(line.heard) ||
      !(line.spoken === null || line.spoken === undefined || text(line.spoken))
    )
      throw bad("has text too long to be a line");
    if (!finite(line.match, 0, 1)) throw bad("has no match");
    if (
      !(
        line.lift === null ||
        line.lift === undefined ||
        finite(line.lift, -200, 200)
      )
    )
      throw bad("has a lift that is no loudness");
    if (
      !Array.isArray(line.reasons) ||
      line.reasons.length > LINE_REASONS.length ||
      !line.reasons.every((reason) =>
        LINE_REASONS.includes(reason as LineReason),
      )
    )
      throw bad("gives a reason there is none of");
    if (
      !Array.isArray(line.unsure) ||
      line.unsure.length > 500 ||
      !line.unsure.every(
        (pair) =>
          Array.isArray(pair) &&
          pair.length === 2 &&
          whole(pair[0]) &&
          whole(pair[1]) &&
          pair[0] < pair[1] &&
          pair[1] <= length,
      )
    )
      throw bad("names unsure words outside its block");
    if (!whole(line.takes, 1_000) || !whole(line.retakes, 1_000_000))
      throw bad("counts its takes wrong");
    return {
      chunk: line.chunk as string,
      block: line.block,
      start: line.start,
      end: line.end,
      at: line.at,
      duration: line.duration,
      heard: line.heard,
      spoken: (line.spoken as string | null | undefined) ?? null,
      match: line.match,
      lift: (line.lift as number | null | undefined) ?? null,
      reasons: line.reasons as LineReason[],
      unsure: line.unsure as Array<[number, number]>,
      takes: line.takes,
      retakes: line.retakes,
    };
  });
}

// -- the pronunciation list ----------------------------------------------------

/** A word as the narrator cuts the text into words (WORD in text.py). */
const WORD = /[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu;
const KEY = /^[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*$/u;

export function turkishLower(value: string): string {
  return value.replace(/I/g, "ı").replace(/İ/g, "i").toLowerCase();
}

/**
 * How a word is looked up in the pronunciation list, as the narrator does
 * (pronunciation_key in text.py): as written, in Turkish lower case, without
 * a suffix after an apostrophe. Null for what is not one word.
 */
export function pronunciationKey(word: string): string | null {
  const stem = word.normalize("NFC").trim().split(/['’]/)[0] ?? "";
  const key = turkishLower(stem);
  return key.length >= 1 && key.length <= 100 && KEY.test(key) ? key : null;
}

/** How the voice is to say it: one line of plain words, or null. */
export function spokenForm(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const spoken = value.normalize("NFC").replace(/\s+/g, " ").trim();
  return spoken.length >= 1 && spoken.length <= 200 && /\p{L}/u.test(spoken)
    ? spoken
    : null;
}

/** Whether the script has the word anywhere, as the narrator would look it up. */
export function scriptHasWord(script: NarrationScript, key: string): boolean {
  return script.sections.some((section) =>
    section.blocks.some((block) =>
      [...block.text.normalize("NFC").matchAll(WORD)].some(
        (match) => pronunciationKey(match[0]) === key,
      ),
    ),
  );
}
