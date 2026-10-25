/**
 * Finding where each part of a subtitle belongs, not just where the whole of it does.
 *
 * `alignSpeech` answers one question: which single `rate · t + offset` maps a
 * subtitle onto a film. That is the right model for a subtitle and a film that
 * are two clocks, and the wrong one for a subtitle timed to a different *cut*:
 * an episode whose second half runs eight seconds late has no single answer,
 * and the old aligner found one anyway — the late half's −8 s, scored at 0.84
 * confidence — which fixed twenty minutes and broke the twenty before them.
 *
 * So the model here is a sequence of transforms, one per region, found rather
 * than assumed:
 *
 *  1. **Every cue is scored at every offset** against the reference, as
 *     evidence *above chance*: how far its start lands from a reference onset
 *     and how much of it lands on speech, each minus what a cue placed at
 *     random would get. A cue with no evidence scores about zero wherever it
 *     goes, so it cannot pull a region anywhere.
 *  2. **A dynamic program chooses one offset per cue**, maximising the summed
 *     evidence minus a fixed penalty for every change of offset. A breakpoint
 *     therefore has to pay for itself with the evidence of the cues after it;
 *     a single coincidental match cannot afford one, and a run of agreeing
 *     cues can. This is the split-penalty alignment `alass` uses, with a
 *     chance-centred score so that "unmatched" needs no state of its own.
 *  3. **Each region is then tested on its own**: refined to the millisecond
 *     against the reference onsets it pairs with, measured against decoy
 *     offsets (how often chance alone would agree), and compared with leaving
 *     it exactly where it is. A region that does not beat its decoys is
 *     unresolved; one that is about as good unmoved is left alone. Nothing is
 *     corrected because a correction was available.
 *  4. **Cues no region claims** are placed only by what the regions around
 *     them allow. Between two regions that agree, they move with them. Next to
 *     an edit, a cue that fits neither side's timeline — it would land on top
 *     of dialogue both regions already own — belonged to footage this edition
 *     does not have, and is reported as unmatched rather than placed anywhere.
 *
 * Inputs are intervals and anchors on the media's timeline, so this serves a
 * reference subtitle, an audio track's speech, an ASR transcript, and anchors
 * from matching what the subtitle *says* to what was spoken, all through one
 * scoring function. Nothing here reads a character of dialogue.
 */

import {
  alignSpeech,
  CANDIDATE_RATES,
  leastSquares,
  type SpeechInterval,
} from "./subtitleAlignment";

/** Bumped whenever a change here can change an answer for the same inputs. */
export const PIECEWISE_ALIGNER_VERSION = "piecewise-1";

/** What the reference intervals are, which decides how far each edge is trusted. */
export type ReferenceKind = "subtitle" | "speech" | "transcript";

export interface AlignmentReference {
  readonly kind: ReferenceKind;
  /** On the media's timeline. */
  readonly intervals: readonly SpeechInterval[];
}

/**
 * A claim that one cue's dialogue is spoken at one moment of the media.
 *
 * Produced by matching a cue's meaning to a transcript segment. `weight` is
 * how much that one claim is worth, in the same units as one cue's evidence
 * (about one for a cue landing exactly on a reference onset); the caller sets
 * it from how reliable the match was, and an ambiguous match should carry
 * little.
 */
export interface CueAnchor {
  readonly cueIndex: number;
  readonly mediaSeconds: number;
  readonly weight: number;
}

export interface AlignmentCue {
  /** The cue's position in the document, which is how the result names it. */
  readonly index: number;
  readonly startSeconds: number;
  readonly endSeconds: number;
}

export type SegmentStatus =
  /** Strong evidence that the region is already right. Not moved. */
  | "aligned"
  /** Strong evidence for a transform that is not the identity. */
  | "corrected"
  /** Too little evidence of its own; placed by the regions around it. */
  | "inferred"
  /** Too little evidence, and the regions around it disagree. Not moved. */
  | "unresolved";

export type CueDisposition =
  | SegmentStatus
  /** Belongs to footage this edition does not have. Left for review. */
  | "unmatched";

export interface PiecewiseSegment {
  readonly status: SegmentStatus;
  /** Positions in the document's cue list, inclusive. */
  readonly firstCue: number;
  readonly lastCue: number;
  readonly sourceStartSeconds: number;
  readonly sourceEndSeconds: number;
  readonly rate: number;
  readonly offsetSeconds: number;
  readonly cueCount: number;
  /** Cues whose start lands within a few tenths of a reference onset. */
  readonly matchedCues: number;
  /**
   * How far above chance the region's agreement stands, 0 to 1, measured the
   * way `alignSpeech` measures a whole film: the same count at deliberately
   * wrong offsets is what chance gives, and this is how much better the
   * region does. Zero for a region placed by its neighbours.
   */
  readonly confidence: number;
  /** Typical distance from a matched cue to its reference onset. */
  readonly medianErrorSeconds: number | null;
}

export interface PiecewiseCue {
  readonly index: number;
  readonly disposition: CueDisposition;
  readonly sourceStartSeconds: number;
  readonly sourceEndSeconds: number;
  /** Where it would go. Equal to the source for anything not moved. */
  readonly startSeconds: number;
  readonly endSeconds: number;
}

export type BreakpointKind =
  /** Footage the subtitle's edition had and this one does not. */
  | "removed"
  /** Footage this edition has and the subtitle's did not. */
  | "inserted";

export interface PiecewiseBreakpoint {
  /** Between the last supported cue before and the first after, in source time. */
  readonly afterSourceSeconds: number;
  readonly beforeSourceSeconds: number;
  readonly kind: BreakpointKind;
  /** How much media time appeared or disappeared. Always positive. */
  readonly seconds: number;
}

export type PiecewiseVerdict =
  /** Every supported region is already right. Nothing to do. */
  | "in-sync"
  /** Every cue is placed by evidence or by agreeing neighbours. */
  | "correctable"
  /** Some regions are supported, some are not. A person should look. */
  | "partial"
  /** The supported regions would put dialogue out of order. */
  | "reordered"
  /** Not enough of the subtitle agrees with the reference to say anything. */
  | "insufficient-evidence";

