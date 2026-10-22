import { mkdir, statfs, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  getEncodingPolicy,
  parseHdrPolicy,
  type RenditionCodecFamily,
} from "./encoding";
import { discoverEligibleVideoFiles } from "./inventory";
import {
  DEFAULT_MP4_CONTAINER_OVERHEAD_RATIO,
  DEFAULT_STORAGE_SAFETY_MARGIN,
  buildStorageSchedule,
  calculateReserveBytes,
  estimateRenditionBytes,
  type PlannedRenditionJob,
  type StorageSchedule,
} from "./planning";
import {
  RENDITION_PROFILE_VERSION,
  buildRenditionRequirements,
  classifyQualityHeight,
} from "./policy";
import { probeMediaFile, type RenditionMediaProbe } from "./probe";
import {
  computeSourceFingerprint,
  loadRenditionRegistry,
  saveRenditionRegistry,
  upsertRegistrySource,
} from "./registry";
import type { RenditionHdrPolicy } from "./encoding";
import type { RenditionProgressReporter } from "./progress";
import { inspectCompletedRendition } from "./validation";
import {
  estimateAdaptivePackageBytes,
  planAudioRenditions,
} from "./adaptive/packager";
import {
  inspectAdaptivePackage,
  type AdaptiveInspectionStatus,
} from "./adaptive/inspect";
import { resolveTitleRoot } from "./adaptive/titleRoot";
import { ADAPTIVE_PROFILE_VERSION } from "./adaptive/profile";
import { planRetainedSidecarSubtitles } from "./adaptive/processor";
import { SEGMENT_TARGET_SECONDS } from "../lib/playback-planner/gopPolicy";

export interface RenditionPaths {
  mediaRoot: string;
  renditionRoot: string;
  workRoot: string;
  stateRoot: string;
  logsRoot: string;
}

export interface DriveSpace {
  totalBytes: number;
  freeBytes: number;
}

export interface RenditionAnalysisItem {
  mediaId: string;
  relativePath: string;
  library: string;
  sourceSizeBytes: number;
  sourceMtimeMs: number;
  sourceFingerprint: string;
  status:
    | "pending"
    | "ready"
    | "already-valid"
    | "failed"
    | "stale"
    | "validation-failed"
    | "deferred-for-storage";
  probe?: RenditionMediaProbe;
  existingStatus?: string;
  existingHeights: number[];
  requiredHeights: number[];
  jobs: PlannedRenditionJob[];
  error?: string;
  /**
   * The adaptive package's state, reported alongside the legacy one rather than
   * instead of it. A title with a valid legacy package and no adaptive package
   * is playable today and a candidate for regeneration — two facts that a
   * single status field cannot express.
   */
  adaptive: {
    status: AdaptiveInspectionStatus;
    /** False when the source cannot join an adaptive switching set at all. */
    eligible: boolean;
    reason?: string;
    estimatedVideoBytes: number;
    estimatedAudioBytes: number;
    estimatedTotalBytes: number;
    /** Media files the package will consist of, for the file-count budget. */
    expectedFileCount: number;
    /** Two-second segments a full playthrough would request. */
    expectedSegmentCount: number;
    isHdr: boolean;
  };
}

