/**
 * Produces one adaptive package, from probe to activated pointer.
 *
 * The lifecycle is the same shape as the legacy processor's and for the same
 * reason: a package is built in an isolated work directory, measured, validated
 * as a whole, and only then promoted and pointed at. Nothing ever writes into a
 * directory a playback session might currently be reading, and a failed run
 * leaves the previously active package — legacy or adaptive — exactly as it was.
 *
 * The unit of *work*, however, is no longer the whole package. The timeline is
 * cut into nominal five-minute epochs, each encoded by one FFmpeg process that
 * reads and decodes the source once and produces every rung of the ladder for
 * that stretch. An epoch that finishes is validated, manifested and renamed
 * into place, and from that moment it is immutable: a crash, a cancel, an
 * unplugged drive or a restarted server costs at most the epoch that was
 * running. Assembly then joins those epochs into the final renditions by
 * copying bytes — no decoder, no encoder, not even a remux — so the recovery
 * story does not cost a second transcode at the end.
 */

import { readFile, rm, stat, statfs, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolvePublishedTitleRoot } from "./publishedRoot";
import { SEGMENT_TARGET_SECONDS } from "../../lib/playback-planner/gopPolicy";
import { UNKNOWN_LANGUAGE } from "../processing/languages";
import type { PauseController } from "../processing/pauseController";
import {
  sidecarSubtitleIsCurrent,
  type SidecarSubtitle,
} from "./sidecarSubtitles";
import type { DriveSpace, RenditionPaths } from "../analysis";
import { getDriveSpace } from "../analysis";
import {
  codecFamilyForEncoder,
  getEncodingPolicy,
  resolveVideoEncoder,
  type RenditionEncoderPreference,
  type RenditionHdrSignal,
  type RenditionVideoEncoder,
} from "../encoding";
import { acquireDirectoryLock } from "../locks";
import { DEFAULT_STORAGE_SAFETY_MARGIN } from "../planning";
import {
  buildRenditionRequirements,
  classifyQualityHeight,
  getDisplayDimensions,
} from "../policy";
import type { RenditionMediaProbe } from "../probe";
import { probeMediaFile } from "../probe";
import type { RenditionProgressReporter } from "../progress";
import { parseFfmpegProgressFields } from "../progress";
import {
  canStreamCopyAudio,
  deliveryChannelsFor,
  type AdaptiveAudioOutput,
  type AdaptiveVideoOutput,
} from "./encoding";
import type {
  AdaptiveAudioRenditionMetadata,
  AdaptiveHdrState,
  AdaptivePackageMetadata,
  AdaptiveSubtitleRenditionMetadata,
  AdaptiveVideoRenditionMetadata,
} from "./metadata";
import { buildMasterPlaylist, parseMediaPlaylist } from "./playlist";
import {
  audioCodecString,
  probePackagedAudio,
  probePackagedVideo,
} from "./probePackaged";
import {
  ADAPTIVE_AUDIO_DIRECTORY,
  ADAPTIVE_MASTER_PLAYLIST,
  ADAPTIVE_MEDIA_FILE,
  ADAPTIVE_METADATA_FILE,
  ADAPTIVE_METADATA_SCHEMA_VERSION,
  ADAPTIVE_PLAYLIST_FILE,
  ADAPTIVE_PROFILE_VERSION,
  ADAPTIVE_SUBTITLE_DIRECTORY,
  ADAPTIVE_SUBTITLE_FILE,
  ADAPTIVE_VIDEO_DIRECTORY,
  ALIGNMENT_EPSILON_SECONDS,
  AUDIO_DURATION_TOLERANCE_SECONDS,
  audioRenditionId,
  subtitleRenditionId,
  videoRenditionId,
} from "./profile";
import { frameRateForClass } from "./layout";
import { probeTitleRates, readStoredRateProbe } from "./rateProbe";
import { besideTitleRoot } from "./titleRoot";
import {
  publishAdditionalRenditions,
  publishTitlePackage,
  readTitleBuildRecord,
  readTitlePackageManifest,
  TITLE_INCOMING_DIRECTORY,
  type TitlePackageManifest,
} from "./publishTitle";
import { validateAdaptivePackage } from "./validation";
import {
  createByteRateEstimator,
  etaFromRate,
  safeFraction,
  VERIFICATION_STALE_MS,
  type AssemblyPhaseProgress,
  type PublishPhaseProgress,
} from "./phaseProgress";
import {
  defaultSoftwareEncoderThreads,
  defaultSoftwareFilterThreads,
} from "../../server/cpuTopology";
import {
  planPackageWork,
  type PackageWorkPlan,
  type RenditionPresence,
} from "./incrementalPlan";
import { buildWebVttMediaPlaylist, extractWebVttFile } from "./subtitles";
import {
  audioStagePath,
  checkpointBytes,
  checkpointRoot,
  listCompletedEpochIndexes,
  reconcilePlan,
} from "./epochs/checkpoints";
import type { ClassifiedFailure } from "./epochs/failure";
import type {
  StorageIdentityProbe,
  VolumeIdentity,
} from "../processing/storageIdentity";
import {
  DEFAULT_EPOCH_TARGET_SECONDS,
  EPOCH_TIMELINE_POLICY_VERSION,
} from "./epochs/policy";
import { buildEpochPlan, nominalEpochBoundaries } from "./epochs/plan";
import { probeSourceFrameTimeline } from "./epochs/sourceTimeline";
import { runEpochBuild, type SourceProbeWindow } from "./epochs/engine";
import { ensureAudioStage } from "./epochs/audioStage";
import { assembleVideoRenditions, copyStageDirectory } from "./epochs/assemble";
import { epochProgress } from "./epochs/progress";
import {
  AudioStageError,
  classifyFailure,
  MediaProgressTimeoutError,
  SourceReadError,
  StorageInterruptedError,
  type ProcessingFailureKind,
} from "./epochs/failure";
import { stallThresholds, type StallThresholds } from "./epochs/stallPolicy";
import type { SourceProbeOutcome } from "./epochs/sourceIo";
import { probeSourceRangeReadable } from "./epochs/sourceReadProbe";
import {
  damageIntervalOf,
  describeInterval,
  mergeIntervals,
  sourceDamagePolicyFromEnvironment,
  type SourceDamagePolicy,
  type SourceDamageRecord,
  type SourceInterval,
} from "./epochs/salvage";
import {
  assertOwnedJobWorkspace,
  assertWorkspaceId,
  assertClaimedWorkspace,
  claimJobWorkspace,
  JOB_WORKSPACE_OWNER_FILE,
  mkdirWithinWorkspace,
  ScratchStorageLostError,
  verifyOwnedJobWorkspace,
  type ClaimedWorkspace,
} from "../storageRoles";

/**
 * Whether a title still holds every file its manifest names.
 *
 * A manifest alone is not proof: a half-deleted folder would otherwise be
 * reported as current and then fail on the first request.
 */
/**
 * Which published renditions are individually intact.
 *
 * `titlePackageFilesPresent` answers for the package as a whole, which is the
 * right question when deciding whether to skip everything and the wrong one
 * when deciding what to build: a single truncated rendition would condemn the
 * other seven to a needless re-encode. This reports per rendition so the plan
 * can rebuild exactly the broken one.
 */
async function titleRenditionPresence(
  titleRoot: string,
  manifest: TitlePackageManifest,
): Promise<RenditionPresence> {
  titleRoot = await resolvePublishedTitleRoot(titleRoot);
  const intact = async (relatives: readonly string[]): Promise<boolean> => {
    for (const relative of relatives) {
      const stats = await stat(
        path.join(titleRoot, ...relative.split("/")),
      ).catch(() => undefined);
      if (!stats?.isFile() || stats.size === 0) return false;
    }
    return true;
  };
  const collect = async (
    renditions: readonly {
      id: string;
      mediaPath: string;
      playlistPath: string;
    }[],
  ): Promise<Set<string>> => {
    const present = new Set<string>();
    for (const rendition of renditions) {
      if (await intact([rendition.mediaPath, rendition.playlistPath])) {
        present.add(rendition.id);
      }
    }
    return present;
  };
  return {
    video: await collect(manifest.video),
    audio: await collect(manifest.audio),
    subtitle: await collect(manifest.subtitle),
  };
}

/**
 * A matching source/profile is not enough to skip packaging: the ladder can
 * gain a rung without invalidating the renditions already on disk. In that
 * case the package is still playable, but it is not complete for today's
 * policy and must go through the encoder.
 */
export function titlePackageCoversVideoLadder(
  manifest: { video: readonly { qualityHeight: number }[] },
  requirements: readonly { qualityHeight: number }[],
): boolean {
  const present = new Set(
    manifest.video.map((rendition) => rendition.qualityHeight),
  );
  return requirements.every((requirement) =>
    present.has(requirement.qualityHeight),
  );
}

export type AdaptivePackageStatus =
  | "ready"
  | "already-valid"
  | "failed"
  | "validation-failed"
  | "deferred-for-storage"
  | "interrupted"
  | "incompatible"
  | "dry-run";

export interface AdaptivePackageResult {
  mediaId: string;
  relativePath: string;
  status: AdaptivePackageStatus;
  versionDirectory?: string;
  error?: string;
  /** Populated when validation ran and produced findings. */
  issues?: string[];
  storageBytes?: number;
  /**
   * Why an `interrupted` run stopped.
   *
   * A cancellation and a vanished volume both end the encoder the same way, and
   * conflating them is what turned an accidental unplug into a permanently
   * failed job. The caller needs to know which happened to choose between
   * "cancelled" and "waiting for the drive".
   */
  interruption?: "cancelled" | "storage";
  /**
   * Bytes this run actually produced, as against `storageBytes` which is the
   * whole published package. They are the same for a full build and very
   * different for an incremental one — a job that added a single rung must not
   * report the size of the seven it reused.
   */
  jobOutputBytes?: number;
  /**
   * Intervals that were replaced because the source could not supply them.
   *
   * Present, and non-empty, only for a salvaged encode. A `ready` result
   * carrying these is not the same thing as a clean one, and every reader —
   * the job record, the API, the page — is expected to say so.
   */
  sourceDamage?: SourceDamageRecord[];
  /**
   * What kind of failure this was, for a caller that must not parse prose.
   *
   * The queue's decision — requeue this, or stop — turns on the difference
   * between "a lock was held" and "this region of the disk will never read",
   * and a job that guessed from an error message is a job that eventually
   * guesses wrong. It guessed wrong once already, and re-attacked a damaged
   * platter for its trouble.
   */
  failureKind?: ProcessingFailureKind;
  /** Owned scratch workspace retained until the job success row is committed. */
  workspaceDirectory?: string;
  /**
   * The volume the workspace was claimed on, for the caller to persist.
   *
   * Returned on the first successful claim so the job record can remember it;
   * every later attempt passes it back as `expectedScratchIdentity`.
   */
  scratchIdentity?: VolumeIdentity | null;
  /** Hidden HDD staging retained until the job success commit. */
  publicationIncomingDirectory?: string;
}

/** One reading of where the package goes, shared by every step below. */
function titleRootForRequest(request: AdaptivePackageRequest): string {
  return request.titleRoot ?? besideTitleRoot(request.sourcePath);
}

export interface AdaptivePackageRequest {
  mediaId: string;
  relativePath: string;
  sourceFingerprint: string;
  sourcePath: string;
  probe?: RenditionMediaProbe;
  /** Stable domain-job id. Offline callers fall back to the media id. */
  workspaceId?: string;
  /**
   * Where this title's package lives on the media volume.
   *
   * Defaults to the directory beside the source, which for a movie folder is
   * the title itself. An episode's season folder is not: it holds every
   * episode of the season, so an episode is given its own nested root (see
   * `titleRoot.ts`) and passes it here rather than letting this layer guess
   * from a path that cannot tell the two cases apart.
   */
  titleRoot?: string;
}