export interface PiecewiseAlignment {
  readonly verdict: PiecewiseVerdict;
  /** The rate every region was searched at; regions may refine their own. */
  readonly rate: number;
  readonly segments: readonly PiecewiseSegment[];
  readonly cues: readonly PiecewiseCue[];
  readonly breakpoints: readonly PiecewiseBreakpoint[];
  /** Cues in aligned or corrected regions, as a fraction of all cues. */
  readonly coverage: number;
  readonly counts: Readonly<Record<CueDisposition, number>>;
  /**
   * Inferred cues placed beside an edit, where the regions either side
   * disagree — by elimination, or by the cue's own evidence alone.
   */
  readonly placedAtEdits: number;
  /**
   * Whether this may be written without a person looking at it.
   *
   * Only a correctable result whose every moved region is strongly supported,
   * and which covers most of the subtitle. Anything else is a proposal.
   */
  readonly autoApplicable: boolean;
  readonly reference: ReferenceKind;
  readonly anchorCount: number;
  readonly version: string;
}

export interface PiecewiseOptions {
  /** How far either way an offset is searched. Defaults to five minutes. */
  readonly maxOffsetSeconds?: number;
  /**
   * Rates to search at. Defaults to one, plus whatever rate the global
   * aligner prefers, so a frame-rate transfer is still one region.
   */
  readonly rates?: readonly number[];
  readonly anchors?: readonly CueAnchor[];
  /** Overrides for calibration; production uses the defaults. */
  readonly tuning?: Partial<PiecewiseTuning>;
}

export interface PiecewiseTuning {
  /** What one change of offset costs, in cues' worth of evidence. */
  readonly splitPenalty: number;
  /** The least a cue's score can be, so a few cues the reference misses cannot force a split. */
  readonly scoreFloor: number;
  /** A region needs this many matched cues to stand on its own. */
  readonly minimumMatchedCues: number;
  /** And this much agreement above its decoys. */
  readonly minimumConfidence: number;
  /** Autoapply needs every moved region at least this confident. */
  readonly autoConfidence: number;
  /** Autoapply needs at least this coverage. */
  readonly autoCoverage: number;
  /**
   * A region within this of the identity is aligned, not corrected. Defaults
   * to the reference kind's own floor (see `PROFILES`).
   */
  readonly negligibleShiftSeconds: number;
  /** Longest head or tail run placed from one neighbour alone, in source seconds. */
  readonly maximumInferredEdgeSeconds: number;
}

export const DEFAULT_TUNING: PiecewiseTuning = {
  splitPenalty: 12,
  scoreFloor: 0.3,
  minimumMatchedCues: 8,
  minimumConfidence: 0.45,
  autoConfidence: 0.6,
  autoCoverage: 0.6,
  negligibleShiftSeconds: 0.15,
  maximumInferredEdgeSeconds: 240,
};

/** The evidence grid, and the offset grid as a whole number of its cells. */
const GRID_SECONDS = 0.05;
const OFFSET_STEP_CELLS = 2;
const OFFSET_STEP_SECONDS = GRID_SECONDS * OFFSET_STEP_CELLS;

/** How close an onset must be to count as the same moment. */
const ONSET_KERNEL_SECONDS = 0.5;
/** And an anchor, whose own timing is a transcript segment's. */
const ANCHOR_KERNEL_SECONDS = 1.2;
/** How far past its first and last line a reference still speaks for the media. */
const REFERENCE_MARGIN_SECONDS = 5;

/** Within this a cue's start is a match, for counting and for confidence. */
const MATCH_SECONDS = 0.3;
/** And within this of its own anchor, which is a transcript segment's start. */
const ANCHOR_MATCH_SECONDS = 0.8;

/**
 * How far each kind of reference is trusted, and what it gets wrong.
 *
 * - **Edges.** A subtitle's cue boundaries are placed by a person to the
 *   frame; an energy gate's end is wherever the room tone took over, and is
 *   not evidence of anything; a transcript's segment end is in between.
 * - **Lag.** An energy gate finds speech once it is already loud. Against the
 *   Turkish subtitles packaged with nine episodes of five series, its onsets
 *   trailed the cue starts by a median of 0.02–0.17 s depending on the mix
 *   (0.08 s overall), so its onsets are moved back by that before anything is
 *   compared — otherwise every correction against audio is that much late,
 *   and a correct subtitle looks 0.15 s early.
 * - **Negligible.** The smallest shift worth proposing. Below an energy gate's
 *   own scatter a "correction" is the gate's error, not the subtitle's.
 * - **Zone margin.** How much better one placement of the cues beside an edit
 *   must be before it is believed (see `partitionZone`). An energy gate puts
 *   speech under a boundary cue on either side of an inserted scene, so one
 *   cue's worth of evidence cannot choose; a subtitle's onsets can.
 */
interface ReferenceProfile {
  readonly onset: number;
  readonly end: number;
  readonly overlap: number;
  readonly onsetLagSeconds: number;
  readonly negligibleShiftSeconds: number;
  readonly zoneMargin: number;
}

const PROFILES: Record<ReferenceKind, ReferenceProfile> = {
  subtitle: {
    onset: 1,
    end: 0.5,
    overlap: 0.5,
    onsetLagSeconds: 0,
    negligibleShiftSeconds: 0.15,
    zoneMargin: 0.5,
  },
  speech: {
    onset: 1,
    end: 0,
    overlap: 0.5,
    onsetLagSeconds: 0.08,
    negligibleShiftSeconds: 0.3,
    zoneMargin: 1.5,
  },
  transcript: {
    onset: 1,
    end: 0.3,
    overlap: 0.5,
    onsetLagSeconds: 0,
    negligibleShiftSeconds: 0.2,
    zoneMargin: 1,
  },
};

interface EvidenceGrid {
  readonly origin: number;
  readonly cells: number;
  /** Seconds of speech before each cell. */
  readonly speech: Float64Array;
  readonly onset: Float32Array;
  readonly end: Float32Array;
  readonly density: number;
  readonly onsetMean: number;
  readonly endMean: number;
  readonly onsets: Float64Array;
  /** How often a cue placed at random starts on a reference onset. */
  readonly chanceHitRate: number;
  /** The stretch of media the reference speaks for. */
  readonly coveredFrom: number;
  readonly coveredTo: number;
}

/** A triangle of `width` either side of every point, as a grid. */
function kernelGrid(
  points: readonly number[],
  origin: number,
  cells: number,
  width: number,
): Float32Array {
  const grid = new Float32Array(cells);
  const reach = Math.ceil(width / GRID_SECONDS);
  for (const point of points) {
    const centre = Math.round((point - origin) / GRID_SECONDS);
    for (let delta = -reach; delta <= reach; delta += 1) {
      const cell = centre + delta;
      if (cell < 0 || cell >= cells) continue;
      const value = 1 - Math.abs(delta * GRID_SECONDS) / width;
      if (value > (grid[cell] as number)) grid[cell] = value;
    }
  }
  return grid;
}

