/**
 * What every phase after the video encode reports about itself.
 *
 * The video encoder has always had rich feedback because FFmpeg hands it a
 * measured timeline four times a second. Everything after it — audio, assembly,
 * verification, publication — did real work for minutes at a time and reported
 * nothing but its own name, so a job that had finished encoding looked stalled
 * for the rest of its life.
 *
 * The shapes here are the fix, and they follow one rule: every number is
 * measured from work that has actually completed. Bytes are bytes the process
 * wrote, checks are checks the validator finished, media time is FFmpeg's own
 * `out_time`. Nothing is derived from a wall clock ticking toward a guess.
 *
 * They are also the wire format. These objects travel from the worker through
 * the live-progress file to the browser, so they hold only serialisable values:
 * rendition ids, counts and byte totals, never an absolute path and never a
 * Node object.
 */

/** One audio track, as the page names it. */
export interface AudioTrackProgress {
  /** Rendition id, e.g. `track-2`. Never a path. */
  id: string;
  /** ISO 639 code when the source declares one. */
  language?: string;
  title?: string;
  codec: string;
  channels: number;
  /** Bytes on disk for this track, measured from the file being written. */
  writtenBytes: number;
}

/**
 * The audio stage.
 *
 * One FFmpeg process encodes every retained track in a single pass over the
 * source, so there is no "track 2 of 3" to report: the tracks advance together
 * along one timeline. `processedSeconds` is that shared timeline, and the
 * per-track figures are the bytes each has produced so far. Reporting a
 * sequential track position would be easier to read and would be false.
 */
export interface AudioPhaseProgress {
  tracks: AudioTrackProgress[];
  /** FFmpeg's `out_time`: media seconds all tracks have been written through. */
  processedSeconds: number;
  durationSeconds: number;
  /** `processedSeconds / durationSeconds`, clamped. */
  fraction: number;
  /** FFmpeg's throughput multiplier, smoothed. */
  speed?: number;
  /** Total bytes written across every track. */
  writtenBytes: number;
  etaSeconds?: number;
  /**
   * True when the stage was satisfied by an existing checkpoint. There is no
   * progress to report because no work is being done.
   */
  reused?: boolean;
}

export type AssemblyRenditionState = "waiting" | "running" | "complete";

export interface AssemblyRenditionProgress {
  /** Rendition id, e.g. `1080p`. */
  id: string;
  /**
   * Bytes this rendition is expected to produce, summed from the checkpoint
   * manifests it is being joined from and fixed before the phase starts.
   *
   * It exceeds the final file by one initialisation segment per epoch after
   * the first, because assembly writes one initialisation for the whole title
   * rather than one per epoch — kilobytes against gigabytes. The figure is not
   * revised when the real size is known: the denominator is committed, and the
   * reconciliation happens once, at completion.
   */
  expectedBytes: number;
  /** Bytes actually written into the final media file. */
  writtenBytes: number;
  state: AssemblyRenditionState;
}

/**
 * The assembly stage, in bytes rather than in renditions.
 *
 * A ladder is not eight equal jobs: 2160p is seventy times the bytes of 144p,
 * and counting rungs showed a build that had written two thirds of its data as
 * a quarter done. The denominator is the sum of the epoch checkpoints being
 * joined, which is known exactly before the first byte is copied.
 */
