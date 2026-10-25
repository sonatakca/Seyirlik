import { randomUUID } from "node:crypto";
import type { DatabasePool } from "../database/databasePool";
import type { ProcessingStage } from "./stages";
import type {
  StorageMedium,
  VolumeIdentity,
} from "../../../renditions/processing/storageIdentity";

/** Job rows that still own retryable scratch; shared by startup and periodic cleanup. */
export const WORKSPACE_CLAIMING_STATES = [
  "pending",
  "queued",
  "running",
  "paused",
  "failed",
  "cancelled",
] as const;

/**
 * The durable record of one media-processing job.
 *
 * Scheduling lives in the generic `jobs` table; everything a media job needs to
 * survive a restart, and everything the administration page shows, lives here.
 * Both are written in the same transaction where it matters, so a job cannot be
 * queued without a record or recorded without being queued.
 */

/**
 * Why a job is paused, and — crucially — who is allowed to un-pause it.
 *
 * Only `storage-unavailable` is automatically recoverable. The two added here
 * exist because that single reason was being used for two opposite situations:
 * a drive that was cleanly unplugged, which should come back on its own, and a
 * drive that was returning `EIO`, which must not. `requeueStorageInterruptedJobs`
 * reads this column to decide what to restart, so conflating them is not a
 * labelling problem — it is the mechanism that sent an encoder back at a failing
 * platter after a forced reboot.
 */
export type ProcessingPauseReason =
  /** A person pressed pause. Only a person lifts it. */
  | "operator"
  /** The volume went away cleanly. Resumes when the same one returns and stays. */
  | "storage-unavailable"
  /** The volume has an established I/O fault. Operator only. */
  | "storage-quarantined"
  /** Nothing observed how the last attempt ended. Operator, or policy, decides. */
  | "recovery-pending";

/**
 * How hard each reason is to lift, as a total order.
 *
 * The reason is not a label, it is the authorisation rule: only
 * `storage-unavailable` is visible to `listPaused(AUTOMATIC_REQUEUE_PAUSE_REASON)`,
 * so lowering a reason is the same act as granting an automatic path permission
 * to restart work that was being held for a person.
 *
 * That is what happened. Two places record a pause for one storage
 * interruption — the supervisor tick, which runs at the moment of the fault,
 * and `finishStorageInterrupted`, which runs once FFmpeg has actually been
 * reaped and can therefore be many minutes later. The second re-derived the
 * reason from the guard's state *at that later moment*, so a volume that had
 * been quarantined at 12:10 and looked merely absent by 12:29 left the job
 * marked `storage-unavailable`: a quarantine, silently converted into
 * something the next remount would resume.
 *
 * Ordering them and never writing downwards fixes it independently of which
 * site runs first, of how far apart they run, and of whether they even run in
 * the same process — which threading the first site's answer through to the
 * second would not.
 */
const PAUSE_REASON_SEVERITY: Readonly<Record<ProcessingPauseReason, number>> = {
  /** An automatic path may lift it. The only reason that is true of. */
  "storage-unavailable": 1,
  /** A person decided this. The storage returning is not an answer to them. */
  operator: 2,
  /** Nobody watched the last attempt end. A person, or policy, must decide. */
  "recovery-pending": 3,
  /** An established I/O fault. The strongest claim anything here can make. */
  "storage-quarantined": 4,
};

/**
 * The more severe of a recorded reason and one being written now.
 *
 * Escalation still works — an `unavailable` job whose volume is then
 * quarantined becomes quarantined — because this is a maximum and not a
 * refusal to write. Clearing a pause is unaffected: `resume`, `finalizeCancelled`
 * and `startAttempt` set the column to NULL in their own statements and never
 * come through here.
 */
export function escalatePauseReason(
  recorded: ProcessingPauseReason | null | undefined,
  next: ProcessingPauseReason,
): ProcessingPauseReason {
  if (!recorded) return next;
  return PAUSE_REASON_SEVERITY[recorded] >= PAUSE_REASON_SEVERITY[next]
    ? recorded
    : next;
}

export type ProcessingState =
  | "pending"
  | "queued"
  | "running"
  | "paused"
  | "succeeded"
  | "failed"
  | "cancelled";

export interface ProcessingJobRecord {
  id: string;
  jobId: string | null;
  itemId: string;
  mediaFileId: string;
  sourceFingerprint: string;
  profile: string;
  state: ProcessingState;
  stage: ProcessingStage;
  stageProgress: number;
  overallProgress: number;
  bytesProcessed: number;
  outputBytes: number | null;
  estimatedOutputBytes: number | null;
  estimatedStagingBytes: number | null;
  speed: number | null;
  fps: number | null;
  etaSeconds: number | null;
  hardwareAdapter: string | null;
  videoEncoder: string | null;
  /**
   * The machine that planned this attempt (`SEYIRLIK_WORKER_NAME`, else its
   * host name). Absent until a worker plans it.
   */
  processedBy?: string | null;
  decision: Record<string, unknown> | null;
  streamDecisions: Record<string, unknown> | null;
  validation: Record<string, unknown> | null;
  warnings: string[];
  /**
   * Intervals of the source that could not be read and were replaced.
   *
   * NULL for every clean encode. A succeeded job carrying these is a *salvaged*
   * title — playable, on its own timeline, with black picture and silence where
   * the disk could not answer — and nothing may present it as a perfect result.
   */
  sourceDamage: Record<string, unknown>[] | null;
  /** One summary per finished build phase of this attempt. */
  phaseHistory?: Record<string, unknown>[] | null;
  /** The background upload to Drive after publication, while it is tracked. */
  driveUpload?: Record<string, unknown> | null;
  /**
   * The scratch volume this job's workspace was claimed on.
   *
   * Durable on purpose and stored off that volume: it is what a worker that
   * restarted while the disk was absent compares against before it is allowed
   * to create anything at the configured scratch path. `null` means the job
   * has never claimed an identifiable volume, and it is then treated exactly
   * as a new job is.
   */
  scratchIdentity: VolumeIdentity | null;
  errorCode: string | null;
  errorMessage: string | null;
  stagingDirectory: string | null;
  publishedVersion: string | null;
  attempts: number;
  cancellationRequested: boolean;
  pauseRequested: boolean;
  /** Why it is paused. Only `storage-unavailable` resumes without a person. */
  pausedReason: ProcessingPauseReason | null;
  /**
   * The epoch build's position, cached from the checkpoints on disk.
   *
   * None of this is authoritative: the filesystem owns durable progress, and a
   * restart reconciles against it. It is here so a page opened before the
   * encoder next reports in can already say how much work is protected.
   */
  epochCount: number | null;
  epochIndex: number | null;
  completedEpochs: number;
  protectedSeconds: number;
  /** Media time encoded. The video percentage is this over the source duration. */
  encodedSeconds: number;
  sourceDurationSeconds: number | null;
  epochStartSeconds: number | null;
  epochEndSeconds: number | null;
  checkpointBytes: number;
  freeBytes: number | null;
  /**
   * Where this job sits in the waiting line, read from its queue attempt.
   *
   * The generic `jobs` table owns scheduling, so the operator's ordering is
   * kept there — on the row the worker actually claims — rather than mirrored
   * here where it could disagree with what runs next. Only listings join it;
   * a record fetched on its own leaves it undefined, which is not the same as
   * a job that has no place in the queue.
   */
  queuePriority?: number | null;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  updatedAt: Date;
}

