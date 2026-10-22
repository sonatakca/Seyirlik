/**
 * Queueing processing for what the importer brought in.
 *
 * An import stops once its files are in the library. The library scan
 * registers them some minutes later — on a cloud mount, only once the server
 * can see the upload — and until then there is no media file to process. So
 * this is not a step at the end of an import but a sweep: every committed
 * media file of an import, matched by path to the media file the scan made of
 * it, is handed to the one enqueuer every processing button uses.
 *
 * Matching by path is the point. The same item can still carry media file
 * rows from an older copy of the title — the files of a drive that is gone,
 * kept with `missing_since` set — and the item's primary file is not
 * necessarily the one that was just imported. The imported file is named
 * explicitly, and nothing else is ever chosen.
 *
 * The decision is kept on the import file. A file is offered at most until
 * the enqueuer says something definite about it — queued, already queued,
 * already current, rejected — and never again after that, so a re-run sweep,
 * a retried job or two workers at once converge on one processing job, and a
 * job somebody cancelled is not quietly brought back. The enqueuer's own
 * duplicate rules sit underneath this, so even a lost decision cannot double
 * a job.
 */
import type { DatabasePool } from "../database/databasePool";
import { OwnApiError } from "../ownApiHandler";
import type {
  BulkEnqueueOutcome,
  ProcessingEnqueuer,
} from "../processing/processingEnqueue";

export type ImportProcessingOutcome =
  | "queued"
  | "already-queued"
  | "already-complete"
  | "rejected"
  | "gave-up";

/** A committed media file of an import that processing has not decided on. */
export interface UndecidedImportFile {
  readonly id: string;
  readonly importId: string;
  /** The library root the import was authorised against, on its machine. */
  readonly libraryRoot: string;
  /** Relative to `libraryRoot`. */
  readonly destinationRelative: string;
  readonly attempts: number;
}

/** What the library scan made of a path. */
export interface RegisteredMediaFile {
  readonly id: string;
  readonly itemId: string;
  readonly relativePath: string;
  readonly missing: boolean;
}

export interface ImportProcessingStore {
  /** Undecided files whose retry time, if any, has come; oldest import first. */
  listUndecided(nowMs: number): Promise<UndecidedImportFile[]>;
  /** The media files registered at exactly these media-root-relative paths. */
  findMediaFiles(
    relativePaths: readonly string[],
  ): Promise<Map<string, RegisteredMediaFile>>;
  /** Records a definite answer. Only an undecided file moves. */
  decide(
    fileId: string,
    outcome: ImportProcessingOutcome,
    extra?: { detail?: string; processingJobId?: string },
  ): Promise<void>;
  /** Records a transient refusal and when to ask again. */
  postpone(
    fileId: string,
    retry: { attempts: number; retryAtMs: number; detail?: string },
  ): Promise<void>;
}

export function createImportProcessingStore(
  pool: Pick<DatabasePool, "query">,
): ImportProcessingStore {
  return {
    async listUndecided(nowMs) {
      const result = await pool.query<{
        id: string;
        import_id: string;
        library_root: string;
        destination_relative: string;
        processing_attempts: number;
      }>(
        `SELECT f.id, f.import_id, i.library_root, f.destination_relative,
                f.processing_attempts
           FROM import_files f
           JOIN imports i ON i.id = f.import_id
          WHERE f.role = 'media'
            AND f.state = 'committed'
            AND f.processing_outcome IS NULL
            AND f.destination_relative IS NOT NULL
            AND i.state IN ('committed', 'complete')
            AND (f.processing_retry_at IS NULL OR f.processing_retry_at <= $1)
          ORDER BY i.committed_at NULLS LAST, f.created_at, f.id`,
        [new Date(nowMs)],
      );
      return result.rows.map((row) => ({
        id: row.id,
        importId: row.import_id,
        libraryRoot: row.library_root,
        destinationRelative: row.destination_relative,
        attempts: row.processing_attempts,
      }));
    },

    async findMediaFiles(relativePaths) {
      const found = new Map<string, RegisteredMediaFile>();
      if (relativePaths.length === 0) return found;
      const result = await pool.query<{
        id: string;
        item_id: string;
        relative_path: string;
        missing: boolean;
      }>(
        `SELECT id, item_id, relative_path, missing_since IS NOT NULL AS missing
           FROM media_files
          WHERE relative_path = ANY($1::text[])`,
        [relativePaths],
      );
      for (const row of result.rows) {
        found.set(row.relative_path, {
          id: row.id,
          itemId: row.item_id,
          relativePath: row.relative_path,
          missing: row.missing,
        });
      }
      return found;
    },

    async decide(fileId, outcome, extra = {}) {
      await pool.query(
        `UPDATE import_files
            SET processing_outcome = $2,
                processing_detail = $3,
                processing_job_id = $4,
                processing_retry_at = NULL,
                processing_decided_at = now(),
                updated_at = now()
          WHERE id = $1 AND processing_outcome IS NULL`,
        [fileId, outcome, extra.detail ?? null, extra.processingJobId ?? null],
      );
    },

    async postpone(fileId, retry) {
      await pool.query(
        `UPDATE import_files
            SET processing_attempts = $2,
                processing_retry_at = $3,
                processing_detail = $4,
                updated_at = now()
          WHERE id = $1 AND processing_outcome IS NULL`,
        [
          fileId,
          retry.attempts,
          new Date(retry.retryAtMs),
          retry.detail ?? null,
        ],
      );
    },
  };
}

const normalise = (value: string) =>
  value.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");