export interface AssemblyPhaseProgress {
  /**
   * Bytes this phase expects to write, summed from the validated epoch inputs
   * and **fixed for the whole phase**.
   *
   * Nothing revises it while assembly runs. An earlier version substituted
   * each rendition's measured size as it completed, which moved the
   * denominator during the phase — harmless in direction, since the measured
   * size is always slightly smaller, but it meant the number under the bar
   * changed for reasons that had nothing to do with progress.
   */
  totalBytes: number;
  completedBytes: number;
  /**
   * `completedBytes / totalBytes`, clamped — except at the end, where every
   * rendition being complete is what makes it exactly 1. Those two can differ
   * by the initialisation segments described above, and the phase being
   * finished is a fact about the renditions, not about the ratio.
   */
  fraction: number;
  renditions: AssemblyRenditionProgress[];
  /** The rendition being written, when one is. */
  currentId?: string;
  /** Rolling throughput over the last few seconds. Absent until measurable. */
  bytesPerSecond?: number;
  /** Only present once throughput is known; never a guess. */
  etaSeconds?: number;
  /**
   * The audio stage being copied into the package, which happens after the
   * video renditions are joined. Its bytes are deliberately outside the totals
   * above: those describe the video assembly the ladder table shows.
   */
  audioCopyBytes?: number;
  audioCopyState?: "waiting" | "running" | "complete";
  /**
   * The manifest measurement that follows the join.
   *
   * Once the bytes are written every assembled rendition is walked again — an
   * `ffprobe -skip_frame nokey` per rung — to record the keyframe cadence the
   * manifest advertises. It reads everything that was just written, so on a
   * thirty-gigabyte ladder it is tens of minutes of real work, and it used to
   * happen entirely unannounced: the byte counter had already reached its
   * total, so the page showed a finished bar and a stale-rate notice while
   * ffprobe worked.
   *
   * Kept beside the byte totals rather than inside them, exactly as the audio
   * copy is: those totals describe the join, and this is a different kind of
   * work measured a different way.
   */
  measure?: AssemblyMeasureProgress;
}

/** One rendition being measured after the join, and how far through it is. */
export interface AssemblyMeasureProgress {
  /** Rendition being read, e.g. `2160p`. */
  currentId: string;
  /** Which of the ladder's rungs this is, counting from one. */
  index: number;
  count: number;
  /** Media seconds the scan has reached, when it has reported any. */
  currentMediaSeconds?: number;
  totalMediaSeconds?: number;
  /** `currentMediaSeconds / totalMediaSeconds`, clamped and monotonic. */
  fraction?: number;
  /** Media seconds read per wall-clock second. */
  rate?: number;
  etaSeconds?: number;
  lastAdvancedAtMs?: number;
  stalled?: boolean;
}

/** What a verification step is proving. */
export type VerificationCheckKind =
  | "metadata"
  | "master-playlist"
  | "video-structure"
  | "video-probe"
  | "cross-rendition"
  | "audio"
  | "subtitle"
  | "seek-decode"
  | "cross-quality-splice";

export interface VerificationStepProgress {
  kind: VerificationCheckKind;
  /** Rendition id when the step is about one, `package` when it is not. */
  rendition: string;
  /** Wall clock when this check began, so the page can show how long it has run. */
  startedAtMs?: number;
  /**
   * How far into the rendition's own timeline the scan has reached.
   *
   * Present only for a check that walks media and says where it has got to.
   * `ffprobe -skip_frame nokey` prints a keyframe's presentation time as it
   * finds it, which is a real measurement of a real position — unlike the
   * phase's weighted bar, which is a cost model. Absent for every check that
   * completes atomically, because inventing a percentage for a playlist parse
   * would be exactly the fabrication this file exists to avoid.
   */
  currentMediaSeconds?: number;
  totalMediaSeconds?: number;
  /** `currentMediaSeconds / totalMediaSeconds`, clamped and monotonic. */
  fraction?: number;
  /**
   * Media seconds scanned per wall-clock second.
   *
   * Deliberately not called speed: this is how fast the *verifier reads*, and
   * a page that showed it beside an encoder's speed without saying which was
   * which would invite the two to be compared.
   */
  rate?: number;
  etaSeconds?: number;
  /** When the scan last moved forward. */
  lastAdvancedAtMs?: number;
  /** True once nothing has advanced for `VERIFICATION_STALE_MS`. */
  stalled?: boolean;
}

/** One family of checks, counted. */
export interface VerificationGroupProgress {
  kind: VerificationCheckKind;
  completed: number;
  total: number;
}

