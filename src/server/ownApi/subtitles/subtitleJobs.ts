import type { MaintenancePhase } from "../../../lib/maintenance/maintenanceTasks";
import {
  DeferredJobError,
  PermanentJobError,
  type JobHandler,
} from "../tasks/worker";
import type { SubtitleRepository } from "./subtitleRepository";
import type { SubtitleService } from "./subtitleService";
import type { SubtitleSyncRequest, SubtitleSyncService } from "./subtitleSync";

export const SUBTITLE_JOB_TYPES = {
  run: "subtitle.run",
  reconcile: "subtitle.reconcile",
  resume: "subtitle.auth-resume",
  sync: "subtitle.sync",
} as const;

/**
 * Reads a sync request out of a job payload, or refuses it permanently.
 *
 * A payload that does not describe a correction cannot start describing one on
 * a retry, so every fault here is permanent. The numbers are checked as
 * integers and finite doubles rather than merely as numbers because they end up
 * multiplying every timestamp in somebody's subtitle, and a `NaN` rate would
 * write a file of `NaN --> NaN`.
 */
export function parseSyncPayload(
  payload: Record<string, unknown>,
): SubtitleSyncRequest {
  const uuid = payload.mediaFileId;
  if (typeof uuid !== "string" || !/^[0-9a-f-]{36}$/i.test(uuid))
    throw new PermanentJobError("The task must name a media file.");
  const targetStreamIndex = payload.targetStreamIndex;
  if (
    !Number.isSafeInteger(targetStreamIndex) ||
    (targetStreamIndex as number) < 0
  )
    throw new PermanentJobError("The task must name a subtitle track.");
  const reference = payload.reference as Record<string, unknown> | undefined;
  if (
    !reference ||
    (reference.kind !== "subtitle" && reference.kind !== "audio") ||
    !Number.isSafeInteger(reference.streamIndex) ||
    (reference.streamIndex as number) < 0
  )
    throw new PermanentJobError("The task must name what to time against.");
  const offsetSeconds = payload.offsetSeconds;
  const rate = payload.rate;
  const manual =
    offsetSeconds !== undefined || rate !== undefined
      ? {
          offsetSeconds: typeof offsetSeconds === "number" ? offsetSeconds : 0,
          rate: typeof rate === "number" ? rate : 1,
        }
      : undefined;
  if (
    manual &&
    (!Number.isFinite(manual.offsetSeconds) ||
      Math.abs(manual.offsetSeconds) > 24 * 3600 ||
      !Number.isFinite(manual.rate) ||
      manual.rate <= 0.5 ||
      manual.rate >= 2)
  )
    throw new PermanentJobError("That correction is not a plausible one.");
  return {
    mediaFileId: uuid,
    targetStreamIndex: targetStreamIndex as number,
    reference: {
      kind: reference.kind,
      streamIndex: reference.streamIndex as number,
    },
    ...(manual ? { transform: manual } : {}),
    dryRun: payload.dryRun === true,
  };
}

/*
 * A rate-limited search is tried again when the provider said it would answer,
 * but never sooner than a minute (a throttle that says "now" would otherwise
 * spin) and never later than a day and an hour (a download allowance renews
 * daily, and a later date is a clock or a parse gone wrong).
 */
const MIN_RETRY_MS = 60_000;
const MAX_RETRY_MS = 25 * 60 * 60 * 1000;

