import { randomUUID } from "node:crypto";
import type { ProcessingJobStore } from "../processing/jobStore";
import { episodeCode } from "../processing/processingProjection";
import {
  liveProgressIsFresh,
  readLiveProgress,
} from "../processing/liveProgress";
import {
  presentMaintenanceProgress,
  presentTask,
  safeTaskLabel,
  type TaskPresentation,
} from "../../../lib/notifications/taskPresentation";
import { OwnApiError } from "../ownApiHandler";
import { sendAccepted, sendData, sendNoContent } from "../api/envelope";
import type { RouteDefinition } from "../api/router";
import {
  asObjectBody,
  optionalBodyBoolean,
  parseLimit,
  parseOffset,
  parseOptionalEnum,
  requireUuid,
  validationError,
} from "../api/validation";
import type { JobQueue, JobRecord, JobStatus } from "./jobQueue";
import { JOB_TYPES } from "./jobHandlers";
import {
  TRICKPLAY_FFMPEG_FAILURES,
  TRICKPLAY_NOTHING_TO_SAMPLE,
} from "../trickplay/trickplayService";
import {
  MAINTENANCE_EXCLUDED_JOB_TYPES,
  toMaintenanceTaskDto,
} from "./maintenanceTaskDto";
import type { MaintenanceTaskDto } from "../../../lib/maintenance/maintenanceTasks";
import type { LibraryRepository } from "../libraries/libraryRepository";
import type { LibraryKind } from "../scanner/libraryScan";

const JOB_STATUSES: JobStatus[] = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
];

/**
 * The maintenance actions the Library Maintenance page offers, and nothing
 * else. An allowlist rather than a mapping from free text: the action name
 * arrives in a URL, and every one of these schedules work against somebody's
 * media volume.
 */
export const MAINTENANCE_ACTIONS = [
  "all",
  "scan-all",
  "scan-movies",
  "scan-shows",
  "scan-books",
  "trickplay",
  "segments",
  "enrich",
  "rename",
  "organize",
] as const;
export type MaintenanceAction = (typeof MAINTENANCE_ACTIONS)[number];

/**
 * Which library kinds each category action selects.
 *
 * `collections` and `mixed` are deliberately absent: neither is a category a
 * person can press, and classifying either as films or shows would scan a
 * library the button did not name. Both are still covered by "all".
 */
const SCAN_KINDS: Record<string, LibraryKind[]> = {
  "scan-movies": ["movies"],
  "scan-shows": ["series"],
  "scan-books": ["books"],
};

export interface MaintenanceAcceptance {
  action: MaintenanceAction;
  /** Durable jobs now queued or already in flight for this action. */
  taskIds: string[];
  /** Libraries the action applied to; zero is a successful no-op. */
  libraries: number;
}

/**
 * The one place a maintenance action becomes queued work.
 *
 * Every route below funnels through here so the dedupe keys, the priorities
 * and the "which libraries does this mean" decision exist once. Nothing waits:
 * the function returns as soon as the rows are durable, and the browser learns
 * the rest from the task list it already watches.
 */
