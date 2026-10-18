import { randomUUID } from "node:crypto";
import { cpus } from "node:os";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  getEncodingPolicy,
  type RenditionCodecFamily,
  type RenditionVideoEncoder,
} from "../encoding";
import { runBoundedProcess } from "../processExecution";
import {
  buildAdaptiveSampleFfmpegArgs,
  type AdaptiveVideoOutput,
  type RungBitrate,
} from "./encoding";

/**
 * Per-title rates, found by encoding samples and measuring them.
 *
 * The policy table gives each class one rate, written for a demanding master.
 * Most of this library is easier than that: on the Windows host, the Sopranos
 * pilot's 1080p rung scored VMAF 95.3 against its source at 74% of the table
 * rate, and Andor's 2160p rung 96.5 at a third of it. But a rate read off the
 * source alone cannot tell them apart from Ezel, a 2 Mbps 1080p source that
 * scored 88 (and 60 on its worst frames) at its own rate and needed the full
 * table rate to reach 97.8. Only measuring tells.
 *
 * So, for encoders that are given a target rate (QSV, VideoToolbox), a few
 * seconds from across the title are encoded at fractions of the table rate
 * with the job's own encoder settings, and each rung takes the lowest fraction
 * whose picture still scores VMAF `MIN_MEAN` on average and `MIN_P5` on its
 * worst 5% of frames, measured against the source scaled to that rung. A rung
 * that never qualifies keeps the table rate, which also stays the ceiling, so
 * no title ever gets fewer bits than it needs or more than it got before.
 *
 * Everything here is advisory: a probe that fails, times out, or finds no
 * `libvmaf` leaves the title on the table rates it would have had anyway.
 */

/** Fractions of the table rate tried, lowest first. */
export const RATE_PROBE_FACTORS = [0.4, 0.55, 0.7, 0.85] as const;
/** Average VMAF a rung must keep against the source. */
export const RATE_PROBE_MIN_MEAN = 95;
/** VMAF the worst 5% of a rung's frames must keep. */
export const RATE_PROBE_MIN_P5 = 90;
/**
 * Rungs below this are not measured: VMAF says little about a 144p picture,
 * and together they are about a tenth of a ladder's bytes. They keep the
 * table rate, and the ordering clamp below still brings them under the rungs
 * above them.
 */
export const RATE_PROBE_MIN_HEIGHT = 720;
/**
 * A rung never gets more than this share of the rung above it.
 *
 * A player picks rungs by advertised bandwidth, so a 720p rung that outweighs
 * the 1080p one is a step down in picture for a step up in bits.
 */
const LADDER_STEP_RATIO = 0.85;
const SAMPLE_WINDOW_SECONDS = 10;
const SAMPLE_WINDOW_POSITIONS = [0.1, 0.28, 0.46, 0.64, 0.82] as const;
/** Titles shorter than this are encoded at table rates; sampling would be most of the work. */
const MIN_PROBE_DURATION_SECONDS = 300;
const ENCODE_TIMEOUT_MS = 10 * 60_000;
const MEASURE_TIMEOUT_MS = 15 * 60_000;
const RATE_PROBE_FILE = "rate-probe.json";
const RATE_PROBE_VERSION = 1;

export interface RungQuality {
  mean: number;
  p5: number;
}

export interface RateProbeEvidence {
  qualityHeight: number;
  factor: number;
  mean: number;
  p5: number;
}

export interface RateProbeResult {
  /** Chosen rate per rung, keyed by quality height. */
  rates: Record<number, RungBitrate & { factor: number }>;
  evidence: RateProbeEvidence[];
}

export function qualityPasses(quality: RungQuality): boolean {
  return quality.mean >= RATE_PROBE_MIN_MEAN && quality.p5 >= RATE_PROBE_MIN_P5;
}

