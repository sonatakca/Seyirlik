/**
 * Whether an encode workspace may still be needed, decided from its job.
 *
 * A workspace lives at `<jobsRoot>/<processing job id>`, and only a retry of
 * that same job row ever resumes from it: the retry route re-queues the row it
 * was asked about, and a new job for the same title gets a new id and a new
 * workspace. So the question is never how old a directory is. It is whether
 * that row can still be retried into its workspace with any purpose.
 *
 * - A pending, queued, running or paused job owns its workspace outright.
 *   A paused job may be waiting weeks for a drive, and its checkpoints are the
 *   most expensive thing on the volume.
 * - A failed or cancelled job used to own its workspace for ever, "for retry".
 *   On the laptop that does the encoding this kept 66 GB of dead attempts on a
 *   927 GB disk and filled it, failing two finished 4K encodes at publication.
 *   Such a workspace is now released when nothing will resume from it:
 *   - a later attempt for the same item and profile has succeeded, so the
 *     title is published and this attempt is history;
 *   - the job was cancelled, by a person, more than a grace period ago;
 *   - the job failed and nobody has retried it within the retention period.
 *   A retry after that still works. It starts the encode again from nothing.
 * - Any state this code does not know keeps its workspace (fail closed).
 */

import type { ProcessingJobRecord } from "./jobStore";

export interface WorkspaceRetentionPolicy {
  /** How long a cancelled job's workspace survives, for an "undo". */
  cancelledGraceMs: number;
  /** How long a failed job's workspace waits for a retry. */
  failedRetentionMs: number;
}

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

export const DEFAULT_WORKSPACE_RETENTION: WorkspaceRetentionPolicy = {
  cancelledGraceMs: DAY,
  failedRetentionMs: 7 * DAY,
};

/**
 * The policy, with `SEYIRLIK_FAILED_WORKSPACE_RETENTION_DAYS` and
 * `SEYIRLIK_CANCELLED_WORKSPACE_GRACE_HOURS` able to lengthen or shorten it.
 * A value that is not a positive number is ignored rather than read as zero,
 * since zero would release a workspace the moment its job failed.
 */
export function workspaceRetentionFromEnvironment(
  env: Record<string, string | undefined> = process.env,
): WorkspaceRetentionPolicy {
  const positive = (value: string | undefined): number | undefined => {
    const parsed = Number(value);
    return value !== undefined && Number.isFinite(parsed) && parsed > 0
      ? parsed
      : undefined;
  };
  const days = positive(env.SEYIRLIK_FAILED_WORKSPACE_RETENTION_DAYS);
  const hours = positive(env.SEYIRLIK_CANCELLED_WORKSPACE_GRACE_HOURS);
  return {
    failedRetentionMs:
      days === undefined
        ? DEFAULT_WORKSPACE_RETENTION.failedRetentionMs
        : days * DAY,
    cancelledGraceMs:
      hours === undefined
        ? DEFAULT_WORKSPACE_RETENTION.cancelledGraceMs
        : hours * HOUR,
  };
}

export type WorkspaceClaim =
  | { claimed: true; reason: string }
  | { claimed: false; reason: string };

const LIVE_STATES = new Set(["pending", "queued", "running", "paused"]);

export type WorkspaceJob = Pick<
  ProcessingJobRecord,
  | "id"
  | "itemId"
  | "profile"
  | "state"
  | "createdAt"
  | "updatedAt"
  | "finishedAt"
>;

export async function workspaceClaim({
  job,
  laterAttemptSucceeded,
  policy = DEFAULT_WORKSPACE_RETENTION,
  now = Date.now(),
}: {
  /** The job the workspace is named after, read fresh; null if it is gone. */
  job: WorkspaceJob | null;
  /** Whether a later attempt for the same title and profile succeeded. */
  laterAttemptSucceeded: (jobId: string) => Promise<boolean>;
  policy?: WorkspaceRetentionPolicy;
  now?: number;
}): Promise<WorkspaceClaim> {
  if (!job) return { claimed: false, reason: "no job answers to it" };
  if (LIVE_STATES.has(job.state)) {
    return { claimed: true, reason: `its job is ${job.state}` };
  }
  if (job.state === "succeeded") {
    return { claimed: false, reason: "its job succeeded" };
  }
  if (job.state !== "failed" && job.state !== "cancelled") {
    return { claimed: true, reason: `its job is in an unknown state` };
  }

  if (await laterAttemptSucceeded(job.id)) {
    return {
      claimed: false,
      reason: `its job is ${job.state} and a later attempt for the same title succeeded`,
    };
  }

  // The last moment anyone or anything touched the row: a retry, a cancel,
  // the failure itself.
  const touchedMs = Math.max(
    job.updatedAt.getTime(),
    job.finishedAt?.getTime() ?? 0,
  );
  const idleMs = Math.max(0, now - touchedMs);
  const limitMs =
    job.state === "cancelled"
      ? policy.cancelledGraceMs
      : policy.failedRetentionMs;
  if (idleMs >= limitMs) {
    return {
      claimed: false,
      reason: `its job was ${job.state} ${Math.floor(idleMs / HOUR)} h ago and nobody retried it`,
    };
  }
  return {
    claimed: true,
    reason: `its job is ${job.state}, kept for a retry for ${Math.ceil((limitMs - idleMs) / HOUR)} h more`,
  };
}
