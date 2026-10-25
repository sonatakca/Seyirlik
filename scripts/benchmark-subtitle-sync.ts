/**
 * Measures subtitle synchronisation against real audio with a known answer.
 *
 * Synthetic timelines prove the arithmetic and nothing about a film's mix. The
 * library has the missing ingredient: a package keeps the subtitles that were
 * inside the video as WebVTT, timed to that exact edition by whoever authored
 * the release. Take one of those as the truth, damage its timing the way real
 * subtitles are damaged — half late, several regions shifted, the wrong frame
 * rate, a scene the edition lacks, a scene it has extra — and ask each
 * approach to put it back against the package's own audio. Every cue's true
 * place is known, so every error is measured rather than judged.
 *
 * Usage:
 *   npx tsx scripts/benchmark-subtitle-sync.ts <dataset> [--episodes a,b] [--json out.json]
 *
 * `<dataset>` holds one directory per episode with:
 *   audio.m4a      the package's audio rendition (the one `TitleReferences` reads)
 *   turkish.vtt    a subtitle timed to this edition — the truth that gets damaged
 *   english.vtt    optional: a second subtitle timed to this edition, the reference
 *   transcript.json optional: an ASR transcript (see `subtitleTranscript.ts`)
 *
 * No media is in the repository; the dataset lives wherever the operator put it.
 */
import { readFile, writeFile, access } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";

import {
  readAudioEnvelope,
  speechIntervalsFromEnvelope,
  SPEECH_DUTY_CYCLES,
  type EnvelopeSample,
} from "../src/server/ownApi/subtitles/audioSpeech";
import {
  alignPiecewise,
  type AlignmentCue,
  type AlignmentReference,
  type CueAnchor,
  type PiecewiseAlignment,
} from "../src/server/ownApi/subtitles/piecewiseAlignment";
import {
  alignSpeech,
  type SpeechInterval,
} from "../src/server/ownApi/subtitles/subtitleAlignment";
import {
  cueIntervals,
  documentCues,
  parseSubtitleDocument,
} from "../src/server/ownApi/subtitles/subtitleCues";
import { MINIMUM_SYNC_CONFIDENCE } from "../src/server/ownApi/subtitles/subtitleSync";

const FFMPEG = process.env.FFMPEG_PATH ?? "ffmpeg";

interface Truth {
  /** The cue as the damaged subtitle has it. */
  readonly cue: AlignmentCue;
  /** Where it really belongs on this edition, or null when it is not in it. */
  readonly media: number | null;
}

interface Scenario {
  readonly name: string;
  readonly cues: readonly Truth[];
}

/** A cue the damage did not move: where a correct region was before. */
const isUntouched = (truth: Truth) =>
  truth.media !== null &&
  Math.abs(truth.cue.startSeconds - truth.media) < 0.001;

function scenarios(truth: readonly SpeechInterval[]): Scenario[] {
  const duration = Math.max(...truth.map((cue) => cue.endSeconds));
  const half = duration / 2;
  const build = (
    name: string,
    timing: (seconds: number) => number | null,
  ): Scenario => ({
    name,
    cues: truth.flatMap((line, index) => {
      const start = timing(line.startSeconds);
      if (start === null) return [];
      const shift = start - line.startSeconds;
      return [
        {
          cue: {
            index,
            startSeconds: start,
            endSeconds: line.endSeconds + shift,
          },
          media: line.startSeconds,
        },
      ];
    }),
  });

  // D: the subtitle's edition had 45 s more at ~15:00 — cues for footage this
  // one lacks, borrowed from elsewhere in the subtitle so they look real.
  const cutAt = Math.min(900, half);
  const borrowed = truth.filter(
    (line) =>
      line.startSeconds > duration * 0.7 &&
      line.startSeconds < duration * 0.7 + 45,
  );
  const longerEdition: Truth[] = [];
  truth.forEach((line, index) => {
    const after = line.startSeconds >= cutAt;
    longerEdition.push({
      cue: {
        index,
        startSeconds: line.startSeconds + (after ? 45 : 0),
        endSeconds: line.endSeconds + (after ? 45 : 0),
      },
      media: line.startSeconds,
    });
  });
  const firstBorrowed = borrowed[0]?.startSeconds ?? 0;
  borrowed.forEach((line, offset) => {
    longerEdition.push({
      cue: {
        index: truth.length + offset,
        startSeconds: cutAt + 1 + (line.startSeconds - firstBorrowed),
        endSeconds: cutAt + 1 + (line.endSeconds - firstBorrowed),
      },
      media: null,
    });
  });
  longerEdition.sort(
    (left, right) => left.cue.startSeconds - right.cue.startSeconds,
  );

  return [
    build("F already in sync", (t) => t),
    build("plain +6.5 s", (t) => t + 6.5),
    build("A second half +8 s", (t) => (t >= half ? t + 8 : t)),
    build("B four regions", (t) =>
      t < duration * 0.25
        ? t
        : t < duration * 0.45
          ? t + 4
          : t < duration * 0.72
            ? t
            : t - 12,
    ),
    build("C 25/23.976 rate", (t) => t * (25 / 23.976) + 1.5),
    { name: "D scene not in this edition", cues: longerEdition },
    // E: this edition has 40 s the subtitle's did not — the subtitle has no
    // lines there, and everything after it is early.
    build("E scene only in this edition", (t) =>
      t >= cutAt && t < cutAt + 40 ? null : t >= cutAt + 40 ? t - 40 : t,
    ),
  ];
}