/**
 * Where an imported file sits relative to the media root, as the scan names it.
 *
 * The import recorded its library root as an absolute path on the machine
 * that ran it — `\\seyirlik\drive\media\Series` on one, `D:\media\Series` on
 * another — so the media root cannot simply be cut off the front. What every
 * machine shares is the configured library root it ends in, and that is what
 * the scan prefixes its paths with. The longest root that matches wins, so a
 * nested root is never mistaken for its parent. `null` when no configured
 * library is the one the import wrote into.
 */
export function mediaRelativePath(
  libraryRoot: string,
  destinationRelative: string,
  libraryRoots: readonly string[],
): string | null {
  const imported = normalise(libraryRoot).toLowerCase();
  let best: string | null = null;
  for (const root of libraryRoots) {
    const candidate = normalise(root);
    if (!candidate) continue;
    const folded = candidate.toLowerCase();
    if (imported !== folded && !imported.endsWith(`/${folded}`)) continue;
    if (best === null || candidate.length > best.length) best = candidate;
  }
  if (best === null) return null;
  const destination = normalise(destinationRelative);
  return destination ? `${best}/${destination}` : null;
}

/** How long a transient refusal waits: 2, 4, 8, 16, 32 minutes. */
export const IMPORT_PROCESSING_MAX_ATTEMPTS = 6;
const backoffMs = (attempts: number) => Math.min(2 ** attempts, 60) * 60_000;
/** A full scratch disk empties as encodes finish; it is not this file's fault. */
const SPACE_RETRY_MS = 10 * 60_000;

export interface ImportProcessingSweepResult {
  /** Undecided files looked at. */
  examined: number;
  /** Not registered by the library scan yet, or registered as missing. */
  waiting: number;
  queued: number;
  alreadyQueued: number;
  alreadyComplete: number;
  rejected: number;
  postponed: number;
  gaveUp: number;
  /** 1 when the storage guard refused new work and the sweep stopped. */
  guarded: number;
}

export interface ImportProcessingSweepOptions {
  readonly store: ImportProcessingStore;
  readonly enqueueAll: ProcessingEnqueuer["enqueueAll"];
  /** The configured library roots, relative to the media root. */
  readonly libraryRoots: readonly string[];
  readonly now?: () => number;
  readonly warn?: (message: string) => void;
}

export function createImportProcessingSweep({
  store,
  enqueueAll,
  libraryRoots,
  now = Date.now,
  warn = console.warn,
}: ImportProcessingSweepOptions): () => Promise<ImportProcessingSweepResult> {
  return async () => {
    const result: ImportProcessingSweepResult = {
      examined: 0,
      waiting: 0,
      queued: 0,
      alreadyQueued: 0,
      alreadyComplete: 0,
      rejected: 0,
      postponed: 0,
      gaveUp: 0,
      guarded: 0,
    };
    const undecided = await store.listUndecided(now());
    result.examined = undecided.length;
    if (undecided.length === 0) return result;

    const paths = new Map<string, string>();
    for (const file of undecided) {
      const relative = mediaRelativePath(
        file.libraryRoot,
        file.destinationRelative,
        libraryRoots,
      );
      if (relative) paths.set(file.id, relative);
    }
    const registered = await store.findMediaFiles([...new Set(paths.values())]);

    for (const file of undecided) {
      const relative = paths.get(file.id);
      const media = relative ? registered.get(relative) : undefined;
      // The scan has not seen it yet, or saw it gone. Asked again next pass.
      if (!media || media.missing) {
        result.waiting += 1;
        continue;
      }

      let outcome: BulkEnqueueOutcome;
      try {
        outcome = await enqueueAll([
          { itemId: media.itemId, mediaFileId: media.id },
        ]);
      } catch (error) {
        /*
         * Guarded storage refuses every title alike. Nothing is recorded, so
         * the files are offered again the moment the guard lifts.
         */
        if (
          error instanceof OwnApiError &&
          error.code === "PROCESSING_STORAGE_GUARDED"
        ) {
          result.guarded = 1;
          return result;
        }
        throw error;
      }

      const jobId = outcome.jobIds[0];
      if (outcome.queued > 0 && jobId) {
        await store.decide(file.id, "queued", { processingJobId: jobId });
        result.queued += 1;
        continue;
      }
      const skipped = outcome.skipped[0];
      const detail = skipped?.detail;
      switch (skipped?.reason) {
        case "already-queued":
          await store.decide(file.id, "already-queued");
          result.alreadyQueued += 1;
          continue;
        case "already-complete":
          await store.decide(file.id, "already-complete");
          result.alreadyComplete += 1;
          continue;
        case "rejected":
          await store.decide(file.id, "rejected", detail ? { detail } : {});
          result.rejected += 1;
          continue;
        case "insufficient-space":
          await store.postpone(file.id, {
            attempts: file.attempts,
            retryAtMs: now() + SPACE_RETRY_MS,
            ...(detail ? { detail } : {}),
          });
          result.postponed += 1;
          // The next title needs the same disk.
          return result;
        default: {
          const attempts = file.attempts + 1;
          const why =
            detail ??
            (skipped?.reason === "source-unavailable"
              ? "The source is not readable on this machine yet."
              : "Processing refused the file.");
          if (attempts >= IMPORT_PROCESSING_MAX_ATTEMPTS) {
            await store.decide(file.id, "gave-up", { detail: why });
            result.gaveUp += 1;
            warn(
              `[import] Gave up queueing processing for ${relative}: ${why}`,
            );
          } else {
            await store.postpone(file.id, {
              attempts,
              retryAtMs: now() + backoffMs(attempts),
              detail: why,
            });
            result.postponed += 1;
          }
        }
      }
    }
    return result;
  };
}
