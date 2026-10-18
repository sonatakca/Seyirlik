/**
 * The immutable epoch plan.
 *
 * Written once, before any encoding, and read back on every restart. Two
 * properties matter and both are load-bearing:
 *
 *  - It is *deterministic*. The same source bytes, adaptive profile and
 *    timeline policy always produce the same boundaries, so a job that dies and
 *    restarts computes exactly the epochs it already has on disk rather than a
 *    slightly different set that cannot be joined to them.
 *  - It is *exact*. Boundaries are carried as rationals in the source's own
 *    time base, never as accumulated floating-point seconds, because a
 *    two-and-a-half-hour title has thirty joins and a fraction of a millisecond
 *    lost at each one is a visible drift by the end.
 */

import {
  DEFAULT_EPOCH_TARGET_SECONDS,
  EPOCH_PLAN_SCHEMA_VERSION,
  EPOCH_TIMELINE_POLICY_VERSION,
  MINIMUM_TAIL_FRACTION,
} from "./policy";
import {
  cutSecondsBetween,
  straddlingFrames,
  timestampSeconds,
  type SourceFrameTimeline,
  type SourceTimestamp,
} from "./sourceTimeline";

export interface EpochPlanEntry {
  index: number;
  /** The round boundary this epoch was placed on, before frame alignment. */
  nominalStartSeconds: number;
  nominalEndSeconds: number;
  /**
   * Presentation time of the first source frame this epoch owns, exactly.
   *
   * This is where the epoch's media is placed on the final timeline, so it is
   * the number the whole assembly depends on.
   */
  start: SourceTimestamp;
  /** First frame of the *next* epoch. Absent on the last epoch. */
  end?: SourceTimestamp;
  /**
   * What FFmpeg is told to seek to: midway between the last frame of the epoch
   * before and the first frame of this one, where no frame exists.
   */
  seekSeconds: number;
  /**
   * What FFmpeg is told to stop at, as an output duration. Absent on the last
   * epoch, which runs to the end of the source.
   */
  durationSeconds?: number;
  /** Nominal length, used for progress and estimates rather than for cutting. */
  expectedDurationSeconds: number;
}

export interface EpochPlan {
  schemaVersion: number;
  timelinePolicyVersion: string;
  profileVersion: string;
  mediaId: string;
  sourceFingerprint: string;
  sourceDurationSeconds: number;
  epochTargetSeconds: number;
  segmentSeconds: number;
  /** Whether frame times were measured, or nominal boundaries were assumed. */
  boundariesMeasured: boolean;
  epochs: EpochPlanEntry[];
  createdAt: string;
}

export interface BuildEpochPlanInput {
  mediaId: string;
  sourceFingerprint: string;
  profileVersion: string;
  sourceDurationSeconds: number;
  epochTargetSeconds?: number;
  segmentSeconds: number;
  /** Measured source frame times around each boundary; null when unavailable. */
  timeline?: SourceFrameTimeline | null;
  createdAt?: string;
}

/**
 * The round boundaries an epoch grid would use, before any frame alignment.
 *
 * Snapped to a whole number of segments so a boundary never lands inside one.
 * A cut in the middle of a two-second segment would force the epoch after it to
 * start a segment early, and the ladder's segment boundaries would stop being
 * the same instants in every rendition — which is the one property that makes a
 * mid-playback quality switch invisible.
 */
export function nominalEpochBoundaries({
  sourceDurationSeconds,
  epochTargetSeconds,
  segmentSeconds,
}: {
  sourceDurationSeconds: number;
  epochTargetSeconds: number;
  segmentSeconds: number;
}): number[] {
  const step =
    Math.max(1, Math.round(epochTargetSeconds / segmentSeconds)) *
    segmentSeconds;
  const boundaries: number[] = [];
  for (
    let boundary = step;
    boundary < sourceDurationSeconds;
    boundary += step
  ) {
    boundaries.push(boundary);
  }
  /*
   * A tail shorter than half an epoch is folded back rather than given its own
   * FFmpeg process, seek and validation pass. Without this a 02:30:04 title
   * ends on a four-second epoch, which costs more to protect than it protects.
   */
  const last = boundaries[boundaries.length - 1];
  if (
    last !== undefined &&
    sourceDurationSeconds - last < step * MINIMUM_TAIL_FRACTION
  ) {
    boundaries.pop();
  }
  return boundaries;
}