/**
 * The verification stage.
 *
 * Its steps are not equal: parsing a playlist is microseconds and probing a
 * ten-gigabyte rendition demuxes the whole file. So the bar is weighted by the
 * size of what each check reads — but the weight is deliberately *not* called
 * a byte count, because nothing counts bytes as they are read.
 *
 * The distinction is the point. `ffprobe -skip_frame nokey` walks the file to
 * find its keyframes, so its cost grows with the file: measured here, thirty
 * times the bytes took roughly twenty times the marginal time, while a
 * header-only probe stayed flat. That makes file size a defensible *weight*.
 * It does not make it a measurement: ffprobe reports nothing until it exits, so
 * a check contributes its whole weight the instant it finishes and nothing
 * before. Printing that as "18.4 GB of 27.0 GB inspected" would be presenting a
 * cost model as a physical quantity.
 *
 * What is literally true, and therefore what the page shows as numbers, is the
 * counts: how many checks of each kind have finished, and which one is running.
 * The weighted fraction drives the bar, and is labelled as weighted.
 */
export interface VerificationPhaseProgress {
  totalChecks: number;
  completedChecks: number;
  /**
   * Unitless. The sum of every planned check's weight, where a check that
   * reads a file weighs that file's recorded size and one that parses a
   * playlist weighs a nominal constant. Never bytes, never displayed as bytes.
   */
  totalWeight: number;
  completedWeight: number;
  /** `completedWeight / totalWeight`. Weighted, not measured. */
  fraction: number;
  /** Counts per family of check, which are exact. */
  groups: VerificationGroupProgress[];
  current?: VerificationStepProgress;
  /** Counts of what the package declares, for the structural summary. */
  declared?: {
    videoRenditions: number;
    audioRenditions: number;
    subtitleRenditions: number;
  };
  /** True once the whole package has passed. */
  ok?: boolean;
}

/**
 * The planning stage, step by step.
 *
 * Usually seconds, but not always: the rate probe encodes sample windows of
 * the title at several rates and scores each rung against the source with
 * VMAF, which is minutes of real work that used to show as nothing at all.
 * Its search length depends on what it finds, so it is reported as work done
 * (encodes, measurements) rather than as a fraction of an unknown total.
 */
export interface PlanningPhaseProgress {
  /**
   * `encoder` is a wait, not work: the plan is made and another title holds
   * the worker's encoder (`encoderSlot.ts`). The fields keep what the steps
   * before it reported.
   */
  step: "timeline" | "rates" | "encoder";
  /** Epoch boundaries whose frame times are being read. */
  boundaryCount: number;
  /** Epochs in the plan, once it is made. */
  epochCount?: number;
  rateProbe?: {
    /** Sample encodes finished, each one a pass over every window. */
    encodes: number;
    /** VMAF measurements finished, one per rung, rate and window. */
    measurements: number;
    /** The rung being scored, when one is. */
    qualityHeight?: number;
    /** True when a decision from an earlier attempt was reused. */
    reused?: boolean;
  };
}

/** One subtitle track, as the page names it. */
export interface SubtitleTrackProgress {
  /** Rendition id, e.g. `subtitle-3`. Never a path. */
  id: string;
  /** Inside the source, or a file beside it. */
  origin: "embedded" | "sidecar";
  language?: string;
  title?: string;
  isForced?: boolean;
  /**
   * `skipped` is a sidecar that could not be converted: the title is published
   * without it, and the page says so rather than the track quietly vanishing.
   */
  state: "waiting" | "running" | "complete" | "skipped";
  /** Size of the WebVTT written, once it is. */
  bytes?: number;
}

/**
 * The subtitle stage.
 *
 * One FFmpeg run per track, one after another, and an embedded track has to
 * read the whole source to find its cues, so a title with eight embedded
 * subtitle tracks reads its source eight times. Counted in tracks because that
 * is the unit of work: each run reports nothing until it has finished.
 */
export interface SubtitlePhaseProgress {
  tracks: SubtitleTrackProgress[];
  completedTracks: number;
  /** Finished (complete or skipped) over all tracks. */
  fraction: number;
  currentId?: string;
  /** When the running track started, so the page can say how long it has run. */
  currentStartedAtMs?: number;
  writtenBytes: number;
}

