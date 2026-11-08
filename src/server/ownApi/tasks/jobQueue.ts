import { randomUUID } from "node:crypto";
import type { DatabasePool } from "../database/databasePool";
import { defaultJobPriority } from "./quickJobs";
import {
  parseMaintenanceProgress,
  type MaintenanceProgress,
} from "../../../lib/maintenance/maintenanceTasks";

/**
 * Durable job queue backed by PostgreSQL.
 *
 * PostgreSQL is the only correctness-bearing store here on purpose: a lease
 * with an expiry means a worker that crashes mid-scan releases its job without
 * anyone noticing, and no broker has to be installed next to the media volume.
 */

export type JobStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

export interface JobRecord {
  id: string;
  jobType: string;
  payload: Record<string, unknown>;
  status: JobStatus;
  attempts: number;
  maxAttempts: number;
  progress: number;
  progressMessage: string | null;
  /**
   * What the handler last said it was doing, in structured form.
   *
   * Null for a handler that reports no structured progress, and null again
   * from the moment the row is claimed: it describes the attempt underway, not
   * the one before it.
   */
  progressDetail: MaintenanceProgress | null;
  safeError: string | null;
  result: Record<string, unknown> | null;
  cancellationRequested: boolean;
  /** Where this row sits in the claim order. Lower runs sooner. */
  priority: number;
  queuedAt: Date;
  /** The row is not claimable before this; later than now during a backoff. */
  runAfter: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
}

export interface EnqueueOptions {
  jobType: string;
  payload?: Record<string, unknown>;
  priority?: number;
  maxAttempts?: number;
  runAfter?: Date;
  /**
   * Collapses this job onto an existing queued/running job with the same key,
   * so repeatedly pressing "scan library" cannot flood the worker.
   */
  dedupeKey?: string;
}

/**
 * Which job types a claim is allowed to take.
 *
 * A worker runs several lanes at once — one for media encoding, one for
 * everything else — and a lane may only claim its own kind of work. Without
 * this every lane would race for the head of one queue and a library scan
 * would still wait behind an encode that had already filled the media lane.
 */
export interface ClaimFilter {
  /** Claim only these types. */
  jobTypes?: string[];
  /** Claim anything except these types. */
  excludeJobTypes?: string[];
}

