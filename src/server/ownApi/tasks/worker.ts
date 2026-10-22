import { randomUUID } from "node:crypto";
import type { ClaimFilter, JobQueue, JobRecord } from "./jobQueue";
import type { MaintenanceProgressInput } from "../../../lib/maintenance/maintenanceTasks";

export interface JobContext {
  job: JobRecord;
  /**
   * What the job is doing.
   *
   * The fraction and the sentence are the long-standing pair the notification
   * cards read. `detail` is the structured truth beside them: which phase,
   * measured how, with which counters. A handler that has one passes it, and
   * the revision that orders it against every other report of this attempt is
   * added here rather than being one more thing each handler has to carry.
   */
  reportProgress(
    progress: number,
    message?: string,
    detail?: MaintenanceProgressInput,
  ): Promise<void>;
  isCancelled(): Promise<boolean>;
}

export type JobHandler = (
  context: JobContext,
) => Promise<Record<string, unknown> | void>;

/**
 * A group of job types that share a resource, and how many of them may run at
 * once.
 *
 * The reason lanes exist is that "the queue" is not one resource. A media
 * encode holds the machine's encoder for hours; a library scan reads
 * directories. Draining both from one serial loop meant a scan queued behind
 * an encode waited for the encode — not because the two conflict, but because
 * one loop claimed them in turn.
 *
 * A lane is deliberately not a scheduler: it is a claim filter plus a count.
 * Ordering, leasing, retry and cancellation all stay in PostgreSQL, and two
 * lanes can never take the same row because every claim is still the same
 * `FOR UPDATE SKIP LOCKED` statement.
 */
export interface WorkerLane extends ClaimFilter {
  name: string;
  /** How many jobs of this lane may run concurrently in this process. */
  concurrency: number;
}

export interface WorkerOptions {
  queue: JobQueue;
  handlers: Record<string, JobHandler>;
  /** How long a claimed job stays leased without a heartbeat. */
  leaseMs?: number;
  pollIntervalMs?: number;
  /**
   * Defaults to one lane taking everything, one at a time — exactly the
   * behaviour a worker had before lanes existed, so a caller that does not
   * care about resources is unaffected.
   */
  lanes?: WorkerLane[];
  logger?: {
    info(event: string, context: Record<string, unknown>): void;
    error?(event: string, context: Record<string, unknown>): void;
  };
}

const DEFAULT_LEASE_MS = 60_000;
const DEFAULT_POLL_INTERVAL_MS = 2_000;
const SINGLE_LANE: WorkerLane[] = [{ name: "default", concurrency: 1 }];

/**
 * Error text that reaches an operator dashboard must never carry a filesystem
 * path, a command line, or a connection string.
 */
export function sanitizeJobError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message
      .split("\n", 1)[0]
      /*
       * Quoted paths first, and to the closing quote.
       *
       * Every Node `fs` error names its path inside quotes, and the rule below
       * only ever matched a path introduced by whitespace — so every one of
       * them survived, and 243 sheet jobs carried `mkdir '/Volumes/Expansion'`
       * to the dashboard before anybody noticed. The quote is also the only
       * delimiter that works: a real media path has spaces in it, so a rule
       * that stops at whitespace leaves `Dune (2021)/video` standing.
       */
      ?.replace(/(['"`])(?:[A-Za-z]:)?[\\/][^'"`]*\1/g, " ")
      // Then the unquoted ones.
      .replace(/(^|\s)(?:[A-Za-z]:)?[\\/]\S*/g, " ")
      .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S*/gi, " ")
      .replace(/\s{2,}/g, " ")
      .trim()
      .slice(0, 480) || "The task failed."
  );
}

/**
 * A job whose failure is deterministic — a malformed payload, a deleted
 * library — should not burn its remaining attempts.
 */
export class PermanentJobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermanentJobError";
  }
}

/**
 * A job that never started because something outside it was not ready.
 *
 * Neither a success nor a failure, and importantly not an attempt: an absent
 * volume answers `mkdir` in microseconds, so a queue that treated "the disk is
 * not here" as a failure could spend every attempt of every queued title before
 * anybody noticed the drive had been unplugged. The handler says when to look
 * again, and the row goes back to `queued` with its attempts intact.
 */
export class DeferredJobError extends Error {
  readonly retryAfterMs: number;

  constructor(message: string, retryAfterMs: number) {
    super(message);
    this.name = "DeferredJobError";
    this.retryAfterMs = retryAfterMs;
  }
}

/** What a release hand-off needs from a running worker. */
export type WorkerControl = Pick<
  ReturnType<typeof createWorker>,
  "pause" | "resume" | "whenIdle" | "activeJobs"