export interface AdaptivePackagerOptions {
  /** The publication filesystem boundary; encoding and validation stay real. */
  publicationFileSystem?: Pick<typeof import("node:fs/promises"), "rename">;
  ffmpegPath?: string;
  ffprobePath?: string;
  encoderPreference?: RenditionEncoderPreference;
  videoEncoder?: RenditionVideoEncoder;
  hdrVideoEncoder?: RenditionVideoEncoder;
  reserveBytes: number;
  segmentSeconds?: number;
  preset?: string;
  /**
   * Measure this title's rates before encoding (see `rateProbe.ts`). On by
   * default; it only ever acts for rate-targeted encoders with `libvmaf`.
   */
  rateProbe?: boolean;
  /** Explicit software CPU budget; automatic topology detection is the default. */
  softwareThreads?: number;
  /**
   * Package every source audio track rather than only the default one. The
   * schema and master generator always support several; this decides how many a
   * given run actually encodes.
   */
  allAudioTracks?: boolean;
  /** Source audio stream indexes the retention policy chose, in order. */
  audioStreamIndexes?: readonly number[];
  /** Text subtitle stream indexes the retention policy chose for WebVTT. */
  subtitleStreamIndexes?: readonly number[];
  /**
   * Suspends the encoder while paused instead of killing it, so a pause keeps
   * the work already done rather than costing the whole ladder.
   */
  pauseController?: PauseController;
  /**
   * Subtitle files sitting beside the source that the policy chose to package.
   *
   * Most of this library is subtitled this way rather than in-container, so a
   * packager that only reads embedded streams publishes titles with no
   * subtitles at all in a language it was told to retain.
   */
  sidecarSubtitles?: readonly SidecarSubtitle[];
  /**
   * Nominal epoch length. Five minutes in production; tests shorten it so an
   * integration run crosses several boundaries in a few seconds of fixture.
   */
  epochTargetSeconds?: number;
  /**
   * Whether every root this job needs is answering right now.
   *
   * Consulted only when something fails, and it is the deciding evidence: an
   * `ENOENT` on an output path is a vanished volume when the volume is gone and
   * a genuinely missing file when it is not, and no error message distinguishes
   * them.
   */
  storageAvailable?: () => boolean | Promise<boolean>;
  /** Which roots failed their last check, so the reason names the drive. */
  missingRoots?: () => readonly string[];
  /** Persists a hard storage fault before any retry/probe can be launched. */
  onHardStorageFault?: (failure: ClassifiedFailure) => Promise<void>;
  /** Reads the volume identity of a path. Injected; `diskutil` in production. */
  probeScratchIdentity?: StorageIdentityProbe;
  /**
   * The scratch volume this job recorded when it first claimed a workspace.
   *
   * Supplied by the caller from durable storage, so a worker that restarted
   * while the disk was absent still knows which volume the job is waiting for.
   */
  expectedScratchIdentity?: VolumeIdentity | null;
  /**
   * Waits between re-reading a source that returned an I/O error.
   *
   * Long enough by default to outlast a watchdog poll, so a drive that has
   * genuinely gone is recognised as gone rather than blamed on the media.
   * Tests shorten it; nothing else should.
   */
  sourceIoBackoffMs?: readonly number[];
  driveSpaceProvider?: () => Promise<DriveSpace>;
  runEncoder?: (
    command: string,
    args: string[],
    options: {
      signal?: AbortSignal;
      logPath: string;
      onProgress?: (
        progress: ReturnType<typeof parseFfmpegProgressFields>,
      ) => void;
      /** FFmpeg's own words, so a clean exit is not mistaken for a clean read. */
      onStderr?: (chunk: string) => void;
      pauseController?: PauseController;
    },
  ) => Promise<void>;
  /**
   * What to do when part of the source cannot be read at all.
   *
   * Defaults to the environment's policy, which itself defaults to `fail` —
   * the behaviour that existed before salvage did. `replace-epoch` substitutes
   * black picture and silence of exactly the planned length for an unreadable
   * interval and publishes the rest of the title, with the substitution
   * recorded as a warning that follows the job to the page.
   */
  sourceDamagePolicy?: SourceDamagePolicy;
  /**
   * How long an encoder may produce nothing before it is stopped.
   *
   * Read from the deployment's policy by default. Injected by tests, which
   * cannot spend half a minute proving that a watchdog fires.
   */
  stalls?: StallThresholds;
  /**
   * The readability check, when something other than a real read is wanted.
   *
   * Injected by tests so the window the engine asks about can be observed
   * without a disk that fails on demand. Production always uses the real one.
   */
  verifySourceReadable?: (
    window: SourceProbeWindow,
  ) => Promise<SourceProbeOutcome>;
  onEvent?: RenditionProgressReporter;
  verifySourceFingerprint?: boolean;
  signal?: AbortSignal;
  dryRun?: boolean;
  /** Server jobs clean only after their database success commit. */
  retainWorkspaceAfterPublish?: boolean;
}

/**
 * Whether a variable-frame-rate source can be packaged deterministically.
 *
 * `avg_frame_rate` and `r_frame_rate` diverging is the usual signature of VFR
 * or of a container whose timestamps are irregular. Forced keyframes are placed
 * on presentation time rather than frame counts, so such a source can still be
 * cut on exact two-second boundaries — but the claim is proved by validation
 * afterwards, not assumed here.
 */
export function isVariableFrameRate(probe: RenditionMediaProbe): boolean {
  const average = probe.video.frameRate;
  if (!average || !Number.isFinite(average)) return true;
  const maximum = probe.video.maxFrameRate;
  if (!maximum || !Number.isFinite(maximum)) return false;
  return Math.abs(maximum - average) / average > 0.01;
}

function hdrStateFor(probe: RenditionMediaProbe): AdaptiveHdrState {
  if (!probe.video.isHdr) return "sdr";
  return probe.video.colorTransfer?.toLowerCase() === "arib-std-b67"
    ? "hlg"
    : "hdr10";
}

/**
 * Audio tracks that become renditions, and the ones deliberately left out.
 *
 * The default track always leads. Unsupported codecs are transcoded rather than
 * dropped, because a package whose only audio is a format the browser cannot
 * decode is a package that silently plays silent.
 */
export function planAudioRenditions(
  probe: RenditionMediaProbe,
  {
    allTracks = false,
    streamIndexes,
  }: {
    allTracks?: boolean;
    /**
     * Exactly which source tracks to package, decided by the retention policy.
     *
     * Takes precedence over `allTracks`. The policy knows which language is the
     * source default and which duplicates to drop; the packager only has to
     * carry out that decision. An index the source does not have is ignored
     * rather than failing the encode.
     */
    streamIndexes?: readonly number[];
  } = {},
): { outputs: AdaptiveAudioOutput[]; deferred: number[] } {
  const tracks = probe.audioTracks;
  if (tracks.length === 0) {
    return { outputs: [], deferred: [] };
  }
  const defaultTrack = tracks.find((track) => track.isDefault) ?? tracks[0];
  // Mapped in the order the policy asked for, not the order the container
  // stores them in: the first rendition becomes the package default, and that
  // has to be the track the policy chose as the source's own default.
  const requested = streamIndexes
    ? streamIndexes
        .map((index) => tracks.find((track) => track.streamIndex === index))
        .filter(
          (track): track is (typeof tracks)[number] => track !== undefined,
        )
    : undefined;
  const selected =
    requested && requested.length > 0
      ? requested
      : allTracks
        ? tracks
        : [defaultTrack];
  const deferred = tracks
    .filter((track) => !selected.includes(track))
    .map((track) => track.streamIndex);

  const outputs = selected.map<AdaptiveAudioOutput>((track) => {
    const channels = track.channels ?? 2;
    // The rate follows the layout that is actually delivered, not the source
    // one, so a downmixed 7.1 track is not paid for at 7.1 rates.
    const deliveryChannels = deliveryChannelsFor(channels);
    return {
      sourceStreamIndex: track.streamIndex,
      action: canStreamCopyAudio({ codec: track.codec, channels })
        ? "copy"
        : "transcode",
      channels: deliveryChannels,
      bitrate: deliveryChannels > 2 ? 256_000 : 192_000,
      ...(track.language ? { language: track.language } : {}),
      ...(track.title ? { title: track.title } : {}),
      isDefault:
        track.streamIndex === (selected[0] ?? defaultTrack).streamIndex,
      isForced: false,
    };
  });

  return { outputs, deferred };
}

async function runFfmpegProcess(
  command: string,
  args: string[],
  options: {
    signal?: AbortSignal;
    logPath: string;
    onProgress?: (
      progress: ReturnType<typeof parseFfmpegProgressFields>,
    ) => void;
    pauseController?: PauseController;
  },
): Promise<void> {
  const { runFfmpeg } = await import("../processor");
  return runFfmpeg(command, args, options);
}

/**
 * Bitrate figures measured from the packaged bytes.
 *
 * `average` is the whole rendition; `peak` is the busiest single segment, which
 * is what a player must be able to sustain to avoid stalling on the hardest two
 * seconds of the title. Using the configured rate cap instead would advertise
 * the same number for every title regardless of content.
 */
export function measureBitrates(playlistText: string): {
  averageBitrate: number;
  peakBitrate: number;
  segmentCount: number;
  durationSeconds: number;
  mediaBytes: number;
} {
  const playlist = parseMediaPlaylist(playlistText);
  let peak = 0;
  let payloadBytes = 0;
  for (const segment of playlist.segments) {
    payloadBytes += segment.byteRange.length;
    const rate = (segment.byteRange.length * 8) / segment.durationSeconds;
    if (rate > peak) peak = rate;
  }
  const durationSeconds = playlist.totalDurationSeconds;
  return {
    averageBitrate: Math.max(
      1,
      Math.round((payloadBytes * 8) / durationSeconds),
    ),
    peakBitrate: Math.max(1, Math.round(peak)),
    segmentCount: playlist.segments.length,
    durationSeconds,
    mediaBytes: payloadBytes + playlist.map.byteRange.length,
  };
}

function keyframeSummary(
  keyframeTimes: number[],
  target: number,
): AdaptiveVideoRenditionMetadata["keyframeIntervalSeconds"] {
  if (keyframeTimes.length < 2) {
    return { target, minimum: target, maximum: target, mean: target };
  }
  const gaps: number[] = [];
  for (let index = 1; index < keyframeTimes.length; index += 1) {
    gaps.push(keyframeTimes[index] - keyframeTimes[index - 1]);
  }
  const total = gaps.reduce((sum, gap) => sum + gap, 0);
  return {
    target,
    minimum: Math.max(0.0001, Math.min(...gaps)),
    maximum: Math.max(...gaps),
    mean: Math.max(0.0001, total / gaps.length),
  };
}

/**
 * Estimated package size, used only for the free-space preflight.
 *
 * Video is estimated per rung as before, but audio is counted once for the
 * whole package rather than once per rung — which is the storage difference the
 * shared-audio layout buys and the reason the adaptive estimate is materially
 * lower than the legacy one for the same ladder.
 */
export function estimateAdaptivePackageBytes({
  durationSeconds,
  qualityHeights,
  codecFamily,
  audioTrackCount = 1,
}: {
  durationSeconds: number;
  qualityHeights: number[];
  codecFamily: "h264" | "hevc";
  audioTrackCount?: number;
}): { videoBytes: number; audioBytes: number; totalBytes: number } {
  const videoBytes = qualityHeights.reduce((total, height) => {
    const policy = getEncodingPolicy(height, codecFamily);
    return (
      total + Math.ceil((durationSeconds * policy.expectedVideoBitrate) / 8)
    );
  }, 0);
  const audioBytes = Math.ceil(
    (durationSeconds * 192_000 * Math.max(1, audioTrackCount)) / 8,
  );
  // CMAF fragmentation carries more box overhead than a progressive MP4: an
  // moof per two-second fragment rather than one moov for the file.
  const totalBytes = Math.ceil((videoBytes + audioBytes) * 1.02);
  return { videoBytes, audioBytes, totalBytes };
}

/**
 * What a restart can learn about an unfinished publication, read from scratch.
 *
 * The marker alone is not enough to trust. It records that the package was
 * complete and verified when it was written, but the volume holding it may
 * have been unplugged, filled, or partly cleaned since. So every file the
 * package's own build record names is checked for presence and for the exact
 * size recorded for it — cheap metadata reads, no hashing — and anything that
 * disagrees sends the job back to its checkpoints rather than into a
 * publication that would copy a truncated file.
 *
 * Content equality is not re-established here and does not need to be: the
 * copy itself compares each destination file against this one before it
 * accepts it.
 */
/**
 * Where a job's finished, verified scratch package and its marker live.
 * Shared by the packager's own resume and by planning, which must not demand
 * scratch space for a package that is already built.
 */
function verifiedPackagePaths(
  workspaceDirectory: string,
  sourceFingerprint: string,
): { marker: string; workVersionRoot: string } {
  const versionDirectory = `${ADAPTIVE_PROFILE_VERSION}-${sourceFingerprint.slice(0, 16)}`;
  return {
    marker: path.join(workspaceDirectory, ".verified-package.json"),
    workVersionRoot: path.join(
      workspaceDirectory,
      `${versionDirectory}.verified-package`,
    ),
  };
}

