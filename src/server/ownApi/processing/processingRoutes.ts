import { stat, unlink } from "node:fs/promises";
import path from "node:path";
import { OwnApiError } from "../ownApiHandler";
import { sendData } from "../api/envelope";
import type { RouteDefinition } from "../api/router";
import {
  asObjectBody,
  isUuid,
  optionalBodyString,
  parseLimit,
  requireUuid,
  validationError,
} from "../api/validation";
import { isPathInsideRoot } from "../../pathSecurity";
import {
  describeMissingPackageAssets,
  missingPackageAssets,
} from "./packageAssets";
import type { CatalogueRepository } from "../catalogue/catalogueRepository";
import type { JobQueue } from "../tasks/jobQueue";
import {
  detectHardware,
  type HardwareReport,
} from "../../../renditions/hardware/detect";
import { ADAPTIVE_PROFILE_VERSION } from "../../../renditions/adaptive/profile";
import { readTitlePackageManifest } from "../../../renditions/adaptive/publishTitle";
import {
  type ProcessingJobRecord,
  type ProcessingJobStore,
  type ProcessingState,
} from "./jobStore";
import {
  PROCESSING_JOB_TYPE,
  createProcessingEnqueuer,
} from "./processingEnqueue";
import { createPackageIndex, manifestIdentity } from "./packageIndex";
import {
  packageTargetsFor,
  projectCatalogue,
  type ProcessingCatalogueView,
} from "./processingProjection";
import { PROCESSING_STAGES } from "./stages";
import { readVolumeSpace } from "./volumeSpace";
import {
  createPermissiveStorageGuard,
  type StorageGuard,
} from "./storageGuard";
import type { StorageIncidentStore } from "./storageIncidentStore";
import {
  clearLiveProgress,
  liveProgressIsFresh,
  readLiveProgress,
  type LiveProgressSnapshot,
} from "./liveProgress";

/*
 * Re-exported rather than redefined: the queue's job type and the code that
 * enqueues it must not be able to disagree.
 */
export { PROCESSING_JOB_TYPE };

export interface ProcessingRoutesOptions {
  catalogue: CatalogueRepository;
  store: ProcessingJobStore;
  queue: JobQueue;
  mediaRoot: string;
  /** Scratch root used by the worker, including its job directories. */
  workRoot: string;
  ffmpegPath?: string;
  ffprobePath?: string;
  /**
   * Whether the media volume is currently mounted. Injected rather than probed
   * here so the routes and the watchdog cannot disagree about it.
   */
  storageAvailable?: () => boolean;
  /**
   * The durable verdict on the storage, and the operator's way back from it.
   *
   * Separate from `storageAvailable` on purpose. That asks the volume whether
   * it is there, which a failing drive answers correctly right up to the moment
   * it takes the machine down; this asks what the system remembers about it,
   * which is the only thing that survives the forced reboot that ends such an
   * incident.
   */
  storageGuard?: StorageGuard;
  /** The incident history, for the panel that explains why nothing is running. */
  storageIncidents?: Pick<StorageIncidentStore, "listOpen" | "listRecent">;
}

/**
 * Hardware is probed by encoding, which costs a second or two. The result only
 * changes when the machine does, so it is held briefly rather than re-probed on
 * every page load.
 */
/**
 * The states in which a processing job still has a future.
 *
 * Mirrors the store's own active set, which is what the unique index and every
 * guarded statement there are written against. Kept here so the routes decide
 * "can this still be acted on?" from the same list rather than from an
 * inlined array that drifts from it.
 */
const ACTIVE_PROCESSING_STATES: readonly ProcessingState[] = [
  "pending",
  "queued",
  "running",
  "paused",
];

const HARDWARE_CACHE_MS = 60_000;

/**
 * How long the projected catalogue tree is reused between polls.
 *
 * Short enough that a finished scan appears almost at once, long enough that a
 * page refreshing every second is not re-reading every episode of every show
 * sixty times a minute. Job state is never cached with it.
 */
const CATALOGUE_CACHE_MS = 4_000;

function toJobDto(job: ProcessingJobRecord) {
  return {
    id: job.id,
    itemId: job.itemId,
    mediaFileId: job.mediaFileId,
    profile: job.profile,
    state: job.state,
    stage: job.stage,
    stageProgress: job.stageProgress,
    overallProgress: job.overallProgress,
    bytesProcessed: job.bytesProcessed,
    outputBytes: job.outputBytes,
    estimatedOutputBytes: job.estimatedOutputBytes,
    /*
     * Named for what they mean rather than for where they are stored.
     * `actualOutputBytes` is what this job has physically written; it is never
     * the package's size and never a prediction. `outputBytes` is kept as the
     * published package total for anything already reading it.
     */
    actualOutputBytes: job.bytesProcessed,
    estimatedStagingBytes: job.estimatedStagingBytes,
    speed: job.speed,
    fps: job.fps,
    etaSeconds: job.etaSeconds,
    hardwareAdapter: job.hardwareAdapter,
    videoEncoder: job.videoEncoder,
    decision: job.decision,
    validation: job.validation,
    warnings: job.warnings,
    /*
     * Null for a clean encode; an array of replaced intervals for a salvaged
     * one. The page needs this to tell a perfect result from a title that is
     * playable because five minutes of it were substituted, which a `succeeded`
     * state alone cannot say. It carries seconds and counts only — never a path.
     */
    sourceDamage: job.sourceDamage,
    errorCode: job.errorCode,
    errorMessage: job.errorMessage,
    publishedVersion: job.publishedVersion,
    attempts: job.attempts,
    cancellationRequested: job.cancellationRequested,
    pauseRequested: job.pauseRequested,
    pausedReason: job.pausedReason,
    /*
     * The checkpointed build's position. `encodedSeconds` over
     * `sourceDurationSeconds` is the video percentage the page shows;
     * `overallProgress` remains a whole-workflow figure and must never be
     * presented as how much of the film has been encoded.
     */
    epochCount: job.epochCount,
    epochIndex: job.epochIndex,
    completedEpochs: job.completedEpochs,
    protectedSeconds: job.protectedSeconds,
    encodedSeconds: job.encodedSeconds,
    sourceDurationSeconds: job.sourceDurationSeconds,
    epochStartSeconds: job.epochStartSeconds,
    epochEndSeconds: job.epochEndSeconds,
    checkpointBytes: job.checkpointBytes,
    freeBytes: job.freeBytes,
    ...(job.queuePriority === undefined
      ? {}
      : { queuePriority: job.queuePriority }),
    createdAt: job.createdAt.toISOString(),
    startedAt: job.startedAt?.toISOString() ?? null,
    finishedAt: job.finishedAt?.toISOString() ?? null,
    updatedAt: job.updatedAt.toISOString(),
  };
}

/**
 * What a running job is called, in terms that identify it.
 *
 * A movie job needs only its title. An episode job needs the show and the
 * code as well: a queue tab listing "Pilot", "Pilot", "Pilot" is a queue tab
 * nobody can act on. Built from the tree the overview already assembled, so
 * this costs no query of its own.
 */
