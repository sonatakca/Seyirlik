/**
 * Episodes that share one file.
 *
 * SpongeBob's TMDB numbering is per eleven-minute story and its files are
 * half-hours of two or three. Such an episode plays its host's file from its
 * own start (`PlayAs`), the player names whichever part is under the playhead
 * (`FileParts`), and progress goes to that part, on its own clock, so each
 * story keeps its own resume point and watched mark.
 *
 * Times are seconds on the file's timeline. A part whose start is unknown (a
 * release named S01E01-E03 says the order, not the places) cannot be located,
 * so a file with one is treated as a single stretch belonging to the item that
 * was opened.
 */
import type { MediaFilePart, MediaItem } from "./types";

/** How close to a boundary counts as across it: a seek lands near, not on. */
const BOUNDARY_TOLERANCE_SECONDS = 0.5;

/** Where the opened episode starts in the file. */
export function partStartSeconds(item: MediaItem | null): number {
  return item?.PlayAs?.StartSeconds ?? 0;
}

function locatedParts(item: MediaItem | null): MediaFilePart[] | null {
  const parts = item?.FileParts;
  if (!parts || parts.length < 2) return null;
  return parts.every((part) => part.StartSeconds !== undefined)
    ? parts
    : null;
}

/** The part playing at `seconds`, or null when the file has no located parts. */
export function filePartAt(
  item: MediaItem | null,
  seconds: number,
): MediaFilePart | null {
  const parts = locatedParts(item);
  if (!parts) return null;
  let active = parts[0]!;
  for (const part of parts) {
    if (part.StartSeconds! <= seconds + BOUNDARY_TOLERANCE_SECONDS) {
      active = part;
    }
  }
  return active;
}

export interface PartProgress {
  /** The episode the position belongs to. */
  itemId: string;
  /** Seconds into that episode. */
  positionSeconds: number;
  /** Its place in the file, so a caller can tell playing on from seeking. */
  index: number;
}

/**
 * Turns a position on the file's timeline into progress for the episode
 * playing there. Null for an item that is not part of a shared file.
 */
export function partProgress(
  item: MediaItem | null,
  seconds: number,
): PartProgress | null {
  const parts = locatedParts(item);
  if (!item || !parts) return null;
  const active = filePartAt(item, seconds)!;
  return {
    itemId: active.Id,
    positionSeconds: Math.max(0, seconds - active.StartSeconds!),
    index: parts.indexOf(active),
  };
}

/**
 * The opened episode's own resume point, as a time in the file.
 *
 * `UserData` holds it on the episode's own clock. A saved place past the
 * episode's end (it was played whole once) starts the episode over.
 */
export function initialFileSeconds(
  item: MediaItem | null,
  savedSeconds: number,
): number {
  const start = partStartSeconds(item);
  if (!item?.PlayAs) return savedSeconds;
  const end = item.PlayAs.EndSeconds;
  const length = end === undefined ? undefined : end - start;
  return length !== undefined && savedSeconds >= length
    ? start
    : start + savedSeconds;
}

/** Whether `candidate` plays inside the file `current` is playing. */
export function sharesFile(
  current: MediaItem | null,
  candidate: MediaItem | null,
): boolean {
  if (!current?.FileParts || !candidate) return false;
  return current.FileParts.some((part) => part.Id === candidate.Id);
}