export interface RenditionAnalysisReport {
  schemaVersion: 1;
  generatedAt: string;
  profileVersion: string;
  policy: {
    sourceLadder: string;
    scheduling: StorageSchedule["policy"];
    safetyMarginRatio: number;
    containerOverheadRatio: number;
    audioStrategy: "default-track-only";
    subtitleStrategy: "original-playback-only";
    hdrStrategy: RenditionHdrPolicy;
  };
  summary: {
    totalEligibleVideoCount: number;
    totalSourceVideoBytes: number;
    movieCount: number;
    episodeCount: number;
    otherEligibleVideoCount: number;
    source2160pCount: number;
    source1080pCount: number;
    lowerResolutionSourceCount: number;
    existingValidRenditionCount: number;
    staleRenditionCount: number;
    validationFailureCount: number;
    probeFailureCount: number;
    hdrSourceCount: number;
    missingByHeight: Record<"480" | "720" | "1080", number>;
    sourceBytesByLibrary: Record<string, number>;
    estimatedOutputBytesByLibrary: Record<string, number>;
  };
  /**
   * The migration picture: how much of the library each generation covers, and
   * what completing the adaptive generation would cost.
   */
  adaptive: {
    profileVersion: string;
    segmentTargetSeconds: number;
    legacyValidTitleCount: number;
    adaptiveValidTitleCount: number;
    titlesRequiringAdaptiveGeneration: number;
    incompatibleTitleCount: number;
    staleAdaptiveTitleCount: number;
    sdrPackageCount: number;
    hdrPackageCount: number;
    estimatedVideoBytes: number;
    estimatedSharedAudioBytes: number;
    estimatedTotalBytes: number;
    /**
     * Peak extra space while both generations exist. Legacy output is never
     * deleted implicitly, so a migration needs room for both at once.
     */
    temporaryMigrationOverheadBytes: number;
    expectedPackageCount: number;
    expectedMediaFileCount: number;
    expectedSegmentRequestCount: number;
    titlesDeferredForStorage: number;
  };
  storage: StorageSchedule & {
    driveTotalBytes: number;
    driveFreeBytes: number;
    completePlanEstimatedFinalBytes: number;
    completePlanConservativeFinalBytes: number;
    completePlanTemporaryPeakBytes: number;
    completePlanPeakRequiredBytes: number;
    expectedRemainingBytesForCompletePlan: number;
  };
  selectedMediaIds: string[];
  deferredMediaIds: string[];
  discoveryErrors: Array<{ relativePath: string; message: string }>;
  items: RenditionAnalysisItem[];
}

export interface RenditionAnalysisOptions {
  paths: RenditionPaths;
  ffprobePath?: string;
  driveSpace?: DriveSpace;
  reserveBytes?: number;
  libraryOrder?: string[];
  probe?: (filePath: string) => Promise<RenditionMediaProbe>;
  saveReport?: boolean;
  reportPath?: string;
  onEvent?: RenditionProgressReporter;
  hdrPolicy?: RenditionHdrPolicy;
}

export function resolveRenditionPaths(
  environment: Record<string, string | undefined> = process.env,
): RenditionPaths {
  const mediaRoot = environment.SEYIRLIK_MEDIA_ROOT?.trim();
  if (!mediaRoot) throw new Error("SEYIRLIK_MEDIA_ROOT is required.");
  const generatedRoot = path.join(mediaRoot, ".seyirlik");
  return {
    mediaRoot: path.resolve(mediaRoot),
    renditionRoot: path.resolve(
      environment.SEYIRLIK_RENDITION_ROOT?.trim() ||
        path.join(generatedRoot, "renditions"),
    ),
    workRoot: path.resolve(
      environment.SEYIRLIK_RENDITION_WORK_ROOT?.trim() ||
        path.join(generatedRoot, "work"),
    ),
    stateRoot: path.resolve(
      environment.SEYIRLIK_RENDITION_STATE_ROOT?.trim() ||
        path.join(generatedRoot, "state"),
    ),
    logsRoot: path.resolve(
      environment.SEYIRLIK_RENDITION_LOG_ROOT?.trim() ||
        path.join(generatedRoot, "logs"),
    ),
  };
}

/**
 * Generated output living inside the media root is reachable by any tool that
 * watches the library. Media automation re-encodes or deletes the renditions in
 * place, validation then rejects them, and the player silently loses its quality
 * options. Keep the output on the same volume but outside the watched tree.
 */
export function findRootsInsideMediaRoot(paths: RenditionPaths): string[] {
  const mediaRoot = path.resolve(paths.mediaRoot);
  const prefix = mediaRoot.endsWith(path.sep)
    ? mediaRoot
    : `${mediaRoot}${path.sep}`;
  const comparable = (value: string) =>
    process.platform === "win32" ? value.toLowerCase() : value;

  return (
    [
      ["rendition output", paths.renditionRoot],
      ["work", paths.workRoot],
    ] as const
  )
    .filter(([, root]) =>
      comparable(path.resolve(root)).startsWith(comparable(prefix)),
    )
    .map(([label, root]) => `${label} (${root})`);
}