export async function enqueueMaintenance(
  queue: JobQueue,
  libraries: LibraryRepository,
  action: MaintenanceAction,
): Promise<MaintenanceAcceptance> {
  if (action === "all") {
    const taskId = await queue.enqueue({
      jobType: JOB_TYPES.libraryMaintenance,
      /*
       * The run's identity, minted here and carried by every pass of it.
       *
       * "All in one" is a chain of short bookkeeping rows, and without a shared
       * id the history is a column of identical successes with nothing saying
       * which run each belonged to. A press that collapses onto an in-flight
       * run keeps that run's id, because `enqueue` returns the existing row
       * rather than inserting this payload.
       */
      payload: { stage: "scan", pass: 0, runId: randomUUID() },
      dedupeKey: `${JOB_TYPES.libraryMaintenance}:scan:0`,
      priority: 90,
    });
    return {
      action,
      taskIds: [taskId],
      libraries: (await libraries.listAll()).length,
    };
  }

  if (action === "enrich") {
    const taskId = await queue.enqueue({
      jobType: JOB_TYPES.catalogueEnrich,
      payload: {},
      dedupeKey: `${JOB_TYPES.catalogueEnrich}:all`,
      priority: 300,
    });
    return { action, taskIds: [taskId], libraries: 0 };
  }

  if (action === "segments") {
    const taskId = await queue.enqueue({
      jobType: JOB_TYPES.segmentsScan,
      payload: {},
      dedupeKey: `${JOB_TYPES.segmentsScan}:all`,
      priority: 455,
    });
    return { action, taskIds: [taskId], libraries: 0 };
  }

  if (action === "trickplay") {
    const taskId = await queue.enqueue({
      jobType: JOB_TYPES.trickplayScan,
      payload: {},
      dedupeKey: `${JOB_TYPES.trickplayScan}:all:0`,
      priority: 450,
    });
    return { action, taskIds: [taskId], libraries: 0 };
  }

  const all = await libraries.listAll();
  const kinds = SCAN_KINDS[action];
  const selected = kinds
    ? all.filter((library) => kinds.includes(library.kind))
    : all;

  const jobType =
    action === "rename"
      ? JOB_TYPES.libraryRename
      : action === "organize"
        ? JOB_TYPES.libraryOrganize
        : JOB_TYPES.libraryScan;

  const taskIds: string[] = [];
  for (const library of selected) {
    taskIds.push(
      await queue.enqueue({
        jobType,
        payload: { libraryId: library.id },
        // Per library and per operation: repeated presses, a category action
        // and "all in one" all collapse onto the one attempt already due.
        dedupeKey: `${jobType}:${library.id}`,
        ...(jobType === JOB_TYPES.libraryScan ? {} : { priority: 150 }),
      }),
    );
  }
  return { action, taskIds, libraries: selected.length };
}

export interface TaskRoutesOptions {
  queue: JobQueue;
  processingJobs?: Pick<ProcessingJobStore, "get">;
  libraries: LibraryRepository;
  resolveMediaLabel?: (
    userId: string,
    itemId: string,
  ) => Promise<MediaSubject | null>;
}

/**
 * The naming fields of one title, straight from the catalogue.
 *
 * Separate fields rather than one composed string: a name that trips the
 * allowlist would otherwise take the episode number down with it, and an
 * anonymous card is exactly the thing this endpoint exists to prevent.
 */
export interface MediaSubject {
  kind: "movie" | "episode" | string;
  title: string | null;
  seriesTitle?: string | null;
  seasonNumber?: number | null;
  episodeNumber?: number | null;
}

/**
 * Names one title the way the processing queue names it: the show carries the
 * card, the code and episode name say which part of it.
 */
export function describeMediaSubject(
  media: MediaSubject,
): NonNullable<TaskPresentation["subject"]> {
  const title = safeTaskLabel(media.title);
  const series = safeTaskLabel(media.seriesTitle);
  const code =
    typeof media.seasonNumber === "number" &&
    Number.isSafeInteger(media.seasonNumber) &&
    media.seasonNumber >= 0
      ? episodeCode(
          media.seasonNumber,
          typeof media.episodeNumber === "number" &&
            Number.isSafeInteger(media.episodeNumber) &&
            media.episodeNumber >= 0
            ? media.episodeNumber
            : null,
        )
      : undefined;
  const isEpisode = media.kind === "episode" || series !== undefined || !!code;
  const label = isEpisode ? (series ?? title) : title;
  return {
    type: "media",
    ...(label ? { label } : {}),
    // Kept apart from the name so a card can wear the short form on its line
    // and the long one inside, and so one rejected field cannot take the
    // other down with it.
    ...(isEpisode && code ? { code } : {}),
    ...(isEpisode && title && title !== label ? { detail: title } : {}),
    ...(label || (isEpisode && code) ? {} : { unnamed: true }),
  };
}

