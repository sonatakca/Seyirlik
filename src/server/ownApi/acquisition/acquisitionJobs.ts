/**
 * Acquisition work on the existing job queue.
 *
 * Deliberately not a second background system. The queue already has durable
 * leases, heartbeats and restart recovery, and an acquisition that survives a
 * service restart is exactly what those were built for.
 *
 * Two handlers only. One hands a chosen release to SABnzbd; the other brings
 * every active acquisition back into agreement with it. Everything else —
 * retries, fallbacks, completion — is a consequence of those two running
 * again, which is what makes the pair safe to re-run at any moment.
 */
import type { JobHandler } from "../tasks/worker";
import { PermanentJobError } from "../tasks/worker";
import type { AcquisitionService } from "./acquisitionService";
import type { AcquisitionRepository } from "./acquisitionRepository";
import {
  dispositionFor,
  planRetry,
  type FailureClass,
} from "./acquisitionState";
import {
  MAX_AUTOMATIC_REPLACEMENTS,
  type AcquisitionFallback,
} from "./acquisitionFallback";
import type { BlocklistRepository } from "../releases/blocklistRepository";
import type { JobQueue } from "../tasks/jobQueue";

export const ACQUISITION_JOB_TYPES = {
  submit: "acquisition.submit",
  reconcile: "acquisition.reconcile",
  /** Chooses and starts the next release for one that cannot complete. */
  replace: "acquisition.replace",
} as const;

/**
 * One queued submission per acquisition.
 *
 * The queue collapses this onto a job that is queued or already running, so
 * asking twice cannot put the same release in front of two workers. It does
 * not collapse onto a finished job, which is what leaves a retry free to run.
 */
export function submitDedupeKey(acquisitionId: string): string {
  return `${ACQUISITION_JOB_TYPES.submit}:${acquisitionId}`;
}

/**
 * What automatic recovery needs: replacing a release that cannot complete,
 * and submitting again one whose retry is due. Absent, both wait for an
 * operator, which is how it always worked.
 */
export interface AutomaticReplacement {
  readonly fallback: AcquisitionFallback;
  readonly blocklist: BlocklistRepository;
  readonly queue: JobQueue;
}

