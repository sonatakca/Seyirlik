import path from "node:path";
import { readdir, rm } from "node:fs/promises";
import { createPauseController } from "../../../renditions/processing/pauseController";
import { planRetainedSidecarSubtitles } from "../../../renditions/adaptive/processor";
import {
  hasVerifiedScratchPackage,
  replaceableScratchPackageBytes,
  packageAdaptiveRendition,
} from "../../../renditions/adaptive/packager";
import { cleanupPublicationIncoming } from "../../../renditions/adaptive/publishTitle";
import { besideTitleRoot } from "../../../renditions/adaptive/titleRoot";
import {
  SUPPORTED_VIDEO_EXTENSIONS,
  isDerivativeFileName,
} from "../../../renditions/policy";
import { TitleRootConflictError } from "../../../renditions/adaptive/publishTitle";
import { estimateFinalOutputBytes } from "../../../renditions/outputEstimate";
import type { AdaptivePackageResult } from "../../../renditions/adaptive/packager";
import {
  detectHardware,
  type HardwareReport,
} from "../../../renditions/hardware/detect";
import type { RenditionPaths } from "../../../renditions/analysis";
import type { StorageIdentityProbe } from "../../../renditions/processing/storageIdentity";
import { probeMediaFile } from "../../../renditions/probe";
import { RenditionLockHeldError } from "../../../renditions/locks";
import {
  createFileRenditionRegistryStore,
  findRegistryItemById,
  type RenditionRegistryStore,
  RenditionRegistryUnreadableError,
  upsertRegistrySource,
} from "../../../renditions/registry";
import {
  checkpointBytes,
  checkpointRoot,
} from "../../../renditions/adaptive/epochs/checkpoints";
import { ADAPTIVE_PROFILE_VERSION } from "../../../renditions/adaptive/profile";
import {
  decideProcessing,
  freeBytesOn,
  type ProcessingDecision,
} from "../../../renditions/processing/decide";
import {
  createMediaStallDetector,
  createSpeedEstimator,
  estimateEncodeEtaSeconds,
} from "../../../renditions/adaptive/epochs/progress";
import { formatClock } from "../../../renditions/adaptive/epochs/engine";
import {
  stallThresholds,
  type StallThresholds,
} from "../../../renditions/adaptive/epochs/stallPolicy";
import {
  damageIntervalOf,
  describeInterval,
  sourceDamagePolicyFromEnvironment,
  type SourceDamagePolicy,
  type SourceDamageRecord,
} from "../../../renditions/adaptive/epochs/salvage";
import {
  classifyFailure,
  looksLikeOutOfSpace,
  type ProcessingFailureKind,
} from "../../../renditions/adaptive/epochs/failure";
import {
  assertOwnedJobWorkspace,
  verifyOwnedJobWorkspace,
} from "../../../renditions/storageRoles";
import {
  escalatePauseReason,
  type ProcessingJobRecord,
  type ProcessingJobStore,
  type ProcessingPauseReason,
} from "./jobStore";
import {
  createPermissiveStorageGuard,
  type StorageGuard,
} from "./storageGuard";
import { createDependencyGate } from "../../../renditions/processing/dependencyGate";
import type { DriveUploadTracker } from "./driveUpload";
import {
  clearLiveProgress,
  writeLiveProgress,
  type BuildPhase,
  type CompletedPhaseSummary,
  type LiveProgressSnapshot,
  type SourceIoStatus,
} from "./liveProgress";
import {
  globalPhaseFor,
  globalProgress,
  monotonic,
  planPhaseWeights,
  type PhaseWeights,
} from "./jobProgress";
import {
  calibratePhaseRates,
  describeCalibration,
  ESTIMATED_RATES,
} from "./phaseCalibration";
import {
  monotonicProgress,
  overallProgress,
  type ProcessingStage,
} from "./stages";

/**
 * Which durable stage each build phase belongs to.
 *
 * The phases the packager reports are finer than the stages the job record has
 * always carried, and the record's vocabulary is what history rows, the
 * timeline and every existing test are written against. Mapping rather than
 * renaming keeps both honest: `assembling` is the packaging stage, and an
 * operator watching sees the word that describes what is happening.
 */
const STAGE_FOR_PHASE: Readonly<Record<BuildPhase, ProcessingStage>> = {
  planning: "planning",
  encoding: "video",
  audio: "audio",
  subtitles: "subtitles",
  assembling: "packaging",
  validating: "validating",
  publishing: "publishing",
};

const PHASE_MESSAGES: Readonly<Record<BuildPhase, string>> = {
  planning: "Planning the checkpointed encode.",
  encoding: "Encoding the video ladder.",
  audio: "Encoding audio.",
  subtitles: "Converting subtitles.",
  assembling:
    "Assembling the checkpointed epochs into the final renditions. No video is re-encoded.",
  validating: "Validating the assembled package.",
  publishing: "Publishing the verified package.",
};

/**
 * How often the running job's row is written while the encoder reports.
 *
 * FFmpeg reports four times a second. Writing that to the database for hours,
 * per title, would be sustained write pressure for data nothing needs to
 * survive a restart — the durable progress is the checkpoints on disk. The fast
 * lane goes to the live-progress file instead; this is the slow one.
 */
export const PERSIST_INTERVAL_MS = 1_000;

/**
 * Smallest gap between live samples reaching the transient file.
 *
 * The phases after the encode report far more often than this — the assembler
 * on every write — so they are collapsed to roughly four samples a second,
 * which is the rate the encoder already sets and the rate the page's stream
 * polls at. Faster would be four file writes a second the reader cannot use.
 */
export const LIVE_PUBLISH_INTERVAL_MS = 250;

/**
 * How often the last confirmed sample is republished while nothing new arrives.
 *
 * Some operations legitimately report nothing for minutes: ffprobe walking a
 * ten-gigabyte rendition, a publish that has to copy across volumes. The
 * reader drops a sample older than six seconds — correctly, because that is
 * how a dead worker is detected — so without this the panel vanished in the
 * middle of work that was going perfectly well.
 *
 * The heartbeat republishes the *same* figures with a fresh publication time.
 * It never advances progress by so much as a byte; `confirmedAtMs` keeps
 * saying when the values were really measured, which is what the page uses to
 * decide that a throughput or an estimate has gone stale.
 */
export const LIVE_HEARTBEAT_INTERVAL_MS = 2_000;

/**
 * Runs one processing job from analysis to publication.
 *
 * Every stage transition and every progress update goes through the store, so
 * the record on disk is always what the UI would show — a worker that dies
 * leaves a job whose last honest state is already persisted, rather than one
 * whose progress lived only in memory.
 */

export interface ProcessingJobRunnerDeps {
  store: ProcessingJobStore;
  /** What the processing page calls this machine; see `processedBy`. */
  workerName?: string;
  paths: RenditionPaths;
  registry?: RenditionRegistryStore;
  mediaRoot: string;
  ffmpegPath?: string;
  ffprobePath?: string;
  softwareThreads?: number;
  /** Injected in tests so nothing spawns FFmpeg. */
  detectHardwareFn?: typeof detectHardware;
  packageFn?: typeof packageAdaptiveRendition;
  probeFn?: typeof probeMediaFile;
  /** Free bytes on the output volume. Injected so tests can force a shortfall. */
  freeBytesFn?: typeof freeBytesOn;
  /** Whether a verified package is already on scratch. Injected in tests. */
  verifiedPackageFn?: typeof hasVerifiedScratchPackage;
  /** Bytes of an unverified scratch package a rebuild removes. Injected in tests. */
  replaceablePackageFn?: typeof replaceableScratchPackageBytes;
  /**
   * Whether the storage this work needs is currently available.
   *
   * Consulted when an encode fails, because the failure a vanished volume
   * produces is an ordinary-looking `ENOENT` on an output path — indisting-
   * uishable by its code from a genuinely missing file. Asking the storage
   * itself is the only reliable way to tell "the drive was unplugged" from
   * "this source is gone", and getting that wrong turned every accidental
   * disconnect into a permanent failure.
   */
  storageAvailableFn?: () => boolean | Promise<boolean>;
  /** Which roots failed their last check, so an error can name the drive. */
  missingRootsFn?: () => readonly string[];
  /**
   * The durable verdict on whether this storage may be worked against at all.
   *
   * Distinct from `storageAvailableFn`, which asks the volume a question, and
   * deliberately consulted first. On the failure this exists for, the volume
   * answered that question correctly — the mount was there, the directory
   * listed — while its block layer returned `EIO` on every read. Availability
   * is what the drive says about itself; the guard is what this system
   * remembers about the drive, and only one of those survives a reboot.
   */
  storageGuard?: StorageGuard;
  /** Reads a path's volume identity. `diskutil` in production, injected in tests. */
  scratchIdentityProbe?: StorageIdentityProbe;
  /**
   * Nominal epoch length. Thirty minutes in production; a deployment with very
   * short titles or very slow storage can shorten it, at the cost of one FFmpeg
   * start and one validation pass more often.
   */
  epochTargetSeconds?: number;
  /**
   * Follows a published package up to Google Drive, where publication only
   * reaches a mount's write-back cache. Absent where there is no such mount.
   */
  driveUploads?: DriveUploadTracker;
  /**
   * What to do when part of a source cannot be read at all.
   *
   * Defaults to the deployment's environment setting, which itself defaults to
   * the strict behaviour. A library on a failing drive can be told to salvage
   * without changing what every other deployment does.
   */
  sourceDamagePolicy?: SourceDamagePolicy;
  /**
   * How patient this deployment is with an encoder that stops producing.
   *
   * The same object the encoder's watchdog uses, so the page's "waiting for
   * source data" and the termination that follows it cannot be working to
   * different clocks.
   */
  stalls?: StallThresholds;
  now?: () => number;
}

/**
 * The published package's location for this run, read in exactly one place so
 * publishing and its cleanup can never point at different directories.
 *
 * The fallback is for a job that genuinely carries no destination — an offline
 * caller, or a row queued before episodes had their own folders. It is *not* a
 * repair for a destination that arrived malformed: for an episode, the
 * directory beside the source is the season folder its neighbours publish into,
 * so quietly falling back there is how one title comes to overwrite ten. A
 * present-but-unusable value is a defect in whoever queued the job, and it stops
 * the run instead of choosing a destination on their behalf.
 */
async function titleRootForInput(
  input: RunProcessingJobInput,
): Promise<string> {
  const titleRoot = input.titleRoot as unknown;
  if (titleRoot !== undefined && titleRoot !== null) {
    if (typeof titleRoot !== "string" || titleRoot.trim() === "") {
      throw new Error(
        `Processing job ${input.processingJobId} carries an unusable titleRoot ` +
          `(${JSON.stringify(titleRoot)}). Refusing to guess a publish ` +
          `destination for ${input.relativePath}.`,
      );
    }
    return titleRoot;
  }

  /*
   * No destination was carried, so the only one left to infer is the folder
   * beside the source. That is right for a folder holding one title and wrong
   * for one holding many — a season folder, where publishing beside means
   * publishing over the neighbours, one episode at a time, each publish
   * reporting success.
   *
   * The inference is therefore allowed only where it is unambiguous. A caller
   * that means to publish into a shared folder has to say so, and a caller that
   * simply forgot gets a stopped job instead of a deleted one. This has been
   * forgotten twice — once by a requeue that dropped the field, once by a queue
   * handler that never read it — which is the argument for the check rather
   * than against it.
   */
  const beside = besideTitleRoot(input.sourcePath);
  /*
   * How many sources share this file's folder — its *own* folder, which in an
   * organised library is the `src/` bucket rather than the title folder
   * `beside` resolves to. Counting in `beside` would find a season folder
   * holding no loose sources at all now that they live in the bucket, and read
   * that as "one title here", which is the answer that publishes an episode
   * over its whole season.
   */
  const folder = path.dirname(input.sourcePath);
  const siblings = await readdir(folder).catch(() => null);
  if (siblings === null) return beside;
  const sources = siblings.filter(
    (name) =>
      !name.startsWith("._") &&
      SUPPORTED_VIDEO_EXTENSIONS.has(path.extname(name).toLowerCase()) &&
      !isDerivativeFileName(name),
  );
  if (sources.length > 1) {
    throw new Error(
      `Processing job ${input.processingJobId} carries no publish destination, ` +
        `and ${folder} holds ${sources.length} sources, so the folder beside ` +
        `the source is not this title's. Refusing to publish ` +
        `${input.relativePath} over its neighbours.`,
    );
  }
  return beside;
}

