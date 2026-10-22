import path from "node:path";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import type { RenditionAnalysisReport, RenditionPaths } from "../analysis";
import {
  parseEncoderPreference,
  resolveVideoEncoder,
  type RenditionEncoderPreference,
  type RenditionVideoEncoder,
} from "../encoding";
import { acquireDirectoryLock } from "../locks";
import { classifyQualityHeight, getDisplayDimensions } from "../policy";
import type { RenditionProgressReporter } from "../progress";
import {
  loadRenditionRegistry,
  saveRenditionRegistry,
  type AdaptiveRegistryStatus,
} from "../registry";
import {
  decideAudioStreams,
  decideSubtitleStreams,
  type StreamPolicyOptions,
} from "../processing/streamPolicy";
import {
  discoverSidecarSubtitles,
  type SidecarSubtitle,
} from "./sidecarSubtitles";
import { titleRootFor, type TitleRootLayout } from "./titleRoot";
import {
  packageAdaptiveRendition,
  type AdaptivePackageResult,
} from "./packager";
import { ADAPTIVE_PROFILE_VERSION } from "./profile";

export interface ProcessAdaptiveReportOptions {
  reserveBytes: number;
  ffmpegPath?: string;
  ffprobePath?: string;
  encoderPreference?: RenditionEncoderPreference;
  videoEncoder?: RenditionVideoEncoder;
  hdrVideoEncoder?: RenditionVideoEncoder;
  library?: string;
  mediaId?: string;
  workerCount?: number;
  maxRetries?: number;
  /**
   * Bypass the retention policy and keep every language. Off by default: a
   * library build that keeps everything is what fills a disk with subtitle
   * languages nobody reads.
   */
  allAudioTracks?: boolean;
  /** Languages the retention policy keeps. Defaults to English and Turkish. */
  preferredLanguages?: string[];
  dryRun?: boolean;
  signal?: AbortSignal;
  onEvent?: RenditionProgressReporter;
}

export interface ProcessAdaptiveReportOutcome {
  videoEncoder: RenditionVideoEncoder;
  hdrVideoEncoder?: RenditionVideoEncoder;
  results: AdaptivePackageResult[];
}

/**
 * The offline CLI has no per-user language preference to apply. Preserve every
 * text subtitle the package can represent rather than silently dropping the
 * entire subtitle group; the server job path supplies its explicit retention
 * decision instead.
 */
export function defaultSubtitleStreamIndexes(
  probe: Pick<
    NonNullable<RenditionAnalysisReport["items"][number]["probe"]>,
    "subtitleTracks"
  >,
): number[] {
  return probe.subtitleTracks
    .filter((track) => track.isTextBased)
    .map((track) => track.streamIndex);
}

/**
 * The streams an offline build keeps, decided by the same policy the server job
 * path uses rather than by a second set of rules that could drift from it.
 *
 * A library build that keeps every stream is how a title ends up carrying
 * thirty-four subtitle languages nobody reads. Keeping the policy in one place
 * means "why did the French audio go" has the same answer whichever path built
 * the package.
 */
export function planRetainedStreams(
  probe: Pick<
    NonNullable<RenditionAnalysisReport["items"][number]["probe"]>,
    "audioTracks" | "subtitleTracks"
  >,
  options: StreamPolicyOptions = {},
): { audioStreamIndexes: number[]; subtitleStreamIndexes: number[] } {
  const audio = decideAudioStreams(probe.audioTracks, options);
  const subtitles = decideSubtitleStreams(probe.subtitleTracks, options);
  return {
    audioStreamIndexes: audio
      .filter((decision) => decision.keep)
      .map((decision) => decision.streamIndex),
    // A kept bitmap track has no WebVTT to extract, so it cannot join the
    // package even though the policy retains it on the source.
    subtitleStreamIndexes: subtitles
      .filter((decision) => decision.keep && !decision.requiresOcr)
      .map((decision) => decision.streamIndex),
  };
}

/**
 * The subtitle files beside a source that the retention policy keeps.
 *
 * Judged by the same policy as the embedded streams, so a Turkish `.srt` and a
 * Turkish subtitle track inside the container are kept or dropped for the same
 * stated reason rather than by two different sets of rules.
 */