export interface ProcessingJobEvent {
  id: number;
  processingJobId: string;
  sequence: number;
  stage: ProcessingStage;
  level: "info" | "warning" | "error";
  message: string;
  detail: Record<string, unknown> | null;
  createdAt: Date;
}

export interface CreateProcessingJobInput {
  itemId: string;
  mediaFileId: string;
  sourceFingerprint: string;
  profile: string;
  decision?: Record<string, unknown>;
  streamDecisions?: Record<string, unknown>;
  estimatedOutputBytes?: number;
  estimatedStagingBytes?: number;
  hardwareAdapter?: string;
  videoEncoder?: string;
  warnings?: string[];
}

export interface ProcessingJobUpdate {
  state?: ProcessingState;
  stage?: ProcessingStage;
  stageProgress?: number;
  overallProgress?: number;
  bytesProcessed?: number;
  outputBytes?: number;
  /** The job's live prediction of its own final size, refined as it runs. */
  estimatedOutputBytes?: number;
  speed?: number | null;
  fps?: number | null;
  etaSeconds?: number | null;
  hardwareAdapter?: string;
  videoEncoder?: string;
  processedBy?: string | null;
  validation?: Record<string, unknown> | null;
  warnings?: string[];
  sourceDamage?: Record<string, unknown>[] | null;
  phaseHistory?: Record<string, unknown>[] | null;
  scratchIdentity?: VolumeIdentity | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  stagingDirectory?: string | null;
  publishedVersion?: string | null;
  startedAt?: Date;
  finishedAt?: Date | null;
  /**
   * Cleared when a job is retried. A retry that inherited the flag was
   * cancelled again the moment it started, which looked like the retry button
   * doing nothing at all.
   */
  cancellationRequested?: boolean;
  pauseRequested?: boolean;
  pausedReason?: ProcessingPauseReason | null;
  epochCount?: number | null;
  epochIndex?: number | null;
  completedEpochs?: number;
  protectedSeconds?: number;
  encodedSeconds?: number;
  sourceDurationSeconds?: number | null;
  epochStartSeconds?: number | null;
  epochEndSeconds?: number | null;
  checkpointBytes?: number;
  freeBytes?: number | null;
}

const ACTIVE_STATES: readonly ProcessingState[] = [
  "pending",
  "queued",
  "running",
  "paused",
];

const COLUMNS = `
  id, job_id, item_id, media_file_id, source_fingerprint, profile,
  state, stage, stage_progress, overall_progress,
  bytes_processed, output_bytes, estimated_output_bytes, estimated_staging_bytes,
  speed, fps, eta_seconds, hardware_adapter, video_encoder, processed_by,
  decision, stream_decisions, validation, warnings, source_damage,
  phase_history, drive_upload,
  error_code, error_message, staging_directory, published_version,
  attempts, cancellation_requested, pause_requested, paused_reason,
  epoch_count, epoch_index, completed_epochs, protected_seconds,
  encoded_seconds, source_duration_seconds, epoch_start_seconds,
  epoch_end_seconds, checkpoint_bytes, free_bytes,
  scratch_volume_uuid, scratch_volume_medium, scratch_volume_fs_type,
  created_at, started_at, finished_at, updated_at
`;

/**
 * The priority the head of the processing line holds.
 *
 * Deliberately the `jobs.priority` default, so a queue nobody has reordered
 * sorts exactly where it always did — beside the scans and probes that also
 * take the default — and reordering only spreads the processing jobs out from
 * there rather than lifting the whole class of work above everything else.
 */
const QUEUE_PRIORITY_BASE = 100;

/**
 * The ceiling on a recorded failure message.
 *
 * Trimmed rather than rejected, which is the whole point. The column was once
 * narrow enough to refuse a long diagnosis, and PostgreSQL does not shorten an
 * oversized value — it fails the statement. So the write that was recording why
 * a job died died itself, and what landed in the row was the database
 * complaining about the column instead of anything about the job.
 *
 * Generous, because the useful part of an FFmpeg failure is often near the end
 * of a long stderr tail, and a message this size is still nothing next to the
 * media it describes.
 */
const MAX_ERROR_MESSAGE_CHARS = 4_000;

/**
 * `COLUMNS` again, qualified, for the one query that joins the queue.
 *
 * `processing_jobs` and `jobs` share half a dozen column names — `id`,
 * `attempts`, `started_at` — so the listing cannot select the bare list.
 * Derived from it rather than written out twice: a column added to one and
 * forgotten in the other is exactly the kind of drift that makes a listing
 * silently lose a field.
 */