function buildGrid(
  reference: readonly SpeechInterval[],
  origin: number,
  span: number,
): EvidenceGrid {
  const cells = Math.ceil(span / GRID_SECONDS) + 2;
  const covered = new Uint8Array(cells);
  for (const interval of reference) {
    const from = Math.max(
      0,
      Math.round((interval.startSeconds - origin) / GRID_SECONDS),
    );
    const to = Math.min(
      cells,
      Math.round((interval.endSeconds - origin) / GRID_SECONDS),
    );
    for (let cell = from; cell < to; cell += 1) covered[cell] = 1;
  }
  const speech = new Float64Array(cells + 1);
  for (let cell = 0; cell < cells; cell += 1)
    speech[cell + 1] =
      (speech[cell] as number) + (covered[cell] as number) * GRID_SECONDS;

  const onsetTimes = reference.map((interval) => interval.startSeconds);
  const endTimes = reference.map((interval) => interval.endSeconds);
  const onset = kernelGrid(onsetTimes, origin, cells, ONSET_KERNEL_SECONDS);
  const end = kernelGrid(endTimes, origin, cells, ONSET_KERNEL_SECONDS);

  /*
   * Chance is measured over the stretch the reference covers, not the whole
   * grid: the grid is padded by the offset search on both sides, and averaging
   * in five minutes of nothing would make every random placement look worse
   * than it is and every real one look better.
   */
  const first = Math.min(...onsetTimes);
  const last = Math.max(...endTimes);
  const from = Math.max(0, Math.floor((first - origin) / GRID_SECONDS));
  const to = Math.min(cells, Math.ceil((last - origin) / GRID_SECONDS));
  let onsetSum = 0;
  let endSum = 0;
  for (let cell = from; cell < to; cell += 1) {
    onsetSum += onset[cell] as number;
    endSum += end[cell] as number;
  }
  const active = Math.max(1, to - from);
  return {
    origin,
    cells,
    speech,
    onset,
    end,
    density:
      ((speech[to] as number) - (speech[from] as number)) /
      (active * GRID_SECONDS),
    onsetMean: onsetSum / active,
    endMean: endSum / active,
    onsets: Float64Array.from(onsetTimes).sort(),
    coveredFrom: first - REFERENCE_MARGIN_SECONDS,
    coveredTo: last + REFERENCE_MARGIN_SECONDS,
    chanceHitRate: Math.min(
      1,
      (onsetTimes.length * 2 * MATCH_SECONDS) / (active * GRID_SECONDS),
    ),
  };
}

interface Scorer {
  /** One cue's evidence at one placement, above chance. */
  at(cue: AlignmentCue, rate: number, offset: number): number;
  /**
   * How far a cue's start lands from what it should meet there — a reference
   * onset, or its own anchor — or null when it meets neither.
   */
  hitError(cue: AlignmentCue, rate: number, offset: number): number | null;
}

function createScorer(
  grid: EvidenceGrid,
  kind: ReferenceKind,
  anchors: ReadonlyMap<number, readonly CueAnchor[]>,
): Scorer {
  const weights = PROFILES[kind];
  const cellOf = (seconds: number) =>
    Math.round((seconds - grid.origin) / GRID_SECONDS);
  const read = (array: Float32Array, cell: number) =>
    cell >= 0 && cell < grid.cells ? (array[cell] as number) : 0;
  const speechAt = (cell: number) =>
    grid.speech[Math.max(0, Math.min(grid.cells, cell))] as number;

  return {
    at(cue, rate, offset) {
      const start = cue.startSeconds * rate + offset;
      const end = cue.endSeconds * rate + offset;
      const startCell = cellOf(start);
      const endCell = cellOf(end);
      let score = 0;
      /*
       * Outside what the reference covers it says nothing, for or against: a
       * reference that stops early is not evidence that the rest of the film
       * is silent. Inside, silence is evidence — a cue that lands where the
       * reference has nobody speaking is somewhere it should not be.
       */
      if (start >= grid.coveredFrom && start <= grid.coveredTo) {
        score += weights.onset * (read(grid.onset, startCell) - grid.onsetMean);
        if (weights.end > 0)
          score += weights.end * (read(grid.end, endCell) - grid.endMean);
        const duration = end - start;
        if (duration > 0.05)
          score +=
            weights.overlap *
            ((speechAt(endCell) - speechAt(startCell)) / duration -
              grid.density);
      }
      const own = anchors.get(cue.index);
      if (own)
        for (const anchor of own) {
          const distance = Math.abs(start - anchor.mediaSeconds);
          if (distance < ANCHOR_KERNEL_SECONDS)
            score += anchor.weight * (1 - distance / ANCHOR_KERNEL_SECONDS);
        }
      return score;
    },
    hitError(cue, rate, offset) {
      const start = cue.startSeconds * rate + offset;
      const near = nearest(grid.onsets, start);
      if (near !== null && Math.abs(near - start) <= MATCH_SECONDS)
        return Math.abs(near - start);
      for (const anchor of anchors.get(cue.index) ?? [])
        if (Math.abs(anchor.mediaSeconds - start) <= ANCHOR_MATCH_SECONDS)
          return Math.abs(anchor.mediaSeconds - start);
      return null;
    },
  };
}

function nearest(sorted: Float64Array, value: number): number | null {
  if (sorted.length === 0) return null;
  let low = 0;
  let high = sorted.length - 1;
  while (low < high) {
    const middle = (low + high) >> 1;
    if ((sorted[middle] as number) < value) low = middle + 1;
    else high = middle;
  }
  const candidate = sorted[low] as number;
  const previous = low > 0 ? (sorted[low - 1] as number) : null;
  return previous !== null &&
    Math.abs(previous - value) < Math.abs(candidate - value)
    ? previous
    : candidate;
}

/**
 * One offset per cue, maximising evidence minus a penalty per change.
 *
 * `V[j]` is the best total for the cues so far ending at offset `j`; each new
 * cue either stays on its predecessor's offset for free or jumps from the best
 * previous offset at the split penalty. The best previous total is one number,
 * so a step costs O(offsets), and a 45-minute episode at ±5 minutes is a few
 * million additions.
 */