interface Score {
  readonly approach: string;
  readonly scenario: string;
  readonly verdict: string;
  readonly auto: boolean;
  readonly median: number;
  readonly p95: number;
  readonly within200ms: number;
  readonly within500ms: number;
  /** Cues that were right before and were moved by more than 200 ms. */
  readonly damaged: number;
  readonly untouched: number;
  readonly unmatchedFound: number;
  readonly unmatchedTruth: number;
  readonly unmatchedWrong: number;
  readonly segments: number;
  readonly ms: number;
}

function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[
    Math.min(sorted.length - 1, Math.floor(sorted.length * p))
  ] as number;
}

/**
 * How a placement did. A cue left unmoved for review is measured where it was
 * left, so an approach cannot buy accuracy by refusing; an unmatched cue is
 * measured as a detection instead.
 */
function scorePlacement(
  approach: string,
  scenario: Scenario,
  placed: ReadonlyMap<number, { start: number; disposition: string }>,
  verdict: string,
  auto: boolean,
  segments: number,
  ms: number,
): Score {
  const errors: number[] = [];
  let damaged = 0;
  let untouched = 0;
  let unmatchedFound = 0;
  let unmatchedWrong = 0;
  let unmatchedTruth = 0;
  for (const truth of scenario.cues) {
    const result = placed.get(truth.cue.index);
    if (!result) continue;
    if (truth.media === null) {
      unmatchedTruth += 1;
      if (result.disposition === "unmatched") unmatchedFound += 1;
      continue;
    }
    if (result.disposition === "unmatched") {
      unmatchedWrong += 1;
      continue;
    }
    const error = Math.abs(result.start - truth.media);
    errors.push(error);
    if (isUntouched(truth)) {
      untouched += 1;
      if (error > 0.2) damaged += 1;
    }
  }
  return {
    approach,
    scenario: scenario.name,
    verdict,
    auto,
    median: percentile(errors, 0.5),
    p95: percentile(errors, 0.95),
    within200ms: errors.filter((error) => error <= 0.2).length / errors.length,
    within500ms: errors.filter((error) => error <= 0.5).length / errors.length,
    damaged,
    untouched,
    unmatchedFound,
    unmatchedTruth,
    unmatchedWrong,
    segments,
    ms,
  };
}

function fromPiecewise(result: PiecewiseAlignment) {
  return new Map(
    result.cues.map((cue) => [
      cue.index,
      { start: cue.startSeconds, disposition: cue.disposition },
    ]),
  );
}

/** The old path: one transform, written whenever it cleared 0.35. */
function globalApproach(
  scenario: Scenario,
  references: readonly SpeechInterval[][],
): Score {
  const started = performance.now();
  const cues = scenario.cues.map((truth) => truth.cue);
  let best: ReturnType<typeof alignSpeech> | null = null;
  for (const reference of references) {
    const proposal = alignSpeech(cues, reference);
    if (best === null || proposal.confidence > best.confidence) best = proposal;
  }
  const proposal = best as NonNullable<typeof best>;
  const trusted = proposal.confidence >= MINIMUM_SYNC_CONFIDENCE;
  const placed = new Map(
    cues.map((cue) => [
      cue.index,
      {
        start: trusted
          ? cue.startSeconds * proposal.rate + proposal.offsetSeconds
          : cue.startSeconds,
        disposition: "corrected",
      },
    ]),
  );
  return scorePlacement(
    "global",
    scenario,
    placed,
    trusted
      ? `applied ${proposal.offsetSeconds.toFixed(2)}s c=${proposal.confidence.toFixed(2)}`
      : "refused",
    trusted,
    1,
    performance.now() - started,
  );
}