export async function getDriveSpace(filePath: string): Promise<DriveSpace> {
  const result = await statfs(filePath, { bigint: true });
  const totalBytes = Number(result.bsize * result.blocks);
  const freeBytes = Number(result.bsize * result.bavail);
  if (!Number.isSafeInteger(totalBytes) || !Number.isSafeInteger(freeBytes)) {
    throw new Error("Drive capacity exceeds JavaScript safe integer range.");
  }
  return { totalBytes, freeBytes };
}

function jobEstimate(
  durationSeconds: number,
  qualityHeight: number,
  family: RenditionCodecFamily,
): PlannedRenditionJob {
  const policy = getEncodingPolicy(qualityHeight, family);
  const estimate = estimateRenditionBytes({
    durationSeconds,
    videoBitrate: policy.expectedVideoBitrate,
    audioBitrate: policy.audioBitrate,
    overheadRatio: DEFAULT_MP4_CONTAINER_OVERHEAD_RATIO,
    safetyMarginRatio: DEFAULT_STORAGE_SAFETY_MARGIN,
  });
  return { qualityHeight, estimatedBytes: estimate.withOverheadBytes };
}

function addRecordValue(
  record: Record<string, number>,
  key: string,
  value: number,
) {
  record[key] = (record[key] ?? 0) + value;
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function analyseRenditionLibrary({
  paths,
  ffprobePath,
  driveSpace,
  reserveBytes,
  libraryOrder,
  probe = (filePath) => probeMediaFile(filePath, ffprobePath),
  saveReport = true,
  reportPath = path.join(paths.stateRoot, "rendition-analysis.json"),
  hdrPolicy = parseHdrPolicy(process.env.SEYIRLIK_RENDITION_HDR),
  onEvent,
}: RenditionAnalysisOptions): Promise<RenditionAnalysisReport> {
  await mkdir(paths.stateRoot, { recursive: true });
  const registryPath = path.join(paths.stateRoot, "registry.json");
  const registry = await loadRenditionRegistry(registryPath);
  registry.profileVersion = RENDITION_PROFILE_VERSION;
  const discoveryErrors: RenditionAnalysisReport["discoveryErrors"] = [];
  const discovered = await discoverEligibleVideoFiles(paths.mediaRoot, {
    onError: (filePath, error) => {
      discoveryErrors.push({
        relativePath: path
          .relative(paths.mediaRoot, filePath)
          .split(path.sep)
          .join("/"),
        message: safeErrorMessage(error),
      });
    },
  });
  const items: RenditionAnalysisItem[] = [];

  for (const [discoveredIndex, source] of discovered.entries()) {
    onEvent?.({
      type: "analysis-progress",
      index: discoveredIndex + 1,
      total: discovered.length,
      relativePath: source.relativePath,
    });
    let fingerprint = "";
    try {
      fingerprint = await computeSourceFingerprint(source.filePath, source);
      const registryItem = upsertRegistrySource(registry, {
        relativePath: source.relativePath,
        size: source.size,
        mtimeMs: source.mtimeMs,
        sourceFingerprint: fingerprint,
      });
      const mediaProbe = await probe(source.filePath);
      if (!(mediaProbe.durationSeconds > 0)) {
        throw new Error("FFprobe did not report a positive media duration.");
      }
      // HDR masters are carried through as HEVC Main 10, which has its own rate
      // policy, so storage is estimated against the codec each title will use.
      const codecFamily: RenditionCodecFamily =
        mediaProbe.video.isHdr && hdrPolicy === "preserve" ? "hevc" : "h264";
      const required = buildRenditionRequirements(mediaProbe.video);
      const existing = await inspectCompletedRendition({
        mediaRoot: path.join(paths.renditionRoot, registryItem.id),
        mediaId: registryItem.id,
        sourceFingerprint: fingerprint,
        profileVersion: RENDITION_PROFILE_VERSION,
      });
      const existingHeights =
        existing.status === "ready"
          ? (existing.metadata?.files.map((file) => file.qualityHeight) ?? [])
          : [];
      const requiredHeights = required.map((variant) => variant.qualityHeight);
      const jobs = requiredHeights
        .filter((qualityHeight) => !existingHeights.includes(qualityHeight))
        .map((qualityHeight) =>
          jobEstimate(mediaProbe.durationSeconds, qualityHeight, codecFamily),
        )
        .sort((left, right) => left.qualityHeight - right.qualityHeight);
      const status: RenditionAnalysisItem["status"] =
        existing.status === "stale"
          ? "stale"
          : existing.status === "validation-failed"
            ? "validation-failed"
            : jobs.length === 0
              ? existing.status === "ready"
                ? "already-valid"
                : "ready"
              : "pending";
      const adaptiveInspection = await inspectAdaptivePackage({
        sidecarSubtitles: await planRetainedSidecarSubtitles(source.filePath),
        /*
         * A movie's package sits beside its source; a source that shares its
         * folder with others — an episode in a season folder — has its own
         * nested root. Resolved from what is actually on disk, so this reader
         * finds either without knowing which it is looking at.
         */
        titleRoot: await resolveTitleRoot(source.filePath),
        sourceFingerprint: fingerprint,
        profileVersion: ADAPTIVE_PROFILE_VERSION,
      });
      const audioPlan = planAudioRenditions(mediaProbe);
      const adaptiveEligible =
        required.length > 0 && audioPlan.outputs.length > 0;
      const adaptiveReason =
        required.length === 0
          ? "The source is not larger than the smallest adaptive rung."
          : audioPlan.outputs.length === 0
            ? "The source has no audio stream."
            : adaptiveInspection.reason;
      const adaptiveNeedsGeneration =
        adaptiveEligible && adaptiveInspection.status !== "ready";
      const adaptiveEstimate = adaptiveNeedsGeneration
        ? estimateAdaptivePackageBytes({
            durationSeconds: mediaProbe.durationSeconds,
            qualityHeights: required.map(
              (requirement) => requirement.qualityHeight,
            ),
            codecFamily,
            audioTrackCount: audioPlan.outputs.length,
          })
        : { videoBytes: 0, audioBytes: 0, totalBytes: 0 };
      const adaptiveStatus: AdaptiveInspectionStatus = adaptiveEligible
        ? adaptiveInspection.status
        : "missing";

      registryItem.status = status;
      registryItem.adaptiveStatus = adaptiveEligible
        ? adaptiveStatus === "missing"
          ? "pending"
          : adaptiveStatus
        : "incompatible";
      registryItem.adaptiveProfileVersion = ADAPTIVE_PROFILE_VERSION;
      if (adaptiveReason) registryItem.adaptiveLastError = adaptiveReason;
      else delete registryItem.adaptiveLastError;
      items.push({
        mediaId: registryItem.id,
        relativePath: source.relativePath,
        library: source.library,
        sourceSizeBytes: source.size,
        sourceMtimeMs: source.mtimeMs,
        sourceFingerprint: fingerprint,
        status,
        probe: mediaProbe,
        existingStatus: existing.status,
        existingHeights: [...existingHeights].sort((a, b) => a - b),
        requiredHeights: [...requiredHeights].sort((a, b) => a - b),
        jobs,
        adaptive: {
          status: adaptiveStatus,
          eligible: adaptiveEligible,
          ...(adaptiveReason ? { reason: adaptiveReason } : {}),
          estimatedVideoBytes: adaptiveEstimate.videoBytes,
          estimatedAudioBytes: adaptiveEstimate.audioBytes,
          estimatedTotalBytes: adaptiveEstimate.totalBytes,
          expectedFileCount: adaptiveEligible
            ? required.length * 2 + audioPlan.outputs.length * 2 + 2
            : 0,
          expectedSegmentCount: adaptiveEligible
            ? Math.ceil(mediaProbe.durationSeconds / SEGMENT_TARGET_SECONDS) * 2
            : 0,
          isHdr: mediaProbe.video.isHdr,
        },
        ...(existing.reason ? { error: existing.reason } : {}),
      });
    } catch (error) {
      const registryItem = upsertRegistrySource(registry, {
        relativePath: source.relativePath,
        size: source.size,
        mtimeMs: source.mtimeMs,
        sourceFingerprint: fingerprint || "0".repeat(64),
      });
      registryItem.status = "failed";
      registryItem.lastError = safeErrorMessage(error);
      registryItem.adaptiveStatus = "incompatible";
      registryItem.adaptiveProfileVersion = ADAPTIVE_PROFILE_VERSION;
      registryItem.adaptiveLastError = safeErrorMessage(error);
      items.push({
        mediaId: registryItem.id,
        relativePath: source.relativePath,
        library: source.library,
        sourceSizeBytes: source.size,
        sourceMtimeMs: source.mtimeMs,
        sourceFingerprint: fingerprint || "0".repeat(64),
        status: "failed",
        existingHeights: [],
        requiredHeights: [],
        jobs: [],
        adaptive: {
          status: "missing",
          eligible: false,
          reason: safeErrorMessage(error),
          estimatedVideoBytes: 0,
          estimatedAudioBytes: 0,
          estimatedTotalBytes: 0,
          expectedFileCount: 0,
          expectedSegmentCount: 0,
          isHdr: false,
        },
        error: safeErrorMessage(error),
      });
    }
  }

  await saveRenditionRegistry(registryPath, registry);
  const actualDriveSpace = driveSpace ?? (await getDriveSpace(paths.mediaRoot));
  const configuredReserve =
    reserveBytes ?? calculateReserveBytes(actualDriveSpace.totalBytes);
  const schedulableItems = items
    .filter((item) => item.status !== "failed" && item.jobs.length > 0)
    .map((item) => ({
      mediaId: item.mediaId,
      relativePath: item.relativePath,
      library: item.library,
      jobs: item.jobs,
    }));
  const schedule = buildStorageSchedule({
    driveTotalBytes: actualDriveSpace.totalBytes,
    driveFreeBytes: actualDriveSpace.freeBytes,
    reserveBytes: configuredReserve,
    libraryOrder,
    items: schedulableItems,
  });
  const selectedIds = new Set(schedule.selected.map((item) => item.mediaId));
  const deferredIds = new Set(schedule.deferred.map((item) => item.mediaId));
  for (const item of items) {
    if (deferredIds.has(item.mediaId)) item.status = "deferred-for-storage";
    else if (selectedIds.has(item.mediaId) && item.status === "pending")
      item.status = "pending";
  }

  const sourceBytesByLibrary: Record<string, number> = {};
  const estimatedOutputBytesByLibrary: Record<string, number> = {};
  let movieCount = 0;
  let episodeCount = 0;
  let otherEligibleVideoCount = 0;
  let source2160pCount = 0;
  let source1080pCount = 0;
  let lowerResolutionSourceCount = 0;
  let existingValidRenditionCount = 0;
  let staleRenditionCount = 0;
  let validationFailureCount = 0;
  let probeFailureCount = 0;
  let hdrSourceCount = 0;
  const missingByHeight = { "480": 0, "720": 0, "1080": 0 };

  for (const item of items) {
    addRecordValue(sourceBytesByLibrary, item.library, item.sourceSizeBytes);
    addRecordValue(
      estimatedOutputBytesByLibrary,
      item.library,
      item.jobs.reduce((total, job) => total + job.estimatedBytes, 0),
    );
    const library = item.library.toLowerCase();
    if (library === "movies") movieCount += 1;
    else if (library === "series") episodeCount += 1;
    else otherEligibleVideoCount += 1;
    if (!item.probe) {
      probeFailureCount += 1;
    } else {
      if (item.probe.video.isHdr) hdrSourceCount += 1;
      const qualityHeight = classifyQualityHeight(item.probe.video);
      if (qualityHeight >= 2160) source2160pCount += 1;
      else if (qualityHeight >= 1080) source1080pCount += 1;
      else lowerResolutionSourceCount += 1;
    }
    existingValidRenditionCount += item.existingHeights.length;
    if (item.existingStatus === "stale") staleRenditionCount += 1;
    if (item.existingStatus === "validation-failed")
      validationFailureCount += 1;
    for (const job of item.jobs) {
      const key = String(job.qualityHeight) as keyof typeof missingByHeight;
      if (key in missingByHeight) missingByHeight[key] += 1;
    }
  }

  const completePlanEstimatedFinalBytes = schedulableItems.reduce(
    (total, item) =>
      total +
      item.jobs.reduce((itemTotal, job) => itemTotal + job.estimatedBytes, 0),
    0,
  );
  const completePlanConservativeFinalBytes = Math.ceil(
    completePlanEstimatedFinalBytes * (1 + DEFAULT_STORAGE_SAFETY_MARGIN),
  );
  const completePlanTemporaryPeakBytes = schedulableItems.reduce(
    (maximum, item) =>
      Math.max(maximum, ...item.jobs.map((job) => job.estimatedBytes)),
    0,
  );
  const completePlanPeakRequiredBytes =
    completePlanConservativeFinalBytes + completePlanTemporaryPeakBytes;
  const adaptiveCandidates = items.filter(
    (item) => item.adaptive.eligible && item.adaptive.status !== "ready",
  );
  const adaptiveEstimatedVideoBytes = adaptiveCandidates.reduce(
    (total, item) => total + item.adaptive.estimatedVideoBytes,
    0,
  );
  const adaptiveEstimatedSharedAudioBytes = adaptiveCandidates.reduce(
    (total, item) => total + item.adaptive.estimatedAudioBytes,
    0,
  );
  const adaptiveEstimatedTotalBytes = adaptiveCandidates.reduce(
    (total, item) => total + item.adaptive.estimatedTotalBytes,
    0,
  );
  let adaptiveBudgetBytes = Math.max(
    0,
    actualDriveSpace.freeBytes - configuredReserve,
  );
  let titlesDeferredForStorage = 0;
  for (const item of [...adaptiveCandidates].sort(
    (left, right) =>
      left.adaptive.estimatedTotalBytes - right.adaptive.estimatedTotalBytes ||
      left.relativePath.localeCompare(right.relativePath),
  )) {
    const conservative = Math.ceil(
      item.adaptive.estimatedTotalBytes * (1 + DEFAULT_STORAGE_SAFETY_MARGIN),
    );
    if (conservative <= adaptiveBudgetBytes)
      adaptiveBudgetBytes -= conservative;
    else titlesDeferredForStorage += 1;
  }
  const report: RenditionAnalysisReport = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    profileVersion: RENDITION_PROFILE_VERSION,
    policy: {
      sourceLadder:
        "classified by display long edge: 2160p=>1080p,720p,480p; 1080p=>720p,480p; 720p=>480p; never upscale or crop",
      scheduling: schedule.policy,
      safetyMarginRatio: DEFAULT_STORAGE_SAFETY_MARGIN,
      containerOverheadRatio: DEFAULT_MP4_CONTAINER_OVERHEAD_RATIO,
      audioStrategy: "default-track-only",
      subtitleStrategy: "original-playback-only",
      hdrStrategy: hdrPolicy,
    },
    summary: {
      totalEligibleVideoCount: items.length,
      totalSourceVideoBytes: items.reduce(
        (total, item) => total + item.sourceSizeBytes,
        0,
      ),
      movieCount,
      episodeCount,
      otherEligibleVideoCount,
      source2160pCount,
      source1080pCount,
      lowerResolutionSourceCount,
      existingValidRenditionCount,
      staleRenditionCount,
      validationFailureCount,
      probeFailureCount,
      hdrSourceCount,
      missingByHeight,
      sourceBytesByLibrary,
      estimatedOutputBytesByLibrary,
    },
    adaptive: {
      profileVersion: ADAPTIVE_PROFILE_VERSION,
      segmentTargetSeconds: SEGMENT_TARGET_SECONDS,
      legacyValidTitleCount: items.filter((item) =>
        ["ready", "already-valid"].includes(item.status),
      ).length,
      adaptiveValidTitleCount: items.filter(
        (item) => item.adaptive.status === "ready",
      ).length,
      titlesRequiringAdaptiveGeneration: adaptiveCandidates.length,
      incompatibleTitleCount: items.filter((item) => !item.adaptive.eligible)
        .length,
      staleAdaptiveTitleCount: items.filter(
        (item) => item.adaptive.status === "stale",
      ).length,
      sdrPackageCount: items.filter(
        (item) => item.adaptive.eligible && !item.adaptive.isHdr,
      ).length,
      hdrPackageCount: items.filter(
        (item) => item.adaptive.eligible && item.adaptive.isHdr,
      ).length,
      estimatedVideoBytes: adaptiveEstimatedVideoBytes,
      estimatedSharedAudioBytes: adaptiveEstimatedSharedAudioBytes,
      estimatedTotalBytes: adaptiveEstimatedTotalBytes,
      temporaryMigrationOverheadBytes: adaptiveEstimatedTotalBytes,
      expectedPackageCount: items.filter((item) => item.adaptive.eligible)
        .length,
      expectedMediaFileCount: items.reduce(
        (total, item) => total + item.adaptive.expectedFileCount,
        0,
      ),
      expectedSegmentRequestCount: items.reduce(
        (total, item) => total + item.adaptive.expectedSegmentCount,
        0,
      ),
      titlesDeferredForStorage,
    },
    storage: {
      ...schedule,
      driveTotalBytes: actualDriveSpace.totalBytes,
      driveFreeBytes: actualDriveSpace.freeBytes,
      completePlanEstimatedFinalBytes,
      completePlanConservativeFinalBytes,
      completePlanTemporaryPeakBytes,
      completePlanPeakRequiredBytes,
      expectedRemainingBytesForCompletePlan: Math.max(
        0,
        actualDriveSpace.freeBytes - completePlanConservativeFinalBytes,
      ),
    },
    selectedMediaIds: schedule.selected.map((item) => item.mediaId),
    deferredMediaIds: schedule.deferred.map((item) => item.mediaId),
    discoveryErrors,
    items,
  };

  if (saveReport) {
    await mkdir(path.dirname(reportPath), { recursive: true });
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }
  return report;
}

