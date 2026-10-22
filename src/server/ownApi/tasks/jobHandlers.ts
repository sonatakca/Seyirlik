import type { JobHandler } from "./worker";
import { DeferredJobError, PermanentJobError } from "./worker";
import type { JobQueue } from "./jobQueue";
import type { LibraryRepository } from "../libraries/libraryRepository";
import type { CatalogueScanStore } from "../scanner/reconciler";
import { reconcileLibraryScan } from "../scanner/reconciler";
import { scanLibraryTree, type ScanResult } from "../scanner/libraryScan";
import type { ScannerFileSystem } from "../scanner/libraryScan";
import {
  applyOrganizationPlan,
  planLibraryOrganization,
  type OrganizeMove,
  type OrganizerFileSystem,
} from "../scanner/organizeLibrary";
import {
  planLibraryRename,
  type RenameCandidate,
} from "../scanner/renameLibrary";
import { movesFiles, type OrganizeMode } from "../scanner/organizeConfig";
import type { createProbeService } from "../probe/probeService";
import type { MetadataService } from "../metadata/metadataService";
import {
  isTrickplayCandidate,
  TrickplayUnsupportedError,
  type TrickplayFrameProgress,
  type TrickplayService,
} from "../trickplay/trickplayService";
import type { StorageGuard } from "../processing/storageGuard";
import type { SegmentService } from "../segments/segmentService";
import type { NfoService } from "../nfo/nfoService";
import type { CatalogueRepository } from "../catalogue/catalogueRepository";
import type {
  MaintenanceCounters,
  MaintenanceFailureReason,
  MaintenancePhase,
  MaintenanceProgressInput,
} from "../../../lib/maintenance/maintenanceTasks";
import {
  createFailureLog,
  failureReasonFromMessage,
  subjectFromTitle,
} from "./maintenanceReporting";

export const JOB_TYPES = {
  libraryScan: "library.scan",
  libraryOrganize: "library.organize",
  libraryRename: "library.rename",
  libraryMaintenance: "library.maintenance",
  mediaProbe: "media.probe",
  metadataScan: "metadata.scan",
  metadataRefresh: "metadata.refresh",
  trickplayGenerate: "trickplay.generate",
  trickplayScan: "trickplay.scan",
  mediaProcess: "media.process",
  segmentsScan: "segments.scan",
  segmentsDetect: "segments.detect",
  catalogueEnrich: "catalogue.enrich",
} as const;

/**
 * Job types that read and reconcile, and job types that hold the encoder.
 *
 * The worker runs these as separate lanes so a scan never queues behind hours
 * of encoding. Kept here, beside the names themselves, so a new type cannot be
 * added without a decision about which resource it competes for.
 */
export const MEDIA_LANE_JOB_TYPES: string[] = [JOB_TYPES.mediaProcess];

/**
 * Sheet generation, which holds a decoder and a source volume for minutes.
 *
 * It used to be nothing in particular, so it fell through to the library lane
 * and ran three at a time — a lane sized for reading directories and asking
 * TMDB questions. Sampling a title is neither: it decodes every frame of the
 * source to keep one in two hundred and forty, and three of those at once on
 * one volume were measured delivering 1.6x, 1.0x and 0.6x realtime against the
 * 11-16x a single pass reaches alone. Three jobs returned a fifth of what one
 * returns; the volume itself fell from 40 MB/s to 4.85 MB/s for anything else
 * trying to read it.
 *
 * So it gets a lane of its own, one at a time. Its own rather than the media
 * lane's because trickplay must not queue behind hours of encoding, which is
 * the same reason lanes exist at all.
 */
export const TRICKPLAY_LANE_JOB_TYPES: string[] = [
  JOB_TYPES.trickplayGenerate,
  /*
   * Listening for intros decodes the opening and closing minutes of every
   * episode in a season from the same volume, so it queues behind sheets, one
   * at a time, for the reason above.
   */
  JOB_TYPES.segmentsDetect,
];

/** How many titles one bulk trickplay pass enqueues before yielding. */
const TRICKPLAY_ENQUEUE_LIMIT = 500;

/**
 * How long a stage waits before looking again at the work it depends on.
 *
 * A re-queue with `run_after` rather than a timer: the pass ends, the row is
 * durable, and a restart in between resumes it. Nothing is held in memory and
 * no worker slot is occupied while it waits.
 */
const STAGE_RECHECK_MS = 30_000;
/** A bounded number of re-checks, so a stuck prerequisite cannot loop forever. */
const MAX_STAGE_PASSES = 240;

/**
 * How long a title waits before asking again whether its volume is back.
 *
 * Longer than a stage recheck on purpose. Nothing is lost by waiting — the row
 * is durable, the attempt is intact, and the guard is watching the volume
 * anyway — while a queue of several hundred titles asking every thirty seconds
 * is several hundred pointless claims a minute.
 */
const STORAGE_RECHECK_MS = 120_000;

export interface JobHandlerOptions {
  libraries: LibraryRepository;
  scanStore: CatalogueScanStore;
  fileSystem: ScannerFileSystem;
  probeService: ReturnType<typeof createProbeService>;
  queue: JobQueue;
  /** Absent when no TMDB key is configured; metadata jobs then no-op. */
  metadataService?: MetadataService;
  trickplayService?: TrickplayService;
  /** Finds intros and credits; absent, the segment jobs fail cleanly. */
  segmentService?: SegmentService;
  /**
   * The one thing that knows whether the media volume may be worked on.
   *
   * Optional so a test or a deployment without storage supervision keeps the
   * behaviour it had. Where it is supplied, sheet generation asks it before
   * touching the volume, for the reason recorded in `trickplayGenerate`.
   */
  storageGuard?: Pick<StorageGuard, "mayStartWork" | "describe">;
  /**
   * Catalogue facts the bulk maintenance passes read: which titles are
   * playable, probed and named. Absent only in tests that exercise no
   * maintenance job.
   */
  catalogue?: Pick<
    CatalogueRepository,
    "listProcessableTitles" | "listEnrichableTitles"
  >;
  /** Writes NFO metadata as the final, observable stage of a library scan. */
  nfoService?: NfoService;
  /**
   * Whether a scan deletes titles that stayed missing past the grace period.
   * Defaults to true; see `ReconcileOptions.deleteMissing` for the host that
   * turns it off.
   */
  deleteMissing?: boolean;
  /**
   * Tidies the media folders before they are read. Absent, or in `off` mode,
   * a scan never writes to the media volume.
   */
  organizer?: {
    mode: OrganizeMode;
    fileSystem: OrganizerFileSystem;
    /**
     * Moves the catalogue's file rows with the files.
     *
     * Without it a moved source reads as one file gone and another arrived:
     * the row's identity — and with it the technical probe, the streams and
     * every processing job that points at it — would be replaced for a file
     * whose bytes never changed.
     */
    recordMoves?(moves: OrganizeMove[]): Promise<number>;
  };
  /**
   * Runs a media-processing job. Absent when the runtime has no rendition
   * paths configured, in which case queued processing jobs fail cleanly rather
   * than being silently dropped.
   */
  processingRunner?: {
    run(input: {
      processingJobId: string;
      sourcePath: string;
      relativePath: string;
      sizeBytes: number;
      mtimeMs: number;
      signal?: AbortSignal;
      isCancelled?: () => Promise<boolean>;
    }): Promise<{
      status: "succeeded" | "failed" | "cancelled" | "waiting-for-storage";
      errorMessage?: string;
      /** A failure the queue should try again, such as a held rendition lock. */
      retryable?: boolean;
    }>;
  };
}