/** The piecewise engine over several readings of one reference; most coverage wins. */
function piecewiseApproach(
  name: string,
  scenario: Scenario,
  references: readonly AlignmentReference[],
  anchors?: readonly CueAnchor[],
): Score {
  const started = performance.now();
  const cues = scenario.cues.map((truth) => truth.cue);
  let best: PiecewiseAlignment | null = null;
  for (const reference of references) {
    const result = alignPiecewise(cues, reference, anchors ? { anchors } : {});
    if (best === null || rank(result) > rank(best)) best = result;
  }
  const result = best as PiecewiseAlignment;
  return scorePlacement(
    name,
    scenario,
    fromPiecewise(result),
    result.verdict,
    result.autoApplicable,
    result.segments.length,
    performance.now() - started,
  );
}

/** Which of several readings to believe: the one that explains the most of the subtitle. */
export function rank(result: PiecewiseAlignment): number {
  const confidence =
    result.segments
      .filter(
        (segment) =>
          segment.status === "aligned" || segment.status === "corrected",
      )
      .reduce(
        (sum, segment) => sum + segment.confidence * segment.cueCount,
        0,
      ) / Math.max(1, result.cues.length);
  return result.coverage + confidence;
}

async function exists(file: string) {
  return access(file).then(
    () => true,
    () => false,
  );
}

async function envelopeOf(directory: string): Promise<EnvelopeSample[]> {
  const cache = path.join(directory, "envelope.json");
  if (await exists(cache)) return JSON.parse(await readFile(cache, "utf8"));
  const envelope = await readAudioEnvelope({
    ffmpegPath: FFMPEG,
    inputPath: path.join(directory, "audio.m4a"),
    streamIndex: 0,
  });
  await writeFile(cache, JSON.stringify(envelope));
  return envelope;
}

async function intervalsOf(file: string): Promise<SpeechInterval[]> {
  return cueIntervals(
    documentCues(parseSubtitleDocument(await readFile(file, "utf8"))),
  );
}

const fmt = (value: number, digits = 2) =>
  Number.isFinite(value) ? value.toFixed(digits) : "—";

async function main() {
  const args = process.argv.slice(2);
  const dataset = args[0];
  if (!dataset)
    throw new Error(
      "usage: benchmark-subtitle-sync.ts <dataset> [--episodes a,b] [--json out]",
    );
  const only = args.includes("--episodes")
    ? (args[args.indexOf("--episodes") + 1] ?? "").split(",")
    : null;
  const jsonOut = args.includes("--json")
    ? args[args.indexOf("--json") + 1]
    : null;
  const { readdir } = await import("node:fs/promises");
  const episodes = (await readdir(dataset, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => !only || only.includes(name))
    .sort();

  const all: (Score & { episode: string })[] = [];
  for (const episode of episodes) {
    const directory = path.join(dataset, episode);
    if (!(await exists(path.join(directory, "turkish.vtt")))) continue;
    const truth = await intervalsOf(path.join(directory, "turkish.vtt"));
    const envelope = await envelopeOf(directory);
    const speech = SPEECH_DUTY_CYCLES.map((dutyCycle) =>
      speechIntervalsFromEnvelope(envelope, { dutyCycle }),
    );
    const english = (await exists(path.join(directory, "english.vtt")))
      ? await intervalsOf(path.join(directory, "english.vtt"))
      : null;

    for (const scenario of scenarios(truth)) {
      const results: Score[] = [
        globalApproach(scenario, speech),
        piecewiseApproach(
          "piecewise/speech",
          scenario,
          speech.map((intervals) => ({ kind: "speech" as const, intervals })),
        ),
      ];
      if (english)
        results.push(
          piecewiseApproach("piecewise/english-subtitle", scenario, [
            { kind: "subtitle", intervals: english },
          ]),
        );
      for (const score of results) {
        all.push({ episode, ...score });
        console.log(
          [
            episode.padEnd(18),
            score.scenario.padEnd(28),
            score.approach.padEnd(27),
            score.verdict.padEnd(22).slice(0, 22),
            score.auto ? "auto" : "    ",
            `med ${fmt(score.median)}`,
            `p95 ${fmt(score.p95)}`,
            `≤0.5s ${fmt(score.within500ms * 100, 0)}%`,
            `damaged ${score.damaged}/${score.untouched}`,
            `unmatched ${score.unmatchedFound}/${score.unmatchedTruth} (+${score.unmatchedWrong})`,
            `seg ${score.segments}`,
            `${fmt(score.ms, 0)}ms`,
          ].join("  "),
        );
      }
    }
  }
  if (jsonOut) await writeFile(jsonOut, JSON.stringify(all, null, 2));
}

await main();
