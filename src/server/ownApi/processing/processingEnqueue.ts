import { stat, unlink } from "node:fs/promises";
import type { Stats } from "node:fs";
import path from "node:path";
import { OwnApiError } from "../ownApiHandler";
import { isPathInsideRoot } from "../../pathSecurity";
import { RENDITION_TARGETS } from "../../../renditions/policy";
import type {
  CatalogueRepository,
  MediaFileRow,
} from "../catalogue/catalogueRepository";
import type { JobQueue, JobStatus } from "../tasks/jobQueue";
import type { HardwareReport } from "../../../renditions/hardware/detect";
import { probeMediaFile } from "../../../renditions/probe";
import { computeSourceFingerprint } from "../../../renditions/registry";
import {
  decideProcessing,
  freeBytesOn,
  type ProcessingDecision,
} from "../../../renditions/processing/decide";
import { ADAPTIVE_PROFILE_VERSION } from "../../../renditions/adaptive/profile";
import { readTitlePackageManifest } from "../../../renditions/adaptive/publishTitle";
import {
  resolveTitleRoot,
  titleRootLayoutForKind,
} from "../../../renditions/adaptive/titleRoot";
import {
  DuplicateProcessingJobError,
  type ProcessingJobRecord,
  type ProcessingJobStore,
} from "./jobStore";
import type { StorageGuard } from "./storageGuard";
import {
  manifestIdentity,
  summarisePackage,
  type PackageDamage,
} from "./packageIndex";
import {
  describeMissingPackageAssets,
  missingPackageAssets,
} from "./packageAssets";
import { resolvePublishedTitleRoot } from "../../../renditions/adaptive/publishedRoot";
import { planRetainedSidecarSubtitles } from "../../../renditions/adaptive/processor";
import { sidecarSubtitleIsCurrent } from "../../../renditions/adaptive/sidecarSubtitles";
import { subtitleRenditionId } from "../../../renditions/adaptive/profile";

/**
 * The one way a processing job is created.
 *
 * A movie, an episode, a whole season and a whole series all end up here. That
 * is the point of it: the checks that stand between a button and an encoder —
 * the source is really there, its bytes are the bytes the plan was made
 * against, the volume is not quarantined, the ladder actually has something
 * left to build, no other job is already on this file — are the reason this
 * system has not destroyed anything, and a second copy of them written for
 * television would be a second copy that drifts.
 *
 * A bulk action is therefore not a different code path. It is this one, run
 * once per episode, with the outcomes counted.
 */

export const PROCESSING_JOB_TYPE = "media.process";

export interface ProcessingEnqueueOptions {
  catalogue: CatalogueRepository;
  store: ProcessingJobStore;
  queue: JobQueue;
  mediaRoot: string;
  workRoot: string;
  ffprobePath: string;
  hardware: () => Promise<HardwareReport>;
  storageGuard: StorageGuard;
  /**
   * Encodes run on another machine (this host's worker is `light`).
   *
   * Free space on this host's scratch then says nothing about the job, so it is
   * not measured: the estimate is left unknown rather than refused on the
   * wrong disk. The worker that claims the job checks its own scratch before
   * planning, which is where the space is actually spent.
   */
  processingElsewhere?: boolean;
}

export interface LocatedSource {
  file: MediaFileRow;
  absolutePath: string;
}

export interface ExistingPackageView {
  present: boolean;
  current?: boolean;
  sourceMatches?: boolean;
  profileMatches?: boolean;
  rungs?: number[];
  complete?: boolean;
  hdr?: string;
  audioTracks?: number;
  subtitleTracks?: number;
  totalBytes?: number;
  missingRungs: number[];
  /**
   * What a real look at the files found, when one was taken. Absent means the
   * package was not inspected, never that it was inspected and found whole.
   */
  damage?: PackageDamage;
}

export interface AnalysisResult {
  decision: ProcessingDecision;
  fingerprint: string;
  file: MediaFileRow;
  absolutePath: string;
  titleRoot: string;
  mtimeMs: number;
  existing: ExistingPackageView;
}

