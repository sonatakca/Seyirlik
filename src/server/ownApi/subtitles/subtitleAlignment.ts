/**
 * Finding where a subtitle belongs on a film's timeline.
 *
 * The problem this solves is not translation and has nothing to do with text.
 * A subtitle and the thing it is timed against — another subtitle, or the
 * speech in the audio — describe the *same* pattern of silence and talking, and
 * that pattern is a fingerprint. A Turkish translation and an English one share
 * no words at all, but they start and stop within a few hundred milliseconds of
 * each other more than a thousand times, and no wrong alignment reproduces that.
 *
 * So both sides are reduced to the same thing: a run of intervals during which
 * somebody is speaking. Everything below works on those and never looks at a
 * character of dialogue, which is what lets one implementation serve a
 * reference subtitle in any language and a raw audio track equally.
 *
 * Two stages, for two different reasons.
 *
 *  - **A coarse cross-correlation** over a half-second grid, which is a global
 *    search: it will find a fourteen-second shift, or a PAL transfer's four
 *    percent, from no starting guess at all. It is deliberately blurred, so the
 *    peak is broad enough to survive a rate it has not exactly guessed, and
 *    therefore deliberately imprecise.
 *  - **An iterative fit** over cue onsets, which is a local search: given a
 *    starting point already within a second or so, it pairs each cue with the
 *    reference cue it must be, fits a line through the pairs, and repeats with
 *    a tighter tolerance. That is where the millisecond accuracy comes from,
 *    and it recovers a small rate error the coarse stage cannot resolve.
 *
 * The confidence that comes back is not a probability. It is the fraction of
 * the subtitle's own cues that land within a quarter of a second of a reference
 * cue under the proposed mapping, which is the thing an operator would check by
 * hand, and it is what decides whether the correction is offered at all.
 */

import type { CueTransform } from "./subtitleCues";

export interface SpeechInterval {
  readonly startSeconds: number;
  readonly endSeconds: number;
}

/**
 * The rates worth trying before the fit takes over.
 *
 * Every entry is a real transfer between two frame rates, not a guess: a print
 * conformed from 23.976 to 25 runs 4.27% fast, from 24 to 25 exactly 4.17%, and
 * the 1001 pull-down that separates 24 from 23.976 and 30 from 29.97 is a tenth
 * of a percent. A subtitle mis-timed at all is overwhelmingly mis-timed by one
 * of these or by nothing at all, and anything between them the iterative fit
 * finds on its own.
 */
export const CANDIDATE_RATES: readonly number[] = [
  1,
  1001 / 1000,
  1000 / 1001,
  25 / 24,
  24 / 25,
  25 / 23.976,
  23.976 / 25,
];

/** Half a second, which is finer than any drift anybody notices. */
const COARSE_BIN_SECONDS = 0.5;

/**
 * How far the coarse search looks, in seconds either way.
 *
 * Three minutes is far past any plausible mistake — a missing distributor logo,
 * a subtitle timed to a different cut's opening — and every second of it costs
 * two more correlation positions, so it is a ceiling rather than a guess.
 */
export const DEFAULT_MAX_OFFSET_SECONDS = 180;

/** What counts as a cue landing where it should, for the confidence figure. */
const MATCH_TOLERANCE_SECONDS = 0.25;

/** Tightening windows for the fit. Wide enough to start, tight enough to finish. */
const FIT_TOLERANCES_SECONDS = [2.5, 1.2, 0.6, 0.35, 0.25];

/** Below this the pairs are as likely to be coincidence as correspondence. */
const MINIMUM_FIT_PAIRS = 12;

/** Beyond this a "rate" is no longer a frame-rate transfer but a mistake. */
const RATE_BOUND = 0.12;