const QUALIFIED_COLUMNS = COLUMNS.split(",")
  .map((column) => column.trim())
  .filter((column) => column.length > 0)
  .map((column) => `job.${column}`)
  .join(", ");

interface RawRow {
  id: string;
  job_id: string | null;
  item_id: string;
  media_file_id: string;
  source_fingerprint: string;
  profile: string;
  state: ProcessingState;
  stage: ProcessingStage;
  stage_progress: number;
  overall_progress: number;
  bytes_processed: string | number;
  output_bytes: string | number | null;
  estimated_output_bytes: string | number | null;
  estimated_staging_bytes: string | number | null;
  speed: number | null;
  fps: number | null;
  eta_seconds: number | null;
  hardware_adapter: string | null;
  video_encoder: string | null;
  processed_by: string | null;
  decision: Record<string, unknown> | null;
  stream_decisions: Record<string, unknown> | null;
  validation: Record<string, unknown> | null;
  warnings: string[] | null;
  source_damage: Record<string, unknown>[] | null;
  phase_history: Record<string, unknown>[] | null;
  drive_upload: Record<string, unknown> | null;
  scratch_volume_uuid: string | null;
  scratch_volume_medium: StorageMedium | null;
  scratch_volume_fs_type: string | null;
  error_code: string | null;
  error_message: string | null;
  staging_directory: string | null;
  published_version: string | null;
  attempts: number;
  cancellation_requested: boolean;
  pause_requested: boolean;
  paused_reason: ProcessingPauseReason | null;
  epoch_count: number | null;
  epoch_index: number | null;
  completed_epochs: number;
  protected_seconds: string | number;
  encoded_seconds: string | number;
  source_duration_seconds: string | number | null;
  epoch_start_seconds: string | number | null;
  epoch_end_seconds: string | number | null;
  checkpoint_bytes: string | number;
  free_bytes: string | number | null;
  /** Only present on the listing query, which joins the queue attempt. */
  queue_priority?: number | null;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
  updated_at: Date;
}

