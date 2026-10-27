/**
 * Pinning a subtitle's lines to the moments they are spoken, by what they mean.
 *
 * A Turkish subtitle and an English audio track share no words, but a Turkish
 * line and the English sentence it translates share a meaning, and a
 * multilingual sentence embedding puts the two close together. Matching a
 * cue's meaning to a transcript segment says *this line is spoken here* — an
 * anchor that does not depend on speech being audible over the music, or on
 * how many lines happen to start near each other.
 *
 * The subtitle is never changed by this. Its text is read to decide timing and
 * for nothing else: not translated, not compared for quality, not rewritten.
 *
 * Similarity alone is a poor witness. "Come on!" is said thirty times an
 * episode and resembles every short exclamation; "Sen benim kardeşimsin"
 * resembles one sentence. So three things stand between a similarity and an
 * anchor:
 *
 *  1. **Local scaling.** Each pair's similarity is judged against how similar
 *     each side is to everything else near it (cross-domain similarity local
 *     scaling, the standard correction for "hub" sentences in bilingual
 *     mining). A generic line scores high against everything and so stands
 *     out against nothing.
 *  2. **Order.** Lines are spoken in the order they are subtitled, nearly
 *     always. Candidates are chosen for all cues at once by a monotonic path
 *     that rewards consistent offsets between neighbours, so a repeated line
 *     is matched where its neighbours are matched, not wherever it is most
 *     similar. A cue may match nothing.
 *  3. **Weight.** Each anchor carries a weight from its margin over the best
 *     rival and from whether its neighbours agree; a lone match, however
 *     similar, carries little. The piecewise aligner then needs several
 *     agreeing anchors before it moves a region.
 */

import type { CueAnchor } from "./piecewiseAlignment";

export interface TextEmbedder {
  /** Names the model, for the analysis record and its cache key. */
  readonly model: string;
  /** Unit-length vectors, one per text. */
  embed(texts: readonly string[]): Promise<Float32Array[]>;
}

export interface MatchableCue {
  readonly index: number;
  readonly text: string;
  readonly startSeconds: number;
}

export interface MatchableSegment {
  readonly startSeconds: number;
  readonly endSeconds: number;
  readonly text: string;
}

/** One anchor, with what it rests on, for a person to inspect. */
export interface SemanticAnchorEvidence extends CueAnchor {
  readonly cueText: string;
  readonly spokenText: string;
  readonly similarity: number;
  /** Local-scaled score less the best rival's, for the same cue. */
  readonly margin: number;
  /** Neighbouring anchors (within three cues) that agree on the offset. */
  readonly support: number;
}

export interface SemanticMatchOptions {
  /** How far from its own time a cue's counterpart may be. */
  readonly maxOffsetSeconds?: number;
  /** Candidates kept per cue before the ordered pass. */
  readonly candidatesPerCue?: number;
  /** Anchors weaker than this are not reported. */
  readonly minimumWeight?: number;
  readonly tuning?: Partial<SemanticTuning>;
}

export interface SemanticTuning {
  /** Nearest neighbours in the local-scaling average. */
  readonly neighbours: number;
  /** Margins at which an anchor's weight begins, and is full. */
  readonly marginFloor: number;
  readonly marginFull: number;
  readonly maximumWeight: number;
  /** A cue's own local-scaled score below this is no candidate at all. */
  readonly scoreFloor: number;
  /** What moving the dialogue to another offset costs: an edit, paid for by the matches after it. */
  readonly offsetPenaltyCap: number;
}

export const DEFAULT_SEMANTIC_TUNING: SemanticTuning = {
  neighbours: 4,
  marginFloor: 0.02,
  marginFull: 0.12,
  maximumWeight: 1.5,
  scoreFloor: 0.02,
  offsetPenaltyCap: 0.3,
};

/** Bumped when matching changes in a way that changes anchors. */
export const SEMANTIC_MATCHER_VERSION = "semantic-1";

/**
 * A cue's words as a sentence: markup, speaker dashes, sound descriptions and
 * line breaks out. What is left is what was said.
 */