export interface AlignmentProposal extends CueTransform {
  /**
   * Cues that land within a quarter-second of a reference onset, as a fraction
   * of those that could. The number an operator would arrive at by checking.
   */
  readonly matchedFraction: number;
  readonly matchedCues: number;
  readonly consideredCues: number;
  /** Typical distance from a cue to the reference onset it was paired with. */
  readonly medianErrorSeconds: number;
  /** The coarse stage's own similarity score, before any fitting. 0 to 1. */
  readonly coarseScore: number;
  /**
   * How much better this alignment is than being wrong. Zero to one.
   *
   * The one figure that may be compared across reference kinds, and therefore
   * the only one anything decides on. `matchedFraction` cannot be: a reference
   * subtitle offers one onset per line and matches two thirds of the target's
   * cues when it is right, while an audio track offers one per *stretch* of
   * speech and can never match more than a fraction of them however perfect the
   * alignment is. A single threshold over those two would either refuse every
   * audio alignment or accept every wrong one.
   *
   * So the proposal is measured against itself instead. The same count is taken
   * at a handful of deliberately wrong offsets, which is how often cues land
   * near a reference onset by chance alone given these two documents; this is
   * how far above that the real answer stands. Measured on the pair in hand, it
   * needs no calibration and does not care where the reference came from.
   */
  readonly confidence: number;
}

/**
 * A blurred, half-second picture of when somebody is speaking.
 *
 * Blurred on purpose. The coarse search compares two of these at a rate it has
 * only guessed, so by the end of a two-hour film the guess can be a second or
 * more out even when it is the right guess; a sharp signal would score that as
 * no match at all and the correct rate would lose to a wrong one. Widening each
 * interval by one bin on each side makes the correlation peak broad enough for
 * the right answer to win, and the fit afterwards is what makes it precise.
 */
export function activityBins(
  intervals: readonly SpeechInterval[],
  binCount: number,
  binSeconds = COARSE_BIN_SECONDS,
): Uint8Array {
  const bins = new Uint8Array(binCount);
  for (const interval of intervals) {
    const from = Math.max(
      0,
      Math.floor(interval.startSeconds / binSeconds) - 1,
    );
    const to = Math.min(
      binCount - 1,
      Math.ceil(interval.endSeconds / binSeconds) + 1,
    );
    for (let index = from; index <= to; index += 1) bins[index] = 1;
  }
  return bins;
}

/**
 * The best whole-bin shift of `target` onto `reference`, and how good it is.
 *
 * Scored as a cosine similarity between the two binary vectors rather than as a
 * raw overlap count, because a raw count rewards a shift that simply piles the
 * busiest part of one signal onto the busiest part of the other. Normalising by
 * the overlapping region's own mass asks the better question: of the talking
 * that could have lined up here, how much did.
 */
function bestShift(
  target: Uint8Array,
  reference: Uint8Array,
  maxShiftBins: number,
): { shiftBins: number; score: number } {
  let bestScore = -1;
  let bestShiftBins = 0;
  for (let shift = -maxShiftBins; shift <= maxShiftBins; shift += 1) {
    const from = Math.max(0, -shift);
    const to = Math.min(target.length, reference.length - shift);
    if (to - from < 4) continue;
    let both = 0;
    let targetMass = 0;
    let referenceMass = 0;
    for (let index = from; index < to; index += 1) {
      const t = target[index] as number;
      const r = reference[index + shift] as number;
      both += t & r;
      targetMass += t;
      referenceMass += r;
    }
    if (targetMass === 0 || referenceMass === 0) continue;
    const score = both / Math.sqrt(targetMass * referenceMass);
    if (score > bestScore) {
      bestScore = score;
      bestShiftBins = shift;
    }
  }
  return { shiftBins: bestShiftBins, score: Math.max(0, bestScore) };
}

function scaleIntervals(
  intervals: readonly SpeechInterval[],
  rate: number,
): SpeechInterval[] {
  return intervals.map((interval) => ({
    startSeconds: interval.startSeconds * rate,
    endSeconds: interval.endSeconds * rate,
  }));
}

/**
 * The coarse stage: which rate, and roughly which offset.
 *
 * Every candidate rate is tried in full rather than pruned, because the scores
 * are not comparable until they are all computed — a wrong rate can beat the
 * right one over the first twenty minutes and lose badly over two hours, and
 * only the whole-film score says which is which.
 */