/** Only safe, client-actionable fields leave the process. */
export async function toTaskDto(
  job: JobRecord,
  libraries: LibraryRepository,
  resolveMediaLabel?: (id: string) => Promise<MediaSubject | null>,
  processingJobs?: Pick<ProcessingJobStore, "get">,
) {
  const presentation = presentTask(
    job.jobType,
    job.status === "running" ? job.progressMessage : null,
    job.status === "succeeded" ? job.result : null,
  );
  /*
   * The executor's own report wins over the sentence beside it.
   *
   * Both are written by the same call, so they never disagree — but only one
   * of them carries a phase and a fraction for every maintenance job rather
   * than for the four whose wording the matcher above happens to know. Applied
   * before the processing block below, which has a richer record of its own
   * and is allowed to overwrite any of this.
   */
  Object.assign(
    presentation,
    (job.status === "running"
      ? presentMaintenanceProgress(job.progressDetail)
      : null) ?? {},
  );
  let itemId = job.payload.itemId;
  if (
    job.jobType === "media.process" &&
    typeof job.payload.processingJobId === "string" &&
    processingJobs
  ) {
    const processing = await processingJobs.get(job.payload.processingJobId);
    /*
     * Which title this is never changes once the row exists, so naming is read
     * from any attempt. A queued job whose attempt has not been re-attached is
     * still that episode, and a card that cannot say which episode it is about
     * is indistinguishable from the eleven behind it.
     */
    if (processing) itemId = processing.itemId;
    // Figures are a different matter: never combine a historical queue attempt
    // with a newer processing run.
    if (processing?.jobId === job.id) {
      /*
       * The same sample the processing page draws from, so the two never
       * disagree about how far along an encode is. Read only for a job that is
       * actually running — for anything else there is no rate to describe.
       */
      const sample =
        processing.state === "running"
          ? await readLiveProgress(processing.id).catch(() => null)
          : null;
      const live = sample && liveProgressIsFresh(sample) ? sample : null;
      const encodedSeconds = Math.max(
        live?.encodedSeconds ?? 0,
        processing.encodedSeconds,
      );
      const totalSeconds =
        live?.sourceDurationSeconds ?? processing.sourceDurationSeconds;
      /*
       * The row is written at checkpoints; the sample arrives four times a
       * second. Reading the phase off the row is what left a card saying
       * "Starting media processing, progress not measurable yet" beside a page
       * showing the same job eighty-four per cent through its picture.
       */
      const stage = live?.stage ?? processing.stage;
      /*
       * Read from whichever source named the phase above, never mixed. The
       * sample's phase and the row's phase advance independently, and pairing
       * one's name with the other's fraction reports the position of the phase
       * that has just ended under the name of the one that just began.
       */
      const phaseFraction = live
        ? live.phaseFraction
        : processing.stageProgress;
      if (
        stage === "video" &&
        /*
         * A paused encoder is suspended where it stands, so its position is
         * still a fact about the file on disk — the figure that stops being
         * true is the *rate*, and that is guarded separately below. Dropping
         * the position along with the rate is what left a suspended job saying
         * only "progress not measurable yet" beside a page showing it three
         * quarters encoded.
         */
        (processing.state === "running" || processing.state === "paused") &&
        Number.isFinite(encodedSeconds) &&
        encodedSeconds >= 0 &&
        totalSeconds !== null &&
        Number.isFinite(totalSeconds) &&
        totalSeconds > 0 &&
        encodedSeconds <= totalSeconds
      ) {
        presentation.encoding = {
          completedSeconds: encodedSeconds,
          totalSeconds,
        };
        /*
         * Only from a sample that is still arriving. A remaining time is a
         * statement about a rate that is happening now, and the last figure a
         * stopped encoder wrote stays true about the past while becoming a lie
         * about the future.
         */
        if (
          live &&
          typeof live.etaSeconds === "number" &&
          Number.isFinite(live.etaSeconds) &&
          live.etaSeconds >= 0 &&
          live.etaSeconds < 60 * 60 * 24 * 30
        )
          presentation.remainingSeconds = Math.round(live.etaSeconds);
      }
      if (
        [
          "analysing",
          "planning",
          "video",
          "audio",
          "subtitles",
          "packaging",
          "validating",
          "publishing",
        ].includes(stage)
      )
        presentation.stage = stage as typeof presentation.stage;
      /*
       * Assembling, verifying and publishing each measure themselves exactly,
       * and none of them is the picture — so without this a card went silent
       * for the whole last stretch of a job, saying "progress not measurable
       * yet" beside a page showing the package a hundred per cent assembled.
       */
      if (
        (processing.state === "running" || processing.state === "paused") &&
        typeof phaseFraction === "number" &&
        Number.isFinite(phaseFraction) &&
        phaseFraction >= 0 &&
        phaseFraction <= 1
      )
        presentation.phaseFraction = phaseFraction;
      /*
       * Pausing suspends the encoder; it does not end the queue attempt, so
       * the row this DTO is built from goes on saying `running` for as long as
       * the hold lasts. The processing job is the only thing that knows the
       * work has stopped, and why — a person's hand or an absent drive.
       */
      if (processing.state === "paused")
        presentation.outcome =
          processing.pausedReason === "storage-unavailable" ||
          processing.pausedReason === "storage-quarantined"
            ? "waiting-for-storage"
            : "paused";
      if (processing.sourceDamage?.length && processing.state === "succeeded")
        presentation.outcome = "damaged-output";
    }
  }
  // Keyed by the exact producer message, so the union stays the presentation
  // layer's and no server text ever reaches a card verbatim.
  const errors: Record<string, NonNullable<TaskPresentation["errorCode"]>> = {
    "The library no longer exists.": "deleted",
    "The item no longer exists.": "deleted",
    "No metadata provider is configured.": "provider",
    "Trickplay generation is not available.": "unavailable",
    "This title is HDR, and trickplay for HDR needs an FFmpeg built with the zscale filter (libzimg).":
      "hdr-unsupported",
    "This server is not configured to process media.": "unavailable",
    [TRICKPLAY_NOTHING_TO_SAMPLE]: "source-gone",
    [TRICKPLAY_FFMPEG_FAILURES.fileMissing]: "file-missing",
    [TRICKPLAY_FFMPEG_FAILURES.accessDenied]: "access-denied",
    [TRICKPLAY_FFMPEG_FAILURES.volumeFull]: "volume-full",
    [TRICKPLAY_FFMPEG_FAILURES.unreadable]: "unreadable",
  };
  presentation.errorCode = errors[job.safeError ?? ""];
  if (typeof job.payload.libraryId === "string") {
    const library = await libraries.getById(job.payload.libraryId);
    presentation.subject = {
      type: "library",
      ...(library ? { label: safeTaskLabel(library.name) } : { deleted: true }),
    };
  }
  if (typeof itemId === "string" && resolveMediaLabel) {
    const media = await resolveMediaLabel(itemId as string);
    presentation.subject =
      media === null
        ? { type: "media", deleted: true }
        : describeMediaSubject(media);
  }
  return {
    id: job.id,
    type: job.jobType,
    status: job.status,
    progress: job.progress,
    presentation,
    progressMessage: null,
    attempts: job.attempts,
    maxAttempts: job.maxAttempts,
    error: job.safeError
      ? "Task failed. Review task configuration and retry."
      : null,
    result: Object.fromEntries(
      (presentation.metrics ?? []).map(({ metric, value }) => [metric, value]),
    ),
    queuedAt: job.queuedAt.toISOString(),
    startedAt: job.startedAt?.toISOString() ?? null,
    finishedAt: job.finishedAt?.toISOString() ?? null,
  };
}

