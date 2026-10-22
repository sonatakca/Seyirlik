/**
 * Audio, as its own recoverable stage.
 *
 * Audio used to ride along in the same FFmpeg process as the video ladder,
 * which was free while a package was one transaction and is wrong now: a
 * failure encoding a soundtrack would take eight video renditions with it, and
 * a video epoch that had to be redone would re-encode audio it had already
 * produced. Sound is cheap — minutes against hours — so it is built once for
 * the whole title and checkpointed on its own.
 *
 * The consequence that matters is stated plainly because it is the whole point:
 * audio failing never invalidates a video epoch, and a video epoch failing
 * never re-encodes audio.
 */

import { mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { PauseController } from "../../processing/pauseController";
import { parseFfmpegProgressFields } from "../../progress";
import {
  adaptiveOutputDirectories,
  buildAdaptivePackageFfmpegArgs,
  type AdaptiveAudioOutput,
} from "../encoding";
import {
  ADAPTIVE_AUDIO_DIRECTORY,
  ADAPTIVE_MEDIA_FILE,
  ADAPTIVE_PLAYLIST_FILE,
  AUDIO_DURATION_TOLERANCE_SECONDS,
  audioRenditionId,
} from "../profile";
import { probePackagedAudio } from "../probePackaged";
import { parseMediaPlaylist } from "../playlist";
import { readFile } from "node:fs/promises";
import { EPOCH_CHECKPOINT_SCHEMA_VERSION } from "./policy";
import {
  readAuxiliaryStage,
  writeAuxiliaryStage,
  type AuxiliaryStageManifest,
} from "./checkpoints";
import {
  AudioStageError,
  classifyFailure,
  StorageInterruptedError,
} from "./failure";
import { planSalvagedAudio, sameDamagedIntervals } from "./audioSalvage";
import { describeInterval, type SourceInterval } from "./salvage";
import { stallThresholds, type StallThresholds } from "./stallPolicy";
import type { EncoderWatchdog } from "../../processExecution";
import {
  createStderrTail,
  evidenceIndictsSource,
  readSourceIoEvidence,
} from "./sourceIo";
import { createOutputMeter } from "../../outputMeter";
import { createSpeedEstimator } from "./progress";
import { safeFraction, type AudioPhaseProgress } from "../phaseProgress";

/**
 * How the audio stage actually runs, stated because the reporting depends on
 * it: one FFmpeg process reads the source once and writes every retained track
 * in the same pass. The tracks therefore advance together along one timeline —
 * there is no track 1 finishing before track 2 begins — so progress is that
 * shared timeline plus the bytes each track has produced, and never a
 * "track 2 of 3" position that the pipeline does not have.
 */
export const AUDIO_PROGRESS_INTERVAL_MS = 250;

export interface AudioStageResult {
  /** Directory the finished audio renditions live in. */
  directory: string;
  reused: boolean;
  bytes: number;
  manifest: AuxiliaryStageManifest;
}

export interface EnsureAudioStageInput {
  stageDirectory: string;
  mediaId: string;
  sourceFingerprint: string;
  adaptiveProfileVersion: string;
  sourcePath: string;
  audioOutputs: readonly AdaptiveAudioOutput[];
  sourceDurationSeconds: number;
  /**
   * Where the source's video ends, when its sound runs on past the last frame.
   *
   * The ladder stops at that frame, so audio encoded to the container's end
   * would outlast every video rendition and the package would fail its
   * coverage check after the whole encode had run.
   */
  endSeconds?: number;
  ffmpegPath: string;
  ffprobePath: string;
  logPath: string;
  runEncoder: (
    command: string,
    args: string[],
    options: {
      signal?: AbortSignal;
      logPath: string;
      onProgress?: (
        progress: ReturnType<typeof parseFfmpegProgressFields>,
      ) => void;
      onStderr?: (chunk: string) => void;
      watchdog?: EncoderWatchdog;
      pauseController?: PauseController;
    },
  ) => Promise<void>;
  /**
   * Stretches of the source that are known to be unreadable.
   *
   * Passed in from the video stage, which found them the hard way. Without this
   * the audio pass would walk into the same bad sectors after the video epochs
   * had been successfully salvaged and fail the title anyway, which is the
   * exact outcome salvage exists to prevent.
   */
  damagedIntervals?: readonly SourceInterval[];
  /**
   * Ends the pass when media time stops advancing.
   *
   * Audio reads the whole source in one go, so it is the stage most exposed to
   * a bad region the video epochs never touched — and without this it would sit
   * on it for as long as the kernel takes, exactly as the video encoder did.
   */
  stalls?: StallThresholds;
  signal?: AbortSignal;
  pauseController?: PauseController;
  storageAvailable?: () => boolean | Promise<boolean>;
  /**
   * The tracks' own descriptions, so the page can name what it is encoding.
   * Keyed by source stream index; anything missing is simply not shown.
   */
  trackDetails?: ReadonlyMap<
    number,
    { language?: string; title?: string; channels?: number }
  >;
  /** Called about four times a second while FFmpeg is reporting. */
  onProgress?: (progress: AudioPhaseProgress) => void;
  now?: () => number;
}

function sameStreams(
  manifest: AuxiliaryStageManifest,
  wanted: readonly number[],
): boolean {
  if (manifest.streamIndexes.length !== wanted.length) return false;
  const present = new Set(manifest.streamIndexes);
  return wanted.every((index) => present.has(index));
}

/**
 * Builds the title's audio, or proves what is already there still fits.
 *
 * The stage is only reused when it was produced from the same source bytes,
 * under the same profile, for exactly the tracks wanted now. A retention policy
 * that changed its mind about a language must rebuild rather than publish a
 * package whose manifest and media disagree about which tracks exist.
 */
export async function ensureAudioStage({
  stageDirectory,
  mediaId,
  sourceFingerprint,
  adaptiveProfileVersion,
  sourcePath,
  audioOutputs,
  sourceDurationSeconds,
  endSeconds,
  ffmpegPath,
  ffprobePath,
  logPath,
  runEncoder,
  signal,
  pauseController,
  storageAvailable,
  trackDetails,
  damagedIntervals = [],
  stalls = stallThresholds(),
  onProgress,
  now = Date.now,
}: EnsureAudioStageInput): Promise<AudioStageResult> {
  const wanted = audioOutputs.map((output) => output.sourceStreamIndex);
  // How much of the timeline the tracks cover: up to the last frame when the
  // source's sound runs on past it, otherwise the whole source.
  const end =
    endSeconds !== undefined && endSeconds < sourceDurationSeconds
      ? Number(endSeconds.toFixed(6))
      : undefined;
  const coverSeconds = end ?? sourceDurationSeconds;
  const salvaging = damagedIntervals.length > 0;
  const existing = await readAuxiliaryStage(stageDirectory);
  if (
    existing &&
    existing.schemaVersion === EPOCH_CHECKPOINT_SCHEMA_VERSION &&
    existing.mediaId === mediaId &&
    existing.sourceFingerprint === sourceFingerprint &&
    existing.adaptiveProfileVersion === adaptiveProfileVersion &&
    sameStreams(existing, wanted) &&
    sameDamagedIntervals(existing.damagedIntervals, damagedIntervals) &&
    existing.endSeconds === end &&
    (await audioFilesPresent(stageDirectory, audioOutputs))
  ) {
    /*
     * Nothing is being encoded, so there is no progress to report — only the
     * fact that the stage is already there. Said once rather than left silent,
     * because a phase that produces no samples at all is what made the page
     * look stalled.
     */
    onProgress?.({
      tracks: audioOutputs.map((output) => {
        const details = trackDetails?.get(output.sourceStreamIndex);
        return {
          id: audioRenditionId(output.sourceStreamIndex),
          ...(details?.language ? { language: details.language } : {}),
          ...(details?.title ? { title: details.title } : {}),
          codec: "aac",
          channels: details?.channels ?? 0,
          writtenBytes: 0,
        };
      }),
      processedSeconds: coverSeconds,
      durationSeconds: coverSeconds,
      fraction: 1,
      writtenBytes: existing.totalBytes,
      reused: true,
    });
    return {
      directory: stageDirectory,
      reused: true,
      bytes: existing.totalBytes,
      manifest: existing,
    };
  }

  await rm(stageDirectory, { recursive: true, force: true });
  await mkdir(stageDirectory, { recursive: true });
  for (const directory of adaptiveOutputDirectories({
    videoOutputs: [],
    audioOutputs: [...audioOutputs],
  })) {
    await mkdir(path.join(stageDirectory, ...directory.split("/")), {
      recursive: true,
    });
  }

  /*
   * Two shapes of the same command. An undamaged source is read once, straight
   * through, exactly as it always was. A damaged one is read once per readable
   * stretch with generated silence between, concatenated inside the filter
   * graph so each track is still a single continuous encode over the title's
   * own timeline — the material after a hole stays where it belongs rather than
   * being pulled earlier by the length of the hole.
   */
  const salvagePlan = salvaging
    ? planSalvagedAudio({
        sourcePath,
        audioOutputs,
        damagedIntervals,
        sourceDurationSeconds: coverSeconds,
      })
    : null;
  const args = buildAdaptivePackageFfmpegArgs({
    inputPath: sourcePath,
    outputRoot: stageDirectory.split(path.sep).join("/"),
    videoOutputs: [],
    audioOutputs: salvagePlan ? [...salvagePlan.outputs] : [...audioOutputs],
    ...(salvagePlan
      ? {
          inputs: salvagePlan.inputs,
          audioFilterComplex: salvagePlan.filterComplex,
        }
      : {}),
    ...(end === undefined ? {} : { durationSeconds: end }),
    statsPeriodSeconds: 1,
  });

  /*
   * Per-track bytes, measured from the files being written.
   *
   * FFmpeg reports `total_size=N/A` for HLS outputs, so its own byte counter is
   * useless here — the same reason the video stage measures its epochs. One
   * stat per track per second is cheap: a handful of files, not a tree walk.
   */
  const trackFiles = audioOutputs.map((output) => ({
    id: audioRenditionId(output.sourceStreamIndex),
    streamIndex: output.sourceStreamIndex,
    meter: createOutputMeter([
      path.join(
        stageDirectory,
        ADAPTIVE_AUDIO_DIRECTORY,
        audioRenditionId(output.sourceStreamIndex),
        ADAPTIVE_MEDIA_FILE,
      ),
    ]),
  }));
  const speed = createSpeedEstimator();
  let lastReportMs = Number.NEGATIVE_INFINITY;

  const stderr = createStderrTail();
  try {
    await runEncoder(ffmpegPath, args, {
      ...(signal ? { signal } : {}),
      ...(pauseController ? { pauseController } : {}),
      logPath,
      onStderr: (chunk) => stderr.append(chunk),
      watchdog: {
        hardStallMs: stalls.hardStallMs,
        startupStallMs: stalls.startupStallMs,
        terminationGraceMs: stalls.terminationGraceMs,
      },
      ...(onProgress
        ? {
            onProgress: (progress) => {
              for (const track of trackFiles) track.meter.sample();
              const smoothed = speed.sample(progress.speed);
              const at = now();
              if (at - lastReportMs < AUDIO_PROGRESS_INTERVAL_MS) return;
              lastReportMs = at;

              const tracks = trackFiles.map((track) => {
                const details = trackDetails?.get(track.streamIndex);
                return {
                  id: track.id,
                  ...(details?.language ? { language: details.language } : {}),
                  ...(details?.title ? { title: details.title } : {}),
                  codec: "aac",
                  channels: details?.channels ?? 0,
                  writtenBytes: track.meter.latest() ?? 0,
                };
              });
              const fraction = safeFraction(
                progress.processedSeconds,
                coverSeconds,
              );
              /*
               * The estimate uses FFmpeg's own throughput multiplier over the
               * media time that genuinely remains — the same measurement the
               * video stage trusts, and never a wall clock counting toward a
               * guessed finish.
               */
              const remaining = Math.max(
                0,
                coverSeconds - progress.processedSeconds,
              );
              const etaSeconds =
                smoothed && smoothed > 0
                  ? Math.round(remaining / smoothed)
                  : undefined;
              onProgress({
                tracks,
                processedSeconds: progress.processedSeconds,
                durationSeconds: coverSeconds,
                fraction,
                ...(smoothed === undefined ? {} : { speed: smoothed }),
                writtenBytes: tracks.reduce(
                  (sum, track) => sum + track.writtenBytes,
                  0,
                ),
                ...(etaSeconds === undefined ? {} : { etaSeconds }),
              });
            },
          }
        : {}),
    });
  } catch (error) {
    await rm(stageDirectory, { recursive: true, force: true }).catch(
      () => undefined,
    );
    if (signal?.aborted) throw error;
    const message = error instanceof Error ? error.message : String(error);
    const evidence = readSourceIoEvidence(`${stderr.value()}\n${message}`);
    const failure = classifyFailure({
      message,
      storageAvailable: storageAvailable ? await storageAvailable() : true,
      evidence,
      /*
       * The video stage has already established that this source has an
       * unreadable region and has spent its retry budget proving it. An audio
       * pass that hits a *further* one is the same disk failing further, not a
       * mount that might come back, so it is reported as damage rather than
       * parked for a watchdog with nothing to wait for.
       */
      ioRechecksExhausted: salvaging,
    });
    if (
      failure.kind === "storage-unavailable" ||
      failure.kind === "storage-device-lost" ||
      failure.kind === "storage-io" ||
      failure.kind === "storage-soft-fault" ||
      failure.kind === "out-of-space"
    ) {
      throw new StorageInterruptedError(failure);
    }
    throw new AudioStageError(
      failure.kind === "source-io"
        ? failure.summary
        : `Audio could not be packaged. ${failure.detail}`.trim(),
      failure,
      evidence.lines,
    );
  }
  /*
   * A clean exit is not proof the source was read. Checked here for the same
   * reason the video stage checks it: a demuxer that gave up on a bad region
   * can still let the muxer finalise, and the duration check below would then
   * report a truncated soundtrack as an encoding fault.
   */
  {
    const evidence = readSourceIoEvidence(stderr.value());
    if (evidenceIndictsSource(evidence)) {
      await rm(stageDirectory, { recursive: true, force: true }).catch(
        () => undefined,
      );
      throw new AudioStageError(
        salvaging
          ? `The source could not be read while building audio around the intervals already known to be damaged (${damagedIntervals
              .map(describeInterval)
              .join(", ")}).`
          : "The source could not be read while its audio was being encoded.",
        {
          kind: "source-io",
          summary: "The source could not be read while audio was encoded.",
          detail: evidence.lines.join(" | "),
          evidence,
        },
        evidence.lines,
      );
    }
  }

  let totalBytes = 0;
  const measuredBytes = new Map<number, number>();
  for (const output of audioOutputs) {
    const id = audioRenditionId(output.sourceStreamIndex);
    const mediaPath = path.join(
      stageDirectory,
      ADAPTIVE_AUDIO_DIRECTORY,
      id,
      ADAPTIVE_MEDIA_FILE,
    );
    const playlistPath = path.join(
      stageDirectory,
      ADAPTIVE_AUDIO_DIRECTORY,
      id,
      ADAPTIVE_PLAYLIST_FILE,
    );
    const stats = await stat(mediaPath).catch(() => undefined);
    if (!stats?.isFile() || stats.size === 0) {
      throw new Error(`Audio rendition ${id} was not written.`);
    }
    totalBytes += stats.size;
    measuredBytes.set(output.sourceStreamIndex, stats.size);

    // Parsed rather than merely present: a playlist the delivery route cannot
    // read is a track that plays as silence with no error anywhere.
    parseMediaPlaylist(await readFile(playlistPath, "utf8"));

    const probe = await probePackagedAudio(mediaPath, ffprobePath, signal);
    if (
      Math.abs(probe.durationSeconds - coverSeconds) >
      Math.max(AUDIO_DURATION_TOLERANCE_SECONDS, coverSeconds * 0.01)
    ) {
      throw new Error(
        `Audio rendition ${id} covers ${probe.durationSeconds.toFixed(2)}s of a ${coverSeconds.toFixed(2)}s source.`,
      );
    }
  }

  const manifest: AuxiliaryStageManifest = {
    schemaVersion: EPOCH_CHECKPOINT_SCHEMA_VERSION,
    mediaId,
    sourceFingerprint,
    adaptiveProfileVersion,
    stage: "audio",
    streamIndexes: wanted,
    ...(salvaging
      ? {
          damagedIntervals: damagedIntervals.map((interval) => ({
            ...interval,
          })),
        }
      : {}),
    ...(end === undefined ? {} : { endSeconds: end }),
    totalBytes,
    completedAt: new Date().toISOString(),
  };
  await writeAuxiliaryStage(stageDirectory, manifest);

  // The closing sample, with the sizes the files actually have rather than the
  // last figure the meter happened to catch before FFmpeg exited.
  onProgress?.({
    tracks: audioOutputs.map((output) => {
      const details = trackDetails?.get(output.sourceStreamIndex);
      return {
        id: audioRenditionId(output.sourceStreamIndex),
        ...(details?.language ? { language: details.language } : {}),
        ...(details?.title ? { title: details.title } : {}),
        codec: "aac",
        channels: details?.channels ?? 0,
        writtenBytes: measuredBytes.get(output.sourceStreamIndex) ?? 0,
      };
    }),
    processedSeconds: coverSeconds,
    durationSeconds: coverSeconds,
    fraction: 1,
    writtenBytes: totalBytes,
  });

  return {
    directory: stageDirectory,
    reused: false,
    bytes: totalBytes,
    manifest,
  };
}

async function audioFilesPresent(
  stageDirectory: string,
  audioOutputs: readonly AdaptiveAudioOutput[],
): Promise<boolean> {
  for (const output of audioOutputs) {
    const id = audioRenditionId(output.sourceStreamIndex);
    for (const file of [ADAPTIVE_MEDIA_FILE, ADAPTIVE_PLAYLIST_FILE]) {
      const stats = await stat(
        path.join(stageDirectory, ADAPTIVE_AUDIO_DIRECTORY, id, file),
      ).catch(() => undefined);
      if (!stats?.isFile() || stats.size === 0) return false;
    }
  }
  return true;
}