export function sampleWindows(
  durationSeconds: number,
): Array<{ startSeconds: number; durationSeconds: number }> {
  if (!(durationSeconds >= MIN_PROBE_DURATION_SECONDS)) return [];
  return SAMPLE_WINDOW_POSITIONS.map((position) => ({
    startSeconds: Math.floor(durationSeconds * position),
    durationSeconds: SAMPLE_WINDOW_SECONDS,
  }));
}

/** Whether this encoder is rate-targeted, which is the only kind a probe can help. */
export function encoderTakesTargetRate(
  encoder: RenditionVideoEncoder,
): boolean {
  return (
    encoder === "h264_qsv" ||
    encoder === "hevc_qsv" ||
    encoder === "h264_videotoolbox" ||
    encoder === "hevc_videotoolbox" ||
    encoder === "h264_nvenc" ||
    encoder === "hevc_nvenc"
  );
}

function rateAt(
  qualityHeight: number,
  codecFamily: RenditionCodecFamily,
  factor: number,
): RungBitrate {
  const policy = getEncodingPolicy(qualityHeight, codecFamily);
  const target = Math.round(policy.expectedVideoBitrate * factor);
  // The cap keeps the table's proportion to the target, so busy scenes keep
  // the same room to peak, and a cap equal to the target would select CBR.
  return {
    target,
    max: Math.round(
      target * (policy.maxVideoBitrate / policy.expectedVideoBitrate),
    ),
  };
}

/**
 * The search, kept apart from FFmpeg so it can be tested on its own.
 *
 * Quality rises with rate, so the lowest qualifying factor is found by binary
 * search: at most three measurements per rung for four candidates.
 */
export async function chooseRungRates({
  outputs,
  codecFamily,
  measure,
}: {
  outputs: readonly Pick<AdaptiveVideoOutput, "qualityHeight">[];
  codecFamily: RenditionCodecFamily;
  measure: (rungIndex: number, factor: number) => Promise<RungQuality>;
}): Promise<RateProbeResult> {
  const evidence: RateProbeEvidence[] = [];
  const factors = new Map<number, number>();

  for (const [index, output] of outputs.entries()) {
    if (output.qualityHeight < RATE_PROBE_MIN_HEIGHT) continue;
    let low = 0;
    let high = RATE_PROBE_FACTORS.length - 1;
    let best: number | undefined;
    while (low <= high) {
      const middle = (low + high) >> 1;
      const factor = RATE_PROBE_FACTORS[middle]!;
      const quality = await measure(index, factor);
      evidence.push({
        qualityHeight: output.qualityHeight,
        factor,
        ...quality,
      });
      if (qualityPasses(quality)) {
        best = factor;
        high = middle - 1;
      } else {
        low = middle + 1;
      }
    }
    if (best !== undefined) factors.set(output.qualityHeight, best);
  }

  const rates: RateProbeResult["rates"] = {};
  let above: number | undefined;
  for (const output of [...outputs].sort(
    (left, right) => right.qualityHeight - left.qualityHeight,
  )) {
    const policy = getEncodingPolicy(output.qualityHeight, codecFamily);
    let factor = factors.get(output.qualityHeight) ?? 1;
    if (above !== undefined) {
      factor = Math.min(
        factor,
        (above * LADDER_STEP_RATIO) / policy.expectedVideoBitrate,
      );
    }
    const rate = rateAt(output.qualityHeight, codecFamily, factor);
    rates[output.qualityHeight] = {
      ...rate,
      factor: Math.round(factor * 1000) / 1000,
    };
    above = rate.target;
  }
  return { rates, evidence };
}

/** Mean and 5th percentile of per-frame VMAF scores. */
export function poolVmafScores(scores: readonly number[]): RungQuality {
  if (scores.length === 0) throw new Error("VMAF produced no frame scores.");
  const sorted = [...scores].sort((left, right) => left - right);
  const mean =
    sorted.reduce((total, score) => total + score, 0) / sorted.length;
  const p5 = sorted[Math.floor(sorted.length * 0.05)]!;
  return { mean, p5 };
}

