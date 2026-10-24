/**
 * The resumable encoder.
 *
 * One loop, one rule: for every epoch in the plan, either a valid checkpoint
 * already exists and is reused, or one FFmpeg process reads the source once,
 * decodes it once, and produces every rung of the ladder for that half hour.
 * Nothing else in the system decides what to encode — the CLI and the server
 * job both come through here, so "why did it re-encode that" has one answer.
 *
 * The loop is written so that every exit is safe. An abort, a pause that turns
 * into a stop, a vanished volume and a failed validation all leave the
 * completed epochs untouched and at most the running one to redo.
 */

import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { PauseController } from "../../processing/pauseController";
import type { RenditionHdrSignal, RenditionVideoEncoder } from "../../encoding";
import { parseFfmpegProgressFields } from "../../progress";
import { createOutputMeter } from "../../outputMeter";
import {
  adaptiveOutputDirectories,
  buildAdaptivePackageFfmpegArgs,
  type AdaptiveVideoOutput,
} from "../encoding";
import {
  ADAPTIVE_MASTER_PLAYLIST,
  ADAPTIVE_MEDIA_FILE,
  ADAPTIVE_PLAYLIST_FILE,
  ADAPTIVE_VIDEO_DIRECTORY,
  videoRenditionId,
} from "../profile";
import {
  beginPartialEpoch,
  completedEpochPath,
  readEpochManifest,
  reconcileCheckpoints,
  type CheckpointIdentity,
  type EpochCheckpointManifest,
  type EpochRenditionRecord,
  type ReconciliationOutcome,
} from "./checkpoints";
import {
  EPOCH_CHECKPOINT_SCHEMA_VERSION,
  NETWORK_STALL_RETRY_BACKOFF_MS,
  SOURCE_IO_RETRY_BACKOFF_MS,
} from "./policy";
import { isUncNetworkPath } from "../../processing/storageIdentity";
import { protectedSecondsAfter, type EpochPlan } from "./plan";
import { timestampSeconds } from "./sourceTimeline";
import {
  readRenditionJoinKey,
  validateEpoch,
  type EpochRenditionExpectation,
} from "./validateEpoch";
import {
  classifyFailure,
  looksLikeHardStorageFailure,
  looksLikeOutOfSpace,
  looksLikeStorageLoss,
  MediaProgressTimeoutError,
  SourceReadError,
  StorageInterruptedError,
  type ClassifiedFailure,
} from "./failure";
import {
  assessSourceRead,
  createStderrTail,
  evidenceIndictsSource,
  readSourceIoEvidence,
  type SourceIoEvidence,
  type SourceProbeOutcome,
  type SourceReadVerdict,
} from "./sourceIo";
import { stallThresholds, type StallThresholds } from "./stallPolicy";
import {
  EncoderAbortedError,
  type EncoderWatchdog,
} from "../../processExecution";
import { describeJoinMismatch, joinKeysMatch } from "./fragments";
import { generatePlaceholderEpoch } from "./placeholder";
import {
  DEFAULT_SOURCE_DAMAGE_POLICY,
  describeInterval,
  type SourceDamagePolicy,
  type SourceDamageRecord,
} from "./salvage";

/** FFmpeg reports four times a second, which is what makes the page feel live. */
export const EPOCH_STATS_PERIOD_SECONDS = 0.25;

export type EpochBuildEvent =
  | {
      type: "reconciled";
      outcome: ReconciliationOutcome;
      epochCount: number;
      protectedSeconds: number;
    }
  | {
      type: "epoch-reused";
      index: number;
      epochCount: number;
      protectedSeconds: number;
    }
  | {
      type: "epoch-start";
      index: number;
      epochCount: number;
      startSeconds: number;
      endSeconds: number;
      attempt: number;
    }
  | {
      type: "epoch-progress";
      index: number;
      epochCount: number;
      startSeconds: number;
      endSeconds: number;
      /** FFmpeg's own out_time for this epoch. */
      epochProcessedSeconds: number;
      protectedSeconds: number;
      sourceDurationSeconds: number;
      fps?: number;
      speed?: number;
      writtenBytes?: number;
      /**
       * True while the media being produced is the synthetic replacement for an
       * unreadable interval rather than the film. The work is real and the bar
       * should move for it; what it is must not be hidden.
       */
      placeholder?: boolean;
    }
  | {
      type: "epoch-complete";
      index: number;
      epochCount: number;
      protectedSeconds: number;
      bytes: number;
      elapsedMs: number;
    }
  | {
      type: "epoch-invalid";
      index: number;
      reason: string;
    }
  | {
      /**
       * The source failed to read and the volume was still there afterwards.
       *
       * Emitted before each re-read so the operator sees the escalation happen
       * rather than a job that silently sits still for twenty seconds.
       */
      type: "source-io-retry";
      index: number;
      attempt: number;
      maxAttempts: number;
      /** Whether the source window could be read back between attempts. */
      sourceReadable?: boolean;
      /** What the evidence so far concludes, which decides the read budget. */
      verdict?: SourceReadVerdict;
      /** One clause naming what decided it, for the job history. */
      because?: string;
      detail: string;
    }
  | {
      /**
       * Media time stopped and the encoder is being terminated.
       *
       * Emitted at the moment the decision is taken, before the signals go out,
       * so a page that has been saying "waiting for source data" can say what
       * is being done about it rather than going quiet for the length of a
       * kernel recovery and then announcing a diagnosis.
       */
      type: "source-stall-abort";
      index: number;
      startSeconds: number;
      endSeconds: number;
      /** Media seconds the encoder had produced when it stopped producing. */
      lastMediaSeconds: number;
      stalledForMs: number;
    }
  | {
      /**
       * The read budget is spent and the volume proved healthy every time.
       *
       * Emitted whichever policy is in force, because the diagnosis is the same
       * either way and only what happens next differs. A page showing "waiting
       * for source data" can say "source read problem" from here.
       */
      type: "source-damage-confirmed";
      index: number;
      damage: SourceDamageRecord;
      policy: SourceDamagePolicy;
    }
  | {
      /** Synthetic media of the planned length is being produced. */
      type: "epoch-salvage-start";
      index: number;
      epochCount: number;
      startSeconds: number;
      endSeconds: number;
      expectedDurationSeconds: number;
    }
  | {
      /** The replacement passed the same validation a real epoch must. */
      type: "epoch-salvaged";
      index: number;
      epochCount: number;
      protectedSeconds: number;
      bytes: number;
      damage: SourceDamageRecord;
    };

