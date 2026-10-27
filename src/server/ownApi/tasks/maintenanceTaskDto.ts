import {
  countedFailures,
  MAINTENANCE_COUNTERS,
  parseItemFailures,
  type MaintenanceCounter,
  type MaintenanceCounters,
  type MaintenanceErrorCode,
  type MaintenanceOutcome,
  type MaintenanceTaskDto,
} from "../../../lib/maintenance/maintenanceTasks";
import { safeTaskLabel } from "../../../lib/notifications/taskPresentation";
import { episodeCode } from "../processing/processingProjection";
import type { LibraryRepository } from "../libraries/libraryRepository";
import type { JobRecord } from "./jobQueue";
import {
  TRICKPLAY_FFMPEG_FAILURES,
  TRICKPLAY_NOTHING_TO_SAMPLE,
} from "../trickplay/trickplayService";
import { JOB_TYPES, MEDIA_LANE_JOB_TYPES } from "./jobHandlers";
import type { MediaSubject } from "./taskRoutes";

/**
 * Turning a queue row into the record the Library Maintenance page reads.
 *
 * Everything the page shows comes from here, and everything here comes from
 * the row. There is deliberately no place in this module where a number is
 * estimated, blended or inferred: a figure the executor did not write does not
 * appear, and the page's job is to render the absence rather than to fill it.
 */

/**
 * The work the Library Scan tab is about: every durable job except the ones
 * that hold the encoder.
 *
 * Defined as an exclusion rather than a list so a maintenance job added later
 * appears in the viewer by default. The alternative — an allowlist somebody has
 * to remember to extend — is how work ends up running invisibly, which is the
 * failure this page exists to prevent.
 */
export const MAINTENANCE_EXCLUDED_JOB_TYPES: string[] = MEDIA_LANE_JOB_TYPES;

/** Job types whose payload names a single library. */
const LIBRARY_WIDE_OPERATIONS: ReadonlySet<string> = new Set([
  JOB_TYPES.libraryMaintenance,
  JOB_TYPES.trickplayScan,
  JOB_TYPES.segmentsScan,
  JOB_TYPES.catalogueEnrich,
  JOB_TYPES.mediaProbe,
]);

/**
 * Producer messages mapped to codes.
 *
 * Keyed by the exact sentence the handler raises, exactly as the notification
 * layer does it, so the union stays the client's and no server text is ever
 * forwarded to a screen.
 */
const ERROR_CODES: Record<string, MaintenanceErrorCode> = {
  "The library no longer exists.": "library-deleted",
  "The item no longer exists.": "item-deleted",
  "No metadata provider is configured.": "provider-missing",
  "Trickplay generation is not available.": "unavailable",
  "Renaming is not available.": "unavailable",
  "This server is not configured to process media.": "unavailable",
  "This title is HDR, and trickplay for HDR needs an FFmpeg built with the zscale filter (libzimg).":
    "hdr-unsupported",
  "The task payload is missing a library.": "payload-invalid",
  "The task payload is missing an item.": "payload-invalid",
  "The processing task payload is incomplete.": "payload-invalid",
  "The job did not complete before its lease expired.": "lease-expired",
  "No handler is registered for this task.": "unavailable",
  [TRICKPLAY_NOTHING_TO_SAMPLE]: "source-gone",
  [TRICKPLAY_FFMPEG_FAILURES.fileMissing]: "file-missing",
  [TRICKPLAY_FFMPEG_FAILURES.accessDenied]: "access-denied",
  [TRICKPLAY_FFMPEG_FAILURES.volumeFull]: "volume-full",
  [TRICKPLAY_FFMPEG_FAILURES.unreadable]: "unreadable",
};

/**
 * The counters a result carries, read through the allowlist.
 *
 * A handler returns a plain object and the column stores whatever was in it;
 * this is the boundary where "some JSON" becomes "numbers this page has words
 * for". Nested sub-results are flattened in by their own names, because a scan
 * reports its probe and its provider pass as objects inside its result and both
 * are the same counters under the same names.
 */
export function countersFromResult(
  result: Record<string, unknown> | null,
): MaintenanceCounters {
  const counters: MaintenanceCounters = {};
  if (!result) return counters;
  const take = (source: Record<string, unknown>): void => {
    for (const counter of MAINTENANCE_COUNTERS) {
      const value = source[counter];
      if (
        typeof value === "number" &&
        Number.isSafeInteger(value) &&
        value >= 0
      ) {
        counters[counter as MaintenanceCounter] = value;
      }
    }
  };
  take(result);
  for (const nested of Object.values(result)) {
    if (nested && typeof nested === "object" && !Array.isArray(nested)) {
      take(nested as Record<string, unknown>);
    }
  }
  return counters;
}