export interface ProcessingJobTitle {
  jobId: string;
  kind: "movie" | "episode";
  /** The show for an episode; absent for a movie. */
  seriesTitle?: string;
  /** `S01E01` for an episode; absent for a movie. */
  code?: string;
  /*
   * The same two numbers the code spells out, as numbers.
   *
   * Sent as well as the code because the code is a label and these are the
   * catalogue's answer: the queue's "group by show and episode" sorts on them,
   * and sorting on a parsed label is how S01E10 lands before S01E09 the day
   * somebody changes how the label is written.
   */
  seasonNumber?: number;
  episodeNumber?: number | null;
  title: string;
}

export function describeJobs(
  jobs: readonly ProcessingJobRecord[],
  view: ProcessingCatalogueView,
): ProcessingJobTitle[] {
  const byItem = new Map<
    string,
    {
      kind: "movie" | "episode";
      seriesTitle?: string;
      code?: string;
      seasonNumber?: number;
      episodeNumber?: number | null;
      title: string;
    }
  >();
  for (const movie of view.movies) {
    byItem.set(movie.itemId, { kind: "movie", title: movie.title });
  }
  for (const series of view.series) {
    for (const season of series.seasons) {
      for (const episode of season.episodes) {
        byItem.set(episode.itemId, {
          kind: "episode",
          seriesTitle: series.title,
          code: episode.code,
          seasonNumber: season.seasonNumber,
          episodeNumber: episode.episodeNumber,
          title: episode.title,
        });
      }
    }
  }

  const titles: ProcessingJobTitle[] = [];
  for (const job of jobs) {
    const entry = byItem.get(job.itemId);
    if (!entry) continue;
    titles.push({ jobId: job.id, ...entry });
  }
  return titles;
}

