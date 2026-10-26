import type { NarrationSection } from "./narrationScript";

/** `[block, start, end, t0, t1]`: see NarrationTimings in src/lib/bookNarrationApi.ts. */
export type TimedWord = [number, number, number, number, number];

/** Far more words than any section of any book holds. */
const MAX_WORDS = 400_000;
/** The audio may run a little past the last word: its closing silence. */
const END_SLACK_MS = 2_000;
export const MAX_SECTION_SECONDS = 24 * 60 * 60;

export class TimingsError extends Error {}

const integer = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0;

/**
 * A section's word timings as a narrator uploads them, checked against the
 * section the server would hand it: every word in a block of that section,
 * inside that block's text, heard within the audio and in the order read.
 * The reader finds each word on the page by these numbers alone, so timings
 * that pass are timings it can show.
 */
export function checkTimings(
  section: NarrationSection,
  words: unknown,
  durationSeconds: number,
): TimedWord[] {
  if (
    typeof durationSeconds !== "number" ||
    !Number.isFinite(durationSeconds) ||
    durationSeconds <= 0 ||
    durationSeconds > MAX_SECTION_SECONDS
  )
    throw new TimingsError("The section's duration is not a length of audio.");
  if (!Array.isArray(words) || words.length > MAX_WORDS)
    throw new TimingsError("The words are not a list of timed words.");

  const lengths = new Map(
    section.blocks.map((block) => [block.block, block.text.length]),
  );
  const end = durationSeconds * 1000 + END_SLACK_MS;
  let previous = 0;

  return words.map((word, index): TimedWord => {
    if (!Array.isArray(word) || word.length !== 5 || !word.every(integer))
      throw new TimingsError(`Word ${index} is not five whole numbers.`);
    const [block, start, stop, t0, t1] = word as TimedWord;
    const length = lengths.get(block);
    if (length === undefined)
      throw new TimingsError(
        `Word ${index} is in block ${block}, which this section does not read.`,
      );
    if (start >= stop || stop > length)
      throw new TimingsError(`Word ${index} is not inside its block's text.`);
    if (t0 > t1 || t1 > end)
      throw new TimingsError(`Word ${index} is not heard within the audio.`);
    if (t0 < previous)
      throw new TimingsError(
        `Word ${index} is heard before the word read before it.`,
      );
    previous = t0;
    return [block, start, stop, t0, t1];
  });
}