/**
 * The one qualifier a finished job wears, chosen by which fact matters most.
 *
 * Only one can be shown, so the order is the order an operator would want to
 * be told: something went wrong with part of it, it stopped short, it stood
 * down, it declined to remove things, it only planned, it is switched off. A
 * job with none of these succeeded plainly and needs no word at all.
 */
export function outcomeFromResult(
  status: JobRecord["status"],
  result: Record<string, unknown> | null,
  counters: MaintenanceCounters,
): MaintenanceOutcome | undefined {
  if (status === "cancelled" || result?.cancelled === true) return "cancelled";
  if (countedFailures(counters) > 0) return "completed-with-failures";
  if (result?.incomplete === true) return "incomplete";
  if (result?.deferred === "processing-active") return "deferred-processing";
  if (result?.removalsSuppressed === true) return "removals-suppressed";
  if (result?.planOnly === true) return "plan-only";
  if (result?.disabled === true) return "organize-disabled";
  return undefined;
}

/** Names one title the way the processing queue names it. */
function describeMedia(media: MediaSubject): MaintenanceTaskDto["scope"] {
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
    kind: "media",
    ...(label ? { label } : {}),
    ...(isEpisode && code ? { code } : {}),
    ...(label || code ? {} : { unnamed: true as const }),
  };
}

export interface MaintenanceDtoContext {
  libraries: Pick<LibraryRepository, "getById">;
  resolveMediaLabel?: (itemId: string) => Promise<MediaSubject | null>;
  /** How many libraries exist, for the operations that mean "all of them". */
  libraryCount?: number;
  /** 1-based place in the waiting line. Absent unless genuinely queued. */
  queuePosition?: number;
}

export async function toMaintenanceTaskDto(
  job: JobRecord,
  context: MaintenanceDtoContext,
): Promise<MaintenanceTaskDto> {
  const counters = countersFromResult(job.result);
  const concluded =
    job.status === "succeeded" ||
    job.status === "failed" ||
    job.status === "cancelled";

  let scope: MaintenanceTaskDto["scope"];
  if (typeof job.payload.libraryId === "string") {
    const library = await context.libraries.getById(job.payload.libraryId);
    scope = {
      kind: "library",
      ...(library
        ? { label: safeTaskLabel(library.name) ?? undefined }
        : { deleted: true as const }),
    };
    if (library && !scope.label) scope.unnamed = true;
  } else if (typeof job.payload.itemId === "string") {
    const media = await context.resolveMediaLabel?.(job.payload.itemId);
    scope =
      media === null || media === undefined
        ? { kind: "media", deleted: true }
        : describeMedia(media);
  } else if (LIBRARY_WIDE_OPERATIONS.has(job.jobType)) {
    scope = {
      kind: "all-libraries",
      ...(typeof context.libraryCount === "number"
        ? { libraries: context.libraryCount }
        : {}),
    };
  }

  const runId =
    typeof job.payload.runId === "string" && job.payload.runId.length > 0
      ? job.payload.runId
      : undefined;

  return {
    id: job.id,
    operation: job.jobType,
    status: job.status,
    ...(runId ? { runId } : {}),
    ...(scope ? { scope } : {}),
    ...(context.queuePosition !== undefined
      ? { queuePosition: context.queuePosition }
      : {}),
    /*
     * Only a row that is still waiting can be moved. Read from the status
     * rather than from the absence of a start time: a job whose lease expired
     * has a `startedAt` and is queued again, and it is genuinely movable.
     */
    reorderable: job.status === "queued",
    attempts: job.attempts,
    maxAttempts: job.maxAttempts,
    progress: job.progressDetail,
    result: concluded
      ? {
          counters,
          failures: parseItemFailures(job.result?.failures),
          ...(job.result?.failuresTruncated === true
            ? { failuresTruncated: true as const }
            : {}),
          ...(() => {
            const outcome = outcomeFromResult(job.status, job.result, counters);
            return outcome ? { outcome } : {};
          })(),
        }
      : null,
    errorCode: job.safeError ? (ERROR_CODES[job.safeError] ?? "unknown") : null,
    queuedAt: job.queuedAt.toISOString(),
    runAfter: job.runAfter.toISOString(),
    startedAt: job.startedAt?.toISOString() ?? null,
    finishedAt: job.finishedAt?.toISOString() ?? null,
    /*
     * When the executor last said anything, which is not the same as when the
     * job started. A run whose last word was twenty minutes ago is a run worth
     * looking at, and only the snapshot's own timestamp can say so.
     */
    progressAt: job.progressDetail?.at ?? null,
  };
}
