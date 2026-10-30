import type { ProcessingJob } from "../../lib/processingApi";

/**
 * The queue tab's own logic, kept out of the component.
 *
 * Three questions live here: which half of the tab a job belongs in, what
 * order the waiting ones are actually in, and what a drag would leave behind.
 * All three are pure and none of them touch the network, which is what lets a
 * page polling once a second re-sort without the row under the operator's
 * cursor jumping somewhere else.
 */

/** The two halves of the Processes tab. */
export type ProcessingOutcomeTab = "active" | "finished";

export const PROCESSING_OUTCOME_TABS: readonly ProcessingOutcomeTab[] = [
  "active",
  "finished",
];

const CONCLUDED_STATES: ReadonlySet<ProcessingJob["state"]> = new Set([
  "succeeded",
  "failed",
  "cancelled",
]);

/**
 * True once nothing more will happen to this job on its own.
 *
 * A retry creates a fresh attempt on the same row, so this is a statement
 * about now rather than for ever — which is exactly what a tab labelled
 * "concluded" claims.
 */
export function isConcluded(job: Pick<ProcessingJob, "state">): boolean {
  return CONCLUDED_STATES.has(job.state);
}

/**
 * True while a job is being held rather than waiting its turn.
 *
 * Two things make a job held, and both have to be read. The first is the
 * state, which a runner writes when it picks a job up and puts it straight
 * back down. The second is a pause that has only been *asked* for: `state`
 * turns `paused` when a worker reaches the job, and a worker draining one
 * encode at a time may not reach a queued job for hours. Until then the hold
 * lives in the request alone — and reading the state by itself left every job
 * an operator had paused sitting in the waiting band, numbered as though it
 * were next, while nothing was ever going to start it.
 *
 * The exception is the volume going away. That pause lifts itself when the
 * drive comes back, so the job is waiting for the disk rather than for a
 * person; it is still in the line, and its card already carries the storage
 * panel that says what it is waiting for.
 */
function isHeld(
  job: Pick<ProcessingJob, "state" | "pauseRequested" | "pausedReason">,
): boolean {
  if (job.state === "paused") return true;
  return job.pauseRequested && job.pausedReason !== "storage-unavailable";
}

/**
 * The band of the queue a job sits in: running, then waiting, then held.
 *
 * The three read as a sentence about the machine — what it is doing, what it
 * will do next, and what it has set aside. A held job still owns the encoder
 * and its workspace, but it is not going to advance until somebody or the
 * storage guard says so, so it sits below the line rather than above it. A job
 * that has merely been *asked* to pause is still `running` and stays in the
 * top band until the encoder actually stops — which is why the running check
 * comes first and the hold is asked about second.
 */
const RUNNING_BAND = 0;
const WAITING_BAND = 1;
const HELD_BAND = 2;

function queueBand(
  job: Pick<ProcessingJob, "state" | "pauseRequested" | "pausedReason">,
): number {
  if (job.state === "running") return RUNNING_BAND;
  if (isHeld(job)) return HELD_BAND;
  return WAITING_BAND;
}

/**
 * Whether this row can be dragged.
 *
 * The server hands back a position only for a job that is genuinely still
 * waiting; a claimed attempt and a finished one both report `null`. Reading
 * the position rather than the state is deliberate — the state says what the
 * job is doing, and only the queue row knows whether moving it would still
 * mean anything by the time the request lands.
 */
export function canReorder(job: Pick<ProcessingJob, "queuePriority">): boolean {
  return typeof job.queuePriority === "number";
}

function byCreatedAtAscending(
  left: Pick<ProcessingJob, "createdAt">,
  right: Pick<ProcessingJob, "createdAt">,
): number {
  const difference = Date.parse(left.createdAt) - Date.parse(right.createdAt);
  // An unparseable timestamp yields NaN, and a NaN comparator scrambles the
  // list. Falling back to "equal" leaves the pair where the sort found them.
  return Number.isFinite(difference) ? difference : 0;
}

/**
 * The waiting line, in the order the machine will actually work through it.
 *
 * The encodes that are running come first — they are the only rows on this
 * page that are happening rather than pending — then the jobs waiting their
 * turn, by the position the queue holds for them, and last the paused ones,
 * which will not advance until they are resumed. Jobs the server gave no
 * position to sort last within their own band by age rather than being
 * dropped: a job whose attempt is missing is still work somebody queued, and
 * hiding it is how a stuck row goes unnoticed.
 */