export function createProcessingRoutes({
  catalogue,
  store,
  queue,
  mediaRoot,
  workRoot,
  ffmpegPath = process.env.SEYIRLIK_FFMPEG_PATH ?? "ffmpeg",
  ffprobePath = process.env.SEYIRLIK_FFPROBE_PATH ?? "ffprobe",
  storageAvailable = () => true,
  storageGuard = createPermissiveStorageGuard(),
  storageIncidents,
}: ProcessingRoutesOptions): RouteDefinition[] {
  const resolvedMediaRoot = path.resolve(mediaRoot);

  /**
   * The storage panel's payload.
   *
   * Deliberately says whether automatic resume is blocked as its own field
   * rather than leaving a page to infer it from the state name. "Quarantined"
   * means nothing to somebody who has just found their library stopped; "this
   * will not start again until you say so" means everything.
   */
  const describeGuard = () => ({
    root: storageGuard.health.root,
    state: storageGuard.health.state,
    summary: storageGuard.describe(),
    reason: storageGuard.health.reason,
    faultCount: storageGuard.health.faultCount,
    missingRoots: [...storageGuard.health.missingRoots],
    firstFaultAt:
      storageGuard.health.firstFaultAtMs === null
        ? null
        : new Date(storageGuard.health.firstFaultAtMs).toISOString(),
    lastFaultAt:
      storageGuard.health.lastFaultAtMs === null
        ? null
        : new Date(storageGuard.health.lastFaultAtMs).toISOString(),
    changedAt: new Date(storageGuard.health.changedAtMs).toISOString(),
    verifiedAt:
      storageGuard.health.verifiedAtMs === null
        ? null
        : new Date(storageGuard.health.verifiedAtMs).toISOString(),
    mayStartWork: storageGuard.mayStartWork(),
    automaticResumeBlocked: !storageGuard.resumesAutomatically(),
    /** True when the next step is the operator's cheap verification. */
    awaitingVerification:
      storageGuard.health.state === "quarantined" ||
      storageGuard.health.state === "suspect",
    /** True when verification has passed and only the resume press remains. */
    awaitingResume: storageGuard.health.state === "recovery-pending",
  });
  let hardwareCache: { report: HardwareReport; at: number } | null = null;

  async function hardware(): Promise<HardwareReport> {
    if (hardwareCache && Date.now() - hardwareCache.at < HARDWARE_CACHE_MS) {
      return hardwareCache.report;
    }
    const report = await detectHardware({
      ffmpegPath,
      probeWidth: 1920,
      probeHeight: 1080,
    });
    hardwareCache = { report, at: Date.now() };
    return report;
  }

  /*
   * The one path that creates a job, shared by the single-title button, the
   * season button and the series button. Built here so it closes over the same
   * hardware cache and the same storage guard the routes answer with.
   */
  const enqueuer = createProcessingEnqueuer({
    catalogue,
    store,
    queue,
    mediaRoot: resolvedMediaRoot,
    workRoot,
    ffprobePath,
    hardware,
    storageGuard,
  });
  const { locateSource, statSource, existingPackage, analyse } = enqueuer;

  /**
   * The queue attempt currently responsible for a durable job, if any.
   *
   * Asked of the queue by what the attempt is *for*. `job.jobId` records the
   * last attempt attached, and a job outlives its attempts: after a run that
   * parked the work for storage that column names a row the queue calls
   * `succeeded`, which is neither an error nor something that can be
   * cancelled. It is still consulted as a fallback, but only when it points at
   * something that can actually still run.
   */
  async function currentAttempt(
    job: Pick<ProcessingJobRecord, "id" | "jobId">,
  ) {
    const found = await queue.findActive({
      jobType: PROCESSING_JOB_TYPE,
      payload: { processingJobId: job.id },
    });
    if (found) return found;
    if (!job.jobId) return null;
    const attached = await queue.get(job.jobId);
    return attached &&
      (attached.status === "queued" || attached.status === "running")
      ? attached
      : null;
  }

  /**
   * The catalogue view, cached for a moment.
   *
   * The page polls once a second while anything is running, and almost all of
   * what it asks for on those polls is the job list. Rebuilding the whole
   * series tree each time would run the same two statements sixty times a
   * minute for a result that only changes when a scan does, so the tree is
   * held briefly and the jobs are always fresh — they are stitched onto the
   * cached tree below rather than cached with it.
   */
  let catalogueCache: { view: ProcessingCatalogueView; at: number } | null =
    null;
  const packageIndex = createPackageIndex();

  const SOURCE_PRESENCE_TTL_MS = 30_000;
  const SOURCE_PRESENCE_CONCURRENCY = 4;
  const sourcePresence = new Map<
    string,
    { available: boolean; checkedAt: number }
  >();

  /**
   * `media_files.missing_since` cannot answer whether a processed title still
   * has its original source: rendition-backed titles deliberately keep that
   * row active so playback can authorize the generated package through its
   * original file identity.
   *
   * Check the actual path only for titles that already own a package, cache the
   * result, and bound concurrency so an overview poll never turns into a burst
   * of filesystem operations against the media disk.
   */
  async function refreshSourcePresence(
    rows: ReadonlyArray<{
      mediaFileId: string | null;
      relativePath: string | null;
      fileMissingSince: Date | null;
    }>,
  ): Promise<void> {
    if (!storageAvailable()) return;

    const now = Date.now();
    const candidates = rows.filter((row) => {
      if (
        !row.mediaFileId ||
        !row.relativePath ||
        row.fileMissingSince !== null
      ) {
        return false;
      }

      // The catalogue is sufficient for ordinary, source-backed titles.
      // Physical verification is needed only once a generated package exists.
      if (packageIndex.get(row.mediaFileId).summary === null) return false;

      const cached = sourcePresence.get(row.mediaFileId);
      return !cached || now - cached.checkedAt >= SOURCE_PRESENCE_TTL_MS;
    });

    for (
      let offset = 0;
      offset < candidates.length;
      offset += SOURCE_PRESENCE_CONCURRENCY
    ) {
      const batch = candidates.slice(
        offset,
        offset + SOURCE_PRESENCE_CONCURRENCY,
      );

      await Promise.all(
        batch.map(async (row) => {
          const mediaFileId = row.mediaFileId;
          const relativePath = row.relativePath;
          if (!mediaFileId || !relativePath) return;

          const absolutePath = path.resolve(
            resolvedMediaRoot,
            ...relativePath.split("/"),
          );

          let available = false;

          if (isPathInsideRoot(resolvedMediaRoot, absolutePath)) {
            try {
              const stats = await stat(absolutePath);
              available = stats.isFile();
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
                /*
                 * An I/O error is not proof that a source was deleted. Do not
                 * overwrite a previous verdict; with no previous verdict the
                 * projection below fails closed and hides destructive actions.
                 */
                return;
              }
            }
          }

          sourcePresence.set(mediaFileId, {
            available,
            checkedAt: Date.now(),
          });
        }),
      );
    }
  }

  async function catalogueView(): Promise<ProcessingCatalogueView> {
    const rows = await catalogue.listProcessableTitles();
    /*
     * Ask the index to keep these titles warm. It reads manifests off the
     * media volume on its own clock and a few at a time; this call never
     * touches a disk and never waits.
     */
    packageIndex.track(packageTargetsFor(rows, resolvedMediaRoot));

    /*
     * Refresh only stale package-backed source paths. The result is cached
     * separately from the catalogue identity because the latter deliberately
     * survives source deletion.
     */
    await refreshSourcePresence(rows);

    const fileIds = rows
      .map((row) => row.mediaFileId)
      .filter((id): id is string => id !== null);
    const [report, streamsByFile, activeJobs] = await Promise.all([
      hardware(),
      catalogue.listStreamsForFiles(fileIds),
      store.listActive(),
    ]);
    const activeJobsByFile = new Map(
      activeJobs.map((job) => [job.mediaFileId, job]),
    );

    return projectCatalogue(rows, {
      hardware: report,
      streamsByFile,
      packageFor: (mediaFileId) => packageIndex.get(mediaFileId),
      sourceAvailableFor: (row) => {
        if (!row.mediaFileId || row.fileMissingSince !== null) return false;

        /*
         * During a storage outage, never advertise a destructive source action.
         * Nothing is persisted from this verdict.
         */
        if (!storageAvailable()) return false;

        const cached = sourcePresence.get(row.mediaFileId);
        if (cached) return cached.available;

        /*
         * No package means the ordinary catalogue source semantics are enough.
         * A package-backed title with no physical verdict fails closed until
         * the bounded presence check above has confirmed its source.
         */
        return packageIndex.get(row.mediaFileId).summary === null;
      },
      activeJobsByFile,
    });
  }

  async function cachedCatalogueView(): Promise<ProcessingCatalogueView> {
    if (catalogueCache && Date.now() - catalogueCache.at < CATALOGUE_CACHE_MS) {
      return catalogueCache.view;
    }
    const view = await catalogueView();
    catalogueCache = { view, at: Date.now() };
    return view;
  }

  /** Dropped whenever this process changes what the tree would say. */
  function invalidateCatalogueView(mediaFileId?: string): void {
    catalogueCache = null;
    if (mediaFileId) packageIndex.invalidate(mediaFileId);
  }

  /**
   * The episodes a season or series press would act on.
   *
   * Read from the catalogue rather than from the cached tree, so a bulk action
   * is never taken against a view that is seconds old. Ineligible episodes are
   * still returned: `enqueueAll` is what decides, and it decides by trying,
   * which is the only answer that cannot be stale.
   */
  async function episodeTargets(scope: {
    seriesId?: string;
    seasonId?: string;
  }): Promise<Array<{ itemId: string; mediaFileId: string }>> {
    const rows = await catalogue.listProcessableTitles({
      ...scope,
      kinds: ["episode"],
    });
    return rows
      .filter(
        (row): row is typeof row & { mediaFileId: string } =>
          row.mediaFileId !== null,
      )
      .map((row) => ({ itemId: row.itemId, mediaFileId: row.mediaFileId }));
  }

  return [
    {
      method: "GET",
      path: "/processing/hardware",
      access: "admin",
      handle: async (context) => {
        context.requirePrincipal();
        sendData(context.response, context.requestId, await hardware());
      },
    },

    {
      /** Free space on the media and scratch volumes, for the admin overview. */
      method: "GET",
      path: "/processing/space",
      access: "admin",
      handle: async (context) => {
        context.requirePrincipal();
        sendData(context.response, context.requestId, {
          volumes: await readVolumeSpace([
            {
              role: "media",
              root: resolvedMediaRoot,
              skip: !storageAvailable(),
            },
            { role: "scratch", root: workRoot },
          ]),
        });
      },
    },

    {
      method: "GET",
      path: "/processing/overview",
      access: "admin",
      handle: async (context) => {
        context.requirePrincipal();
        await store.reconcileTerminalQueueJobs();
        const [counts, report, jobs, view] = await Promise.all([
          store.counts(),
          hardware(),
          store.list({ limit: 50 }),
          /*
           * The catalogue projection, which fails soft. A page that cannot
           * list titles must still be able to show the jobs that are running
           * and the drive that is holding them, which is the whole reason
           * somebody has this page open during an incident.
           */
          cachedCatalogueView().catch(
            (): ProcessingCatalogueView => ({ movies: [], series: [] }),
          ),
        ]);
        sendData(context.response, context.requestId, {
          counts,
          hardware: report,
          jobs: jobs.map(toJobDto),
          stages: PROCESSING_STAGES,
          profile: ADAPTIVE_PROFILE_VERSION,
          /*
           * The catalogue, as processing sees it: films, and shows as the
           * hierarchy they actually are. Movies keep their own preview-driven
           * cards, so this is additive — nothing that reads the fields above
           * has to know these exist.
           */
          movies: view.movies,
          series: view.series,
          /*
           * Job identity for the queue tab. A job row carries an item id, and
           * "Pilot" is not enough to tell which show's pilot is encoding, so
           * the labels ride along with the jobs rather than being looked up
           * one at a time by the page.
           */
          jobTitles: describeJobs(jobs, view),
          /*
           * Carried on the overview rather than left to a second request. A
           * page that lists a dozen paused jobs and cannot say why is the page
           * an operator was looking at while the drive was being attacked; the
           * reason has to arrive with the jobs, not after them.
           */
          storage: describeGuard(),
        });
      },
    },

    {
      /**
       * The storage panel, and its history.
       *
       * Read-only and free: everything it reports is memory or a database row.
       * Nothing here touches the volume, which is the point — an operator
       * refreshing the page that tells them their drive is failing must not be
       * the thing that sends another read at it.
       */
      method: "GET",
      path: "/processing/storage",
      access: "admin",
      handle: async (context) => {
        context.requirePrincipal();
        sendData(context.response, context.requestId, {
          storage: describeGuard(),
          open: (await storageIncidents?.listOpen()) ?? [],
          recent: (await storageIncidents?.listRecent(20)) ?? [],
        });
      },
    },

    {
      /**
       * "Storage repaired — verify".
       *
       * The whole of the check is the watchdog's own poll: stat the roots, list
       * them, compare the device against the one last seen. It reads no media,
       * takes no checksum and runs no benchmark, because a verification that
       * exercises a suspect drive is simply the next outage with a friendlier
       * label on it.
       *
       * Passing does not start anything. It moves the storage to
       * `recovery-pending`, and the operator presses resume separately — two
       * steps, so that reconnecting a drive is never on its own the thing that
       * restarts a multi-hour encode against it.
       */
      method: "POST",
      path: "/processing/storage/verify",
      access: "admin",
      handle: async (context) => {
        const principal = context.requirePrincipal();
        const outcome = await storageGuard.verify(principal.userId);
        sendData(context.response, context.requestId, {
          ok: outcome.ok,
          detail: outcome.detail,
          /*
           * The page must be able to say *which* thing happened. A drive that
           * was genuinely recovered and a replacement that was adopted are
           * different facts about what is in the machine, and presenting them
           * identically would be the interface lying.
           */
          outcome: outcome.outcome,
          storage: describeGuard(),
        });
      },
    },

    {
      /**
       * "This is replacement storage — adopt it."
       *
       * Its own endpoint rather than a flag on verify, because it is a different
       * act: verification asks whether this is the same disk, adoption declares
       * that a different disk is now the one that counts. It requires a volume
       * that can identify itself and refuses otherwise, so it is never a way to
       * switch fail-closed off.
       */
      method: "POST",
      path: "/processing/storage/adopt",
      access: "admin",
      handle: async (context) => {
        const principal = context.requirePrincipal();
        const outcome = await storageGuard.adopt(principal.userId);
        if (!outcome.ok) {
          throw new OwnApiError(
            "PROCESSING_STORAGE_NOT_ADOPTABLE",
            outcome.detail,
            409,
          );
        }
        sendData(context.response, context.requestId, {
          detail: outcome.detail,
          adoptedVolumeUuid: outcome.adopted?.volumeUuid ?? null,
          storage: describeGuard(),
        });
      },
    },

    {
      /**
       * The second press. The only thing in this system that lifts a
       * quarantine.
       *
       * Refuses unless a verification has passed, so the cheap safe check has
       * definitely been run against the hardware as it is now rather than as it
       * was when somebody last looked.
       */
      method: "POST",
      path: "/processing/storage/resume",
      access: "admin",
      handle: async (context) => {
        const principal = context.requirePrincipal();
        if (storageGuard.health.state !== "recovery-pending") {
          throw new OwnApiError(
            "PROCESSING_STORAGE_NOT_VERIFIED",
            "Verify the storage before resuming it.",
            409,
          );
        }
        await storageGuard.resume(principal.userId);
        /*
         * Jobs are not requeued from here. Whoever owns the encoders owns that
         * decision, and in a split deployment that is the worker process — the
         * one place `requeueStorageInterruptedJobs` lives. Its watchdog sees a
         * healthy guard within a poll and picks the work up, which is also what
         * keeps two runtimes from requeueing the same job twice.
         */
        sendData(context.response, context.requestId, {
          storage: describeGuard(),
        });
      },
    },

    {
      /** The decision, without queueing anything. */
      method: "POST",
      path: "/processing/preview",
      access: "admin",
      handle: async (context) => {
        context.requirePrincipal();
        const body = asObjectBody(await context.readJson(8 * 1024), [
          "itemId",
          "mediaFileId",
        ]);
        const itemId = requireUuid(
          optionalBodyString(body, "itemId"),
          "itemId",
        );
        const mediaFileId = body.mediaFileId
          ? requireUuid(optionalBodyString(body, "mediaFileId"), "mediaFileId")
          : undefined;
        /*
         * A title whose source has been deleted still has a package worth
         * describing, so the preview reports the absent source rather than
         * failing on it. There is no decision to make without the bytes: the
         * page shows what is on disk and offers no way to start a job.
         */
        const located = await locateSource(itemId, mediaFileId);
        const stats = await statSource(located.file, located.absolutePath);
        if (!stats) {
          const existing = await existingPackage(
            await enqueuer.titleRootFor(itemId, located.absolutePath),
            null,
          );
          if (existing.damage)
            packageIndex.noteDamage(located.file.id, existing.damage);
          const activeJob = await store.findActiveForFile(located.file.id);
          sendData(context.response, context.requestId, {
            itemId,
            mediaFileId: located.file.id,
            relativePath: located.file.relativePath,
            sourceAvailable: false,
            sourceFingerprint: null,
            decision: null,
            existing: { ...existing, missingRungs: [] },
            activeJobId: activeJob?.id ?? null,
          });
          return;
        }

        const { decision, file, fingerprint, existing } = await analyse(
          itemId,
          mediaFileId,
        );
        /*
         * The one reader that looks at the files tells the index what it saw,
         * so the library list stops offering to remove a source whose package
         * is short a rung, and starts offering to encode that rung instead.
         * The sweep cannot find this out for itself without a stat per
         * rendition across the whole library.
         */
        if (existing.damage) packageIndex.noteDamage(file.id, existing.damage);
        const active = await store.findActiveForFile(file.id);
        sendData(context.response, context.requestId, {
          itemId,
          mediaFileId: file.id,
          relativePath: file.relativePath,
          sourceAvailable: true,
          sourceFingerprint: fingerprint,
          decision,
          existing,
          activeJobId: active?.id ?? null,
        });
      },
    },

    {
      /**
       * Deletes the source file of a title whose package already holds every
       * rendition it would ever be given.
       *
       * The bytes are gone for good, so nothing the page believes is taken on
       * trust: the source is re-fingerprinted, the ladder is re-decided from
       * it, and every file the package claims is checked before the source is
       * unlinked. A page can be looking at a preview minutes old, and in that
       * time the file can have been replaced or the package half-removed.
       */
      method: "POST",
      path: "/processing/source/delete",
      access: "admin",
      handle: async (context) => {
        context.requirePrincipal();
        const body = asObjectBody(await context.readJson(8 * 1024), [
          "itemId",
          "mediaFileId",
        ]);
        const itemId = requireUuid(
          optionalBodyString(body, "itemId"),
          "itemId",
        );
        const mediaFileId = body.mediaFileId
          ? requireUuid(optionalBodyString(body, "mediaFileId"), "mediaFileId")
          : undefined;

        /*
         * A volume that has gone away reads as "every file is missing", which
         * is the one reading under which this route must do nothing at all.
         */
        if (!storageAvailable()) {
          throw new OwnApiError(
            "PROCESSING_STORAGE_UNAVAILABLE",
            "The media volume is not available, so the source file cannot be removed.",
            409,
          );
        }

        const located = await locateSource(itemId, mediaFileId);
        const active = await store.findActiveForFile(located.file.id);
        if (active) {
          throw new OwnApiError(
            "PROCESSING_JOB_EXISTS",
            "This file has a processing job that has not finished, and that job is still reading it.",
            409,
          );
        }

        const stats = await statSource(located.file, located.absolutePath);
        if (!stats) {
          /*
           * The state being asked for is already the state on disk. Reporting
           * that is more useful than failing: a double submission, or a page
           * that lost the response, must not read as a problem.
           */
          // The source is physically absent. Record that independently
          // from the catalogue identity, which rendition playback still needs.
          sourcePresence.set(located.file.id, {
            available: false,
            checkedAt: Date.now(),
          });
          invalidateCatalogueView(located.file.id);
          sendData(context.response, context.requestId, {
            deleted: false,
            alreadyAbsent: true,
            freedBytes: 0,
          });
          return;
        }
        if (!stats.isFile()) {
          throw new OwnApiError(
            "SOURCE_NOT_A_FILE",
            "The source path is not a regular file.",
            409,
          );
        }

        /*
         * The package's real location, which for an episode is its own folder
         * inside the season rather than the season folder itself. Removing a
         * source is the one action here that cannot be taken back, so it must
         * be checking the package that actually belongs to these bytes.
         */
        const titleRoot = await enqueuer.titleRootFor(
          itemId,
          located.absolutePath,
        );
        const manifest = await readTitlePackageManifest(titleRoot).catch(
          () => undefined,
        );
        if (!manifest) {
          throw new OwnApiError(
            "PROCESSING_PACKAGE_INCOMPLETE",
            "This title's package manifest could not be read, so its renditions cannot be confirmed.",
            409,
          );
        }
        const missing = await missingPackageAssets(titleRoot, manifest);
        if (missing.length > 0) {
          packageIndex.noteDamage(located.file.id, {
            manifestId: manifestIdentity(manifest),
            rungs: [
              ...new Set(
                missing
                  .map((asset) => asset.qualityHeight)
                  .filter((height): height is number => height !== undefined),
              ),
            ],
            elsewhere: missing.some(
              (asset) => asset.qualityHeight === undefined,
            ),
          });
          throw new OwnApiError(
            "PROCESSING_PACKAGE_INCOMPLETE",
            `This title's package is incomplete on disk, so its source is still the only whole copy: ${describeMissingPackageAssets(missing)}.`,
            409,
          );
        }

        /*
         * Then the questions the files cannot answer: whether these are still
         * the bytes the package was built from, and whether today's ladder
         * would give the title a rung it does not have.
         */
        const { existing } = await analyse(itemId, mediaFileId);
        if (
          !existing.present ||
          !existing.sourceMatches ||
          !existing.profileMatches ||
          existing.missingRungs.length > 0
        ) {
          throw new OwnApiError(
            "PROCESSING_PACKAGE_INCOMPLETE",
            "This title still needs its source: its package is missing renditions, was built from different bytes, or was built by an older profile.",
            409,
          );
        }

        await unlink(located.absolutePath);

        /*
         * Keep the media-file identity for rendition authorization, but record
         * that its original bytes no longer exist. The next overview therefore
         * cannot advertise "Remove Source" again.
         */
        sourcePresence.set(located.file.id, {
          available: false,
          checkedAt: Date.now(),
        });
        invalidateCatalogueView(located.file.id);

        sendData(context.response, context.requestId, {
          deleted: true,
          alreadyAbsent: false,
          freedBytes: stats.size,
        });
      },
    },

    {
      method: "POST",
      path: "/processing/jobs",
      access: "admin",
      handle: async (context) => {
        context.requirePrincipal();
        /*
         * Refused before the source is even located. Queueing new work against
         * guarded storage is how a backlog gets built that the moment the
         * quarantine lifts is thrown at the drive all at once.
         */
        if (!storageGuard.mayStartWork()) {
          throw new OwnApiError(
            "PROCESSING_STORAGE_GUARDED",
            `${storageGuard.describe()} Verify and resume the storage before queueing new work.`,
            409,
          );
        }
        const body = asObjectBody(await context.readJson(8 * 1024), [
          "itemId",
          "mediaFileId",
        ]);
        const itemId = requireUuid(
          optionalBodyString(body, "itemId"),
          "itemId",
        );
        const mediaFileId = body.mediaFileId
          ? requireUuid(optionalBodyString(body, "mediaFileId"), "mediaFileId")
          : undefined;

        /*
         * One title, through the same creation path a season and a series use.
         * Nothing about this request is special-cased; what makes it a single
         * title is that the caller named one.
         */
        const { job } = await enqueuer.enqueue(itemId, mediaFileId);
        invalidateCatalogueView(job.mediaFileId);

        sendData(
          context.response,
          context.requestId,
          { job: toJobDto(job) },
          202,
        );
      },
    },

    {
      /**
       * "Process this season."
       *
       * One independent job per eligible episode, never one job for the
       * season. A season is a folder, not a thing that can be encoded: it has
       * no source file, no duration and no ladder, and a single job spanning
       * thirteen hours of video would lose all thirteen to one failure.
       *
       * Idempotent by construction rather than by a guard written here. Every
       * episode goes through the same creation path a single press uses, and
       * that path is refused by the unique index on `processing_jobs` and by
       * the queue's dedupe key when a job for the file already exists — so a
       * second press, a double click, or a season press overlapping a series
       * press all converge on the same set of jobs and report the duplicates
       * as `alreadyQueued` rather than making them.
       */
      method: "POST",
      path: "/processing/seasons/:seasonId/jobs",
      access: "admin",
      handle: async (context) => {
        context.requirePrincipal();
        const seasonId = requireUuid(context.params.seasonId, "seasonId");
        const targets = await episodeTargets({ seasonId });
        if (targets.length === 0) {
          throw new OwnApiError(
            "MEDIA_NOT_FOUND",
            "That season has no episodes with a playable source.",
            404,
          );
        }
        const outcome = await enqueuer.enqueueAll(targets);
        invalidateCatalogueView();
        sendData(context.response, context.requestId, outcome, 202);
      },
    },

    {
      /**
       * "Process every missing episode of this show."
       *
       * The same operation as the season one, over every season. It is not a
       * series-level job and there is no series-level state: a show is a
       * container, and the only things with a lifecycle are the episodes.
       */
      method: "POST",
      path: "/processing/series/:seriesId/jobs",
      access: "admin",
      handle: async (context) => {
        context.requirePrincipal();
        const seriesId = requireUuid(context.params.seriesId, "seriesId");
        const targets = await episodeTargets({ seriesId });
        if (targets.length === 0) {
          throw new OwnApiError(
            "MEDIA_NOT_FOUND",
            "That series has no episodes with a playable source.",
            404,
          );
        }
        const outcome = await enqueuer.enqueueAll(targets);
        invalidateCatalogueView();
        sendData(context.response, context.requestId, outcome, 202);
      },
    },

    {
      method: "GET",
      path: "/processing/jobs",
      access: "admin",
      handle: async (context) => {
        context.requirePrincipal();
        await store.reconcileTerminalQueueJobs();
        const stateParam = context.url.searchParams.get("state");
        const limit = parseLimit(
          context.url.searchParams.get("limit"),
          50,
          200,
        );
        const jobs = await store.list({
          ...(stateParam ? { state: stateParam as ProcessingState } : {}),
          limit,
        });
        sendData(context.response, context.requestId, jobs.map(toJobDto));
      },
    },

    {
      method: "POST",
      path: "/processing/queue/order",
      access: "admin",
      handle: async (context) => {
        context.requirePrincipal();
        const body = asObjectBody(await context.readJson(32 * 1024), [
          "jobIds",
        ]);
        const raw = body.jobIds;
        if (!Array.isArray(raw) || raw.length === 0 || raw.length > 200) {
          throw validationError("jobIds must be a list of 1 to 200 job ids.");
        }
        const jobIds = raw.map((value) => {
          if (!isUuid(value)) throw validationError("jobIds is invalid.");
          return value.toLowerCase();
        });
        if (new Set(jobIds).size !== jobIds.length) {
          throw validationError("jobIds must not repeat a job.");
        }
        const reordered = await store.reorderQueue(jobIds);
        sendData(context.response, context.requestId, { reordered });
      },
    },

    {
      method: "GET",
      path: "/processing/jobs/:jobId",
      access: "admin",
      handle: async (context) => {
        context.requirePrincipal();
        const id = requireUuid(context.params.jobId, "jobId");
        const job = await store.get(id);
        if (!job) {
          throw new OwnApiError(
            "PROCESSING_JOB_NOT_FOUND",
            "The processing job could not be found.",
            404,
          );
        }
        const after = Number(
          context.url.searchParams.get("afterSequence") ?? 0,
        );
        /*
         * The snapshot carries the live sample too. A page that has just
         * reconnected must not have to wait for the next encoder tick before it
         * can show where the encode is — that wait is what made a refresh look
         * like a stall.
         */
        const live = await readLiveProgress(id);
        sendData(context.response, context.requestId, {
          job: toJobDto(job),
          live: live && liveProgressIsFresh(live) ? live : null,
          streamDecisions: job.streamDecisions,
          events: (
            await store.listEvents(id, Number.isFinite(after) ? after : 0)
          ).map((event) => ({
            sequence: event.sequence,
            stage: event.stage,
            level: event.level,
            message: event.message,
            createdAt: event.createdAt.toISOString(),
          })),
        });
      },
    },

    {
      method: "DELETE",
      path: "/processing/jobs/:jobId",
      access: "admin",
      handle: async (context) => {
        context.requirePrincipal();
        const id = requireUuid(context.params.jobId, "jobId");
        const job = await store.get(id);
        if (!job) {
          throw new OwnApiError(
            "PROCESSING_JOB_NOT_FOUND",
            "The processing job could not be found.",
            404,
          );
        }
        if (["pending", "queued", "running", "paused"].includes(job.state)) {
          throw new OwnApiError(
            "PROCESSING_JOB_ACTIVE",
            "An active processing job cannot be removed from history.",
            409,
          );
        }
        const removed = await store.deleteFinished(id);
        if (!removed) {
          throw new OwnApiError(
            "PROCESSING_JOB_ACTIVE",
            "An active processing job cannot be removed from history.",
            409,
          );
        }
        sendData(context.response, context.requestId, { removed: true });
      },
    },

    {
      /**
       * Live progress, as Server-Sent Events.
       *
       * SSE rather than a WebSocket: this is one-way, the server already speaks
       * HTTP with the same session cookie, and a dropped connection reconnects
       * on its own. Every event carries the job's own sequence number as the
       * SSE id, so a browser reconnecting with `Last-Event-ID` resumes exactly
       * where it stopped instead of replaying the timeline or skipping part of
       * it.
       */
      method: "GET",
      path: "/processing/jobs/:jobId/stream",
      access: "admin",
      skipCsrf: true,
      handle: async (context) => {
        context.requirePrincipal();
        const id = requireUuid(context.params.jobId, "jobId");
        const job = await store.get(id);
        if (!job) {
          throw new OwnApiError(
            "PROCESSING_JOB_NOT_FOUND",
            "The processing job could not be found.",
            404,
          );
        }

        const lastEventId = Number(
          context.request.headers["last-event-id"] ??
            context.url.searchParams.get("lastEventId") ??
            0,
        );
        let sequence =
          Number.isFinite(lastEventId) && lastEventId > 0 ? lastEventId : 0;

        const { response } = context;
        response.statusCode = 200;
        response.setHeader("Content-Type", "text/event-stream; charset=utf-8");
        response.setHeader("Cache-Control", "no-store");
        response.setHeader("Connection", "keep-alive");
        response.setHeader("X-Accel-Buffering", "no");
        response.flushHeaders?.();

        let closed = false;
        const send = (event: string, data: unknown, eventId?: number) => {
          if (closed || response.writableEnded) return;
          const lines = [
            ...(eventId === undefined ? [] : [`id: ${eventId}`]),
            `event: ${event}`,
            `data: ${JSON.stringify(data)}`,
            "",
            "",
          ];
          response.write(lines.join("\n"));
        };

        const tick = async () => {
          if (closed) return;
          try {
            const current = await store.get(id);
            if (!current) {
              send("error", { message: "The job no longer exists." });
              finish();
              return;
            }
            send("progress", toJobDto(current));
            const events = await store.listEvents(id, sequence);
            for (const entry of events) {
              sequence = entry.sequence;
              send(
                "stage",
                {
                  sequence: entry.sequence,
                  stage: entry.stage,
                  level: entry.level,
                  message: entry.message,
                  createdAt: entry.createdAt.toISOString(),
                },
                entry.sequence,
              );
            }
            if (["succeeded", "failed", "cancelled"].includes(current.state)) {
              await liveTick();
              send("done", toJobDto(current));
              finish();
            }
          } catch {
            // A transient database error must not kill the stream; the next
            // tick tries again.
          }
        };

        /*
         * The fast lane.
         *
         * The encoder reports four times a second and writes each sample to a
         * small file; the job row is written about once a second. Reading the
         * file here is what lets the page move at the encoder's rate without
         * asking the database to absorb four writes a second per job for hours.
         *
         * Only a sample newer than the last one is sent, so a stalled encoder
         * produces silence rather than a bar that keeps moving.
         */
        let lastRevision = 0;
        const liveTick = async () => {
          if (closed) return;
          const snapshot = await readLiveProgress(id);
          if (!snapshot) return;
          if (snapshot.revision <= lastRevision) return;
          if (!liveProgressIsFresh(snapshot)) return;
          lastRevision = snapshot.revision;
          send("live", snapshot satisfies LiveProgressSnapshot);
        };

        const liveInterval = setInterval(() => void liveTick(), 250);
        const interval = setInterval(() => void tick(), 1000);
        // Keeps intermediaries from closing an idle connection between stages.
        const keepAlive = setInterval(() => {
          if (!closed && !response.writableEnded)
            response.write(": keep-alive\n\n");
        }, 15_000);

        function finish() {
          if (closed) return;
          closed = true;
          clearInterval(interval);
          clearInterval(liveInterval);
          clearInterval(keepAlive);
          response.end();
        }

        context.request.on("close", finish);
        await tick();
        await liveTick();

        // Held open until the client disconnects or the job finishes.
        await new Promise<void>((resolve) => {
          const settle = () => resolve();
          context.request.once("close", settle);
          const poll = setInterval(() => {
            if (closed) {
              clearInterval(poll);
              settle();
            }
          }, 500);
        });
      },
    },

    /**
     * Stops the durable operation, whether or not anything is executing it.
     *
     * Cancellation used to be a message written on one queue row: the id
     * stored beside the job. That id names the *last* attempt, and an attempt
     * that parked its job for storage finishes successfully — so a job could
     * sit active for ever pointing at a queue row that had ended hours before,
     * with the flag set on nothing that would ever read it. So the attempt is
     * looked up by what it is for, and when there is no live one the job is
     * ended here instead of being asked to end itself.
     */
    {
      method: "POST",
      path: "/processing/jobs/:jobId/cancel",
      access: "admin",
      handle: async (context) => {
        context.requirePrincipal();
        const id = requireUuid(context.params.jobId, "jobId");
        const job = await store.get(id);
        if (!job) {
          throw new OwnApiError(
            "PROCESSING_JOB_NOT_FOUND",
            "The processing job could not be found.",
            404,
          );
        }
        /*
         * Already over. Pressing cancel again is harmless rather than an
         * error — an operator double-clicking must not be told off — but
         * nothing is written: a finished job's outcome, its finish time and
         * its published version are the record of what happened.
         */
        if (!ACTIVE_PROCESSING_STATES.includes(job.state)) {
          sendData(context.response, context.requestId, {
            job: toJobDto(job),
          });
          return;
        }

        await store.requestCancellation(id);
        const attempt = await currentAttempt(job);
        if (attempt) await queue.requestCancellation(attempt.id);

        /*
         * A worker holds the attempt, so the flag has a reader: it stops the
         * encoder where it stands, and the runner ends the job through its own
         * path — which knows what is half-written and what may be kept. That
         * cleanup belongs to the process that made the mess, and nothing here
         * may pre-empt it.
         */
        if (attempt?.status === "running") {
          await store.appendEvent({
            processingJobId: id,
            stage: job.stage,
            level: "warning",
            message: "Cancellation requested.",
          });
          sendData(context.response, context.requestId, {
            job: toJobDto((await store.get(id))!),
          });
          return;
        }

        /*
         * Nothing is executing this: either there was never a live attempt, or
         * the one there was had not been leased and the queue has just marked
         * it cancelled. No process will ever observe the flag, so the durable
         * job is ended here.
         *
         * Deliberately nothing is deleted. A published package, a staging
         * directory and a scratch workspace all outlive an attempt by design —
         * the package because it is what the title plays from, the workspace
         * because its checkpoints are hours of encoding that a later job may
         * legitimately reuse — and the paths that own them release them when
         * they can prove it is safe. A cancel that reached for a filesystem
         * would be doing it with the least information anybody has.
         */
        await clearLiveProgress(id).catch(() => undefined);
        const cancelled = await store.finalizeCancelled(id);
        if (cancelled) {
          await store.appendEvent({
            processingJobId: id,
            stage: job.stage,
            level: "warning",
            message:
              "Cancelled. No attempt was running, so the job was ended directly. Any published package is untouched.",
          });
        }
        sendData(context.response, context.requestId, {
          job: toJobDto(cancelled ?? (await store.get(id))!),
        });
      },
    },

    /**
     * Suspends an encode without losing it.
     *
     * Cancelling a two-hour 4K ladder throws away every frame it has produced.
     * Pausing stops the encoder where it stands and keeps the work, which is
     * what an operator actually wants when they need the machine back for a
     * while.
     */
    {
      method: "POST",
      path: "/processing/jobs/:jobId/pause",
      access: "admin",
      handle: async (context) => {
        context.requirePrincipal();
        const id = requireUuid(context.params.jobId, "jobId");
        const job = await store.get(id);
        if (!job) {
          throw new OwnApiError(
            "PROCESSING_JOB_NOT_FOUND",
            "The processing job could not be found.",
            404,
          );
        }
        await store.requestPause(id, "operator");
        sendData(context.response, context.requestId, {
          job: toJobDto((await store.get(id))!),
        });
      },
    },

    {
      method: "POST",
      path: "/processing/jobs/:jobId/resume",
      access: "admin",
      handle: async (context) => {
        context.requirePrincipal();
        const id = requireUuid(context.params.jobId, "jobId");
        const job = await store.get(id);
        if (!job) {
          throw new OwnApiError(
            "PROCESSING_JOB_NOT_FOUND",
            "The processing job could not be found.",
            404,
          );
        }
        /*
         * A job the storage paused cannot be resumed by hand while the volume
         * is still missing: it would wake straight into the same I/O failure
         * and be marked failed, which is exactly the outcome the auto-pause
         * exists to prevent.
         */
        if (job.pausedReason === "storage-unavailable" && !storageAvailable()) {
          throw new OwnApiError(
            "PROCESSING_STORAGE_UNAVAILABLE",
            "The media volume is not available. This job resumes on its own once the volume is back.",
            409,
          );
        }
        /*
         * A guarded volume refuses the per-job resume outright, whatever the
         * volume currently says about itself. Letting an operator resume one
         * job at a time would route straight around the quarantine — and it is
         * the natural thing to try, because the job looks fine and the drive
         * looks mounted. The way back is the storage panel, and it is two
         * deliberate presses.
         */
        if (!storageGuard.mayStartWork()) {
          throw new OwnApiError(
            "PROCESSING_STORAGE_GUARDED",
            `${storageGuard.describe()} Verify and resume the storage before resuming this job.`,
            409,
          );
        }

        /*
         * Resuming is not a state change, it is the creation of an attempt.
         *
         * What this used to be was one call that cleared the pause flag and
         * wrote `running`. Nothing was queued, so no worker ever learned the
         * job existed, and `running` was a claim about a process that had
         * exited hours earlier — a row reading running / waiting / never
         * started, which no later press could get out of, because cancelling
         * wrote to the queue row of the attempt that had already finished.
         *
         * The order below is what survives a crash in the middle. The job is
         * made eligible first and queued second: a failure between the two
         * leaves a job that is queued with nothing to run it, which the next
         * press repairs. The reverse order would leave a queued attempt for a
         * job still marked paused, and a worker would lease it and start
         * encoding work an operator had deliberately stopped.
         */
        if (job.cancellationRequested) {
          throw new OwnApiError(
            "PROCESSING_JOB_CANCELLING",
            "This job is being cancelled and cannot be resumed.",
            409,
          );
        }
        if (!ACTIVE_PROCESSING_STATES.includes(job.state)) {
          throw new OwnApiError(
            "PROCESSING_JOB_NOT_RESUMABLE",
            "This job has finished. Use retry to run it again.",
            409,
          );
        }

        /*
         * The source is settled before anything durable moves, so a source that
         * is no longer on disk refuses the press without having first un-paused
         * the job. `ensureAttempt` checks this too and throws the same error;
         * asking here as well is what lets the pause be lifted before an
         * attempt exists rather than after.
         */
        const located = await enqueuer.locateSource(
          job.itemId,
          job.mediaFileId,
        );
        if (!(await enqueuer.statSource(located.file, located.absolutePath))) {
          throw new OwnApiError(
            "SOURCE_UNAVAILABLE",
            "The source file for this title is no longer on disk.",
            409,
          );
        }

        /*
         * The pause is lifted first and the attempt queued second, which is the
         * order the block above describes.
         *
         * Queueing first leaves — for as long as the next statement takes — an
         * attempt on the queue for a job still marked paused. A worker that
         * leases it in that window must refuse it, because refusing to start
         * paused work is precisely what it is for, and the resume then finishes
         * into a job that is eligible with nothing left to run it.
         *
         * What is lifted is the *request*; the state is left exactly where it
         * is.
         *
         * This used to resume into `queued` and then, for an attempt a worker
         * still held, write `running` on the spot. That second write was a
         * claim about an operating-system process made by a web request that
         * had not touched one: on Windows the encoder was suspended by ntdll and
         * takes a round trip through a helper to wake, and for that round trip
         * the page would have said Running over a frozen process. The worker
         * writes `running` when the resume has actually been acknowledged, and
         * until then the row reads `paused` with no pause requested — which is
         * precisely "resuming", and is what the queue page renders.
         */
        await store.resume(id, undefined, "paused");
        const attempt = await enqueuer.ensureAttempt(job);
        const executing = attempt.status === "running";
        /*
         * A job nobody is holding has no encoder to wake, so there is nothing to
         * wait for and `queued` is the honest description of it. That also
         * covers the job left `running` by a worker that died: it is not
         * running, and saying so is the whole point of this route.
         */
        if (!executing) {
          await store.update(id, { state: "queued" });
        }
        await store.setCurrentAttempt(id, attempt.queueJobId);
        if (!attempt.adopted) {
          await store.appendEvent({
            processingJobId: id,
            stage: "waiting",
            message: "Resumed. Queued for a new processing attempt.",
            detail: { queueJobId: attempt.queueJobId },
          });
        }
        sendData(context.response, context.requestId, {
          job: toJobDto((await store.get(id))!),
        });
      },
    },

    {
      method: "POST",
      path: "/processing/jobs/:jobId/retry",
      access: "admin",
      handle: async (context) => {
        context.requirePrincipal();
        const id = requireUuid(context.params.jobId, "jobId");
        const job = await store.get(id);
        if (!job) {
          throw new OwnApiError(
            "PROCESSING_JOB_NOT_FOUND",
            "The processing job could not be found.",
            404,
          );
        }
        if (!storageGuard.mayStartWork()) {
          throw new OwnApiError(
            "PROCESSING_STORAGE_GUARDED",
            `${storageGuard.describe()} Verify and resume the storage before retrying this job.`,
            409,
          );
        }
        if (["queued", "running", "pending"].includes(job.state)) {
          throw new OwnApiError(
            "PROCESSING_JOB_ACTIVE",
            "This job has not finished yet.",
            409,
          );
        }
        const {
          decision,
          file,
          absolutePath,
          fingerprint,
          mtimeMs,
          existing,
          titleRoot,
        } = await analyse(job.itemId, job.mediaFileId);
        /*
         * The whole attempt is reset in one place, and the estimate is taken
         * from the decision made *now*. Resetting a handful of fields by hand
         * here is what left a retry showing the previous attempt's 89%, its
         * finish time and its far larger full-ladder estimate.
         */
        await store.beginAttempt(id, {
          estimatedOutputBytes: decision.estimate.outputBytes,
          estimatedStagingBytes: decision.estimate.stagingBytes,
          decision: {
            ...decision,
            incremental:
              existing.present &&
              decision.renditionsToEncode.length > 0 &&
              decision.renditionsToEncode.length < decision.ladder.length,
          } as unknown as Record<string, unknown>,
          streamDecisions: {
            audio: decision.streams.audio,
            subtitles: decision.streams.subtitles,
          } as unknown as Record<string, unknown>,
          hardwareAdapter: decision.hardwareAdapter,
          videoEncoder: decision.videoEncoder,
          warnings: decision.warnings,
        });
        const queueJobId = await queue.enqueue({
          jobType: PROCESSING_JOB_TYPE,
          payload: {
            processingJobId: id,
            sourcePath: absolutePath,
            relativePath: file.relativePath,
            sizeBytes: Number(file.sizeBytes),
            mtimeMs,
            /*
             * Carried here as it is on a first attempt. Without it the worker
             * falls back to the folder beside the source, which for an episode
             * is the season folder — so a retried episode would publish over
             * its neighbours. A retry must land where the original would have.
             */
            titleRoot,
          },
          priority: await store.nextQueuePriority(),
          dedupeKey: `processing:${file.id}:retry:${Date.now()}`,
        });
        await store.attachQueueJob(id, queueJobId);
        await store.appendEvent({
          processingJobId: id,
          stage: "waiting",
          message: "Re-queued after a retry.",
          detail: { sourceFingerprint: fingerprint },
        });
        sendData(
          context.response,
          context.requestId,
          { job: toJobDto((await store.get(id))!) },
          202,
        );
      },
    },
  ];
}