export type PublishStepId =
  | "video"
  | "audio"
  | "subtitles"
  | "master-playlist"
  | "manifest"
  | "build-record"
  | "swap"
  | "verify"
  | "cleanup";

export interface PublishStepProgress {
  id: PublishStepId;
  state: "waiting" | "running" | "complete";
  /** Bytes this step moves, when it moves any. */
  bytes?: number;
  /** Bytes durably copied for this step, including bytes from a prior attempt. */
  completedBytes?: number;
}

/**
 * The publication stage.
 *
 * Usually seconds — renames within one filesystem — but not always: when the
 * work directory is on a different volume from the library, publishing copies
 * the whole package. Weighted by bytes for that reason.
 */
export interface PublishPhaseProgress {
  steps: PublishStepProgress[];
  totalBytes: number;
  completedBytes: number;
  fraction: number;
  currentId?: PublishStepId;
  /** Measured destination-write throughput while a file is being copied. */
  bytesPerSecond?: number;
  etaSeconds?: number;
}

/**
 * One assembly sample, built from what has been written so far.
 *
 * Pure, and exported, because this is the arithmetic the whole phase is judged
 * on: a ladder whose 2160p rung is seventy times the bytes of its 144p rung
 * must not report itself by counting rungs. Keeping it out of the assembler's
 * closure is what lets the real Gladiator proportions be asserted directly.
 *
 * The denominator is `expected` and only `expected`. It is computed once from
 * the checkpoint manifests before the first byte moves and passed in unchanged
 * on every call, so the phase's total cannot drift while the phase runs.
 */
export function buildAssemblyProgress({
  renditionIds,
  expected,
  written,
  finished,
  currentId,
  bytesPerSecond,
}: {
  renditionIds: readonly string[];
  expected: ReadonlyMap<string, number>;
  written: ReadonlyMap<string, number>;
  finished: ReadonlySet<string>;
  currentId?: string | undefined;
  bytesPerSecond?: number | undefined;
}): AssemblyPhaseProgress {
  const renditions: AssemblyRenditionProgress[] = renditionIds.map((id) => ({
    id,
    expectedBytes: expected.get(id) ?? 0,
    writtenBytes: written.get(id) ?? 0,
    state: finished.has(id)
      ? ("complete" as const)
      : id === currentId
        ? ("running" as const)
        : ("waiting" as const),
  }));
  const totalBytes = renditions.reduce(
    (sum, entry) => sum + entry.expectedBytes,
    0,
  );
  const completedBytes = renditions.reduce(
    (sum, entry) => sum + entry.writtenBytes,
    0,
  );
  /*
   * The phase is over when every rendition has been written and closed, which
   * is a stronger statement than the byte ratio can make: the ratio lands a
   * few kilobytes short because the expectation counted an initialisation
   * segment per epoch. Reconciled here, once, rather than by adjusting the
   * denominator throughout.
   */
  const allComplete =
    renditions.length > 0 &&
    renditions.every((entry) => entry.state === "complete");
  const etaSeconds = etaFromRate(
    Math.max(0, totalBytes - completedBytes),
    bytesPerSecond,
  );
  return {
    totalBytes,
    completedBytes,
    fraction: allComplete ? 1 : safeFraction(completedBytes, totalBytes),
    renditions,
    ...(currentId === undefined ? {} : { currentId }),
    ...(bytesPerSecond === undefined ? {} : { bytesPerSecond }),
    ...(etaSeconds === undefined ? {} : { etaSeconds }),
  };
}

/**
 * Throughput over a rolling window, for a figure that neither lurches nor
 * lies.
 *
 * A rate taken from one write is meaningless — a 64 KiB chunk that took a
 * microsecond reads as gigabytes a second — and a rate taken from the whole run
 * cannot notice that the disk has stopped. So samples inside a window are kept
 * and the rate is the span across it: bytes gained divided by time passed.
 *
 * Nothing is reported until the window holds a real span, which is what keeps
 * `Infinity`, `NaN` and a first-second ETA of nine hours off the page.
 */