export function createAcquisitionJobHandlers(
  service: AcquisitionService,
  repository: AcquisitionRepository,
  automatic?: AutomaticReplacement,
): Record<string, JobHandler> {
  const submit: JobHandler = async ({ job, reportProgress }) => {
    const acquisitionId = job.payload.acquisitionId;
    if (typeof acquisitionId !== "string") {
      throw new PermanentJobError("The task payload names no acquisition.");
    }
    await reportProgress(0, "Handing the release to the download client");
    await service.submit(acquisitionId);
    const after = await repository.get(acquisitionId);
    // A deleted acquisition is not a transient fault; retrying cannot make it
    // exist, and the job queue would otherwise keep trying.
    if (!after)
      throw new PermanentJobError("The acquisition no longer exists.");
    return {
      state: after.state,
      ...(after.externalId ? { externalId: after.externalId } : {}),
    };
  };

  const reconcile: JobHandler = async ({ reportProgress }) => {
    await reportProgress(0, "Reconciling downloads");
    const result = await service.reconcile();

    /*
     * Reconciliation only records what SABnzbd says. Deciding what to do about
     * a failure happens here, once, after the facts are in — so a row cannot
     * be retried by the reconciler and by a failure handler at the same time.
     */
    let retried = 0;
    let abandoned = 0;
    let resubmitted = 0;
    for (const record of await repository.list(200)) {
      if (record.state === "awaiting_retry") {
        /*
         * Its time has come, so it is submitted again. Nothing else picks a
         * waiting row up, and without this it would wait forever while the
         * page promised a retry. A row with no time is due now.
         */
        if (
          automatic &&
          (record.retryAfterMs === undefined ||
            record.retryAfterMs <= Date.now())
        ) {
          await automatic.queue.enqueue({
            jobType: ACQUISITION_JOB_TYPES.submit,
            payload: { acquisitionId: record.id },
            dedupeKey: submitDedupeKey(record.id),
          });
          resubmitted += 1;
        }
        continue;
      }
      if (record.state !== "failed" || !record.failureClass) continue;
      const failure = record.failureClass as FailureClass;
      if (dispositionFor(failure) === "terminal") continue;
      const plan = planRetry(failure, record.attempt);
      if (plan.action === "retry") {
        if (
          await repository.update(
            record.id,
            "failed",
            {
              state: "awaiting_retry",
              retryAfterMs: Date.now() + plan.delayMs,
            },
            plan.detail,
          )
        ) {
          retried += 1;
        }
      } else if (plan.action === "try-another-release") {
        /*
         * Not chosen here. Choosing the next candidate means running a search
         * and the decision engine again, which belongs to its own job — so a
         * slow indexer cannot hold up the reconciler, and a job that fails is
         * retried by the queue without the reconciler deciding anything.
         * The key collapses the request every tick makes onto the one job.
         */
        if (automatic) {
          await automatic.queue.enqueue({
            jobType: ACQUISITION_JOB_TYPES.replace,
            payload: { acquisitionId: record.id },
            dedupeKey: `${ACQUISITION_JOB_TYPES.replace}:${record.id}`,
          });
        }
        abandoned += 1;
      }
    }
    return {
      ...result,
      retried,
      resubmitted,
      awaitingAlternative: abandoned,
    };
  };

  /**
   * Replaces a release that will never complete with the next acceptable one.
   *
   * The search runs before anything is changed, so an unreachable indexer
   * fails this job (and the queue retries it) while the acquisition stays
   * exactly as SABnzbd left it. Only once there is an answer is the release
   * blocklisted, its SABnzbd job and partial files removed, and the
   * replacement started. A title gets at most `MAX_AUTOMATIC_REPLACEMENTS`;
   * after that, or when nothing acceptable is left, the acquisition stays
   * failed and blocklisted for an operator to decide.
   */
  const replace: JobHandler = async ({ job, reportProgress }) => {
    if (!automatic) {
      throw new PermanentJobError("Automatic replacement is not configured.");
    }
    const acquisitionId = job.payload.acquisitionId;
    if (typeof acquisitionId !== "string") {
      throw new PermanentJobError("The task payload names no acquisition.");
    }
    const record = await repository.get(acquisitionId);
    if (
      !record ||
      record.state !== "failed" ||
      !record.failureClass ||
      dispositionFor(record.failureClass as FailureClass) !==
        "try-another-release"
    ) {
      // Somebody already dealt with it, by hand or by an earlier run.
      return { skipped: true };
    }

    const giveUp = async (detail: string) => {
      await automatic.blocklist.add({
        indexerId: record.indexerId,
        releaseGuid: record.releaseGuid,
        releaseTitle: record.releaseTitle,
        targetKind: record.targetKind,
        targetTitle: record.targetTitle,
        reason: record.failureClass ?? "unknown",
        acquisitionId,
      });
      await service.blocklist(acquisitionId);
      await repository.update(
        acquisitionId,
        "failed",
        { failureClass: "blocklisted", failureDetail: detail },
        detail,
      );
      return { replaced: false, detail };
    };

    const context = await repository.searchContext(acquisitionId);
    const policy = context?.profileId
      ? await automatic.fallback.policyFor(context.profileId)
      : null;
    if (!context || !policy) {
      return giveUp(
        "No quality profile is recorded for it, so another release cannot be chosen automatically.",
      );
    }
    if (
      (await repository.replacementsFor(acquisitionId)) >=
      MAX_AUTOMATIC_REPLACEMENTS
    ) {
      return giveUp(
        `${MAX_AUTOMATIC_REPLACEMENTS} replacements have already failed for this title; choose another release by hand.`,
      );
    }

    await reportProgress(0.2, "Searching for another release");
    const choice = await automatic.fallback.choose(context.target, policy, {
      indexerId: record.indexerId,
      releaseGuid: record.releaseGuid,
    });
    if (choice.kind === "none") {
      return giveUp("Searched again automatically; nothing else acceptable.");
    }

    await automatic.blocklist.add({
      indexerId: record.indexerId,
      releaseGuid: record.releaseGuid,
      releaseTitle: record.releaseTitle,
      targetKind: record.targetKind,
      targetTitle: record.targetTitle,
      reason: record.failureClass,
      acquisitionId,
    });
    // Marks it blocklisted and removes its SABnzbd job and partial files.
    await service.blocklist(acquisitionId);
    const applied = await automatic.fallback.apply(
      acquisitionId,
      choice,
      policy,
    );
    return {
      replaced: applied !== null,
      created: applied?.created.length ?? 0,
      ...(choice.kind === "episodes"
        ? { episodes: choice.picks.length, missingEpisodes: choice.missing }
        : {}),
    };
  };

  return {
    [ACQUISITION_JOB_TYPES.submit]: submit,
    [ACQUISITION_JOB_TYPES.reconcile]: reconcile,
    [ACQUISITION_JOB_TYPES.replace]: replace,
  };
}