function splitPenaltyPath(
  cues: readonly AlignmentCue[],
  scorer: Scorer,
  rate: number,
  maxOffsetSeconds: number,
  tuning: PiecewiseTuning,
): { offsets: Float64Array; total: number } {
  const states = Math.round((2 * maxOffsetSeconds) / OFFSET_STEP_SECONDS) + 1;
  const offsetOf = (state: number) =>
    -maxOffsetSeconds + state * OFFSET_STEP_SECONDS;
  let previous = new Float64Array(states);
  let current = new Float64Array(states);
  const jumped = new Uint8Array(cues.length * states);
  const jumpFrom = new Int32Array(cues.length);

  for (let index = 0; index < cues.length; index += 1) {
    const cue = cues[index] as AlignmentCue;
    let bestPrevious = 0;
    let bestPreviousState = 0;
    if (index > 0) {
      bestPrevious = Number.NEGATIVE_INFINITY;
      for (let state = 0; state < states; state += 1) {
        if ((previous[state] as number) > bestPrevious) {
          bestPrevious = previous[state] as number;
          bestPreviousState = state;
        }
      }
    }
    jumpFrom[index] = bestPreviousState;
    const jumpTotal = bestPrevious - tuning.splitPenalty;
    for (let state = 0; state < states; state += 1) {
      const evidence = Math.max(
        -tuning.scoreFloor,
        scorer.at(cue, rate, offsetOf(state)),
      );
      if (index === 0) {
        current[state] = evidence;
        continue;
      }
      const stay = previous[state] as number;
      if (jumpTotal > stay) {
        current[state] = jumpTotal + evidence;
        jumped[index * states + state] = 1;
      } else current[state] = stay + evidence;
    }
    [previous, current] = [current, previous];
  }

  let state = 0;
  let total = Number.NEGATIVE_INFINITY;
  for (let candidate = 0; candidate < states; candidate += 1) {
    if ((previous[candidate] as number) > total) {
      total = previous[candidate] as number;
      state = candidate;
    }
  }
  const offsets = new Float64Array(cues.length);
  for (let index = cues.length - 1; index >= 0; index -= 1) {
    offsets[index] = offsetOf(state);
    if (jumped[index * states + state]) state = jumpFrom[index] as number;
  }
  return { offsets, total };
}

interface Transform {
  readonly rate: number;
  readonly offsetSeconds: number;
}

interface RegionStats {
  readonly matchedCues: number;
  readonly confidence: number;
  readonly evidence: number;
  readonly medianErrorSeconds: number | null;
}

function measure(
  cues: readonly AlignmentCue[],
  scorer: Scorer,
  transform: Transform,
  maxOffsetSeconds: number,
  floor: number,
): RegionStats {
  let matched = 0;
  let evidence = 0;
  const errors: number[] = [];
  for (const cue of cues) {
    evidence += Math.max(
      -floor,
      scorer.at(cue, transform.rate, transform.offsetSeconds),
    );
    const error = scorer.hitError(cue, transform.rate, transform.offsetSeconds);
    if (error !== null) {
      matched += 1;
      errors.push(error);
    }
  }
  const rival = bestRival(cues, scorer, transform, maxOffsetSeconds, floor);
  errors.sort((left, right) => left - right);
  return {
    matchedCues: matched,
    confidence:
      evidence <= 0 ? 0 : Math.max(0, 1 - Math.max(0, rival) / evidence),
    evidence,
    medianErrorSeconds:
      errors.length === 0 ? null : (errors[errors.length >> 1] as number),
  };
}

/**
 * The most evidence any *other* offset finds for the same cues, anywhere in
 * the search.
 *
 * A region's offset was chosen as the best of thousands, so comparing it with
 * a few fixed decoys measures nothing: some offset out of six thousand lines
 * up any short run of cues by chance, and fixed decoys never look there. The
 * runner-up does — the best total more than a second and a half from the
 * chosen offset is what chance managed on the same cues with the same
 * freedom, measured in the same units the program chose by, anchors and all.
 */
function bestRival(
  cues: readonly AlignmentCue[],
  scorer: Scorer,
  transform: Transform,
  maxOffsetSeconds: number,
  floor: number,
): number {
  const states = Math.round((2 * maxOffsetSeconds) / OFFSET_STEP_SECONDS) + 1;
  const totals = new Float64Array(states);
  for (const cue of cues)
    for (let state = 0; state < states; state += 1)
      totals[state] =
        (totals[state] as number) +
        Math.max(
          -floor,
          scorer.at(
            cue,
            transform.rate,
            -maxOffsetSeconds + state * OFFSET_STEP_SECONDS,
          ),
        );
  const chosen = Math.round(
    (transform.offsetSeconds + maxOffsetSeconds) / OFFSET_STEP_SECONDS,
  );
  const exclusion = Math.round(1.5 / OFFSET_STEP_SECONDS);
  let rival = Number.NEGATIVE_INFINITY;
  for (let state = 0; state < states; state += 1) {
    if (Math.abs(state - chosen) <= exclusion) continue;
    if ((totals[state] as number) > rival) rival = totals[state] as number;
  }
  return rival;
}

/**
 * The region's transform to the millisecond.
 *
 * The program places offsets on a tenth-of-a-second grid. Each matched cue is
 * paired with its nearest reference onset under that placement, and the pairs
 * decide: the median shift for a short region, whose span cannot tell a rate
 * from noise, and a least-squares line for a long one, held near the searched
 * rate so a region cannot invent its own frame-rate transfer.
 */
function refineRegion(
  cues: readonly AlignmentCue[],
  grid: EvidenceGrid,
  seed: Transform,
): Transform {
  let current = seed;
  for (const tolerance of [0.6, 0.35, 0.25]) {
    const xs: number[] = [];
    const ys: number[] = [];
    for (const cue of cues) {
      const mapped = cue.startSeconds * current.rate + current.offsetSeconds;
      const near = nearest(grid.onsets, mapped);
      if (near === null || Math.abs(near - mapped) > tolerance) continue;
      xs.push(cue.startSeconds);
      ys.push(near);
    }
    if (xs.length < 4) break;
    const span = (xs[xs.length - 1] as number) - (xs[0] as number);
    if (span >= 600 && xs.length >= 30) {
      const fitted = leastSquares(xs, ys);
      if (fitted && Math.abs(fitted.rate / seed.rate - 1) < 0.002) {
        current = fitted;
        continue;
      }
    }
    const shifts = xs
      .map((x, index) => (ys[index] as number) - x * seed.rate)
      .sort((left, right) => left - right);
    current = {
      rate: seed.rate,
      offsetSeconds: shifts[shifts.length >> 1] as number,
    };
  }
  return current;
}