/**
 * Whether this job's workspace already holds a verified package for this
 * source: the state a restart finds when only publishing remained. Publishing
 * copies to the media volume, whose space the publisher checks itself, so such
 * a job needs no new scratch at all.
 */
export async function hasVerifiedScratchPackage({
  workRoot,
  workspaceId,
  sourceFingerprint,
}: {
  workRoot: string;
  workspaceId: string;
  sourceFingerprint: string;
}): Promise<boolean> {
  const workspaceDirectory = assertOwnedJobWorkspace(
    workRoot,
    path.join(workRoot, assertWorkspaceId(workspaceId)),
  );
  return (
    (await readVerifiedScratchPackage({
      ...verifiedPackagePaths(workspaceDirectory, sourceFingerprint),
      sourceFingerprint,
    })) !== null
  );
}

/**
 * Bytes in this job's scratch package that a rebuild will remove first.
 *
 * A package assembled but not yet marked verified — the state a restart finds
 * mid-validation — is deleted before the packager re-assembles from its
 * checkpoints. Planning must count those bytes as space that will come back,
 * or it demands room for a copy it is about to free: a restart during
 * validation then failed a finished 4-hour encode on disk space. A verified
 * package is not counted; it is published as it is, and planning already
 * asks no scratch for it.
 */
export async function replaceableScratchPackageBytes({
  workRoot,
  workspaceId,
  sourceFingerprint,
}: {
  workRoot: string;
  workspaceId: string;
  sourceFingerprint: string;
}): Promise<number> {
  const workspaceDirectory = assertOwnedJobWorkspace(
    workRoot,
    path.join(workRoot, assertWorkspaceId(workspaceId)),
  );
  const paths = verifiedPackagePaths(workspaceDirectory, sourceFingerprint);
  if (
    (await readVerifiedScratchPackage({ ...paths, sourceFingerprint })) !== null
  )
    return 0;
  return checkpointBytes(paths.workVersionRoot);
}

async function readVerifiedScratchPackage({
  marker,
  workVersionRoot,
  sourceFingerprint,
}: {
  marker: string;
  workVersionRoot: string;
  sourceFingerprint: string;
}): Promise<{
  metadata: AdaptivePackageMetadata;
  mode: "full" | "incremental";
  sourceDamage: SourceDamageRecord[];
} | null> {
  const record = await readFile(marker, "utf8")
    .then((raw) => JSON.parse(raw) as Record<string, unknown>)
    .catch(() => null);
  if (
    !record ||
    record.sourceFingerprint !== sourceFingerprint ||
    record.profileVersion !== ADAPTIVE_PROFILE_VERSION ||
    record.packageDirectory !== path.basename(workVersionRoot)
  ) {
    return null;
  }

  const metadata = await readFile(
    path.join(workVersionRoot, ADAPTIVE_METADATA_FILE),
    "utf8",
  )
    .then((raw) => JSON.parse(raw) as AdaptivePackageMetadata)
    .catch(() => null);
  if (!metadata) return null;

  for (const rendition of [
    ...(metadata.videoRenditions ?? []),
    ...(metadata.audioRenditions ?? []),
  ]) {
    const stats = await stat(
      path.join(workVersionRoot, ...rendition.mediaPath.split("/")),
    ).catch(() => null);
    if (!stats?.isFile() || stats.size !== rendition.fileSizeBytes) return null;
  }
  for (const rendition of metadata.subtitleRenditions ?? []) {
    const stats = await stat(
      path.join(workVersionRoot, ...rendition.subtitlePath.split("/")),
    ).catch(() => null);
    if (!stats?.isFile() || stats.size === 0) return null;
  }

  return {
    metadata,
    mode: record.mode === "incremental" ? "incremental" : "full",
    sourceDamage: Array.isArray(record.sourceDamage)
      ? (record.sourceDamage as SourceDamageRecord[])
      : [],
  };
}