export function createTaskRoutes({
  queue,
  processingJobs,
  libraries,
  resolveMediaLabel,
}: TaskRoutesOptions): RouteDefinition[] {
  return [
    {
      method: "POST",
      path: "/admin/libraries/:libraryId/scan",
      access: "admin",
      handle: async (context) => {
        const libraryId = requireUuid(context.params.libraryId, "libraryId");
        const library = await libraries.getById(libraryId);
        if (!library) {
          throw new OwnApiError(
            "LIBRARY_NOT_FOUND",
            "The requested library could not be found.",
            404,
          );
        }

        const body = asObjectBody(
          await context.readJson(2 * 1_024).catch(() => ({})),
          ["allowMassRemoval"],
        );

        const taskId = await queue.enqueue({
          jobType: JOB_TYPES.libraryScan,
          payload: {
            libraryId,
            allowMassRemoval:
              optionalBodyBoolean(body, "allowMassRemoval") === true,
          },
          // Repeated presses of "scan" collapse onto the in-flight scan for
          // this library instead of queueing duplicates.
          dedupeKey: `${JOB_TYPES.libraryScan}:${libraryId}`,
        });

        sendAccepted(context.response, context.requestId, taskId);
      },
    },

    {
      method: "POST",
      path: "/admin/libraries/scan-all",
      access: "admin",
      handle: async (context) => {
        const accepted = await enqueueMaintenance(queue, libraries, "scan-all");
        sendData(
          context.response,
          context.requestId,
          { taskIds: accepted.taskIds },
          202,
        );
      },
    },

    {
      /**
       * Every Library Maintenance action, accepted and returned.
       *
       * The response says what was queued, never what was finished: a scan, a
       * rename and a sheet of trickplay tiles all outlive the request by minutes to
       * hours, and the page follows them through the task list.
       */
      method: "POST",
      path: "/admin/maintenance/:action",
      access: "admin",
      handle: async (context) => {
        const action = MAINTENANCE_ACTIONS.find(
          (candidate) => candidate === context.params.action,
        );
        if (!action) {
          throw validationError("The maintenance action is invalid.");
        }

        const accepted = await enqueueMaintenance(queue, libraries, action);
        // An empty category is a no-op that succeeded, not a failure: a house
        // with no book library has nothing to scan and should be told so.
        sendData(context.response, context.requestId, accepted, 202);
      },
    },

    {
      method: "GET",
      path: "/admin/tasks",
      access: "admin",
      handle: async (context) => {
        const limit = parseLimit(
          context.url.searchParams.get("limit"),
          200,
          50,
        );
        const status = parseOptionalEnum(
          context.url.searchParams.get("status"),
          JOB_STATUSES,
          "status",
        );
        const jobType = context.url.searchParams.get("type") ?? undefined;

        const observeRaw = context.url.searchParams.get("observe");
        if (observeRaw !== null && observeRaw !== "true")
          throw validationError("observe must be true.");
        const observe = observeRaw === "true";
        const since = context.url.searchParams.get("since");
        const after = context.url.searchParams.get("after");
        if ((since !== null || after !== null) && !observe)
          throw validationError("since and after require observe=true.");
        if (
          since !== null &&
          (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(since) ||
            !Number.isFinite(Date.parse(since)) ||
            new Date(since).toISOString() !== since)
        ) {
          throw validationError("since must be an ISO UTC timestamp.");
        }
        const afterId =
          after === null ? undefined : requireUuid(after, "after");
        // Database time BEFORE reading rows. Only a fully successful paginated
        // observation may adopt this boundary; completions during GET overlap
        // the next interval, never fall into a request-duration blind gap.
        const observedAt = observe ? await queue.observationTime() : undefined;
        const jobs = await queue.list({
          ...(observe
            ? {
                observe: true,
                ...(since ? { since } : {}),
                ...(afterId ? { afterId } : {}),
              }
            : {}),
          limit,
          ...(status ? { status } : {}),
          ...(jobType ? { jobType } : {}),
        });
        const tasks = await Promise.all(
          jobs.map((job) =>
            toTaskDto(
              job,
              libraries,
              resolveMediaLabel
                ? (id) =>
                    resolveMediaLabel(context.requirePrincipal().userId, id)
                : undefined,
              processingJobs,
            ),
          ),
        );
        sendData(
          context.response,
          context.requestId,
          observe
            ? {
                tasks,
                observedAt,
                next: jobs.length === limit ? jobs.at(-1)!.id : null,
              }
            : tasks,
        );
      },
    },

    {
      method: "GET",
      path: "/admin/tasks/:taskId",
      access: "admin",
      handle: async (context) => {
        const job = await queue.get(
          requireUuid(context.params.taskId, "taskId"),
        );
        if (!job) {
          throw new OwnApiError(
            "TASK_NOT_FOUND",
            "The requested task could not be found.",
            404,
          );
        }
        sendData(
          context.response,
          context.requestId,
          await toTaskDto(
            job,
            libraries,
            resolveMediaLabel
              ? (id) => resolveMediaLabel(context.requirePrincipal().userId, id)
              : undefined,
            processingJobs,
          ),
        );
      },
    },

    {
      /**
       * Everything the Library Scan tab shows, in one canonical snapshot.
       *
       * One request rather than two so the page cannot render an "in progress"
       * list and a "concluded" list that were read a second apart — a job that
       * finished in between would otherwise appear in both or in neither.
       *
       * The waiting positions are worked out here and not on the client. The
       * order is the queue's own claim order, which only the database can
       * evaluate, and a page that sorted the rows itself would be publishing a
       * prediction rather than reading one.
       */
      method: "GET",
      path: "/admin/maintenance/tasks",
      access: "admin",
      handle: async (context) => {
        /*
         * Two lists, two pages, and neither is a cut-off any more.
         *
         * `history` was a limit with a fifty default and the running list had a
         * hard two hundred, so a queue longer than that simply stopped being
         * visible past the end of the first screenful — with no way to ask for
         * the rest and no number saying what was missing. They are page sizes
         * now, each with an offset beside it, and the true totals are counted
         * separately so a tab can say how much there really is.
         */
        const historyLimit = parseLimit(
          context.url.searchParams.get("history"),
          200,
          50,
        );
        const historyOffset = parseOffset(
          context.url.searchParams.get("historyOffset"),
        );
        const activeLimit = parseLimit(
          context.url.searchParams.get("active"),
          500,
          200,
        );
        const activeOffset = parseOffset(
          context.url.searchParams.get("activeOffset"),
        );
        const include = context.url.searchParams.get("include");
        const rawIds = include === null ? [] : include.split(",");
        if (rawIds.length > 100)
          throw validationError("include must contain at most 100 task ids.");
        const ids = rawIds.map((id) => requireUuid(id, "include"));
        if (new Set(ids).size !== ids.length)
          throw validationError("include must not repeat a task.");
        const [active, concluded, totals, allLibraries, included] =
          await Promise.all([
            queue.listActive({
              excludeJobTypes: MAINTENANCE_EXCLUDED_JOB_TYPES,
              limit: activeLimit,
              offset: activeOffset,
            }),
            queue.listConcluded({
              excludeJobTypes: MAINTENANCE_EXCLUDED_JOB_TYPES,
              limit: historyLimit,
              offset: historyOffset,
            }),
            queue.countTasks({
              excludeJobTypes: MAINTENANCE_EXCLUDED_JOB_TYPES,
            }),
            libraries.listAll(),
            Promise.all(ids.map((id) => queue.get(id))),
          ]);

        const describe = (job: JobRecord, queuePosition?: number) =>
          toMaintenanceTaskDto(job, {
            libraries,
            libraryCount: allLibraries.length,
            ...(queuePosition === undefined ? {} : { queuePosition }),
            ...(resolveMediaLabel
              ? {
                  resolveMediaLabel: (id: string) =>
                    resolveMediaLabel(context.requirePrincipal().userId, id),
                }
              : {}),
          });

        /*
         * The position a waiting row is given counts from where its page
         * starts, not from one. On page three of a queue the first row is the
         * four hundred and first thing the worker will claim, and numbering it
         * "1" would be a different queue than the one that exists.
         */
        let waiting = activeOffset;
        const tasks: MaintenanceTaskDto[] = [];
        for (const job of active) {
          if (job.status === "queued") {
            waiting += 1;
            tasks.push(await describe(job, waiting));
          } else {
            tasks.push(await describe(job));
          }
        }
        for (const job of [...concluded, ...included]) {
          if (
            !job ||
            MAINTENANCE_EXCLUDED_JOB_TYPES.includes(job.jobType) ||
            tasks.some((task) => task.id === job.id)
          )
            continue;
          tasks.push(await describe(job));
        }

        sendData(context.response, context.requestId, {
          tasks,
          /*
           * The order the server will actually claim in, sent as its own list.
           * The client applies it verbatim instead of re-deriving it, which is
           * what makes an optimistic drag reconcilable: it either matches what
           * was sent or it does not.
           */
          queue: tasks
            .filter((task) => task.reorderable)
            .map((task) => task.id),
          /*
           * What the page is a page of. `total` is the real figure both tabs
           * label themselves with; the offset and size beside it are what the
           * client needs to draw the pager without re-deriving either.
           */
          pages: {
            active: {
              total: totals.active,
              offset: activeOffset,
              limit: activeLimit,
            },
            concluded: {
              total: totals.concluded,
              offset: historyOffset,
              limit: historyLimit,
            },
          },
        });
      },
    },

    {
      /**
       * Rewrites the order the waiting maintenance jobs will be claimed in.
       *
       * The whole order goes over rather than one move, for the same reason the
       * processing queue does it that way: the server would otherwise have to
       * guess the other positions, and two people dragging at once would each
       * get back a queue neither of them arranged.
       *
       * Legality is decided in the database, in the same statement that does
       * the writing. A running attempt has already been claimed and a concluded
       * one has no place left to take, so neither moves however they are asked
       * for; the reply names the rows that genuinely did.
       */
      method: "POST",
      path: "/admin/maintenance/queue/order",
      access: "admin",
      handle: async (context) => {
        const body = asObjectBody(await context.readJson(32 * 1_024), [
          "taskIds",
        ]);
        const raw = body.taskIds;
        if (!Array.isArray(raw) || raw.length === 0 || raw.length > 200) {
          throw validationError("taskIds must be a list of 1 to 200 task ids.");
        }
        const taskIds = raw.map((value) =>
          requireUuid(typeof value === "string" ? value : "", "taskIds"),
        );
        if (new Set(taskIds).size !== taskIds.length) {
          throw validationError("taskIds must not repeat a task.");
        }

        const moved = await queue.reorderQueue(taskIds, {
          /*
           * The media lane keeps its own queue, with its own rules about which
           * rows may move and what a position means there. Excluding it here is
           * a server-side refusal rather than a convention the page is trusted
           * to follow.
           */
          excludeJobTypes: MAINTENANCE_EXCLUDED_JOB_TYPES,
        });

        /*
         * The authoritative line, read back after the write. Returning the
         * request would tell the caller its order was accepted whether or not
         * any of it was.
         */
        const active = await queue.listActive({
          excludeJobTypes: MAINTENANCE_EXCLUDED_JOB_TYPES,
          limit: 200,
        });
        sendData(context.response, context.requestId, {
          moved,
          queue: active
            .filter((job) => job.status === "queued")
            .map((job) => job.id),
        });
      },
    },

    {
      method: "POST",
      path: "/admin/tasks/:taskId/cancel",
      access: "admin",
      handle: async (context) => {
        // Cancellation is cooperative: a running handler notices at its next
        // checkpoint. The response only reports that the request was recorded.
        await queue.requestCancellation(
          requireUuid(context.params.taskId, "taskId"),
        );
        sendNoContent(context.response);
      },
    },
  ];
}