interface Region {
  first: number;
  last: number;
  transform: Transform;
  stats: RegionStats;
  strong: boolean;
}

function mapped(cue: AlignmentCue, transform: Transform) {
  return {
    start: cue.startSeconds * transform.rate + transform.offsetSeconds,
    end: cue.endSeconds * transform.rate + transform.offsetSeconds,
  };
}

/** Where two transforms put one moment, apart. */
function disagreement(left: Transform, right: Transform, atSeconds: number) {
  return Math.abs(
    atSeconds * left.rate +
      left.offsetSeconds -
      (atSeconds * right.rate + right.offsetSeconds),
  );
}

const IDENTITY: Transform = { rate: 1, offsetSeconds: 0 };

/**
 * Where each part of `subtitle` belongs on the media's timeline.
 *
 * `subtitle` is the document's cues in document order; `index` is how the
 * result refers back to them. Never throws on thin evidence — an answer of
 * "insufficient evidence" is an answer.
 */
export function alignPiecewise(
  subtitle: readonly AlignmentCue[],
  reference: AlignmentReference,
  options: PiecewiseOptions = {},
): PiecewiseAlignment {
  const tuning = {
    ...DEFAULT_TUNING,
    negligibleShiftSeconds: PROFILES[reference.kind].negligibleShiftSeconds,
    ...options.tuning,
  };
  const anchorList = options.anchors ?? [];
  const cues = [...subtitle].sort(
    (left, right) => left.startSeconds - right.startSeconds,
  );
  const profile = PROFILES[reference.kind];
  const intervals = reference.intervals
    .filter((interval) => interval.endSeconds > interval.startSeconds)
    .map((interval) =>
      profile.onsetLagSeconds === 0
        ? interval
        : {
            startSeconds: interval.startSeconds - profile.onsetLagSeconds,
            endSeconds: interval.endSeconds,
          },
    );
  if (cues.length === 0 || intervals.length === 0)
    return emptyResult(subtitle, reference.kind, anchorList.length);

  const maxOffset = options.maxOffsetSeconds ?? 300;
  const rates = options.rates ?? candidateRates(cues, intervals);
  const lastSource = Math.max(...cues.map((cue) => cue.endSeconds));
  const lastReference = Math.max(
    ...intervals.map((interval) => interval.endSeconds),
  );
  const origin = -maxOffset - 10;
  const span =
    Math.max(lastSource * Math.max(...rates), lastReference) +
    2 * maxOffset +
    20;
  const grid = buildGrid(intervals, origin, span);
  const anchors = new Map<number, CueAnchor[]>();
  for (const anchor of anchorList) {
    const list = anchors.get(anchor.cueIndex) ?? [];
    list.push(anchor);
    anchors.set(anchor.cueIndex, list);
  }
  const scorer = createScorer(grid, reference.kind, anchors);

  /*
   * One program per rate, and the better total wins. A wrong rate cannot be
   * one region — it drifts, and the program follows it with a staircase of
   * splits, each of which costs a penalty the right rate never pays.
   */
  let best: { rate: number; offsets: Float64Array; total: number } | null =
    null;
  for (const rate of rates) {
    const path = splitPenaltyPath(cues, scorer, rate, maxOffset, tuning);
    if (best === null || path.total > best.total) best = { rate, ...path };
  }
  const { rate, offsets } = best as NonNullable<typeof best>;

  let regions = runsOf(offsets).map(({ first, last }) => {
    const members = cues.slice(first, last + 1);
    const transform = refineRegion(members, grid, {
      rate,
      offsetSeconds: offsets[first] as number,
    });
    return evaluate(first, last, transform);
  });
  regions = mergeAgreeing(regions).flatMap(trimEdges);

  /**
   * A strong region without the cues at its edges that do not support it.
   *
   * The program keeps a cue with no evidence on its neighbour's offset, since
   * the floor makes that cheaper than a split — which is right in the middle
   * of a region and wrong at its edge, where those cues are exactly the ones a
   * cut removed or a jump has already moved. So each edge loses its longest
   * run that matches no better than chance would.
   *
   * Matches, not the evidence score, decide this: a cue that lands on *some*
   * dialogue scores well on overlap wherever the dialogue is dense, and the
   * cues of a removed scene land on the scene that replaced it. Each cue is
   * worth its match less a bar halfway between the region's own match rate
   * and chance's, so a run at the region's rate pays for itself, a run at
   * chance's sinks, and one coincidental match inside a sinking run does not
   * keep it.
   */
  function trimEdges(region: Region): Region[] {
    if (!region.strong) return [region];
    const members = cues.slice(region.first, region.last + 1);
    const own = region.stats.matchedCues / members.length;
    const bar = (own + grid.chanceHitRate) / 2;
    const scores = members.map(
      (cue) =>
        (scorer.hitError(
          cue,
          region.transform.rate,
          region.transform.offsetSeconds,
        ) === null
          ? 0
          : 1) - bar,
    );
    let from = 0;
    let lowest = 0;
    let running = 0;
    for (let at = 0; at < scores.length; at += 1) {
      running += scores[at] as number;
      if (running < lowest) {
        lowest = running;
        from = at + 1;
      }
    }
    let to = scores.length - 1;
    lowest = 0;
    running = 0;
    for (let at = scores.length - 1; at >= from; at -= 1) {
      running += scores[at] as number;
      if (running < lowest) {
        lowest = running;
        to = at - 1;
      }
    }
    if (from === 0 && to === scores.length - 1) return [region];
    const first = region.first + from;
    const last = region.first + to;
    if (last < first) return [{ ...region, strong: false }];
    const core = evaluate(
      first,
      last,
      refineRegion(cues.slice(first, last + 1), grid, region.transform),
    );
    const weak = (a: number, b: number): Region => ({
      ...region,
      first: a,
      last: b,
      strong: false,
    });
    return [
      ...(first > region.first ? [weak(region.first, first - 1)] : []),
      core,
      ...(last < region.last ? [weak(last + 1, region.last)] : []),
    ];
  }

  function evaluate(first: number, last: number, transform: Transform): Region {
    const members = cues.slice(first, last + 1);
    const stats = measure(
      members,
      scorer,
      transform,
      maxOffset,
      tuning.scoreFloor,
    );
    return {
      first,
      last,
      transform,
      stats,
      strong:
        stats.matchedCues >= tuning.minimumMatchedCues &&
        stats.confidence >= tuning.minimumConfidence &&
        stats.evidence >= tuning.splitPenalty,
    };
  }

  /** Neighbouring strong regions that land within a frame or two are one region. */
  function mergeAgreeing(list: Region[]): Region[] {
    const merged: Region[] = [];
    for (const region of list) {
      const previous = merged[merged.length - 1];
      if (
        previous &&
        previous.strong &&
        region.strong &&
        disagreement(
          previous.transform,
          region.transform,
          (cues[region.first] as AlignmentCue).startSeconds,
        ) < 0.25
      ) {
        const members = cues.slice(previous.first, region.last + 1);
        merged[merged.length - 1] = evaluate(
          previous.first,
          region.last,
          refineRegion(members, grid, previous.transform),
        );
        continue;
      }
      merged.push(region);
    }
    return merged;
  }

  /*
   * A strong region is moved only if moving it is clearly better than leaving
   * it. "Clearly" is a split's worth of evidence: the same bar a breakpoint
   * has to clear, so the program cannot propose a correction that the region's
   * own cues would not pay for against the identity.
   */
  const resolved = regions.map((region) => {
    if (!region.strong) return { region, status: "weak" as const };
    const at = (cues[region.first] as AlignmentCue).startSeconds;
    const through = (cues[region.last] as AlignmentCue).startSeconds;
    const negligible =
      disagreement(region.transform, IDENTITY, at) <
        tuning.negligibleShiftSeconds &&
      disagreement(region.transform, IDENTITY, through) <
        tuning.negligibleShiftSeconds;
    if (negligible)
      return {
        region: {
          ...region,
          transform: IDENTITY,
          stats: measure(
            cues.slice(region.first, region.last + 1),
            scorer,
            IDENTITY,
            maxOffset,
            tuning.scoreFloor,
          ),
        },
        status: "aligned" as const,
      };
    const members = cues.slice(region.first, region.last + 1);
    const unmoved = measure(
      members,
      scorer,
      IDENTITY,
      maxOffset,
      tuning.scoreFloor,
    );
    if (unmoved.evidence >= region.stats.evidence - tuning.splitPenalty)
      return {
        region: { ...region, transform: IDENTITY, stats: unmoved },
        status: "aligned" as const,
      };
    return { region, status: "corrected" as const };
  });

  // Per-cue placement, starting from the strong regions.
  const disposition: CueDisposition[] = new Array(cues.length);
  const transformOf: (Transform | null)[] = new Array(cues.length).fill(null);
  /** The strong region that vouches for each cue, for its segment's figures. */
  const vouchedBy: (Region | null)[] = new Array(cues.length).fill(null);
  const strong = resolved.flatMap((entry) =>
    entry.status === "weak"
      ? []
      : [{ region: entry.region, status: entry.status }],
  );
  for (const { region, status } of strong)
    for (let index = region.first; index <= region.last; index += 1) {
      disposition[index] = status;
      transformOf[index] = region.transform;
      vouchedBy[index] = region;
    }

  let placedAtEdit = 0;
  const leaveUnresolved = (from: number, to: number) => {
    for (let index = from; index <= to; index += 1) {
      disposition[index] = "unresolved";
      transformOf[index] = IDENTITY;
      vouchedBy[index] = null;
    }
  };
  const inferFrom = (from: number, to: number, transform: Transform) => {
    for (let index = from; index <= to; index += 1) {
      disposition[index] = "inferred";
      transformOf[index] = transform;
      vouchedBy[index] = null;
    }
  };

  if (strong.length === 0) leaveUnresolved(0, cues.length - 1);
  else {
    /*
     * One neighbour is enough only at the document's own edges — an opening
     * song or a closing credit with nothing to match, moved with the dialogue
     * next to it — and only for a few minutes of it. A run that merely has no
     * strong region on one side is not an edge.
     */
    const head = (strong[0] as (typeof strong)[number]).region;
    const tail = (strong[strong.length - 1] as (typeof strong)[number]).region;
    const edge = (first: number, last: number, only: Region) => {
      if (first > last) return;
      const span =
        (cues[last] as AlignmentCue).endSeconds -
        (cues[first] as AlignmentCue).startSeconds;
      if (span <= tuning.maximumInferredEdgeSeconds)
        inferFrom(first, last, only.transform);
      else leaveUnresolved(first, last);
    };
    edge(0, head.first - 1, head);
    edge(tail.last + 1, cues.length - 1, tail);
    for (let at = 1; at < strong.length; at += 1)
      between(
        strong[at - 1] as (typeof strong)[number],
        strong[at] as (typeof strong)[number],
      );
  }

  /**
   * Everything between two strong regions, and the edges of both.
   *
   * Where the two agree, the cues between them move with them: a stretch of
   * music between two scenes on the same timeline is on that timeline too.
   *
   * Where they disagree, an edit lies somewhere near here, and the program's
   * own boundary is only as sharp as the evidence beside it — against an
   * audio track's speech, a few cues either way. So the boundary is reopened:
   * the cues between the regions and up to ten or thirty seconds of each
   * region's edge are decided again, together.
   *
   * Each cue may go only where it fits between the dialogue the two regions
   * own outside that zone, and a cue that fits under neither timeline was in
   * footage this edition does not have. The rest change sides once —
   * everything before the edit on the left's timeline, everything after on
   * the right's — so the choice is one switch point, not one coin per cue,
   * which would alternate between two speakers' overlapping lines and put
   * dialogue out of order. The switch point goes wherever the cues' own
   * evidence is best, and cues on which near-best switch points disagree are
   * left unresolved rather than given a side the evidence did not choose.
   */
  function between(
    left: { region: Region; status: "aligned" | "corrected" },
    right: { region: Region; status: "aligned" | "corrected" },
  ) {
    const L = left.region;
    const R = right.region;
    const at = (cues[R.first] as AlignmentCue).startSeconds;
    if (disagreement(L.transform, R.transform, at) < 0.25) {
      if (L.last + 1 <= R.first - 1)
        inferFrom(L.last + 1, R.first - 1, L.transform);
      return;
    }
    const zone = 10;
    const reach = 30;
    let first = L.last + 1;
    const leftEdge = (cues[L.last] as AlignmentCue).startSeconds;
    while (
      first - 1 > L.first &&
      L.last + 1 - (first - 1) <= zone &&
      leftEdge - (cues[first - 1] as AlignmentCue).startSeconds <= reach
    )
      first -= 1;
    let last = R.first - 1;
    const rightEdge = (cues[R.first] as AlignmentCue).startSeconds;
    while (
      last + 1 < R.last &&
      last + 1 - (R.first - 1) <= zone &&
      (cues[last + 1] as AlignmentCue).startSeconds - rightEdge <= reach
    )
      last += 1;

    const decided = partitionZone(first, last, L, R);
    for (let offset = 0; offset < decided.length; offset += 1) {
      const index = first + offset;
      const choice = decided[offset];
      if (choice === "nowhere") {
        disposition[index] = "unmatched";
        transformOf[index] = null;
        vouchedBy[index] = null;
      } else if (choice === "undecided") leaveUnresolved(index, index);
      else {
        const owner = choice === "left" ? left : right;
        // A cue its own region already held stays as it was; any other is inferred.
        if (vouchedBy[index] === owner.region) continue;
        inferFrom(index, index, owner.region.transform);
        placedAtEdit += 1;
      }
    }
  }

  /**
   * The cues of one boundary zone, split as left, then absent, then right.
   *
   * Every split is scored by the evidence of its cues where it puts them; a
   * cue counted as absent scores nothing, and may be absent only if it fits
   * under neither timeline — under the left's it would run into the dialogue
   * the split put on the right, and under the right's it would land before
   * the dialogue it put on the left. That is what a removed scene looks like
   * and nothing else does. Splits within the reference kind's zone margin of the best are
   * all plausible; a cue they place differently is undecided.
   */
  function partitionZone(
    first: number,
    last: number,
    L: Region,
    R: Region,
  ): ("left" | "right" | "nowhere" | "undecided")[] {
    const zone = cues.slice(first, last + 1);
    const count = zone.length;
    const slack = 0.5;
    const outsideLeftEnd = mapped(
      cues[first - 1] as AlignmentCue,
      L.transform,
    ).end;
    const outsideRightStart = mapped(
      cues[last + 1] as AlignmentCue,
      R.transform,
    ).start;
    const underL = zone.map((cue) => mapped(cue, L.transform));
    const underR = zone.map((cue) => mapped(cue, R.transform));
    const score = (cue: AlignmentCue, transform: Transform) =>
      Math.max(
        -tuning.scoreFloor,
        scorer.at(cue, transform.rate, transform.offsetSeconds),
      );
    // Lines that already overlapped in the subtitle may go on overlapping.
    const overlap = zone.map((cue, offset) => {
      const next = cues[first + offset + 1];
      return next ? Math.max(0, cue.endSeconds - next.startSeconds) : 0;
    });
    const leftSum = [0];
    const leftEnd = [outsideLeftEnd];
    for (let offset = 0; offset < count; offset += 1) {
      leftSum.push(
        (leftSum[offset] as number) +
          score(zone[offset] as AlignmentCue, L.transform),
      );
      leftEnd.push(
        Math.max(
          leftEnd[offset] as number,
          (underL[offset] as { end: number }).end - (overlap[offset] as number),
        ),
      );
    }
    const rightSum = new Array<number>(count + 1).fill(0);
    const rightStart = new Array<number>(count + 1).fill(outsideRightStart);
    for (let offset = count - 1; offset >= 0; offset -= 1) {
      rightSum[offset] =
        (rightSum[offset + 1] as number) +
        score(zone[offset] as AlignmentCue, R.transform);
      rightStart[offset] = Math.min(
        rightStart[offset + 1] as number,
        (underR[offset] as { start: number }).start,
      );
    }

    const splits: { a: number; c: number; total: number }[] = [];
    for (let a = 0; a <= count; a += 1) {
      for (let c = a; c <= count; c += 1) {
        const lEnd = leftEnd[a] as number;
        const rStart = rightStart[c] as number;
        if (lEnd > rStart + slack) continue;
        let absentOk = true;
        for (let offset = a; offset < c && absentOk; offset += 1) {
          const asLeft =
            (underL[offset] as { end: number }).end -
            (overlap[offset] as number);
          const asRight = (underR[offset] as { start: number }).start;
          absentOk = asLeft > rStart + slack && asRight < lEnd - slack;
        }
        if (!absentOk) continue;
        splits.push({
          a,
          c,
          total: (leftSum[a] as number) + (rightSum[c] as number),
        });
      }
    }
    if (splits.length === 0) return new Array(count).fill("undecided");
    const best = Math.max(...splits.map((split) => split.total));
    const plausible = splits.filter(
      (split) => split.total >= best - profile.zoneMargin,
    );
    return zone.map((_, offset) => {
      const choices = new Set(
        plausible.map((split) =>
          offset < split.a ? "left" : offset < split.c ? "nowhere" : "right",
        ),
      );
      return choices.size === 1
        ? ([...choices][0] as "left" | "right" | "nowhere")
        : "undecided";
    });
  }

  // The answer, in document order.
  const placed: PiecewiseCue[] = cues.map((cue, position) => {
    const transform = transformOf[position];
    const where = transform
      ? mapped(cue, transform)
      : { start: cue.startSeconds, end: cue.endSeconds };
    return {
      index: cue.index,
      disposition: disposition[position] as CueDisposition,
      sourceStartSeconds: cue.startSeconds,
      sourceEndSeconds: cue.endSeconds,
      startSeconds: where.start,
      endSeconds: where.end,
    };
  });

  const segments = segmentsOf(placed, transformOf, vouchedBy, cues);
  const counts = countDispositions(placed);
  const supported = counts.aligned + counts.corrected;
  const coverage = supported / cues.length;

  const breakpoints = breakpointsOf(segments);
  const reordered = isReordered(placed);
  const verdict: PiecewiseVerdict =
    coverage < 0.3 || supported < tuning.minimumMatchedCues
      ? "insufficient-evidence"
      : reordered
        ? "reordered"
        : counts.unresolved > 0 || counts.unmatched > 0
          ? "partial"
          : counts.corrected === 0 &&
              placed.every(
                (cue) =>
                  Math.abs(cue.startSeconds - cue.sourceStartSeconds) <
                  tuning.negligibleShiftSeconds,
              )
            ? "in-sync"
            : "correctable";
  /*
   * A cue placed next to an edit was placed by elimination or by a single
   * cue's evidence, and is wrong by the whole jump if that was wrong. Worth
   * proposing; not worth writing unseen.
   */
  const autoApplicable =
    verdict === "correctable" &&
    placedAtEdit === 0 &&
    coverage >= tuning.autoCoverage &&
    segments.every(
      (segment) =>
        segment.status !== "corrected" ||
        segment.confidence >= tuning.autoConfidence,
    );

  return {
    verdict,
    rate,
    segments,
    cues: placed.sort((left, right) => left.index - right.index),
    breakpoints,
    coverage,
    counts,
    placedAtEdits: placedAtEdit,
    autoApplicable,
    reference: reference.kind,
    anchorCount: anchorList.length,
    version: PIECEWISE_ALIGNER_VERSION,
  };
}

