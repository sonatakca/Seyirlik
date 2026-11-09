import {
  bindChildToPauseController,
  type PauseController,
} from "./processing/pauseController";
import {
  EncoderAbortedError,
  FFMPEG_GRACEFUL_STOP,
  spawnManagedProcess,
  type EncoderWatchdog,
  type ManagedProcessOutcome,
} from "./processExecution";

/*
 * Re-exported where they have always been imported from. They live in the
 * process-execution module because that is what owns a child's lifetime, and
 * because the adaptive epoch engine needs them without needing this file.
 */
export { EncoderAbortedError };
export type { EncoderWatchdog };
import { randomUUID } from "node:crypto";
import {
  appendFile,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import type {
  DriveSpace,
  RenditionAnalysisItem,
  RenditionAnalysisReport,
  RenditionPaths,
} from "./analysis";
import { getDriveSpace } from "./analysis";
import {
  buildRenditionFfmpegArgs,
  codecFamilyForEncoder,
  type RenditionCodecFamily,
  resolveVideoEncoder,
  type RenditionEncoderPreference,
  type RenditionHdrPolicy,
  type RenditionHdrSignal,
  type RenditionVideoEncoder,
} from "./encoding";
import { acquireDirectoryLock } from "./locks";
import { DEFAULT_STORAGE_SAFETY_MARGIN } from "./planning";
import {
  RENDITION_PROFILE_VERSION,
  buildRenditionRequirements,
  classifyQualityHeight,
  getDisplayDimensions,
  type RenditionRequirement,
} from "./policy";
import { probeMediaFile } from "./probe";
import {
  parseFfmpegProgressFields,
  type RenditionProgressReporter,
} from "./progress";
import { computeSourceFingerprint } from "./registry";
import {
  inspectCompletedRendition,
  validateCompletedVersion,
  RENDITION_POINTER_SCHEMA_VERSION,
  RENDITION_METADATA_SCHEMA_VERSION,
  type RenditionMetadata,
  type RenditionFileMetadata,
} from "./validation";

const MAX_LOG_BYTES = 1024 * 1024;

export type FfmpegProgress = ReturnType<typeof parseFfmpegProgressFields>;

export interface VariantValidationProbe {
  durationSeconds: number;
  width: number;
  height: number;
  videoCodec: string;
  audioCodec: string;
  audioLanguage?: string;
  frameRate?: number;
  averageBitrate?: number;
}

export interface RenditionProcessorOptions {
  ffmpegPath?: string;
  ffprobePath?: string;
  /** `auto` uses QuickSync when a usable device is present, else software. */
  encoderPreference?: RenditionEncoderPreference;
  /** Pre-resolved SDR encoder, so a batch decides once instead of probing per item. */
  videoEncoder?: RenditionVideoEncoder;
  /** Pre-resolved HDR encoder, used for PQ/HLG sources under `preserve`. */
  hdrVideoEncoder?: RenditionVideoEncoder;
  /** `preserve` keeps HDR (HEVC Main 10); `tonemap` converts to SDR H.264. */
  hdrPolicy?: RenditionHdrPolicy;
  reserveBytes: number;
  driveSpaceProvider?: () => Promise<DriveSpace>;
  runEncoder?: (
    command: string,
    args: string[],
    options: {
      signal?: AbortSignal;
      logPath: string;
      onProgress?: (progress: FfmpegProgress) => void;
    },
  ) => Promise<void>;
  /** Receives structured progress so callers can render it however they like. */
  onEvent?: RenditionProgressReporter;
  probeVariant?: (filePath: string) => Promise<VariantValidationProbe>;
  verifySourceFingerprint?: boolean;
  signal?: AbortSignal;
  dryRun?: boolean;
}

export interface RenditionProcessResult {
  mediaId: string;
  relativePath: string;
  status:
    | "ready"
    | "already-valid"
    | "failed"
    | "deferred-for-storage"
    | "interrupted"
    | "dry-run";
  error?: string;
  versionDirectory?: string;
}

function safeSourcePath(mediaRoot: string, relativePath: string): string {
  const sourcePath = path.resolve(mediaRoot, ...relativePath.split("/"));
  const normalizedRoot = path.resolve(mediaRoot);
  const comparisonRoot =
    process.platform === "win32"
      ? normalizedRoot.toLowerCase()
      : normalizedRoot;
  const comparisonSource =
    process.platform === "win32" ? sourcePath.toLowerCase() : sourcePath;
  if (
    comparisonSource === comparisonRoot ||
    !comparisonSource.startsWith(`${comparisonRoot}${path.sep}`)
  ) {
    throw new Error("Media source path escapes the configured media root.");
  }
  return sourcePath;
}

async function appendBoundedLog(logPath: string, text: string): Promise<void> {
  await mkdir(path.dirname(logPath), { recursive: true });
  await appendFile(logPath, text, "utf8");
  const logStats = await stat(logPath);
  if (logStats.size <= MAX_LOG_BYTES) return;
  const content = await readFile(logPath);
  await writeFile(logPath, content.subarray(content.length - MAX_LOG_BYTES));
}

export async function runFfmpeg(
  command: string,
  args: string[],
  {
    signal,
    logPath,
    onProgress,
    onStderr,
    pauseController,
    watchdog,
    now = Date.now,
  }: {
    signal?: AbortSignal;
    logPath: string;
    onProgress?: (progress: FfmpegProgress) => void;
    /**
     * Every line FFmpeg writes to stderr, as it writes it.
     *
     * Handed out rather than kept private because the exit code is not enough
     * to classify a failure: a demuxer that gave up on an unreadable region can
     * still let the muxer finalise and exit zero, and a caller that only sees
     * the resolved promise would go on to blame the encoder for a short output.
     * The caller keeps its own bounded tail; nothing here grows without limit.
     */
    onStderr?: (chunk: string) => void;
    /**
     * Suspends this encoder while paused. Progress is kept: the process holds
     * its memory, its output files and its position, so resuming costs nothing
     * where cancelling would cost the whole encode.
     *
     * `SIGSTOP` on POSIX, `NtSuspendProcess` on Windows — and on both the
     * controller only reports `paused` once the operating system has agreed.
     */
    pauseController?: PauseController;
    /**
     * Ends the run when media time stops advancing.
     *
     * Absent by default, because most callers here are short-lived and a
     * needless watchdog is a needless way to fail. The epoch encoder, the
     * replacement generator and the audio stage all set one: they are the runs
     * that read a source for minutes at a time, and they are the runs that a
     * failing platter can wedge indefinitely.
     */
    watchdog?: EncoderWatchdog;
    now?: () => number;
  },
): Promise<void> {
  /*
   * Media time, watched rather than the reports about it. The distinction is
   * the whole point: a report arriving says the process is alive, and only the
   * figure inside it says work is happening.
   */
  let lastMediaSeconds = 0;
  /**
   * Encoded video frames, the second measure of work. `out_time` is the least
   * advanced stream of every output, so a sparse copied subtitle track holds
   * it still while the video encodes; a frame count that moves is media being
   * produced, and an encode reporting one is not stalled.
   */
  let lastFrames = 0;
  let lastProgressAtMs = now();
  /**
   * Whether anything has been produced yet.
   *
   * Until the first report the process is allowed a much longer silence: an
   * accurate seek decodes forward from the previous keyframe and says nothing
   * until it reaches the frame the epoch actually begins on.
   */
  let started = false;
  let stallTimer: NodeJS.Timeout | undefined;
  let stallDetail:
    | { lastMediaSeconds: number; stalledForMs: number }
    | undefined;

  const managed = spawnManagedProcess({
    command,
    args,
    /*
     * This child is FFmpeg, and FFmpeg has a cooperative stop. Declaring it
     * here is what gives the child a stdin pipe and what makes cancellation on
     * Windows something other than an immediate kill.
     */
    gracefulStop: FFMPEG_GRACEFUL_STOP,
    ...(pauseController
      ? {
          /*
           * Resume before terminate, on every path that terminates.
           *
           * A suspended process cannot read the quit key, cannot act on a
           * signal, and — on Windows — cannot be reaped without being forced.
           * The queue already lifts the pause before the aborts it initiates;
           * this covers the ones it does not: the media watchdog, a wall clock,
           * an output ceiling, and a caller's `AbortSignal` arriving from
           * anywhere at all. Fire and forget by design — the escalation below
           * is not allowed to wait on a helper process, and if the resume fails
           * the forced termination still ends a suspended process.
           */
          onAbort: () => {
            void pauseController.resume().catch(() => undefined);
          },
        }
      : {}),
    ...(signal ? { signal } : {}),
    ...(watchdog?.terminationGraceMs === undefined
      ? {}
      : { terminationGraceMs: watchdog.terminationGraceMs }),
    onStderr: (chunk) => {
      onStderr?.(chunk);
      void appendBoundedLog(logPath, chunk).catch(() => undefined);
    },
    ...(onProgress
      ? {
          onStdout: (() => {
            const fields: Record<string, string> = {};
            let pending = "";
            return (chunk: string) => {
              pending += chunk;
              const lines = pending.split(/\r?\n/);
              pending = lines.pop() ?? "";
              for (const line of lines) {
                const separator = line.indexOf("=");
                if (separator <= 0) continue;
                fields[line.slice(0, separator).trim()] = line
                  .slice(separator + 1)
                  .trim();
                if (!line.startsWith("progress=")) continue;
                const progress = parseFfmpegProgressFields(fields);
                const frames = progress.frames ?? 0;
                if (
                  !started ||
                  progress.processedSeconds > lastMediaSeconds + 1e-6 ||
                  frames > lastFrames
                ) {
                  started = true;
                  lastMediaSeconds = Math.max(
                    lastMediaSeconds,
                    progress.processedSeconds,
                  );
                  lastFrames = Math.max(lastFrames, frames);
                  lastProgressAtMs = now();
                }
                onProgress(progress);
              }
            };
          })(),
        }
      : {}),
  });

  const unbindPause = pauseController
    ? bindChildToPauseController(
        {
          get pid() {
            return managed.pid;
          },
          kill: (sig: NodeJS.Signals) => {
            const pid = managed.pid;
            if (pid === undefined) return false;
            try {
              // The group, not the leaf: a paused encoder that left a helper
              // running would keep reading the very source it was suspended for.
              process.kill(-pid, sig);
            } catch {
              try {
                process.kill(pid, sig);
              } catch {
                return false;
              }
            }
            return true;
          },
        },
        pauseController,
        {
          /*
           * What this pid is believed to be, checked by the Windows helper
           * before it suspends anything. Windows recycles pids quickly, and a
           * suspend aimed at a recycled one freezes whichever process the
           * operating system handed the number to next.
           */
          imageName: path.basename(command),
          isAborting: () => managed.aborting,
        },
      )
    : undefined;

  if (watchdog) {
    /*
     * Polled rather than scheduled from each report, so a process that has
     * stopped reporting altogether — no stdout, no stderr, nothing — is caught
     * by the same clock as one that reports a frozen timeline. A quarter of the
     * threshold keeps the check cheap and the overshoot small.
     */
    const interval = Math.max(250, Math.floor(watchdog.hardStallMs / 4));
    stallTimer = setInterval(() => {
      /*
       * A paused encoder is not a stalled one. It is producing nothing because
       * it was told to, and killing it would turn a pause into a lost epoch.
       */
      if (pauseController?.paused) {
        lastProgressAtMs = now();
        return;
      }
      const stalledForMs = now() - lastProgressAtMs;
      const allowance = started
        ? watchdog.hardStallMs
        : (watchdog.startupStallMs ?? watchdog.hardStallMs);
      if (stalledForMs < allowance) return;
      if (stallDetail) return;
      stallDetail = { lastMediaSeconds, stalledForMs };
      watchdog.onStall?.(stallDetail);
      managed.abort("media-watchdog");
    }, interval);
    stallTimer.unref?.();
  }

  let outcome: ManagedProcessOutcome;
  try {
    outcome = await managed.completed;
  } finally {
    if (stallTimer) clearInterval(stallTimer);
    unbindPause?.();
  }

  /*
   * An abort outranks the exit status, always. FFmpeg killed mid-write can
   * still close its outputs and report success on the way out, and `progress=end`
   * arriving says something about the reporting pipe rather than about the
   * media — so a run that was stopped on purpose is never reported as one that
   * finished.
   */
  if (outcome.aborted) {
    const media = {
      lastMediaSeconds,
      lastProgressAtMs,
      stalledForMs: stallDetail?.stalledForMs ?? now() - lastProgressAtMs,
    };
    if (outcome.abortReason === "media-watchdog") {
      throw new EncoderAbortedError(
        `FFmpeg produced no media for ${Math.round(
          media.stalledForMs / 1000,
        )}s and was stopped at ${media.lastMediaSeconds.toFixed(3)}s.`,
        outcome,
        media,
      );
    }
    throw new EncoderAbortedError("FFmpeg was cancelled.", outcome, media);
  }

  if (outcome.exitCode === 0) return;
  throw new Error(
    `FFmpeg failed with exit code ${
      outcome.exitCode ??
      (outcome.signal ? `signal ${outcome.signal}` : "unknown")
    }: ${outcome.stderrTail}`,
  );
}

async function defaultProbeVariant(
  filePath: string,
  ffprobePath?: string,
): Promise<VariantValidationProbe> {
  const probe = await probeMediaFile(filePath, ffprobePath);
  return {
    durationSeconds: probe.durationSeconds,
    width: probe.video.width,
    height: probe.video.height,
    videoCodec: probe.video.codec,
    audioCodec: probe.audioTracks[0]?.codec ?? "missing",
    audioLanguage: probe.audioTracks[0]?.language,
    frameRate: probe.video.frameRate,
    averageBitrate: probe.overallBitrate,
  };
}

function validateVariantProbe(
  sourceDuration: number,
  expectedWidth: number,
  expectedHeight: number,
  probe: VariantValidationProbe,
  expectedAudioLanguage?: string,
  expectedVideoCodec: RenditionCodecFamily = "h264",
): void {
  if (probe.width !== expectedWidth || probe.height !== expectedHeight) {
    throw new Error(
      `Validated rendition dimensions ${probe.width}x${probe.height} do not match ${expectedWidth}x${expectedHeight}.`,
    );
  }
  if (probe.videoCodec.toLowerCase() !== expectedVideoCodec) {
    throw new Error(
      `Validated rendition video codec is ${probe.videoCodec}, not ${expectedVideoCodec.toUpperCase()}.`,
    );
  }
  if (probe.audioCodec.toLowerCase() !== "aac") {
    throw new Error(
      `Validated rendition audio codec is ${probe.audioCodec}, not AAC.`,
    );
  }
  if (
    expectedAudioLanguage &&
    (probe.audioLanguage ?? "und").toLowerCase() !==
      expectedAudioLanguage.toLowerCase()
  ) {
    throw new Error("Validated rendition audio language metadata changed.");
  }
  const tolerance = Math.max(2, sourceDuration * 0.02);
  if (Math.abs(probe.durationSeconds - sourceDuration) > tolerance) {
    throw new Error(
      "Validated rendition duration differs from the source beyond tolerance.",
    );
  }
}

async function writeCurrentPointer(
  mediaRoot: string,
  versionDirectory: string,
  sourceFingerprint: string,
): Promise<void> {
  const pointerPath = path.join(mediaRoot, "current.json");
  const temporaryPath = `${pointerPath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(
    temporaryPath,
    `${JSON.stringify(
      {
        schemaVersion: RENDITION_POINTER_SCHEMA_VERSION,
        versionDirectory,
        sourceFingerprint,
        profileVersion: RENDITION_PROFILE_VERSION,
      },
      null,
      2,
    )}\n`,
    { encoding: "utf8", flag: "wx" },
  );
  try {
    await rename(temporaryPath, pointerPath);
  } catch (error) {
    if (process.platform !== "win32") {
      await rm(temporaryPath, { force: true });
      throw error;
    }
    const previousPath = `${pointerPath}.${randomUUID()}.previous`;
    try {
      await rename(pointerPath, previousPath);
      await rename(temporaryPath, pointerPath);
      await rm(previousPath, { force: true });
    } catch (replacementError) {
      await rename(previousPath, pointerPath).catch(() => undefined);
      await rm(temporaryPath, { force: true });
      throw replacementError;
    }
  }
}

export async function processRenditionItem(
  item: RenditionAnalysisItem,
  paths: RenditionPaths,
  {
    ffmpegPath = process.env.FFMPEG_PATH ??
      process.env.SEYIRLIK_FFMPEG_PATH ??
      "ffmpeg",
    ffprobePath,
    reserveBytes,
    driveSpaceProvider = () => getDriveSpace(paths.mediaRoot),
    runEncoder = runFfmpeg,
    probeVariant = (playlistPath) =>
      defaultProbeVariant(playlistPath, ffprobePath),
    verifySourceFingerprint = true,
    encoderPreference = "auto",
    videoEncoder,
    hdrVideoEncoder,
    hdrPolicy = "preserve",
    onEvent,
    signal,
    dryRun = false,
  }: RenditionProcessorOptions,
): Promise<RenditionProcessResult> {
  if (!item.probe || item.jobs.length === 0) {
    return {
      mediaId: item.mediaId,
      relativePath: item.relativePath,
      status:
        item.status === "deferred-for-storage"
          ? "deferred-for-storage"
          : "already-valid",
    };
  }
  if (signal?.aborted) {
    return {
      mediaId: item.mediaId,
      relativePath: item.relativePath,
      status: "interrupted",
    };
  }
  if (dryRun) {
    return {
      mediaId: item.mediaId,
      relativePath: item.relativePath,
      status: "dry-run",
    };
  }

  const lock = await acquireDirectoryLock(
    path.join(paths.stateRoot, "locks", `${item.mediaId}.lock`),
    `rendition:${item.mediaId}`,
  );
  try {
    const completed = await inspectCompletedRendition({
      mediaRoot: path.join(paths.renditionRoot, item.mediaId),
      mediaId: item.mediaId,
      sourceFingerprint: item.sourceFingerprint,
      profileVersion: RENDITION_PROFILE_VERSION,
    });
    if (
      completed.status === "ready" &&
      item.jobs.every((job) =>
        completed.metadata?.files.some(
          (file) => file.qualityHeight === job.qualityHeight,
        ),
      )
    ) {
      return {
        mediaId: item.mediaId,
        relativePath: item.relativePath,
        status: "already-valid",
      };
    }

    const sourcePath = safeSourcePath(paths.mediaRoot, item.relativePath);
    if (verifySourceFingerprint) {
      const sourceStats = await stat(sourcePath);
      const currentFingerprint = await computeSourceFingerprint(
        sourcePath,
        sourceStats,
      );
      if (currentFingerprint !== item.sourceFingerprint) {
        throw new Error(
          "Source changed after analysis; run analysis again before processing.",
        );
      }
    }

    const drive = await driveSpaceProvider();
    const estimatedJobBytes = item.jobs.reduce(
      (total, job) => total + job.estimatedBytes,
      0,
    );
    const conservativeJobBytes = Math.ceil(
      estimatedJobBytes * (1 + DEFAULT_STORAGE_SAFETY_MARGIN),
    );
    if (drive.freeBytes - conservativeJobBytes < reserveBytes) {
      return {
        mediaId: item.mediaId,
        relativePath: item.relativePath,
        status: "deferred-for-storage",
        error: "Free-space check would breach the configured reserve.",
      };
    }

    const versionDirectory = `${RENDITION_PROFILE_VERSION}-${item.sourceFingerprint.slice(0, 16)}`;
    const mediaRoot = path.join(paths.renditionRoot, item.mediaId);
    const finalVersionRoot = path.join(mediaRoot, versionDirectory);
    try {
      await validateCompletedVersion({
        versionRoot: finalVersionRoot,
        mediaId: item.mediaId,
        sourceFingerprint: item.sourceFingerprint,
        profileVersion: RENDITION_PROFILE_VERSION,
      });
      await mkdir(mediaRoot, { recursive: true });
      await writeCurrentPointer(
        mediaRoot,
        versionDirectory,
        item.sourceFingerprint,
      );
      return {
        mediaId: item.mediaId,
        relativePath: item.relativePath,
        status: "already-valid",
        versionDirectory,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        try {
          const finalStats = await stat(finalVersionRoot);
          if (finalStats.isDirectory()) {
            throw new Error(
              "A deterministic completed-version directory exists but is invalid; validate and explicitly clean stale generated output before retrying.",
            );
          }
        } catch (statError) {
          if ((statError as NodeJS.ErrnoException).code !== "ENOENT")
            throw statError;
        }
      }
    }

    // The work directory is unique per run. A previous run whose FFmpeg was
    // orphaned must never be able to write into this one: that is exactly how a
    // stale encode overwrote validated output after its metadata was written.
    const workVersionRoot = path.join(
      paths.workRoot,
      item.mediaId,
      `${versionDirectory}.${process.pid}-${randomUUID().slice(0, 8)}.partial`,
    );
    const logPath = path.join(paths.logsRoot, `${item.mediaId}.log`);
    await mkdir(workVersionRoot, { recursive: true });
    const requirementsByQuality = new Map(
      buildRenditionRequirements(item.probe.video).map((requirement) => [
        requirement.qualityHeight,
        requirement,
      ]),
    );
    // Reused files from an earlier run must be checked against the codec this
    // source is meant to produce, or an HDR title would keep stale SDR output.
    const expectedCodecFamily: RenditionCodecFamily =
      item.probe.video.isHdr && hdrPolicy === "preserve" ? "hevc" : "h264";
    const files: RenditionFileMetadata[] = [];
    const sourceAudioTrack =
      item.probe.audioTracks.find((track) => track.isDefault) ??
      item.probe.audioTracks[0];
    if (!sourceAudioTrack) {
      throw new Error("Source does not contain the required audio stream.");
    }

    const plannedJobs = [...item.jobs].sort(
      (left, right) => left.qualityHeight - right.qualityHeight,
    );
    const pending: Array<{
      requirement: RenditionRequirement;
      finalFileName: string;
      finalFilePath: string;
      partialFilePath: string;
      estimatedBytes: number;
    }> = [];

    // Renditions promoted by an earlier run are reused, so cancelling and
    // resuming never repeats completed work. Only what is still missing goes
    // into the single encode pass below.
    for (const job of plannedJobs) {
      const requirement = requirementsByQuality.get(job.qualityHeight);
      if (!requirement)
        throw new Error(
          `No rendition requirement exists for ${job.qualityHeight}p.`,
        );
      const finalFileName = `${job.qualityHeight}p.mp4`;
      const finalFilePath = path.join(workVersionRoot, finalFileName);
      const partialFilePath = path.join(
        workVersionRoot,
        `${job.qualityHeight}p.partial.mp4`,
      );

      try {
        const finalStats = await stat(finalFilePath);
        if (!finalStats.isFile() || finalStats.size <= 0) {
          throw new Error(
            "Existing complete rendition file is missing or empty.",
          );
        }
        const existingProbe = await probeVariant(finalFilePath);
        validateVariantProbe(
          item.probe.durationSeconds,
          requirement.width,
          requirement.height,
          existingProbe,
          sourceAudioTrack.language,
          expectedCodecFamily,
        );
        files.push({
          qualityHeight: requirement.qualityHeight,
          width: requirement.width,
          height: requirement.height,
          bitrate: existingProbe.averageBitrate,
          fileSize: finalStats.size,
          videoCodec: "h264",
          audioCodec: "aac",
          container: "mp4",
          frameRate: existingProbe.frameRate,
          file: finalFileName,
          sourceAudioStreamIndex: sourceAudioTrack.streamIndex,
          audioLanguage: sourceAudioTrack.language,
        });
        onEvent?.({
          type: "quality-ready",
          mediaId: item.mediaId,
          qualityHeight: requirement.qualityHeight,
          width: requirement.width,
          height: requirement.height,
          fileSize: finalStats.size,
          reused: true,
        });
      } catch {
        await rm(finalFilePath, { force: true });
        await rm(partialFilePath, { force: true });
        pending.push({
          requirement,
          finalFileName,
          finalFilePath,
          partialFilePath,
          estimatedBytes: job.estimatedBytes,
        });
      }
    }

    if (pending.length > 0) {
      if (signal?.aborted) {
        return {
          mediaId: item.mediaId,
          relativePath: item.relativePath,
          status: "interrupted",
        };
      }

      // One decode feeds every remaining rendition, so free space is checked
      // once for the whole set rather than per file.
      const currentDrive = await driveSpaceProvider();
      const conservativePendingBytes = Math.ceil(
        pending.reduce((total, entry) => total + entry.estimatedBytes, 0) *
          (1 + DEFAULT_STORAGE_SAFETY_MARGIN),
      );
      if (currentDrive.freeBytes - conservativePendingBytes < reserveBytes) {
        return {
          mediaId: item.mediaId,
          relativePath: item.relativePath,
          status: "deferred-for-storage",
          error:
            "Free-space check before encoding would breach the configured reserve.",
        };
      }

      // An HDR master keeps its grade, which forces HEVC Main 10 because no
      // browser decodes 10-bit H.264. Everything else stays on H.264.
      const preserveHdr = item.probe.video.isHdr && hdrPolicy === "preserve";
      const hdr: RenditionHdrSignal | undefined = preserveHdr
        ? {
            colorPrimaries: item.probe.video.colorPrimaries ?? "bt2020",
            colorTransfer: item.probe.video.colorTransfer ?? "smpte2084",
            colorSpace: item.probe.video.colorSpace ?? "bt2020nc",
          }
        : undefined;
      const tonemapHdr = item.probe.video.isHdr && !preserveHdr;
      const encoder = preserveHdr
        ? (hdrVideoEncoder ??
          (await resolveVideoEncoder(
            encoderPreference,
            ffmpegPath,
            "hevc",
            true,
            signal,
          )))
        : (videoEncoder ??
          (await resolveVideoEncoder(
            encoderPreference,
            ffmpegPath,
            "h264",
            false,
            signal,
          )));
      onEvent?.({
        type: "encode-start",
        mediaId: item.mediaId,
        qualities: pending.map((entry) => entry.requirement.qualityHeight),
        encoder,
        hdr: preserveHdr,
        tonemapHdr,
        durationSeconds: item.probe.durationSeconds,
      });
      const args = buildRenditionFfmpegArgs({
        inputPath: sourcePath,
        outputs: pending.map((entry) => ({
          qualityHeight: entry.requirement.qualityHeight,
          width: entry.requirement.width,
          height: entry.requirement.height,
          outputPath: entry.partialFilePath,
        })),
        audioStreamIndex: sourceAudioTrack.streamIndex,
        audioLanguage: sourceAudioTrack.language,
        encoder,
        hdr,
        tonemapHdr,
      });

      try {
        await runEncoder(ffmpegPath, args, {
          signal,
          logPath,
          onProgress: onEvent
            ? (progress) =>
                onEvent({
                  type: "encode-progress",
                  mediaId: item.mediaId,
                  durationSeconds: item.probe?.durationSeconds ?? 0,
                  ...progress,
                })
            : undefined,
        });
      } catch (error) {
        for (const entry of pending) {
          await rm(entry.partialFilePath, { force: true });
        }
        throw error;
      }

      for (const entry of pending) {
        const partialStats = await stat(entry.partialFilePath);
        if (!partialStats.isFile() || partialStats.size <= 0) {
          throw new Error(
            `FFmpeg did not produce a non-empty ${entry.requirement.qualityHeight}p MP4 file.`,
          );
        }
        const variantProbe = await probeVariant(entry.partialFilePath);
        validateVariantProbe(
          item.probe.durationSeconds,
          entry.requirement.width,
          entry.requirement.height,
          variantProbe,
          sourceAudioTrack.language,
          codecFamilyForEncoder(encoder),
        );
        await rename(entry.partialFilePath, entry.finalFilePath);
        const finalStats = await stat(entry.finalFilePath);
        files.push({
          qualityHeight: entry.requirement.qualityHeight,
          width: entry.requirement.width,
          height: entry.requirement.height,
          bitrate: variantProbe.averageBitrate,
          fileSize: finalStats.size,
          videoCodec: codecFamilyForEncoder(encoder),
          audioCodec: "aac",
          container: "mp4",
          frameRate: variantProbe.frameRate,
          file: entry.finalFileName,
          sourceAudioStreamIndex: sourceAudioTrack.streamIndex,
          audioLanguage: sourceAudioTrack.language,
          videoEncoder: encoder,
          ...(preserveHdr ? { hdr: true } : {}),
          ...(tonemapHdr ? { tonemappedFromHdr: true } : {}),
        });
        onEvent?.({
          type: "quality-ready",
          mediaId: item.mediaId,
          qualityHeight: entry.requirement.qualityHeight,
          width: entry.requirement.width,
          height: entry.requirement.height,
          fileSize: finalStats.size,
          reused: false,
        });
      }
    }

    files.sort((left, right) => left.qualityHeight - right.qualityHeight);

    const durationToleranceSeconds = Math.max(
      2,
      item.probe.durationSeconds * 0.02,
    );
    const metadata: RenditionMetadata = {
      schemaVersion: RENDITION_METADATA_SCHEMA_VERSION,
      mediaId: item.mediaId,
      sourceFingerprint: item.sourceFingerprint,
      profileVersion: RENDITION_PROFILE_VERSION,
      createdAt: new Date().toISOString(),
      durationSeconds: item.probe.durationSeconds,
      original: {
        width: getDisplayDimensions(item.probe.video).width,
        height: getDisplayDimensions(item.probe.video).height,
        qualityHeight: classifyQualityHeight(item.probe.video),
        codec: item.probe.video.codec,
      },
      files,
      audioStrategy: "default-track-only",
      subtitleStrategy: "original-playback-only",
      validation: {
        validatedAt: new Date().toISOString(),
        durationToleranceSeconds,
      },
    };
    await writeFile(
      path.join(workVersionRoot, "metadata.json"),
      `${JSON.stringify(metadata, null, 2)}\n`,
      "utf8",
    );
    await validateCompletedVersion({
      versionRoot: workVersionRoot,
      mediaId: item.mediaId,
      sourceFingerprint: item.sourceFingerprint,
      profileVersion: RENDITION_PROFILE_VERSION,
    });

    await mkdir(mediaRoot, { recursive: true });
    await rename(workVersionRoot, finalVersionRoot);
    // Re-validate after promotion. If anything altered the files between the
    // work-directory check and publication, the pointer must not be written —
    // otherwise playback would be offered output that no longer matches.
    await validateCompletedVersion({
      versionRoot: finalVersionRoot,
      mediaId: item.mediaId,
      sourceFingerprint: item.sourceFingerprint,
      profileVersion: RENDITION_PROFILE_VERSION,
    });
    await writeCurrentPointer(
      mediaRoot,
      versionDirectory,
      item.sourceFingerprint,
    );
    await rm(path.dirname(workVersionRoot), {
      recursive: true,
      force: true,
    }).catch(() => undefined);
    return {
      mediaId: item.mediaId,
      relativePath: item.relativePath,
      status: "ready",
      versionDirectory,
    };
  } catch (error) {
    return {
      mediaId: item.mediaId,
      relativePath: item.relativePath,
      status: signal?.aborted ? "interrupted" : "failed",
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await lock.release();
  }
}

export interface ProcessReportOptions extends RenditionProcessorOptions {
  library?: string;
  mediaId?: string;
  workerCount?: number;
  maxRetries?: number;
}

export interface ProcessReportOutcome {
  videoEncoder: RenditionVideoEncoder;
  hdrVideoEncoder?: RenditionVideoEncoder;
  results: RenditionProcessResult[];
}

export async function processRenditionReport(
  report: RenditionAnalysisReport,
  paths: RenditionPaths,
  options: ProcessReportOptions,
): Promise<ProcessReportOutcome> {
  const processLock = await acquireDirectoryLock(
    path.join(paths.stateRoot, "locks", "processor.lock"),
    "rendition-processor",
  );
  try {
    // Encoders are probed once for the whole batch rather than per title.
    const ffmpegPath =
      options.ffmpegPath ??
      process.env.FFMPEG_PATH ??
      process.env.SEYIRLIK_FFMPEG_PATH ??
      "ffmpeg";
    const preference = options.encoderPreference ?? "auto";
    const hdrPolicy = options.hdrPolicy ?? "preserve";
    const videoEncoder =
      options.videoEncoder ??
      (await resolveVideoEncoder(
        preference,
        ffmpegPath,
        "h264",
        false,
        options.signal,
      ));
    const needsHdrEncoder =
      hdrPolicy === "preserve" &&
      report.items.some((item) => item.probe?.video.isHdr);
    const hdrVideoEncoder =
      options.hdrVideoEncoder ??
      (needsHdrEncoder
        ? await resolveVideoEncoder(
            preference,
            ffmpegPath,
            "hevc",
            true,
            options.signal,
          )
        : undefined);
    options.onEvent?.({
      type: "encoder-selected",
      encoder: videoEncoder,
      ...(hdrVideoEncoder ? { hdrEncoder: hdrVideoEncoder } : {}),
    });
    const selected = new Set(report.selectedMediaIds);
    const candidates = report.items.filter(
      (item) =>
        selected.has(item.mediaId) &&
        item.jobs.length > 0 &&
        (!options.library ||
          item.library.toLowerCase() === options.library.toLowerCase()) &&
        (!options.mediaId || item.mediaId === options.mediaId),
    );
    const workerCount = Math.max(
      1,
      Math.min(4, Math.floor(options.workerCount ?? 1)),
    );
    const maxRetries = Math.max(
      0,
      Math.min(3, Math.floor(options.maxRetries ?? 1)),
    );
    const results: RenditionProcessResult[] = new Array(candidates.length);
    let nextIndex = 0;
    const worker = async () => {
      while (!options.signal?.aborted) {
        const index = nextIndex;
        nextIndex += 1;
        const item = candidates[index];
        if (!item) return;
        const startedAt = Date.now();
        if (item.probe) {
          options.onEvent?.({
            type: "item-start",
            index: index + 1,
            total: candidates.length,
            mediaId: item.mediaId,
            relativePath: item.relativePath,
            source: {
              ...getDisplayDimensions(item.probe.video),
              qualityHeight: classifyQualityHeight(item.probe.video),
              durationSeconds: item.probe.durationSeconds,
              videoCodec: item.probe.video.codec,
              isHdr: item.probe.video.isHdr,
              audioLanguage: (
                item.probe.audioTracks.find((track) => track.isDefault) ??
                item.probe.audioTracks[0]
              )?.language,
            },
            pendingQualities: item.jobs.map((job) => job.qualityHeight),
            reusedQualities: item.existingHeights,
          });
        }
        let result: RenditionProcessResult | undefined;
        for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
          result = await processRenditionItem(item, paths, {
            ...options,
            videoEncoder,
            hdrVideoEncoder,
            hdrPolicy,
          });
          if (result.status !== "failed") break;
        }
        results[index] = result as RenditionProcessResult;
        options.onEvent?.({
          type: "item-complete",
          mediaId: item.mediaId,
          relativePath: item.relativePath,
          status: results[index].status,
          elapsedMs: Date.now() - startedAt,
          ...(results[index].error ? { error: results[index].error } : {}),
        });
      }
    };
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    return {
      videoEncoder,
      ...(hdrVideoEncoder ? { hdrVideoEncoder } : {}),
      results: results.filter(Boolean),
    };
  } finally {
    await processLock.release();
  }
}