function coarseAlignment(
  target: readonly SpeechInterval[],
  reference: readonly SpeechInterval[],
  maxOffsetSeconds: number,
  rates: readonly number[],
): { rate: number; offsetSeconds: number; score: number } {
  const span =
    Math.max(
      lastEnd(target) * Math.max(...rates.map(Math.abs), 1),
      lastEnd(reference),
    ) + maxOffsetSeconds;
  const binCount = Math.max(8, Math.ceil(span / COARSE_BIN_SECONDS) + 2);
  const maxShiftBins = Math.ceil(maxOffsetSeconds / COARSE_BIN_SECONDS);
  const referenceBins = activityBins(reference, binCount);

  let best = { rate: 1, offsetSeconds: 0, score: -1 };
  for (const rate of rates) {
    const targetBins = activityBins(scaleIntervals(target, rate), binCount);
    const { shiftBins, score } = bestShift(
      targetBins,
      referenceBins,
      maxShiftBins,
    );
    if (score > best.score) {
      best = { rate, offsetSeconds: shiftBins * COARSE_BIN_SECONDS, score };
    }
  }
  return best;
}

function lastEnd(intervals: readonly SpeechInterval[]): number {
  let end = 0;
  for (const interval of intervals) {
    if (interval.endSeconds > end) end = interval.endSeconds;
  }
  return end;
}

/** The moment each stretch of speech begins — the only feature the fit uses. */
export function onsets(intervals: readonly SpeechInterval[]): Float64Array {
  const values = intervals
    .map((interval) => interval.startSeconds)
    .sort((left, right) => left - right);
  return Float64Array.from(values);
}

/** The nearest value in a sorted array, by binary search. */
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
  if (
    previous !== null &&
    Math.abs(previous - value) < Math.abs(candidate - value)
  )
    return previous;
  return candidate;
}

/**
 * Pairs cues with the reference onsets they must be, and fits a line.
 *
 * This is iterative closest point, which converges when it starts inside the
 * right basin and diverges entertainingly when it does not — hence the coarse
 * stage before it, and hence the tolerance schedule: the first pass is allowed
 * to pair things two and a half seconds apart, and each pass afterwards throws
 * away the pairs the previous fit proved wrong.
 *
 * The fit itself is ordinary least squares on `reference ≈ rate · target +
 * offset`. Its slope is refused if it leaves the plausible band, because a slope
 * fitted through a handful of coincidental pairs can be anything at all, and a
 * subtitle stretched by thirty percent is not a correction of any kind.
 */
function refine(
  targetOnsets: Float64Array,
  referenceOnsets: Float64Array,
  seed: CueTransform,
): CueTransform {
  let current = seed;
  for (const tolerance of FIT_TOLERANCES_SECONDS) {
    const xs: number[] = [];
    const ys: number[] = [];
    for (const onset of targetOnsets) {
      const mapped = onset * current.rate + current.offsetSeconds;
      const match = nearest(referenceOnsets, mapped);
      if (match === null || Math.abs(match - mapped) > tolerance) continue;
      xs.push(onset);
      ys.push(match);
    }
    if (xs.length < MINIMUM_FIT_PAIRS) break;
    const fitted = leastSquares(xs, ys);
    if (fitted === null) break;
    if (Math.abs(fitted.rate - 1) > RATE_BOUND) break;
    current = fitted;
  }
  return current;
}

export function leastSquares(
  xs: readonly number[],
  ys: readonly number[],
): CueTransform | null {
  const n = xs.length;
  let sumX = 0;
  let sumY = 0;
  for (let index = 0; index < n; index += 1) {
    sumX += xs[index] as number;
    sumY += ys[index] as number;
  }
  const meanX = sumX / n;
  const meanY = sumY / n;
  let covariance = 0;
  let variance = 0;
  for (let index = 0; index < n; index += 1) {
    const dx = (xs[index] as number) - meanX;
    covariance += dx * ((ys[index] as number) - meanY);
    variance += dx * dx;
  }
  /*
   * A subtitle whose cues are all within a few seconds of each other carries no
   * information about rate at all, and dividing by that variance produces a
   * slope from rounding noise. Such a document gets an offset and rate 1, which
   * is the only honest answer.
   */
  if (variance < 1) return { rate: 1, offsetSeconds: meanY - meanX };
  const rate = covariance / variance;
  if (!Number.isFinite(rate)) return null;
  return { rate, offsetSeconds: meanY - rate * meanX };
}