/**
 * One, and the global aligner's rate when it differs.
 *
 * The global aligner is wrong about *offsets* whenever a subtitle has more
 * than one, but a frame-rate transfer is the same rate everywhere, and its
 * search for one is good.
 */
function candidateRates(
  cues: readonly AlignmentCue[],
  intervals: readonly SpeechInterval[],
): number[] {
  const global = alignSpeech(cues, intervals, { rates: CANDIDATE_RATES });
  // At any confidence: a wrong rate only costs one more program, and loses it.
  return Math.abs(global.rate - 1) > 0.00002 ? [1, global.rate] : [1];
}

function runsOf(offsets: Float64Array): { first: number; last: number }[] {
  const runs: { first: number; last: number }[] = [];
  for (let index = 0; index < offsets.length; index += 1) {
    const run = runs[runs.length - 1];
    if (run && offsets[index] === offsets[run.last]) run.last = index;
    else runs.push({ first: index, last: index });
  }
  return runs;
}

function segmentsOf(
  placed: readonly PiecewiseCue[],
  transforms: readonly (Transform | null)[],
  vouchedBy: readonly (Region | null)[],
  cues: readonly AlignmentCue[],
): PiecewiseSegment[] {
  const segments: PiecewiseSegment[] = [];
  let open: {
    first: number;
    last: number;
    status: SegmentStatus;
    transform: Transform;
    region: Region | null;
  } | null = null;
  const close = () => {
    if (!open) return;
    const stats = open.region?.stats;
    segments.push({
      status: open.status,
      firstCue: (cues[open.first] as AlignmentCue).index,
      lastCue: (cues[open.last] as AlignmentCue).index,
      sourceStartSeconds: (cues[open.first] as AlignmentCue).startSeconds,
      sourceEndSeconds: (cues[open.last] as AlignmentCue).endSeconds,
      rate: open.transform.rate,
      offsetSeconds: open.transform.offsetSeconds,
      cueCount: open.last - open.first + 1,
      matchedCues: stats?.matchedCues ?? 0,
      confidence: stats?.confidence ?? 0,
      medianErrorSeconds: stats?.medianErrorSeconds ?? null,
    });
    open = null;
  };
  for (let position = 0; position < placed.length; position += 1) {
    const cue = placed[position] as PiecewiseCue;
    if (cue.disposition === "unmatched") {
      close();
      continue;
    }
    const status = cue.disposition as SegmentStatus;
    const transform = transforms[position] ?? IDENTITY;
    const region = vouchedBy[position] ?? null;
    if (
      open &&
      open.status === status &&
      open.region === region &&
      open.transform.rate === transform.rate &&
      open.transform.offsetSeconds === transform.offsetSeconds
    ) {
      open.last = position;
      continue;
    }
    close();
    open = { first: position, last: position, status, transform, region };
  }
  close();
  return segments;
}