function toNumber(value: string | number | null): number | null {
  if (value === null) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toRecord(row: RawRow): ProcessingJobRecord {
  return {
    id: row.id,
    jobId: row.job_id,
    itemId: row.item_id,
    mediaFileId: row.media_file_id,
    sourceFingerprint: row.source_fingerprint,
    profile: row.profile,
    state: row.state,
    stage: row.stage,
    stageProgress: row.stage_progress,
    overallProgress: row.overall_progress,
    bytesProcessed: toNumber(row.bytes_processed) ?? 0,
    outputBytes: toNumber(row.output_bytes),
    estimatedOutputBytes: toNumber(row.estimated_output_bytes),
    estimatedStagingBytes: toNumber(row.estimated_staging_bytes),
    speed: row.speed,
    fps: row.fps,
    etaSeconds: row.eta_seconds,
    hardwareAdapter: row.hardware_adapter,
    videoEncoder: row.video_encoder,
    processedBy: row.processed_by,
    decision: row.decision,
    streamDecisions: row.stream_decisions,
    validation: row.validation,
    sourceDamage: row.source_damage,
    phaseHistory: row.phase_history,
    driveUpload: row.drive_upload,
    /*
     * Only a row that recorded a UUID yields an identity. A medium without one
     * is not a weaker identity, it is none — the same rule the storage-incident
     * store applies, and for the same reason.
     */
    scratchIdentity: row.scratch_volume_uuid
      ? {
          volumeUuid: row.scratch_volume_uuid,
          medium: row.scratch_volume_medium ?? "unknown",
          fsType: row.scratch_volume_fs_type,
          deviceNode: null,
          mountPath: null,
        }
      : null,
    warnings: Array.isArray(row.warnings) ? row.warnings : [],
    errorCode: row.error_code,
    errorMessage: row.error_message,
    stagingDirectory: row.staging_directory,
    publishedVersion: row.published_version,
    attempts: row.attempts,
    cancellationRequested: row.cancellation_requested,
    pauseRequested: row.pause_requested,
    pausedReason: row.paused_reason,
    epochCount: row.epoch_count,
    epochIndex: row.epoch_index,
    completedEpochs: row.completed_epochs ?? 0,
    protectedSeconds: toNumber(row.protected_seconds) ?? 0,
    encodedSeconds: toNumber(row.encoded_seconds) ?? 0,
    sourceDurationSeconds: toNumber(row.source_duration_seconds),
    epochStartSeconds: toNumber(row.epoch_start_seconds),
    epochEndSeconds: toNumber(row.epoch_end_seconds),
    checkpointBytes: toNumber(row.checkpoint_bytes) ?? 0,
    freeBytes: toNumber(row.free_bytes),
    /*
     * Carried only when the query asked for it. Left off entirely otherwise,
     * so "nobody looked" stays distinguishable from "this job holds no place
     * in the queue" — a distinction the page reads to decide whether a row can
     * be dragged at all.
     */
    ...(row.queue_priority === undefined
      ? {}
      : { queuePriority: row.queue_priority }),
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    updatedAt: row.updated_at,
  };
}

/** Raised when a media file already has a job that has not finished. */
export class DuplicateProcessingJobError extends Error {
  readonly existingJobId: string;
  constructor(existingJobId: string) {
    super("This file already has a processing job that has not finished.");
    this.name = "DuplicateProcessingJobError";
    this.existingJobId = existingJobId;
  }
}

export interface ProcessingJobStore {
  create(input: CreateProcessingJobInput): Promise<ProcessingJobRecord>;
  attachQueueJob(id: string, jobId: string): Promise<void>;
  get(id: string): Promise<ProcessingJobRecord | null>;
  getByQueueJobId(jobId: string): Promise<ProcessingJobRecord | null>;
  findActiveForFile(mediaFileId: string): Promise<ProcessingJobRecord | null>;
  /** Removes a finished history entry. Active work is deliberately retained. */
  deleteFinished(id: string): Promise<boolean>;
  list(options?: {
    state?: ProcessingState;
    limit?: number;
  }): Promise<ProcessingJobRecord[]>;
  /**
   * The priority a newly queued job should take to land at the back of the
   * line.
   *
   * Without it every new job would enter on the default priority, which after
   * a reorder is the *head* position — so queueing an episode while a reordered
   * backlog was waiting would have jumped it in front of everything the
   * operator had just arranged.
   */
  nextQueuePriority(): Promise<number>;
  /**
   * Rewrites the order of the jobs that are still waiting.
   *
   * The ids are processing jobs, in the order the operator wants them run, and
   * the priorities land on the queue attempts because that is the row the
   * worker claims — an order recorded anywhere else would be a label rather
   * than a decision. Only jobs that are genuinely still waiting are touched: a
   * running attempt has already been claimed and cannot be moved, and one that
   * has finished has no place left to take. Returns the ids that actually
   * moved, so a caller is never told it reordered something it did not — as a
   * set, not a sequence: the order they come back in is the database's, and
   * the order that matters is the one that was sent.
   */
  reorderQueue(orderedIds: readonly string[]): Promise<string[]>;
  update(
    id: string,
    update: ProcessingJobUpdate,
  ): Promise<ProcessingJobRecord | null>;
  requestCancellation(id: string): Promise<boolean>;
  /** Asks a running job to suspend itself, recording who asked and why. */
  requestPause(id: string, reason: ProcessingPauseReason): Promise<boolean>;
  /**
   * Lifts a pause. Pass `onlyReason` to lift only pauses of that kind, so the
   * storage returning does not restart something a person paused on purpose.
   *
   * `resumesInto` is what a lifted pause becomes, and the default is the whole
   * point of it. `running` used to be unconditional here, which meant pressing
   * Resume *asserted* that an encoder was working — on a job whose worker had
   * long since exited, leaving a row that said running, waiting, never started,
   * for ever. `running` is a fact about a process, and only the runner may
   * claim it. Everything this method can honestly say is that the job is
   * eligible again, which is `queued`.
   *
   * `paused` is the third answer, and it is not a contradiction: it lifts the
   * *request* while leaving the state alone, which is the shape of a job whose
   * encoder is suspended in an operating system somewhere and has been asked to
   * wake. The worker writes `running` once it actually has. Between the two the
   * row reads paused with nothing requesting it, and the page says "Resuming".
   */
  resume(
    id: string,
    onlyReason?: ProcessingPauseReason,
    resumesInto?: "queued" | "running" | "paused",
  ): Promise<boolean>;
  /**
   * Points the durable job at the attempt now responsible for it.
   *
   * Unlike `attachQueueJob` this says nothing about state: it is used when an
   * attempt is adopted rather than created, and the caller — which knows
   * whether that attempt is merely queued or actually leased — decides what
   * the job is.
   */
  setCurrentAttempt(id: string, queueJobId: string): Promise<void>;
  /**
   * Ends an active job as cancelled, in one statement.
   *
   * For the case where nothing can observe a cancellation flag: no worker, no
   * encoder, no lease. `requestCancellation` is a message to a process, and
   * with no process to read it the job would otherwise stay active for ever.
   * Guarded to active states, so it is idempotent and can never reopen or
   * rewrite a job that already finished. It touches no file: a published
   * package, a staging directory and a scratch workspace all outlive this and
   * are released by the paths that own them.
   */
  finalizeCancelled(id: string): Promise<ProcessingJobRecord | null>;
  listPaused(reason: ProcessingPauseReason): Promise<ProcessingJobRecord[]>;
  listActive(): Promise<ProcessingJobRecord[]>;
  /**
   * Starts a new attempt, resetting everything scoped to an attempt.
   *
   * A processing job outlives its attempts: it keeps its identity, its source
   * and the package it has already published. Everything describing *how the
   * work went* belongs to one attempt and must not survive into the next. It
   * did — a retry inherited the previous attempt's 89% overall progress, its
   * `finishedAt`, its estimate and its speed, so a freshly started run showed
   * as nearly complete and as having finished two minutes before it began.
   * Resetting in one statement is what makes that impossible to get wrong
   * again, rather than each caller remembering the whole list.
   */
  beginAttempt(
    id: string,
    input: {
      estimatedOutputBytes?: number;
      estimatedStagingBytes?: number;
      decision?: Record<string, unknown>;
      streamDecisions?: Record<string, unknown>;
      hardwareAdapter?: string;
      videoEncoder?: string;
      warnings?: string[];
    },
  ): Promise<ProcessingJobRecord | null>;
  incrementAttempts(id: string): Promise<number>;
  appendEvent(input: {
    processingJobId: string;
    stage: ProcessingStage;
    level?: "info" | "warning" | "error";
    message: string;
    detail?: Record<string, unknown>;
  }): Promise<ProcessingJobEvent>;
  listEvents(
    processingJobId: string,
    afterSequence?: number,
  ): Promise<ProcessingJobEvent[]>;
  counts(): Promise<Record<ProcessingState, number>>;
  /**
   * Mirrors terminal queue failures into the operator-facing processing row.
   * A worker can disappear between those two durable records; without this
   * repair the queue is honestly failed while the processing page says the
   * encoder is still running forever.
   */
  reconcileTerminalQueueJobs(): Promise<number>;
  /**
   * Returns jobs abandoned by a worker that stopped, so they can be resumed or
   * failed on the next start rather than sitting at `running` for ever.
   */
  findInterrupted(): Promise<ProcessingJobRecord[]>;
  /**
   * How long each phase of recent successful jobs actually took.
   *
   * Read from records this system already keeps: the stage history it writes
   * for the timeline, and the job row's own duration and byte totals. Nothing
   * is stored for the sake of this query — it is the same evidence an operator
   * reads off the page, aggregated.
   *
   * Its one purpose is to weight the whole-job progress bar from what this
   * machine and this storage actually do, instead of from constants chosen
   * elsewhere. Bounded by `limit`, and run once per attempt.
   */
  listPhaseTimings(limit?: number): Promise<PhaseTimingRecord[]>;
}

/** One completed job, reduced to when each of its phases started and ended. */
export interface PhaseTimingRecord {
  sourceDurationSeconds: number | null;
  /** Bytes this job itself wrote — its assembled, verified, published package. */
  outputBytes: number;
  videoEncoder: string | null;
  hardwareAdapter: string | null;
  audioTrackCount: number;
  startedAt: Date | null;
  finishedAt: Date | null;
  /** First time each stage was reported, which is when that phase began. */
  stageStartedAt: Partial<Record<ProcessingStage, Date>>;
}

export function createProcessingJobStore(
  pool: DatabasePool,
): ProcessingJobStore {
  return {
    async create(input) {
      const existing = await pool.query<{ id: string }>(
        `SELECT id FROM processing_jobs
          WHERE media_file_id = $1 AND state = ANY($2::text[]) LIMIT 1`,
        [input.mediaFileId, ACTIVE_STATES],
      );
      if (existing.rows[0]) {
        throw new DuplicateProcessingJobError(existing.rows[0].id);
      }

      const id = randomUUID();
      const result = await pool.query<RawRow>(
        `INSERT INTO processing_jobs (
           id, item_id, media_file_id, source_fingerprint, profile,
           decision, stream_decisions, estimated_output_bytes, estimated_staging_bytes,
           hardware_adapter, video_encoder, warnings
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         RETURNING ${COLUMNS}`,
        [
          id,
          input.itemId,
          input.mediaFileId,
          input.sourceFingerprint,
          input.profile,
          input.decision ?? null,
          input.streamDecisions ?? null,
          input.estimatedOutputBytes ?? null,
          input.estimatedStagingBytes ?? null,
          input.hardwareAdapter ?? null,
          input.videoEncoder ?? null,
          JSON.stringify(input.warnings ?? []),
        ],
      );
      return toRecord(result.rows[0]!);
    },

    async attachQueueJob(id, jobId) {
      await pool.query(
        `UPDATE processing_jobs
            SET job_id = $2, state = 'queued', updated_at = now()
          WHERE id = $1`,
        [id, jobId],
      );
    },

    async get(id) {
      const result = await pool.query<RawRow>(
        `SELECT ${COLUMNS} FROM processing_jobs WHERE id = $1`,
        [id],
      );
      return result.rows[0] ? toRecord(result.rows[0]) : null;
    },

    async getByQueueJobId(jobId) {
      const result = await pool.query<RawRow>(
        `SELECT ${COLUMNS} FROM processing_jobs WHERE job_id = $1`,
        [jobId],
      );
      return result.rows[0] ? toRecord(result.rows[0]) : null;
    },

    async findActiveForFile(mediaFileId) {
      const result = await pool.query<RawRow>(
        `SELECT ${COLUMNS} FROM processing_jobs
          WHERE media_file_id = $1 AND state = ANY($2::text[])
          LIMIT 1`,
        [mediaFileId, ACTIVE_STATES],
      );
      return result.rows[0] ? toRecord(result.rows[0]) : null;
    },

    async deleteFinished(id) {
      const result = await pool.query(
        `DELETE FROM processing_jobs
          WHERE id = $1 AND state IN ('succeeded', 'failed', 'cancelled')`,
        [id],
      );
      return (result.rowCount ?? 0) > 0;
    },

    async list(options = {}) {
      const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
      /*
       * Joined to the attempt so every listing can say where a job stands in
       * the line. The join is `LEFT`: a job whose attempt has finished, failed
       * or was never created is still a row the page has to show — it just has
       * no place in the queue any more.
       */
      const result = options.state
        ? await pool.query<RawRow>(
            `SELECT ${QUALIFIED_COLUMNS}, attempt.priority AS queue_priority
               FROM processing_jobs AS job
               LEFT JOIN jobs AS attempt
                 ON attempt.id = job.job_id AND attempt.status = 'queued'
              WHERE job.state = $1
              ORDER BY job.created_at DESC LIMIT $2`,
            [options.state, limit],
          )
        : await pool.query<RawRow>(
            `SELECT ${QUALIFIED_COLUMNS}, attempt.priority AS queue_priority
               FROM processing_jobs AS job
               LEFT JOIN jobs AS attempt
                 ON attempt.id = job.job_id AND attempt.status = 'queued'
              -- Apply the limit after choosing active work. Otherwise newer
              -- history and bulk-enqueued jobs hide an older running encode.
              ORDER BY CASE job.state
                         WHEN 'running' THEN 0
                         WHEN 'paused' THEN 1
                         WHEN 'pending' THEN 2
                         WHEN 'queued' THEN 2
                         ELSE 3
                       END,
                       CASE WHEN job.state IN ('pending', 'queued')
                         THEN attempt.priority END ASC NULLS LAST,
                       CASE WHEN job.state IN ('pending', 'queued')
                         THEN job.created_at END ASC,
                       job.created_at DESC
              LIMIT $1`,
            [limit],
          );
      return result.rows.map(toRecord);
    },

    async nextQueuePriority() {
      const result = await pool.query<{ next: number }>(
        `SELECT COALESCE(MAX(attempt.priority), $1 - 1) + 1 AS next
           FROM jobs AS attempt
           JOIN processing_jobs AS job ON job.job_id = attempt.id
          WHERE attempt.status = 'queued'`,
        [QUEUE_PRIORITY_BASE],
      );
      const next = Number(result.rows[0]?.next);
      return Number.isFinite(next) ? next : QUEUE_PRIORITY_BASE;
    },

    async reorderQueue(orderedIds) {
      if (orderedIds.length === 0) return [];
      /*
       * One statement, so the line cannot be observed half-rewritten by a
       * worker claiming between two updates. The positions are handed in as a
       * `VALUES` list rather than looped, for the same reason.
       */
      const values: unknown[] = [];
      const rows = orderedIds.map((id, index) => {
        values.push(id, QUEUE_PRIORITY_BASE + index);
        return `($${values.length - 1}::uuid, $${values.length}::int)`;
      });
      const result = await pool.query<{ id: string }>(
        `UPDATE jobs AS attempt
            SET priority = ordering.priority
           FROM (VALUES ${rows.join(", ")})
                  AS ordering(processing_id, priority)
           JOIN processing_jobs AS job ON job.id = ordering.processing_id
          WHERE attempt.id = job.job_id
            AND attempt.status = 'queued'
            AND job.state IN ('pending', 'queued')
        RETURNING job.id`,
        values,
      );
      return result.rows.map((row) => row.id);
    },

    async update(id, update) {
      const assignments: string[] = [];
      const values: unknown[] = [id];
      const set = (column: string, value: unknown) => {
        values.push(value);
        assignments.push(`${column} = $${values.length}`);
      };

      if (update.state !== undefined) set("state", update.state);
      if (update.stage !== undefined) set("stage", update.stage);
      if (update.stageProgress !== undefined)
        set("stage_progress", update.stageProgress);
      if (update.overallProgress !== undefined) {
        // Guarded in SQL as well as in the caller: two writers reporting out of
        // order must not be able to walk the bar backwards.
        values.push(update.overallProgress);
        assignments.push(
          `overall_progress = GREATEST(overall_progress, $${values.length})`,
        );
      }
      if (update.bytesProcessed !== undefined)
        set("bytes_processed", update.bytesProcessed);
      if (update.estimatedOutputBytes !== undefined)
        set("estimated_output_bytes", update.estimatedOutputBytes);
      if (update.outputBytes !== undefined)
        set("output_bytes", update.outputBytes);
      if (update.speed !== undefined) set("speed", update.speed);
      if (update.fps !== undefined) set("fps", update.fps);
      if (update.etaSeconds !== undefined)
        set("eta_seconds", update.etaSeconds);
      if (update.hardwareAdapter !== undefined)
        set("hardware_adapter", update.hardwareAdapter);
      if (update.videoEncoder !== undefined)
        set("video_encoder", update.videoEncoder);
      if (update.processedBy !== undefined)
        set("processed_by", update.processedBy);
      if (update.validation !== undefined) set("validation", update.validation);
      if (update.sourceDamage !== undefined) {
        set(
          "source_damage",
          update.sourceDamage === null
            ? null
            : JSON.stringify(update.sourceDamage),
        );
      }
      if (update.phaseHistory !== undefined) {
        set(
          "phase_history",
          update.phaseHistory === null
            ? null
            : JSON.stringify(update.phaseHistory),
        );
      }
      if (update.scratchIdentity !== undefined) {
        set("scratch_volume_uuid", update.scratchIdentity?.volumeUuid ?? null);
        set("scratch_volume_medium", update.scratchIdentity?.medium ?? null);
        set("scratch_volume_fs_type", update.scratchIdentity?.fsType ?? null);
      }
      if (update.warnings !== undefined)
        set("warnings", JSON.stringify(update.warnings));
      if (update.errorCode !== undefined) set("error_code", update.errorCode);
      if (update.errorMessage !== undefined)
        set(
          "error_message",
          update.errorMessage === null
            ? null
            : update.errorMessage.slice(0, MAX_ERROR_MESSAGE_CHARS),
        );
      if (update.stagingDirectory !== undefined)
        set("staging_directory", update.stagingDirectory);
      if (update.publishedVersion !== undefined)
        set("published_version", update.publishedVersion);
      if (update.pauseRequested !== undefined) {
        set("pause_requested", update.pauseRequested);
      }
      if (update.pausedReason !== undefined) {
        set("paused_reason", update.pausedReason);
      }
      if (update.cancellationRequested !== undefined) {
        set("cancellation_requested", update.cancellationRequested);
      }
      if (update.epochCount !== undefined)
        set("epoch_count", update.epochCount);
      if (update.epochIndex !== undefined)
        set("epoch_index", update.epochIndex);
      if (update.completedEpochs !== undefined)
        set("completed_epochs", update.completedEpochs);
      if (update.protectedSeconds !== undefined)
        set("protected_seconds", update.protectedSeconds);
      if (update.encodedSeconds !== undefined)
        set("encoded_seconds", update.encodedSeconds);
      if (update.sourceDurationSeconds !== undefined)
        set("source_duration_seconds", update.sourceDurationSeconds);
      if (update.epochStartSeconds !== undefined)
        set("epoch_start_seconds", update.epochStartSeconds);
      if (update.epochEndSeconds !== undefined)
        set("epoch_end_seconds", update.epochEndSeconds);
      if (update.checkpointBytes !== undefined)
        set("checkpoint_bytes", update.checkpointBytes);
      if (update.freeBytes !== undefined) set("free_bytes", update.freeBytes);
      if (update.startedAt !== undefined) set("started_at", update.startedAt);
      if (update.finishedAt !== undefined)
        set("finished_at", update.finishedAt);

      if (assignments.length === 0) return this.get(id);
      assignments.push("updated_at = now()");

      const result = await pool.query<RawRow>(
        `UPDATE processing_jobs SET ${assignments.join(", ")} WHERE id = $1 RETURNING ${COLUMNS}`,
        values,
      );
      return result.rows[0] ? toRecord(result.rows[0]) : null;
    },

    async requestPause(id, reason) {
      const result = await pool.query(
        `UPDATE processing_jobs
            SET pause_requested = true, paused_reason = $3, updated_at = now()
          WHERE id = $1 AND state = ANY($2::text[])
            AND cancellation_requested = false`,
        [id, ACTIVE_STATES, reason],
      );
      return (result.rowCount ?? 0) > 0;
    },

    /**
     * Clears the pause. A job the operator paused by hand is deliberately not
     * resumed by the storage coming back: the drive returning answers why the
     * machine paused it, not why a person did.
     */
    async resume(id, onlyReason, resumesInto = "queued") {
      const values: unknown[] = [id, ACTIVE_STATES, resumesInto];
      const conditions = onlyReason ? "AND paused_reason = $4" : "";
      if (onlyReason) values.push(onlyReason);
      const result = await pool.query(
        `UPDATE processing_jobs
            SET pause_requested = false, paused_reason = NULL,
                state = CASE WHEN state = 'paused' THEN $3 ELSE state END,
                updated_at = now()
          WHERE id = $1 AND state = ANY($2::text[]) ${conditions}`,
        values,
      );
      return (result.rowCount ?? 0) > 0;
    },

    async setCurrentAttempt(id, queueJobId) {
      await pool.query(
        `UPDATE processing_jobs SET job_id = $2, updated_at = now()
          WHERE id = $1`,
        [id, queueJobId],
      );
    },

    async finalizeCancelled(id) {
      const result = await pool.query<RawRow>(
        `UPDATE processing_jobs SET
           state = 'cancelled',
           cancellation_requested = true,
           pause_requested = false,
           paused_reason = NULL,
           error_code = 'CANCELLED',
           error_message = 'Processing was cancelled.',
           /*
            * Live telemetry describes a process that is reporting. There is
            * none, so a speed and a remaining time left behind here would be
            * a reading of something that stopped.
            */
           speed = NULL,
           fps = NULL,
           eta_seconds = NULL,
           finished_at = COALESCE(finished_at, now()),
           updated_at = now()
         WHERE id = $1 AND state = ANY($2::text[])
         RETURNING ${COLUMNS}`,
        [id, ACTIVE_STATES],
      );
      const row = result.rows[0];
      return row ? toRecord(row) : null;
    },

    async listPaused(reason) {
      const result = await pool.query<RawRow>(
        `SELECT ${COLUMNS} FROM processing_jobs
          WHERE paused_reason = $1 ORDER BY created_at`,
        [reason],
      );
      return result.rows.map(toRecord);
    },

    async listActive() {
      const result = await pool.query<RawRow>(
        `SELECT ${COLUMNS} FROM processing_jobs
          WHERE state = ANY($1::text[]) ORDER BY created_at`,
        [ACTIVE_STATES],
      );
      return result.rows.map(toRecord);
    },

    async requestCancellation(id) {
      const result = await pool.query(
        `UPDATE processing_jobs
            SET cancellation_requested = true, updated_at = now()
          WHERE id = $1 AND state = ANY($2::text[])`,
        [id, ACTIVE_STATES],
      );
      return (result.rowCount ?? 0) > 0;
    },

    async beginAttempt(id, input) {
      /*
       * One statement, so a reader can see the whole boundary between what a
       * job keeps and what an attempt owns. Kept deliberately: the job's
       * identity, its source fingerprint, its attempt count, and
       * `published_version` — that names the package already on disk, which a
       * new attempt builds upon rather than replaces.
       */
      const result = await pool.query<RawRow>(
        `UPDATE processing_jobs SET
           state = 'queued',
           stage = 'waiting',
           stage_progress = 0,
           overall_progress = 0,
           bytes_processed = 0,
           output_bytes = NULL,
           estimated_output_bytes = $2,
           estimated_staging_bytes = COALESCE($3, estimated_staging_bytes),
           speed = NULL,
           fps = NULL,
           eta_seconds = NULL,
           validation = NULL,
           /*
            * A retry is a fresh reading of the source. The previous attempt's
            * damage describes bytes that may since have been repaired or the
            * whole file replaced, so it must not survive into a run that has
            * not looked at the disk yet.
            */
           source_damage = NULL,
           phase_history = NULL,
           drive_upload = NULL,
           error_code = NULL,
           error_message = NULL,
           cancellation_requested = false,
           pause_requested = false,
           paused_reason = NULL,
           started_at = NULL,
           finished_at = NULL,
           /*
            * The epoch position describes an attempt, not the job, and is
            * rebuilt from the checkpoints the moment the next attempt
            * reconciles. What it must not do is carry the previous attempt's
            * "protected through 00:50:00" into a run that has not looked at
            * the disk yet.
            */
           epoch_index = NULL,
           completed_epochs = 0,
           protected_seconds = 0,
           encoded_seconds = 0,
           epoch_start_seconds = NULL,
           epoch_end_seconds = NULL,
           decision = COALESCE($4::jsonb, decision),
           stream_decisions = COALESCE($5::jsonb, stream_decisions),
           hardware_adapter = COALESCE($6, hardware_adapter),
           video_encoder = COALESCE($7, video_encoder),
           processed_by = NULL,
           warnings = COALESCE($8::jsonb, warnings),
           updated_at = now()
         WHERE id = $1
         RETURNING ${COLUMNS}`,
        [
          id,
          input.estimatedOutputBytes ?? null,
          input.estimatedStagingBytes ?? null,
          input.decision ? JSON.stringify(input.decision) : null,
          input.streamDecisions ? JSON.stringify(input.streamDecisions) : null,
          input.hardwareAdapter ?? null,
          input.videoEncoder ?? null,
          input.warnings ? JSON.stringify(input.warnings) : null,
        ],
      );
      const row = result.rows[0];
      return row ? toRecord(row) : null;
    },

    async incrementAttempts(id) {
      const result = await pool.query<{ attempts: number }>(
        `UPDATE processing_jobs
            SET attempts = attempts + 1, updated_at = now()
          WHERE id = $1 RETURNING attempts`,
        [id],
      );
      return result.rows[0]?.attempts ?? 0;
    },

    async appendEvent(input) {
      const result = await pool.query<{
        id: string;
        sequence: number;
        created_at: Date;
      }>(
        `INSERT INTO processing_job_events
           (processing_job_id, sequence, stage, level, message, detail)
         VALUES (
           $1,
           COALESCE(
             (SELECT MAX(sequence) FROM processing_job_events WHERE processing_job_id = $1),
             0
           ) + 1,
           $2, $3, $4, $5
         )
         RETURNING id, sequence, created_at`,
        [
          input.processingJobId,
          input.stage,
          input.level ?? "info",
          input.message.slice(0, 500),
          input.detail ?? null,
        ],
      );
      const row = result.rows[0]!;
      return {
        id: Number(row.id),
        processingJobId: input.processingJobId,
        sequence: row.sequence,
        stage: input.stage,
        level: input.level ?? "info",
        message: input.message.slice(0, 500),
        detail: input.detail ?? null,
        createdAt: row.created_at,
      };
    },

    async listEvents(processingJobId, afterSequence = 0) {
      const result = await pool.query<{
        id: string;
        sequence: number;
        stage: ProcessingStage;
        level: "info" | "warning" | "error";
        message: string;
        detail: Record<string, unknown> | null;
        created_at: Date;
      }>(
        `SELECT id, sequence, stage, level, message, detail, created_at
           FROM processing_job_events
          WHERE processing_job_id = $1 AND sequence > $2
          ORDER BY sequence ASC
          LIMIT 500`,
        [processingJobId, afterSequence],
      );
      return result.rows.map((row) => ({
        id: Number(row.id),
        processingJobId,
        sequence: row.sequence,
        stage: row.stage,
        level: row.level,
        message: row.message,
        detail: row.detail,
        createdAt: row.created_at,
      }));
    },

    async listPhaseTimings(limit = 20) {
      /*
       * One query, bounded twice: to the most recent successful jobs, and to
       * the stage rows belonging to them. The inner select is what keeps the
       * join from touching the whole event history — that table grows without
       * limit and this runs at the start of every attempt.
       */
      const result = await pool.query<{
        id: string;
        source_duration_seconds: number | null;
        bytes_processed: string | number;
        output_bytes: string | number | null;
        video_encoder: string | null;
        hardware_adapter: string | null;
        decision: Record<string, unknown> | null;
        started_at: Date | null;
        finished_at: Date | null;
        stage: ProcessingStage;
        stage_started_at: Date;
      }>(
        `SELECT j.id, j.source_duration_seconds, j.bytes_processed, j.output_bytes,
                j.video_encoder, j.hardware_adapter, j.decision,
                j.started_at, j.finished_at,
                e.stage, MIN(e.created_at) AS stage_started_at
           FROM (
             SELECT id, source_duration_seconds, bytes_processed, output_bytes,
                    video_encoder, hardware_adapter, decision, started_at, finished_at
               FROM processing_jobs
              WHERE state = 'succeeded'
                AND started_at IS NOT NULL
                AND finished_at IS NOT NULL
              ORDER BY finished_at DESC
              LIMIT $1
           ) j
           JOIN processing_job_events e ON e.processing_job_id = j.id
          GROUP BY j.id, j.source_duration_seconds, j.bytes_processed, j.output_bytes,
                   j.video_encoder, j.hardware_adapter, j.decision,
                   j.started_at, j.finished_at, e.stage`,
        [Math.max(1, Math.min(100, limit))],
      );

      const byJob = new Map<string, PhaseTimingRecord>();
      for (const row of result.rows) {
        let record = byJob.get(row.id);
        if (!record) {
          const decision = row.decision as {
            streams?: { keptAudioStreamIndexes?: unknown[] };
          } | null;
          record = {
            sourceDurationSeconds: row.source_duration_seconds,
            outputBytes: Number(row.bytes_processed ?? 0),
            videoEncoder: row.video_encoder,
            hardwareAdapter: row.hardware_adapter,
            audioTrackCount:
              decision?.streams?.keptAudioStreamIndexes?.length ?? 0,
            startedAt: row.started_at,
            finishedAt: row.finished_at,
            stageStartedAt: {},
          };
          byJob.set(row.id, record);
        }
        record.stageStartedAt[row.stage] = row.stage_started_at;
      }
      return [...byJob.values()];
    },

    async counts() {
      const result = await pool.query<{
        state: ProcessingState;
        count: string;
      }>(
        `SELECT state, COUNT(*)::text AS count FROM processing_jobs GROUP BY state`,
      );
      const counts = {
        pending: 0,
        queued: 0,
        running: 0,
        paused: 0,
        succeeded: 0,
        failed: 0,
        cancelled: 0,
      } satisfies Record<ProcessingState, number>;
      for (const row of result.rows) counts[row.state] = Number(row.count);
      return counts;
    },

    async reconcileTerminalQueueJobs() {
      const result = await pool.query(
        `UPDATE processing_jobs AS processing SET
           state = CASE
             WHEN queue.status = 'cancelled' THEN 'cancelled'
             ELSE 'failed'
           END,
           error_code = CASE
             WHEN queue.status = 'cancelled' THEN 'CANCELLED'
             ELSE 'WORKER_STOPPED'
           END,
           error_message = CASE
             WHEN queue.status = 'cancelled' THEN 'Processing was cancelled.'
             ELSE COALESCE(
               NULLIF(queue.safe_error, ''),
               'The processing worker stopped before the job completed.'
             )
           END,
           speed = NULL,
           fps = NULL,
           eta_seconds = NULL,
           finished_at = COALESCE(queue.finished_at, now()),
           updated_at = now()
         FROM jobs AS queue
         WHERE processing.job_id = queue.id
           AND processing.state = ANY($1::text[])
           AND queue.status IN ('failed', 'cancelled')`,
        [ACTIVE_STATES],
      );
      return result.rowCount ?? 0;
    },

    async findInterrupted() {
      const result = await pool.query<RawRow>(
        `SELECT ${COLUMNS} FROM processing_jobs WHERE state = 'running'`,
      );
      return result.rows.map(toRecord);
    },
  };
}