function score(
  targetOnsets: Float64Array,
  referenceOnsets: Float64Array,
  transform: CueTransform,
): { matchedCues: number; medianErrorSeconds: number } {
  const errors: number[] = [];
  let matched = 0;
  for (const onset of targetOnsets) {
    const mapped = onset * transform.rate + transform.offsetSeconds;
    const match = nearest(referenceOnsets, mapped);
    if (match === null) continue;
    const error = Math.abs(match - mapped);
    if (error <= MATCH_TOLERANCE_SECONDS) {
      matched += 1;
      errors.push(error);
    }
  }
  errors.sort((left, right) => left - right);
  const median =
    errors.length === 0 ? Number.NaN : (errors[errors.length >> 1] as number);
  return { matchedCues: matched, medianErrorSeconds: median };
}

/**
 * Offsets that are certainly wrong, for measuring how often chance agrees.
 *
 * Deliberately not round, and deliberately not multiples of one another. A
 * subtitle's cues are not laid out at random — dialogue has rhythm, and a decoy
 * at a whole number of seconds can sit on that rhythm and overstate the
 * background. Both signs are used because a film's speech is denser in its
 * second half than its first.
 */
const DECOY_OFFSETS_SECONDS = [-21.7, -13.9, -9.3, -5.7, 3.1, 7.3, 11.9, 19.3];

function backgroundMatches(
  targetOnsets: Float64Array,
  referenceOnsets: Float64Array,
  transform: CueTransform,
): number {
  const counts = DECOY_OFFSETS_SECONDS.map(
    (decoy) =>
      score(targetOnsets, referenceOnsets, {
        rate: transform.rate,
        offsetSeconds: transform.offsetSeconds + decoy,
      }).matchedCues,
  ).sort((left, right) => left - right);
  return counts[counts.length >> 1] as number;
}

export interface AlignmentOptions {
  /** How far either way the coarse search looks. */
  readonly maxOffsetSeconds?: number;
  /**
   * Rates to try before fitting. Narrowed by a caller that knows the reference
   * came from the same print — an audio track cannot be a different transfer of
   * the film it is part of, so only the subtitle can be mis-rated.
   */
  readonly rates?: readonly number[];
}

/**
 * Where the target subtitle belongs, given something already in the right place.
 *
 * Returns a proposal in every case, including a bad one: deciding that a
 * confidence of eleven percent is not worth writing to disk is the caller's
 * business, and an aligner that threw would leave the operator with nothing to
 * look at when the answer is "these two do not describe the same film".
 */
export function alignSpeech(
  target: readonly SpeechInterval[],
  reference: readonly SpeechInterval[],
  options: AlignmentOptions = {},
): AlignmentProposal {
  const targetOnsets = onsets(target);
  const referenceOnsets = onsets(reference);
  if (targetOnsets.length === 0 || referenceOnsets.length === 0) {
    return {
      rate: 1,
      offsetSeconds: 0,
      matchedFraction: 0,
      matchedCues: 0,
      consideredCues: targetOnsets.length,
      medianErrorSeconds: Number.NaN,
      coarseScore: 0,
      confidence: 0,
    };
  }

  const coarse = coarseAlignment(
    target,
    reference,
    options.maxOffsetSeconds ?? DEFAULT_MAX_OFFSET_SECONDS,
    options.rates ?? CANDIDATE_RATES,
  );
  const refined = refine(targetOnsets, referenceOnsets, {
    rate: coarse.rate,
    offsetSeconds: coarse.offsetSeconds,
  });

  /*
   * The refined fit is not assumed to be an improvement. Iterative fitting can
   * walk downhill when the coarse peak was already right and the pairs it found
   * were sparse, so both are scored and the better one is what leaves here.
   */
  const candidates: CueTransform[] = [
    refined,
    { rate: coarse.rate, offsetSeconds: coarse.offsetSeconds },
  ];
  let best: AlignmentProposal | null = null;
  for (const transform of candidates) {
    const measured = score(targetOnsets, referenceOnsets, transform);
    const background = backgroundMatches(
      targetOnsets,
      referenceOnsets,
      transform,
    );
    const proposal: AlignmentProposal = {
      ...transform,
      matchedCues: measured.matchedCues,
      consideredCues: targetOnsets.length,
      matchedFraction: measured.matchedCues / targetOnsets.length,
      medianErrorSeconds: measured.medianErrorSeconds,
      coarseScore: coarse.score,
      confidence:
        measured.matchedCues === 0
          ? 0
          : Math.max(0, 1 - background / measured.matchedCues),
    };
    if (best === null || proposal.matchedCues > best.matchedCues)
      best = proposal;
  }
  return best as AlignmentProposal;
}