/** What removing a source did. A refusal is thrown, never returned. */
export interface SourceRemoval {
  file: MediaFileRow;
  deleted: boolean;
  alreadyAbsent: boolean;
  freedBytes: number;
}

/** Why one title in a bulk request was not queued. */
export type EnqueueSkipReason =
  | "already-queued"
  | "already-complete"
  | "source-unavailable"
  | "rejected"
  | "insufficient-space"
  | "error";

export interface BulkEnqueueOutcome {
  queued: number;
  alreadyQueued: number;
  alreadyComplete: number;
  unavailable: number;
  failed: number;
  /** The job ids created, so a caller can report or follow them. */
  jobIds: string[];
  /** One line per title that was not queued, for the operator's notice. */
  skipped: Array<{
    itemId: string;
    mediaFileId: string | null;
    reason: EnqueueSkipReason;
    detail?: string;
  }>;
}

/**
 * The queue attempt a durable processing job is currently running on.
 *
 * `adopted` is true when an executable attempt already existed — a double
 * press, a concurrent request, or a previous resume that got as far as the
 * queue before its caller went away.
 */
export interface ProcessingAttempt {
  queueJobId: string;
  /** True when an executable attempt already existed and was taken over. */
  adopted: boolean;
  /** `queued` means nothing has begun; `running` means a worker holds it. */
  status: JobStatus;
}

export interface ProcessingEnqueuer {
  locateSource(itemId: string, mediaFileId?: string): Promise<LocatedSource>;
  statSource(
    file: Pick<MediaFileRow, "missingSince">,
    absolutePath: string,
  ): Promise<Stats | null>;
  titleRootFor(itemId: string, absolutePath: string): Promise<string>;
  existingPackage(
    titleRoot: string,
    fingerprint: string | null,
  ): Promise<ExistingPackageView>;
  analyse(itemId: string, mediaFileId?: string): Promise<AnalysisResult>;
  /** Creates and queues one job. Throws the same errors the route always did. */
  enqueue(
    itemId: string,
    mediaFileId?: string,
  ): Promise<{ job: ProcessingJobRecord; analysis: AnalysisResult }>;
  /**
   * Gives an existing durable job one executable attempt, and no more.
   *
   * A processing job is the lifetime of an operation; a `media.process` row is
   * one attempt at it, and an operation may need several — a parked job whose
   * attempt ended, a job whose worker died, a job an operator resumed. What
   * this refuses to do is create a second attempt for work that already has
   * one, and it decides that by asking the queue what is still executable for
   * this processing job rather than by trusting the id stored beside it, which
   * names the last attempt and may long since have finished.
   *
   * Two presses and two concurrent requests converge on one row: the losing
   * insert collapses onto the winner through the queue's own dedupe index, so
   * exactly-once does not depend on this process seeing a consistent read.
   */
  ensureAttempt(
    job: Pick<ProcessingJobRecord, "id" | "itemId" | "mediaFileId">,
  ): Promise<ProcessingAttempt>;
  /**
   * Runs `enqueue` over many titles and counts what happened.
   *
   * Sequential on purpose. Each call probes a source and reads a manifest off
   * the media volume, and eighty of those at once is precisely the burst this
   * system's storage rules exist to prevent. It also makes the result
   * deterministic: two presses of the same button produce the same counts
   * because the second one finds the jobs the first one made.
   */
  enqueueAll(
    targets: ReadonlyArray<{ itemId: string; mediaFileId?: string }>,
  ): Promise<BulkEnqueueOutcome>;
  /**
   * Deletes the source of a title whose package already holds every rendition
   * it would ever be given, or refuses with an `OwnApiError` saying why the
   * source is still needed.
   *
   * The one place this decision is made — for the button and for a helper
   * removing sources after upload alike — because the bytes are gone for good.
   * `expectedFingerprint` further requires the source to still be the bytes a
   * particular job built from. `onDamage` hears of a package found incomplete,
   * so a caller with a package index can stop advertising it as whole.
   */
  removeSource(
    itemId: string,
    mediaFileId?: string,
    options?: {
      expectedFingerprint?: string;
      onDamage?: (mediaFileId: string, damage: PackageDamage) => void;
    },
  ): Promise<SourceRemoval>;
}

