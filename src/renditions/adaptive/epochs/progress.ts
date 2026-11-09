/**
 * What "34.2%" means, and how long it says there is left.
 *
 * The page used to show a weighted sum of workflow stages, so a job that had
 * reached a late stage read as nearly done while FFmpeg was a third of the way
 * through the film. Video progress here is one thing only: how much of the
 * source timeline has actually been encoded. Every other stage — assembling,
 * validating, publishing — is reported as itself rather than folded into that
 * number.
 */

import { SOFT_STALL_AFTER_MS } from "./stallPolicy";

export interface EpochProgressInput {
  /** Media time covered by epochs that are already durable. */
  protectedSeconds: number;
  /** Where the running epoch's own timeline starts. */
  currentEpochStartSeconds: number;
  /** FFmpeg's `out_time` for the running epoch. */
  currentEpochProcessedSeconds: number;
  sourceDurationSeconds: number;
}

export interface EpochProgressSnapshot {
  /** Media time encoded so far, protected plus the epoch in flight. */
  encodedSeconds: number;
  /** The same as a fraction of the source, clamped to [0,1]. */
  encodedFraction: number;
  protectedSeconds: number;
}

/**
 * Encoded media time.
 *
 * Deliberately measured from the running epoch's *own* start rather than from
 * the protected mark: an epoch that is being redone after an interruption
 * starts at the boundary before the loss, and adding its progress to the
 * protected mark would count that stretch twice and run the bar past the end.
 */
export function epochProgress({
  protectedSeconds,
  currentEpochStartSeconds,
  currentEpochProcessedSeconds,
  sourceDurationSeconds,
}: EpochProgressInput): EpochProgressSnapshot {
  const encodedSeconds = Math.max(
    protectedSeconds,
    Math.min(
      sourceDurationSeconds,
      currentEpochStartSeconds + Math.max(0, currentEpochProcessedSeconds),
    ),
  );
  return {
    encodedSeconds,
    encodedFraction:
      sourceDurationSeconds > 0
        ? Math.min(1, Math.max(0, encodedSeconds / sourceDurationSeconds))
        : 0,
    protectedSeconds,
  };
}

/**
 * A throughput estimate that does not lurch.
 *
 * FFmpeg's first few `speed` samples are dominated by process start, filter
 * graph construction and the seek preroll, and taking them at face value shows
 * an ETA of days for the first seconds of every epoch. They are dropped, and
 * what follows is smoothed exponentially so a passing stall bends the estimate
 * rather than replacing it.
 */
export interface SpeedEstimator {
  /** Feeds one sample. Returns the smoothed value, or undefined while warming. */
  sample(speed: number | undefined): number | undefined;
  readonly value: number | undefined;
  readonly samples: number;
}

/** Samples ignored at the start of each epoch, at four reports a second. */
export const SPEED_WARMUP_SAMPLES = 8;
/** Weight given to the newest sample. */
export const SPEED_SMOOTHING = 0.15;

export function createSpeedEstimator({
  warmupSamples = SPEED_WARMUP_SAMPLES,
  smoothing = SPEED_SMOOTHING,
}: { warmupSamples?: number; smoothing?: number } = {}): SpeedEstimator {
  let seen = 0;
  let smoothed: number | undefined;
  return {
    sample(speed) {
      if (speed === undefined || !Number.isFinite(speed) || speed <= 0) {
        return smoothed;
      }
      seen += 1;
      if (seen <= warmupSamples) return smoothed;
      smoothed =
        smoothed === undefined
          ? speed
          : smoothed + smoothing * (speed - smoothed);
      return smoothed;
    },
    get value() {
      return smoothed;
    },
    get samples() {
      return seen;
    },
  };
}

/**
 * Seconds of wall clock left in the *video* stage.
 *
 * Only the encode is estimated. Assembly is a byte copy whose cost is a
 * fraction of it, and validation and publication are shown as their own stages,
 * so folding them in would trade a number that can be trusted for one that
 * cannot.
 */
export function estimateEncodeEtaSeconds({
  encodedSeconds,
  sourceDurationSeconds,
  smoothedSpeed,
}: {
  encodedSeconds: number;
  sourceDurationSeconds: number;
  smoothedSpeed: number | undefined;
}): number | undefined {
  if (!smoothedSpeed || smoothedSpeed <= 0) return undefined;
  const remaining = Math.max(0, sourceDurationSeconds - encodedSeconds);
  const eta = remaining / smoothedSpeed;
  return Number.isFinite(eta) ? Math.round(eta) : undefined;
}