/**
 * Merges the scans of a library's roots into one snapshot before reconciling.
 *
 * Reconciling per root would make every root look like a mass disappearance to
 * the others, since each pass only sees part of the library.
 */
function mergeScans(results: ScanResult[]): ScanResult {
  const merged: ScanResult = { items: [], skipped: [] };
  const seenSourceKeys = new Set<string>();

  for (const result of results) {
    for (const item of result.items) {
      if (seenSourceKeys.has(item.sourceKey)) continue;
      seenSourceKeys.add(item.sourceKey);
      merged.items.push(item);
    }
    merged.skipped.push(...result.skipped);
  }
  return merged;
}

type ProgressReporter = (
  fraction: number,
  message?: string,
  detail?: MaintenanceProgressInput,
) => Promise<void>;

/**
 * The phase sequence of one operation, so a report can say "3 of 5".
 *
 * Built at the start of the job from what that run will actually do — a scan
 * on a server with no metadata provider genuinely has one phase fewer — rather
 * than from a constant that would describe some other installation. Nothing
 * here turns the index into a percentage: the phases are not the same size and
 * this does not know their relative cost.
 */
function phasePlan(phases: readonly MaintenancePhase[]) {
  return {
    count: phases.length,
    at(phase: MaintenancePhase): { phaseIndex: number; phaseCount: number } {
      const index = phases.indexOf(phase);
      return {
        phaseIndex: index < 0 ? 0 : index,
        phaseCount: phases.length,
      };
    },
  };
}

async function runProbeBatches(
  probeService: ReturnType<typeof createProbeService>,
  isCancelled: () => Promise<boolean>,
  reportProgress: ProgressReporter,
  libraryId?: string,
  phase?: { phaseIndex: number; phaseCount: number },
): Promise<{ probed: number; failed: number }> {
  let probed = 0;
  let failed = 0;

  for (;;) {
    if (await isCancelled()) break;

    const batch = await probeService.runBatch(libraryId);
    probed += batch.probed;
    failed += batch.failed;

    /*
     * A real denominator, and a moving one. `remaining` is a count of rows
     * that are pending right now, so the total is true at the moment it is
     * read and can grow if a scan discovers more files while this runs — which
     * is what `provisionalTotal` says out loud rather than letting the bar
     * appear to go backwards for no stated reason.
     */
    const total = probed + failed + batch.remaining;
    await reportProgress(
      total === 0 ? 1 : (probed + failed) / total,
      `Analysed ${probed + failed} of ${total} files`,
      {
        phase: "analysing",
        ...(phase ?? {}),
        measure: {
          kind: "exact",
          completed: probed + failed,
          total,
          unit: "files",
          provisionalTotal: true,
        },
        counters: { probed, probeFailed: failed },
      },
    );

    if (batch.remaining === 0) break;
    if (batch.probed === 0 && batch.failed === 0) break;
  }

  return { probed, failed };
}

async function runMetadataBatches(
  metadataService: MetadataService,
  isCancelled: () => Promise<boolean>,
  reportProgress: ProgressReporter,
  libraryId?: string,
  phase?: { phaseIndex: number; phaseCount: number },
): Promise<{ matched: number; ambiguous: number; notFound: number }> {
  let matched = 0;
  let ambiguous = 0;
  let notFound = 0;

  // Bounded batches keep the provider's rate limit in view and let a
  // cancellation take effect between them. The seen set is a termination
  // guard: if a batch returns only items already visited, no progress is
  // being made and the loop must stop rather than spin.
  const seen = new Set<string>();

  for (;;) {
    if (await isCancelled()) break;

    const results = await metadataService.processPending(10, libraryId);
    if (results.length === 0) break;
    if (results.every((result) => seen.has(result.itemId))) break;

    for (const result of results) {
      seen.add(result.itemId);
      if (result.status === "matched") matched += 1;
      else if (result.status === "ambiguous") ambiguous += 1;
      else if (result.status === "not-found") notFound += 1;
    }

    /*
     * A count and no denominator, because there is none to have. The provider
     * pass takes whatever is pending in batches of ten and stops when a batch
     * comes back empty; nothing anywhere knows how many that will be before it
     * has finished, so this reports the titles it has actually identified and
     * leaves the fraction alone.
     */
    await reportProgress(
      0.5,
      `Identified ${matched} titles, ${ambiguous} need review`,
      {
        phase: "identifying",
        ...(phase ?? {}),
        measure: {
          kind: "counter",
          counted: matched + ambiguous + notFound,
          unit: "titles",
        },
        counters: { matched, ambiguous, notFound },
      },
    );
  }

  await reportProgress(1, `Identified ${matched} titles`, {
    phase: "identifying",
    ...(phase ?? {}),
    measure: {
      kind: "counter",
      counted: matched + ambiguous + notFound,
      unit: "titles",
    },
    counters: { matched, ambiguous, notFound },
  });
  return { matched, ambiguous, notFound };
}