export async function planRetainedSidecarSubtitles(
  sourcePath: string,
  options: StreamPolicyOptions = {},
): Promise<SidecarSubtitle[]> {
  const found = await discoverSidecarSubtitles(sourcePath);
  if (found.length === 0) return [];

  const decisions = decideSubtitleStreams(
    found.map((sidecar) => ({
      streamIndex: sidecar.streamIndex,
      codec: "subrip",
      isTextBased: true,
      isDefault: false,
      isForced: sidecar.isForced,
      isHearingImpaired: sidecar.isHearingImpaired,
      isCommentary: false,
      language: sidecar.language,
    })) as never,
    options,
  );

  const keptIndexes = new Set(
    decisions
      .filter((decision) => decision.keep)
      .map((decision) => decision.streamIndex),
  );
  const retained = found.filter((sidecar) =>
    keptIndexes.has(sidecar.streamIndex),
  );
  for (const sidecar of retained) {
    try {
      const fingerprint = createHash("sha256")
        .update(sidecar.fileName)
        .update("\0");
      for await (const chunk of createReadStream(sidecar.filePath)) {
        fingerprint.update(chunk);
      }
      sidecar.sidecarFingerprint = fingerprint.digest("hex");
    } catch {
      // An unreadable sidecar must not abort library analysis or reuse stale
      // output. Extraction reports the individual file failure during the job.
    }
  }
  return retained;
}

function registryStatus(
  result: AdaptivePackageResult,
): AdaptiveRegistryStatus | undefined {
  switch (result.status) {
    case "ready":
    case "already-valid":
      return "ready";
    case "failed":
    case "validation-failed":
    case "deferred-for-storage":
    case "interrupted":
    case "incompatible":
      return result.status;
    case "dry-run":
      return undefined;
  }
}

/**
 * Processes the adaptive generation without mutating legacy package state.
 *
 * Registry writes are serialised even when encoding uses several workers. This
 * prevents two completed titles from racing an atomic registry rewrite and
 * losing one another's status update.
 */