export function formatAnalysisReport(report: RenditionAnalysisReport): string {
  const formatBytes = (bytes: number) =>
    `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
  const lines = [
    "Seyirlik rendition analysis (encoding disabled)",
    `Eligible videos: ${report.summary.totalEligibleVideoCount}`,
    `Movies: ${report.summary.movieCount}; Series episodes: ${report.summary.episodeCount}; Other: ${report.summary.otherEligibleVideoCount}`,
    `Source size: ${formatBytes(report.summary.totalSourceVideoBytes)}`,
    `Sources: 2160p=${report.summary.source2160pCount}, 1080p=${report.summary.source1080pCount}, lower=${report.summary.lowerResolutionSourceCount}; HDR sources: ${report.summary.hdrSourceCount} (${report.policy.hdrStrategy === "preserve" ? "kept as HEVC Main 10" : "tone mapped to SDR"})`,
    `Missing: 1080p=${report.summary.missingByHeight["1080"]}, 720p=${report.summary.missingByHeight["720"]}, 480p=${report.summary.missingByHeight["480"]}`,
    `Existing valid variants: ${report.summary.existingValidRenditionCount}; stale items: ${report.summary.staleRenditionCount}`,
    `Estimated complete output: ${formatBytes(report.storage.completePlanConservativeFinalBytes)}`,
    `Estimated temporary peak: ${formatBytes(report.storage.completePlanTemporaryPeakBytes)}`,
    `Media volume capacity: ${formatBytes(report.storage.driveTotalBytes)}; free: ${formatBytes(report.storage.driveFreeBytes)}`,
    `Reserve: ${formatBytes(report.storage.reserveBytes)}; safely usable: ${formatBytes(report.storage.safelyUsableBytes)}`,
    `Complete plan fits: ${report.storage.completePlanFits ? "yes" : "no"}`,
    `Selected titles: ${report.selectedMediaIds.length}; deferred titles: ${report.deferredMediaIds.length}`,
    `Scheduling policy: ${report.policy.scheduling}`,
    `Adaptive profile: ${report.adaptive.profileVersion}; aligned ${report.adaptive.segmentTargetSeconds}s CMAF/HLS`,
    `Adaptive coverage: ${report.adaptive.adaptiveValidTitleCount}/${report.adaptive.expectedPackageCount} eligible titles; generation needed: ${report.adaptive.titlesRequiringAdaptiveGeneration}; incompatible: ${report.adaptive.incompatibleTitleCount}`,
    `Adaptive migration estimate: ${formatBytes(report.adaptive.estimatedTotalBytes)} (${formatBytes(report.adaptive.estimatedVideoBytes)} video + ${formatBytes(report.adaptive.estimatedSharedAudioBytes)} shared audio)`,
    `Adaptive storage deferrals: ${report.adaptive.titlesDeferredForStorage}; media files after completion: ${report.adaptive.expectedMediaFileCount}`,
    "No rendition processing was started.",
  ];
  return lines.join("\n");
}