/**
 * The stretch of source a readability probe is asked about.
 *
 * Absolute source seconds, both of them, because the question is about the file
 * rather than about the epoch: `fromSeconds` is where media time stopped —
 * everything before it has just been read successfully — and `toSeconds` is how
 * far the epoch still needed to get.
 */
export interface SourceProbeWindow {
  epochIndex: number;
  fromSeconds: number;
  toSeconds: number;
}

export interface EpochEncodeRunner {
  (
    command: string,
    args: string[],
    options: {
      signal?: AbortSignal;
      logPath: string;
      onProgress?: (
        progress: ReturnType<typeof parseFfmpegProgressFields>,
      ) => void;
      /**
       * FFmpeg's own words, as it says them.
       *
       * The engine keeps a bounded tail of these and reads it whatever the
       * process returned. A demuxer that gave up on an unreadable region can
       * still let the muxer finalise cleanly, so an exit code of zero is not
       * evidence that the source was read — and without this the short epoch
       * that follows would be blamed on the encoder and retried into the same
       * bad sector.
       */
      onStderr?: (chunk: string) => void;
      /**
       * Ends the run when media time stops advancing.
       *
       * The encoder is the only layer that can act on a stall: everything above
       * it is blocked awaiting this call. A page noticing that progress has
       * stopped is a label; this is the thing that stops FFmpeg walking from
       * one unreadable block to the next for minutes on end.
       */
      watchdog?: EncoderWatchdog;
      pauseController?: PauseController;
    },
  ): Promise<void>;
}

export interface RunEpochBuildInput {
  identity: CheckpointIdentity;
  checkpointRoot: string;
  plan: EpochPlan;
  sourcePath: string;
  videoOutputs: readonly AdaptiveVideoOutput[];
  encoder: RenditionVideoEncoder;
  codecFamily: "h264" | "hevc";
  hdr?: RenditionHdrSignal;
  hdrState: string;
  /** Ceiling frame rate the GOP is sized from. */
  frameRate?: number;
  segmentSeconds: number;
  preset: string;
  softwareThreads?: number;
  filterComplexThreads?: number;
  ffmpegPath: string;
  ffprobePath: string;
  logPath: string;
  runEncoder: EpochEncodeRunner;
  signal?: AbortSignal;
  pauseController?: PauseController;
  /** Answers "is the storage this job needs there right now?" on failure. */
  storageAvailable?: () => boolean | Promise<boolean>;
  missingRoots?: () => readonly string[];
  /**
   * Production's durable circuit breaker. When present, the first hard fault
   * is persisted before this function can launch a retry or diagnostic probe.
   * Offline tooling may omit it and retain its explicitly requested salvage
   * workflow.
   */
  onHardStorageFault?: (failure: ClassifiedFailure) => Promise<void>;
  onEvent?: (event: EpochBuildEvent) => void;
  /** Attempts allowed per epoch before the build gives up. */
  attemptsPerEpoch?: number;
  /**
   * Waits between re-reading a source that returned an I/O error.
   *
   * Each one has to outlast a watchdog poll, because the whole point of the
   * wait is to give a genuinely vanished volume time to be noticed as vanished.
   * Overridable so tests do not have to spend the real half minute.
   */
  sourceIoBackoffMs?: readonly number[];
  /**
   * Whether the source is read over the network.
   *
   * Defaults to whether `sourcePath` is a UNC share, which is how the Windows
   * hosts see their Drive mount. It decides what a stall that a probe cannot
   * answer means: damage on a local disk, a slow fetch on a network one.
   */
  sourceOnNetworkVolume?: boolean;
  /** Waits between re-reads of a quiet network source. Tests shorten it. */
  networkStallBackoffMs?: readonly number[];
  /**
   * A bounded readability check of the stretch the encoder could not get past.
   *
   * Called between I/O retries, and decisive: with no input-side line in
   * stderr this is the only thing that can tell a damaged platter from a
   * wedged encoder. Which is why it is handed a *window* rather than an epoch
   * index — asking whether the epoch's start could be read answers the wrong
   * question, since the encoder had already read it, and on the real damaged
   * title that mistake diagnosed unreadable media as an encoder fault.
   */
  verifySourceReadable?: (
    window: SourceProbeWindow,
  ) => Promise<SourceProbeOutcome>;
  /**
   * What to do when a source read fails persistently.
   *
   * `fail` — the default, and the behaviour that existed before salvage did —
   * ends the build and keeps every checkpoint. `replace-epoch` substitutes
   * synthetic media of exactly the planned length and carries on, which trades
   * content for a title that can be published.
   */
  sourceDamagePolicy?: SourceDamagePolicy;
  /**
   * How long media time may stand still before an attempt is ended.
   *
   * Read from the deployment's policy by default. Tests shorten it so a
   * watchdog can be provoked in milliseconds rather than half a minute.
   */
  stalls?: StallThresholds;
  /** Injected by failure-injection tests to stop between epochs. */
  beforeEpoch?: (index: number) => void | Promise<void>;
}

export interface EpochBuildResult {
  manifests: EpochCheckpointManifest[];
  reconciliation: ReconciliationOutcome;
  /** Epochs this run actually encoded, as against reused. */
  encodedEpochs: number[];
  /** Bytes this run wrote into checkpoints. */
  bytesWritten: number;
  /** Codec strings FFmpeg derived from the real bitstream, by rendition id. */
  videoCodecStrings: Map<string, string>;
  /**
   * Intervals replaced because they could not be read, in plan order.
   *
   * Empty for every ordinary build. When it is not empty the title is not a
   * clean encode, and every layer above this — audio, subtitles, the job
   * record, the page — is expected to say so rather than let it pass.
   */
  salvaged: SourceDamageRecord[];
}

function expectationsFor(
  videoOutputs: readonly AdaptiveVideoOutput[],
  codecFamily: "h264" | "hevc",
  hdrState: string,
): EpochRenditionExpectation[] {
  return videoOutputs.map((output) => {
    const id = videoRenditionId(output.qualityHeight);
    return {
      id,
      qualityHeight: output.qualityHeight,
      width: output.width,
      height: output.height,
      codecFamily,
      hdr: hdrState,
      directory: `${ADAPTIVE_VIDEO_DIRECTORY}/${id}`,
      mediaFile: ADAPTIVE_MEDIA_FILE,
      playlistFile: ADAPTIVE_PLAYLIST_FILE,
    };
  });
}