export interface JobQueue {
  enqueue(options: EnqueueOptions): Promise<string>;
  claim(
    leaseOwner: string,
    leaseMs: number,
    filter?: ClaimFilter,
  ): Promise<JobRecord | null>;
  heartbeat(
    jobId: string,
    leaseOwner: string,
    leaseMs: number,
  ): Promise<boolean>;
  /**
   * What the job is doing, as a fraction, a sentence, and — where the handler
   * has one — a structured snapshot.
   *
   * The three go into one statement on purpose. Written separately they could
   * be observed disagreeing, which is precisely the failure this whole surface
   * exists to remove. `detail` is only stored when its revision exceeds the one
   * already there, so a slow write cannot walk a counter backwards.
   */
  reportProgress(
    jobId: string,
    progress: number,
    message?: string,
    detail?: MaintenanceProgress,
  ): Promise<void>;
  /**
   * Concludes an attempt this worker still holds the lease on.
   *
   * The lease owner is required rather than implied. A worker whose lease
   * expired has already had its job requeued and possibly re-claimed by
   * somebody else; letting it write a terminal status from there is how a job
   * that is running again is reported as finished, and how a cancelled row
   * comes back as succeeded.
   */
  complete(
    jobId: string,
    leaseOwner: string,
    result?: Record<string, unknown>,
  ): Promise<void>;
  /**
   * Concludes an attempt that stopped because cancellation was requested.
   *
   * Separate from `complete` because "we were told to stop" and "we finished
   * the work" are different facts, and a history that records the first as the
   * second cannot be read afterwards.
   */
  concludeCancelled(
    jobId: string,
    leaseOwner: string,
    result?: Record<string, unknown>,
  ): Promise<void>;
  fail(
    jobId: string,
    leaseOwner: string,
    safeError: string,
    retry: boolean,
  ): Promise<void>;
  /**
   * Puts an attempt back without spending it.
   *
   * Distinct from `fail(retry: true)`, which spends one: a job that never
   * started because a precondition outside it was not met has not failed at
   * anything, and counting it would let a volume that is merely unplugged
   * exhaust an entire queue's attempts in the time it takes `mkdir` to return
   * `EACCES` — which is exactly what 243 sheet jobs did. The claim's increment
   * is given back, so a title can wait out an absence of any length and still
   * arrive with all three of its attempts intact.
   */
  defer(
    jobId: string,
    leaseOwner: string,
    runAfterMs: number,
    reason: string,
  ): Promise<void>;
  requestCancellation(jobId: string): Promise<boolean>;
  isCancellationRequested(jobId: string): Promise<boolean>;
  get(jobId: string): Promise<JobRecord | null>;
  /**
   * The attempt of this type that is still executable, found by what it is
   * *for* rather than by an id somebody wrote down.
   *
   * A durable operation outlives its attempts — a processing job can be
   * queued, parked for storage, and queued again — so the id stored beside it
   * names the last attempt, not necessarily a live one. Asking the queue
   * "is anything still due to run for this?" is the only question whose answer
   * cannot be stale, and it is what stops a second attempt being created for
   * work that already has one.
   */
  findActive(options: {
    jobType: string;
    /** Payload fields the attempt must carry, matched by containment. */
    payload: Record<string, unknown>;
  }): Promise<JobRecord | null>;
  observationTime(): Promise<string>;
  list(options: {
    observe?: boolean;
    since?: string;
    afterId?: string;
    jobType?: string;
    status?: JobStatus;
    limit: number;
  }): Promise<JobRecord[]>;
  /**
   * The jobs that have not concluded, in the order the worker will claim them.
   *
   * Ordered by exactly the expression `claim` uses, so the positions a page
   * shows are the positions the machine will work through rather than a
   * plausible-looking sort of its own. Running rows come first because they
   * are happening; nothing else about their order is a queue position.
   */
  listActive(options: {
    excludeJobTypes?: string[];
    limit: number;
    /** Rows to skip, for a page past the first. */
    offset?: number;
  }): Promise<JobRecord[]>;
  /** Concluded jobs, most recently finished first. */
  listConcluded(options: {
    excludeJobTypes?: string[];
    limit: number;
    /** Rows to skip, for a page past the first. */
    offset?: number;
  }): Promise<JobRecord[]>;
  /**
   * How many rows those two lists could return, ignoring any page.
   *
   * Counted rather than inferred from a page's length, because that is the
   * whole point: a tab reading "Concluded (50)" when a page holds fifty of
   * eight hundred is not a count, it is the page size wearing a number's
   * clothes. Both halves come from one statement so they cannot disagree.
   */
  countTasks(options: { excludeJobTypes?: string[] }): Promise<{
    active: number;
    concluded: number;
  }>;
  /**
   * Rewrites the claim order of jobs that are still waiting.
   *
   * Only rows that are genuinely queued move: a claimed attempt is already
   * being worked on and a concluded one has no place left to take, and both
   * are refused in the same statement that does the writing rather than by a
   * check somewhere above it. `excludeJobTypes` keeps one domain's reorder out
   * of another's — the media lane has a queue of its own with its own rules.
   *
   * Returns the ids that actually moved, so a caller is never told it
   * rearranged something it did not.
   */
  reorderQueue(
    orderedIds: readonly string[],
    options?: { excludeJobTypes?: string[] },
  ): Promise<string[]>;
  /** Returns leases that expired so a crashed worker's jobs are retried. */
  reclaimExpiredLeases(): Promise<number>;
}

interface RawJobRow {
  id: string;
  job_type: string;
  payload: Record<string, unknown>;
  status: JobStatus;
  attempts: number;
  max_attempts: number;
  progress: number;
  progress_message: string | null;
  progress_detail: unknown;
  safe_error: string | null;
  result: Record<string, unknown> | null;
  cancellation_requested: boolean;
  priority: number;
  queued_at: Date;
  run_after: Date;
  started_at: Date | null;
  finished_at: Date | null;
}

const JOB_COLUMNS = `
  id, job_type, payload, status, attempts, max_attempts, progress,
  progress_message, progress_detail, safe_error, result, cancellation_requested,
  priority, queued_at, run_after, started_at, finished_at
`;

