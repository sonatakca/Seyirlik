/**
 * Moving a subtitle's cues by a piecewise alignment, and nothing else.
 *
 * `retimeBlocks` moves every cue by one transform. This moves each cue by its
 * own placement — the one the alignment proposed for it — under the same
 * promise the parser makes: everything that is not a timestamp comes back out
 * unchanged, and a cue the alignment did not move keeps its timestamps to the
 * millisecond, so a region already right is not even reformatted.
 *
 * Three decisions are made here rather than by the alignment:
 *
 *  - **Unmatched cues** — dialogue from footage this edition does not have —
 *    stay where they were unless the caller asks for them to be excluded. An
 *    excluded cue is not lost: the version it came from is a revision, and the
 *    report names it. Nothing here excludes on its own initiative.
 *  - **A cue pushed entirely before the media begins** has nowhere to be. It is
 *    left out and counted, and its presence makes the result one a person must
 *    look at (see `canApplyUnreviewed`).
 *  - **A moved cue that now runs into the next** is ended where the next one
 *    starts, provided that leaves it on screen for a readable time; two lines
 *    that already overlapped in the original are a choice its author made and
 *    are left overlapping.
 */

import type {
  AlignmentCue,
  CueDisposition,
  PiecewiseAlignment,
  PiecewiseCue,
} from "./piecewiseAlignment";
import {
  documentCues,
  type SubtitleBlock,
  type SubtitleDocument,
  type TimedCue,
} from "./subtitleCues";

/**
 * The cues of a document as the aligner reads them: every one, in document
 * order, named by position — which is how a placement names them back.
 */
export function alignmentCues(document: SubtitleDocument): AlignmentCue[] {
  return documentCues(document).map((cue, index) => ({
    index,
    startSeconds: cue.startSeconds,
    endSeconds: cue.endSeconds,
  }));
}

/** Shorter than this a line cannot be read, so an overlap is kept rather than cut to it. */
const MINIMUM_READABLE_SECONDS = 0.7;

export interface PlacementOptions {
  /** What to do with dialogue from footage this edition lacks. */
  readonly unmatched: "keep" | "exclude";
}

export interface PlacementReport {
  readonly blocks: readonly SubtitleBlock[];
  /** Cues given new timestamps. */
  readonly moved: number;
  /** Unmatched cues left out, by their position in the document's cue list. */
  readonly excluded: readonly number[];
  /** Cues that would have ended before the media began, left out. */
  readonly beforeMedia: readonly number[];
  /** Cues that started before zero and were held at it. */
  readonly clamped: number;
  /** Moved cues ended early so they no longer run into the next line. */
  readonly trimmed: number;
}

const MOVED: ReadonlySet<CueDisposition> = new Set(["corrected", "inferred"]);

/**
 * Applies an alignment's placements to the document it was computed for.
 *
 * The alignment names cues by their position in `documentCues(document)`, so
 * the document must be the one that was analysed; a count that does not match
 * is refused rather than applied to the wrong lines.
 */
export function applyPlacements(
  document: SubtitleDocument,
  cues: readonly Pick<
    PiecewiseCue,
    "index" | "disposition" | "startSeconds" | "endSeconds"
  >[],
  options: PlacementOptions,
): PlacementReport {
  const timed = documentCues(document);
  if (cues.length !== timed.length)
    throw new Error(
      "The alignment was computed for a different version of this subtitle.",
    );
  const placement = new Map(cues.map((cue) => [cue.index, cue]));

  // First pass: where each cue goes, or that it goes nowhere.
  const decided = timed.map((cue, index) => {
    const placed = placement.get(index);
    if (!placed) throw new Error("The alignment does not place every cue.");
    if (placed.disposition === "unmatched" && options.unmatched === "exclude")
      return { cue, index, keep: false as const, reason: "excluded" as const };
    if (!MOVED.has(placed.disposition))
      return {
        cue,
        index,
        keep: true as const,
        moved: false,
        start: cue.startSeconds,
        end: cue.endSeconds,
      };
    if (
      !Number.isFinite(placed.startSeconds) ||
      !Number.isFinite(placed.endSeconds)
    )
      throw new Error("The alignment placed a cue at no time at all.");
    if (placed.endSeconds <= 0)
      return {
        cue,
        index,
        keep: false as const,
        reason: "before-media" as const,
      };
    return {
      cue,
      index,
      keep: true as const,
      moved: true,
      start: placed.startSeconds,
      end: placed.endSeconds,
    };
  });

  // Second pass: trim a moved cue that now runs into the next kept one.
  const kept = decided.filter(
    (entry): entry is Extract<(typeof decided)[number], { keep: true }> =>
      entry.keep,
  );
  let trimmed = 0;
  const finalEnd = new Map<number, number>();
  for (let at = 0; at < kept.length; at += 1) {
    const entry = kept[at] as (typeof kept)[number];
    let end = entry.end;
    const next = kept[at + 1];
    if (entry.moved && next && end > next.start) {
      const overlappedBefore = entry.cue.endSeconds > next.cue.startSeconds;
      if (
        !overlappedBefore &&
        next.start - entry.start >= MINIMUM_READABLE_SECONDS
      ) {
        end = next.start;
        trimmed += 1;
      }
    }
    finalEnd.set(entry.index, end);
  }

  let moved = 0;
  let clamped = 0;
  const excluded: number[] = [];
  const beforeMedia: number[] = [];
  const outcome = new Map<TimedCue, TimedCue | null>();
  for (const entry of decided) {
    if (!entry.keep) {
      (entry.reason === "excluded" ? excluded : beforeMedia).push(entry.index);
      outcome.set(entry.cue, null);
      continue;
    }
    if (!entry.moved) {
      outcome.set(entry.cue, entry.cue);
      continue;
    }
    moved += 1;
    if (entry.start < 0) clamped += 1;
    outcome.set(entry.cue, {
      ...entry.cue,
      startSeconds: Math.max(0, entry.start),
      endSeconds: finalEnd.get(entry.index) as number,
    });
  }

  const blocks = document.blocks.flatMap((block): SubtitleBlock[] => {
    if (block.kind !== "cue") return [block];
    const replaced = outcome.get(block);
    return replaced ? [replaced] : [];
  });
  return { blocks, moved, excluded, beforeMedia, clamped, trimmed };
}

/**
 * Whether an alignment may be written without anybody looking at it.
 *
 * The engine's own `autoApplicable` says the evidence is strong everywhere;
 * this adds what only the document knows — that applying it would leave every
 * line of dialogue in place.
 */
export function canApplyUnreviewed(
  alignment: Pick<PiecewiseAlignment, "autoApplicable">,
  report: Pick<PlacementReport, "excluded" | "beforeMedia">,
): boolean {
  return (
    alignment.autoApplicable &&
    report.excluded.length === 0 &&
    report.beforeMedia.length === 0
  );
}