export interface ByteRateEstimator {
  /** Records a cumulative byte total observed at `atMs`. */
  sample(totalBytes: number, atMs: number): void;
  /** Bytes per second across the window, or undefined while it is too thin. */
  rate(atMs?: number): number | undefined;
}

/** Samples older than this are dropped. */
export const RATE_WINDOW_MS = 10_000;
/** The window must span at least this before a rate is reported. */
export const RATE_MINIMUM_SPAN_MS = 1_500;
/**
 * A window with no fresh sample is a stall, not a rate.
 *
 * Assembly reports on every write, so silence for this long means the writes
 * stopped — a paused job, a vanished volume — and the honest answer is that
 * there is no current throughput rather than the one from before it stopped.
 */
export const RATE_STALE_MS = 5_000;

/**
 * How long a media scan may report nothing before the page stops claiming a rate.
 *
 * Longer than the assembly threshold on purpose. An assembler reports on every
 * write; a keyframe scan reports once per random-access frame, which on a
 * two-second segment grid is once every couple of seconds of media and, on a
 * rendition being read slowly, can legitimately be several seconds apart in
 * wall time. This is a display decision only — it withdraws a rate and an
 * estimate, and never stops or blames anything.
 */
export const VERIFICATION_STALE_MS = 15_000;

export function createByteRateEstimator({
  windowMs = RATE_WINDOW_MS,
  minimumSpanMs = RATE_MINIMUM_SPAN_MS,
  staleMs = RATE_STALE_MS,
}: {
  windowMs?: number;
  minimumSpanMs?: number;
  staleMs?: number;
} = {}): ByteRateEstimator {
  const samples: Array<{ bytes: number; atMs: number }> = [];

  return {
    sample(totalBytes, atMs) {
      if (!Number.isFinite(totalBytes) || !Number.isFinite(atMs)) return;
      const last = samples[samples.length - 1];
      // Time only moves forward here, and so do cumulative bytes. A sample that
      // goes backwards is a restarted phase, which is a new window.
      if (last && (atMs < last.atMs || totalBytes < last.bytes)) {
        samples.length = 0;
      }
      samples.push({ bytes: totalBytes, atMs });
      while (samples.length > 1 && atMs - samples[0]!.atMs > windowMs) {
        samples.shift();
      }
    },
    rate(atMs) {
      const first = samples[0];
      const last = samples[samples.length - 1];
      if (!first || !last || first === last) return undefined;
      if (atMs !== undefined && atMs - last.atMs > staleMs) return undefined;
      const spanMs = last.atMs - first.atMs;
      if (spanMs < minimumSpanMs) return undefined;
      const gained = last.bytes - first.bytes;
      if (gained <= 0) return undefined;
      const rate = (gained * 1000) / spanMs;
      return Number.isFinite(rate) && rate > 0 ? rate : undefined;
    },
  };
}

/**
 * Seconds left, from a measured rate and bytes that genuinely remain.
 *
 * Returns undefined rather than a number whenever the inputs cannot support
 * one: no rate yet, a stalled writer, nothing left to write.
 */
export function etaFromRate(
  remainingBytes: number,
  bytesPerSecond: number | undefined,
): number | undefined {
  if (!bytesPerSecond || bytesPerSecond <= 0) return undefined;
  if (!Number.isFinite(remainingBytes) || remainingBytes <= 0) return undefined;
  const eta = remainingBytes / bytesPerSecond;
  return Number.isFinite(eta) ? Math.round(eta) : undefined;
}

/** A fraction that is always a real number in [0,1]. */
export function safeFraction(completed: number, total: number): number {
  if (!Number.isFinite(completed) || !Number.isFinite(total) || total <= 0) {
    return 0;
  }
  return Math.min(1, Math.max(0, completed / total));
}