/**
 * Codec strings, read from the master FFmpeg wrote beside the epoch.
 *
 * They are derived from the real bitstream and are the one part of a master
 * playlist that cannot be guessed safely, so they are harvested rather than
 * constructed. Every epoch produces the same ones because every epoch is
 * encoded with the same settings — which the identical initialisation segments
 * independently prove — so the first available epoch answers for all of them.
 */
async function harvestCodecStrings(
  epochDirectory: string,
  renditionIds: readonly string[],
): Promise<Map<string, string>> {
  const { parseCodecsFromGeneratedMaster } = await import("../playlist");
  const text = await readFile(
    path.join(epochDirectory, ADAPTIVE_MASTER_PLAYLIST),
    "utf8",
  ).catch(() => null);
  const found = new Map<string, string>();
  if (text === null) return found;
  const byPath = parseCodecsFromGeneratedMaster(text);
  for (const id of renditionIds) {
    const codecs = byPath.get(
      `${ADAPTIVE_VIDEO_DIRECTORY}/${id}/${ADAPTIVE_PLAYLIST_FILE}`,
    );
    const video = codecs?.split(",")[0]?.trim();
    if (video) found.set(id, video);
  }
  return found;
}

/**
 * The manifest's description of what one epoch actually contains.
 *
 * Every figure is measured from the packaged bytes rather than requested: the
 * expectation says what was asked for, the measurement says what was produced,
 * and a checkpoint records the second. Shared by real epochs and replacements
 * so a replacement cannot be described more loosely than the film around it.
 */
function renditionRecordsFrom({
  measurements,
  expectations,
  codecFamily,
  hdrState,
  videoCodecStrings,
}: {
  measurements: Awaited<ReturnType<typeof validateEpoch>>["measurements"];
  expectations: readonly EpochRenditionExpectation[];
  codecFamily: "h264" | "hevc";
  hdrState: string;
  videoCodecStrings: ReadonlyMap<string, string>;
}): EpochRenditionRecord[] {
  return measurements.map((measurement) => {
    const expectation = expectations.find(
      (entry) => entry.id === measurement.id,
    )!;
    return {
      id: measurement.id,
      qualityHeight: expectation.qualityHeight,
      width: measurement.probe.width,
      height: measurement.probe.height,
      codec: codecFamily,
      ...(videoCodecStrings.get(measurement.id)
        ? { codecString: videoCodecStrings.get(measurement.id)! }
        : {}),
      pixelFormat: measurement.probe.pixelFormat,
      hdr: hdrState,
      ...(measurement.probe.colorPrimaries
        ? { colorPrimaries: measurement.probe.colorPrimaries }
        : {}),
      ...(measurement.probe.colorTransfer
        ? { colorTransfer: measurement.probe.colorTransfer }
        : {}),
      ...(measurement.probe.colorSpace
        ? { colorSpace: measurement.probe.colorSpace }
        : {}),
      frameRate: measurement.probe.frameRate,
      mediaPath: `${expectation.directory}/${expectation.mediaFile}`,
      playlistPath: `${expectation.directory}/${expectation.playlistFile}`,
      fileSizeBytes: measurement.fileSizeBytes,
      segmentCount: measurement.segmentCount,
      measuredDurationSeconds: measurement.measuredDurationSeconds,
      mediaTimescale: measurement.mediaTimescale,
      initDigest: measurement.initDigest,
      joinKey: measurement.joinKey,
    };
  });
}

/**
 * Thrown when FFmpeg exits cleanly and its own log says the source did not read.
 *
 * A private signal, not an outcome: it exists only to bring a clean exit into
 * the same failure path as a crash, so there is exactly one place that decides
 * what an unreadable source means.
 */
class SourceStderrError extends Error {
  readonly evidence: SourceIoEvidence;
  constructor(evidence: SourceIoEvidence) {
    super(
      `FFmpeg reported a source read failure: ${
        evidence.lines.join(" | ") || "Input/output error"
      }`,
    );
    this.name = "SourceStderrError";
    this.evidence = evidence;
  }
}

/** Re-reads a replacement checkpoint's own record of why it exists. */
function damageFromManifest(
  manifest: EpochCheckpointManifest,
  epochIndex: number,
): SourceDamageRecord {
  const salvage = manifest.salvage!;
  return {
    type: "source-damage",
    epochIndex,
    sourceStartSeconds: salvage.sourceStartSeconds,
    sourceEndSeconds: salvage.sourceEndSeconds,
    expectedDurationSeconds: salvage.expectedDurationSeconds,
    ...(salvage.lastConfirmedMediaSeconds === undefined
      ? {}
      : { lastConfirmedMediaSeconds: salvage.lastConfirmedMediaSeconds }),
    ...(salvage.ffmpegByteOffset === undefined
      ? {}
      : { ffmpegByteOffset: salvage.ffmpegByteOffset }),
    sourceRetryCount: salvage.sourceRetryCount,
    evidence: salvage.evidence,
    detectedAt: salvage.createdAt,
  };
}

/**
 * The rate a finished epoch was actually encoded at.
 *
 * Taken from the packaged bytes rather than from the plan, because it is the
 * muxer's timescale that decides whether a replacement can be joined to it, and
 * the muxer follows the encoder's real rate. The ladder's small rungs are
 * halved deliberately, so the source rate is the largest of them.
 */
function encodedFrameRateOf(
  manifest: EpochCheckpointManifest | undefined,
): number | undefined {
  if (!manifest || manifest.renditions.length === 0) return undefined;
  const rate = Math.max(
    ...manifest.renditions.map((rendition) => rendition.frameRate),
  );
  return Number.isFinite(rate) && rate > 0 ? rate : undefined;
}