>;

export function createWorker({
  queue,
  handlers,
  leaseMs = DEFAULT_LEASE_MS,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  lanes = SINGLE_LANE,
  logger,
}: WorkerOptions) {
  const leaseOwner = `${process.pid}-${randomUUID().slice(0, 8)}`;
  let running = false;
  let stopping = false;
  /*
   * Paused: take nothing new, finish what is held. What a release hand-off
   * waits on (`releaseHandoff.ts`), and unlike `stop` it is undone by
   * `resume` — the lane loops keep their timers and simply come back empty.
   */
  let paused = false;
  /*
   * Everything this process holds, counted from the moment a claim is asked
   * for. A claim in flight is counted too: its row can come back after the
   * pause, and "idle" announced in that gap would let the process exit with a
   * job it had just taken.
   */
  const active = new Map<string, JobRecord>();
  let claiming = 0;
  let idleWaiters: Array<() => void> = [];

  function isIdle(): boolean {
    return claiming === 0 && active.size === 0;
  }

  function settle(): void {
    if (!isIdle()) return;
    const waiters = idleWaiters;
    idleWaiters = [];
    for (const resolve of waiters) resolve();
  }

  /*
   * Only the types this process has a handler for.
   *
   * A lane used to claim "everything except" its neighbours' types, which
   * made any type added after this release this release's to fail: "No
   * handler is registered", permanently, while a newer worker that could run
   * it sat beside it. Releases now overlap — an older worker finishes its job
   * after a newer server is already enqueueing — so an unknown type is left
   * queued for a worker that knows it.
   */
  function claimFilter(lane: WorkerLane): ClaimFilter {
    const excluded = new Set(lane.excludeJobTypes ?? []);
    return {
      jobTypes: (lane.jobTypes ?? Object.keys(handlers)).filter(
        (type) =>
          Object.prototype.hasOwnProperty.call(handlers, type) &&
          !excluded.has(type),
      ),
    };
  }
  /*
   * One timer per lane slot, plus one for lease reclamation.
   *
   * Deliberately not a single shared timer. A lane that is busy for hours must
   * not decide when the other lanes next look at the queue — see `start`.
   */
  const timers = new Set<NodeJS.Timeout>();

  async function runOne(job: JobRecord): Promise<void> {
    const handler = handlers[job.jobType];
    if (!handler) {
      await queue.fail(
        job.id,
        leaseOwner,
        "No handler is registered for this task.",
        false,
      );
      return;
    }

    /*
     * One counter per attempt, owned here.
     *
     * It is what lets a reader put two reports of the same attempt in order
     * without trusting when they arrived — and the attempt is the right scope
     * because a claim clears the stored snapshot, so a retry starts from one
     * again with nothing older to be confused with.
     */
    let revision = 0;

    // Keep the lease alive for the length of the job so a long scan is not
    // reclaimed underneath itself.
    const heartbeat = setInterval(
      () => {
        void queue
          .heartbeat(job.id, leaseOwner, leaseMs)
          .catch(() => undefined);
      },
      Math.max(1_000, Math.floor(leaseMs / 3)),
    );
    heartbeat.unref();

    try {
      const result = await handler({
        job,
        reportProgress: (progress, message, detail) => {
          revision += 1;
          return queue.reportProgress(
            job.id,
            progress,
            message,
            detail
              ? { ...detail, revision, at: new Date().toISOString() }
              : undefined,
          );
        },
        isCancelled: () => queue.isCancellationRequested(job.id),
      });
      /*
       * A handler that stopped because it was asked to did not finish, and the
       * history has to be able to say which of the two happened. The handler
       * is the only thing that knows: it says so by returning `cancelled`, and
       * a run that reached the end of its work reports success even if a
       * cancellation arrived while it was writing the last row.
       */
      if (result?.cancelled === true) {
        await queue.concludeCancelled(job.id, leaseOwner, result);
        logger?.info("job.cancelled", { jobId: job.id, jobType: job.jobType });
        return;
      }
      await queue.complete(job.id, leaseOwner, result ?? undefined);
      logger?.info("job.completed", { jobId: job.id, jobType: job.jobType });
    } catch (error) {
      /*
       * Checked before the failure path, because a deferral must not reach it.
       * `fail` spends an attempt even when it requeues, which is the whole
       * thing a deferral exists to avoid.
       */
      if (error instanceof DeferredJobError) {
        await queue.defer(
          job.id,
          leaseOwner,
          error.retryAfterMs,
          sanitizeJobError(error),
        );
        logger?.info("job.deferred", {
          jobId: job.id,
          jobType: job.jobType,
          retryAfterMs: error.retryAfterMs,
        });
        return;
      }
      const retry = !(error instanceof PermanentJobError);
      await queue.fail(job.id, leaseOwner, sanitizeJobError(error), retry);
      logger?.error?.("job.failed", {
        jobId: job.id,
        jobType: job.jobType,
        retry,
      });
    } finally {
      clearInterval(heartbeat);
    }
  }

  /**
   * One slot of one lane, draining until the lane has nothing left.
   *
   * Draining rather than taking one job per interval keeps a queued backlog
   * from being paced by the poll interval; the claim filter keeps this slot
   * from taking work that belongs to another lane's resource.
   */
  async function drainLane(lane: WorkerLane): Promise<void> {
    const filter = claimFilter(lane);

    for (;;) {
      if (stopping || paused) return;
      let job: JobRecord | null = null;
      claiming += 1;
      try {
        job = await queue.claim(leaseOwner, leaseMs, filter);
        if (job) active.set(job.id, job);
      } finally {
        claiming -= 1;
        if (!job) settle();
      }
      if (!job) return;
      try {
        await runOne(job);
      } finally {
        active.delete(job.id);
        settle();
      }
    }
  }

  /** Every slot of every lane, as independent units of work. */
  function laneSlots(): WorkerLane[] {
    return lanes.flatMap((lane) =>
      Array.from({ length: Math.max(1, lane.concurrency) }, () => lane),
    );
  }

  async function reclaim(): Promise<void> {
    try {
      await queue.reclaimExpiredLeases();
    } catch (error) {
      logger?.error?.("job.poll.failed", { message: sanitizeJobError(error) });
    }
  }

  /**
   * One drain pass over every lane at once, for tests and the one-shot CLI.
   *
   * Not what `start` uses: this resolves only when the slowest lane is done,
   * which is exactly the coupling the running worker must not have.
   */
  async function tick(): Promise<void> {
    if (stopping) return;
    await reclaim();

    // A lane that fails — a database blip on its claim — must not take the
    // others down with it, so each slot catches for itself.
    await Promise.all(
      laneSlots().map((lane) =>
        drainLane(lane).catch((error: unknown) => {
          logger?.error?.("job.poll.failed", {
            lane: lane.name,
            message: sanitizeJobError(error),
          });
        }),
      ),
    );
  }

  /**
   * Re-runs `work` for as long as the worker is running, waiting
   * `pollIntervalMs` between passes.
   *
   * Scheduled from a `finally`, so the loop survives whatever the last pass
   * hit: a throw from a logger or a handler registry used to stop background
   * work for the lifetime of the process and reject into nothing, which Node
   * ends the process for.
   */
  function poll(work: () => Promise<void>): void {
    const loop = async (): Promise<void> => {
      try {
        await work();
      } catch (error) {
        logger?.error?.("job.loop.failed", {
          message: sanitizeJobError(error),
        });
      } finally {
        if (!stopping) {
          const timer = setTimeout(() => {
            timers.delete(timer);
            void loop();
          }, pollIntervalMs);
          timer.unref();
          timers.add(timer);
        }
      }
    };
    void loop();
  }

  return {
    leaseOwner,

    start(): void {
      if (running) return;
      running = true;
      stopping = false;

      /*
       * Every lane slot polls on its own clock, and this is the whole point of
       * lanes.
       *
       * One shared loop that awaited all of them looked equivalent and was
       * not: the library lane drained in milliseconds and then waited for the
       * media lane before the next poll was even scheduled. An encode holds
       * its slot for hours, so a scan queued one minute in sat untouched until
       * that encode finished — the same symptom lanes were added to remove,
       * arriving by a different route.
       *
       * Reclaiming expired leases gets its own loop for the same reason: it is
       * how a crashed worker's jobs come back, and it must not be paced by the
       * longest-running job on this one.
       */
      poll(reclaim);
      for (const lane of laneSlots()) poll(() => drainLane(lane));
    },

    async stop(): Promise<void> {
      stopping = true;
      running = false;
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
    },

    /** Take no new job; the ones held run to their end. */
    pause(): void {
      paused = true;
    },

    resume(): void {
      paused = false;
    },

    /** Resolves once nothing is held and no claim is in flight. */
    whenIdle(): Promise<void> {
      if (isIdle()) return Promise.resolve();
      return new Promise((resolve) => idleWaiters.push(resolve));
    },

    /** What this process holds now, for saying what a hand-off waits on. */
    activeJobs(): Array<Pick<JobRecord, "id" | "jobType">> {
      return [...active.values()].map(({ id, jobType }) => ({ id, jobType }));
    },

    /** Runs a single drain pass; used by tests and the one-shot CLI. */
    runPending: tick,
  };
}