export function createSubtitleJobHandlers(
  service: SubtitleService,
  repository: SubtitleRepository,
  sync?: SubtitleSyncService,
  /** Queues a run of a fresh attempt for later. Absent, a rate limit ends the want's search. */
  runLater?: (attemptId: string, runAfter: Date) => Promise<void>,
): Record<string, JobHandler> {
  const execute =
    (resume: boolean): JobHandler =>
    async ({ job, reportProgress, isCancelled }) => {
      const id = job.payload.attemptId;
      if (typeof id !== "string" || !/^[0-9a-f-]{36}$/i.test(id))
        throw new PermanentJobError("The task must name a subtitle attempt.");
      if (!(await repository.getAttempt(id)))
        throw new PermanentJobError("The subtitle attempt no longer exists.");
      const phases: Record<string, MaintenancePhase> = {
        detecting: "reading",
        searching: "selecting",
        downloading: "reading",
        validating: "analysing",
        installing: "moving",
      };
      const result = await service.run(id, {
        resume,
        replace: job.payload.replace === true,
        isCancelled,
        progress: (event) =>
          reportProgress(0, `Subtitle ${event.phase}`, {
            phase: phases[event.phase]!,
            measure: {
              kind: "exact",
              completed: event.completed,
              total: event.total,
              unit:
                event.phase === "installing" || event.phase === "detecting"
                  ? "files"
                  : "items",
            },
          }),
      });
      if (result.state === "busy")
        throw new DeferredJobError(
          "Another subtitle operation owns this media file.",
          5_000,
        );
      /*
       * Every account's downloads used up for the day, or a provider asking
       * for a pause: this attempt is over, and a new one waits for the
       * renewal rather than leaving the want failed until somebody notices.
       */
      if (
        runLater &&
        result.state === "failed" &&
        result.failure === "provider-rate-limited" &&
        typeof result.retryAfterMs === "number"
      ) {
        const attempt = await repository.getAttempt(id);
        if (attempt && !(await repository.openAttempt(attempt.wantId))) {
          const next = await repository.beginAttempt(attempt.wantId);
          const delay = Math.min(
            Math.max(result.retryAfterMs, MIN_RETRY_MS),
            MAX_RETRY_MS,
          );
          const runAfter = new Date(Date.now() + delay);
          await runLater(next.id, runAfter);
          return {
            ...result,
            retryAttemptId: next.id,
            retryAt: runAfter.toISOString(),
          };
        }
      }
      return result;
    };
  /**
   * How often a running sync is asked whether it has been cancelled.
   *
   * A job context reports cancellation by being asked, and the expensive part
   * of a sync — reading a film's audio — asks nothing for minutes at a time.
   * So the polling happens here and is turned into the `AbortSignal` the
   * process runner already understands, which is what makes Cancel on an audio
   * sync stop an FFmpeg rather than stop watching one.
   */
  const CANCELLATION_POLL_MS = 3_000;

  const syncHandler: JobHandler = async ({
    job,
    reportProgress,
    isCancelled,
  }) => {
    if (!sync)
      throw new PermanentJobError("Subtitle syncing is not configured.");
    const request = parseSyncPayload(job.payload);
    if (await isCancelled()) return { outcome: "cancelled" };
    const controller = new AbortController();
    const poll = setInterval(() => {
      void isCancelled()
        .then((cancelled) => {
          if (cancelled) controller.abort();
        })
        .catch(() => undefined);
    }, CANCELLATION_POLL_MS);
    poll.unref?.();
    try {
      /*
       * A refusal is a result, not a failure. "These two are not the same film"
       * and "that track is inside the container" are answers the operator asked
       * for, and throwing would retry them twice and file them under errors.
       */
      return (await sync.sync({
        ...request,
        signal: controller.signal,
        /*
         * Phases rather than a fraction. Reading a film's audio off the media
         * volume takes minutes and reports nothing on the way, so there is no
         * honest percentage to give and an invented one is worse than a
         * sentence saying what is happening.
         */
        progress: async (message) => {
          await reportProgress(0, message, {
            phase: "analysing",
            measure: { kind: "indeterminate" },
          }).catch(() => undefined);
        },
      })) as unknown as Record<string, unknown>;
    } finally {
      clearInterval(poll);
    }
  };

  return {
    [SUBTITLE_JOB_TYPES.run]: execute(false),
    [SUBTITLE_JOB_TYPES.resume]: execute(true),
    [SUBTITLE_JOB_TYPES.sync]: syncHandler,
    [SUBTITLE_JOB_TYPES.reconcile]: async ({ isCancelled, reportProgress }) => {
      const uncertain = await repository.uncertainAttempts();
      let examined = 0;
      for (const record of uncertain) {
        if (await isCancelled()) break;
        await service.run(record.id, { isCancelled });
        examined++;
        await reportProgress(0, "Reconciling subtitle attempts", {
          phase: "catalogue",
          measure: {
            kind: "exact",
            completed: examined,
            total: uncertain.length,
            unit: "items",
          },
        });
      }
      return { examined };
    },
  };
}