export function speechText(text: string): string {
  return text
    .replace(/<[^>]*>/g, " ")
    .replace(/\{[^}]*\}/g, " ")
    .replace(/[([][^)\]]*[)\]]/g, " ")
    .replace(/^\s*[-–—]\s*/gm, " ")
    .replace(/[♪♫#]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function dot(left: Float32Array, right: Float32Array): number {
  let sum = 0;
  for (let index = 0; index < left.length; index += 1)
    sum += (left[index] as number) * (right[index] as number);
  return sum;
}

function meanOfTop(values: number[], count: number): number {
  if (values.length === 0) return 0;
  const top = values.sort((left, right) => right - left).slice(0, count);
  return top.reduce((sum, value) => sum + value, 0) / top.length;
}

interface Candidate {
  readonly segment: number;
  readonly score: number;
  readonly similarity: number;
  readonly margin: number;
}

/**
 * Anchors for a subtitle's cues from a transcript of the media's speech.
 *
 * `cues` are in the subtitle's own timeline and order; `segments` are the
 * transcript's reliable speech on the media's timeline (see
 * `isReliableSpeech`). Returns the anchors the ordered pass chose, each with
 * its evidence.
 */
export async function semanticAnchors(input: {
  readonly cues: readonly MatchableCue[];
  readonly segments: readonly MatchableSegment[];
  readonly embedder: TextEmbedder;
  readonly options?: SemanticMatchOptions;
}): Promise<SemanticAnchorEvidence[]> {
  const options = input.options ?? {};
  const tuning = { ...DEFAULT_SEMANTIC_TUNING, ...options.tuning };
  const window = options.maxOffsetSeconds ?? 300;
  const keep = options.candidatesPerCue ?? 3;

  const cues = input.cues
    .map((cue) => ({ ...cue, speech: speechText(cue.text) }))
    .filter((cue) => /[\p{L}\p{N}]/u.test(cue.speech))
    .sort((left, right) => left.startSeconds - right.startSeconds);
  const segments = input.segments
    .map((segment) => ({ ...segment, speech: speechText(segment.text) }))
    .filter((segment) => /[\p{L}\p{N}]/u.test(segment.speech))
    .sort((left, right) => left.startSeconds - right.startSeconds);
  if (cues.length === 0 || segments.length === 0) return [];

  const [cueVectors, segmentVectors] = await Promise.all([
    input.embedder.embed(cues.map((cue) => cue.speech)),
    input.embedder.embed(segments.map((segment) => segment.speech)),
  ]);

  // Which segments each cue may match: those within the search window.
  const reach = cues.map((cue) => {
    const from = lowerBound(segments, cue.startSeconds - window);
    const to = lowerBound(segments, cue.startSeconds + window);
    return { from, to };
  });
  const similarity = cues.map((_, i) => {
    const { from, to } = reach[i] as { from: number; to: number };
    const row = new Float32Array(Math.max(0, to - from));
    for (let j = from; j < to; j += 1)
      row[j - from] = dot(
        cueVectors[i] as Float32Array,
        segmentVectors[j] as Float32Array,
      );
    return row;
  });

  // Local scaling: each side's mean similarity to its nearest neighbours.
  const cueHubness = similarity.map((row) =>
    meanOfTop(Array.from(row), tuning.neighbours),
  );
  const segmentScores: number[][] = segments.map(() => []);
  similarity.forEach((row, i) => {
    const { from } = reach[i] as { from: number };
    row.forEach((value, offset) =>
      (segmentScores[from + offset] as number[]).push(value),
    );
  });
  const segmentHubness = segmentScores.map((values) =>
    meanOfTop(values, tuning.neighbours),
  );

  const candidates: Candidate[][] = similarity.map((row, i) => {
    const { from } = reach[i] as { from: number };
    const scored = Array.from(row, (value, offset) => ({
      segment: from + offset,
      similarity: value,
      score:
        2 * value -
        (cueHubness[i] as number) -
        (segmentHubness[from + offset] as number),
    })).sort((left, right) => right.score - left.score);
    const best = scored[0];
    if (!best || best.score < tuning.scoreFloor) return [];
    return scored.slice(0, keep).map((candidate, rank) => {
      // The best rival is the best candidate somewhere else in time.
      const rival = scored.find(
        (other, otherRank) =>
          otherRank !== rank &&
          Math.abs(
            (segments[other.segment] as { startSeconds: number }).startSeconds -
              (segments[candidate.segment] as { startSeconds: number })
                .startSeconds,
          ) > 2,
      );
      return {
        ...candidate,
        margin: candidate.score - (rival?.score ?? 0),
      };
    });
  });

  const path = orderedPath(cues, segments, candidates, tuning, window);

  // Weight from margin, then from neighbours who agree on the offset.
  const chosen = path
    .map((choice, i) =>
      choice === null
        ? null
        : {
            cue: cues[i] as (typeof cues)[number],
            candidate: (candidates[i] as Candidate[])[choice] as Candidate,
          },
    )
    .map((entry) =>
      entry === null
        ? null
        : {
            ...entry,
            offset:
              (segments[entry.candidate.segment] as MatchableSegment)
                .startSeconds - entry.cue.startSeconds,
          },
    );
  const evidence: SemanticAnchorEvidence[] = [];
  chosen.forEach((entry, i) => {
    if (!entry) return;
    let support = 0;
    for (let other = i - 3; other <= i + 3; other += 1) {
      const neighbour = chosen[other];
      if (other === i || !neighbour) continue;
      if (Math.abs(neighbour.offset - entry.offset) <= 1.5) support += 1;
    }
    const strength = Math.min(
      1,
      Math.max(
        0,
        (entry.candidate.margin - tuning.marginFloor) /
          (tuning.marginFull - tuning.marginFloor),
      ),
    );
    const weight =
      tuning.maximumWeight *
      strength *
      (support >= 2 ? 1 : support === 1 ? 0.6 : 0.3);
    if (weight < (options.minimumWeight ?? 0.05)) return;
    const segment = segments[
      entry.candidate.segment
    ] as (typeof segments)[number];
    evidence.push({
      cueIndex: entry.cue.index,
      mediaSeconds: segment.startSeconds,
      weight,
      cueText: entry.cue.speech,
      spokenText: segment.speech,
      similarity: entry.candidate.similarity,
      margin: entry.candidate.margin,
      support,
    });
  });
  return evidence;
}

/**
 * One candidate or none per cue, chosen together.
 *
 * The state is the offset the dialogue is currently on, in half-second bins.
 * Each cue may take a candidate whose offset is within a second of the state,
 * for that candidate's score, or take nothing for nothing. Staying on an
 * offset is free; moving to another costs a fixed penalty, so an edit is
 * followed once the matches after it pay for the move, and a repeated line
 * whose best match sits at some other offset is not taken unless it is very
 * much better than what its neighbours allow.
 *
 * The state space is exactly the offset, so the dynamic program is exact: no
 * path is lost because another reached the same state with a better score.
 */
function orderedPath(
  cues: readonly { startSeconds: number }[],
  segments: readonly MatchableSegment[],
  candidates: readonly Candidate[][],
  tuning: SemanticTuning,
  window: number,
): (number | null)[] {
  const step = 0.5;
  const tolerance = 1;
  const bins = Math.round((2 * window) / step) + 1;
  const binOf = (offset: number) => Math.round((offset + window) / step);
  const reach = Math.round(tolerance / step);

  let previous = new Float64Array(bins);
  let current = new Float64Array(bins);
  const moved = new Uint8Array(cues.length * bins);
  const movedFrom = new Int32Array(cues.length);
  // Per cue, per bin it touches: the candidate that pays most there.
  const gains: Map<number, { score: number; choice: number }>[] = cues.map(
    (cue, i) => {
      const touched = new Map<number, { score: number; choice: number }>();
      (candidates[i] as Candidate[]).forEach((candidate, choice) => {
        if (candidate.score <= 0) return;
        const offset =
          (segments[candidate.segment] as MatchableSegment).startSeconds -
          cue.startSeconds;
        const centre = binOf(offset);
        for (let bin = centre - reach; bin <= centre + reach; bin += 1) {
          if (bin < 0 || bin >= bins) continue;
          const held = touched.get(bin);
          if (!held || candidate.score > held.score)
            touched.set(bin, { score: candidate.score, choice });
        }
      });
      return touched;
    },
  );

  for (let i = 0; i < cues.length; i += 1) {
    let bestBin = 0;
    for (let bin = 1; bin < bins; bin += 1)
      if ((previous[bin] as number) > (previous[bestBin] as number))
        bestBin = bin;
    const best = previous[bestBin] as number;
    movedFrom[i] = bestBin;
    const jump = best - tuning.offsetPenaltyCap;
    const gain = gains[i] as Map<number, { score: number; choice: number }>;
    for (let bin = 0; bin < bins; bin += 1) {
      const stay = previous[bin] as number;
      const here = gain.get(bin)?.score ?? 0;
      if (i > 0 && jump > stay) {
        current[bin] = jump + here;
        moved[i * bins + bin] = 1;
      } else current[bin] = stay + here;
    }
    [previous, current] = [current, previous];
  }

  let state = 0;
  for (let bin = 1; bin < bins; bin += 1)
    if ((previous[bin] as number) > (previous[state] as number)) state = bin;
  const path: (number | null)[] = new Array(cues.length).fill(null);
  for (let i = cues.length - 1; i >= 0; i -= 1) {
    path[i] =
      (gains[i] as Map<number, { choice: number }>).get(state)?.choice ?? null;
    if (moved[i * bins + state]) state = movedFrom[i] as number;
  }
  return path;
}

function lowerBound(
  segments: readonly { startSeconds: number }[],
  value: number,
): number {
  let low = 0;
  let high = segments.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if ((segments[middle] as { startSeconds: number }).startSeconds < value)
      low = middle + 1;
    else high = middle;
  }
  return low;
}
