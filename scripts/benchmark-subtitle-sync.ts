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
 *     [--model-cache <dir> [--embedding multilingual-e5-small]]
 *     [--approaches global,piecewise/speech,piecewise/speech+meaning,...]
 *
 * `<dataset>` holds one directory per episode with:
 *   audio.m4a      the package's audio rendition (the one `TitleReferences` reads)
 *   turkish.vtt    a subtitle timed to this edition — the truth that gets damaged
 *   english.vtt    optional: a second subtitle timed to this edition, the reference
 *   whisper-small.json optional: whisper.cpp `--output-json-full` of audio.m4a
 *   silero-0.5.txt, silero-0.35.txt optional: `whisper-vad-speech-segments`
 *                  output at those thresholds (see `subtitleVoice.ts`)
 *
 * With `--model-cache`, cues are also matched by meaning to the transcript
 * (see `subtitleSemantics.ts`), and the anchors are given to the aligner.
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
  alignmentStrength,
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
import {
  createTransformersEmbedder,
  SUBTITLE_EMBEDDING_MODELS,
  type SubtitleEmbeddingModelName,
} from "../src/server/ownApi/subtitles/subtitleEmbedder";
import {
  semanticAnchors,
  type TextEmbedder,
} from "../src/server/ownApi/subtitles/subtitleSemantics";
import { parseVoiceSegments } from "../src/server/ownApi/subtitles/subtitleVoice";
import {
  isReliableSpeech,
  parseWhisperTranscript,
  transcriptUtterances,
  type Transcript,
} from "../src/server/ownApi/subtitles/subtitleTranscript";

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
    if (best === null || alignmentStrength(result) > alignmentStrength(best))
      best = result;
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

/** Silero speech segments (whisper.cpp `whisper-vad-speech-segments`), if run. */
async function voiceOf(directory: string): Promise<SpeechInterval[][]> {
  const readings: SpeechInterval[][] = [];
  for (const threshold of ["0.5", "0.35"]) {
    const file = path.join(directory, `silero-${threshold}.txt`);
    if (!(await exists(file))) continue;
    readings.push(parseVoiceSegments(await readFile(file, "utf8")));
  }
  return readings.filter((reading) => reading.length > 0);
}

const speechReadingsOf = (speech: readonly SpeechInterval[][]) =>
  speech.map((intervals) => ({ kind: "speech" as const, intervals }));

/**
 * The line a borrowed cue in scenario D copied: the truth line its index
 * past the end stands for, counted the way `scenarios` borrowed them.
 */
function borrowedFrom(truth: readonly SpeechInterval[], index: number): number {
  const duration = Math.max(...truth.map((cue) => cue.endSeconds));
  const first = truth.findIndex((line) => line.startSeconds > duration * 0.7);
  return first + (index - truth.length);
}

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
  const modelCache = args.includes("--model-cache")
    ? args[args.indexOf("--model-cache") + 1]
    : undefined;
  const embedding = (
    args.includes("--embedding")
      ? args[args.indexOf("--embedding") + 1]
      : "multilingual-e5-small"
  ) as SubtitleEmbeddingModelName;
  const approaches = args.includes("--approaches")
    ? new Set((args[args.indexOf("--approaches") + 1] ?? "").split(","))
    : null;
  const wanted = (name: string) => !approaches || approaches.has(name);
  const embedder: TextEmbedder | null = modelCache
    ? createTransformersEmbedder({
        model: SUBTITLE_EMBEDDING_MODELS[embedding],
        cacheDir: modelCache,
        threads: 8,
      })
    : null;
  const episodes = (await readdir(dataset, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => !only || only.includes(name))
    .sort();

  const all: (Score & { episode: string })[] = [];
  for (const episode of episodes) {
    const directory = path.join(dataset, episode);
    if (!(await exists(path.join(directory, "turkish.vtt")))) continue;
    const lines = documentCues(
      parseSubtitleDocument(
        await readFile(path.join(directory, "turkish.vtt"), "utf8"),
      ),
    )
      .filter((cue) => cue.endSeconds > cue.startSeconds)
      .sort((left, right) => left.startSeconds - right.startSeconds);
    const truth: SpeechInterval[] = lines.map((cue) => ({
      startSeconds: cue.startSeconds,
      endSeconds: cue.endSeconds,
    }));
    const textOf = (index: number) =>
      (lines[index] ?? lines[borrowedFrom(truth, index)])?.text.join("\n") ??
      "";
    const transcript: Transcript | null = (await exists(
      path.join(directory, "whisper-small.json"),
    ))
      ? parseWhisperTranscript(
          await readFile(path.join(directory, "whisper-small.json"), "utf8"),
          { name: "whisper.cpp", model: "ggml-small", options: {} },
        )
      : null;
    const utterances = transcript ? transcriptUtterances(transcript) : null;
    const voice = await voiceOf(directory);
    const spoken = transcript
      ? transcript.segments.filter(isReliableSpeech)
      : null;
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
          speechReadingsOf(speech),
        ),
      ];
      if (english)
        results.push(
          piecewiseApproach("piecewise/english-subtitle", scenario, [
            { kind: "subtitle", intervals: english },
          ]),
        );
      const voiceReadings = voice.map((intervals) => ({
        kind: "voice" as const,
        intervals,
      }));
      if (voiceReadings.length > 0 && wanted("piecewise/voice"))
        results.push(
          piecewiseApproach("piecewise/voice", scenario, voiceReadings),
        );
      if (voiceReadings.length > 0 && wanted("piecewise/speech+voice"))
        results.push(
          piecewiseApproach("piecewise/speech+voice", scenario, [
            ...speechReadingsOf(speech),
            ...voiceReadings,
          ]),
        );
      if (utterances && spoken) {
        const speechReadings = speechReadingsOf(speech);
        const transcriptReading = {
          kind: "transcript" as const,
          intervals: utterances,
        };
        if (wanted("piecewise/transcript"))
          results.push(
            piecewiseApproach("piecewise/transcript", scenario, [
              transcriptReading,
            ]),
          );
        if (embedder) {
          const started = performance.now();
          const anchors = await semanticAnchors({
            cues: scenario.cues.map((truth) => ({
              index: truth.cue.index,
              text: textOf(truth.cue.index),
              startSeconds: truth.cue.startSeconds,
            })),
            segments: spoken,
            embedder,
          });
          const anchorMs = performance.now() - started;
          const timed = (score: Score) => ({
            ...score,
            ms: score.ms + anchorMs,
          });
          const combos: [string, AlignmentReference[]][] = [
            ["piecewise/speech+meaning", speechReadings],
            ["piecewise/voice+meaning", voiceReadings],
            [
              "piecewise/speech+voice+meaning",
              [...speechReadings, ...voiceReadings],
            ],
            ["piecewise/transcript+meaning", [transcriptReading]],
            [
              "piecewise/all-audio+meaning",
              [...speechReadings, transcriptReading],
            ],
          ];
          for (const [name, readings] of combos)
            if (wanted(name))
              results.push(
                timed(piecewiseApproach(name, scenario, readings, anchors)),
              );
        }
      }
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