export async function packageAdaptiveRendition(
  request: AdaptivePackageRequest,
  paths: RenditionPaths,
  {
    ffmpegPath = process.env.FFMPEG_PATH ??
      process.env.SEYIRLIK_FFMPEG_PATH ??
      "ffmpeg",
    ffprobePath = process.env.FFPROBE_PATH ??
      process.env.SEYIRLIK_FFPROBE_PATH ??
      "ffprobe",
    encoderPreference = "auto",
    videoEncoder,
    hdrVideoEncoder,
    reserveBytes,
    segmentSeconds = SEGMENT_TARGET_SECONDS,
    preset,
    rateProbe = true,
    softwareThreads = defaultSoftwareEncoderThreads(),
    allAudioTracks = false,
    audioStreamIndexes,
    subtitleStreamIndexes = [],
    sidecarSubtitles = [],
    pauseController,
    epochTargetSeconds = DEFAULT_EPOCH_TARGET_SECONDS,
    storageAvailable,
    onHardStorageFault,
    probeScratchIdentity,
    expectedScratchIdentity,
    sourceIoBackoffMs,
    missingRoots,
    driveSpaceProvider = () => getDriveSpace(paths.workRoot),
    runEncoder = runFfmpegProcess,
    sourceDamagePolicy = sourceDamagePolicyFromEnvironment(),
    stalls = stallThresholds(),
    verifySourceReadable,
    onEvent,
    verifySourceFingerprint = true,
    signal,
    dryRun = false,
    retainWorkspaceAfterPublish = false,
    publicationFileSystem,
  }: AdaptivePackagerOptions,
): Promise<AdaptivePackageResult> {
  const base = { mediaId: request.mediaId, relativePath: request.relativePath };
  const workspaceId = assertWorkspaceId(request.workspaceId ?? request.mediaId);
  const workspaceDirectory = assertOwnedJobWorkspace(
    paths.workRoot,
    path.join(paths.workRoot, workspaceId),
  );

  if (signal?.aborted) return { ...base, status: "interrupted" };
  if (dryRun) return { ...base, status: "dry-run" };
  /** Set once this job's own marker is on scratch. See the failure path. */
  let workspaceClaimed = false;
  /**
   * The workspace once it is claimed, bound to the filesystem it was claimed
   * on. Every later scratch operation is checked against this.
   */
  let workspaceClaim: ClaimedWorkspace | undefined;
  /** Cleared unconditionally on the way out; see the scratch watch below. */
  let scratchPoll: ReturnType<typeof setInterval> | undefined;

  const lock = await acquireDirectoryLock(
    path.join(paths.stateRoot, "locks", `${request.mediaId}.adaptive.lock`),
    `adaptive:${request.mediaId}`,
  );

  const versionDirectory = `${ADAPTIVE_PROFILE_VERSION}-${request.sourceFingerprint.slice(0, 16)}`;

  try {
    const sourceStats = await stat(request.sourcePath);
    if (!sourceStats.isFile()) {
      throw new Error("The configured source path is not a media file.");
    }
    workspaceClaim = await claimJobWorkspace(
      paths.workRoot,
      workspaceDirectory,
      {
        workspaceId,
        sourceFingerprint: request.sourceFingerprint,
      },
      {
        ...(probeScratchIdentity
          ? { probeIdentity: probeScratchIdentity }
          : {}),
        ...(expectedScratchIdentity
          ? { expectedIdentity: expectedScratchIdentity }
          : {}),
      },
    );
    /*
     * From here on, this job owns a directory on scratch and has proven it by
     * writing a marker into it. That fact is what the failure path below uses
     * to tell a vanished volume from a missing file.
     */
    workspaceClaimed = true;
    /**
     * The one check every scratch operation goes through.
     *
     * Cheap — a `stat` and a small read — so it can sit in front of directory
     * creation, each epoch, each promotion, assembly, verification and
     * publication without being felt.
     */
    const assertScratch = async (
      options: { deep?: boolean } = {},
    ): Promise<void> => {
      await assertClaimedWorkspace(workspaceClaim!, options);
    };
    const writeProbe = path.join(workspaceDirectory, ".writable-probe");
    await writeFile(writeProbe, "seyirlik", { encoding: "utf8", flag: "w" });
    await rm(writeProbe, { force: true });

    const probe =
      request.probe ??
      (await probeMediaFile(request.sourcePath, ffprobePath, signal));
    if (!(probe.durationSeconds > 0)) {
      return {
        ...base,
        status: "incompatible",
        error: "The source does not report a positive duration.",
      };
    }

    const requirements = buildRenditionRequirements(probe.video);
    if (requirements.length === 0) {
      return {
        ...base,
        status: "incompatible",
        error:
          "The source does not report usable video dimensions, so no ladder can be built from it.",
      };
    }

    /*
     * A title that already holds a package built from these exact bytes under
     * this exact profile and containing every rung required today is left
     * alone. This is what makes `resume` cheap without mistaking an older,
     * shorter ladder for a complete one.
     */
    const existingTitleRoot = titleRootForRequest(request);
    const existing = await readTitlePackageManifest(existingTitleRoot);
    const presence: RenditionPresence = existing
      ? await titleRenditionPresence(existingTitleRoot, existing)
      : { video: new Set(), audio: new Set(), subtitle: new Set() };
    // A synthetic index is a position in a directory listing, not an identity.
    // Adding a file can put a different translation at an already published id.
    const reusableSubtitles = new Set(presence.subtitle);
    for (const sidecar of sidecarSubtitles) {
      const id = subtitleRenditionId(sidecar.streamIndex);
      if (
        !sidecarSubtitleIsCurrent(
          sidecar,
          existing?.subtitle.find((track) => track.id === id),
        )
      ) {
        reusableSubtitles.delete(id);
      }
    }

    if (verifySourceFingerprint) {
      const { computeSourceFingerprint } = await import("../registry");
      const sourceStats = await stat(request.sourcePath);
      const current = await computeSourceFingerprint(
        request.sourcePath,
        sourceStats,
      );
      if (current !== request.sourceFingerprint) {
        throw new Error(
          "Source changed after analysis; run analysis again before packaging.",
        );
      }
    }

    const audioPlan = planAudioRenditions(probe, {
      allTracks: allAudioTracks,
      ...(audioStreamIndexes ? { streamIndexes: audioStreamIndexes } : {}),
    });
    if (audioPlan.outputs.length === 0) {
      return {
        ...base,
        status: "incompatible",
        error:
          "The source has no audio stream, which an adaptive package requires.",
      };
    }

    /*
     * What actually has to be built, per rendition.
     *
     * Everything below encodes from `work`, never from `requirements`. That is
     * the whole fix: the desired ladder describes the finished package, while
     * this describes the outstanding job, and handing the first to the encoder
     * is what rebuilt seven good renditions to obtain an eighth.
     */
    const work: PackageWorkPlan = planPackageWork({
      requirements,
      existing,
      presence: { ...presence, subtitle: reusableSubtitles },
      sourceFingerprint: request.sourceFingerprint,
      profileVersion: ADAPTIVE_PROFILE_VERSION,
      requiredAudioStreamIndexes: audioPlan.outputs.map(
        (output) => output.sourceStreamIndex,
      ),
      requiredSubtitleStreamIndexes: [
        ...subtitleStreamIndexes,
        // Sidecar files are published as subtitle renditions like any other,
        // so they are reusable on the same terms.
        ...sidecarSubtitles.map((sidecar) => sidecar.streamIndex),
      ],
    });

    if (work.mode === "none" && existing) {
      const finalValidation = await validateAdaptivePackage({
        versionRoot: existingTitleRoot,
        mediaId: request.mediaId,
        sourceFingerprint: request.sourceFingerprint,
        profileVersion: ADAPTIVE_PROFILE_VERSION,
        ffprobePath,
        ffmpegPath,
        deep: true,
        ...(signal ? { signal } : {}),
      });
      if (!finalValidation.ok) {
        return {
          ...base,
          status: "validation-failed",
          error:
            "An existing final package matched the job record but did not pass recovery validation.",
          issues: finalValidation.issues.map((issue) => issue.message),
          workspaceDirectory,
          scratchIdentity: workspaceClaim?.identity ?? null,
        };
      }
      return {
        ...base,
        status: "already-valid",
        versionDirectory,
        storageBytes: existing.storage.totalBytes,
        workspaceDirectory,
        scratchIdentity: workspaceClaim?.identity ?? null,
        ...((await stat(
          path.join(existingTitleRoot, TITLE_INCOMING_DIRECTORY, workspaceId),
        ).catch(() => null))
          ? {
              publicationIncomingDirectory: path.join(
                existingTitleRoot,
                TITLE_INCOMING_DIRECTORY,
                workspaceId,
              ),
            }
          : {}),
      };
    }

    /*
     * The scratch package this job builds, and the marker that says it is
     * finished and verified.
     *
     * Both are named before anything expensive starts, because the marker is
     * what a restart reads to discover that the transcode is already done. It
     * is written only after deep validation has passed, so its presence means
     * exactly one thing: every byte of the package exists on scratch and has
     * proven itself, and all that remains is to copy it to the media volume.
     */
    const { workVersionRoot, marker: verificationMarker } =
      verifiedPackagePaths(workspaceDirectory, request.sourceFingerprint);
    const scratchCandidate = await readVerifiedScratchPackage({
      marker: verificationMarker,
      workVersionRoot,
      sourceFingerprint: request.sourceFingerprint,
    });
    // The video fingerprint does not change when a sidecar is corrected while
    // publication waits. Reuse scratch only if it still covers today's files;
    // unchanged tracks in an incremental package can live in the current title.
    const verifiedScratchPackage =
      scratchCandidate &&
      sidecarSubtitles.every((sidecar) => {
        const id = subtitleRenditionId(sidecar.streamIndex);
        const scratchTrack = scratchCandidate.metadata.subtitleRenditions?.find(
          (track) => track.id === id,
        );
        return sidecarSubtitleIsCurrent(
          sidecar,
          scratchTrack ??
            (reusableSubtitles.has(id)
              ? existing?.subtitle.find((track) => track.id === id)
              : undefined),
        );
      })
        ? scratchCandidate
        : null;

    /**
     * Publishes a verified scratch package and finishes the job.
     *
     * Everything from here on is the same whether the package was built by
     * this process or by one that died mid-copy, which is why it is one
     * function rather than a path duplicated for resume. It is idempotent:
     * files already present and matching on the destination are skipped, the
     * directory swap records which directories it has already renamed, and the
     * scratch workspace is removed only after the destination has been proven
     * against the manifest.
     */
    const completePublication = async ({
      metadata,
      existingBuildRecord,
      sourceDamage,
    }: {
      metadata: AdaptivePackageMetadata;
      existingBuildRecord: AdaptivePackageMetadata | null;
      sourceDamage: SourceDamageRecord[];
    }): Promise<AdaptivePackageResult> => {
      const titleRoot = titleRootForRequest(request);
      const onPublishProgress = onEvent
        ? {
            onProgress: (progress: PublishPhaseProgress) => {
              onEvent({
                type: "publish-progress",
                mediaId: request.mediaId,
                progress,
              });
            },
          }
        : {};
      const publication = existingBuildRecord
        ? await publishAdditionalRenditions({
            ...(publicationFileSystem
              ? { fileSystem: publicationFileSystem }
              : {}),
            workVersionRoot,
            titleRoot,
            existing: existingBuildRecord,
            added: metadata,
            publicationId: workspaceId,
            destinationReserveBytes: reserveBytes,
            retainIncomingAfterPublish: retainWorkspaceAfterPublish,
            ...(signal ? { signal } : {}),
            ...onPublishProgress,
          })
        : await publishTitlePackage({
            ...(publicationFileSystem
              ? { fileSystem: publicationFileSystem }
              : {}),
            workVersionRoot,
            titleRoot,
            metadata,
            publicationId: workspaceId,
            destinationReserveBytes: reserveBytes,
            retainIncomingAfterPublish: retainWorkspaceAfterPublish,
            ...(signal ? { signal } : {}),
            ...onPublishProgress,
          });
      const { manifest, incomingDirectory } = publication;
      const publishedRoot =
        "publishedRoot" in publication
          ? (publication.publishedRoot ?? titleRoot)
          : titleRoot;
      // The manifest describes the whole title, including renditions this run
      // reused, so it is the honest source for the package's own size.
      const publishedTotalBytes = manifest.storage.totalBytes;

      /*
       * The two steps publication performs outside `publishTitlePackage`: proving
       * the manifest against the disk it just described, and removing the
       * checkpoints. Reported here because they are where the remaining time
       * goes, and because the second one is the point of no return for a
       * resumable build.
       */
      const publishTail = (
        id: "verify" | "cleanup",
        state: "running" | "complete",
      ): void => {
        onEvent?.({
          type: "publish-progress",
          mediaId: request.mediaId,
          progress: {
            steps: [
              { id: "verify", state: id === "verify" ? state : "complete" },
              {
                id: "cleanup",
                state: id === "cleanup" ? state : "waiting",
              },
            ],
            totalBytes: 0,
            completedBytes: 0,
            fraction: id === "cleanup" && state === "complete" ? 1 : 0,
            currentId: id,
          },
        });
      };

      // Publication moves and rewrites; a file the manifest names but the folder
      // does not hold would be a package that reads as present and plays as
      // broken, so the manifest is checked against the disk it just described.
      publishTail("verify", "running");
      const missing: string[] = [];
      for (const rendition of [
        ...manifest.video,
        ...manifest.audio,
        ...manifest.subtitle,
      ]) {
        for (const relative of [rendition.mediaPath, rendition.playlistPath]) {
          const stats = await stat(
            path.join(publishedRoot, ...relative.split("/")),
          ).catch(() => undefined);
          const expectedSize =
            relative === rendition.mediaPath
              ? rendition.fileSizeBytes
              : undefined;
          if (
            !stats?.isFile() ||
            stats.size === 0 ||
            (expectedSize !== undefined && stats.size !== expectedSize)
          ) {
            missing.push(relative);
          }
        }
      }
      if (missing.length > 0) {
        return {
          ...base,
          status: "validation-failed",
          error:
            "The published package is missing files its own manifest names, so it was not activated.",
          issues: missing,
        };
      }
      publishTail("verify", "complete");

      /*
       * No pointer is written into the rendition root any more: nothing lives
       * there. The title folder's own manifest is what says which package is
       * current, which keeps the answer next to the files it describes.
       *
       * This is the one place checkpoints are removed, and it is reached only
       * after the package has been validated and published. Until then they are
       * the job's durable progress and nothing may touch them.
       */
      publishTail("cleanup", "running");
      if (!retainWorkspaceAfterPublish) {
        const owned = await verifyOwnedJobWorkspace(
          paths.workRoot,
          workspaceDirectory,
          workspaceId,
        );
        await rm(owned, {
          recursive: true,
          force: true,
        }).catch(() => undefined);
      }
      publishTail("cleanup", "complete");

      if (sourceDamage.length > 0) {
        console.warn(
          `[seyirlik] ${request.relativePath}: published with ${sourceDamage.length} replaced interval(s) — ${sourceDamage
            .map((record) => describeInterval(damageIntervalOf(record)))
            .join(", ")} could not be read from the source.`,
        );
      }

      return {
        ...base,
        status: "ready",
        versionDirectory,
        workspaceDirectory,
        scratchIdentity: workspaceClaim?.identity ?? null,
        publicationIncomingDirectory: incomingDirectory,
        // The published package, whether this run built all of it or one rung.
        storageBytes: publishedTotalBytes,
        // What this run itself wrote.
        jobOutputBytes: metadata.storage.totalBytes,
        /*
         * A salvaged title is published, and it is not a clean encode. Saying so
         * here is what lets the job record, the API and the page tell the two
         * apart rather than presenting them identically.
         */
        ...(sourceDamage.length > 0 ? { sourceDamage } : {}),
      };
    };

    /*
     * Restart during publication.
     *
     * A 400 GB package that was verified before the worker died must not be
     * built a second time: the encode is finished, the bytes are on scratch,
     * and the only unfinished work is the copy. Publication is idempotent and
     * resumable per file, so handing it the package it was already copying is
     * both the cheapest and the safest thing to do.
     *
     * This is deliberately placed after the check above that recognises an
     * already-published final package, so a crash between the final rename and
     * the database commit reconciles as `already-valid` rather than copying a
     * package that is already live.
     */
    if (verifiedScratchPackage) {
      onEvent?.({
        type: "build-stage",
        mediaId: request.mediaId,
        stage: "publishing",
      });
      return await completePublication({
        metadata: verifiedScratchPackage.metadata,
        existingBuildRecord:
          verifiedScratchPackage.mode === "incremental"
            ? await readTitleBuildRecord(titleRootForRequest(request))
            : null,
        sourceDamage: verifiedScratchPackage.sourceDamage,
      });
    }

    const preserveHdr = probe.video.isHdr;
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
    const codecFamily = codecFamilyForEncoder(encoder);
    const hdr: RenditionHdrSignal | undefined = preserveHdr
      ? {
          colorPrimaries: probe.video.colorPrimaries ?? "bt2020",
          colorTransfer: probe.video.colorTransfer ?? "smpte2084",
          colorSpace: probe.video.colorSpace ?? "bt2020nc",
        }
      : undefined;

    /*
     * What *this run* will write, not what the finished package will hold.
     *
     * Both the free-space preflight and the job's progress reporting read this,
     * and estimating a whole ladder for a one-rung job overstated both: the
     * preflight reserved space for eight renditions that were not being made,
     * and the page showed the full package size under a heading that says what
     * the encoder has produced so far.
     */
    const estimate = estimateAdaptivePackageBytes({
      durationSeconds: probe.durationSeconds,
      qualityHeights: work.videoQualityHeights,
      codecFamily,
      audioTrackCount: work.audioStreamIndexes.length,
    });

    /*
     * Two directories, with very different lifetimes.
     *
     * The checkpoint root is durable: it survives a crash, a cancel, a remount
     * and a restart, and it is what makes resume mean "carry on" rather than
     * "start again". The staging root, made further down, is this attempt's
     * scratch space and is the only thing the publisher ever sees.
     */
    const checkpoints = checkpointRoot(
      paths.workRoot,
      workspaceId,
      ADAPTIVE_PROFILE_VERSION,
      request.sourceFingerprint,
    );
    /** Bytes already protected on disk when this attempt started. */
    const inheritedBytes = await checkpointBytes(checkpoints);

    /*
     * Preflight accounts for three things existing at once: the checkpoints,
     * the assembled copy staged beside them, and the previously published
     * package, which is not removed until the replacement is proven. Bytes
     * already checkpointed are subtracted, because a resumed job does not have
     * to find room for work it has already done — reserving for them again is
     * what stopped a nearly finished title from resuming on a full-ish drive.
     */
    const drive = await driveSpaceProvider();
    /*
     * An assembled package that never earned its verified marker is removed
     * just below, before re-assembly, so its bytes are coming back too. Not
     * counting them demanded room for a copy about to be freed, and a restart
     * during validation could not resume a finished encode.
     */
    const replaceablePackageBytes = verifiedScratchPackage
      ? 0
      : await checkpointBytes(workVersionRoot);
    const conservativeBytes = Math.max(
      0,
      Math.ceil(estimate.totalBytes * (1 + DEFAULT_STORAGE_SAFETY_MARGIN) * 2) -
        inheritedBytes -
        replaceablePackageBytes,
    );
    if (drive.freeBytes - conservativeBytes < reserveBytes) {
      return {
        ...base,
        status: "deferred-for-storage",
        error:
          "Packaging this title alongside its existing output would breach the configured free-space reserve.",
      };
    }

    const sourceFrameRate =
      probe.video.frameRate && probe.video.frameRate > 0
        ? probe.video.frameRate
        : undefined;
    /*
     * Only the rungs the plan asked for. `requirements` still describes the
     * finished ladder — the estimate and the published manifest need that —
     * but the filter graph, the encoders and the variant map are all derived
     * from this list, so a one-rung job produces one scaler and one encoder.
     */
    const plannedRequirements = requirements.filter((requirement) =>
      work.videoQualityHeights.includes(requirement.qualityHeight),
    );
    let videoOutputs: AdaptiveVideoOutput[] = plannedRequirements.map(
      (requirement) => {
        const rate = frameRateForClass(
          requirement.qualityHeight,
          sourceFrameRate,
        );
        return {
          qualityHeight: requirement.qualityHeight,
          width: requirement.width,
          height: requirement.height,
          // Only carried when it actually differs: a rung at the source's own
          // rate must not gain an `fps` filter that would resample a timeline
          // that is already correct.
          ...(rate !== undefined &&
          sourceFrameRate !== undefined &&
          rate < sourceFrameRate - 0.01
            ? { frameRate: rate }
            : {}),
        };
      },
    );
    const gopFrameRate =
      Math.max(probe.video.frameRate ?? 0, probe.video.maxFrameRate ?? 0) ||
      undefined;

    /*
     * Audio is asked for separately from video. Adding a video rung must not
     * re-encode sound that is already published and intact — that transcode is
     * pure waste and it rewrites a track the viewer is currently using.
     */
    const plannedAudioOutputs = audioPlan.outputs.filter((output) =>
      work.audioStreamIndexes.includes(output.sourceStreamIndex),
    );
    const plannedSubtitleStreamIndexes = subtitleStreamIndexes.filter(
      (streamIndex) => work.subtitleStreamIndexes.includes(streamIndex),
    );
    const plannedSidecarSubtitles = sidecarSubtitles.filter((sidecar) =>
      work.subtitleStreamIndexes.includes(sidecar.streamIndex),
    );

    /*
     * A scratch package that did not finish publishing is rebuilt from its
     * checkpoints; one that did is never touched again. `resumedPublication`
     * above has already returned in the second case, so reaching here with the
     * marker still valid means the package is being extended, not replaced.
     */
    if (!verifiedScratchPackage) {
      await rm(workVersionRoot, { recursive: true, force: true });
    }
    await mkdirWithinWorkspace(workspaceClaim, workVersionRoot);
    for (const streamIndex of [
      ...plannedSubtitleStreamIndexes,
      // Sidecars are extracted in the same place as embedded tracks and so
      // need their directories made here too, not only the embedded ones.
      ...plannedSidecarSubtitles.map((sidecar) => sidecar.streamIndex),
    ]) {
      await mkdirWithinWorkspace(
        workspaceClaim,
        path.join(
          workVersionRoot,
          ADAPTIVE_SUBTITLE_DIRECTORY,
          subtitleRenditionId(streamIndex),
        ),
      );
    }

    onEvent?.({
      type: "encode-start",
      mediaId: request.mediaId,
      qualities: videoOutputs.map((output) => output.qualityHeight),
      encoder,
      hdr: preserveHdr,
      tonemapHdr: false,
      durationSeconds: probe.durationSeconds,
    });

    /*
     * The plan is computed from the source's own frame times and then written
     * down, so a restart regenerates exactly the boundaries the checkpoints on
     * disk were cut on rather than a set that merely looks similar.
     */
    onEvent?.({
      type: "build-stage",
      mediaId: request.mediaId,
      stage: "planning",
    });
    const boundaries = nominalEpochBoundaries({
      sourceDurationSeconds: probe.durationSeconds,
      epochTargetSeconds,
      segmentSeconds,
    });
    const timeline = await probeSourceFrameTimeline({
      sourcePath: request.sourcePath,
      boundaries,
      ffprobePath,
      ...(signal ? { signal } : {}),
    });
    const freshPlan = buildEpochPlan({
      mediaId: request.mediaId,
      sourceFingerprint: request.sourceFingerprint,
      profileVersion: ADAPTIVE_PROFILE_VERSION,
      sourceDurationSeconds: probe.durationSeconds,
      epochTargetSeconds,
      segmentSeconds,
      timeline,
    });
    const planExpectation = {
      mediaId: request.mediaId,
      sourceFingerprint: request.sourceFingerprint,
      profileVersion: ADAPTIVE_PROFILE_VERSION,
      epochTargetSeconds,
      segmentSeconds,
      sourceDurationSeconds: probe.durationSeconds,
    };
    const { plan } = await reconcilePlan({
      root: checkpoints,
      plan: freshPlan,
      expected: planExpectation,
    });

    const identity = {
      mediaId: request.mediaId,
      sourceFingerprint: request.sourceFingerprint,
      adaptiveProfileVersion: ADAPTIVE_PROFILE_VERSION,
      timelinePolicyVersion: EPOCH_TIMELINE_POLICY_VERSION,
    };

    const encodePreset =
      preset ??
      (encoder === "h264_qsv" || encoder === "hevc_qsv"
        ? "veryfast"
        : encoder === "h264_nvenc" || encoder === "hevc_nvenc"
          ? // p5 of p1-p7: the GPU is rarely the bottleneck of a full ladder
            // (decoding and scaling on the CPU are), so it spends its spare
            // time on quality.
            "p5"
          : "medium");
    const qsvFilterThreads =
      encoder === "h264_qsv" || encoder === "hevc_qsv" ? 2 : undefined;

    /*
     * This title's rates. A resumed job reuses what its first attempt decided,
     * so every epoch is encoded alike; one whose epochs predate the probe stays
     * on the table rates they were made with. HDR is left on the table because
     * VMAF is not calibrated for PQ, and an incremental run because the rungs
     * it joins were not measured with it.
     */
    if (rateProbe && !preserveHdr && work.mode !== "incremental") {
      const stored = await readStoredRateProbe(
        checkpoints,
        encoder,
        encodePreset,
      );
      const probed =
        stored ??
        ((await listCompletedEpochIndexes(checkpoints)).length > 0
          ? null
          : await probeTitleRates({
              ffmpegPath,
              sourcePath: request.sourcePath,
              durationSeconds: probe.durationSeconds,
              outputs: videoOutputs,
              encoder,
              codecFamily,
              preset: encodePreset,
              ...(gopFrameRate === undefined
                ? {}
                : { frameRate: gopFrameRate }),
              segmentSeconds,
              ...(qsvFilterThreads === undefined
                ? {}
                : { filterComplexThreads: qsvFilterThreads }),
              checkpointRoot: checkpoints,
              ...(signal ? { signal } : {}),
              waitWhilePaused: async () => {
                while (pauseController?.pauseRequested && !signal?.aborted) {
                  await new Promise((resolve) => setTimeout(resolve, 1_000));
                }
              },
            }));
      if (probed) {
        videoOutputs = videoOutputs.map((output) => {
          const rate = probed.rates[output.qualityHeight];
          return rate ? { ...output, bitrate: rate } : output;
        });
        console.info(
          `[seyirlik] ${request.relativePath}: ${stored ? "reusing " : ""}measured rates ${videoOutputs
            .map(
              (output) =>
                `${output.qualityHeight}p ${
                  output.bitrate
                    ? `${(output.bitrate.target / 1e6).toFixed(2)} Mbps`
                    : "table"
                }`,
            )
            .join(", ")}`,
        );
      }
    }

    let completedEpochBytes = 0;
    let currentEpochBytes = 0;
    const reportBytes = () =>
      inheritedBytes + completedEpochBytes + currentEpochBytes;

    /*
     * A signal that fires when the caller cancels *or* when scratch stops
     * being the filesystem this job claimed.
     *
     * The boundary checks above cannot help an encode that is already running:
     * an epoch is minutes long, and for all of that time FFmpeg holds output
     * handles on a volume that may already have gone. Polling the claim and
     * aborting through the existing process-abort path is what turns "the disk
     * vanished" into a stopped child rather than minutes of writes to wherever
     * the pathname now resolves.
     *
     * Two seconds is chosen against the storage watchdog's five: this is the
     * cheaper check of the two — one `stat` and one small read, no subprocess —
     * and it is the one holding a running encoder.
     */
    const scratchLost = new AbortController();
    scratchPoll = setInterval(() => {
      void assertScratch().catch(() => scratchLost.abort());
    }, 2_000);
    scratchPoll.unref?.();
    const scratchWatch = signal
      ? { signal: AbortSignal.any([signal, scratchLost.signal]) }
      : { signal: scratchLost.signal };

    let epochBuild: Awaited<ReturnType<typeof runEpochBuild>> | undefined;
    /** Intervals replaced because the source could not supply them. */
    let sourceDamage: SourceDamageRecord[] = [];
    let damagedIntervals: SourceInterval[] = [];
    try {
      onEvent?.({
        type: "build-stage",
        mediaId: request.mediaId,
        stage: "encoding",
      });
      epochBuild = await runEpochBuild({
        identity,
        checkpointRoot: checkpoints,
        plan,
        sourcePath: request.sourcePath,
        videoOutputs,
        encoder,
        codecFamily,
        ...(hdr ? { hdr } : {}),
        hdrState: hdrStateFor(probe),
        ...(gopFrameRate === undefined ? {} : { frameRate: gopFrameRate }),
        segmentSeconds,
        preset: encodePreset,
        ...(encoder === "libx264" || encoder === "libx265"
          ? {
              softwareThreads,
              filterComplexThreads:
                defaultSoftwareFilterThreads(softwareThreads),
            }
          : encoder === "h264_qsv" || encoder === "hevc_qsv"
            ? {
                // Measured on the Windows Intel UHD 630 server. Two filter
                // workers gave the best sustained full-ladder throughput.
                filterComplexThreads: 2,
              }
            : {}),
        ffmpegPath,
        ffprobePath,
        logPath: path.join(paths.logsRoot, `${request.mediaId}.adaptive.log`),
        runEncoder,
        /*
         * The scratch volume is re-proven at every epoch boundary, from a
         * marker this job wrote into its own workspace.
         *
         * The watchdog cannot answer this on its own: when the volume goes,
         * the next `mkdir` recreates the path on whatever filesystem the mount
         * point sits on, and a poll that runs afterwards sees a directory and
         * reports healthy. The job then keeps encoding — onto the wrong disk —
         * and publishes a package built from it.
         */
        beforeEpoch: () => assertScratch(),
        signal: scratchWatch.signal,
        ...(pauseController ? { pauseController } : {}),
        ...(storageAvailable ? { storageAvailable } : {}),
        ...(missingRoots ? { missingRoots } : {}),
        ...(onHardStorageFault ? { onHardStorageFault } : {}),
        ...(sourceIoBackoffMs ? { sourceIoBackoffMs } : {}),
        sourceDamagePolicy,
        stalls,
        /*
         * The bounded readability re-check, asked about the stretch the encoder
         * could not get through rather than about the epoch as a whole. That
         * distinction is the whole value of the answer: everything before the
         * point media time froze has just been read successfully, so a probe
         * aimed there reports "readable" on a file with a hole in it — which is
         * exactly how the real damaged title came to be diagnosed as an encoder
         * fault and failed instead of salvaged.
         *
         * Bounded twice over, because this question is asked *of a disk that is
         * already suspect*: a wall clock the answer cannot outlive, and a
         * process group that is signalled and then killed rather than left
         * behind. A probe that does not answer inside its window is not an
         * inconclusive result — it is the same evidence a second time, and it
         * is reported as such rather than as a healthy source.
         */
        verifySourceReadable: async (
          window: SourceProbeWindow,
        ): Promise<SourceProbeOutcome> =>
          verifySourceReadable
            ? verifySourceReadable(window)
            : probeSourceRangeReadable({
                sourcePath: request.sourcePath,
                fromSeconds: window.fromSeconds,
                toSeconds: window.toSeconds,
                sourceDurationSeconds: probe.durationSeconds,
                ffprobePath,
                timeoutMs: stalls.sourceProbeTimeoutMs,
                ...(signal ? { signal } : {}),
              }),
        onEvent: (event) => {
          if (!onEvent) return;
          switch (event.type) {
            case "reconciled":
              onEvent({
                type: "epoch-plan",
                mediaId: request.mediaId,
                epochCount: event.epochCount,
                epochTargetSeconds,
                sourceDurationSeconds: probe.durationSeconds,
                reusedEpochs: event.outcome.complete.length,
                protectedSeconds: event.protectedSeconds,
                checkpointBytes: inheritedBytes,
                invalidated: event.outcome.invalidated,
              });
              break;
            case "epoch-reused":
              onEvent({
                type: "epoch-complete",
                mediaId: request.mediaId,
                index: event.index,
                epochCount: event.epochCount,
                protectedSeconds: event.protectedSeconds,
                bytes: 0,
                elapsedMs: 0,
              });
              break;
            case "epoch-start":
              currentEpochBytes = 0;
              onEvent({
                type: "epoch-start",
                mediaId: request.mediaId,
                index: event.index,
                epochCount: event.epochCount,
                startSeconds: event.startSeconds,
                endSeconds: event.endSeconds,
                attempt: event.attempt,
              });
              break;
            case "epoch-progress": {
              if (event.writtenBytes !== undefined) {
                currentEpochBytes = event.writtenBytes;
              }
              const encodedSeconds = epochProgress({
                protectedSeconds: event.protectedSeconds,
                currentEpochStartSeconds: event.startSeconds,
                currentEpochProcessedSeconds: event.epochProcessedSeconds,
                sourceDurationSeconds: event.sourceDurationSeconds,
              }).encodedSeconds;
              onEvent({
                type: "epoch-progress",
                mediaId: request.mediaId,
                index: event.index,
                epochCount: event.epochCount,
                startSeconds: event.startSeconds,
                endSeconds: event.endSeconds,
                epochProcessedSeconds: event.epochProcessedSeconds,
                encodedSeconds,
                protectedSeconds: event.protectedSeconds,
                sourceDurationSeconds: event.sourceDurationSeconds,
                ...(event.fps === undefined ? {} : { fps: event.fps }),
                ...(event.speed === undefined ? {} : { speed: event.speed }),
                writtenBytes: reportBytes(),
                ...(event.placeholder ? { placeholder: true } : {}),
              });
              /*
               * The legacy shape is still emitted so the CLI renderer and any
               * reader written against it keep working. It carries the same
               * media time, which is the only figure either of them uses.
               */
              onEvent({
                type: "encode-progress",
                mediaId: request.mediaId,
                processedSeconds: encodedSeconds,
                durationSeconds: probe.durationSeconds,
                ...(event.fps === undefined ? {} : { fps: event.fps }),
                ...(event.speed === undefined ? {} : { speed: event.speed }),
                writtenBytes: reportBytes(),
              });
              break;
            }
            case "epoch-complete":
              completedEpochBytes += event.bytes;
              currentEpochBytes = 0;
              onEvent({
                type: "epoch-complete",
                mediaId: request.mediaId,
                index: event.index,
                epochCount: event.epochCount,
                protectedSeconds: event.protectedSeconds,
                bytes: event.bytes,
                elapsedMs: event.elapsedMs,
              });
              break;
            case "source-io-retry":
              onEvent({
                type: "source-io-retry",
                mediaId: request.mediaId,
                index: event.index,
                attempt: event.attempt,
                maxAttempts: event.maxAttempts,
                ...(event.sourceReadable === undefined
                  ? {}
                  : { sourceReadable: event.sourceReadable }),
                ...(event.verdict === undefined
                  ? {}
                  : { verdict: event.verdict }),
                ...(event.because === undefined
                  ? {}
                  : { because: event.because }),
                detail: event.detail,
              });
              break;
            case "source-stall-abort":
              onEvent({
                type: "source-stall-abort",
                mediaId: request.mediaId,
                index: event.index,
                startSeconds: event.startSeconds,
                endSeconds: event.endSeconds,
                lastMediaSeconds: event.lastMediaSeconds,
                stalledForMs: event.stalledForMs,
              });
              break;
            case "source-damage-confirmed":
              onEvent({
                type: "source-damage-confirmed",
                mediaId: request.mediaId,
                index: event.index,
                damage: event.damage,
                policy: event.policy,
              });
              break;
            case "epoch-salvage-start":
              currentEpochBytes = 0;
              onEvent({
                type: "epoch-salvage-start",
                mediaId: request.mediaId,
                index: event.index,
                epochCount: event.epochCount,
                startSeconds: event.startSeconds,
                endSeconds: event.endSeconds,
                expectedDurationSeconds: event.expectedDurationSeconds,
              });
              break;
            case "epoch-salvaged":
              onEvent({
                type: "epoch-salvaged",
                mediaId: request.mediaId,
                index: event.index,
                epochCount: event.epochCount,
                protectedSeconds: event.protectedSeconds,
                bytes: event.bytes,
                damage: event.damage,
              });
              break;
            case "epoch-invalid":
              onEvent({
                type: "epoch-invalid",
                mediaId: request.mediaId,
                index: event.index,
                reason: event.reason,
              });
              break;
          }
        },
      });

      /*
       * Audio is built once for the whole title, after the video epochs and
       * entirely apart from them. It is minutes of work against hours, and
       * keeping it separate is what stops a soundtrack failure from touching a
       * single durable video epoch.
       */
      /*
       * Where the source could not be read, gathered before anything else
       * touches the file again. Every stage that traverses the whole timeline —
       * audio, subtitles — is given these so it reads around the holes instead
       * of walking into them and failing a title whose video was salvaged
       * successfully.
       */
      sourceDamage = [...epochBuild.salvaged].sort(
        (left, right) => left.sourceStartSeconds - right.sourceStartSeconds,
      );
      damagedIntervals = mergeIntervals(sourceDamage.map(damageIntervalOf));

      if (plannedAudioOutputs.length > 0) {
        onEvent?.({
          type: "build-stage",
          mediaId: request.mediaId,
          stage: "audio",
        });
        /*
         * What the tracks are, so the page can name them. Taken from the
         * source probe rather than from the encode request: the request says
         * which streams to keep, the probe says what they contain.
         */
        const trackDetails = new Map(
          plannedAudioOutputs.map((output) => {
            const track = probe.audioTracks.find(
              (candidate) => candidate.streamIndex === output.sourceStreamIndex,
            );
            return [
              output.sourceStreamIndex,
              {
                ...(track?.language ? { language: track.language } : {}),
                ...(track?.title ? { title: track.title } : {}),
                ...(track?.channels === undefined
                  ? {}
                  : { channels: track.channels }),
              },
            ] as const;
          }),
        );
        const audio = await ensureAudioStage({
          stageDirectory: audioStagePath(checkpoints),
          mediaId: request.mediaId,
          sourceFingerprint: request.sourceFingerprint,
          adaptiveProfileVersion: ADAPTIVE_PROFILE_VERSION,
          sourcePath: request.sourcePath,
          audioOutputs: plannedAudioOutputs,
          sourceDurationSeconds: probe.durationSeconds,
          ffmpegPath,
          ffprobePath,
          logPath: path.join(paths.logsRoot, `${request.mediaId}.adaptive.log`),
          runEncoder,
          trackDetails,
          ...(signal ? { signal } : {}),
          ...(pauseController ? { pauseController } : {}),
          ...(storageAvailable ? { storageAvailable } : {}),
          ...(damagedIntervals.length > 0 ? { damagedIntervals } : {}),
          stalls,
          ...(onEvent
            ? {
                onProgress: (progress) => {
                  onEvent({
                    type: "audio-progress",
                    mediaId: request.mediaId,
                    progress,
                  });
                },
              }
            : {}),
        });
        if (!audio.reused) completedEpochBytes += audio.bytes;
        // Recorded on the warning itself, so "was the sound replaced too" is
        // answered by the thing an operator reads rather than inferred.
        if (damagedIntervals.length > 0) {
          for (const record of sourceDamage) record.audioReplaced = true;
        }
      }
    } catch (error) {
      /*
       * Nothing durable is removed here. The staging directory is this
       * attempt's own and goes; every completed epoch stays exactly where it
       * is, which is the difference between losing five minutes and losing an
       * evening.
       */
      await rm(workVersionRoot, { recursive: true, force: true }).catch(
        () => undefined,
      );
      if (signal?.aborted) {
        return { ...base, status: "interrupted", interruption: "cancelled" };
      }
      /*
       * A source that will not read while its volume stays healthy is a
       * failure, not a pause. Reported before the storage case because the two
       * arrive by the same route and only this one must stop the job.
       */
      if (error instanceof SourceReadError) {
        return {
          ...base,
          status: "failed",
          error: `${error.failure.summary} Epoch ${error.epochIndex + 1} was read ${error.attempts} times without success. Every checkpoint before it is kept, so a retry once the source is repaired or replaced re-encodes only that epoch.`,
          issues: [error.failure.detail],
          failureKind: "source-io",
          /*
           * The interval is reported even though nothing was substituted. It is
           * what an operator needs in order to decide whether to repair the
           * source or to turn salvage on for this library.
           */
          ...(error.damage ? { sourceDamage: [error.damage] } : {}),
        };
      }
      /*
       * The encoder stopped producing while the source proved readable. Not
       * salvageable — replacing film to work around a wedged encoder would be
       * the worst outcome this feature could have — and not a retry either,
       * because the next attempt would wedge in the same place.
       */
      if (error instanceof MediaProgressTimeoutError) {
        return {
          ...base,
          status: "failed",
          error: `${error.failure.summary} Epoch ${error.epochIndex + 1} produced no media for ${Math.round(
            error.stalledForMs / 1000,
          )}s after reaching ${error.lastMediaSeconds.toFixed(1)}s. Every completed checkpoint is kept.`,
          issues: [error.failure.detail],
          failureKind: "media-progress-timeout",
        };
      }
      if (error instanceof StorageInterruptedError) {
        return {
          ...base,
          status: "interrupted",
          interruption: "storage",
          error: error.failure.summary,
          issues: [error.failure.detail],
          failureKind: error.failure.kind,
        };
      }
      /*
       * Audio meeting a bad region the video epochs never touched. The video
       * checkpoints — salvaged ones included — all survive, so a retry after
       * the source is repaired or replaced re-encodes only the soundtrack. It
       * is reported plainly rather than as a generic encoder fault, because
       * "the disk is failing further" and "the AAC encoder broke" call for
       * completely different actions.
       */
      if (error instanceof AudioStageError) {
        return {
          ...base,
          status: "failed",
          error:
            error.failure.kind === "source-io"
              ? `${error.message} Every video checkpoint is kept, so a retry once the source is repaired or replaced rebuilds only the soundtrack.`
              : error.message,
          issues: error.evidence.length > 0 ? error.evidence : undefined,
          failureKind: error.failure.kind,
          ...(sourceDamage.length > 0 ? { sourceDamage } : {}),
        };
      }
      throw error;
    }

    if (signal?.aborted) {
      await rm(workVersionRoot, { recursive: true, force: true }).catch(
        () => undefined,
      );
      return { ...base, status: "interrupted", interruption: "cancelled" };
    }

    /*
     * Assembly. Not a transcode, not even a remux: the epochs' fragments are
     * copied into one file per rendition under a single initialisation segment,
     * with each fragment's decode time moved onto the global timeline. A
     * five-hour checkpointed encode followed by a second full transcode would
     * be worse than no checkpointing at all.
     */
    onEvent?.({
      type: "build-stage",
      mediaId: request.mediaId,
      stage: "assembling",
    });
    /*
     * The last assembly sample is kept so the audio copy that follows can be
     * reported against the same totals rather than resetting the panel: the
     * video bytes are done, and the copy is a named step beside them.
     */
    let lastAssembly: AssemblyPhaseProgress | undefined;
    // Assembly reads every epoch and writes the finished renditions; the volume
    // is re-proven, identity included, before that begins.
    await assertScratch({ deep: true });
    const assembled = await assembleVideoRenditions({
      checkpointRoot: checkpoints,
      plan,
      manifests: epochBuild.manifests,
      renditionIds: videoOutputs.map((output) =>
        videoRenditionId(output.qualityHeight),
      ),
      targetRoot: workVersionRoot,
      targetDirectory: ADAPTIVE_VIDEO_DIRECTORY,
      ...(onEvent
        ? {
            onProgress: (progress) => {
              lastAssembly = progress;
              onEvent({
                type: "assembly-progress",
                mediaId: request.mediaId,
                progress,
              });
            },
          }
        : {}),
    });
    for (const rendition of assembled) {
      if (rendition.sourceGaps > 0) {
        console.warn(
          `[seyirlik] ${request.relativePath}: ${rendition.id} kept ${rendition.sourceGaps} timeline gap(s) the source itself contains.`,
        );
      }
    }
    if (plannedAudioOutputs.length > 0) {
      const reportCopy = (
        state: "running" | "complete",
        bytes: number,
      ): void => {
        if (!onEvent || !lastAssembly) return;
        onEvent({
          type: "assembly-progress",
          mediaId: request.mediaId,
          progress: {
            ...lastAssembly,
            audioCopyState: state,
            audioCopyBytes: bytes,
          },
        });
      };
      reportCopy("running", 0);
      const copied = await copyStageDirectory(
        path.join(audioStagePath(checkpoints), ADAPTIVE_AUDIO_DIRECTORY),
        path.join(workVersionRoot, ADAPTIVE_AUDIO_DIRECTORY),
      );
      reportCopy("complete", copied);
    }

    const generatedMasterPath = path.join(
      workVersionRoot,
      ADAPTIVE_MASTER_PLAYLIST,
    );
    /*
     * Codec strings come from the master FFmpeg wrote beside an epoch. They are
     * derived from the real bitstream, and every epoch produced the same ones —
     * which the identical initialisation segments independently prove — so the
     * assembled rendition advertises exactly what it contains.
     */
    const generatedCodecs = new Map<string, string>(
      [...epochBuild.videoCodecStrings].map(([id, codec]) => [
        `${ADAPTIVE_VIDEO_DIRECTORY}/${id}/${ADAPTIVE_PLAYLIST_FILE}`,
        codec,
      ]),
    );

    const videoCodecStrings = new Map<string, string>();
    const audioCodecStrings = new Map<string, string>();
    const videoRenditions: AdaptiveVideoRenditionMetadata[] = [];
    const audioRenditions: AdaptiveAudioRenditionMetadata[] = [];
    const subtitleRenditions: AdaptiveSubtitleRenditionMetadata[] = [];
    let videoBytes = 0;
    let audioBytes = 0;
    let subtitleBytes = 0;

    /*
     * The measurement pass, announced.
     *
     * Everything below reads back what was just written, one rendition at a
     * time, and it is the largest unannounced stretch the pipeline had: the
     * byte counter above has already reached its total, so a page with nothing
     * further to show sat on a finished bar for as long as ffprobe took to walk
     * thirty gigabytes. The reports are throttled by the live channel, exactly
     * as the encoder's are, so a rendition's thousands of keyframes cost one
     * sample every quarter second.
     */
    const measureRate = createByteRateEstimator();
    let measureOrigin: number | undefined;
    let measureFurthest = 0;
    const reportMeasure = (
      currentId: string,
      index: number,
      totalMediaSeconds: number | undefined,
      advancedAtMs: number | undefined,
    ): void => {
      if (!onEvent || !lastAssembly) return;
      const at = Date.now();
      const measurable =
        totalMediaSeconds !== undefined && totalMediaSeconds > 0;
      const stalled =
        advancedAtMs !== undefined && at - advancedAtMs > VERIFICATION_STALE_MS;
      const rate = stalled ? undefined : measureRate.rate(at);
      onEvent({
        type: "assembly-progress",
        mediaId: request.mediaId,
        progress: {
          ...lastAssembly,
          measure: {
            currentId,
            index,
            count: videoOutputs.length,
            ...(measurable ? { totalMediaSeconds } : {}),
            ...(measureFurthest > 0
              ? { currentMediaSeconds: measureFurthest }
              : {}),
            ...(measurable
              ? { fraction: safeFraction(measureFurthest, totalMediaSeconds) }
              : {}),
            ...(rate === undefined ? {} : { rate }),
            ...(measurable && rate !== undefined
              ? {
                  etaSeconds:
                    etaFromRate(
                      Math.max(0, totalMediaSeconds - measureFurthest),
                      rate,
                    ) ?? 0,
                }
              : {}),
            ...(advancedAtMs === undefined
              ? {}
              : { lastAdvancedAtMs: advancedAtMs }),
            ...(stalled ? { stalled: true } : {}),
          },
        },
      });
    };

    for (const [renditionIndex, output] of videoOutputs.entries()) {
      const id = videoRenditionId(output.qualityHeight);
      const playlistPath = `${ADAPTIVE_VIDEO_DIRECTORY}/${id}/${ADAPTIVE_PLAYLIST_FILE}`;
      const mediaRelativePath = `${ADAPTIVE_VIDEO_DIRECTORY}/${id}/${ADAPTIVE_MEDIA_FILE}`;
      const absolutePlaylist = path.join(
        workVersionRoot,
        ...playlistPath.split("/"),
      );
      const absoluteMedia = path.join(
        workVersionRoot,
        ...mediaRelativePath.split("/"),
      );

      const measured = measureBitrates(
        await readFile(absolutePlaylist, "utf8"),
      );
      measureOrigin = undefined;
      measureFurthest = 0;
      let advancedAtMs: number | undefined;
      reportMeasure(
        id,
        renditionIndex + 1,
        measured.durationSeconds,
        undefined,
      );
      const packaged = await probePackagedVideo(
        absoluteMedia,
        ffprobePath,
        signal,
        (ptsSeconds) => {
          if (!Number.isFinite(ptsSeconds)) return;
          const at = Date.now();
          /*
           * The first timestamp is where the scan starts, not how far it has
           * got. Everything after it is measured from there, and only forwards.
           */
          if (measureOrigin === undefined) {
            measureOrigin = ptsSeconds;
            measureRate.sample(0, at);
            advancedAtMs = at;
          } else {
            const scanned = ptsSeconds - measureOrigin;
            if (!(scanned > measureFurthest)) return;
            measureFurthest = scanned;
            measureRate.sample(measureFurthest, at);
            advancedAtMs = at;
          }
          reportMeasure(
            id,
            renditionIndex + 1,
            measured.durationSeconds,
            advancedAtMs,
          );
        },
      );
      const mediaStats = await stat(absoluteMedia);
      videoBytes += mediaStats.size;

      const codecs = generatedCodecs.get(playlistPath);
      const videoCodec = codecs?.split(",")[0]?.trim();
      if (!videoCodec) {
        throw new Error(
          `FFmpeg did not report a codec string for ${id}; the package cannot advertise it.`,
        );
      }
      videoCodecStrings.set(id, videoCodec);

      videoRenditions.push({
        id,
        qualityHeight: output.qualityHeight,
        width: packaged.width,
        height: packaged.height,
        codec: codecFamily,
        codecString: videoCodec,
        ...(packaged.profile ? { profile: packaged.profile } : {}),
        ...(packaged.level ? { level: packaged.level } : {}),
        pixelFormat: packaged.pixelFormat,
        hdr: hdrStateFor(probe),
        ...(packaged.colorPrimaries
          ? { colorPrimaries: packaged.colorPrimaries }
          : {}),
        ...(packaged.colorTransfer
          ? { colorTransfer: packaged.colorTransfer }
          : {}),
        ...(packaged.colorSpace ? { colorSpace: packaged.colorSpace } : {}),
        frameRate: packaged.frameRate,
        averageBitrate: measured.averageBitrate,
        peakBitrate: measured.peakBitrate,
        durationSeconds: measured.durationSeconds,
        playlistPath,
        mediaPath: mediaRelativePath,
        fileSizeBytes: mediaStats.size,
        keyframeCount: packaged.keyframeTimes.length,
        keyframeIntervalSeconds: keyframeSummary(
          packaged.keyframeTimes,
          segmentSeconds,
        ),
        segmentCount: measured.segmentCount,
      });

      onEvent?.({
        type: "quality-ready",
        mediaId: request.mediaId,
        qualityHeight: output.qualityHeight,
        width: packaged.width,
        height: packaged.height,
        fileSize: mediaStats.size,
        reused: false,
      });
    }

    for (const output of plannedAudioOutputs) {
      const id = audioRenditionId(output.sourceStreamIndex);
      const playlistPath = `${ADAPTIVE_AUDIO_DIRECTORY}/${id}/${ADAPTIVE_PLAYLIST_FILE}`;
      const mediaRelativePath = `${ADAPTIVE_AUDIO_DIRECTORY}/${id}/${ADAPTIVE_MEDIA_FILE}`;
      const absolutePlaylist = path.join(
        workVersionRoot,
        ...playlistPath.split("/"),
      );
      const absoluteMedia = path.join(
        workVersionRoot,
        ...mediaRelativePath.split("/"),
      );

      const measured = measureBitrates(
        await readFile(absolutePlaylist, "utf8"),
      );
      const packaged = await probePackagedAudio(
        absoluteMedia,
        ffprobePath,
        signal,
      );
      const mediaStats = await stat(absoluteMedia);
      audioBytes += mediaStats.size;
      const codecString = audioCodecString(packaged);
      audioCodecStrings.set(id, codecString);

      const sourceTrack = probe.audioTracks.find(
        (track) => track.streamIndex === output.sourceStreamIndex,
      );

      audioRenditions.push({
        id,
        sourceStreamIndex: output.sourceStreamIndex,
        ...(sourceTrack?.language ? { language: sourceTrack.language } : {}),
        ...(sourceTrack?.title ? { title: sourceTrack.title } : {}),
        isDefault: output.isDefault,
        isForced: output.isForced,
        ...(sourceTrack?.isOriginal === undefined
          ? {}
          : { isOriginal: sourceTrack.isOriginal }),
        ...(sourceTrack?.isCommentary === undefined
          ? {}
          : { isCommentary: sourceTrack.isCommentary }),
        codec: "aac",
        codecString,
        channels: packaged.channels,
        sampleRate: packaged.sampleRate,
        averageBitrate: measured.averageBitrate,
        durationSeconds: measured.durationSeconds,
        playlistPath,
        mediaPath: mediaRelativePath,
        fileSizeBytes: mediaStats.size,
        streamCopied: output.action === "copy",
      });
    }

    if (
      plannedSubtitleStreamIndexes.length > 0 ||
      plannedSidecarSubtitles.length > 0
    ) {
      onEvent?.({
        type: "build-stage",
        mediaId: request.mediaId,
        stage: "subtitles",
      });
    }
    for (const streamIndex of plannedSubtitleStreamIndexes) {
      const sourceTrack = probe.subtitleTracks.find(
        (track) => track.streamIndex === streamIndex && track.isTextBased,
      );
      if (!sourceTrack) continue;
      const id = subtitleRenditionId(streamIndex);
      const playlistPath = `${ADAPTIVE_SUBTITLE_DIRECTORY}/${id}/${ADAPTIVE_PLAYLIST_FILE}`;
      const subtitlePath = `${ADAPTIVE_SUBTITLE_DIRECTORY}/${id}/${ADAPTIVE_SUBTITLE_FILE}`;
      const absoluteSubtitle = path.join(
        workVersionRoot,
        ...subtitlePath.split("/"),
      );
      const extracted = await extractWebVttFile({
        ffmpegPath,
        inputPath: request.sourcePath,
        streamIndex,
        outputPath: absoluteSubtitle,
        /*
         * Read around the holes rather than through them. Cues after a damaged
         * interval keep their own timestamps — nothing is shifted earlier by
         * the length of the hole — and cues whose bytes were inside it are
         * absent, which the warning says rather than the file pretending.
         */
        ...(damagedIntervals.length > 0
          ? {
              damagedIntervals,
              sourceDurationSeconds: probe.durationSeconds,
            }
          : {}),
        ...(signal ? { signal } : {}),
      });
      if (extracted.partial) {
        for (const record of sourceDamage) record.subtitlesAffected = true;
      }
      await writeFile(
        path.join(workVersionRoot, ...playlistPath.split("/")),
        buildWebVttMediaPlaylist(probe.durationSeconds, ADAPTIVE_SUBTITLE_FILE),
        "utf8",
      );
      subtitleBytes += extracted.fileSizeBytes;
      subtitleRenditions.push({
        id,
        sourceStreamIndex: streamIndex,
        ...(sourceTrack.language ? { language: sourceTrack.language } : {}),
        ...(sourceTrack.title ? { title: sourceTrack.title } : {}),
        isDefault: sourceTrack.isDefault,
        isForced: sourceTrack.isForced,
        isHearingImpaired: sourceTrack.isHearingImpaired,
        codec: "webvtt",
        durationSeconds: probe.durationSeconds,
        playlistPath,
        subtitlePath,
        fileSizeBytes: extracted.fileSizeBytes,
      });
    }

    /*
     * Subtitles that live beside the source rather than inside it. They are
     * converted the same way, differing only in that each is its own input file
     * and so is always that file's stream 0.
     */
    for (const sidecar of plannedSidecarSubtitles) {
      const id = subtitleRenditionId(sidecar.streamIndex);
      const playlistPath = `${ADAPTIVE_SUBTITLE_DIRECTORY}/${id}/${ADAPTIVE_PLAYLIST_FILE}`;
      const subtitlePath = `${ADAPTIVE_SUBTITLE_DIRECTORY}/${id}/${ADAPTIVE_SUBTITLE_FILE}`;
      const absoluteSubtitle = path.join(
        workVersionRoot,
        ...subtitlePath.split("/"),
      );
      let extracted: { fileSizeBytes: number };
      try {
        extracted = await extractWebVttFile({
          ffmpegPath,
          inputPath: sidecar.filePath,
          streamIndex: 0,
          outputPath: absoluteSubtitle,
          ...(signal ? { signal } : {}),
        });
      } catch (error) {
        /*
         * A malformed or mis-encoded sidecar must not fail the whole package —
         * the title is still worth publishing without that one translation —
         * but it must not vanish either. Swallowing this silently is how a
         * wiring mistake reads as "this library simply has no subtitles".
         */
        console.warn(
          `[seyirlik] ${request.relativePath}: skipped sidecar subtitle ${
            sidecar.fileName
          } — ${error instanceof Error ? error.message : String(error)}`,
        );
        continue;
      }
      await writeFile(
        path.join(workVersionRoot, ...playlistPath.split("/")),
        buildWebVttMediaPlaylist(probe.durationSeconds, ADAPTIVE_SUBTITLE_FILE),
        "utf8",
      );
      subtitleBytes += extracted.fileSizeBytes;
      subtitleRenditions.push({
        id,
        sourceStreamIndex: sidecar.streamIndex,
        ...(sidecar.sidecarFingerprint
          ? { sidecarFingerprint: sidecar.sidecarFingerprint }
          : {}),
        ...(sidecar.language !== UNKNOWN_LANGUAGE
          ? { language: sidecar.language }
          : {}),
        isDefault: false,
        isForced: sidecar.isForced,
        isHearingImpaired: sidecar.isHearingImpaired,
        codec: "webvtt",
        durationSeconds: probe.durationSeconds,
        playlistPath,
        subtitlePath,
        fileSizeBytes: extracted.fileSizeBytes,
      });
    }

    await writeFile(
      generatedMasterPath,
      buildMasterPlaylist({
        videoRenditions,
        audioRenditions,
        subtitleRenditions,
        allowMissingVideo:
          work.mode === "incremental" && videoRenditions.length === 0,
        videoCodecStrings,
        audioCodecStrings,
      }),
      "utf8",
    );

    const display = getDisplayDimensions(probe.video);
    const metadata: AdaptivePackageMetadata = {
      schemaVersion: ADAPTIVE_METADATA_SCHEMA_VERSION,
      profileVersion: ADAPTIVE_PROFILE_VERSION,
      mediaId: request.mediaId,
      sourceFingerprint: request.sourceFingerprint,
      createdAt: new Date().toISOString(),
      sourceDurationSeconds: probe.durationSeconds,
      source: {
        width: display.width,
        height: display.height,
        qualityHeight: classifyQualityHeight(probe.video),
        codec: probe.video.codec,
        ...(probe.video.frameRate === undefined
          ? {}
          : { frameRate: probe.video.frameRate }),
        isHdr: probe.video.isHdr,
        isVariableFrameRate: isVariableFrameRate(probe),
        rotation: probe.video.rotation,
      },
      segmentTargetSeconds: segmentSeconds,
      switchingSetDurationSeconds: Math.max(
        ...(videoRenditions.length === 0 ? [probe.durationSeconds] : []),
        ...videoRenditions.map((rendition) => rendition.durationSeconds),
      ),
      masterPlaylistPath: ADAPTIVE_MASTER_PLAYLIST,
      videoRenditions,
      audioRenditions,
      subtitleRenditions,
      validation: {
        validatedAt: new Date().toISOString(),
        alignmentToleranceSeconds:
          (probe.video.frameRate ? 1 / probe.video.frameRate : 1 / 30) +
          ALIGNMENT_EPSILON_SECONDS,
        audioDurationToleranceSeconds: AUDIO_DURATION_TOLERANCE_SECONDS,
        checks: [],
      },
      storage: {
        videoBytes,
        audioBytes,
        subtitleBytes,
        totalBytes: videoBytes + audioBytes + subtitleBytes,
      },
      ...(audioPlan.deferred.length > 0
        ? { deferredAudioStreamIndexes: audioPlan.deferred }
        : {}),
    };

    await writeFile(
      path.join(workVersionRoot, ADAPTIVE_METADATA_FILE),
      `${JSON.stringify(metadata, null, 2)}\n`,
      "utf8",
    );
    onEvent?.({
      type: "build-stage",
      mediaId: request.mediaId,
      stage: "validating",
    });
    // Verification is only meaningful against the package this job built.
    await assertScratch({ deep: true });
    const validation = await validateAdaptivePackage({
      ...(onEvent
        ? {
            onProgress: (progress) => {
              onEvent({
                type: "verification-progress",
                mediaId: request.mediaId,
                progress,
              });
            },
          }
        : {}),
      versionRoot: workVersionRoot,
      mediaId: request.mediaId,
      sourceFingerprint: request.sourceFingerprint,
      profileVersion: ADAPTIVE_PROFILE_VERSION,
      ffprobePath,
      ffmpegPath,
      deep: true,
      // An incremental run's work directory holds only what it built, which is
      // video alone whenever the published audio is being reused.
      allowMissingAudio: audioRenditions.length === 0,
      allowMissingVideo:
        work.mode === "incremental" && videoRenditions.length === 0,
      ...(signal ? { signal } : {}),
    });

    if (!validation.ok) {
      // A package that cannot prove alignment is never promoted. The legacy
      // package, if any, keeps playing untouched.
      await rm(workVersionRoot, { recursive: true, force: true }).catch(
        () => undefined,
      );
      return {
        ...base,
        status: "validation-failed",
        // The issues, not just the verdict: a package that fails validation is
        // discarded, so this message is the only surviving evidence of why.
        error: `The packaged ladder did not pass validation and was discarded: ${validation.issues
          .map((issue) =>
            [issue.rendition, issue.stage].filter(Boolean).length > 0
              ? `${[issue.rendition, issue.stage].filter(Boolean).join("/")}: ${issue.message}`
              : issue.message,
          )
          .slice(0, 6)
          .join("; ")}`,
        issues: validation.issues.map(
          (issue) => `${issue.rendition}/${issue.stage}: ${issue.message}`,
        ),
      };
    }

    // The record of what was checked is written into the immutable manifest, so
    // a package carries the evidence of its own validation.
    metadata.validation.checks = validation.checks;
    metadata.validation.validatedAt = new Date().toISOString();
    await writeFile(
      path.join(workVersionRoot, ADAPTIVE_METADATA_FILE),
      `${JSON.stringify(metadata, null, 2)}\n`,
      "utf8",
    );
    /*
     * The point at which the transcode stops being repeatable work.
     *
     * Written after deep validation and before the first destination byte, so
     * a process that dies at any moment during publication restarts into
     * `readVerifiedScratchPackage` and resumes the copy. `mode` and
     * `sourceDamage` are recorded because the resuming process has not planned
     * this build and cannot otherwise know whether it is replacing a package
     * or extending one, nor that the encode replaced unreadable source.
     */
    await writeFile(
      verificationMarker,
      `${JSON.stringify({
        schemaVersion: 1,
        sourceFingerprint: request.sourceFingerprint,
        profileVersion: ADAPTIVE_PROFILE_VERSION,
        packageDirectory: path.basename(workVersionRoot),
        mode: work.mode === "incremental" ? "incremental" : "full",
        sourceDamage,
        verifiedAt: new Date().toISOString(),
      })}\n`,
      "utf8",
    );

    /*
     * The package lives with the title it belongs to, not in a parallel tree
     * keyed by an opaque id. It is published only after it has proven itself in
     * the work directory, and publication never touches the source file: the
     * original is read throughout and is still there afterwards.
     */
    onEvent?.({
      type: "build-stage",
      mediaId: request.mediaId,
      stage: "publishing",
    });
    /*
     * Checked again here because publication reads every byte it copies from
     * scratch. Publishing from a workspace that is no longer the one this job
     * verified would copy whatever happens to be at those paths now.
     */
    await assertScratch({ deep: true });
    const titleRoot = titleRootForRequest(request);
    /*
     * An incremental run must not swap the package's directories: the swap
     * carries away every rendition this job did not produce, which for a
     * one-rung job is the entire rest of the ladder. Its new files are written
     * in beside the existing ones instead, and only the master, manifest and
     * build record are replaced.
     */
    const existingBuildRecord =
      work.mode === "incremental"
        ? await readTitleBuildRecord(titleRoot)
        : null;
    return await completePublication({
      metadata,
      existingBuildRecord,
      sourceDamage,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    /*
     * A refusal to claim scratch is a storage condition, and it is the one
     * case the checks below cannot reach: nothing was claimed, so there is no
     * marker to find missing, and the roots all resolve — to the wrong disk,
     * which is exactly the complaint. Reported here from the error's own type
     * rather than inferred from its wording.
     */
    if (error instanceof ScratchStorageLostError) {
      return {
        ...base,
        status: "interrupted",
        interruption: "storage",
        error: message,
        issues: [message],
        failureKind: "storage-device-lost",
        workspaceDirectory,
        scratchIdentity: workspaceClaim?.identity ?? null,
      };
    }
    /*
     * Both volumes are re-checked here, right now, rather than trusting the
     * last watchdog poll.
     *
     * The watchdog runs on a timer, so a volume pulled between two polls is
     * still "available" as far as its cached answer is concerned — and the
     * error a vanished mount produces does not say so either. Unplugging the
     * media volume mid-publication yields `EACCES ... mkdir /Volumes/<name>`,
     * because the mount point itself is gone, and that was being filed as a
     * broken encode: a permanent failure for a job whose only problem was a
     * loose cable, with a verified package sitting on scratch ready to go.
     *
     * A `stat` of two directories costs nothing on a path that is already
     * failing, and it answers the one question the classification turns on.
     */
    const [sourceRootPresent, scratchRootPresent, workspaceMarkerPresent] =
      await Promise.all([
        stat(paths.mediaRoot).then(
          (entry) => entry.isDirectory(),
          () => false,
        ),
        stat(paths.workRoot).then(
          (entry) => entry.isDirectory(),
          () => false,
        ),
        /*
         * The job's own ownership marker, which it wrote itself and which
         * nothing else removes while the job is running.
         *
         * Checking the roots alone is not enough. An unmount is not atomic
         * from a running process's point of view: for a moment the mount
         * point still stats as a directory while paths inside it have already
         * stopped resolving, so a scratch volume pulled mid-encode produced an
         * `ENOENT` on a scratch path while `workRoot` still looked present.
         * That was classified `source-missing` — a permanent failure — and
         * threw away a job whose only problem was a disconnected disk.
         *
         * A marker this job placed and did not delete cannot be absent for any
         * innocent reason, so its disappearance is the volume going away.
         */
        workspaceClaimed
          ? stat(path.join(workspaceDirectory, JOB_WORKSPACE_OWNER_FILE)).then(
              (entry) => entry.isFile(),
              () => false,
            )
          : Promise.resolve(true),
      ]);
    const vanished = [
      ...(sourceRootPresent ? [] : [paths.mediaRoot]),
      ...(scratchRootPresent && workspaceMarkerPresent ? [] : [paths.workRoot]),
    ];
    const available =
      vanished.length > 0
        ? false
        : storageAvailable
          ? await Promise.resolve(storageAvailable()).catch(() => false)
          : true;
    const failure = classifyFailure({
      message,
      // The errno, where there was one. Seyirlik's own storage refusals carry
      // a code and a plain-English message, and only the code is unambiguous.
      errorCode: (error as NodeJS.ErrnoException | undefined)?.code,
      storageAvailable: available,
      missingRoots: [...new Set([...(missingRoots?.() ?? []), ...vanished])],
    });
    /*
     * A disk that is full does not always say so.
     *
     * `ENOSPC` reaches the caller only when the failing call was the write that
     * ran out. Everything downstream of it fails differently: a file that was
     * never created is read back as `ENOENT`, an ffprobe of a truncated
     * fragment fails as a broken encode. Those were classified `source-missing`
     * and `encoder` — both permanent, both wrong, for a job that needs nothing
     * but room.
     *
     * So the volumes are asked how much space they have left, and only an
     * answer of "essentially none" overrides. The scope is deliberately narrow:
     * a genuine encoder fault on a healthy disk keeps its classification, and
     * only the two kinds that a full disk plausibly masquerades as are
     * reconsidered.
     */
    if (failure.kind === "source-missing" || failure.kind === "encoder") {
      const exhausted = await Promise.all(
        [paths.workRoot, paths.mediaRoot].map((root) =>
          statfs(root).then(
            (info) => info.bavail * info.bsize < 4 * 1024 * 1024,
            () => false,
          ),
        ),
      );
      if (exhausted.some(Boolean)) {
        return {
          ...base,
          status: "deferred-for-storage",
          error: "The output volume ran out of space.",
          issues: [failure.detail],
          failureKind: "out-of-space",
          workspaceDirectory,
          scratchIdentity: workspaceClaim?.identity ?? null,
        };
      }
    }
    /*
     * Both storage-loss kinds park the job rather than failing it. They differ
     * only in what an operator is told — a clean unmount against a device that
     * disappeared under active I/O — and neither is the job's fault.
     */
    if (
      failure.kind === "storage-unavailable" ||
      failure.kind === "storage-device-lost"
    ) {
      return {
        ...base,
        status: "interrupted",
        interruption: "storage",
        error: failure.summary,
        issues: [failure.detail],
        failureKind: failure.kind,
        workspaceDirectory,
        scratchIdentity: workspaceClaim?.identity ?? null,
      };
    }
    if (failure.kind === "out-of-space") {
      return {
        ...base,
        status: "deferred-for-storage",
        error: failure.summary,
        failureKind: failure.kind,
        workspaceDirectory,
        scratchIdentity: workspaceClaim?.identity ?? null,
      };
    }
    return {
      ...base,
      status: signal?.aborted ? "interrupted" : "failed",
      error: message,
      failureKind: failure.kind,
      workspaceDirectory,
      scratchIdentity: workspaceClaim?.identity ?? null,
    };
  } finally {
    if (scratchPoll) clearInterval(scratchPoll);
    await lock.release();
  }
}