/**
 * Interpolated media time between authoritative samples, for a bar that moves.
 *
 * Bounded by the next epoch boundary and by the last confirmed value plus the
 * time that has genuinely passed, so it can drift ahead of the truth by at most
 * the reporting interval and can never invent completion. A stalled encoder
 * reaches the bound and stops, which is the honest picture.
 */
export function interpolatedMediaSeconds({
  confirmedSeconds,
  confirmedAtMs,
  nowMs,
  smoothedSpeed,
  upperBoundSeconds,
}: {
  confirmedSeconds: number;
  confirmedAtMs: number;
  nowMs: number;
  smoothedSpeed: number | undefined;
  upperBoundSeconds: number;
}): number {
  if (!smoothedSpeed || smoothedSpeed <= 0 || nowMs <= confirmedAtMs) {
    return Math.min(confirmedSeconds, upperBoundSeconds);
  }
  const elapsed = (nowMs - confirmedAtMs) / 1000;
  return Math.min(
    upperBoundSeconds,
    confirmedSeconds + elapsed * smoothedSpeed,
  );
}

/**
 * How long media time may stand still before the encoder is called stalled.
 *
 * The *soft* threshold, and only the soft one: it decides what a page says, not
 * what happens to a process. It is re-exported from the stall policy rather
 * than restated, because a page that calls an encode stalled at one figure
 * while the watchdog is working to another is a page that contradicts itself.
 */
export const MEDIA_STALL_AFTER_MS = SOFT_STALL_AFTER_MS;

export interface MediaStallReading {
  /** True once media time has not advanced for the configured window. */
  stalled: boolean;
  /** When media time last advanced, so a page can say how long it has been. */
  advancedAtMs: number;
  /** Milliseconds since media time last moved. */
  stalledForMs: number;
}

export interface MediaStallDetector {
  sample(processedSeconds: number, atMs: number): MediaStallReading;
  /** Starts again, for a new epoch or a new attempt. */
  reset(): void;
}

/**
 * Watches media time rather than the reports about it.
 *
 * The distinction is the whole point: a report arriving says the process is
 * alive, and only the figure inside it says work is happening. Nothing here
 * knows why the work stopped — a blocked read, a suspended process, a filter
 * graph thinking — and it deliberately does not guess.
 */
export function createMediaStallDetector({
  stallAfterMs = MEDIA_STALL_AFTER_MS,
}: { stallAfterMs?: number } = {}): MediaStallDetector {
  let lastSeconds: number | undefined;
  let advancedAtMs = 0;
  return {
    sample(processedSeconds, atMs) {
      if (lastSeconds === undefined || processedSeconds > lastSeconds + 1e-6) {
        lastSeconds = processedSeconds;
        advancedAtMs = atMs;
      }
      const stalledForMs = Math.max(0, atMs - advancedAtMs);
      return {
        stalled: stalledForMs > stallAfterMs,
        advancedAtMs,
        stalledForMs,
      };
    },
    reset() {
      lastSeconds = undefined;
      advancedAtMs = 0;
    },
  };
}

/**
 * How far an epoch's video has got, from a progress report.
 *
 * Each epoch also stream-copies the source's audio and text subtitles into a
 * second output, and FFmpeg's `out_time` is the least advanced stream across
 * all of them. A subtitle track has packets only where someone speaks, so
 * `out_time` reads N/A until the first cue and then stands still through every
 * quiet stretch, while the video goes on encoding. The video's own frame count,
 * over the rate it is encoded at, is the time `out_time` meant when the epoch
 * wrote video alone. Speed is derived the same way when FFmpeg gives none.
 */
export function epochVideoProgress<
  T extends {
    processedSeconds: number;
    frames?: number;
    fps?: number;
    speed?: number;
  },
>(
  progress: T,
  frameRate: number | undefined,
  durationSeconds: number | undefined,
): T {
  if (!frameRate || frameRate <= 0 || !progress.frames) return progress;
  const fromFrames = progress.frames / frameRate;
  const bounded =
    durationSeconds !== undefined && durationSeconds > 0
      ? Math.min(fromFrames, durationSeconds)
      : fromFrames;
  return {
    ...progress,
    processedSeconds: Math.max(progress.processedSeconds, bounded),
    ...(progress.speed === undefined && progress.fps !== undefined
      ? { speed: progress.fps / frameRate }
      : {}),
  };
}