function toRecord(row: RawJobRow): JobRecord {
  return {
    id: row.id,
    jobType: row.job_type,
    payload: row.payload ?? {},
    status: row.status,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    progress: row.progress,
    progressMessage: row.progress_message,
    progressDetail: parseMaintenanceProgress(row.progress_detail),
    safeError: row.safe_error,
    result: row.result,
    cancellationRequested: row.cancellation_requested,
    priority: row.priority,
    queuedAt: row.queued_at,
    runAfter: row.run_after,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

/**
 * Rejects a payload value that cannot survive the round trip through JSONB.
 *
 * A payload is `Record<string, unknown>`, so the compiler accepts anything —
 * including a Promise from a forgotten `await`. `JSON.stringify` turns one into
 * `{}` without complaint, and the job then runs with the field simply *missing*,
 * taking whatever default the reader has. That is how a batch of episodes came
 * to publish into their season folder instead of their own: the destination was
 * an un-awaited `resolveTitleRoot`, so every job carried `titleRoot: {}` and
 * fell back to the directory beside the source, over its neighbours.
 *
 * The value that reaches the database must therefore be JSON that means what
 * the caller wrote. Anything else is a defect at the call site and is raised
 * there, before a row exists, rather than discovered as missing content later.
 */
function assertJsonPayload(
  payload: Record<string, unknown>,
  jobType: string,
): void {
  const describe = (value: unknown): string => {
    if (typeof value === "function") return "a function";
    if (typeof value === "bigint") return "a bigint";
    if (typeof value === "symbol") return "a symbol";
    if (typeof value === "object" && value !== null) {
      if (typeof (value as { then?: unknown }).then === "function") {
        return "a Promise (missing `await`?)";
      }
      return `a ${value.constructor?.name ?? "object"}`;
    }
    return `a ${typeof value}`;
  };

  const walk = (value: unknown, path: string, seen: Set<object>): void => {
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "boolean"
    ) {
      return;
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value)) {
        throw new Error(
          `Job payload for "${jobType}" has a non-finite number at ${path}. ` +
            `JSON cannot carry it and the field would arrive as null.`,
        );
      }
      return;
    }
    if (typeof value !== "object") {
      throw new Error(
        `Job payload for "${jobType}" has ${describe(value)} at ${path}. ` +
          `Only JSON values survive the queue.`,
      );
    }
    /*
     * Plain objects and arrays only. A Date, a Buffer, a Map — and above all a
     * Promise — all stringify into something the reader will not recognise, so
     * the caller must convert deliberately rather than by accident.
     */
    const prototype = Object.getPrototypeOf(value);
    const isPlain =
      Array.isArray(value) ||
      prototype === Object.prototype ||
      prototype === null;
    if (!isPlain) {
      throw new Error(
        `Job payload for "${jobType}" has ${describe(value)} at ${path}. ` +
          `Only JSON values survive the queue.`,
      );
    }
    if (seen.has(value as object)) {
      throw new Error(`Job payload for "${jobType}" is circular at ${path}.`);
    }
    seen.add(value as object);
    for (const [key, child] of Object.entries(value as object)) {
      if (child === undefined) continue;
      walk(child, `${path}.${key}`, seen);
    }
    seen.delete(value as object);
  };

  walk(payload, "payload", new Set<object>());
}