export interface RunProcessingJobInput {
  processingJobId: string;
  sourcePath: string;
  relativePath: string;
  sizeBytes: number;
  mtimeMs: number;
  /**
   * Where this title's package is published, decided by the catalogue when the
   * job was queued.
   *
   * Absent on jobs queued before episodes existed, and on every offline
   * caller, which is why it falls back to the directory beside the source —
   * the layout every package written until now uses.
   */
  titleRoot?: string;
  signal?: AbortSignal;
  isCancelled?: () => Promise<boolean>;
}

export interface RunProcessingJobOutcome {
  /**
   * `waiting-for-storage` is a recoverable outcome, not an ending: the job is
   * paused with its reason recorded and will be requeued automatically once
   * the volume it needs is back.
   */
  status: "succeeded" | "failed" | "cancelled" | "waiting-for-storage";
  decision?: ProcessingDecision;
  packageResult?: AdaptivePackageResult;
  errorCode?: string;
  errorMessage?: string;
  /**
   * Set when the failure is a condition of the moment rather than a defect in
   * the job — another attempt holding the rendition lock is the case that
   * matters. Such a job must go back on the queue: failing it outright leaves
   * a perfectly processable title needing a person to notice and requeue it.
   */
  retryable?: boolean;
}

/** Structured codes so the UI can offer the right next action. */
export const PROCESSING_ERROR_CODES = {
  sourceChanged: "SOURCE_CHANGED",
  noVideo: "NO_VIDEO_STREAM",
  tooSmall: "SOURCE_TOO_SMALL",
  insufficientSpace: "INSUFFICIENT_DISK_SPACE",
  validationFailed: "VALIDATION_FAILED",
  encodeFailed: "ENCODE_FAILED",
  /**
   * A region of the source cannot be read, and the policy in force says not to
   * substitute anything for it.
   *
   * Its own code because it is the one failure that must never be requeued
   * automatically: the next attempt would read the same dead sectors, take tens
   * of seconds per one, and fail in the same place. Repairing or replacing the
   * media is a person's job, and the button for it is on the page.
   */
  sourceUnreadable: "SOURCE_UNREADABLE",
  /**
   * The encoder stopped producing while the source read perfectly.
   *
   * Also not requeued: whatever wedged it is in the encode, and doing it again
   * wedges it again. Distinct from a source failure so nobody blames a disk for
   * it.
   */
  mediaProgressTimeout: "MEDIA_PROGRESS_TIMEOUT",
  /**
   * A network volume stopped answering mid-read and waiting did not bring it
   * back.
   *
   * Requeued, unlike the two above: a cloud mount that was slow for a few
   * minutes is usually quick again by the queue's next attempt, and nothing
   * about the media or the encode is in doubt.
   */
  sourceReadStalled: "SOURCE_READ_STALLED",
  /**
   * The package was built correctly but the folder it was told to publish into
   * belongs to a different title.
   *
   * Never requeued: another attempt resolves the same wrong destination and is
   * refused in the same place. The encode is sound; what needs correcting is
   * whatever decided where it goes.
   */
  titleRootConflict: "TITLE_ROOT_CONFLICT",
  cancelled: "CANCELLED",
} as const;

/**
 * Which failures the *queue* should try again, and which are a person's.
 *
 * The queue's retry exists for conditions of the moment — a lock another
 * attempt is holding, a blip — and it is exactly wrong for a physical fault:
 * requeuing a title whose source has an unreadable region sends the encoder
 * straight back into it, which is what happened when a watchdog termination
 * reached the queue looking like an ordinary error.
 */
export function failureIsWorthRequeuing(
  kind: ProcessingFailureKind | undefined,
): boolean {
  if (kind === undefined) return false;
  return !(
    kind === "source-io" ||
    kind === "storage-device-lost" ||
    kind === "storage-io" ||
    kind === "storage-soft-fault" ||
    kind === "media-progress-timeout" ||
    kind === "encoder"
  );
}