function breakpointsOf(
  segments: readonly PiecewiseSegment[],
): PiecewiseBreakpoint[] {
  const supported = segments.filter(
    (segment) => segment.status === "aligned" || segment.status === "corrected",
  );
  const breakpoints: PiecewiseBreakpoint[] = [];
  for (let at = 1; at < supported.length; at += 1) {
    const left = supported[at - 1] as PiecewiseSegment;
    const right = supported[at] as PiecewiseSegment;
    const moment = right.sourceStartSeconds;
    const jump =
      moment * right.rate +
      right.offsetSeconds -
      (moment * left.rate + left.offsetSeconds);
    if (Math.abs(jump) < 0.25) continue;
    breakpoints.push({
      afterSourceSeconds: left.sourceEndSeconds,
      beforeSourceSeconds: right.sourceStartSeconds,
      kind: jump < 0 ? "removed" : "inserted",
      seconds: Math.abs(jump),
    });
  }
  return breakpoints;
}

/**
 * Whether any cue this answer places would start more than half a second
 * before one placed ahead of it.
 */
function isReordered(placed: readonly PiecewiseCue[]): boolean {
  let previous = Number.NEGATIVE_INFINITY;
  for (const cue of placed) {
    // Neither is placed by this answer: one is left for review, one is not here.
    if (cue.disposition === "unmatched" || cue.disposition === "unresolved")
      continue;
    if (cue.startSeconds < previous - 0.5) return true;
    previous = Math.max(previous, cue.startSeconds);
  }
  return false;
}