export function orderQueue(jobs: readonly ProcessingJob[]): ProcessingJob[] {
  return [...jobs].sort((left, right) => {
    const leftBand = queueBand(left);
    const rightBand = queueBand(right);
    if (leftBand !== rightBand) return leftBand - rightBand;
    // Running jobs hold no queue position; they read in the order they began.
    if (leftBand === RUNNING_BAND) return byCreatedAtAscending(left, right);

    const leftPlace = left.queuePriority;
    const rightPlace = right.queuePriority;
    const leftPlaced = typeof leftPlace === "number";
    const rightPlaced = typeof rightPlace === "number";
    if (leftPlaced !== rightPlaced) return leftPlaced ? -1 : 1;
    if (leftPlaced && rightPlaced && leftPlace !== rightPlace) {
      return leftPlace - rightPlace;
    }
    return byCreatedAtAscending(left, right);
  });
}

/**
 * Finished jobs, newest first.
 *
 * The opposite of the queue on purpose: a waiting list reads forwards because
 * the top of it is what happens next, and a history reads backwards because
 * the top of it is what just happened. `finishedAt` can be missing on a row
 * whose worker vanished, so the creation time stands in rather than sinking it
 * to the bottom.
 */
export function orderHistory(jobs: readonly ProcessingJob[]): ProcessingJob[] {
  const endedAt = (job: ProcessingJob) =>
    Date.parse(job.finishedAt ?? job.createdAt);
  return [...jobs].sort((left, right) => endedAt(right) - endedAt(left));
}

/** The tab a job belongs in, and the order it is shown in there. */
export function partitionProcessingJobs(jobs: readonly ProcessingJob[]): {
  active: ProcessingJob[];
  finished: ProcessingJob[];
} {
  const active: ProcessingJob[] = [];
  const finished: ProcessingJob[] = [];
  for (const job of jobs) (isConcluded(job) ? finished : active).push(job);
  return { active: orderQueue(active), finished: orderHistory(finished) };
}

/**
 * The list after a row has been picked up and put down somewhere else.
 *
 * Returns the same array when nothing would change, so a drag that ends where
 * it started cannot start a request. Out-of-range indices are clamped rather
 * than rejected: a drop onto the empty space past the last row means "last",
 * which is what the pointer was over.
 */
export function moveItem<T>(
  items: readonly T[],
  from: number,
  to: number,
): T[] {
  if (from < 0 || from >= items.length) return [...items];
  const target = Math.min(Math.max(to, 0), items.length - 1);
  if (target === from) return [...items];
  const next = [...items];
  const [moved] = next.splice(from, 1);
  next.splice(target, 0, moved);
  return next;
}

/**
 * The queue as the operator last left it, on top of what the server last said.
 *
 * A drag is answered by a request and a refresh, and the page polls in between;
 * without this, a poll landing in that gap would snap the row back to where it
 * was dragged from and then forward again a second later. Rows the override
 * does not name keep the slot the server gave them, so a job queued during the
 * drag, and the encode that is running, both stay where they belong.
 */
export function applyQueueOverride(
  ordered: readonly ProcessingJob[],
  override: readonly string[] | null,
): ProcessingJob[] {
  if (!override || override.length === 0) return [...ordered];
  const named = new Set(override);
  const byId = new Map(ordered.map((job) => [job.id, job]));
  /*
   * The override rearranges the rows it names *within the slots those rows
   * already occupy*. Sorting the whole list by it instead would sink every row
   * it does not mention — the encode that is running, above all — to the
   * bottom, which is the one position it can never be in.
   */
  const moved = override
    .map((id) => byId.get(id))
    .filter((job): job is ProcessingJob => job !== undefined);
  let taken = 0;
  return ordered.map((job) =>
    named.has(job.id) ? (moved[taken++] ?? job) : job,
  );
}

/**
 * A reordered head of the queue, followed by the rest of it as it was.
 *
 * The page draws only part of a long queue, and a drag can only measure what
 * is drawn. Sending that part alone would leave the server to place every
 * other job by whatever position it last had, so the jobs the drag did not
 * name follow it, in their existing order.
 */
export function completeQueueOrder(
  reordered: readonly string[],
  queue: readonly string[],
): string[] {
  const named = new Set(reordered);
  return [...reordered, ...queue.filter((id) => !named.has(id))];
}