export function buildEpochPlan({
  mediaId,
  sourceFingerprint,
  profileVersion,
  sourceDurationSeconds,
  epochTargetSeconds = DEFAULT_EPOCH_TARGET_SECONDS,
  segmentSeconds,
  timeline = null,
  createdAt = new Date().toISOString(),
}: BuildEpochPlanInput): EpochPlan {
  if (!(sourceDurationSeconds > 0)) {
    throw new Error("An epoch plan needs a source with a positive duration.");
  }

  const boundaries = nominalEpochBoundaries({
    sourceDurationSeconds,
    epochTargetSeconds,
    segmentSeconds,
  });

  // Without measured frame times the plan still works: the boundaries are then
  // nominal, which is correct to within one frame, and each epoch's real start
  // is measured and recorded when it is validated.
  const timebase = timeline?.timebase ?? 1_000_000;
  const measured = timeline !== null && timeline.ticks.length > 0;

  const starts: SourceTimestamp[] = [{ ticks: 0, timebase }];
  const cuts: number[] = [0];

  for (const boundary of boundaries) {
    if (!measured) {
      starts.push({ ticks: Math.round(boundary * timebase), timebase });
      cuts.push(boundary);
      continue;
    }
    const frames = straddlingFrames(timeline, boundary);
    if (!frames.next) {
      /*
       * The probe saw nothing at or after this boundary. Either the source ends
       * here or its timestamps are stranger than the duration suggested; either
       * way there is no epoch to place, and inventing one would produce an
       * empty checkpoint the assembler could not use.
       */
      break;
    }
    starts.push(frames.next);
    cuts.push(cutSecondsBetween(frames, boundary));
  }

  const epochs: EpochPlanEntry[] = starts.map((start, index) => {
    const next = starts[index + 1];
    const nominalStartSeconds = index === 0 ? 0 : boundaries[index - 1]!;
    const nominalEndSeconds =
      index + 1 < starts.length ? boundaries[index]! : sourceDurationSeconds;
    const seekSeconds = cuts[index]!;
    const nextCut = cuts[index + 1];
    return {
      index,
      nominalStartSeconds,
      nominalEndSeconds,
      start,
      ...(next ? { end: next } : {}),
      seekSeconds,
      ...(nextCut === undefined
        ? {}
        : {
            /*
             * A duration rather than an absolute stop time, because with input
             * seeking FFmpeg's output timeline restarts at zero. Measured from
             * the epoch's first *kept* frame, since the seek pre-roll is
             * trimmed away before anything reaches the encoder. Both ends of
             * the interval are midpoints between real frames, so the length
             * between them cannot include or exclude a frame by accident.
             */
            durationSeconds: Number(
              (nextCut - timestampSeconds(start)).toFixed(6),
            ),
          }),
      expectedDurationSeconds: Number(
        (
          (next ? timestampSeconds(next) : sourceDurationSeconds) -
          timestampSeconds(start)
        ).toFixed(6),
      ),
    };
  });

  return {
    schemaVersion: EPOCH_PLAN_SCHEMA_VERSION,
    timelinePolicyVersion: EPOCH_TIMELINE_POLICY_VERSION,
    profileVersion,
    mediaId,
    sourceFingerprint,
    sourceDurationSeconds,
    epochTargetSeconds,
    segmentSeconds,
    boundariesMeasured: measured,
    epochs,
    createdAt,
  };
}

/**
 * Whether a plan found on disk describes the job about to run.
 *
 * A plan whose source, profile or timeline policy differs describes a different
 * build, and its epochs cannot be joined to the ones this job would produce.
 * Reusing it is exactly the "silently accepted stale checkpoint" failure the
 * whole identity check exists to prevent.
 */
export function planMatches(
  plan: EpochPlan,
  expected: {
    mediaId: string;
    sourceFingerprint: string;
    profileVersion: string;
    epochTargetSeconds: number;
    segmentSeconds: number;
    sourceDurationSeconds: number;
  },
): { ok: true } | { ok: false; reason: string } {
  if (plan.schemaVersion !== EPOCH_PLAN_SCHEMA_VERSION) {
    return { ok: false, reason: "plan-schema-version" };
  }
  if (plan.timelinePolicyVersion !== EPOCH_TIMELINE_POLICY_VERSION) {
    return { ok: false, reason: "timeline-policy-version" };
  }
  if (plan.mediaId !== expected.mediaId)
    return { ok: false, reason: "media-id" };
  if (plan.sourceFingerprint !== expected.sourceFingerprint) {
    return { ok: false, reason: "source-fingerprint" };
  }
  if (plan.profileVersion !== expected.profileVersion) {
    return { ok: false, reason: "profile-version" };
  }
  /*
   * The epoch length is deliberately not compared. A plan carries its own
   * boundaries, and every checkpoint under it was cut on them, so a plan made
   * under a different length is still a whole, joinable description of this
   * build. Refusing it would discard hours of finished epochs because a deploy
   * changed the length new plans are made with — which is the one thing a
   * checkpoint exists to survive. The new length applies from the next plan.
   */
  if (plan.segmentSeconds !== expected.segmentSeconds) {
    return { ok: false, reason: "segment-target" };
  }
  /*
   * Duration is compared loosely. ffprobe reports a container duration that can
   * move by a frame between runs on the same bytes, and a plan is not wrong
   * because of that — the fingerprint already proves the bytes are the same.
   */
  if (
    Math.abs(plan.sourceDurationSeconds - expected.sourceDurationSeconds) > 1
  ) {
    return { ok: false, reason: "source-duration" };
  }
  return { ok: true };
}

export function parseEpochPlan(text: string): EpochPlan {
  const parsed = JSON.parse(text) as EpochPlan;
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !Array.isArray(parsed.epochs) ||
    parsed.epochs.length === 0
  ) {
    throw new Error("The epoch plan is not a usable document.");
  }
  return parsed;
}

/** Total media time an epoch plan claims to cover. */
export function planDurationSeconds(plan: EpochPlan): number {
  return plan.sourceDurationSeconds;
}

/** Media time protected once the first `count` epochs are complete. */
export function protectedSecondsAfter(plan: EpochPlan, count: number): number {
  if (count <= 0) return 0;
  if (count >= plan.epochs.length) return plan.sourceDurationSeconds;
  return timestampSeconds(plan.epochs[count]!.start);
}