function countDispositions(
  placed: readonly PiecewiseCue[],
): Record<CueDisposition, number> {
  const counts: Record<CueDisposition, number> = {
    aligned: 0,
    corrected: 0,
    inferred: 0,
    unresolved: 0,
    unmatched: 0,
  };
  for (const cue of placed) counts[cue.disposition] += 1;
  return counts;
}

function emptyResult(
  subtitle: readonly AlignmentCue[],
  reference: ReferenceKind,
  anchorCount: number,
): PiecewiseAlignment {
  const cues = subtitle.map((cue) => ({
    index: cue.index,
    disposition: "unresolved" as const,
    sourceStartSeconds: cue.startSeconds,
    sourceEndSeconds: cue.endSeconds,
    startSeconds: cue.startSeconds,
    endSeconds: cue.endSeconds,
  }));
  return {
    verdict: "insufficient-evidence",
    rate: 1,
    segments: [],
    cues,
    breakpoints: [],
    coverage: 0,
    counts: countDispositions(cues),
    placedAtEdits: 0,
    autoApplicable: false,
    reference,
    anchorCount,
    version: PIECEWISE_ALIGNER_VERSION,
  };
}

/**
 * Which of several readings of one reference to believe.
 *
 * An audio track is read at several speech thresholds, because the right one
 * is a property of the mix; each gives its own alignment. The one that places
 * the most of the subtitle on strong evidence wins — coverage, plus each
 * supported region's confidence weighted by its size — never the one that
 * moves the most.
 */
export function alignmentStrength(result: PiecewiseAlignment): number {
  const supported = result.segments.filter(
    (segment) => segment.status === "aligned" || segment.status === "corrected",
  );
  const confidence =
    supported.reduce(
      (sum, segment) => sum + segment.confidence * segment.cueCount,
      0,
    ) / Math.max(1, result.cues.length);
  return result.coverage + confidence;
}