const libvmafSupport = new Map<string, Promise<boolean>>();

export function ffmpegHasLibvmaf(
  ffmpegPath: string,
  signal?: AbortSignal,
): Promise<boolean> {
  let known = libvmafSupport.get(ffmpegPath);
  if (!known) {
    known = runBoundedProcess({
      command: ffmpegPath,
      args: ["-hide_banner", "-filters"],
      timeoutMs: 30_000,
      describe: "ffmpeg -filters",
      ...(signal ? { signal } : {}),
    })
      .then(({ stdout }) => /\blibvmaf\b/.test(stdout))
      .catch(() => false);
    libvmafSupport.set(ffmpegPath, known);
  }
  return known;
}

/** A path inside a filter-graph option: forward slashes, drive colon escaped. */
function filterPath(filePath: string): string {
  return `'${filePath.replace(/\\/g, "/").replace(/:/g, "\\:")}'`;
}

interface StoredRateProbe {
  version: number;
  encoder: RenditionVideoEncoder;
  preset: string;
  result: RateProbeResult;
}

/**
 * What a previous attempt of this job decided, if anything.
 *
 * A resumed job must encode its remaining epochs at the rates its finished
 * epochs used, so the decision is written into the job's durable checkpoint
 * root and read back rather than measured again.
 */
export async function readStoredRateProbe(
  checkpointRoot: string,
  encoder: RenditionVideoEncoder,
  preset: string,
): Promise<RateProbeResult | null> {
  try {
    const stored = JSON.parse(
      await readFile(path.join(checkpointRoot, RATE_PROBE_FILE), "utf8"),
    ) as StoredRateProbe;
    if (
      stored.version !== RATE_PROBE_VERSION ||
      stored.encoder !== encoder ||
      stored.preset !== preset
    ) {
      return null;
    }
    return stored.result;
  } catch {
    return null;
  }
}

