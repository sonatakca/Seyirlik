import type { JOB_TYPES } from "./jobHandlers";

type LibraryJobType = (typeof JOB_TYPES)[keyof typeof JOB_TYPES];

/**
 * Work that finishes in seconds and that somebody is usually waiting to see.
 *
 * The library lane runs three jobs at once and takes every light type, and a
 * subtitle search can hold a slot for minutes while it downloads and measures
 * candidates. Three of those filled the lane and a library scan pressed from
 * the dashboard sat "queued" behind them, along with the twenty searches after
 * them, though it needed a second of the server's time.
 *
 * These types get two things the rest do not:
 *
 * - a lane of their own (`workerRole.ts`), one slot that claims nothing else,
 *   so one of them can always start on the next poll;
 * - a default priority just ahead of the default, so a library slot that frees
 *   up takes them before the backlog too.
 *
 * Only work that is short by construction belongs here. A metadata scan of a
 * whole library or a probe batch over Drive can run for minutes, and putting
 * one in this lane would hold the very slot it exists to keep free. The
 * maintenance pass qualifies because it never waits: it queues its stage and
 * schedules its next look (`runAfter`) instead of blocking on it.
 *
 * Type-only import, so the names are checked against `JOB_TYPES` without the
 * queue loading every handler at runtime.
 */
export const QUICK_JOB_TYPES: readonly LibraryJobType[] = [
  "library.scan",
  "metadata.refresh",
  "library.maintenance",
];

/** The queue's default; lower runs first. */
export const DEFAULT_JOB_PRIORITY = 100;

/**
 * Ahead of the default, and still behind the "all in one" pass (90), which
 * must keep its place ahead of the scans it schedules.
 */
export const QUICK_JOB_PRIORITY = 95;

/** The priority a job gets when its caller does not choose one. */
export function defaultJobPriority(jobType: string): number {
  return (QUICK_JOB_TYPES as readonly string[]).includes(jobType)
    ? QUICK_JOB_PRIORITY
    : DEFAULT_JOB_PRIORITY;
}