export function createProcessingJobRunner(deps: ProcessingJobRunnerDeps) {
  const {
    store,
    paths,
    ffmpegPath = process.env.SEYIRLIK_FFMPEG_PATH ?? "ffmpeg",
    ffprobePath = process.env.SEYIRLIK_FFPROBE_PATH ?? "ffprobe",
    softwareThreads,
    workerName,
    detectHardwareFn = detectHardware,
    packageFn = packageAdaptiveRendition,
    probeFn = probeMediaFile,
    freeBytesFn = freeBytesOn,
    verifiedPackageFn = hasVerifiedScratchPackage,
    replaceablePackageFn = replaceableScratchPackageBytes,
    storageAvailableFn,
    missingRootsFn,
    storageGuard = createPermissiveStorageGuard(),
    scratchIdentityProbe,
    epochTargetSeconds,
    driveUploads,
    sourceDamagePolicy = sourceDamagePolicyFromEnvironment(),
    stalls = stallThresholds(),
  } = deps;
  // Older callers and isolated tests predate the dedicated scratch root.
  // Keeping their work under the state root preserves the same ownership
  // checks without ever falling back to an unscoped filesystem location.
  const workRoot = paths.workRoot ?? paths.stateRoot;
  const registryStore =
    deps.registry ??
    createFileRenditionRegistryStore(
      path.join(paths.stateRoot, "registry.json"),
    );

  async function enterStage(
    job: ProcessingJobRecord,
    stage: ProcessingStage,
    message: string,
    detail?: Record<string, unknown>,
  ): Promise<void> {
    await store.update(job.id, {
      stage,
      stageProgress: 0,
      overallProgress: overallProgress(stage, 0),
    });
    await store.appendEvent({
      processingJobId: job.id,
      stage,
      message,
      ...(detail ? { detail } : {}),
    });
  }

  /**
   * One attempt, from analysis to publication.
   *
   * Wrapped below rather than exposed directly, because everything in here
   * talks to a database and a database can blink. An exception escaping this
   * function used to reach the task queue as an ordinary error, and an ordinary
   * error is requeued — which is how a job whose encoder had just been stopped
   * on a damaged region was sent straight back into it.
   */
  async function attempt(
    input: RunProcessingJobInput,
  ): Promise<RunProcessingJobOutcome> {
    const job = await store.get(input.processingJobId);
    if (!job) {
      return {
        status: "failed",
        errorCode: "JOB_NOT_FOUND",
        errorMessage: "The processing job no longer exists.",
      };
    }

    /*
     * A pause that was asked for before this attempt began.
     *
     * Until now a pause was only observed from inside the encode loop, so it
     * stopped a job that was already running and did nothing at all to one that
     * was merely queued. A worker restarting — and this one is kept alive by
     * launchd, so it restarts by itself — would lease the next paused job and
     * start a fresh encode on it, which is the opposite of what the operator
     * pressed the button for. A pause has to hold at the door as well as in the
     * room.
     *
     * Left in `paused` rather than failed: nothing is wrong with the job, and it
     * must be exactly as resumable afterwards as it was before the worker
     * happened to pick it up.
     */
    if (job.pauseRequested) {
      await clearLiveProgress(job.id).catch(() => undefined);
      await store.update(job.id, {
        state: "paused",
        finishedAt: null,
        speed: null,
        fps: null,
        etaSeconds: null,
      });
      await store.appendEvent({
        processingJobId: job.id,
        stage: "waiting",
        level: "info",
        message: "Not starting: the job is paused.",
        detail: { pausedReason: job.pausedReason },
      });
      return { status: "waiting-for-storage" as const };
    }

    /*
     * The gate, before anything else in the attempt — before the probe, before
     * hardware detection, before a single byte is read.
     *
     * This is the line that stops a backlog being fed to a failing drive one
     * title at a time. The queue can still lease the job, because the queue
     * knows nothing about volumes; what it gets back is a job parked with its
     * reason recorded rather than a job that spent forty seconds in a kernel
     * retry sequence discovering the same thing. Placing it here rather than in
     * the queue also means it applies to every route into an attempt — the
     * automatic requeue, an operator's retry, a lease reclaimed after a crash.
     */
    if (!storageGuard.mayStartWork()) {
      await clearLiveProgress(job.id).catch(() => undefined);
      await store.update(job.id, {
        state: "paused",
        pauseRequested: true,
        /*
         * Escalated, never re-labelled. A job parked by a previous attempt's
         * `finishStorageInterrupted` keeps its reason but not its pause
         * request, so it can be leased again and arrive here — and the guard's
         * state now is not the state that classified the fault then. Writing
         * the derived reason flat is how a quarantine became automatically
         * resumable once the drive was merely unplugged.
         */
        pausedReason: escalatePauseReason(
          job.pausedReason,
          storageGuard.health.state === "unavailable"
            ? "storage-unavailable"
            : storageGuard.health.state === "recovery-pending"
              ? "recovery-pending"
              : "storage-quarantined",
        ),
        finishedAt: null,
        speed: null,
        fps: null,
        etaSeconds: null,
      });
      await store.appendEvent({
        processingJobId: job.id,
        stage: "waiting",
        level: "warning",
        message: `Not starting. ${storageGuard.describe()}`,
        detail: { storageState: storageGuard.health.state },
      });
      return { status: "waiting-for-storage" as const };
    }

    /*
     * Identity before heavy work, for external media.
     *
     * `ensureIdentity` is cheap and cached, and this is the right moment for it:
     * the storage is healthy, so asking costs nothing, and afterwards nothing
     * asks the device anything until an operator does. Starting an encode in the
     * hope that identity can be recovered later is the trade this refuses —
     * later is precisely when the volume is failing, and a fault recorded
     * against an unidentified disk leaves recovery with nothing to match.
     */
    await storageGuard.ensureIdentity().catch(() => undefined);
    const identityVerdict = storageGuard.identityPermitsWork();
    if (!identityVerdict.ok) {
      await clearLiveProgress(job.id).catch(() => undefined);
      await store.update(job.id, {
        state: "paused",
        pauseRequested: true,
        // An unidentifiable volume is a reason to hold, never a reason to
        // soften a hold something else already recorded.
        pausedReason: escalatePauseReason(job.pausedReason, "recovery-pending"),
        finishedAt: null,
        speed: null,
        fps: null,
        etaSeconds: null,
      });
      await store.appendEvent({
        processingJobId: job.id,
        stage: "waiting",
        level: "warning",
        message: `Not starting. ${identityVerdict.reason}`,
        detail: { storageState: storageGuard.health.state },
      });
      return { status: "waiting-for-storage" as const };
    }

    const fail = async (code: string, message: string, retryable = false) => {
      await clearLiveProgress(job.id);
      await store.update(job.id, {
        state: "failed",
        errorCode: code,
        errorMessage: message,
        finishedAt: new Date(),
      });
      await store.appendEvent({
        processingJobId: job.id,
        stage: job.stage,
        level: "error",
        message,
      });
      return {
        status: "failed" as const,
        errorCode: code,
        errorMessage: message,
        ...(retryable ? { retryable: true } : {}),
      };
    };

    const cancelled = async () => {
      if (input.signal?.aborted) return true;
      if (await input.isCancelled?.()) return true;
      const latest = await store.get(job.id);
      return latest?.cancellationRequested === true;
    };

    const finishCancelled = async () => {
      await clearLiveProgress(job.id);
      await store.update(job.id, {
        state: "cancelled",
        errorCode: PROCESSING_ERROR_CODES.cancelled,
        errorMessage: "Processing was cancelled.",
        finishedAt: new Date(),
      });
      await store.appendEvent({
        processingJobId: job.id,
        stage: "waiting",
        level: "warning",
        message:
          "Processing was cancelled. Any published package is untouched.",
      });
      return { status: "cancelled" as const };
    };

    /**
     * The reason this attempt has already recorded for its storage pause.
     *
     * Declared here rather than beside `storageInterrupted` because
     * `finishStorageInterrupted` closes over it and is reachable well before
     * that point. It is a fallback, not the source of truth — the row is —
     * for the case where the database cannot be read at the moment the encode
     * is finally reaped.
     */
    let storageInterruptedReason: ProcessingPauseReason | null = null;

    /**
     * The encode stopped because its storage went away.
     *
     * Deliberately not a failure: nothing is wrong with the source, the plan
     * or the package, and marking it failed is what forced a person to press
     * Retry after every accidental unplug. The job stays paused with the
     * reason recorded, keeps no finish time because it has not finished, and
     * is picked up again automatically when the volume returns — but only if
     * the reason it ends up with is the clean one. A fault already recorded
     * against this pause outranks whatever the guard happens to say by the
     * time the encoder is finally reaped, and holds the job for a person.
     */
    const finishStorageInterrupted = async (
      detail?: string,
      failureKind?: ProcessingFailureKind,
    ) => {
      if (failureKind && storageGuard.health.state !== "quarantined") {
        await storageGuard.reportFailure({
          kind: failureKind,
          detail: detail ?? "Storage interrupted active processing.",
          processingJobId: job.id,
        });
      }
      /*
       * What the guard says *now* — which is not necessarily what it said when
       * the encode was stopped.
       *
       * This runs once FFmpeg has actually been reaped, and on a wedged
       * process against a bad region that takes minutes. In that gap a
       * quarantined volume can read as merely absent, and writing this answer
       * flat is what turned a quarantine into `storage-unavailable` on job
       * 21f644c2: nineteen minutes after the supervisor tick had correctly
       * recorded the fault.
       */
      const observed =
        storageGuard.health.state === "quarantined" ||
        storageGuard.health.state === "suspect"
          ? "storage-quarantined"
          : storageGuard.health.state === "recovery-pending"
            ? "recovery-pending"
            : "storage-unavailable";
      /*
       * The row is the authority on what has already been decided about this
       * pause, including by a previous process. The in-memory stamp is the
       * fallback for the case the row cannot be read — a database that blinks
       * must not be able to launder a quarantine, and this function is reached
       * on exactly the paths where the machine is already unwell.
       */
      const parked = await store.get(job.id).catch(() => null);
      const pausedReason = [
        parked?.pausedReason,
        storageInterruptedReason,
      ].reduce<ProcessingPauseReason>(
        (held, candidate) => escalatePauseReason(candidate, held),
        observed,
      );
      storageInterruptedReason = pausedReason;
      /*
       * The live sample goes but the durable row keeps its epoch position, so
       * a page opened while the drive is missing still says how much work is
       * protected and which five minutes will be redone.
       */
      await clearLiveProgress(job.id);
      await store.update(job.id, {
        state: "paused",
        /*
         * The reason is what makes the pause recoverable.
         * `requeueStorageInterruptedJobs` looks for work with
         * `listPaused("storage-unavailable")`, which reads this column. The
         * encoder classifies an I/O error as storage loss before the watchdog
         * has polled, so without stamping it here that ordinary path leaves a
         * job paused with no reason, no error and nothing that will ever pick
         * it up again.
         */
        pausedReason,
        // It has not finished, so it must not carry a finish time.
        finishedAt: null,
        speed: null,
        fps: null,
        etaSeconds: null,
        errorCode: null,
        errorMessage: null,
      });
      /*
       * The history follows the reason that was actually written, not the
       * guard's current mood. A job held for a person that says "waiting for
       * the drive" is the same lie as the chip on the page: it promises a
       * return nothing is going to deliver.
       */
      const heldReason =
        pausedReason === "operator"
          ? "A person paused this job; the storage returning does not lift that."
          : observed === pausedReason
            ? storageGuard.describe()
            : "The fault recorded when the encoder was stopped still holds this job for an operator.";
      await store.appendEvent({
        processingJobId: job.id,
        stage: "waiting",
        level: "warning",
        message:
          pausedReason === "storage-unavailable"
            ? detail
              ? `Waiting for storage. ${detail} Every completed checkpoint is untouched; only the epoch that was running will be built again.`
              : "Waiting for storage. Every completed checkpoint is untouched; only the epoch that was running will be built again."
            : `Processing stopped. ${heldReason} Every completed checkpoint is untouched.`,
        detail: { storageState: storageGuard.health.state, pausedReason },
      });
      return { status: "waiting-for-storage" as const };
    };

    /*
     * An attempt begins here whether it arrived through a retry or through
     * the queue re-leasing an abandoned job, so the invariants are enforced
     * at the point work actually starts rather than only on one path. A
     * running attempt cannot carry a finish time, and its progress and
     * telemetry describe this attempt alone — the previous one's 89% must
     * not make a run that has just begun look nearly done.
     */
    await store.update(job.id, {
      state: "running",
      startedAt: new Date(),
      finishedAt: null,
      stageProgress: 0,
      overallProgress: 0,
      speed: null,
      fps: null,
      etaSeconds: null,
      validation: null,
      errorCode: null,
      errorMessage: null,
    });
    await store.incrementAttempts(job.id);

    // ---------------------------------------------------------- analysing
    await enterStage(job, "analysing", "Analysing the source.");
    if (await cancelled()) return finishCancelled();

    let probe: Awaited<ReturnType<typeof probeMediaFile>>;
    try {
      probe = await probeFn(input.sourcePath, ffprobePath, input.signal);
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "The source could not be probed.";
      const failure = classifyFailure({
        message,
        storageAvailable: storageAvailableFn
          ? await storageAvailableFn()
          : true,
        ...(missingRootsFn ? { missingRoots: missingRootsFn() } : {}),
      });
      if (
        failure.kind === "storage-unavailable" ||
        failure.kind === "storage-device-lost" ||
        failure.kind === "storage-io" ||
        failure.kind === "storage-soft-fault" ||
        failure.kind === "source-io"
      ) {
        return finishStorageInterrupted(failure.detail, failure.kind);
      }
      return fail(PROCESSING_ERROR_CODES.noVideo, message);
    }
    await store.appendEvent({
      processingJobId: job.id,
      stage: "analysing",
      message: `Analysing ${probe.audioTracks.length} audio and ${probe.subtitleTracks.length} subtitle ${probe.subtitleTracks.length === 1 ? "track" : "tracks"}`,
    });
    /*
     * Provisional weights: neither the plan nor this machine's measured
     * rates are known yet, so the source's own size stands in for the
     * package's. Analysis is worth a sliver under any weighting, and the
     * committed weights land moments later — but the value is kept so the
     * next write can be held at or above it rather than stepping down when
     * the real denominator turns out to be larger.
     */
    const analysedProgress = globalProgress(
      planPhaseWeights({
        sourceDurationSeconds: probe.durationSeconds,
        audioTrackCount: probe.audioTracks.length,
        subtitleTrackCount: probe.subtitleTracks.length,
        outputBytes: input.sizeBytes,
      }),
      "analysing",
      1,
    );
    await store.update(job.id, {
      stageProgress: 1,
      overallProgress: analysedProgress,
    });

    // ----------------------------------------------------------- planning
    await enterStage(job, "planning", "Choosing the processing plan.");
    if (await cancelled()) return finishCancelled();

    let hardware: HardwareReport;
    try {
      hardware = await detectHardwareFn({
        ffmpegPath,
        probeWidth: 1920,
        probeHeight: 1080,
        ...(input.signal ? { signal: input.signal } : {}),
      });
    } catch {
      return fail(
        PROCESSING_ERROR_CODES.encodeFailed,
        "No usable video encoder was found on this machine.",
      );
    }

    // The expensive writes land on scratch; media-root free space is checked
    // separately by the transactional publisher immediately before copying.
    const freeBytes = await freeBytesFn(workRoot);
    // Credit disk occupancy, never the database's remembered checkpoint count.
    // Unowned, missing, or unreadable scratch receives no credit. The packager
    // validates and reuses epochs before encoding and applies the same budget.
    const inheritedBytes = await verifyOwnedJobWorkspace(
      workRoot,
      path.join(workRoot, job.id),
      job.id,
    )
      .then(async () => {
        const checkpoints = await checkpointBytes(
          checkpointRoot(
            workRoot,
            job.id,
            ADAPTIVE_PROFILE_VERSION,
            job.sourceFingerprint,
          ),
        );
        // An assembled package awaiting validation is removed before the
        // rebuild, so its bytes come back too.
        const replaceable = await replaceablePackageFn({
          workRoot,
          workspaceId: job.id,
          sourceFingerprint: job.sourceFingerprint,
        }).catch(() => 0);
        return checkpoints + replaceable;
      })
      .catch(() => 0);
    const decision = decideProcessing({
      inheritedBytes,
      probe,
      container: path.extname(input.sourcePath).replace(".", ""),
      sizeBytes: input.sizeBytes,
      hardware,
      ...(freeBytes === undefined ? {} : { freeBytes }),
    });

    /*
     * The bar's denominator, committed here and never revised.
     *
     * The workloads are known exactly now: the source's duration, the tracks
     * the plan retains, the package's estimated size. The rates that turn
     * them into comparable costs are read off this machine's own completed
     * jobs — its real encoder speed, its real storage throughput — falling
     * back to documented estimates only where it has no history to answer
     * from. Committed once rather than refined as the job runs, because a
     * denominator that changes is a bar that can walk backwards.
     */
    const calibration = await (async () => {
      /*
       * A history that cannot be read is not a reason to fail a job. The
       * estimates stand in, the diagnostics say so, and the encode proceeds
       * — this is the bar's scale, not the work.
       */
      try {
        return calibratePhaseRates(await store.listPhaseTimings(20), {
          encoder: decision.videoEncoder,
        });
      } catch {
        return { rates: ESTIMATED_RATES, measured: {}, consideredJobs: 0 };
      }
    })();
    const weights: PhaseWeights = planPhaseWeights(
      {
        sourceDurationSeconds: probe.durationSeconds,
        audioTrackCount: decision.streams.keptAudioStreamIndexes.length,
        subtitleTrackCount: decision.streams.keptSubtitleStreamIndexes.length,
        outputBytes: decision.estimate.outputBytes,
      },
      calibration.rates,
    );
    await store.appendEvent({
      processingJobId: job.id,
      stage: "planning",
      message: describeCalibration(calibration),
      detail: {
        measuredRates: calibration.measured,
        consideredJobs: calibration.consideredJobs,
      },
    });

    await store.update(job.id, {
      hardwareAdapter: decision.hardwareAdapter,
      videoEncoder: decision.videoEncoder,
      ...(workerName ? { processedBy: workerName } : {}),
      warnings: decision.warnings,
      sourceDurationSeconds: probe.durationSeconds,
      // Shown beside the protected bytes so an operator can see the headroom
      // the rest of the ladder has to fit into.
      ...(freeBytes === undefined ? {} : { freeBytes }),
      stageProgress: 1,
      /*
       * The cumulative bar, from the same weighted model the live samples
       * use. The old stage-weighted figure put a job that had merely chosen
       * a plan at 3% of a four-hour encode; this puts it where the work
       * actually is, which for analysis and planning is a sliver.
       */
      overallProgress: Math.max(
        analysedProgress,
        globalProgress(weights, "planning", 1),
      ),
    });
    await store.appendEvent({
      processingJobId: job.id,
      stage: "planning",
      message: decision.summary,
      detail: { decision: decision as unknown as Record<string, unknown> },
    });
    for (const entry of decision.streams.audio) {
      await store.appendEvent({
        processingJobId: job.id,
        stage: "planning",
        message: entry.explanation,
      });
    }
    for (const entry of decision.streams.subtitles) {
      await store.appendEvent({
        processingJobId: job.id,
        stage: "planning",
        message: entry.explanation,
        ...(entry.requiresOcr ? { level: "warning" as const } : {}),
      });
    }

    if (decision.action === "reject-no-video") {
      return fail(PROCESSING_ERROR_CODES.noVideo, decision.summary);
    }
    if (decision.action === "reject-too-small") {
      return fail(PROCESSING_ERROR_CODES.tooSmall, decision.summary);
    }
    if (!decision.estimate.sufficient) {
      /*
       * The estimate is for building the package from nothing. A job whose
       * earlier attempt finished and verified it, and was stopped while
       * publishing, needs no new scratch: the packager resumes straight into
       * publishing, and the publisher checks the media volume's space itself.
       * Without this, a restart during publishing turned a finished encode
       * into a failure, and the next restart's scratch sweep deleted it.
       */
      const alreadyBuilt = await verifiedPackageFn({
        workRoot,
        workspaceId: job.id,
        sourceFingerprint: job.sourceFingerprint,
      }).catch(() => false);
      if (!alreadyBuilt) {
        return fail(
          PROCESSING_ERROR_CODES.insufficientSpace,
          "There is not enough free space for this package and its staging copy.",
        );
      }
      await store.appendEvent({
        processingJobId: job.id,
        stage: "planning",
        message:
          "The package was already built and verified by an earlier attempt; only publishing remains, so no new scratch space is needed.",
      });
    }

    // ------------------------------------------------- video/audio/subs
    /*
     * The diagnostics name the rungs this run will encode, not the ladder the
     * finished package holds. Logging the whole ladder for a one-rung job was
     * how a job that encoded only 1440p still read as "Encoding 2160p, 1440p,
     * 1080p, ..." in its own history.
     */
    const encodedRungs =
      decision.renditionsToEncode && decision.renditionsToEncode.length > 0
        ? decision.renditionsToEncode
        : decision.ladder.map((rung) => rung.qualityHeight);
    await enterStage(
      job,
      "video",
      `Encoding ${encodedRungs.map((height) => `${height}p`).join(", ")} ` +
        `${decision.videoCodec === "hevc" ? "HEVC" : "H.264"} with ${hardware.adapters.find((adapter) => adapter.id === decision.hardwareAdapter)?.label ?? decision.hardwareAdapter}`,
    );
    if (await cancelled()) return finishCancelled();

    const durationSeconds = probe.durationSeconds;
    // Scoped to this attempt: the record was just reset, and the in-memory
    // `job` still holds the previous attempt's figure.
    let lastOverall = 0;
    /** This job's current guess at its own final size, refined as it runs. */
    let lastEstimateBytes: number | undefined;

    /*
     * The live sample, kept in memory and republished on every change.
     *
     * Held as one object rather than a handful of variables so the transient
     * file and the durable row can never describe different moments.
     */
    const live: {
      stage: ProcessingStage;
      phase: BuildPhase;
      epochIndex: number | null;
      epochCount: number | null;
      epochStartSeconds: number | null;
      epochEndSeconds: number | null;
      epochFraction: number | null;
      completedEpochs: number;
      protectedSeconds: number;
      encodedSeconds: number;
      sourceDurationSeconds: number;
      fps?: number;
      speed?: number;
      smoothedSpeed?: number;
      etaSeconds?: number;
      writtenBytes?: number;
      globalProgress?: number;
      phaseFraction?: number;
      planning?: LiveProgressSnapshot["planning"];
      audio?: LiveProgressSnapshot["audio"];
      subtitles?: LiveProgressSnapshot["subtitles"];
      assembly?: LiveProgressSnapshot["assembly"];
      verification?: LiveProgressSnapshot["verification"];
      publish?: LiveProgressSnapshot["publish"];
      sourceIo?: SourceIoStatus;
    } = {
      stage: "video",
      phase: "planning",
      epochIndex: null,
      epochCount: null,
      epochStartSeconds: null,
      epochEndSeconds: null,
      epochFraction: null,
      completedEpochs: 0,
      protectedSeconds: 0,
      encodedSeconds: 0,
      sourceDurationSeconds: durationSeconds,
    };
    let revision = 0;
    let lastPersistMs = 0;
    let lastLivePublishMs = 0;
    let etaWasKnown = false;
    let checkpointBytesWritten = 0;
    let speed = createSpeedEstimator();
    /*
     * Media time, watched rather than the reports about it. FFmpeg keeps
     * reporting while it is blocked on an unreadable sector — same out_time,
     * four times a second, with a speed that falls a little further each
     * time — and showing that is a page confidently animating a rate for a
     * process that is doing nothing.
     */
    let mediaStall = createMediaStallDetector({
      stallAfterMs: stalls.softStallMs,
    });
    /** Intervals this attempt has replaced, in the order they were found. */
    const sourceDamage: SourceDamageRecord[] = [];

    /** Phase summaries, for the compact history under the live panel. */
    const completedPhases: CompletedPhaseSummary[] = [];
    let phaseStartedMs = Date.now();
    /**
     * The global bar's high-water mark.
     *
     * Separate from `lastOverall`, which is the durable row's stage-weighted
     * figure and stays as it is so nothing reading the API changes meaning.
     */
    let lastGlobal = Math.max(
      analysedProgress,
      globalProgress(weights, "planning", 1),
    );
    /*
     * Seeded, so that a sample published before the first phase reports —
     * the heartbeat, or a stage transition — carries the position the job is
     * genuinely at rather than no position at all.
     */
    live.globalProgress = lastGlobal;

    /**
     * Records the phase's measured position and returns the global value.
     *
     * The single place a phase fraction becomes a bar position, so no caller
     * can invent one: every one of them passes a fraction it measured.
     */
    const advance = (phase: BuildPhase, fraction: number): number => {
      live.phaseFraction = Math.min(1, Math.max(0, fraction));
      lastGlobal = monotonic(
        lastGlobal,
        globalProgress(weights, globalPhaseFor(phase), fraction),
      );
      live.globalProgress = lastGlobal;
      return lastGlobal;
    };

    /**
     * Publishes at most four samples a second.
     *
     * The assembler reports on every write and FFmpeg four times a second;
     * collapsing them here is what keeps the transient file from being
     * rewritten hundreds of times a second while still moving at the rate the
     * page reads it. `force` is for state changes — a phase beginning, a
     * phase ending — which must not wait for the next slot.
     */
    const publishLiveThrottled = (force = false, confirmed = true): void => {
      const at = Date.now();
      /*
       * Every call here follows a report, and only a report that carried new
       * measurements moves this. A sample repeating the same media time is
       * FFmpeg saying it is alive, not that it is working, and treating the
       * two alike is what kept a falling speed on the page for minutes while
       * the encoder was blocked on a platter.
       */
      if (confirmed) confirmedAtMs = at;
      if (!force && at - lastLivePublishMs < LIVE_PUBLISH_INTERVAL_MS) return;
      lastLivePublishMs = at;
      void publishLive();
    };

    /*
     * The heartbeat. It republishes what is already there, so a phase in the
     * middle of one long operation keeps its panel while contributing nothing
     * to progress. `confirmedAtMs` is untouched, which is what lets the page
     * tell "still working, nothing new to report" from "measured a moment
     * ago".
     */
    const heartbeat = setInterval(() => {
      if (Date.now() - lastLivePublishMs < LIVE_HEARTBEAT_INTERVAL_MS) return;
      lastLivePublishMs = Date.now();
      void publishLive();
    }, LIVE_HEARTBEAT_INTERVAL_MS);

    /** Closes the running phase and starts the next one's clock. */
    const closePhase = (
      phase: BuildPhase,
      summary: Omit<CompletedPhaseSummary, "phase" | "elapsedSeconds">,
    ): void => {
      const elapsedSeconds = Math.max(
        0,
        Math.round((Date.now() - phaseStartedMs) / 1000),
      );
      if (!completedPhases.some((entry) => entry.phase === phase)) {
        completedPhases.push({ phase, elapsedSeconds, ...summary });
        /*
         * Onto the row as well as into the sample. The sample is cleared when
         * the job ends, and the history is the one thing a finished card has
         * left to say how the build went.
         */
        void store
          .update(job.id, {
            phaseHistory: completedPhases.map((entry) => ({ ...entry })),
          })
          .catch(() => undefined);
      }
      phaseStartedMs = Date.now();
    };

    /** When the figures in `live` were last actually measured. */
    let confirmedAtMs = Date.now();

    const publishLive = (): Promise<void> => {
      revision += 1;
      const snapshot: LiveProgressSnapshot = {
        processingJobId: job.id,
        revision,
        timestampMs: Date.now(),
        confirmedAtMs,
        stage: live.stage,
        phase: live.phase,
        epochIndex: live.epochIndex,
        epochCount: live.epochCount,
        epochStartSeconds: live.epochStartSeconds,
        epochEndSeconds: live.epochEndSeconds,
        epochFraction: live.epochFraction,
        completedEpochs: live.completedEpochs,
        protectedSeconds: live.protectedSeconds,
        encodedSeconds: live.encodedSeconds,
        sourceDurationSeconds: live.sourceDurationSeconds,
        ...(live.fps === undefined ? {} : { fps: live.fps }),
        ...(live.speed === undefined ? {} : { speed: live.speed }),
        ...(live.smoothedSpeed === undefined
          ? {}
          : { smoothedSpeed: live.smoothedSpeed }),
        ...(live.etaSeconds === undefined
          ? {}
          : { etaSeconds: live.etaSeconds }),
        ...(live.writtenBytes === undefined
          ? {}
          : { writtenBytes: live.writtenBytes }),
        encoder: decision.videoEncoder,
        qualityHeights: encodedRungs,
        ...(live.globalProgress === undefined
          ? {}
          : { globalProgress: live.globalProgress }),
        ...(live.phaseFraction === undefined
          ? {}
          : { phaseFraction: live.phaseFraction }),
        phaseStartedAtMs: phaseStartedMs,
        ...(live.planning === undefined ? {} : { planning: live.planning }),
        ...(live.audio === undefined ? {} : { audio: live.audio }),
        ...(live.subtitles === undefined ? {} : { subtitles: live.subtitles }),
        ...(live.assembly === undefined ? {} : { assembly: live.assembly }),
        ...(live.verification === undefined
          ? {}
          : { verification: live.verification }),
        ...(live.publish === undefined ? {} : { publish: live.publish }),
        ...(completedPhases.length === 0
          ? {}
          : { completedPhases: [...completedPhases] }),
        ...(live.sourceIo === undefined ? {} : { sourceIo: live.sourceIo }),
        ...(sourceDamage.length === 0
          ? {}
          : { sourceDamage: [...sourceDamage] }),
      };
      return writeLiveProgress(snapshot);
    };

    /**
     * The rendition registry, not the catalogue, owns the identity a package
     * is stored under.
     *
     * The playback service finds a package by looking the source up in the
     * registry and reading `<renditionRoot>/<registryItem.id>`. Packaging
     * under the catalogue's own file id would produce a perfectly valid
     * package in a directory nothing ever looks in.
     */
    let registryItem: ReturnType<typeof upsertRegistrySource>;
    try {
      registryItem = await registryStore.update((registry) =>
        upsertRegistrySource(registry, {
          relativePath: input.relativePath,
          size: input.sizeBytes,
          mtimeMs: input.mtimeMs,
          sourceFingerprint: job.sourceFingerprint,
        }),
      );
    } catch (error) {
      // Otherwise only the `finally` much further down stops the heartbeat,
      // and a job that failed here kept republishing for the worker's life.
      clearInterval(heartbeat);
      throw error;
    }

    /**
     * Cancellation has to reach FFmpeg, not just the loop around it.
     *
     * The queue reports cancellation through a polled predicate, while the
     * packager takes an `AbortSignal` that it forwards to the encoder.
     * Without this bridge a cancelled job kept encoding to the end and only
     * noticed afterwards, which to an operator is indistinguishable from the
     * request being ignored.
     */
    const encodeAbort = new AbortController();
    const forwardAbort = () => encodeAbort.abort();
    input.signal?.addEventListener("abort", forwardAbort, { once: true });

    /*
     * Pause travels the same way cancellation does, for the same reason: the
     * request is made in one process and the encoder runs in another, so a
     * polled flag is the only channel between them. Unlike cancellation it
     * suspends rather than kills, so the work already done survives.
     */
    const pauseController = createPauseController();
    /*
     * Set when the encode is stopped because its storage disappeared, so the
     * outcome can be told apart from a person cancelling. The two look
     * identical to the encoder — both end in an abort — and conflating them
     * is what turned an unplugged drive into a permanently failed job.
     */
    let storageInterrupted = false;

    /**
     * Whether the durable record already says what the encoder is doing.
     *
     * The tick used to derive this from the database row on every pass, which
     * was fine while a pause was a boolean flip. It is not fine now: a
     * suspension takes a round trip through the operating system, and during it
     * a newly spawned epoch encoder can leave and re-enter the confirmed-paused
     * state on its own. Without a local memory of what was last written, every
     * one of those produced another `state = "paused"` write and another
     * "Paused." line in the job's history.
     */
    let persistedPaused: boolean | null = null;
    /**
     * The last transition failure reported to the operator, so a suspension
     * that keeps failing produces one line rather than one per second.
     */
    let reportedTransitionFailure: string | null = null;
    /**
     * Whether a tick is still running.
     *
     * Awaiting the operating system inside a one-second interval means a tick
     * can outlive its own period. Two overlapping ticks would race two pause
     * transitions and two database writes for one operator press; the
     * controller serialises the first and nothing serialised the second.
     */
    let ticking = false;

    /**
     * The pause poll's memory of whether the database is answering.
     *
     * This tick used to be an unconditional `store.get` every second with a
     * `console.warn` in its catch, and when PostgreSQL went down during an
     * encode it wrote several hundred identical lines. Each one had cost a
     * five-second connection attempt first, so the loop was also holding open a
     * dial to a database that was not there, from every running job at once,
     * for as long as the outage lasted.
     *
     * The gate turns that into one probe on a doubling schedule and one line
     * per transition. Nothing else about the poll changes: while the database
     * is healthy it is exactly the query it always was.
     */
    const databaseGate = createDependencyGate({
      name: "The processing database",
      probe: async () => {
        await store.get(job.id);
      },
      onStateChange: (state, detail) => {
        console.warn(`[Seyirlik] database.${state}: ${detail}`);
      },
    });
    /*
     * How long an encode may keep running with nothing able to record what it
     * is doing.
     *
     * Not zero, because a database restart takes seconds and killing an
     * eight-hour ladder over one is absurd. Not unbounded either: past this
     * point the work is untracked — no checkpoint counter, no pause request
     * could reach it, no cancellation — and the honest thing is to stop at a
     * boundary the checkpoints already make safe rather than to encode for
     * hours into a record nobody can write.
     */
    const databaseGraceMs = 120_000;
    let databaseLostAtMs: number | null = null;

    /** Writes the confirmed pause down, once per genuine transition. */
    const recordPaused = async (stage: ProcessingStage): Promise<void> => {
      if (persistedPaused === true) return;
      persistedPaused = true;
      await store.update(job.id, {
        state: "paused",
        /*
         * Live telemetry describes a process that is reporting. A suspended one
         * is not, and a speed left behind here is a reading of something that
         * stopped.
         */
        speed: null,
        fps: null,
        etaSeconds: null,
      });
      await clearLiveProgress(job.id).catch(() => undefined);
      await store.appendEvent({
        processingJobId: job.id,
        stage,
        level: "warning",
        message: "Paused.",
      });
    };

    /** Writes the confirmed resume down, once per genuine transition. */
    const recordRunning = async (stage: ProcessingStage): Promise<void> => {
      if (persistedPaused === false) return;
      persistedPaused = false;
      await store.update(job.id, { state: "running" });
      await store.appendEvent({
        processingJobId: job.id,
        stage,
        level: "info",
        message: "Resumed.",
      });
    };

    /**
     * Says a transition failed, once, however long it keeps failing.
     *
     * A pause that cannot be honoured is retried by the next tick, and a
     * suspension that is refused because of a permissions problem will be
     * refused every second for as long as the encode lasts. One line per
     * distinct failure is what an operator can read; three thousand is what
     * hides it.
     */
    const reportTransitionFailure = async (
      stage: ProcessingStage,
      message: string,
    ): Promise<void> => {
      if (reportedTransitionFailure === message) return;
      reportedTransitionFailure = message;
      console.warn(`[Seyirlik] ${message}`);
      await store.appendEvent({
        processingJobId: job.id,
        stage,
        level: "error",
        message,
      });
    };

    /**
     * Undoes a pause request the operating system would not honour.
     *
     * Only an operator's own pause is withdrawn. A storage hold is not this
     * tick's to clear — it is recorded by the guard, it authorises the recovery
     * path, and lowering it here would hand an automatic requeue permission it
     * was never given.
     */
    const clearFailedPause = async (
      latest: ProcessingJobRecord,
      reason: string,
    ): Promise<void> => {
      await reportTransitionFailure(
        latest.stage,
        `The encoder could not be paused and is still running. ${reason}`,
      );
      if (latest.pausedReason !== "operator") return;
      await store.update(job.id, {
        pauseRequested: false,
        pausedReason: null,
      });
    };

    const cancellationWatch = setInterval(() => {
      /*
       * Every line below talks to the database, and a database that blinks —
       * a restart, a dropped idle socket, a query timeout — rejects them. A
       * rejection from a timer is nobody's to catch, so before this `catch`
       * existed it reached the process as an unhandled rejection and ended
       * the server mid-encode. The tick is a poll: missing one costs a second
       * of latency on a pause request, and nothing else.
       */
      if (ticking) return;
      ticking = true;
      void (async () => {
        /*
         * Cheap and from memory while the database is known to be away, so a
         * one-second timer during a five-minute outage costs one probe per
         * backoff step rather than three hundred connection attempts.
         */
        if (!(await databaseGate.check())) {
          databaseLostAtMs ??= Date.now();
          if (Date.now() - databaseLostAtMs > databaseGraceMs) {
            /*
             * Stop at a checkpoint boundary rather than keep going. Every epoch
             * already promoted is durable on disk and survives this; what is
             * abandoned is the epoch in flight, which is at most five minutes,
             * and which would have been abandoned anyway the moment anyone
             * tried to write down that it had finished.
             */
            await pauseController.resume();
            encodeAbort.abort();
          }
          return;
        }
        databaseLostAtMs = null;

        const latest = await store.get(job.id);
        /*
         * The guard is re-read on every tick, and it is what stops an encode
         * that is already running against a volume that has just been
         * quarantined by something else — a second job's failure, an operator
         * pressing the button. The volume is not asked; the guard is, because
         * the volume answered "fine" throughout the incident this exists for.
         */
        if (storageGuard.demandsStop() && !storageInterrupted) {
          storageInterrupted = true;
          /*
           * Awaited, not fired off. A suspended process cannot notice an abort,
           * cannot read FFmpeg's quit key, and on Windows cannot be reaped
           * without being forced — so the resume has to have actually landed
           * before the abort goes out. This is the same `resume → abort`
           * ordering the Unix audit already depends on, made explicit because
           * on Windows it is a round trip rather than a signal.
           */
          await pauseController.resume();
          encodeAbort.abort();
          /*
           * This is the classification made at the moment of the fault, and it
           * is the one that is right. `finishStorageInterrupted` will run again
           * over the same job once FFmpeg is reaped, so what is written here
           * has to be a floor rather than a value that a later, calmer reading
           * of the guard is free to lower.
           */
          storageInterruptedReason = escalatePauseReason(
            latest?.pausedReason,
            storageGuard.health.state === "unavailable"
              ? "storage-unavailable"
              : "storage-quarantined",
          );
          await store.update(job.id, {
            state: "paused",
            pausedReason: storageInterruptedReason,
          });
          await store.appendEvent({
            processingJobId: job.id,
            stage: latest?.stage ?? job.stage,
            level: "warning",
            message: `The encoder was stopped. ${storageGuard.describe()}`,
            detail: {
              storageState: storageGuard.health.state,
              pausedReason: storageInterruptedReason,
            },
          });
          return;
        }
        if (
          latest?.pauseRequested &&
          (latest.pausedReason === "storage-unavailable" ||
            latest.pausedReason === "storage-quarantined") &&
          !storageInterrupted
        ) {
          /*
           * Suspending is the wrong move here, and used to be what happened.
           * A stopped FFmpeg keeps its file descriptors open on a volume that
           * is no longer there, and resuming it later would carry on writing
           * through handles that may now point at a different disk entirely.
           * The encoder is ended instead: its partial output is discarded on
           * recovery and only the interrupted rendition is built again, while
           * every published rendition is left exactly as it is.
           */
          storageInterrupted = true;
          await pauseController.resume();
          encodeAbort.abort();
          await store.update(job.id, { state: "paused" });
          await store.appendEvent({
            processingJobId: job.id,
            stage: latest.stage,
            level: "warning",
            message:
              "Storage became unavailable; the encoder was stopped and the job is waiting for it to return.",
          });
        } else if (
          latest?.pauseRequested &&
          !pauseController.paused &&
          /*
           * Nothing is paused on its way out.
           *
           * A cancel arriving while the encoder is suspended lifts the pause
           * and aborts, and the pause request outlives both — it is cleared
           * when the cancellation is finalised, which is after FFmpeg has
           * actually been reaped. Without this the next tick reads that
           * surviving request, tries to suspend a process that is being
           * terminated, is correctly refused by the binding, and writes "the
           * encoder could not be paused" into the job's history. The refusal is
           * right; the question was the wrong one to ask.
           */
          !encodeAbort.signal.aborted
        ) {
          /*
           * The order here is the whole fix.
           *
           * What this used to be was `pause()` — a boolean flip — followed
           * immediately by `state = "paused"`. On Windows the flip was all
           * there was: the binding refused to install, nothing was ever
           * suspended, and the row said paused over an encoder running at full
           * speed. The durable state is now written *after* the operating
           * system has confirmed the suspension and never before it, so a row
           * that reads paused is a process that is genuinely stopped.
           */
          const transition = await pauseController.pause();
          if (transition.ok) {
            reportedTransitionFailure = null;
            await recordPaused(latest.stage);
          } else {
            /*
             * Nothing was suspended, so nothing may say it was. The request is
             * cleared rather than left standing: an intent that cannot be
             * honoured would have this tick retry for ever, and would leave the
             * page showing an operator a pause that is never going to arrive.
             */
            await clearFailedPause(latest, transition.reason);
          }
        } else if (latest && !latest.pauseRequested && pauseController.paused) {
          const transition = await pauseController.resume();
          if (transition.ok) {
            reportedTransitionFailure = null;
            await recordRunning(latest.stage);
          } else {
            /*
             * Still suspended. The row stays `paused`, the watchdog stays
             * suppressed, and the operator is told — because the one thing that
             * must never happen here is the system claiming a process is
             * running when it is frozen.
             */
            await reportTransitionFailure(
              latest.stage,
              `The encoder could not be resumed. ${transition.reason}`,
            );
          }
        }

        if ((await cancelled()) && !encodeAbort.signal.aborted) {
          // A suspended encoder cannot notice an abort, so lift the pause
          // first — and wait for it to have happened — before the abort.
          await pauseController.resume();
          encodeAbort.abort();
        }
      })()
        .catch((error) => {
          /*
           * Reported through the gate rather than logged here. A failure that
           * reaches this point during an outage is the same failure the gate is
           * already counting, and writing a line for it would restore exactly
           * the storm the gate was added to remove.
           */
          databaseGate.reportFailure(error);
        })
        .finally(() => {
          ticking = false;
        });
    }, 1000);
    if (typeof cancellationWatch.unref === "function")
      cancellationWatch.unref();

    let result: Awaited<ReturnType<typeof packageFn>>;
    try {
      const workspaceDirectory = assertOwnedJobWorkspace(
        workRoot,
        path.join(workRoot, job.id),
      );
      await store.update(job.id, { stagingDirectory: workspaceDirectory });
      result = await packageFn(
        {
          mediaId: registryItem.id,
          workspaceId: job.id,
          relativePath: input.relativePath,
          sourceFingerprint: job.sourceFingerprint,
          sourcePath: input.sourcePath,
          titleRoot: await titleRootForInput(input),
          probe,
        },
        paths,
        {
          ffmpegPath,
          ffprobePath,
          reserveBytes: decision.estimate.reserveBytes,
          ...(softwareThreads === undefined ? {} : { softwareThreads }),
          videoEncoder: decision.videoEncoder,
          hdrVideoEncoder: decision.videoEncoder,
          audioStreamIndexes: decision.streams.keptAudioStreamIndexes,
          subtitleStreamIndexes: decision.streams.keptSubtitleStreamIndexes,
          /*
           * Most of this library is subtitled with a `.srt` beside the file
           * rather than a stream inside it. Without this the server path
           * publishes titles with no subtitles in a retained language while
           * the offline CLI, running the same policy, publishes them with —
           * the same title processed two ways giving two different answers.
           */
          sidecarSubtitles: await planRetainedSidecarSubtitles(
            input.sourcePath,
          ),
          signal: encodeAbort.signal,
          pauseController,
          /*
           * The cross-process half of scratch identity.
           *
           * The job record remembers which volume its workspace was claimed
           * on, and hands it back on every later attempt. A worker that
           * restarted while that disk was absent therefore still knows what it
           * is waiting for, which neither `st_dev` (never persisted, and
           * recycled between mounts) nor the workspace's own marker (which
           * lives on the missing volume) can tell it.
           */
          ...(scratchIdentityProbe
            ? { probeScratchIdentity: scratchIdentityProbe }
            : {}),
          ...(job.scratchIdentity
            ? { expectedScratchIdentity: job.scratchIdentity }
            : {}),
          retainWorkspaceAfterPublish: true,
          ...(epochTargetSeconds === undefined ? {} : { epochTargetSeconds }),
          /*
           * What to do about a source that cannot be read. Passed explicitly
           * rather than left to the packager's own default so the job's
           * history records the decision the deployment actually made.
           */
          sourceDamagePolicy,
          stalls,
          /*
           * The packager asks these at the moment something fails, which is
           * the only moment the answer distinguishes "the drive was pulled
           * out" from "this encode is broken".
           */
          ...(storageAvailableFn
            ? { storageAvailable: storageAvailableFn }
            : {}),
          ...(missingRootsFn ? { missingRoots: missingRootsFn } : {}),
          onHardStorageFault: async (failure) => {
            await storageGuard.reportFailure({
              kind: failure.kind,
              detail: failure.detail,
              processingJobId: job.id,
            });
          },
          onEvent: (event) => {
            switch (event.type) {
              case "build-stage": {
                /*
                 * The stages are shown apart rather than folded into one
                 * number. A job that has finished encoding and is assembling
                 * says so; it does not sit at a percentage that means neither
                 * thing.
                 */
                /*
                 * A phase boundary closes the previous phase's summary and
                 * pins the bar to that phase's full weight, so the value the
                 * next phase starts from is where the last one genuinely
                 * ended rather than wherever its final sample landed.
                 */
                if (live.phase !== event.stage) {
                  advance(live.phase, 1);
                  /*
                   * One line per finished phase, taken from what that phase
                   * itself reported. Summaries, not samples: the page shows
                   * "Video ✓ 3h 38m · 34 checkpoints" without holding any of
                   * the thousands of measurements that produced it.
                   */
                  switch (live.phase) {
                    case "planning":
                      closePhase("planning", {
                        ...(live.planning?.epochCount === undefined
                          ? {}
                          : { count: live.planning.epochCount }),
                        ...(live.planning?.rateProbe?.reused
                          ? { reused: true }
                          : {}),
                      });
                      break;
                    case "subtitles":
                      closePhase("subtitles", {
                        count: live.subtitles?.completedTracks ?? 0,
                        bytes: live.subtitles?.writtenBytes ?? 0,
                      });
                      break;
                    case "encoding":
                      closePhase("encoding", {
                        count: live.completedEpochs,
                        bytes: checkpointBytesWritten,
                      });
                      break;
                    case "audio":
                      closePhase("audio", {
                        count: live.audio?.tracks.length ?? 0,
                        bytes: live.audio?.writtenBytes ?? 0,
                        ...(live.audio?.reused ? { reused: true } : {}),
                      });
                      break;
                    case "assembling":
                      closePhase("assembling", {
                        count: live.assembly?.renditions.length ?? 0,
                        bytes: live.assembly?.completedBytes ?? 0,
                      });
                      break;
                    case "validating":
                      /*
                       * Checks only. The phase's weight is a cost model, not
                       * a byte count, so the history line carries the figure
                       * that is literally true and nothing else.
                       */
                      closePhase("validating", {
                        count: live.verification?.completedChecks ?? 0,
                      });
                      break;
                    default:
                      closePhase(live.phase, {});
                  }
                  live.planning = undefined;
                  live.audio = undefined;
                  live.subtitles = undefined;
                  live.assembly = undefined;
                  live.verification = undefined;
                  live.publish = undefined;
                }
                live.phase = event.stage;
                advance(event.stage, 0);
                const stage = STAGE_FOR_PHASE[event.stage];
                if (stage !== live.stage) {
                  live.stage = stage;
                  void store
                    .update(job.id, {
                      stage,
                      stageProgress: 0,
                      overallProgress: monotonicProgress(
                        lastOverall,
                        overallProgress(stage, 0),
                      ),
                    })
                    .catch(() => undefined);
                  void store
                    .appendEvent({
                      processingJobId: job.id,
                      stage,
                      message: PHASE_MESSAGES[event.stage],
                    })
                    .catch(() => undefined);
                }
                publishLiveThrottled(true);
                return;
              }

              case "epoch-plan": {
                live.epochCount = event.epochCount;
                live.completedEpochs = event.reusedEpochs;
                live.protectedSeconds = event.protectedSeconds;
                live.encodedSeconds = event.protectedSeconds;
                live.sourceDurationSeconds = event.sourceDurationSeconds;
                // Seeded from what is already on disk, so "protected media"
                // counts the checkpoints a resumed job inherited rather than
                // only the ones this attempt produced.
                checkpointBytesWritten = event.checkpointBytes;
                void store
                  .update(job.id, {
                    checkpointBytes: event.checkpointBytes,
                    epochCount: event.epochCount,
                    completedEpochs: event.reusedEpochs,
                    protectedSeconds: event.protectedSeconds,
                    encodedSeconds: event.protectedSeconds,
                    sourceDurationSeconds: event.sourceDurationSeconds,
                  })
                  .catch(() => undefined);
                void store
                  .appendEvent({
                    processingJobId: job.id,
                    stage: "video",
                    message:
                      event.reusedEpochs > 0
                        ? `Resuming from ${event.reusedEpochs} of ${event.epochCount} checkpoints; protected through ${formatClock(event.protectedSeconds)}.`
                        : `Encoding in ${event.epochCount} checkpointed ${event.epochCount === 1 ? "epoch" : "epochs"} of about ${Math.round(event.epochTargetSeconds / 60)} minutes.`,
                    detail: {
                      epochCount: event.epochCount,
                      reusedEpochs: event.reusedEpochs,
                      invalidated: event.invalidated,
                    },
                  })
                  .catch(() => undefined);
                for (const entry of event.invalidated) {
                  void store
                    .appendEvent({
                      processingJobId: job.id,
                      stage: "video",
                      level: "warning",
                      message: `Checkpoint ${entry.index + 1} could not be trusted (${entry.reason}) and will be built again.`,
                    })
                    .catch(() => undefined);
                }
                void publishLive();
                return;
              }

              case "epoch-start": {
                live.epochIndex = event.index;
                live.epochStartSeconds = event.startSeconds;
                live.epochEndSeconds = event.endSeconds;
                live.epochFraction = 0;
                // A new epoch is a new encoder run, so the throughput estimate
                // starts again rather than carrying the previous epoch's
                // startup samples into this one's ETA. The stall watch starts
                // again with it, so a new process is never born stalled.
                speed = createSpeedEstimator();
                mediaStall = createMediaStallDetector({
                  stallAfterMs: stalls.softStallMs,
                });
                if (live.sourceIo?.state !== "replaced") {
                  live.sourceIo = undefined;
                }
                void store
                  .update(job.id, {
                    epochIndex: event.index,
                    epochStartSeconds: event.startSeconds,
                    epochEndSeconds: event.endSeconds,
                  })
                  .catch(() => undefined);
                void store
                  .appendEvent({
                    processingJobId: job.id,
                    stage: "video",
                    message: `${event.attempt > 1 ? "Retrying" : "Encoding"} epoch ${event.index + 1}/${event.epochCount} (${formatClock(event.startSeconds)}–${formatClock(event.endSeconds)})`,
                  })
                  .catch(() => undefined);
                void publishLive();
                return;
              }

              case "epoch-progress": {
                live.epochIndex = event.index;
                live.epochCount = event.epochCount;
                live.epochStartSeconds = event.startSeconds;
                live.epochEndSeconds = event.endSeconds;
                live.protectedSeconds = event.protectedSeconds;
                live.encodedSeconds = event.encodedSeconds;
                live.sourceDurationSeconds = event.sourceDurationSeconds;
                const window = event.endSeconds - event.startSeconds;
                live.epochFraction =
                  window > 0
                    ? Math.min(
                        1,
                        Math.max(0, event.epochProcessedSeconds / window),
                      )
                    : 0;
                const stall = mediaStall.sample(
                  event.epochProcessedSeconds,
                  Date.now(),
                );
                if (stall.stalled) {
                  /*
                   * Nothing is being produced. The position stays exactly
                   * where the encoder left it — it is still true — and the
                   * rate and the estimate go, because both describe a present
                   * tense that is not happening. `confirmedAtMs` is not
                   * refreshed either, which is what tells the page the same
                   * thing from the other end of the stream.
                   */
                  live.fps = undefined;
                  live.speed = undefined;
                  live.smoothedSpeed = undefined;
                  live.etaSeconds = undefined;
                  /*
                   * Said as little as the evidence supports. Media time
                   * stopping is not yet a source problem; a read that has
                   * actually failed says so through `source-io-retry`, and
                   * only that promotes this to a diagnosis.
                   */
                  if (
                    live.sourceIo === undefined ||
                    live.sourceIo.state === "waiting"
                  ) {
                    live.sourceIo = {
                      state: "waiting",
                      epochIndex: event.index,
                      startSeconds: event.startSeconds,
                      endSeconds: event.endSeconds,
                      advancedAtMs: stall.advancedAtMs,
                    };
                  }
                } else {
                  if (live.sourceIo?.state === "waiting") {
                    // It was only slow. Nothing was wrong with the source.
                    live.sourceIo = undefined;
                  }
                  live.fps = event.fps;
                  live.speed = event.speed;
                  live.smoothedSpeed = speed.sample(event.speed);
                  live.etaSeconds = estimateEncodeEtaSeconds({
                    encodedSeconds: event.encodedSeconds,
                    sourceDurationSeconds: event.sourceDurationSeconds,
                    smoothedSpeed: live.smoothedSpeed,
                  });
                }
                live.writtenBytes = event.writtenBytes;

                const fraction =
                  durationSeconds > 0
                    ? Math.min(1, event.encodedSeconds / durationSeconds)
                    : 0;
                lastOverall = monotonicProgress(
                  lastOverall,
                  overallProgress("video", fraction),
                );
                /*
                 * The same measured media time drives the global bar. Video
                 * feedback is unchanged by any of this: it still comes from
                 * FFmpeg's own out_time against the source duration, and the
                 * bar is derived from it rather than the other way round.
                 */
                advance("encoding", fraction);
                /*
                 * The estimate is refined here rather than in the browser so
                 * every reader — page, history, API — sees one number. It
                 * starts as the plan and moves toward what the encoder is
                 * actually producing as the evidence accumulates.
                 */
                if (event.writtenBytes !== undefined) {
                  lastEstimateBytes = estimateFinalOutputBytes({
                    plannedBytes: decision.estimate.outputBytes,
                    actualBytes: event.writtenBytes,
                    progressFraction: fraction,
                    processedSeconds: event.encodedSeconds,
                    ...(lastEstimateBytes === undefined
                      ? {}
                      : { previousEstimate: lastEstimateBytes }),
                  });
                }

                // The transient lane runs at the encoder's own rate; the
                // durable one is deliberately much slower — except that an
                // estimate appearing for the first time is a state change
                // rather than a sample, and a page that reconnects before the
                // next tick should already see it.
                publishLiveThrottled(false, !stall.stalled);
                const etaBecameKnown =
                  (live.etaSeconds !== undefined) !== etaWasKnown;
                if (
                  etaBecameKnown ||
                  Date.now() - lastPersistMs >= PERSIST_INTERVAL_MS
                ) {
                  etaWasKnown = live.etaSeconds !== undefined;
                  lastPersistMs = Date.now();
                  void store
                    .update(job.id, {
                      stage: "video",
                      stageProgress: fraction,
                      /*
                       * The durable row now carries the cumulative bar rather
                       * than the stage-weighted guess: it is what the page
                       * draws before the first live sample arrives, and the
                       * two must not disagree.
                       */
                      overallProgress: Math.max(lastOverall, lastGlobal),
                      encodedSeconds: event.encodedSeconds,
                      protectedSeconds: event.protectedSeconds,
                      epochIndex: event.index,
                      ...(event.writtenBytes === undefined
                        ? {}
                        : { bytesProcessed: event.writtenBytes }),
                      ...(lastEstimateBytes === undefined
                        ? {}
                        : { estimatedOutputBytes: lastEstimateBytes }),
                      speed: event.speed ?? null,
                      fps: event.fps ?? null,
                      etaSeconds: live.etaSeconds ?? null,
                    })
                    .catch(() => undefined);
                }
                return;
              }

              case "epoch-complete": {
                live.completedEpochs = Math.max(
                  live.completedEpochs,
                  event.index + 1,
                );
                live.protectedSeconds = event.protectedSeconds;
                live.encodedSeconds = Math.max(
                  live.encodedSeconds,
                  event.protectedSeconds,
                );
                checkpointBytesWritten += event.bytes;
                void store
                  .update(job.id, {
                    completedEpochs: live.completedEpochs,
                    protectedSeconds: event.protectedSeconds,
                    encodedSeconds: live.encodedSeconds,
                    checkpointBytes: checkpointBytesWritten,
                  })
                  .catch(() => undefined);
                if (event.bytes > 0) {
                  void store
                    .appendEvent({
                      processingJobId: job.id,
                      stage: "video",
                      message: `Checkpoint saved — protected through ${formatClock(event.protectedSeconds)} (${event.index + 1}/${event.epochCount})`,
                    })
                    .catch(() => undefined);
                }
                publishLiveThrottled(true);
                return;
              }

              case "source-io-retry": {
                /*
                 * A read has genuinely failed, which is more than the stall
                 * watch could tell. The page stops saying "waiting for source
                 * data" and says what is actually wrong.
                 */
                live.sourceIo = {
                  state: "suspected",
                  epochIndex: event.index,
                  startSeconds: live.epochStartSeconds,
                  endSeconds: live.epochEndSeconds,
                  attempt: event.attempt,
                  maxAttempts: event.maxAttempts,
                };
                live.speed = undefined;
                live.smoothedSpeed = undefined;
                live.etaSeconds = undefined;
                publishLiveThrottled(true, false);
                void store
                  .appendEvent({
                    processingJobId: job.id,
                    stage: "video",
                    level: "warning",
                    message:
                      event.verdict === "network-stall"
                        ? `Epoch ${event.index + 1} stalled on the network volume and a bounded read of the same stretch timed out (attempt ${event.attempt} of ${event.maxAttempts}). This is read as a slow connection, not damage, so ${
                            event.attempt < event.maxAttempts
                              ? "the read will be tried again after a wait."
                              : "the queue will try the job again later."
                          }`
                        : `Epoch ${event.index + 1} could not be read (attempt ${event.attempt} of ${event.maxAttempts}); the volume was re-checked and is still available, so the read is being retried.`,
                    detail: {
                      epochIndex: event.index,
                      attempt: event.attempt,
                      maxAttempts: event.maxAttempts,
                      ...(event.sourceReadable === undefined
                        ? {}
                        : { sourceReadable: event.sourceReadable }),
                      error: event.detail,
                    },
                  })
                  .catch(() => undefined);
                return;
              }

              case "source-stall-abort": {
                /*
                 * The decision, announced as it is taken. What follows may
                 * take tens of seconds — a process wedged in an
                 * uninterruptible read cannot be killed until the kernel
                 * returns control — and a page that went quiet for them would
                 * look like a page that had crashed.
                 */
                live.sourceIo = {
                  state: "aborting",
                  epochIndex: event.index,
                  startSeconds: event.startSeconds,
                  endSeconds: event.endSeconds,
                  lastMediaSeconds: event.lastMediaSeconds,
                };
                live.speed = undefined;
                live.fps = undefined;
                live.smoothedSpeed = undefined;
                live.etaSeconds = undefined;
                publishLiveThrottled(true, false);
                void store
                  .appendEvent({
                    processingJobId: job.id,
                    stage: "video",
                    level: "warning",
                    message: `Epoch ${event.index + 1} produced no media for ${Math.round(
                      event.stalledForMs / 1000,
                    )}s after reaching ${formatClock(
                      event.startSeconds + event.lastMediaSeconds,
                    )}; stopping the encoder rather than letting it keep reading.`,
                    detail: {
                      epochIndex: event.index,
                      lastMediaSeconds: event.lastMediaSeconds,
                      stalledForMs: event.stalledForMs,
                    },
                  })
                  .catch(() => undefined);
                return;
              }

              case "source-damage-confirmed": {
                live.sourceIo = {
                  state: "confirmed",
                  epochIndex: event.index,
                  startSeconds: event.damage.sourceStartSeconds,
                  endSeconds: event.damage.sourceEndSeconds,
                  attempt: event.damage.sourceRetryCount,
                };
                publishLiveThrottled(true, false);
                void store
                  .appendEvent({
                    processingJobId: job.id,
                    stage: "video",
                    level: "warning",
                    message: `The source could not be read for ${describeInterval(
                      damageIntervalOf(event.damage),
                    )} after ${event.damage.sourceRetryCount} attempts while its volume stayed healthy.${
                      event.policy === "replace-epoch"
                        ? " That interval will be replaced with black picture and silence of the same length."
                        : " Processing will stop; every completed checkpoint is kept."
                    }`,
                    detail: {
                      ...(event.damage as unknown as Record<string, unknown>),
                      policy: event.policy,
                    },
                  })
                  .catch(() => undefined);
                return;
              }

              case "epoch-salvage-start": {
                live.sourceIo = {
                  state: "replacing",
                  epochIndex: event.index,
                  startSeconds: event.startSeconds,
                  endSeconds: event.endSeconds,
                };
                // A replacement is real work with real progress, so the stall
                // watch starts again rather than inheriting a blocked read.
                mediaStall = createMediaStallDetector({
                  stallAfterMs: stalls.softStallMs,
                });
                speed = createSpeedEstimator();
                publishLiveThrottled(true);
                void store
                  .appendEvent({
                    processingJobId: job.id,
                    stage: "video",
                    level: "warning",
                    message: `Replacing ${formatClock(event.startSeconds)}–${formatClock(
                      event.endSeconds,
                    )} with ${Math.round(event.expectedDurationSeconds)}s of black picture, because the source could not be read there.`,
                  })
                  .catch(() => undefined);
                return;
              }

              case "epoch-salvaged": {
                sourceDamage.push(event.damage);
                live.sourceIo = {
                  state: "replaced",
                  epochIndex: event.index,
                  startSeconds: event.damage.sourceStartSeconds,
                  endSeconds: event.damage.sourceEndSeconds,
                  resumeSeconds: event.damage.sourceEndSeconds,
                };
                publishLiveThrottled(true);
                void store
                  .update(job.id, {
                    sourceDamage: sourceDamage as unknown as Record<
                      string,
                      unknown
                    >[],
                  })
                  .catch(() => undefined);
                void store
                  .appendEvent({
                    processingJobId: job.id,
                    stage: "video",
                    level: "warning",
                    message: `Replaced ${describeInterval(
                      damageIntervalOf(event.damage),
                    )}; encoding continues from ${formatClock(
                      event.damage.sourceEndSeconds,
                    )}.`,
                    detail: event.damage as unknown as Record<string, unknown>,
                  })
                  .catch(() => undefined);
                return;
              }

              case "epoch-invalid": {
                /*
                 * One reason is not a failed check and must not read like one.
                 * `encoder-config-changed` says the epoch is perfectly good and
                 * simply belongs to an older encoder configuration than the
                 * epochs beside it — which happens when a change is deployed
                 * into a job that is already running, and which used to be
                 * discovered only at assembly, after every epoch had been paid
                 * for.
                 */
                const message =
                  event.reason === "encoder-config-changed"
                    ? `Epoch ${event.index + 1} was encoded with different encoder settings from the newer epochs and cannot be joined to them; it will be built again.`
                    : `Epoch ${event.index + 1} did not pass its checks and will be built again: ${event.reason}`;
                void store
                  .appendEvent({
                    processingJobId: job.id,
                    stage: "video",
                    level: "warning",
                    message,
                  })
                  .catch(() => undefined);
                return;
              }

              /*
               * The four phases that used to report only their own name.
               *
               * Each one carries a fraction its own producer measured — media
               * time for audio, bytes for assembly, weighted checks for
               * verification, steps for publication — and each drives the
               * global bar through the same `advance` the encoder uses. The
               * durable row is written at the slow interval; the sample goes
               * out at four a second.
               */
              case "audio-progress": {
                /*
                 * A phase's first measurement is a state change, not a
                 * sample: it is what puts the panel on screen. It goes out
                 * immediately rather than waiting for the throttle's next
                 * slot, as does the last one.
                 */
                const first = live.audio === undefined;
                live.audio = event.progress;
                const global = advance("audio", event.progress.fraction);
                publishLiveThrottled(first || event.progress.fraction >= 1);
                if (Date.now() - lastPersistMs >= PERSIST_INTERVAL_MS) {
                  lastPersistMs = Date.now();
                  void store
                    .update(job.id, {
                      stageProgress: event.progress.fraction,
                      overallProgress: Math.max(lastOverall, global),
                    })
                    .catch(() => undefined);
                }
                return;
              }

              case "planning-progress": {
                /*
                 * Planning has no measurable total — the rate probe's search
                 * runs as long as its answers require — so the bar moves by
                 * step and the panel reports the work done in each.
                 */
                const first = live.planning?.step !== event.progress.step;
                live.planning = event.progress;
                advance(
                  "planning",
                  event.progress.step === "timeline" ? 0 : 0.5,
                );
                publishLiveThrottled(first);
                return;
              }

              case "subtitle-progress": {
                live.subtitles = event.progress;
                const global = advance("subtitles", event.progress.fraction);
                // Each sample is a track starting or finishing: all of them
                // are state changes, and there are only a handful.
                publishLiveThrottled(true);
                if (Date.now() - lastPersistMs >= PERSIST_INTERVAL_MS) {
                  lastPersistMs = Date.now();
                  void store
                    .update(job.id, {
                      stageProgress: event.progress.fraction,
                      overallProgress: Math.max(lastOverall, global),
                    })
                    .catch(() => undefined);
                }
                return;
              }

              case "assembly-progress": {
                const first = live.assembly === undefined;
                live.assembly = event.progress;
                const global = advance("assembling", event.progress.fraction);
                publishLiveThrottled(first || event.progress.fraction >= 1);
                if (Date.now() - lastPersistMs >= PERSIST_INTERVAL_MS) {
                  lastPersistMs = Date.now();
                  void store
                    .update(job.id, {
                      stageProgress: event.progress.fraction,
                      overallProgress: Math.max(lastOverall, global),
                    })
                    .catch(() => undefined);
                }
                return;
              }

              case "verification-progress": {
                const first = live.verification === undefined;
                live.verification = event.progress;
                const global = advance("validating", event.progress.fraction);
                publishLiveThrottled(first || event.progress.ok !== undefined);
                if (Date.now() - lastPersistMs >= PERSIST_INTERVAL_MS) {
                  lastPersistMs = Date.now();
                  void store
                    .update(job.id, {
                      stageProgress: event.progress.fraction,
                      overallProgress: Math.max(lastOverall, global),
                    })
                    .catch(() => undefined);
                }
                return;
              }

              case "publish-progress": {
                /*
                 * Publication arrives in two bursts from two producers — the
                 * title publisher's own steps, then the packager's verify and
                 * cleanup — so the steps are merged rather than replaced, and
                 * the fraction is taken over the union.
                 */
                const merged = [
                  ...(live.publish?.steps ?? []).filter(
                    (step) =>
                      !event.progress.steps.some(
                        (incoming) => incoming.id === step.id,
                      ),
                  ),
                  ...event.progress.steps,
                ];
                const totalBytes = merged.reduce(
                  (sum, step) => sum + (step.bytes ?? 0),
                  0,
                );
                const completedBytes = merged.reduce(
                  (sum, step) =>
                    sum +
                    Math.min(
                      step.bytes ?? 0,
                      step.completedBytes ??
                        (step.state === "complete" ? (step.bytes ?? 0) : 0),
                    ),
                  0,
                );
                const completedSteps = merged.filter(
                  (step) => step.state === "complete",
                ).length;
                live.publish = {
                  ...event.progress,
                  steps: merged,
                  totalBytes,
                  completedBytes,
                  fraction:
                    totalBytes > 0
                      ? completedBytes / totalBytes
                      : merged.length > 0
                        ? completedSteps / merged.length
                        : 0,
                };
                advance("publishing", live.publish.fraction);
                publishLiveThrottled(true);
                return;
              }

              default:
                return;
            }
          },
        },
      );
      /*
       * Recorded the moment it is known, whatever the outcome.
       *
       * A job that failed still claimed a workspace on a particular volume,
       * and its next attempt has to be held to the same one — otherwise a
       * retry that runs while the disk is absent is exactly the case this
       * whole column exists to prevent. Written only when the job does not
       * already carry an identity, so the first claim wins and a later
       * probe returning something different cannot quietly redefine it.
       */
      if (!job.scratchIdentity && result.scratchIdentity?.volumeUuid) {
        await store
          .update(job.id, { scratchIdentity: result.scratchIdentity })
          .catch(() => undefined);
      }
    } catch (error) {
      /*
       * A throw from the packager used to escape this function entirely, so
       * nothing was written to the job's own diagnostics and the row was
       * back-filled later with a generic worker-stopped message. The reason
       * the encode never started — a held rendition lock, a vanished drive —
       * is exactly what a person opening the details is looking for, so it
       * is recorded here where it is still known.
       */
      const message =
        error instanceof Error
          ? error.message
          : "The encoder stopped before the package was built.";
      const available = storageAvailableFn
        ? await Promise.resolve(storageAvailableFn()).catch(() => false)
        : true;
      const classified = classifyFailure({
        message,
        storageAvailable: available,
        missingRoots: missingRootsFn?.() ?? [],
      });
      if (classified.kind === "storage-unavailable") {
        await storageGuard
          .reportFailure({
            kind: classified.kind,
            detail: classified.detail,
            processingJobId: job.id,
          })
          .catch(() => undefined);
        return finishStorageInterrupted(classified.detail, classified.kind);
      }
      if (looksLikeOutOfSpace(message)) {
        return fail(
          PROCESSING_ERROR_CODES.insufficientSpace,
          "Processing stopped because the scratch or final media volume ran out of space.",
        );
      }
      /*
       * Reported under its own code rather than as an encode failure, because
       * it is not one: the package is finished and valid, and only its
       * destination is wrong. Calling this ENCODE_FAILED would send whoever
       * reads it looking at the encoder.
       */
      if (error instanceof TitleRootConflictError) {
        return fail(PROCESSING_ERROR_CODES.titleRootConflict, message);
      }
      return fail(
        PROCESSING_ERROR_CODES.encodeFailed,
        message,
        error instanceof RenditionLockHeldError,
      );
    } finally {
      clearInterval(cancellationWatch);
      clearInterval(heartbeat);
      input.signal?.removeEventListener("abort", forwardAbort);
    }

    /*
     * The packager now says *why* it stopped. A cancellation and a vanished
     * volume both end the encoder with an abort, and only one of them is a
     * reason to mark the job cancelled.
     */
    if (result.interruption === "storage") {
      return finishStorageInterrupted(
        result.issues?.[0] ?? result.error,
        result.failureKind,
      );
    }
    if (storageInterrupted && result.status === "interrupted") {
      return finishStorageInterrupted();
    }
    if (await cancelled()) return finishCancelled();
    if (result.status === "interrupted") {
      return storageInterrupted
        ? finishStorageInterrupted()
        : finishCancelled();
    }

    // ------------------------------------------------------- validating
    await enterStage(job, "validating", "Validating the package.");
    if (result.status === "validation-failed") {
      await store.update(job.id, {
        validation: { ok: false, issues: result.issues ?? [] },
      });
      /*
       * The verdict alone is useless to whoever has to fix it. The package is
       * discarded on a validation failure, so this message is the only
       * surviving evidence of what was wrong with it.
       */
      return fail(
        PROCESSING_ERROR_CODES.validationFailed,
        result.error ?? "The package failed validation and was not published.",
      );
    }
    if (result.status === "failed" || result.status === "incompatible") {
      // The storage is asked directly rather than inferred from the error.
      if (storageAvailableFn && !(await storageAvailableFn())) {
        return finishStorageInterrupted(result.error, "storage-device-lost");
      }
      /*
       * A failure that nevertheless identified an unreadable interval keeps
       * the finding. It is what an operator needs in order to choose between
       * re-ripping the disc and turning salvage on for this library.
       */
      if (result.sourceDamage && result.sourceDamage.length > 0) {
        await store
          .update(job.id, {
            sourceDamage: result.sourceDamage as unknown as Record<
              string,
              unknown
            >[],
          })
          .catch(() => undefined);
      }
      /*
       * The code says what happened, and the code is what decides whether the
       * queue ever tries this again. A source with an unreadable region and
       * an encoder that stopped producing are both terminal for this attempt
       * and both worth a person's attention; neither is worth another pass
       * over the same sectors.
       */
      /*
       * The classification goes to the guard as well as into the row. This is
       * the direction that was missing entirely: every failure was recorded
       * against the *job*, so the next job started with no knowledge that the
       * previous one had met an I/O error on the same volume — which is how a
       * queue works its way through a backlog against a failing drive, one
       * forty-second kernel retry sequence at a time.
       *
       * `media-progress-timeout` is passed through unchanged and is deliberately
       * *not* storage evidence; the mapping that decides so lives in one place
       * and the distinction it preserves cost a real investigation to establish.
       */
      if (result.failureKind) {
        await storageGuard
          .reportFailure({
            kind: result.failureKind,
            detail: result.error ?? "The encode failed.",
            processingJobId: job.id,
          })
          .catch(() => undefined);
      }
      const code =
        result.failureKind === "source-io"
          ? PROCESSING_ERROR_CODES.sourceUnreadable
          : result.failureKind === "media-progress-timeout"
            ? PROCESSING_ERROR_CODES.mediaProgressTimeout
            : result.failureKind === "network-read-stall"
              ? PROCESSING_ERROR_CODES.sourceReadStalled
              : PROCESSING_ERROR_CODES.encodeFailed;
      return fail(
        code,
        result.error ?? "The package could not be produced.",
        failureIsWorthRequeuing(result.failureKind),
      );
    }
    if (result.status === "deferred-for-storage") {
      return fail(
        PROCESSING_ERROR_CODES.insufficientSpace,
        "Processing stopped because the output volume ran short of space.",
      );
    }

    /*
     * The packager returns only after it has published, so by the time this
     * line runs every phase has finished. The bar is put where that leaves
     * it — just short of the end — and reaches the end below, with the row
     * that says the job succeeded.
     */
    await store.update(job.id, {
      validation: { ok: true, issues: [] },
      stageProgress: 1,
      overallProgress: globalProgress(weights, "publishing", 1),
    });

    /*
     * The packager returned, so publication — the last phase it reports — is
     * over. Closed here because no further stage event will close it.
     */
    if (live.phase === "publishing") {
      closePhase("publishing", {
        ...(live.publish?.completedBytes
          ? { bytes: live.publish.completedBytes }
          : {}),
      });
    }

    // -------------------------------------------------------- publishing
    await enterStage(job, "publishing", "Publishing the verified package.");
    await clearLiveProgress(job.id);
    /*
     * A salvaged title is published and is not a clean encode. The row keeps
     * `succeeded` — it did succeed, there is a playable package on disk — and
     * carries the structured record of what was substituted, which is what
     * lets every reader tell the two apart without a new state to teach the
     * queue, the history and the timeline about.
     */
    const damage = result.sourceDamage ?? sourceDamage;
    const damageWarnings = damage.map(
      (record) =>
        `${describeInterval(damageIntervalOf(record))} could not be read from the source and was replaced with black picture${
          record.audioReplaced ? " and silence" : ""
        }.`,
    );

    /*
     * Playback finds the package only through this entry, so it is written
     * before the job is called a success, and so before its upload is followed
     * and its source can be removed. A write that fails leaves the job failed
     * and requeued; the next attempt finds the verified package and only
     * publishes it again.
     *
     * Applied to the registry as it is now, not to the copy read when the job
     * started: that is hours old, and writing it back would undo every change
     * made since. A removed entry or a replacement source must not be
     * resurrected or marked ready by an encode that started before it.
     */
    try {
      await registryStore.update((registry) => {
        const readyItem = findRegistryItemById(registry, registryItem.id);
        if (
          !readyItem ||
          readyItem.sourceFingerprint !== registryItem.sourceFingerprint
        ) {
          throw new Error(
            "The registry source was removed or changed while this package was encoding.",
          );
        }
        readyItem.adaptiveStatus = "ready";
        readyItem.adaptiveProfileVersion = ADAPTIVE_PROFILE_VERSION;
        delete readyItem.adaptiveLastError;
      });
    } catch (error) {
      return fail(
        PROCESSING_ERROR_CODES.encodeFailed,
        `The package was published, but the rendition registry could not record it, so playback cannot find it yet: ${
          error instanceof Error ? error.message : String(error)
        }`,
        true,
      );
    }

    await store.update(job.id, {
      state: "succeeded",
      stage: "complete",
      stageProgress: 1,
      overallProgress: 1,
      ...(damage.length > 0
        ? {
            sourceDamage: damage as unknown as Record<string, unknown>[],
            warnings: [...job.warnings, ...damageWarnings],
          }
        : {}),
      ...(result.versionDirectory
        ? { publishedVersion: result.versionDirectory }
        : {}),
      /*
       * On success the size is no longer predicted, it is known. Actual and
       * estimated converge so a finished row cannot show two different
       * numbers for the same thing.
       */
      ...(result.jobOutputBytes === undefined
        ? {}
        : {
            bytesProcessed: result.jobOutputBytes,
            estimatedOutputBytes: result.jobOutputBytes,
          }),
      ...(result.storageBytes === undefined
        ? {}
        : { outputBytes: result.storageBytes }),
      speed: null,
      fps: null,
      etaSeconds: 0,
      finishedAt: new Date(),
    });

    /*
     * Published here means written into the mount's cache. The upload to
     * Drive carries on in the background and is followed from there; the job
     * does not wait for it, so the encoder is already free for the next title.
     */
    if (driveUploads && result.status !== "already-valid") {
      void titleRootForInput(input)
        .then((directory) =>
          driveUploads.track({
            processingJobId: job.id,
            directory,
            totalBytes: result.jobOutputBytes ?? result.storageBytes ?? 0,
          }),
        )
        .catch(() => undefined);
    }

    /*
     * Publication is now reflected in both durable records. Until this point
     * the verified SSD workspace remains the recovery source for a crash after
     * the HDD rename but before the database commit.
     */
    if (result.workspaceDirectory) {
      const owned = await verifyOwnedJobWorkspace(
        workRoot,
        result.workspaceDirectory,
        job.id,
      );
      await rm(owned, { recursive: true, force: true }).catch(async (error) => {
        await store.appendEvent({
          processingJobId: job.id,
          stage: "complete",
          level: "warning",
          message:
            "The package was published, but its scratch workspace could not be removed.",
          detail: {
            error: error instanceof Error ? error.message : String(error),
          },
        });
      });
      await store.update(job.id, { stagingDirectory: null });
    }
    if (result.publicationIncomingDirectory) {
      await cleanupPublicationIncoming(
        await titleRootForInput(input),
        result.publicationIncomingDirectory,
        job.id,
      ).catch(async (error) => {
        await store.appendEvent({
          processingJobId: job.id,
          stage: "complete",
          level: "warning",
          message:
            "The package was published, but its HDD incoming marker could not be removed.",
          detail: {
            error: error instanceof Error ? error.message : String(error),
          },
        });
      });
    }

    await store.appendEvent({
      processingJobId: job.id,
      stage: "complete",
      level: damage.length > 0 ? "warning" : "info",
      message:
        result.status === "already-valid"
          ? "A current package already existed; nothing needed rebuilding."
          : damage.length > 0
            ? `Published with source damage. ${damageWarnings.join(" ")}`
            : "Published the verified package.",
      ...(result.versionDirectory
        ? { detail: { versionDirectory: result.versionDirectory } }
        : {}),
    });

    return { status: "succeeded", decision, packageResult: result };
  }

  return {
    async run(input: RunProcessingJobInput): Promise<RunProcessingJobOutcome> {
      try {
        return await attempt(input);
      } catch (error) {
        /*
         * Nothing here is allowed to become a queue-level retry on its own.
         *
         * The conditions that genuinely deserve another pass say so by their
         * type: another attempt holding the rendition lock, and a registry
         * that read back empty through the mount before any work began.
         * Everything else — a dropped database connection, a bug, an
         * unhandled rejection from a write — leaves a job row an operator can
         * see and retry deliberately. Requeuing automatically is what sent a
         * second FFmpeg at a failing platter while the first was still being
         * reaped.
         */
        const message =
          error instanceof Error
            ? error.message
            : "Processing stopped unexpectedly.";
        const retryable =
          error instanceof RenditionLockHeldError ||
          error instanceof RenditionRegistryUnreadableError;
        await store
          .update(input.processingJobId, {
            state: "failed",
            errorCode: PROCESSING_ERROR_CODES.encodeFailed,
            errorMessage: message,
            finishedAt: new Date(),
          })
          .catch(() => undefined);
        await store
          .appendEvent({
            processingJobId: input.processingJobId,
            stage: "waiting",
            level: "error",
            message,
          })
          .catch(() => undefined);
        await clearLiveProgress(input.processingJobId).catch(() => undefined);
        return {
          status: "failed",
          errorCode: PROCESSING_ERROR_CODES.encodeFailed,
          errorMessage: message,
          ...(retryable ? { retryable: true } : {}),
        };
      }
    },
  };
}