export function createProcessingEnqueuer({
  catalogue,
  store,
  queue,
  mediaRoot,
  workRoot,
  ffprobePath,
  hardware,
  storageGuard,
  processingElsewhere = false,
}: ProcessingEnqueueOptions): ProcessingEnqueuer {
  const resolvedMediaRoot = path.resolve(mediaRoot);

  /**
   * Where an item's bytes would live, whether or not they are still there.
   *
   * Locating and reading are separate steps because a source can be deleted
   * while the package built from it stays on disk: the path is still the only
   * way to find that package, so it is resolved before the file is opened.
   */
  const locateSource: ProcessingEnqueuer["locateSource"] = async (
    itemId,
    mediaFileId,
  ) => {
    const files = await catalogue.listFilesForItem(itemId);
    /*
     * `listFilesForItem` returns primary first, largest first — the same order
     * `getPrimaryFile` picks from — so `files[0]` is the canonical source the
     * rest of Seyirlik plays. This is what keeps the `.mkv` and the `.mp4` of
     * one episode from becoming two jobs writing to one package.
     */
    const file = mediaFileId
      ? files.find((candidate) => candidate.id === mediaFileId)
      : files[0];
    if (!file) {
      throw new OwnApiError(
        "MEDIA_NOT_FOUND",
        "The requested media could not be found.",
        404,
      );
    }
    const absolutePath = path.resolve(
      resolvedMediaRoot,
      ...file.relativePath.split("/"),
    );
    if (!isPathInsideRoot(resolvedMediaRoot, absolutePath)) {
      throw new OwnApiError(
        "MEDIA_NOT_FOUND",
        "The requested media could not be found.",
        404,
      );
    }
    return { file, absolutePath };
  };

  /**
   * The source's stats, or `null` when the source is gone.
   *
   * A deleted source is an ordinary state of the library, not a fault: `stat`
   * raising ENOENT used to reach the page as a bare internal error, which said
   * nothing about the package the title still has.
   */
  const statSource: ProcessingEnqueuer["statSource"] = async (
    file,
    absolutePath,
  ) => {
    if (file.missingSince !== null) return null;
    try {
      return await stat(absolutePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  };

  /**
   * Where this title's package is, or would go.
   *
   * A movie folder holds one movie, so its package sits beside it. A season
   * folder holds a season, so an episode's goes in its own folder inside it.
   * The kind comes from the catalogue rather than from the shape of the path,
   * because a path cannot tell the two apart.
   */
  const titleRootFor: ProcessingEnqueuer["titleRootFor"] = async (
    itemId,
    absolutePath,
  ) => {
    const kind = (await catalogue.getItemKind(itemId)) ?? "movie";
    return resolveTitleRoot(absolutePath, titleRootLayoutForKind(kind));
  };

  /**
   * What the title already holds, so a preview can describe the work that is
   * actually left rather than the work a bare source would need.
   */
  const existingPackage: ProcessingEnqueuer["existingPackage"] = async (
    titleRoot,
    fingerprint,
  ) => {
    const manifest = await readTitlePackageManifest(titleRoot).catch(
      () => undefined,
    );
    const summary = summarisePackage(manifest ?? null, fingerprint);
    if (!summary || !manifest) return { present: false, missingRungs: [] };

    /*
     * The manifest is what publishing meant to leave behind; this is what it
     * actually left. One title, on demand, so the stats cost nothing next to
     * the probe of the source that surrounds them — the background index that
     * sweeps the whole library on a clock deliberately does not do this.
     *
     * A rung whose media file is gone or short is dropped from the package, so
     * the ladder reports it as missing and the ordinary incremental job encodes
     * it again. Damage anywhere else — the master playlist, an audio or
     * subtitle track — cannot be repaired by re-encoding one rung, so it is
     * reported as an incomplete package instead of being quietly excused.
     */
    const missing = await missingPackageAssets(
      await resolvePublishedTitleRoot(titleRoot),
      manifest,
    );
    const damage: PackageDamage = {
      manifestId: manifestIdentity(manifest),
      rungs: [
        ...new Set(
          missing
            .map((asset) => asset.qualityHeight)
            .filter((height): height is number => height !== undefined),
        ),
      ],
      elsewhere: missing.some((asset) => asset.qualityHeight === undefined),
    };
    // Summarised again from what survives, so the ladder, the state and
    // completeness are decided by one predicate rather than by a copy of it.
    return {
      ...(summarisePackage(manifest, fingerprint, damage) ?? summary),
      missingRungs: [],
      damage,
    };
  };

  const analyse: ProcessingEnqueuer["analyse"] = async (
    itemId,
    mediaFileId,
  ) => {
    const { file, absolutePath } = await locateSource(itemId, mediaFileId);
    const stats = await statSource(file, absolutePath);
    if (!stats) {
      throw new OwnApiError(
        "SOURCE_UNAVAILABLE",
        "The source file for this title is no longer on disk.",
        409,
      );
    }
    const probe = await probeMediaFile(absolutePath, ffprobePath);
    const report = await hardware();
    const freeBytes = processingElsewhere
      ? undefined
      : await freeBytesOn(workRoot);
    const fingerprint = await computeSourceFingerprint(absolutePath, stats);
    const titleRoot = await titleRootFor(itemId, absolutePath);
    const existing = await existingPackage(titleRoot, fingerprint);
    const plan = {
      probe,
      container: path.extname(absolutePath).replace(".", ""),
      sizeBytes: stats.size,
      hardware: report,
      ...(freeBytes === undefined ? {} : { freeBytes }),
    };

    /*
     * What this source would be built into today, before asking whether the
     * package on disk already satisfies it.
     *
     * The two questions are separate: the profile version says whether a
     * package is still *readable*, and the ladder says whether it is still
     * *complete*. Deciding completeness from the profile version alone means a
     * title that predates a new rung reports "nothing to do" — and moving the
     * profile version to force the issue is worse, because a mismatch resolves
     * the package to `missing` and withdraws a perfectly playable title from
     * delivery. So the ladder is compared directly. `decideProcessing` reads
     * only the values above, so asking it twice costs nothing.
     */
    const planned = decideProcessing(plan);
    const retainedSidecars = await planRetainedSidecarSubtitles(absolutePath);
    const manifest = existing.present
      ? await readTitlePackageManifest(titleRoot)
      : null;
    const missingSidecars = retainedSidecars.filter(
      (sidecar) =>
        !sidecarSubtitleIsCurrent(
          sidecar,
          manifest?.subtitle.find(
            (track) => track.id === subtitleRenditionId(sidecar.streamIndex),
          ),
        ),
    );
    const missingEmbeddedSubtitles =
      planned.streams.keptSubtitleStreamIndexes.filter(
        (index) =>
          !manifest?.subtitle.some(
            (track) => track.id === subtitleRenditionId(index),
          ),
      );
    const missingSubtitleCount =
      missingSidecars.length + missingEmbeddedSubtitles.length;
    const missingRungs = planned.ladder
      .map((rung) => rung.qualityHeight)
      .filter(
        (height) => !existing.present || !existing.rungs?.includes(height),
      );
    const isCurrent =
      existing.present &&
      existing.current === true &&
      !existing.damage?.elsewhere &&
      missingRungs.length === 0 &&
      missingSubtitleCount === 0;

    /*
     * Re-decided once the outstanding work is known, so the estimate and the
     * disk preflight describe this job rather than the finished package. A
     * one-rung job otherwise reported the whole package's size as its own
     * output and reserved space for seven renditions it was not making.
     */
    const incremental =
      !isCurrent &&
      existing.present &&
      existing.current === true &&
      !existing.damage?.elsewhere;
    const decision = isCurrent
      ? decideProcessing({ ...plan, alreadyCurrent: true })
      : incremental
        ? decideProcessing({
            ...plan,
            renditionsToEncode: missingRungs,
            // Existing audio is reused whenever the package is otherwise
            // current, so this run encodes none of it.
            audioTracksToEncode: 0,
          })
        : planned;
    if (incremental && missingSubtitleCount > 0 && missingRungs.length === 0) {
      decision.summary = `Refresh ${missingSubtitleCount} subtitle track(s), reusing the published video and audio.`;
    }

    return {
      decision,
      fingerprint,
      file,
      absolutePath,
      titleRoot,
      mtimeMs: stats.mtimeMs,
      existing: { ...existing, missingRungs },
    };
  };

  /**
   * The payload one attempt runs on.
   *
   * Built in one place so every route into an attempt carries the same fields.
   * `titleRoot` is the one that matters most: without it the worker publishes
   * beside the source, which for an episode is the season folder — so every
   * episode of a season would overwrite the last one. It was present on the
   * first attempt and missing from every requeue, which made the destination
   * of a job depend on how it happened to be started.
   */
  function attemptPayload(input: {
    processingJobId: string;
    file: MediaFileRow;
    absolutePath: string;
    mtimeMs: number;
    titleRoot: string;
  }): Record<string, unknown> {
    return {
      processingJobId: input.processingJobId,
      sourcePath: input.absolutePath,
      relativePath: input.file.relativePath,
      sizeBytes: Number(input.file.sizeBytes),
      mtimeMs: input.mtimeMs,
      titleRoot: input.titleRoot,
    };
  }

  const ensureAttempt: ProcessingEnqueuer["ensureAttempt"] = async (job) => {
    /*
     * The same gate a new job meets. A resumed job is new work as far as the
     * drive is concerned, and routing around the quarantine by resuming
     * instead of queueing is precisely the thing an operator would try.
     */
    if (!storageGuard.mayStartWork()) {
      throw new OwnApiError(
        "PROCESSING_STORAGE_GUARDED",
        `${storageGuard.describe()} Verify and resume the storage before starting this job.`,
        409,
      );
    }

    const existing = await queue.findActive({
      jobType: PROCESSING_JOB_TYPE,
      payload: { processingJobId: job.id },
    });
    if (existing) {
      return {
        queueJobId: existing.id,
        adopted: true,
        status: existing.status,
      };
    }

    const { file, absolutePath } = await locateSource(
      job.itemId,
      job.mediaFileId,
    );
    const stats = await statSource(file, absolutePath);
    if (!stats) {
      throw new OwnApiError(
        "SOURCE_UNAVAILABLE",
        "The source file for this title is no longer on disk.",
        409,
      );
    }
    const titleRoot = await titleRootFor(job.itemId, absolutePath);
    const queueJobId = await queue.enqueue({
      jobType: PROCESSING_JOB_TYPE,
      payload: attemptPayload({
        processingJobId: job.id,
        file,
        absolutePath,
        mtimeMs: stats.mtimeMs,
        titleRoot,
      }),
      /*
       * The back of the line. An attempt re-entering the queue is new work as
       * far as the order goes, and taking the default priority would have put
       * it at the head of a queue an operator had arranged by hand.
       */
      priority: await store.nextQueuePriority(),
      /*
       * The same key a first attempt uses, on purpose. It is unique only over
       * queued and running rows, so a finished attempt never blocks a later
       * one — and while an attempt *is* live, two simultaneous presses collapse
       * onto it in the database rather than in whichever process read first.
       */
      dedupeKey: `processing:${file.id}`,
    });
    /*
     * Read back rather than assumed. A collapse returns the row it collapsed
     * onto — which a racing request may already have had leased — and a caller
     * that assumed `queued` here would tell the page nothing has started while
     * an encoder was running.
     */
    const record = await queue.get(queueJobId);
    return { queueJobId, adopted: false, status: record?.status ?? "queued" };
  };

  const enqueue: ProcessingEnqueuer["enqueue"] = async (
    itemId,
    mediaFileId,
  ) => {
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

    const analysis = await analyse(itemId, mediaFileId);
    const { decision, file, fingerprint, absolutePath, mtimeMs, existing } =
      analysis;

    if (decision.action.startsWith("reject")) {
      throw new OwnApiError("PROCESSING_REJECTED", decision.summary, 422);
    }
    if (decision.action === "skip-already-current") {
      /*
       * Nothing to build. A single press already surfaced this as a card that
       * offers removal of the source instead of a run; a bulk press has to be
       * told the same thing in a form it can count.
       */
      throw new OwnApiError(
        "PROCESSING_ALREADY_CURRENT",
        "A current package for this exact source already exists.",
        409,
      );
    }
    if (!decision.estimate.sufficient) {
      throw new OwnApiError(
        "INSUFFICIENT_DISK_SPACE",
        "There is not enough free space for this package and its staging copy.",
        507,
      );
    }

    let job: ProcessingJobRecord;
    try {
      job = await store.create({
        itemId,
        mediaFileId: file.id,
        sourceFingerprint: fingerprint,
        profile: ADAPTIVE_PROFILE_VERSION,
        /*
         * `decision.renditionsToEncode` already states the work; the flag only
         * records whether this was an addition to a package that was otherwise
         * complete, which is what the history reads back.
         */
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
        estimatedOutputBytes: decision.estimate.outputBytes,
        estimatedStagingBytes: decision.estimate.stagingBytes,
        hardwareAdapter: decision.hardwareAdapter,
        videoEncoder: decision.videoEncoder,
        warnings: decision.warnings,
      });
    } catch (error) {
      if (error instanceof DuplicateProcessingJobError) {
        throw new OwnApiError(
          "PROCESSING_JOB_EXISTS",
          "This file already has a processing job that has not finished.",
          409,
        );
      }
      throw error;
    }

    const queueJobId = await queue.enqueue({
      jobType: PROCESSING_JOB_TYPE,
      payload: attemptPayload({
        processingJobId: job.id,
        file,
        absolutePath,
        mtimeMs,
        titleRoot: analysis.titleRoot,
      }),
      /*
       * The back of the line, read rather than assumed. The column's default
       * is the *head* position, so a title queued while a hand-arranged
       * backlog was waiting would otherwise have been encoded first.
       */
      priority: await store.nextQueuePriority(),
      /*
       * The queue's own dedupe key, keyed on the file rather than the item, so
       * a double press and two overlapping bulk requests converge on one job
       * exactly as the unique index on `processing_jobs` does.
       */
      dedupeKey: `processing:${file.id}`,
    });
    await store.attachQueueJob(job.id, queueJobId);
    await store.appendEvent({
      processingJobId: job.id,
      stage: "waiting",
      message: "Queued for processing.",
    });

    return { job: (await store.get(job.id)) ?? job, analysis };
  };

  const enqueueAll: ProcessingEnqueuer["enqueueAll"] = async (targets) => {
    const outcome: BulkEnqueueOutcome = {
      queued: 0,
      alreadyQueued: 0,
      alreadyComplete: 0,
      unavailable: 0,
      failed: 0,
      jobIds: [],
      skipped: [],
    };
    /*
     * The same title named twice in one request — which a season and a series
     * press can both produce — is one attempt, not two.
     */
    const seen = new Set<string>();

    for (const target of targets) {
      const key = `${target.itemId}:${target.mediaFileId ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);

      try {
        const { job } = await enqueue(target.itemId, target.mediaFileId);
        outcome.queued += 1;
        outcome.jobIds.push(job.id);
      } catch (error) {
        const code = error instanceof OwnApiError ? error.code : "";
        const mediaFileId = target.mediaFileId ?? null;
        if (code === "PROCESSING_JOB_EXISTS") {
          outcome.alreadyQueued += 1;
          outcome.skipped.push({
            itemId: target.itemId,
            mediaFileId,
            reason: "already-queued",
          });
          continue;
        }
        if (code === "PROCESSING_ALREADY_CURRENT") {
          outcome.alreadyComplete += 1;
          outcome.skipped.push({
            itemId: target.itemId,
            mediaFileId,
            reason: "already-complete",
          });
          continue;
        }
        if (code === "SOURCE_UNAVAILABLE" || code === "MEDIA_NOT_FOUND") {
          outcome.unavailable += 1;
          outcome.skipped.push({
            itemId: target.itemId,
            mediaFileId,
            reason: "source-unavailable",
          });
          continue;
        }
        /*
         * A guarded volume is not one title's problem, it is the whole
         * request's. Continuing would produce a hundred identical refusals and
         * hide the one that matters.
         */
        if (code === "PROCESSING_STORAGE_GUARDED") throw error;

        outcome.failed += 1;
        outcome.skipped.push({
          itemId: target.itemId,
          mediaFileId,
          reason:
            code === "PROCESSING_REJECTED"
              ? "rejected"
              : code === "INSUFFICIENT_DISK_SPACE"
                ? "insufficient-space"
                : "error",
          detail: error instanceof Error ? error.message : String(error),
        });
        /*
         * A full disk will be full for the next title too. Stopping is the
         * honest answer, and it leaves the jobs already queued intact.
         */
        if (code === "INSUFFICIENT_DISK_SPACE") break;
      }
    }

    return outcome;
  };

  /*
   * Nothing a caller believes is taken on trust: the source is
   * re-fingerprinted, the ladder is re-decided from it, and every file the
   * package claims is checked before the source is unlinked. A page can be
   * looking at a preview minutes old, and in that time the file can have been
   * replaced or the package half-removed.
   */
  const removeSource: ProcessingEnqueuer["removeSource"] = async (
    itemId,
    mediaFileId,
    options = {},
  ) => {
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
      return {
        file: located.file,
        deleted: false,
        alreadyAbsent: true,
        freedBytes: 0,
      };
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
    const titleRoot = await titleRootFor(itemId, located.absolutePath);
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
    // Checked where the manifest was read from: behind a publication pointer
    // that is the current generation, not the title folder.
    const missing = await missingPackageAssets(
      await resolvePublishedTitleRoot(titleRoot),
      manifest,
    );
    if (missing.length > 0) {
      options.onDamage?.(located.file.id, {
        manifestId: manifestIdentity(manifest),
        rungs: [
          ...new Set(
            missing
              .map((asset) => asset.qualityHeight)
              .filter((height): height is number => height !== undefined),
          ),
        ],
        elsewhere: missing.some((asset) => asset.qualityHeight === undefined),
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
    const { existing, fingerprint } = await analyse(itemId, located.file.id);
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
    if (
      options.expectedFingerprint !== undefined &&
      fingerprint !== options.expectedFingerprint
    ) {
      throw new OwnApiError(
        "SOURCE_CHANGED",
        "The source is no longer the file this package was built from.",
        409,
      );
    }

    await unlink(located.absolutePath);
    return {
      file: located.file,
      deleted: true,
      alreadyAbsent: false,
      freedBytes: stats.size,
    };
  };

  return {
    locateSource,
    statSource,
    titleRootFor,
    existingPackage,
    analyse,
    enqueue,
    ensureAttempt,
    enqueueAll,
    removeSource,
  };
}

/** Kept here so the route module and the projection agree on the ladder. */
export const STANDARD_RUNG_HEIGHTS = RENDITION_TARGETS.map(
  (target) => target.qualityHeight,
);