export function createJobHandlers({
  libraries,
  scanStore,
  fileSystem,
  probeService,
  queue,
  metadataService,
  trickplayService,
  segmentService,
  storageGuard,
  processingRunner,
  nfoService,
  organizer,
  catalogue,
  deleteMissing = true,
}: JobHandlerOptions): Record<string, JobHandler> {
  /**
   * Live processing work, meaning queued as much as running.
   *
   * A running encode re-opens its source at the start of every epoch, so the
   * file cannot be moved out from under it even between FFmpeg invocations. A
   * *queued* attempt is the subtler one: its queue row froze an absolute
   * `sourcePath` at the moment it was queued, and nothing re-reads it, so a
   * move would leave twenty rows pointing at files that are no longer there.
   * (A paused or storage-held job is not live — resuming it rebuilds the
   * payload from the catalogue, which by then names the new path.)
   *
   * Only the operations that *write* to the volume consult this. A pure scan
   * reads directories and reconciles rows; it has never had a reason to wait
   * for an encoder, and since organisation moved out of the scan handler it no
   * longer does.
   */
  const hasLiveProcessingWork = async (): Promise<boolean> => {
    for (const status of ["running", "queued"] as const) {
      const live = await queue.list({
        jobType: JOB_TYPES.mediaProcess,
        status,
        limit: 1,
      });
      if (live.length > 0) return true;
    }
    return false;
  };

  const requireLibrary = async (payload: Record<string, unknown>) => {
    const libraryId = payload.libraryId;
    if (typeof libraryId !== "string") {
      throw new PermanentJobError("The task payload is missing a library.");
    }
    const library = await libraries.getById(libraryId);
    if (!library) {
      throw new PermanentJobError("The library no longer exists.");
    }
    return library;
  };

  /**
   * Carries out a plan of moves, or reports what it would have done.
   *
   * Shared by the folder organiser and the renamer because the two differ only
   * in what they plan: the write path — the configuration gate, the
   * processing check taken again immediately before the first mutation, the
   * atomic no-overwrite executor and the catalogue rows following their files
   * — must be one piece of code, or one of the two buttons would end up with a
   * weaker set of guarantees than the other.
   */
  const applyPlannedMoves = async (plan: {
    moves: OrganizeMove[];
    directories: string[];
  }): Promise<{
    moved: number;
    failed: number;
    /**
     * Why each move that failed did, as a code.
     *
     * The executor's own record of a failure is a path and the platform's
     * message about it, and neither may leave the process. What survives is
     * the classification, which is the part an operator can act on.
     */
    failureReasons: MaintenanceFailureReason[];
    deferred?: "processing-active";
  }> => {
    if (!organizer || !movesFiles(organizer.mode) || plan.moves.length === 0) {
      return { moved: 0, failed: 0, failureReasons: [] };
    }

    /*
     * Asked again, immediately before the first rename. Planning walks a whole
     * library, which takes long enough for someone to press Process in the
     * admin page while it runs.
     */
    if (await hasLiveProcessingWork()) {
      return {
        moved: 0,
        failed: 0,
        failureReasons: [],
        deferred: "processing-active",
      };
    }

    const applied = await applyOrganizationPlan(organizer.fileSystem, plan);
    if (applied.moved.length > 0) await organizer.recordMoves?.(applied.moved);
    return {
      moved: applied.moved.length,
      failed: applied.failed.length,
      failureReasons: applied.failed.map((entry) =>
        failureReasonFromMessage(entry.error),
      ),
    };
  };

  /** The shape both destructive maintenance jobs report themselves in. */
  const organizeOutcome = (
    mode: OrganizeMode,
    deferred?: "processing-active",
  ) =>
    deferred
      ? { deferred }
      : mode === "plan"
        ? { planOnly: true }
        : { applied: true };

  /**
   * Moving a library's files into the established folder layout.
   *
   * Split out of `library.scan` deliberately. It has always had to stand down
   * while an encode owns the paths it would move, and while it lived inside
   * the scan that wait belonged to the scan too — so a library could not be
   * re-read at all until the encoder was finished with an unrelated title.
   * Reading is not destructive and never needed the guard.
   */
  const libraryOrganize: JobHandler = async ({ job, reportProgress }) => {
    const library = await requireLibrary(job.payload);
    if (!organizer || organizer.mode === "off") {
      return { mode: "off", disabled: true };
    }

    if (movesFiles(organizer.mode) && (await hasLiveProcessingWork())) {
      return {
        mode: organizer.mode,
        ...organizeOutcome(organizer.mode, "processing-active"),
      };
    }

    let planned = 0;
    let movesSkipped = 0;
    let moved = 0;
    let movesFailed = 0;
    let deferred: "processing-active" | undefined;
    const failures = createFailureLog();
    const phases = phasePlan(["planning", "moving"]);
    const counters = (): MaintenanceCounters => ({
      planned,
      moved,
      movesSkipped,
      movesFailed,
    });

    for (const [index, root] of library.roots.entries()) {
      /*
       * Exact, over the thing that is actually countable: the roots. What is
       * inside one is a directory walk of unknown size, so the report says
       * which root it is on and how many there are, and claims nothing about
       * how far into it the walk has got.
       */
      await reportProgress(
        index / Math.max(1, library.roots.length),
        "Organising the library folders",
        {
          phase: "planning",
          ...phases.at("planning"),
          measure: {
            kind: "exact",
            completed: index,
            total: library.roots.length,
            unit: "roots",
          },
          counters: counters(),
        },
      );
      const plan = await planLibraryOrganization({
        fileSystem: organizer.fileSystem,
        rootPath: root,
        kind: library.kind,
      });
      planned += plan.moves.length;
      movesSkipped += plan.skipped.length;

      await reportProgress(
        index / Math.max(1, library.roots.length),
        "Organising the library folders",
        {
          phase: "moving",
          ...phases.at("moving"),
          measure: {
            kind: "exact",
            completed: moved,
            total: planned,
            unit: "moves",
            // More roots may still be planned, so the denominator can grow.
            provisionalTotal: index + 1 < library.roots.length,
          },
          counters: counters(),
        },
      );

      const applied = await applyPlannedMoves(plan);
      moved += applied.moved;
      movesFailed += applied.failed;
      for (const reason of applied.failureReasons)
        failures.add("moving", reason);
      if (applied.deferred) {
        deferred = applied.deferred;
        break;
      }
    }

    await reportProgress(1, "Organising the library folders", {
      phase: "moving",
      ...phases.at("moving"),
      measure: {
        kind: "exact",
        completed: moved,
        total: planned,
        unit: "moves",
      },
      counters: counters(),
    });
    /*
     * Counts only. The paths themselves are exactly the private detail a task
     * card must not carry, and the operator-facing list of moves is what
     * `npm run media:organize:plan` is for.
     */
    return {
      mode: organizer.mode,
      planned,
      moved,
      movesSkipped,
      movesFailed,
      ...failures.toResult(),
      ...organizeOutcome(organizer.mode, deferred),
    };
  };

  /**
   * Giving a library's sources their canonical filenames.
   *
   * Distinct from organising on purpose: this changes basenames and never a
   * parent directory. It runs on catalogue facts rather than on a re-parse of
   * the name it is replacing, and skips anything it cannot derive a name for
   * without guessing — see `renameLibrary.ts` for what "cannot" means.
   */
  const libraryRename: JobHandler = async ({ job, reportProgress }) => {
    const library = await requireLibrary(job.payload);
    if (!organizer || organizer.mode === "off") {
      return { mode: "off", disabled: true };
    }
    if (!catalogue) {
      throw new PermanentJobError("Renaming is not available.");
    }

    if (movesFiles(organizer.mode) && (await hasLiveProcessingWork())) {
      return {
        mode: organizer.mode,
        ...organizeOutcome(organizer.mode, "processing-active"),
      };
    }

    const phases = phasePlan(["catalogue", "planning", "naming"]);
    await reportProgress(0.05, "Naming the library files", {
      phase: "catalogue",
      ...phases.at("catalogue"),
      // Two reads of the catalogue, issued together. Neither reports its own
      // position, so neither does this.
      measure: { kind: "indeterminate" },
    });
    const [titles, items] = await Promise.all([
      catalogue.listProcessableTitles({ libraryId: library.id }),
      scanStore.listItems(library.id),
    ]);
    const sourceKeys = new Map(items.map((item) => [item.id, item.sourceKey]));

    const candidates: RenameCandidate[] = [];
    for (const title of titles) {
      const sourceKey = sourceKeys.get(title.itemId);
      if (!sourceKey || title.relativePath === null) continue;
      // A file the volume no longer holds is not a file to rename.
      if (title.fileMissingSince !== null || title.itemMissingSince !== null) {
        continue;
      }
      candidates.push({
        itemId: title.itemId,
        sourceKey,
        kind: title.kind,
        title: title.title,
        seriesTitle: title.seriesTitle,
        seasonNumber: title.seasonNumber,
        indexNumber: title.indexNumber,
        relativePath: title.relativePath,
        fileCount: title.fileCount,
      });
    }

    await reportProgress(0.4, "Naming the library files", {
      phase: "planning",
      ...phases.at("planning"),
      /*
       * The candidate list is known, so this one is exact: the planner is
       * asked about every title that has a file, and how many that is has just
       * been counted.
       */
      measure: {
        kind: "exact",
        completed: 0,
        total: candidates.length,
        unit: "titles",
      },
    });
    const plan = await planLibraryRename({
      fileSystem: organizer.fileSystem,
      candidates,
    });
    await reportProgress(0.5, "Naming the library files", {
      phase: "naming",
      ...phases.at("naming"),
      measure: {
        kind: "exact",
        completed: 0,
        total: plan.moves.length,
        unit: "renames",
      },
      counters: {
        planned: plan.moves.length,
        renamesSkipped: plan.skipped.length,
      },
    });

    const applied = await applyPlannedMoves(plan);
    const failures = createFailureLog();
    for (const reason of applied.failureReasons) failures.add("naming", reason);
    await reportProgress(1, "Naming the library files", {
      phase: "naming",
      ...phases.at("naming"),
      measure: {
        kind: "exact",
        completed: applied.moved,
        total: plan.moves.length,
        unit: "renames",
      },
      counters: {
        planned: plan.moves.length,
        renamed: applied.moved,
        renamesSkipped: plan.skipped.length,
        renamesFailed: applied.failed,
      },
    });
    return {
      mode: organizer.mode,
      planned: plan.moves.length,
      renamed: applied.moved,
      renamesSkipped: plan.skipped.length,
      renamesFailed: applied.failed,
      ...failures.toResult(),
      ...organizeOutcome(organizer.mode, applied.deferred),
    };
  };

  /**
   * One bulk pass over the titles that should have trickplay.
   *
   * The pass enqueues a durable `trickplay.generate` per eligible title rather
   * than generating anything itself, so cancellation, retry and per-title
   * failure all stay where the queue already handles them.
   *
   * Eligibility is deliberately narrow: a playable movie or episode whose
   * canonical file exists, has been probed, and has no sheets yet. Books,
   * series and season containers, collections and trailers are not playable
   * primary titles and are never enqueued.
   *
   * A title the probe has not reached yet is not skipped — it is the reason
   * the pass re-queues itself. Observing a library seconds after a scan and
   * declaring the unprobed half ineligible is precisely the silent miss this
   * has to avoid.
   */
  const trickplayScan: JobHandler = async ({ job, reportProgress }) => {
    if (!trickplayService) {
      throw new PermanentJobError("Trickplay generation is not available.");
    }
    if (!catalogue) {
      throw new PermanentJobError("Trickplay generation is not available.");
    }
    const libraryId =
      typeof job.payload.libraryId === "string"
        ? job.payload.libraryId
        : undefined;
    const pass =
      typeof job.payload.pass === "number" &&
      Number.isSafeInteger(job.payload.pass)
        ? job.payload.pass
        : 0;

    const phases = phasePlan(["selecting", "enqueueing"]);
    await reportProgress(0, "Scanning for missing trickplay", {
      phase: "selecting",
      ...phases.at("selecting"),
      // One catalogue query; it does not report a position and neither does
      // this.
      measure: { kind: "indeterminate" },
    });
    const titles = await catalogue.listProcessableTitles({
      ...(libraryId ? { libraryId } : {}),
    });

    const ready = titles.filter(isTrickplayCandidate);
    // Awaiting the probe rather than ineligible: counted so the pass knows
    // whether it still has a reason to come back. A packaged title is never
    // probed, so waiting for one would keep the pass returning for nothing.
    const awaitingProbe = titles.filter(
      (title) =>
        title.mediaFileId !== null &&
        title.fileMissingSince === null &&
        title.itemMissingSince === null &&
        title.probeState !== "probed" &&
        title.probeState !== "packaged",
    ).length;

    const generated = await trickplayService.listGeneratedMediaFileIds(
      ready.map((title) => title.mediaFileId as string),
    );
    const missing = ready.filter(
      (title) => !generated.has(title.mediaFileId as string),
    );

    let queued = 0;
    const batch = missing.slice(0, TRICKPLAY_ENQUEUE_LIMIT);
    for (const title of batch) {
      await queue.enqueue({
        jobType: JOB_TYPES.trickplayGenerate,
        payload: { itemId: title.itemId },
        // Per title, so overlapping passes and a hand-pressed regenerate
        // collapse onto one attempt instead of decoding the file twice.
        dedupeKey: `${JOB_TYPES.trickplayGenerate}:${title.itemId}`,
        priority: 400,
      });
      queued += 1;
      /*
       * Exact, and settled: the batch was chosen before the loop began, so
       * this denominator is how many child jobs this pass will create — not a
       * guess at how much trickplay the library still needs, which is the
       * separate `trickplayPending` count below.
       */
      await reportProgress(
        queued / Math.max(1, batch.length),
        "Scanning for missing trickplay",
        {
          phase: "enqueueing",
          ...phases.at("enqueueing"),
          measure: {
            kind: "exact",
            completed: queued,
            total: batch.length,
            unit: "titles",
          },
          counters: { trickplayQueued: queued },
          current: subjectFromTitle(title.title),
        },
      );
    }

    const remaining = Math.max(0, missing.length - queued);
    const pending = awaitingProbe + remaining;
    if (pending > 0 && pass < MAX_STAGE_PASSES) {
      await queue.enqueue({
        jobType: JOB_TYPES.trickplayScan,
        payload: { ...(libraryId ? { libraryId } : {}), pass: pass + 1 },
        // The pass number is part of the key so this successor does not
        // collapse onto the row that is creating it, which is still running.
        dedupeKey: `${JOB_TYPES.trickplayScan}:${libraryId ?? "all"}:${pass + 1}`,
        runAfter: new Date(Date.now() + STAGE_RECHECK_MS),
        priority: 450,
      });
    }

    return {
      trickplayQueued: queued,
      trickplayPending: pending,
      ...(pending > 0 && pass >= MAX_STAGE_PASSES ? { incomplete: true } : {}),
    };
  };

  /**
   * One sweep for intros and credits: every season and film not yet looked at
   * by this version of the detector.
   *
   * Films are settled here and now — a film has no episode to compare its
   * audio with, so its only source is its own chapter names, which is a
   * database read. Seasons each get a durable `segments.detect`, which is
   * where audio is actually decoded.
   */
  const segmentsScan: JobHandler = async ({ reportProgress, isCancelled }) => {
    if (!segmentService) {
      throw new PermanentJobError("Intro detection is not available.");
    }
    const phases = phasePlan(["selecting", "enqueueing"]);
    await reportProgress(0, "Looking for intros and credits", {
      phase: "selecting",
      ...phases.at("selecting"),
      measure: { kind: "indeterminate" },
    });
    const subjects = await segmentService.listPendingSubjects();

    let seasonsQueued = 0;
    let filmsChecked = 0;
    for (const [index, subject] of subjects.entries()) {
      if (await isCancelled()) return { cancelled: true };
      if (subject.kind === "movie") {
        await segmentService.detectMovie(subject.subjectId);
        filmsChecked += 1;
      } else {
        await queue.enqueue({
          jobType: JOB_TYPES.segmentsDetect,
          payload: { seasonId: subject.subjectId },
          dedupeKey: `${JOB_TYPES.segmentsDetect}:${subject.subjectId}`,
          priority: 460,
        });
        seasonsQueued += 1;
      }
      await reportProgress(
        (index + 1) / Math.max(1, subjects.length),
        "Looking for intros and credits",
        {
          phase: "enqueueing",
          ...phases.at("enqueueing"),
          measure: {
            kind: "exact",
            completed: index + 1,
            total: subjects.length,
            unit: "titles",
          },
          counters: { segmentsQueued: seasonsQueued },
          current: subjectFromTitle(subject.title),
        },
      );
    }
    return { segmentsQueued: seasonsQueued, filmsChecked };
  };

  /**
   * Records every matched title's age rating and every matched film's box
   * set: the back-fill for a library matched before either was read. One
   * provider request per title, which is why it is a button and not part of
   * every scan.
   */
  const catalogueEnrich: JobHandler = async ({
    reportProgress,
    isCancelled,
  }) => {
    if (!metadataService || !catalogue) {
      throw new PermanentJobError("Metadata is not available.");
    }
    const titles = await catalogue.listEnrichableTitles();
    let rated = 0;
    let inCollections = 0;
    for (const [index, title] of titles.entries()) {
      if (await isCancelled()) return { cancelled: true };
      const outcome = await metadataService.enrich(title.itemId);
      if (outcome?.rated) rated += 1;
      if (outcome?.inCollection) inCollections += 1;
      await reportProgress(
        (index + 1) / Math.max(1, titles.length),
        "Fetching ratings and collections",
        {
          phase: "identifying",
          measure: {
            kind: "exact",
            completed: index + 1,
            total: titles.length,
            unit: "titles",
          },
          current: subjectFromTitle(title.title),
        },
      );
    }
    return { titlesChecked: titles.length, rated, inCollections };
  };

  /** Listens to one season and records its intros and credits. */
  const segmentsDetect: JobHandler = async ({
    job,
    reportProgress,
    isCancelled,
  }) => {
    if (!segmentService) {
      throw new PermanentJobError("Intro detection is not available.");
    }
    // Asked before any audio is read, for the reason given in trickplayGenerate.
    if (storageGuard && !storageGuard.mayStartWork()) {
      throw new DeferredJobError(storageGuard.describe(), STORAGE_RECHECK_MS);
    }
    const seasonId = job.payload.seasonId;
    if (typeof seasonId !== "string") {
      throw new PermanentJobError("The task payload is missing a season.");
    }
    await reportProgress(0, "Detecting intros and credits", {
      phase: "analysing",
      measure: { kind: "indeterminate" },
    });
    let lastReport: Promise<void> = Promise.resolve();
    const result = await segmentService.detectSeason(seasonId, {
      isCancelled,
      onEpisode: (completed, total, title) => {
        lastReport = reportProgress(
          completed / Math.max(1, total),
          "Detecting intros and credits",
          {
            phase: "analysing",
            measure: { kind: "exact", completed, total, unit: "titles" },
            ...(title ? { current: subjectFromTitle(title) } : {}),
          },
        ).catch(() => undefined);
      },
    });
    await lastReport;
    return {
      episodes: result.episodes,
      introsFound: result.intros,
      creditsFound: result.credits,
      chapterSegments: result.fromChapters,
      unreadable: result.unreadable,
    };
  };

  /**
   * "All in one": the whole maintenance workflow, in the only order that is
   * safe.
   *
   * Scan first, because renaming and moving are decided from catalogue facts
   * and must not race a walk of the same paths. Then the destructive folder
   * work. Then trickplay, which needs a probed primary file that only the scan
   * can have discovered.
   *
   * Each stage enqueues its own work and then re-queues *this* job to look
   * again — a durable row with a `run_after`, not a timer and not a promise
   * held in memory. A restart between two passes resumes exactly where it was,
   * and every enqueue below carries a dedupe key, so a pass that runs twice
   * schedules nothing twice.
   */
  const libraryMaintenance: JobHandler = async ({ job, reportProgress }) => {
    const STAGES = ["scan", "organize", "trickplay"] as const;
    type Stage = (typeof STAGES)[number];
    const stage: Stage = STAGES.includes(job.payload.stage as Stage)
      ? (job.payload.stage as Stage)
      : "scan";
    const pass =
      typeof job.payload.pass === "number" &&
      Number.isSafeInteger(job.payload.pass)
        ? job.payload.pass
        : 0;

    const stageJobTypes: Record<Stage, string[]> = {
      scan: [JOB_TYPES.libraryScan],
      organize: [JOB_TYPES.libraryRename, JOB_TYPES.libraryOrganize],
      trickplay: [JOB_TYPES.trickplayScan],
    };
    /*
     * The identity of the whole run, carried from pass to pass.
     *
     * "All in one" is not one row: it is a chain of short bookkeeping passes,
     * each of which enqueues work and then re-queues itself to look again. Only
     * this field ties them together, and without it the history would show
     * forty separate successes with no way to tell which run any of them
     * belonged to. Passes that predate the field, and the very first pass of a
     * run, fall back to their own id — which is stable for that pass and never
     * collides with another run's.
     */
    const runId =
      typeof job.payload.runId === "string" && job.payload.runId.length > 0
        ? job.payload.runId
        : job.id;
    const stagePhase: Record<Stage, MaintenancePhase> = {
      scan: "reading",
      organize: "moving",
      trickplay: "trickplay",
    };

    const all = await libraries.listAll();
    await reportProgress(
      (STAGES.indexOf(stage) + 0.5) / STAGES.length,
      "Running library maintenance",
      {
        phase: pass === 0 ? "enqueueing" : stagePhase[stage],
        phaseIndex: STAGES.indexOf(stage),
        phaseCount: STAGES.length,
        // What this pass is doing is scheduling and then watching. Neither has
        // a fraction; the count of jobs it is still waiting on is reported
        // below, once the queue has been asked.
        measure: { kind: "indeterminate" },
      },
    );

    if (pass === 0) {
      // Every configured library, whatever its kind: `collections` and
      // `mixed` are libraries too and "all in one" means all of them.
      for (const library of all) {
        if (stage === "scan") {
          await queue.enqueue({
            jobType: JOB_TYPES.libraryScan,
            payload: { libraryId: library.id },
            dedupeKey: `${JOB_TYPES.libraryScan}:${library.id}`,
          });
          continue;
        }
        if (stage === "organize") {
          /*
           * Rename before organise, and both per library. A rename changes a
           * basename inside the folder the file is already in; organising then
           * moves that file, under its settled name, into the layout. The
           * reverse order would move a file and then rename it, which reaches
           * the same place by way of an extra mutation.
           */
          await queue.enqueue({
            jobType: JOB_TYPES.libraryRename,
            payload: { libraryId: library.id },
            dedupeKey: `${JOB_TYPES.libraryRename}:${library.id}`,
            priority: 150,
          });
          await queue.enqueue({
            jobType: JOB_TYPES.libraryOrganize,
            payload: { libraryId: library.id },
            dedupeKey: `${JOB_TYPES.libraryOrganize}:${library.id}`,
            priority: 160,
          });
        }
      }
      if (stage === "trickplay") {
        await queue.enqueue({
          jobType: JOB_TYPES.trickplayScan,
          payload: {},
          dedupeKey: `${JOB_TYPES.trickplayScan}:all:0`,
          priority: 450,
        });
      }
    }

    /*
     * Is the stage's own work finished? Asked of the queue, which is the only
     * thing that knows, and asked again on the next pass rather than waited on.
     *
     * Counted rather than merely detected. One row was enough to decide
     * whether to move on, and it is not enough to say what the run is waiting
     * for — "waiting on 14 scans" and "waiting on 1" are the difference
     * between a run that is working and a run that is stuck.
     */
    let outstanding = 0;
    for (const jobType of stageJobTypes[stage]) {
      for (const status of ["queued", "running"] as const) {
        outstanding += (await queue.list({ jobType, status, limit: 200 }))
          .length;
      }
    }
    await reportProgress(
      (STAGES.indexOf(stage) + 0.5) / STAGES.length,
      "Running library maintenance",
      {
        phase: outstanding > 0 ? "waiting" : stagePhase[stage],
        phaseIndex: STAGES.indexOf(stage),
        phaseCount: STAGES.length,
        /*
         * A count of the jobs this stage is still waiting on, and deliberately
         * not a fraction of them. How many the stage started with is not a
         * number this pass can know: a restart, a dedupe collapse or a job
         * queued by hand all change it, and dividing by a remembered figure
         * would produce a bar that jumps.
         */
        measure:
          outstanding > 0
            ? { kind: "counter", counted: outstanding, unit: "items" }
            : { kind: "indeterminate" },
      },
    );

    const nextStage = STAGES[STAGES.indexOf(stage) + 1];
    const done = outstanding === 0 && pass > 0;
    if (done && nextStage === undefined) {
      return { stage, runId, libraries: all.length, completed: true };
    }

    const follow = done
      ? { stage: nextStage as string, pass: 0, runId }
      : { stage: stage as string, pass: pass + 1, runId };
    if (!done && pass >= MAX_STAGE_PASSES) {
      return { stage, runId, libraries: all.length, incomplete: true };
    }

    await queue.enqueue({
      jobType: JOB_TYPES.libraryMaintenance,
      payload: follow,
      dedupeKey: `${JOB_TYPES.libraryMaintenance}:${follow.stage}:${follow.pass}`,
      runAfter: new Date(Date.now() + (done ? 0 : STAGE_RECHECK_MS)),
      priority: 90,
    });
    return { stage, runId, libraries: all.length, outstanding };
  };

  /**
   * Discovery and reconciliation, and nothing else that can block on a
   * resource somebody else is holding.
   *
   * Folder organisation used to run here, first, and stood down while any
   * encode was queued or running — which meant a scan could not read a
   * library while an unrelated title was encoding. Organising is now its own
   * job, so a scan waits for nothing.
   */
  const libraryScan: JobHandler = async ({
    job,
    reportProgress,
    isCancelled,
  }) => {
    const library = await requireLibrary(job.payload);
    const libraryId = library.id;

    /*
     * What this run will actually do, decided once and reported with every
     * phase.
     *
     * A server with no NFO output stops after the catalogue; one with no
     * metadata provider skips identification. Saying "phase 2 of 5" on an
     * installation that only ever runs two of them would be a count of some
     * other machine's work.
     */
    const phases = phasePlan([
      "reading",
      "catalogue",
      ...(nfoService
        ? ([
            "analysing",
            ...(metadataService ? (["identifying"] as const) : []),
            "nfo",
          ] as const)
        : []),
    ]);

    await reportProgress(0.05, "Reading the library folders", {
      phase: "reading",
      ...phases.at("reading"),
      measure: {
        kind: "exact",
        completed: 0,
        total: library.roots.length,
        unit: "roots",
      },
    });

    const results: ScanResult[] = [];
    let discovered = 0;
    let skipped = 0;
    for (const [index, root] of library.roots.entries()) {
      if (await isCancelled()) {
        return { cancelled: true };
      }
      const result = await scanLibraryTree({
        fileSystem,
        rootPath: root,
        kind: library.kind,
      });
      results.push(result);
      discovered += result.items.length;
      skipped += result.skipped.length;
      /*
       * Roots are the only exact denominator a directory walk has, and the
       * count of what has been found so far is the only other true thing to
       * say about it. Neither is turned into "the scan is 43% done".
       */
      await reportProgress(
        0.05 + (0.55 * (index + 1)) / Math.max(1, library.roots.length),
        "Reading the library folders",
        {
          phase: "reading",
          ...phases.at("reading"),
          measure: {
            kind: "exact",
            completed: index + 1,
            total: library.roots.length,
            unit: "roots",
          },
          counters: { filesDiscovered: discovered, filesSkipped: skipped },
        },
      );
    }

    if (await isCancelled()) return { cancelled: true };

    await reportProgress(0.65, "Updating the catalogue", {
      phase: "catalogue",
      ...phases.at("catalogue"),
      /*
       * One transaction against the catalogue. It either happens or it does
       * not, and there is no position inside it to report — which is exactly
       * the case `indeterminate` exists for.
       */
      measure: { kind: "indeterminate" },
      counters: { filesDiscovered: discovered, filesSkipped: skipped },
    });
    const summary = await reconcileLibraryScan({
      store: scanStore,
      libraryId,
      scan: mergeScans(results),
      allowMassRemoval: job.payload.allowMassRemoval === true,
      deleteMissing,
    });
    const reconciled: MaintenanceCounters = {
      filesDiscovered: discovered,
      filesSkipped: skipped,
      itemsCreated: summary.itemsCreated,
      itemsUpdated: summary.itemsUpdated,
      itemsMarkedMissing: summary.itemsMarkedMissing,
      itemsDeleted: summary.itemsDeleted,
      filesCreated: summary.filesCreated,
      filesChanged: summary.filesChanged,
      filesMarkedMissing: summary.filesMarkedMissing,
      filesDeleted: summary.filesDeleted,
      probesQueued: summary.probesQueued,
    };

    // With NFO output disabled, keep the original short scan behavior: probe
    // and provider matching can run independently in the background.
    if (!nfoService) {
      if (summary.probesQueued > 0) {
        await queue.enqueue({
          jobType: JOB_TYPES.mediaProbe,
          dedupeKey: JOB_TYPES.mediaProbe,
          priority: 200,
        });
      }
      if (metadataService) {
        await queue.enqueue({
          jobType: JOB_TYPES.metadataScan,
          payload: { libraryId },
          dedupeKey: `${JOB_TYPES.metadataScan}:${libraryId}`,
          priority: 300,
        });
      }
      await reportProgress(1, "Scan complete", {
        phase: "catalogue",
        ...phases.at("catalogue"),
        measure: { kind: "indeterminate" },
        counters: reconciled,
      });
      return { ...summary, ...reconciled };
    }

    // NFO is a scan output, so every source of information it serializes must
    // finish first. In particular, queuing the probe and immediately exporting
    // produced a runtime-free NFO for every newly discovered file.
    await reportProgress(0.7, "Analysing media files", {
      phase: "analysing",
      ...phases.at("analysing"),
      measure: { kind: "indeterminate" },
      counters: reconciled,
    });
    const probe = await runProbeBatches(
      probeService,
      isCancelled,
      async (fraction, message, detail) =>
        reportProgress(0.7 + fraction * 0.1, message, {
          ...(detail ?? {
            phase: "analysing",
            measure: { kind: "indeterminate" },
          }),
          // The scan's own totals travel with every phase, so a card opened
          // during identification still says what the walk found.
          counters: { ...reconciled, ...(detail?.counters ?? {}) },
        }),
      libraryId,
      phases.at("analysing"),
    );
    if (await isCancelled()) return { ...summary, probe, cancelled: true };

    let metadata;
    if (metadataService) {
      await reportProgress(0.81, "Identifying titles", {
        phase: "identifying",
        ...phases.at("identifying"),
        measure: { kind: "counter", counted: 0, unit: "titles" },
        counters: {
          ...reconciled,
          probed: probe.probed,
          probeFailed: probe.failed,
        },
      });
      metadata = await runMetadataBatches(
        metadataService,
        isCancelled,
        async (fraction, message, detail) =>
          reportProgress(0.81 + fraction * 0.08, message, {
            ...(detail ?? {
              phase: "identifying",
              measure: { kind: "counter", counted: 0, unit: "titles" },
            }),
            counters: {
              ...reconciled,
              probed: probe.probed,
              probeFailed: probe.failed,
              ...(detail?.counters ?? {}),
            },
          }),
        libraryId,
        phases.at("identifying"),
      );
      if (await isCancelled()) {
        return { ...summary, probe, metadata, cancelled: true };
      }
    }

    const identified: MaintenanceCounters = {
      ...reconciled,
      probed: probe.probed,
      probeFailed: probe.failed,
      ...(metadata
        ? {
            matched: metadata.matched,
            ambiguous: metadata.ambiguous,
            notFound: metadata.notFound,
          }
        : {}),
    };

    let nfoExport;
    if (nfoService) {
      await reportProgress(0.9, "Writing NFO metadata", {
        phase: "nfo",
        ...phases.at("nfo"),
        measure: { kind: "indeterminate" },
        counters: identified,
      });
      nfoExport = await nfoService.exportLibrary(libraryId, {
        force: false,
        isCancelled,
        /*
         * The export counts its own titles and now hands both halves of that
         * fraction over rather than only a float and a sentence. The page used
         * to recover these two numbers by matching the sentence with a regular
         * expression, which meant the figures it displayed were a parse of a
         * label.
         */
        reportProgress: (fraction, message, counts) =>
          reportProgress(0.9 + fraction * 0.09, message, {
            phase: "nfo",
            ...phases.at("nfo"),
            measure: counts
              ? {
                  kind: "exact",
                  completed: counts.completed,
                  total: counts.total,
                  unit: "titles",
                }
              : { kind: "indeterminate" },
            counters: identified,
          }),
      });
    }

    const finalCounters: MaintenanceCounters = {
      ...identified,
      ...(nfoExport
        ? {
            nfoCreated: nfoExport.created,
            nfoUpdated: nfoExport.updated,
            nfoUnchanged: nfoExport.unchanged,
            nfoSkippedConflict: nfoExport.skippedConflict,
            nfoSkippedNotApplicable: nfoExport.skippedNotApplicable,
            nfoFailed: nfoExport.failed,
          }
        : {}),
    };
    await reportProgress(1, "Scan complete", {
      phase: "nfo",
      ...phases.at("nfo"),
      measure: { kind: "indeterminate" },
      counters: finalCounters,
    });
    return {
      ...summary,
      probe,
      ...(metadata ? { metadata } : {}),
      ...(nfoExport ? { nfoExport } : {}),
      ...finalCounters,
    };
  };

  const mediaProbe: JobHandler = async ({ reportProgress, isCancelled }) => {
    const result = await runProbeBatches(
      probeService,
      isCancelled,
      reportProgress,
    );
    return { ...result, probed: result.probed, probeFailed: result.failed };
  };

  const metadataScan: JobHandler = async ({
    job,
    reportProgress,
    isCancelled,
  }) => {
    if (!metadataService) {
      throw new PermanentJobError("No metadata provider is configured.");
    }

    const libraryId =
      typeof job.payload.libraryId === "string"
        ? job.payload.libraryId
        : undefined;

    return runMetadataBatches(
      metadataService,
      isCancelled,
      reportProgress,
      libraryId,
    );
  };

  const metadataRefresh: JobHandler = async ({ job, reportProgress }) => {
    if (!metadataService) {
      throw new PermanentJobError("No metadata provider is configured.");
    }
    const itemId = job.payload.itemId;
    if (typeof itemId !== "string") {
      throw new PermanentJobError("The task payload is missing an item.");
    }

    await reportProgress(0, "Identifying titles", {
      phase: "identifying",
      /*
       * One provider lookup for one title. It has no interior to report and no
       * denominator; a bar here would be an animation, not a measurement.
       */
      measure: { kind: "indeterminate" },
    });
    const result = await metadataService.refreshItem(itemId);
    return { ...result };
  };

  const trickplayGenerate: JobHandler = async ({ job, reportProgress }) => {
    if (!trickplayService) {
      throw new PermanentJobError("Trickplay generation is not available.");
    }
    /*
     * Asked before anything is created, spawned or written.
     *
     * An absent volume is not a property of the title, and it is not a failure
     * of this job: `mkdir` on an unmounted mount point returns `EACCES` in
     * microseconds, so treating it as one let a single unplug spend all three
     * attempts of every queued title in about a minute — 243 of them, all
     * reporting a permission problem that was really a missing disk. Deferring
     * hands the attempt back, so the queue simply waits for the volume.
     */
    if (storageGuard && !storageGuard.mayStartWork()) {
      throw new DeferredJobError(storageGuard.describe(), STORAGE_RECHECK_MS);
    }
    const itemId = job.payload.itemId;
    if (typeof itemId !== "string") {
      throw new PermanentJobError("The task payload is missing an item.");
    }

    /*
     * A forced rebuild never begins by deleting.
     *
     * It used to: the row and the directory went first, and then FFmpeg was
     * started. Every way that decode could fail — an unreadable source, a
     * cancelled job, a volume pulled mid-pass — therefore left a title with no
     * sheets at all where a working set had been standing a second earlier.
     * The service now stages the replacement beside the live set and swaps it
     * in only once it has been validated, so `force` is a flag it is told
     * about rather than damage done before it is called.
     */
    const force = job.payload.force === true;

    await reportProgress(0, "Generating trickplay", {
      phase: "trickplay",
      /*
       * Nothing is known until the decoder has reached its first sampling
       * point, which is the first thing it does. Until then the honest answer
       * is the title's name and the time it has been at it.
       */
      measure: { kind: "indeterminate" },
    });
    /*
     * The sampler announces every frame it emits — hundreds over one episode,
     * many of them within the same second on a fast decode — and each report
     * is a write to the queue row that the page reads every two seconds. So
     * the frames are counted as they come and written at a cadence somebody
     * can actually see; nothing between two writes is lost, because each one
     * carries the position rather than a delta.
     */
    const REPORT_INTERVAL_MS = 1_500;
    let lastReportedAt = 0;
    let reportInFlight: Promise<void> | null = null;
    /*
     * Set the moment the pass is over, and checked before every write.
     *
     * Concluding a job clears the structured report from its row, so a write
     * still in flight when that happens would put a phase and a fraction back
     * onto a task that had already finished — a finished row describing work
     * in progress. The last write is waited for below for the same reason.
     */
    let finished = false;
    const announceFrame = ({
      completed,
      total,
    }: TrickplayFrameProgress): void => {
      const now = Date.now();
      if (
        finished ||
        reportInFlight !== null ||
        now - lastReportedAt < REPORT_INTERVAL_MS
      )
        return;
      lastReportedAt = now;
      reportInFlight = reportProgress(
        completed / total,
        "Generating trickplay",
        {
          phase: "trickplay",
          // Both halves come from the pass itself: the frame the decoder has
          // reached, and the frame count the sheet layout was built from.
          measure: { kind: "exact", completed, total, unit: "frames" },
        },
      )
        .catch(() => undefined)
        .finally(() => {
          reportInFlight = null;
        });
    };
    let set;
    try {
      set = await trickplayService.generateForItem(itemId, {
        force,
        onProgress: announceFrame,
      });
    } catch (error) {
      /*
       * A conversion the configured FFmpeg cannot perform is not a transient
       * failure: the binary either has the filter or it does not, and three
       * attempts at it only bury the one sentence that says what to do.
       */
      if (error instanceof TrickplayUnsupportedError) {
        throw new PermanentJobError(error.message);
      }
      throw error;
    } finally {
      finished = true;
      await reportInFlight;
    }
    return set
      ? { generated: true, spriteCount: set.spriteCount }
      : { generated: false };
  };

  /**
   * Runs one media-processing job.
   *
   * The queue owns scheduling, leasing and retry; the runner owns the media
   * work and writes its own detailed record. Progress is mirrored back onto the
   * queue row so the generic task list stays meaningful, but the processing UI
   * reads the richer record directly.
   */
  const mediaProcess: JobHandler = async ({
    job,
    reportProgress,
    isCancelled,
  }) => {
    const payload = job.payload as {
      processingJobId?: unknown;
      sourcePath?: unknown;
      relativePath?: unknown;
      sizeBytes?: unknown;
      mtimeMs?: unknown;
      titleRoot?: unknown;
    };
    if (
      typeof payload.processingJobId !== "string" ||
      typeof payload.sourcePath !== "string" ||
      typeof payload.relativePath !== "string" ||
      typeof payload.sizeBytes !== "number" ||
      typeof payload.mtimeMs !== "number"
    ) {
      throw new PermanentJobError("The processing task payload is incomplete.");
    }
    /*
     * The publish destination, carried from the queue row to the runner.
     *
     * Every caller that queues a processing job works out where the title
     * publishes and writes it into the payload; this handler is the one hop
     * between that and the encoder, and while it did not read the field the
     * work was done and then thrown away. The runner then had nothing to go on
     * and fell back to the folder beside the source — for an episode, the
     * season folder its neighbours publish into.
     *
     * A payload that genuinely carries no destination is still allowed through:
     * the runner decides what an absent one means, and refuses the ones it
     * cannot make safe.
     */
    if (
      payload.titleRoot !== undefined &&
      typeof payload.titleRoot !== "string"
    ) {
      throw new PermanentJobError(
        "The processing task payload carries an unusable publish destination.",
      );
    }
    if (!processingRunner) {
      throw new PermanentJobError(
        "This server is not configured to process media.",
      );
    }

    await reportProgress(0.01, "Starting media processing").catch(
      () => undefined,
    );
    const outcome = await processingRunner.run({
      processingJobId: payload.processingJobId,
      sourcePath: payload.sourcePath,
      relativePath: payload.relativePath,
      sizeBytes: payload.sizeBytes,
      mtimeMs: payload.mtimeMs,
      ...(payload.titleRoot === undefined
        ? {}
        : { titleRoot: payload.titleRoot }),
      isCancelled,
    });
    /*
     * Cosmetic, and deliberately best-effort. This mirrors the media job's
     * progress onto the generic queue row; a database blip while writing it
     * must not turn a finished — or a deliberately stopped — encode into a
     * queue failure, because a queue failure is a requeue and a requeue sends
     * the encoder back over the same media.
     */
    await reportProgress(1, "Media processing finished").catch(() => undefined);

    if (outcome.status === "failed") {
      const message = outcome.errorMessage ?? "Processing failed.";
      /*
       * Contention is not a verdict on the job.
       *
       * A rendition lock held by another attempt says only that this one
       * arrived second, and the queue's own backoff is exactly the right
       * answer. Failing permanently instead left a title needing a person to
       * requeue it by hand — which is what happened to every encode that was
       * running when the worker was restarted, since the lock its own killed
       * process left behind refused its retry.
       *
       * Everything else is already recorded in detail on the processing job;
       * the queue row only needs to know it did not succeed.
       */
      if (outcome.retryable) throw new Error(message);
      throw new PermanentJobError(message);
    }
    /*
     * Storage disappearing ends this queue run without being a failure. The
     * processing job stays paused with its reason recorded and is requeued
     * when the volume returns, so retrying here would only burn attempts
     * against a disk that is not there.
     */
    if (outcome.status === "waiting-for-storage") {
      return { status: "waiting-for-storage" as const };
    }
    return { status: outcome.status };
  };

  return {
    [JOB_TYPES.mediaProcess]: mediaProcess,
    [JOB_TYPES.libraryScan]: libraryScan,
    [JOB_TYPES.libraryOrganize]: libraryOrganize,
    [JOB_TYPES.libraryRename]: libraryRename,
    [JOB_TYPES.libraryMaintenance]: libraryMaintenance,
    [JOB_TYPES.trickplayGenerate]: trickplayGenerate,
    [JOB_TYPES.trickplayScan]: trickplayScan,
    [JOB_TYPES.segmentsScan]: segmentsScan,
    [JOB_TYPES.segmentsDetect]: segmentsDetect,
    [JOB_TYPES.catalogueEnrich]: catalogueEnrich,
    [JOB_TYPES.mediaProbe]: mediaProbe,
    [JOB_TYPES.metadataScan]: metadataScan,
    [JOB_TYPES.metadataRefresh]: metadataRefresh,
  };
}