async function writeStoredRateProbe(
  checkpointRoot: string,
  value: StoredRateProbe,
): Promise<void> {
  const filePath = path.join(checkpointRoot, RATE_PROBE_FILE);
  const temporary = `${filePath}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, filePath);
}

export interface ProbeTitleRatesInput {
  ffmpegPath: string;
  sourcePath: string;
  durationSeconds: number;
  outputs: readonly AdaptiveVideoOutput[];
  encoder: RenditionVideoEncoder;
  codecFamily: RenditionCodecFamily;
  preset: string;
  frameRate?: number;
  segmentSeconds: number;
  filterComplexThreads?: number;
  /** Durable per-job directory; the decision is kept here for resumes. */
  checkpointRoot: string;
  signal?: AbortSignal;
  /** Holds off between steps while the queue is paused. */
  waitWhilePaused?: () => Promise<void>;
}

/**
 * Measures and records this title's rates. Resolves `null` when the title
 * should simply use the table, and never throws for a probe failure.
 */
export async function probeTitleRates(
  input: ProbeTitleRatesInput,
): Promise<RateProbeResult | null> {
  const windows = sampleWindows(input.durationSeconds);
  if (
    windows.length === 0 ||
    !encoderTakesTargetRate(input.encoder) ||
    !input.outputs.some(
      (output) => output.qualityHeight >= RATE_PROBE_MIN_HEIGHT,
    ) ||
    !(await ffmpegHasLibvmaf(input.ffmpegPath, input.signal))
  ) {
    return null;
  }

  const sampleRoot = path.join(input.checkpointRoot, "rate-probe");
  await rm(sampleRoot, { recursive: true, force: true });
  await mkdir(sampleRoot, { recursive: true });
  const vmafThreads = Math.max(1, cpus().length - 2);
  const encodes = new Map<number, Promise<string[]>>();

  const encodeAt = (factor: number): Promise<string[]> => {
    let pending = encodes.get(factor);
    if (!pending) {
      pending = (async () => {
        const outputs = input.outputs.map((output) => ({
          ...output,
          bitrate: rateAt(output.qualityHeight, input.codecFamily, factor),
        }));
        const files: string[] = [];
        for (const [index, window] of windows.entries()) {
          await input.waitWhilePaused?.();
          const outputPath = path.join(sampleRoot, `f${factor}-w${index}.mp4`);
          await runBoundedProcess({
            command: input.ffmpegPath,
            args: buildAdaptiveSampleFfmpegArgs({
              inputPath: input.sourcePath,
              startSeconds: window.startSeconds,
              durationSeconds: window.durationSeconds,
              outputPath,
              videoOutputs: outputs,
              encoder: input.encoder,
              preset: input.preset,
              segmentSeconds: input.segmentSeconds,
              ...(input.frameRate === undefined
                ? {}
                : { frameRate: input.frameRate }),
              ...(input.filterComplexThreads === undefined
                ? {}
                : { filterComplexThreads: input.filterComplexThreads }),
            }),
            timeoutMs: ENCODE_TIMEOUT_MS,
            describe: "rate probe encode",
            ...(input.signal ? { signal: input.signal } : {}),
          });
          files.push(outputPath);
        }
        return files;
      })();
      encodes.set(factor, pending);
    }
    return pending;
  };

  const measure = async (
    rungIndex: number,
    factor: number,
  ): Promise<RungQuality> => {
    const files = await encodeAt(factor);
    const output = input.outputs[rungIndex]!;
    const scores: number[] = [];
    for (const [index, window] of windows.entries()) {
      await input.waitWhilePaused?.();
      const logPath = path.join(
        sampleRoot,
        `vmaf-${output.qualityHeight}-f${factor}-w${index}.json`,
      );
      // The reference goes through the same trim, rate change and scale as
      // the rung, at a better scaler, so the score is the encoder's loss and
      // not the resize's.
      const reference = [
        "trim=start=0",
        "setpts=PTS-STARTPTS",
        ...(output.frameRate ? [`fps=${output.frameRate}`] : []),
        `scale=${output.width}:${output.height}:flags=bicubic`,
        "format=yuv420p",
      ].join(",");
      await runBoundedProcess({
        command: input.ffmpegPath,
        args: [
          "-hide_banner",
          "-nostdin",
          "-loglevel",
          "error",
          "-i",
          files[index]!,
          "-ss",
          window.startSeconds.toFixed(6),
          "-t",
          window.durationSeconds.toFixed(6),
          "-i",
          input.sourcePath,
          "-lavfi",
          `[0:v:${rungIndex}]setpts=PTS-STARTPTS,format=yuv420p[distorted];` +
            `[1:v:0]${reference}[reference];` +
            `[distorted][reference]libvmaf=n_threads=${vmafThreads}:log_fmt=json:log_path=${filterPath(logPath)}`,
          "-f",
          "null",
          "-",
        ],
        timeoutMs: MEASURE_TIMEOUT_MS,
        describe: "rate probe measurement",
        ...(input.signal ? { signal: input.signal } : {}),
      });
      const log = JSON.parse(await readFile(logPath, "utf8")) as {
        frames?: Array<{ metrics?: { vmaf?: number } }>;
      };
      for (const frame of log.frames ?? []) {
        if (typeof frame.metrics?.vmaf === "number") {
          scores.push(frame.metrics.vmaf);
        }
      }
    }
    return poolVmafScores(scores);
  };

  try {
    const result = await chooseRungRates({
      outputs: input.outputs,
      codecFamily: input.codecFamily,
      measure,
    });
    await writeStoredRateProbe(input.checkpointRoot, {
      version: RATE_PROBE_VERSION,
      encoder: input.encoder,
      preset: input.preset,
      result,
    });
    return result;
  } catch (error) {
    if (input.signal?.aborted) throw error;
    console.warn(
      `[seyirlik] rate probe failed; using table rates — ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return null;
  } finally {
    await rm(sampleRoot, { recursive: true, force: true }).catch(() => {});
  }
}