export async function runEpochBuild({
  identity,
  checkpointRoot,
  plan,
  sourcePath,
  videoOutputs,
  encoder,
  codecFamily,
  hdr,
  hdrState,
  frameRate,
  segmentSeconds,
  preset,
  softwareThreads,
  filterComplexThreads,
  ffmpegPath,
  ffprobePath,
  logPath,
  runEncoder,
  signal,
  pauseController,
  storageAvailable,
  missingRoots,
  onHardStorageFault,
  onEvent,
  attemptsPerEpoch = 2,
  sourceIoBackoffMs = SOURCE_IO_RETRY_BACKOFF_MS,
  sourceOnNetworkVolume = isUncNetworkPath(sourcePath),
  networkStallBackoffMs = NETWORK_STALL_RETRY_BACKOFF_MS,
  verifySourceReadable,
  sourceDamagePolicy = DEFAULT_SOURCE_DAMAGE_POLICY,
  stalls = stallThresholds(),
  beforeEpoch,
}: RunEpochBuildInput): Promise<EpochBuildResult> {
  const expectations = expectationsFor(videoOutputs, codecFamily, hdrState);
  const renditionIds = expectations.map((entry) => entry.id);

  const reconciliation = await reconcileCheckpoints({
    root: checkpointRoot,
    plan,
    identity,
    requiredRenditionIds: renditionIds,
  });
  for (const entry of reconciliation.invalidated) {
    onEvent?.({
      type: "epoch-invalid",
      index: entry.index,
      reason: entry.reason,
    });
  }
  onEvent?.({
    type: "reconciled",
    outcome: reconciliation,
    epochCount: plan.epochs.length,
    protectedSeconds: contiguousProtectedSeconds(plan, reconciliation.complete),
  });

  const completed = new Set(reconciliation.complete);
  const manifests: EpochCheckpointManifest[] = [];
  const encodedEpochs: number[] = [];
  const salvaged: SourceDamageRecord[] = [];
  let bytesWritten = 0;
  let videoCodecStrings = new Map<string, string>();

  // Subtitle/audio-only updates have no video epochs to encode or assemble.
  if (videoOutputs.length === 0) {
    return {
      manifests,
      reconciliation,
      encodedEpochs,
      bytesWritten,
      videoCodecStrings,
      salvaged,
    };
  }

  /**
   * One frame of the source, which is the closest two rungs can ever land.
   *
   * Demanding better would fail every real encode; allowing more would let a
   * genuinely misaligned ladder through.
   */
  const alignmentToleranceSeconds =
    (frameRate && frameRate > 0 ? 1 / frameRate : 1 / 30) + 0.002;

  for (const epoch of plan.epochs) {
    if (signal?.aborted) throw abortError();

    if (completed.has(epoch.index)) {
      const manifest = await readEpochManifest(checkpointRoot, epoch.index);
      if (manifest) {
        manifests.push(manifest);
        /*
         * A replacement that was made on an earlier attempt is still a
         * replacement. Re-announcing it here is what keeps a resumed job's
         * audio, subtitles and final warning describing the same holes as the
         * run that discovered them — without which a restart would quietly
         * publish a salvaged title as a clean one.
         */
        if (manifest.salvage) {
          salvaged.push(damageFromManifest(manifest, epoch.index));
        }
        if (videoCodecStrings.size === 0) {
          videoCodecStrings = await harvestCodecStrings(
            completedEpochPath(checkpointRoot, epoch.index),
            renditionIds,
          );
        }
        onEvent?.({
          type: "epoch-reused",
          index: epoch.index,
          epochCount: plan.epochs.length,
          protectedSeconds: protectedSecondsAfter(plan, manifests.length),
        });
        continue;
      }
      // The manifest vanished between reconciliation and now. Encode it.
      completed.delete(epoch.index);
    }

    await beforeEpoch?.(epoch.index);
    if (signal?.aborted) throw abortError();

    const startSeconds = timestampSeconds(epoch.start);
    const endSeconds = epoch.end
      ? timestampSeconds(epoch.end)
      : plan.sourceDurationSeconds;

    let lastValidationError: string | undefined;
    let promoted: EpochCheckpointManifest | undefined;
    /**
     * Media time the encoder genuinely produced before it stopped.
     *
     * The one figure that says how much of a damaged interval was readable. It
     * is recorded rather than acted on today — whole-epoch replacement does not
     * need it — and it is what a finer salvage would begin from.
     */
    let lastConfirmedMediaSeconds = 0;
    /** Set when the read budget is spent and the interval is to be replaced. */
    let pendingSalvage: SourceDamageRecord | undefined;
    /*
     * Reads of this epoch that ended in an I/O error while the volume kept
     * answering. Counted per epoch and given its own budget, so a bad region of
     * the source cannot be spent by a validation retry and a failing encoder
     * cannot spend the read budget.
     */
    let sourceIoAttempts = 0;
    const sourceIoMaxAttempts = sourceIoBackoffMs.length + 1;
    /** Waits already spent on a quiet network source, for the next one's length. */
    let networkStallWaits = 0;
    /** How long media time had been standing still when the watchdog fired. */
    let stalledForMs = 0;
    /** What the evidence concluded, once there was enough of it to conclude. */
    let sourceVerdict: SourceReadVerdict | undefined;

    for (
      let attempt = 1;
      attempt <= attemptsPerEpoch + sourceIoAttempts;
      attempt += 1
    ) {
      if (signal?.aborted) throw abortError();
      const startedAt = Date.now();
      onEvent?.({
        type: "epoch-start",
        index: epoch.index,
        epochCount: plan.epochs.length,
        startSeconds,
        endSeconds,
        attempt,
      });

      const handle = await beginPartialEpoch({
        root: checkpointRoot,
        index: epoch.index,
        // Re-proven at the rename, so an epoch encoded after the scratch volume
        // vanished cannot become a durable checkpoint on another disk.
        ...(beforeEpoch
          ? { beforePromote: () => beforeEpoch(epoch.index) }
          : {}),
      });

      try {
        /*
         * These are the directories FFmpeg is about to write fragments into.
         * `beginPartialEpoch` has just proven the filesystem; proving it again
         * here costs a `stat` and closes the window between the two.
         */
        await beforeEpoch?.(epoch.index);
        for (const directory of adaptiveOutputDirectories({
          videoOutputs: [...videoOutputs],
          audioOutputs: [],
        })) {
          await mkdir(path.join(handle.directory, ...directory.split("/")), {
            recursive: true,
          });
        }

        const args = buildAdaptivePackageFfmpegArgs({
          inputPath: sourcePath,
          // FFmpeg joins `%v` templates with forward slashes on every platform.
          outputRoot: handle.directory.split(path.sep).join("/"),
          videoOutputs: [...videoOutputs],
          audioOutputs: [],
          encoder,
          ...(hdr ? { hdr } : {}),
          ...(frameRate === undefined ? {} : { frameRate }),
          segmentSeconds,
          preset,
          ...(softwareThreads === undefined ? {} : { softwareThreads }),
          ...(filterComplexThreads === undefined
            ? {}
            : { filterComplexThreads }),
          ...(epoch.seekSeconds > 0 ? { startSeconds: epoch.seekSeconds } : {}),
          ...(epoch.durationSeconds === undefined
            ? {}
            : { durationSeconds: epoch.durationSeconds }),
          statsPeriodSeconds: EPOCH_STATS_PERIOD_SECONDS,
        });

        const protectedSeconds = protectedSecondsAfter(plan, epoch.index);
        /*
         * FFmpeg reports `total_size=N/A` for HLS, so the only honest byte
         * figure is the one measured from the files being written. Sampled from
         * the partial epoch rather than the finished package, because that is
         * where this run's bytes are actually landing.
         */
        const meter = createOutputMeter(
          videoOutputs.map((output) =>
            path.join(
              handle.directory,
              ADAPTIVE_VIDEO_DIRECTORY,
              videoRenditionId(output.qualityHeight),
              ADAPTIVE_MEDIA_FILE,
            ),
          ),
        );
        /*
         * FFmpeg's own account of this attempt, kept whatever it exits with.
         *
         * This is the difference between diagnosing a bad platter and blaming
         * the encoder for it. A demuxer that gives up on an unreadable region
         * can still close its outputs and report `progress=end`, so the process
         * resolving proves only that the process ended.
         */
        const stderr = createStderrTail();
        try {
          await runEncoder(ffmpegPath, args, {
            ...(signal ? { signal } : {}),
            ...(pauseController ? { pauseController } : {}),
            logPath,
            onStderr: (chunk) => stderr.append(chunk),
            ...(onEvent
              ? {
                  onProgress: (progress) => {
                    meter.sample();
                    lastConfirmedMediaSeconds = Math.max(
                      lastConfirmedMediaSeconds,
                      progress.processedSeconds,
                    );
                    const epochBytes = meter.latest();
                    onEvent({
                      type: "epoch-progress",
                      index: epoch.index,
                      epochCount: plan.epochs.length,
                      startSeconds,
                      endSeconds,
                      epochProcessedSeconds: progress.processedSeconds,
                      protectedSeconds,
                      sourceDurationSeconds: plan.sourceDurationSeconds,
                      ...(progress.fps === undefined
                        ? {}
                        : { fps: progress.fps }),
                      ...(progress.speed === undefined
                        ? {}
                        : { speed: progress.speed }),
                      ...(epochBytes === undefined
                        ? {}
                        : { writtenBytes: epochBytes }),
                    });
                  },
                }
              : {}),
            /*
             * The thing that actually stops a wedged encoder. Everything above
             * this call is blocked awaiting it, so the watchdog has to live
             * inside the runner: a page noticing that progress has stopped is a
             * label, and this is a termination.
             */
            watchdog: {
              hardStallMs: stalls.hardStallMs,
              startupStallMs: stalls.startupStallMs,
              terminationGraceMs: stalls.terminationGraceMs,
              onStall: (detail) => {
                onEvent?.({
                  type: "source-stall-abort",
                  index: epoch.index,
                  startSeconds,
                  endSeconds,
                  lastMediaSeconds: detail.lastMediaSeconds,
                  stalledForMs: detail.stalledForMs,
                });
              },
            },
          });
          /*
           * The encoder returned, and that is not the same as the source having
           * been read. This check is deliberately here — before the duration
           * validator — because the validator's answer to a half-read epoch is
           * "the encoder produced the wrong length", which is true, useless,
           * and spends the retry budget re-reading a sector that will never
           * come back.
           */
          const evidence = readSourceIoEvidence(stderr.value());
          if (evidenceIndictsSource(evidence)) {
            throw new SourceStderrError(evidence);
          }
        } catch (error) {
          /*
           * A watchdog termination is *this* layer's decision, so it must not
           * be read as the job being cancelled — the abort signal may well have
           * fired for an unrelated reason in the same tick. A caller abort, by
           * contrast, outranks everything: a person pressing Cancel is never
           * source damage.
           */
          const watchdogAborted =
            error instanceof EncoderAbortedError &&
            error.reason === "media-watchdog";
          if (!watchdogAborted && signal?.aborted) throw abortError();
          if (
            error instanceof EncoderAbortedError &&
            error.reason === "caller"
          ) {
            throw abortError();
          }

          const message =
            error instanceof Error ? error.message : String(error);
          /*
           * Evidence from a thrown attempt is read the same way. Where the
           * throw already carried it — the clean-exit case above — it is used
           * as it is rather than re-parsed out of a message.
           */
          const evidence: SourceIoEvidence =
            error instanceof SourceStderrError
              ? error.evidence
              : readSourceIoEvidence(`${stderr.value()}\n${message}`);
          if (watchdogAborted && error instanceof EncoderAbortedError) {
            lastConfirmedMediaSeconds = Math.max(
              lastConfirmedMediaSeconds,
              error.lastMediaSeconds,
            );
            stalledForMs = error.stalledForMs;
          }
          /*
           * A stalled encoder is a failed read by definition — it stopped
           * because nothing came back — even though its message carries no
           * errno at all. Without this a watchdog termination would fall
           * through as a generic encoder fault, which is exactly how a
           * confirmed source failure escaped to the task queue and had the
           * whole job requeued into the damaged region.
           */
          const readFailed =
            watchdogAborted ||
            looksLikeStorageLoss(message) ||
            evidenceIndictsSource(evidence);

          /*
           * The volume is asked first, and asked directly rather than inferred
           * from the message. If it is gone the answer is settled.
           */
          let available = storageAvailable ? await storageAvailable() : true;

          if (
            onHardStorageFault &&
            (!available ||
              looksLikeHardStorageFailure(message) ||
              evidenceIndictsSource(evidence))
          ) {
            const hardFailure = classifyFailure({
              message,
              storageAvailable: available,
              ...(missingRoots ? { missingRoots: missingRoots() } : {}),
              evidence,
            });
            await onHardStorageFault(hardFailure);
            /*
             * Stop inside the same catch, before backoff, ffprobe, retry, or
             * placeholder generation. The job runner will park this as a
             * persisted quarantine; this exception only carries the already
             * recorded classification back up the stack.
             */
            throw new StorageInterruptedError(hardFailure);
          }

          /*
           * An I/O error while the volume still answers is the ambiguous case,
           * and it is ambiguous only because the storage watchdog polls: the
           * drive may already be gone and the check simply has not run yet. So
           * the storage is asked again after a wait long enough to outlast a
           * poll, and the error is counted against the *source* only once the
           * volume has proved it is still there and still itself.
           */
          let ioRechecksExhausted = false;
          if (available && readFailed && !looksLikeOutOfSpace(message)) {
            const backoff = sourceIoBackoffMs[sourceIoAttempts];
            if (backoff !== undefined && backoff > 0) {
              await delay(backoff, signal);
              if (signal?.aborted) throw abortError();
              available = storageAvailable ? await storageAvailable() : true;
            }
            if (available) {
              sourceIoAttempts += 1;
              /*
               * The probe is now decisive evidence rather than a note, so it is
               * taken on every attempt — and it is bounded, because on a
               * failing platter the question can hang as thoroughly as the
               * encode it is asking about.
               *
               * It is asked about the stretch that was *not* read. Media time
               * is reported against the epoch's own output, so where it froze
               * becomes a position in the file only once the seek is added
               * back; everything before that point has demonstrably just been
               * read, and probing it would prove nothing but that.
               */
              const probe = await verifySourceReadable?.({
                epochIndex: epoch.index,
                fromSeconds: startSeconds + lastConfirmedMediaSeconds,
                toSeconds: endSeconds,
              }).catch(() => ({ verdict: "unreadable" as const }));
              /*
               * A person cancelling during the probe outranks its answer. The
               * check above happened before a read that can take its whole
               * wall clock, and salvaging a job someone has just stopped would
               * replace film nobody asked to have replaced.
               */
              if (signal?.aborted) throw abortError();
              const assessment = assessSourceRead({
                evidence,
                watchdogAborted,
                ...(probe ? { probe } : {}),
                transientBudget: sourceIoMaxAttempts,
                networkVolume: sourceOnNetworkVolume,
                networkStallBudget: networkStallBackoffMs.length + 1,
              });
              sourceVerdict = assessment.verdict;
              ioRechecksExhausted =
                sourceIoAttempts >= assessment.fullReadBudget;
              onEvent?.({
                type: "source-io-retry",
                index: epoch.index,
                attempt: sourceIoAttempts,
                maxAttempts: Math.max(
                  sourceIoAttempts,
                  assessment.fullReadBudget,
                ),
                ...(probe === undefined
                  ? {}
                  : { sourceReadable: probe.verdict === "readable" }),
                verdict: assessment.verdict,
                because: assessment.because,
                detail: message.slice(-500),
              });
              if (!ioRechecksExhausted) {
                await handle.discard();
                /*
                 * A quiet network mount is given real time before the next
                 * read. The backoff above is sized to outlast a watchdog poll,
                 * which tells a vanished disk from a present one; a cloud fetch
                 * that has stalled needs minutes, not seconds, to come back.
                 */
                if (assessment.verdict === "network-stall") {
                  const wait = networkStallBackoffMs[networkStallWaits] ?? 0;
                  networkStallWaits += 1;
                  if (wait > 0) await delay(wait, signal);
                  if (signal?.aborted) throw abortError();
                }
                continue;
              }
            }
          }

          const failure = classifyFailure({
            message,
            storageAvailable: available,
            ...(missingRoots ? { missingRoots: missingRoots() } : {}),
            ioRechecksExhausted,
            evidence,
            ...(sourceVerdict === undefined ? {} : { sourceVerdict }),
          });
          if (
            onHardStorageFault &&
            (failure.kind === "source-io" ||
              failure.kind === "storage-device-lost" ||
              failure.kind === "storage-io")
          ) {
            await onHardStorageFault(failure);
            throw new StorageInterruptedError(failure);
          }
          if (
            failure.kind === "media-progress-timeout" ||
            failure.kind === "network-read-stall"
          ) {
            /*
             * Ended, and not salvaged. The source reads; something in the
             * encode stopped producing. Replacing the interval with black would
             * be destroying film to work around a bug, and every checkpoint
             * before it stays exactly where it is. A network stall ends the
             * same way: the media is blameless and the queue tries it later.
             */
            throw new MediaProgressTimeoutError(failure, epoch.index, {
              lastMediaSeconds: lastConfirmedMediaSeconds,
              stalledForMs,
            });
          }
          if (failure.kind === "source-io") {
            const damage: SourceDamageRecord = {
              type: "source-damage",
              epochIndex: epoch.index,
              sourceStartSeconds: startSeconds,
              sourceEndSeconds: endSeconds,
              expectedDurationSeconds: epoch.expectedDurationSeconds,
              ...(lastConfirmedMediaSeconds > 0
                ? { lastConfirmedMediaSeconds }
                : {}),
              ...(evidence.byteOffset === undefined
                ? {}
                : { ffmpegByteOffset: evidence.byteOffset }),
              sourceRetryCount: sourceIoAttempts,
              evidence: evidence.lines,
              detectedAt: new Date().toISOString(),
            };
            onEvent?.({
              type: "source-damage-confirmed",
              index: epoch.index,
              damage,
              policy: sourceDamagePolicy,
            });
            if (sourceDamagePolicy !== "replace-epoch") {
              throw new SourceReadError(
                failure,
                epoch.index,
                sourceIoAttempts,
                damage,
              );
            }
            await handle.discard();
            pendingSalvage = damage;
            break;
          }
          if (
            failure.kind === "storage-unavailable" ||
            failure.kind === "storage-device-lost" ||
            failure.kind === "storage-io" ||
            failure.kind === "storage-soft-fault" ||
            failure.kind === "out-of-space"
          ) {
            /*
             * Not a defect in the job. The partial workspace goes, every
             * completed epoch stays, and the caller decides whether to wait for
             * the volume or to report a shortfall.
             */
            throw new StorageInterruptedError(failure);
          }
          throw new Error(`${failure.summary} ${failure.detail}`.trim());
        }

        if (signal?.aborted) throw abortError();

        const validation = await validateEpoch({
          epochDirectory: handle.directory,
          expectations,
          expectedDurationSeconds: epoch.expectedDurationSeconds,
          alignmentToleranceSeconds,
          ffprobePath,
          ...(signal ? { signal } : {}),
        });

        if (!validation.ok) {
          lastValidationError = validation.issues
            .map(
              (issue) => `${issue.rendition}/${issue.stage}: ${issue.message}`,
            )
            .slice(0, 4)
            .join("; ");
          onEvent?.({
            type: "epoch-invalid",
            index: epoch.index,
            reason: lastValidationError,
          });
          await handle.discard();
          continue;
        }

        if (videoCodecStrings.size === 0) {
          videoCodecStrings = await harvestCodecStrings(
            handle.directory,
            renditionIds,
          );
        }

        const renditions = renditionRecordsFrom({
          measurements: validation.measurements,
          expectations,
          codecFamily,
          hdrState,
          videoCodecStrings,
        });

        const totalBytes = renditions.reduce(
          (sum, entry) => sum + entry.fileSizeBytes,
          0,
        );
        const manifest: EpochCheckpointManifest = {
          schemaVersion: EPOCH_CHECKPOINT_SCHEMA_VERSION,
          mediaId: identity.mediaId,
          sourceFingerprint: identity.sourceFingerprint,
          adaptiveProfileVersion: identity.adaptiveProfileVersion,
          timelinePolicyVersion: identity.timelinePolicyVersion,
          epochIndex: epoch.index,
          startSeconds,
          endSeconds: epoch.end ? timestampSeconds(epoch.end) : null,
          expectedDurationSeconds: epoch.expectedDurationSeconds,
          actualDurationSeconds: Math.max(
            ...validation.measurements.map(
              (measurement) => measurement.measuredDurationSeconds,
            ),
          ),
          encoder,
          renditions,
          totalBytes,
          checks: validation.checks,
          completedAt: new Date().toISOString(),
        };

        await handle.promote(manifest);
        promoted = manifest;
        bytesWritten += totalBytes;
        encodedEpochs.push(epoch.index);
        manifests.push(manifest);
        onEvent?.({
          type: "epoch-complete",
          index: epoch.index,
          epochCount: plan.epochs.length,
          protectedSeconds: protectedSecondsAfter(plan, manifests.length),
          bytes: totalBytes,
          elapsedMs: Date.now() - startedAt,
        });
        break;
      } catch (error) {
        await handle.discard();
        throw error;
      } finally {
        handle.release();
      }
    }

    if (!promoted && pendingSalvage) {
      const damage = pendingSalvage;
      onEvent?.({
        type: "epoch-salvage-start",
        index: epoch.index,
        epochCount: plan.epochs.length,
        startSeconds,
        endSeconds,
        expectedDurationSeconds: epoch.expectedDurationSeconds,
      });

      /*
       * A finished epoch of real film, if this build has one. It is the
       * standard the replacement has to meet: same media timescale, same
       * initialisation segment, same encoded rate. Without one — the first
       * epoch of a title being the damaged one — the replacement sets the
       * standard instead, and the epochs that follow are measured against it
       * by the assembler exactly as they always are.
       */
      const reference =
        [...manifests].reverse().find((entry) => !entry.salvage) ??
        manifests[manifests.length - 1];
      const referenceFrameRate = encodedFrameRateOf(reference) ?? frameRate;

      const startedAt = Date.now();
      const handle = await beginPartialEpoch({
        root: checkpointRoot,
        index: epoch.index,
        // Re-proven at the rename, so an epoch encoded after the scratch volume
        // vanished cannot become a durable checkpoint on another disk.
        ...(beforeEpoch
          ? { beforePromote: () => beforeEpoch(epoch.index) }
          : {}),
      });
      try {
        const protectedSeconds = protectedSecondsAfter(plan, epoch.index);
        const meter = createOutputMeter(
          videoOutputs.map((output) =>
            path.join(
              handle.directory,
              ADAPTIVE_VIDEO_DIRECTORY,
              videoRenditionId(output.qualityHeight),
              ADAPTIVE_MEDIA_FILE,
            ),
          ),
        );
        await generatePlaceholderEpoch({
          directory: handle.directory,
          videoOutputs,
          encoder,
          ...(hdr ? { hdr } : {}),
          ...(referenceFrameRate === undefined
            ? {}
            : { frameRate: referenceFrameRate }),
          segmentSeconds,
          preset,
          ...(softwareThreads === undefined ? {} : { softwareThreads }),
          ...(filterComplexThreads === undefined
            ? {}
            : { filterComplexThreads }),
          /*
           * The planned length, to the microsecond, and never the length of
           * the partial output the damaged read produced. Substituting the
           * short one would collapse the source timeline and move everything
           * after this interval earlier.
           */
          durationSeconds: epoch.expectedDurationSeconds,
          ffmpegPath,
          logPath,
          runEncoder,
          ...(signal ? { signal } : {}),
          ...(pauseController ? { pauseController } : {}),
          statsPeriodSeconds: EPOCH_STATS_PERIOD_SECONDS,
          watchdog: {
            hardStallMs: stalls.hardStallMs,
            startupStallMs: stalls.startupStallMs,
            terminationGraceMs: stalls.terminationGraceMs,
          },
          ...(onEvent
            ? {
                onProgress: (progress) => {
                  meter.sample();
                  const epochBytes = meter.latest();
                  onEvent({
                    type: "epoch-progress",
                    index: epoch.index,
                    epochCount: plan.epochs.length,
                    startSeconds,
                    endSeconds,
                    epochProcessedSeconds: progress.processedSeconds,
                    protectedSeconds,
                    sourceDurationSeconds: plan.sourceDurationSeconds,
                    ...(progress.fps === undefined
                      ? {}
                      : { fps: progress.fps }),
                    ...(progress.speed === undefined
                      ? {}
                      : { speed: progress.speed }),
                    ...(epochBytes === undefined
                      ? {}
                      : { writtenBytes: epochBytes }),
                    placeholder: true,
                  });
                },
              }
            : {}),
        });

        if (signal?.aborted) throw abortError();

        /*
         * The same validation, not a relaxed one. A replacement that cannot
         * prove its own duration, dimensions, codec, colour and alignment is
         * worse than no replacement: it would be joined to the title and
         * nothing downstream would ever look at it again.
         */
        const validation = await validateEpoch({
          epochDirectory: handle.directory,
          expectations,
          expectedDurationSeconds: epoch.expectedDurationSeconds,
          alignmentToleranceSeconds,
          ffprobePath,
          ...(signal ? { signal } : {}),
        });
        if (!validation.ok) {
          await handle.discard();
          throw new SourceReadError(
            {
              kind: "source-io",
              summary: `The source could not be read for ${describeInterval({ startSeconds, endSeconds })} and the replacement media did not pass validation, so nothing was substituted.`,
              detail: validation.issues
                .map(
                  (issue) =>
                    `${issue.rendition}/${issue.stage}: ${issue.message}`,
                )
                .slice(0, 4)
                .join("; "),
            },
            epoch.index,
            damage.sourceRetryCount,
            damage,
          );
        }

        /*
         * Joinability, checked before the replacement is allowed to become
         * durable rather than discovered by the assembler hours later. Epochs
         * are concatenated under a single initialisation segment, so a
         * replacement whose initialisation differs cannot be joined at all —
         * and finding that out at assembly would mean losing the whole title
         * to a problem that was detectable here.
         */
        if (reference) {
          const referenceDirectory = completedEpochPath(
            checkpointRoot,
            reference.epochIndex,
          );
          for (const measurement of validation.measurements) {
            const record = reference.renditions.find(
              (entry) => entry.id === measurement.id,
            );
            if (!record) continue;
            /*
             * Compared on what joining actually requires, not on the whole
             * initialisation segment. Assembly writes the first epoch's
             * initialisation and copies every other epoch's fragments in after
             * it, so a replacement is joinable when its fragments decode under
             * that initialisation — the decoder configuration, the sample
             * entry and the timescale.
             *
             * A byte comparison was stricter than the truth, and on a real HDR
             * title stricter in a way that made salvage impossible: the film's
             * epochs carry HDR10 mastering-display and content-light boxes
             * that a colour generator has nothing to put in, so a replacement
             * with a byte-identical `hvcC` was refused. Those boxes live in
             * the initialisation assembly keeps, so the published title still
             * carries the film's own values.
             */
            const referenceKey =
              record.joinKey ??
              (await readRenditionJoinKey(referenceDirectory, record).catch(
                () => undefined,
              ));
            if (!referenceKey) continue;
            if (!joinKeysMatch(measurement.joinKey, referenceKey)) {
              await handle.discard();
              throw new SourceReadError(
                {
                  kind: "source-io",
                  summary: `The source could not be read for ${describeInterval({ startSeconds, endSeconds })}, and replacement media for ${measurement.id} could not be made joinable to the epochs around it, so nothing was substituted.`,
                  detail: `Replacement ${measurement.id} wrote ${
                    describeJoinMismatch(measurement.joinKey, referenceKey) ??
                    "media that does not match"
                  }, against epoch ${reference.epochIndex}.`,
                },
                epoch.index,
                damage.sourceRetryCount,
                damage,
              );
            }
          }
        }

        if (videoCodecStrings.size === 0) {
          videoCodecStrings = await harvestCodecStrings(
            handle.directory,
            renditionIds,
          );
        }

        const renditions = renditionRecordsFrom({
          measurements: validation.measurements,
          expectations,
          codecFamily,
          hdrState,
          videoCodecStrings,
        });
        const totalBytes = renditions.reduce(
          (sum, entry) => sum + entry.fileSizeBytes,
          0,
        );
        const manifest: EpochCheckpointManifest = {
          schemaVersion: EPOCH_CHECKPOINT_SCHEMA_VERSION,
          mediaId: identity.mediaId,
          sourceFingerprint: identity.sourceFingerprint,
          adaptiveProfileVersion: identity.adaptiveProfileVersion,
          timelinePolicyVersion: identity.timelinePolicyVersion,
          epochIndex: epoch.index,
          startSeconds,
          endSeconds: epoch.end ? timestampSeconds(epoch.end) : null,
          expectedDurationSeconds: epoch.expectedDurationSeconds,
          actualDurationSeconds: Math.max(
            ...validation.measurements.map(
              (measurement) => measurement.measuredDurationSeconds,
            ),
          ),
          encoder,
          renditions,
          totalBytes,
          checks: [
            ...validation.checks,
            "replacement media for an unreadable source interval",
          ],
          salvage: {
            kind: "source-damage",
            reason:
              "This interval of the source could not be read, so it holds black picture of exactly the planned length.",
            sourceStartSeconds: startSeconds,
            sourceEndSeconds: endSeconds,
            expectedDurationSeconds: epoch.expectedDurationSeconds,
            ...(damage.lastConfirmedMediaSeconds === undefined
              ? {}
              : {
                  lastConfirmedMediaSeconds: damage.lastConfirmedMediaSeconds,
                }),
            ...(damage.ffmpegByteOffset === undefined
              ? {}
              : { ffmpegByteOffset: damage.ffmpegByteOffset }),
            sourceRetryCount: damage.sourceRetryCount,
            evidence: damage.evidence,
            createdAt: damage.detectedAt,
          },
          completedAt: new Date().toISOString(),
        };

        await handle.promote(manifest);
        promoted = manifest;
        bytesWritten += totalBytes;
        encodedEpochs.push(epoch.index);
        manifests.push(manifest);
        salvaged.push(damage);
        onEvent?.({
          type: "epoch-salvaged",
          index: epoch.index,
          epochCount: plan.epochs.length,
          protectedSeconds: protectedSecondsAfter(plan, manifests.length),
          bytes: totalBytes,
          damage,
        });
        onEvent?.({
          type: "epoch-complete",
          index: epoch.index,
          epochCount: plan.epochs.length,
          protectedSeconds: protectedSecondsAfter(plan, manifests.length),
          bytes: totalBytes,
          elapsedMs: Date.now() - startedAt,
        });
      } catch (error) {
        await handle.discard();
        throw error;
      } finally {
        handle.release();
      }
    }

    if (!promoted) {
      throw new Error(
        `Epoch ${epoch.index} (${formatClock(startSeconds)}–${formatClock(endSeconds)}) failed validation and was not kept: ${lastValidationError ?? "no reason recorded"}`,
      );
    }
  }

  return {
    manifests,
    reconciliation,
    encodedEpochs,
    bytesWritten,
    videoCodecStrings,
    salvaged,
  };
}

/**
 * Protected media time given a set of completed epochs.
 *
 * Only a *contiguous* run from the beginning counts. Epoch 7 being complete
 * while epoch 3 is missing protects nothing: the title cannot be assembled up
 * to seven, and reporting it as protected would tell an operator their work is
 * safe further along than it is.
 */
export function contiguousProtectedSeconds(
  plan: EpochPlan,
  completed: readonly number[],
): number {
  const present = new Set(completed);
  let count = 0;
  while (count < plan.epochs.length && present.has(count)) count += 1;
  return protectedSecondsAfter(plan, count);
}

/** A wait that gives up the moment the job is cancelled. */
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function abortError(): Error {
  const error = new Error("The epoch build was cancelled.");
  error.name = "AbortError";
  return error;
}

export function formatClock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "--:--:--";
  const whole = Math.floor(seconds);
  const hours = String(Math.floor(whole / 3600)).padStart(2, "0");
  const minutes = String(Math.floor((whole % 3600) / 60)).padStart(2, "0");
  const rest = String(whole % 60).padStart(2, "0");
  return `${hours}:${minutes}:${rest}`;
}