export async function processAdaptiveReport(
  report: RenditionAnalysisReport,
  paths: RenditionPaths,
  options: ProcessAdaptiveReportOptions,
): Promise<ProcessAdaptiveReportOutcome> {
  const processLock = await acquireDirectoryLock(
    path.join(paths.stateRoot, "locks", "processor.lock"),
    "adaptive-rendition-processor",
  );

  try {
    const ffmpegPath =
      options.ffmpegPath ??
      process.env.FFMPEG_PATH ??
      process.env.SEYIRLIK_FFMPEG_PATH ??
      "ffmpeg";
    const encoderPreference =
      options.encoderPreference ??
      parseEncoderPreference(process.env.SEYIRLIK_RENDITION_ENCODER);
    const candidates = report.items.filter(
      (item) =>
        item.adaptive.eligible &&
        item.adaptive.status !== "ready" &&
        item.probe !== undefined &&
        (!options.library ||
          item.library.toLowerCase() === options.library.toLowerCase()) &&
        (!options.mediaId || item.mediaId === options.mediaId),
    );
    const videoEncoder =
      options.videoEncoder ??
      (await resolveVideoEncoder(
        encoderPreference,
        ffmpegPath,
        "h264",
        false,
        options.signal,
      ));
    const needsHdrEncoder = candidates.some((item) => item.probe?.video.isHdr);
    const hdrVideoEncoder =
      options.hdrVideoEncoder ??
      (needsHdrEncoder
        ? await resolveVideoEncoder(
            encoderPreference,
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

    const registryPath = path.join(paths.stateRoot, "registry.json");
    const registry = await loadRenditionRegistry(registryPath);
    let registryWrite = Promise.resolve();
    const recordResult = (result: AdaptivePackageResult) => {
      const status = registryStatus(result);
      if (!status) return registryWrite;
      const item = registry.items.find((entry) => entry.id === result.mediaId);
      if (!item) return registryWrite;
      item.adaptiveStatus = status;
      item.adaptiveProfileVersion = ADAPTIVE_PROFILE_VERSION;
      if (result.error) item.adaptiveLastError = result.error;
      else delete item.adaptiveLastError;
      registryWrite = registryWrite.then(() =>
        saveRenditionRegistry(registryPath, registry),
      );
      return registryWrite;
    };

    /*
     * Which of these sources own their folder, and which share it.
     *
     * The offline runner has no catalogue to ask, so it reads the question off
     * the run itself: a folder holding one source is that source's title, and
     * its package goes beside it — the movie layout, unchanged. A folder
     * holding several is a season folder, and each source gets its own nested
     * root, because publishing them all into one directory would have each
     * episode's `video/` and manifest silently replace the last one's.
     */
    const sourcesPerDirectory = new Map<string, number>();
    for (const candidate of candidates) {
      const directory = path.posix.dirname(candidate.relativePath);
      sourcesPerDirectory.set(
        directory,
        (sourcesPerDirectory.get(directory) ?? 0) + 1,
      );
    }
    const layoutFor = (relativePath: string): TitleRootLayout =>
      (sourcesPerDirectory.get(path.posix.dirname(relativePath)) ?? 1) > 1
        ? "nested"
        : "beside";

    const workerCount = Math.max(
      1,
      Math.min(4, Math.floor(options.workerCount ?? 1)),
    );
    const maxRetries = Math.max(
      0,
      Math.min(3, Math.floor(options.maxRetries ?? 1)),
    );
    const results: AdaptivePackageResult[] = new Array(candidates.length);
    let nextIndex = 0;

    const worker = async () => {
      while (!options.signal?.aborted) {
        const index = nextIndex;
        nextIndex += 1;
        const item = candidates[index];
        if (!item?.probe) return;
        const startedAt = Date.now();
        const display = getDisplayDimensions(item.probe.video);
        options.onEvent?.({
          type: "item-start",
          index: index + 1,
          total: candidates.length,
          mediaId: item.mediaId,
          relativePath: item.relativePath,
          source: {
            ...display,
            qualityHeight: classifyQualityHeight(item.probe.video),
            durationSeconds: item.probe.durationSeconds,
            videoCodec: item.probe.video.codec,
            isHdr: item.probe.video.isHdr,
            audioLanguage: (
              item.probe.audioTracks.find((track) => track.isDefault) ??
              item.probe.audioTracks[0]
            )?.language,
          },
          pendingQualities: item.requiredHeights,
          reusedQualities: [],
        });

        const sourcePath = path.join(
          paths.mediaRoot,
          ...item.relativePath.split("/"),
        );
        const sidecarSubtitles = await planRetainedSidecarSubtitles(
          sourcePath,
          {
            keepAllLanguages: options.allAudioTracks,
            ...(options.preferredLanguages
              ? { preferredLanguages: options.preferredLanguages }
              : {}),
          },
        );

        let result: AdaptivePackageResult | undefined;
        for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
          result = await packageAdaptiveRendition(
            {
              mediaId: item.mediaId,
              relativePath: item.relativePath,
              sourceFingerprint: item.sourceFingerprint,
              sourcePath,
              titleRoot: titleRootFor(sourcePath, layoutFor(item.relativePath)),
              probe: item.probe,
            },
            paths,
            {
              reserveBytes: options.reserveBytes,
              ffmpegPath,
              ...(options.ffprobePath
                ? { ffprobePath: options.ffprobePath }
                : {}),
              encoderPreference,
              videoEncoder,
              hdrVideoEncoder,
              allAudioTracks: options.allAudioTracks,
              ...(options.allAudioTracks
                ? {
                    subtitleStreamIndexes: defaultSubtitleStreamIndexes(
                      item.probe,
                    ),
                  }
                : planRetainedStreams(item.probe, {
                    ...(options.preferredLanguages
                      ? { preferredLanguages: options.preferredLanguages }
                      : {}),
                  })),
              sidecarSubtitles,
              dryRun: options.dryRun,
              signal: options.signal,
              onEvent: options.onEvent,
            },
          );
          if (result.status !== "failed") break;
        }
        results[index] = result as AdaptivePackageResult;
        await recordResult(results[index]);
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
    await registryWrite;
    return {
      videoEncoder,
      ...(hdrVideoEncoder ? { hdrVideoEncoder } : {}),
      results: results.filter(Boolean),
    };
  } finally {
    await processLock.release();
  }
}