export function createJobQueue(pool: DatabasePool): JobQueue {
  return {
    enqueue: async ({
      jobType,
      payload = {},
      priority = defaultJobPriority(jobType),
      maxAttempts = 3,
      runAfter,
      dedupeKey,
    }) => {
      assertJsonPayload(payload, jobType);
      const id = randomUUID();
      const result = await pool.query<{ id: string }>(
        `INSERT INTO jobs (id, job_type, payload, priority, max_attempts, run_after, dedupe_key)
         VALUES ($1, $2, $3, $4, $5, COALESCE($6, now()), $7)
         ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL AND status IN ('queued', 'running')
         DO NOTHING
         RETURNING id`,
        [
          id,
          jobType,
          payload,
          priority,
          maxAttempts,
          runAfter ?? null,
          dedupeKey ?? null,
        ],
      );

      const inserted = result.rows[0]?.id;
      if (inserted) return inserted;

      // Collapsed onto an in-flight job; return that job's id so the caller can
      // still poll a real task.
      const existing = await pool.query<{ id: string }>(
        `SELECT id FROM jobs
         WHERE dedupe_key = $1 AND status IN ('queued', 'running')
         ORDER BY queued_at DESC LIMIT 1`,
        [dedupeKey],
      );
      const row = existing.rows[0];
      if (!row) throw new Error("Job enqueue returned no row.");
      return row.id;
    },

    claim: async (leaseOwner, leaseMs, filter) => {
      // SKIP LOCKED lets several workers — and several lanes inside one
      // worker — claim different jobs concurrently without serialising on the
      // queue head. The type filter narrows *which* row a lane may take; it
      // never widens what a claim does.
      const result = await pool.query<RawJobRow>(
        `UPDATE jobs SET
           status = 'running',
           attempts = attempts + 1,
           lease_owner = $1,
           lease_expires_at = now() + make_interval(secs => $2),
           started_at = now(), progress = 0, progress_message = NULL,
           -- A new attempt starts with no story. Carrying the previous one
           -- forward would show a retry as already half way through work it
           -- has not begun.
           progress_detail = NULL,
           safe_error = NULL, result = NULL
         WHERE id = (
           SELECT id FROM jobs
           WHERE status = 'queued' AND run_after <= now()
             AND ($3::text[] IS NULL OR job_type = ANY($3::text[]))
             AND ($4::text[] IS NULL OR job_type <> ALL($4::text[]))
           ORDER BY priority, run_after, queued_at
           FOR UPDATE SKIP LOCKED
           LIMIT 1
         )
         RETURNING ${JOB_COLUMNS}`,
        [
          leaseOwner,
          Math.max(1, Math.round(leaseMs / 1_000)),
          filter?.jobTypes ?? null,
          filter?.excludeJobTypes ?? null,
        ],
      );
      const row = result.rows[0];
      return row ? toRecord(row) : null;
    },

    heartbeat: async (jobId, leaseOwner, leaseMs) => {
      const result = await pool.query(
        `UPDATE jobs SET lease_expires_at = now() + make_interval(secs => $3)
         WHERE id = $1 AND lease_owner = $2 AND status = 'running'`,
        [jobId, leaseOwner, Math.max(1, Math.round(leaseMs / 1_000))],
      );
      return (result.rowCount ?? 0) > 0;
    },

    reportProgress: async (jobId, progress, message, detail) => {
      await pool.query(
        /*
         * The revision guard lives in the WHERE of the JSONB assignment rather
         * than in the caller. Two reports can be in flight at once — a phase
         * handing over while a batch callback is still resolving — and the
         * only place that can order them is the row itself.
         */
        `UPDATE jobs SET
           progress = $2, progress_message = $3,
           progress_detail = CASE
             WHEN $4::jsonb IS NULL THEN progress_detail
             WHEN progress_detail IS NULL THEN $4::jsonb
             WHEN COALESCE((progress_detail ->> 'revision')::int, -1)
                  < ($4::jsonb ->> 'revision')::int THEN $4::jsonb
             ELSE progress_detail END
         WHERE id = $1 AND status = 'running'`,
        [
          jobId,
          Number.isFinite(progress) ? Math.min(1, Math.max(0, progress)) : 0,
          message?.slice(0, 300) ?? null,
          detail ? JSON.stringify(detail) : null,
        ],
      );
    },

    complete: async (jobId, leaseOwner, result) => {
      await pool.query(
        `UPDATE jobs SET
           status = 'succeeded', progress = 1, finished_at = now(),
           lease_owner = NULL, lease_expires_at = NULL, result = $3,
           safe_error = NULL, progress_message = NULL, progress_detail = NULL
         WHERE id = $1 AND status = 'running' AND lease_owner = $2`,
        [jobId, leaseOwner, result ?? null],
      );
    },

    concludeCancelled: async (jobId, leaseOwner, result) => {
      await pool.query(
        `UPDATE jobs SET
           status = 'cancelled', finished_at = now(),
           lease_owner = NULL, lease_expires_at = NULL, result = $3,
           safe_error = NULL, progress_message = NULL
         WHERE id = $1 AND status = 'running' AND lease_owner = $2`,
        [jobId, leaseOwner, result ?? null],
      );
    },

    fail: async (jobId, leaseOwner, safeError, retry) => {
      await pool.query(
        `UPDATE jobs SET
           status = CASE
             WHEN $4 AND attempts < max_attempts THEN 'queued'
             ELSE 'failed' END,
           -- Exponential-ish backoff keeps a permanently broken file from
           -- spinning the worker.
           run_after = CASE
             WHEN $4 AND attempts < max_attempts
               THEN now() + make_interval(secs => least(300, power(2, attempts)::int * 15))
             ELSE run_after END,
           safe_error = $3, result = NULL,
           lease_owner = NULL,
           lease_expires_at = NULL,
           finished_at = CASE
             WHEN $4 AND attempts < max_attempts THEN NULL ELSE now() END
         -- Same ownership guard as completion: only the worker that still
         -- holds this attempt may end it. The structured progress is left
         -- standing, because on a failure the phase it died in is the single
         -- most useful thing the row can still say.
         WHERE id = $1 AND status = 'running' AND lease_owner = $2`,
        [jobId, leaseOwner, safeError.slice(0, 500), retry],
      );
    },

    defer: async (jobId, leaseOwner, runAfterMs, reason) => {
      await pool.query(
        `UPDATE jobs SET
           status = 'queued',
           -- The claim already spent one. A deferral is not an attempt, so it
           -- is handed back, and the floor keeps a double deferral from ever
           -- writing a negative count.
           attempts = greatest(0, attempts - 1),
           run_after = now() + make_interval(secs => $3),
           progress = 0,
           progress_message = $4,
           progress_detail = NULL,
           safe_error = NULL,
           result = NULL,
           lease_owner = NULL,
           lease_expires_at = NULL,
           started_at = NULL,
           finished_at = NULL
         -- Same ownership guard as completion and failure: only the worker
         -- that still holds this attempt may hand it back.
         WHERE id = $1 AND status = 'running' AND lease_owner = $2`,
        [
          jobId,
          leaseOwner,
          Math.max(0, runAfterMs) / 1_000,
          reason.slice(0, 300),
        ],
      );
    },

    requestCancellation: async (jobId) => {
      const result = await pool.query(
        `UPDATE jobs SET
           cancellation_requested = true,
           status = CASE WHEN status = 'queued' THEN 'cancelled' ELSE status END,
           finished_at = CASE WHEN status = 'queued' THEN now() ELSE finished_at END
         WHERE id = $1 AND status IN ('queued', 'running')`,
        [jobId],
      );
      return (result.rowCount ?? 0) > 0;
    },

    isCancellationRequested: async (jobId) => {
      const result = await pool.query<{ cancellation_requested: boolean }>(
        `SELECT cancellation_requested FROM jobs WHERE id = $1`,
        [jobId],
      );
      return result.rows[0]?.cancellation_requested === true;
    },

    get: async (jobId) => {
      const result = await pool.query<RawJobRow>(
        `SELECT ${JOB_COLUMNS} FROM jobs WHERE id = $1`,
        [jobId],
      );
      const row = result.rows[0];
      return row ? toRecord(row) : null;
    },

    findActive: async ({ jobType, payload }) => {
      /*
       * `queued` and `running` are exactly the statuses from which work can
       * still happen, and they are the same two the dedupe index is built on,
       * so this answer and the collapse an `enqueue` performs cannot disagree.
       * The newest is returned because that is the one an `enqueue` would have
       * collapsed onto.
       */
      const result = await pool.query<RawJobRow>(
        `SELECT ${JOB_COLUMNS} FROM jobs
         WHERE job_type = $1 AND status IN ('queued', 'running')
           AND payload @> $2::jsonb
         ORDER BY queued_at DESC
         LIMIT 1`,
        [jobType, JSON.stringify(payload)],
      );
      const row = result.rows[0];
      return row ? toRecord(row) : null;
    },

    observationTime: async () => {
      const result = await pool.query<{ at: Date }>(
        "SELECT date_trunc('milliseconds', clock_timestamp()) AS at",
      );
      return result.rows[0]!.at.toISOString();
    },

    list: async ({ jobType, status, limit, observe, since, afterId }) => {
      const values: unknown[] = [limit];
      const conditions: string[] = [];
      if (observe) {
        values.push(since ?? null);
        conditions.push(`(status IN ('queued', 'running') OR
          COALESCE(finished_at, started_at, queued_at) >= $${values.length}::timestamptz)`);
        if (afterId) {
          values.push(afterId);
          conditions.push(`id > $${values.length}::uuid`);
        }
      }
      if (jobType) {
        values.push(jobType);
        conditions.push(`job_type = $${values.length}`);
      }
      if (status) {
        values.push(status);
        conditions.push(`status = $${values.length}`);
      }

      const result = await pool.query<RawJobRow>(
        `SELECT ${JOB_COLUMNS} FROM jobs
         ${conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : ""}
         ORDER BY ${observe ? "id ASC" : "queued_at DESC"}
         LIMIT $1`,
        values,
      );
      return result.rows.map(toRecord);
    },

    listActive: async ({ excludeJobTypes, limit, offset = 0 }) => {
      /*
       * `ORDER BY` repeats the claim's own expression, one band down from a
       * `status` sort that puts the running rows first. Anything else — newest
       * first, say — would number the queue in an order the worker is not
       * going to follow, and a position that does not predict what runs next
       * is a decoration.
       */
      const result = await pool.query<RawJobRow>(
        `SELECT ${JOB_COLUMNS} FROM jobs
          WHERE status IN ('queued', 'running')
            AND ($2::text[] IS NULL OR job_type <> ALL($2::text[]))
          ORDER BY (status = 'running') DESC, priority, run_after, queued_at
          LIMIT $1 OFFSET $3`,
        [limit, excludeJobTypes ?? null, Math.max(0, offset)],
      );
      return result.rows.map(toRecord);
    },

    listConcluded: async ({ excludeJobTypes, limit, offset = 0 }) => {
      const result = await pool.query<RawJobRow>(
        `SELECT ${JOB_COLUMNS} FROM jobs
          WHERE status IN ('succeeded', 'failed', 'cancelled')
            AND ($2::text[] IS NULL OR job_type <> ALL($2::text[]))
          ORDER BY COALESCE(finished_at, queued_at) DESC
          LIMIT $1 OFFSET $3`,
        [limit, excludeJobTypes ?? null, Math.max(0, offset)],
      );
      return result.rows.map(toRecord);
    },

    countTasks: async ({ excludeJobTypes }) => {
      const result = await pool.query<{ active: string; concluded: string }>(
        `SELECT
           count(*) FILTER (WHERE status IN ('queued', 'running')) AS active,
           count(*) FILTER (
             WHERE status IN ('succeeded', 'failed', 'cancelled')
           ) AS concluded
         FROM jobs
         WHERE $1::text[] IS NULL OR job_type <> ALL($1::text[])`,
        [excludeJobTypes ?? null],
      );
      const row = result.rows[0];
      return {
        active: Number(row?.active ?? 0),
        concluded: Number(row?.concluded ?? 0),
      };
    },

    reorderQueue: async (orderedIds, options = {}) => {
      if (orderedIds.length === 0) return [];
      /*
       * One statement, so the line cannot be observed half-rewritten by a
       * worker claiming between two updates.
       *
       * The base is the priority the head of the list already holds, not a
       * constant: these rows carry priorities that mean something — the
       * "all in one" bookkeeping pass sits ahead of the work it schedules, and
       * trickplay jobs sit behind it — and rewriting every one of them onto a
       * fixed base would silently promote the whole set past jobs nobody
       * dragged.
       */
      const values: unknown[] = [];
      const rows = orderedIds.map((id, index) => {
        values.push(id, index);
        return `($${values.length - 1}::uuid, $${values.length}::int)`;
      });
      values.push(options.excludeJobTypes ?? null);
      const excluded = `$${values.length}::text[]`;
      const result = await pool.query<{ id: string }>(
        `WITH ordering(id, slot) AS (VALUES ${rows.join(", ")}),
              base AS (
                SELECT COALESCE(MIN(jobs.priority), 100) AS priority
                  FROM jobs JOIN ordering ON ordering.id = jobs.id
                 WHERE jobs.status = 'queued'
              )
         UPDATE jobs SET priority = base.priority + ordering.slot
           FROM ordering, base
          WHERE jobs.id = ordering.id
            AND jobs.status = 'queued'
            AND (${excluded} IS NULL OR jobs.job_type <> ALL(${excluded}))
        RETURNING jobs.id`,
        values,
      );
      return result.rows.map((row) => row.id);
    },

    reclaimExpiredLeases: async () => {
      const result = await pool.query(
        `UPDATE jobs SET
           status = CASE WHEN attempts < max_attempts THEN 'queued' ELSE 'failed' END,
           safe_error = CASE
             WHEN attempts < max_attempts THEN safe_error
             ELSE 'The job did not complete before its lease expired.' END,
           lease_owner = NULL,
           lease_expires_at = NULL,
           finished_at = CASE
             WHEN attempts < max_attempts THEN NULL
             ELSE now()
           END
         WHERE status = 'running' AND lease_expires_at < now()`,
      );
      return result.rowCount ?? 0;
    },
  };
}
