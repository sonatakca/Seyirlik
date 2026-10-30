/**
 * Imports in PostgreSQL.
 *
 * Two things here carry the correctness of the whole phase.
 *
 * `update` is a conditional write — the row must still be in the state the
 * caller last saw — so two workers holding one import cannot both move it. The
 * loser matches no row, is told so, and stops before touching a filesystem.
 *
 * And `commitFile` leans on a unique index rather than on a check. Asking
 * "is this destination free?" and then writing is a race with a window in it;
 * writing and letting the database refuse has no window at all. A refusal is
 * not an error here — it is the signal that somebody else committed this
 * destination, which is precisely when reality needs reading rather than
 * overwriting.
 */
import { randomUUID } from "node:crypto";
import type { DatabasePool } from "../database/databasePool";
import {
  publicDriveUpload,
  type DriveUploadStatus,
} from "../processing/driveUploadStatus";
import type {
  ImportFailureClass,
  ImportFileRole,
  ImportState,
  ImportStrategy,
} from "./importState";

export interface ImportTarget {
  readonly kind: "movie" | "series" | "season" | "episode";
  readonly itemId?: string;
  readonly title: string;
  readonly year?: number;
  readonly season?: number;
  readonly episode?: number;
}

export interface CreateImportInput {
  readonly acquisitionId?: string;
  readonly target: ImportTarget;
  /** The authorised roots, frozen onto the row at plan time. */
  readonly sourceRoot: string;
  readonly libraryRoot: string;
  readonly sourceRelative: string;
  /**
   * Set by whoever decided this release is better than what is in the library.
   *
   * An importer that worked this out for itself would be an importer that can
   * overwrite a film because a name matched.
   */
  readonly isUpgrade?: boolean;
}

export interface ImportRecord {
  readonly id: string;
  readonly acquisitionId?: string;
  readonly idempotencyKey: string;
  readonly state: ImportState;
  readonly strategy?: ImportStrategy;
  readonly targetKind: string;
  readonly targetTitle: string;
  /*
   * Read back as well as written. Without these the destination is built from
   * the title alone, so an import lands in `Night of the Living Dead` beside a
   * library of `Title (Year)` folders — and the year the row was created with
   * is sitting unused in the same row.
   */
  readonly targetYear?: number;
  readonly targetSeason?: number;
  readonly targetEpisode?: number;
  readonly targetItemId?: string;
  readonly sourceRoot: string;
  readonly libraryRoot: string;
  readonly sourceRelative: string;
  /** Whether this import may replace media already in the library. */
  readonly isUpgrade: boolean;
  readonly attempt: number;
  readonly failureClass?: string;
  readonly failureDetail?: string;
  readonly retryAfterMs?: number;
  readonly committedAtMs?: number;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

export type ImportFileState =
  | "planned"
  /**
   * Claimed by a worker that is putting it beside its destination.
   *
   * The claim exists because staging is the one phase with no other lock on
   * it. Without it a second worker discards the first one's half-written
   * staging file, and the first then activates nothing.
   */
  | "staging"
  | "staged"
  | "committed"
  /**
   * Committed once, and replaced since by an upgrade.
   *
   * A distinct state rather than a deletion, because the row is the record of
   * a file that really was in the library — and because the unique index only
   * counts `committed`, superseding is what frees the destination for the
   * release that replaced it.
   */
  | "superseded"
  | "skipped"
  | "failed";

export interface ImportFileRecord {
  readonly id: string;
  readonly importId: string;
  readonly role: ImportFileRole;
  readonly sourceRelative: string;
  readonly destinationRelative?: string;
  readonly destinationKey?: string;
  readonly state: ImportFileState;
  readonly strategy?: ImportStrategy;
  readonly sizeBytes?: number;
  readonly sourceMtimeMs?: number;
  readonly destinationIdentity?: string;
  readonly failureClass?: string;
  readonly failureDetail?: string;
  /** Its way to Google Drive after the import, where the helper follows it. */
  readonly driveUpload?: DriveUploadStatus;
}

export interface PlannedImportFile {
  readonly role: ImportFileRole;
  readonly sourceRelative: string;
  readonly destinationRelative?: string;
  readonly destinationKey?: string;
  readonly sizeBytes?: number;
  readonly sourceMtimeMs?: number;
}

export interface ImportPatch {
  readonly state?: ImportState;
  readonly strategy?: ImportStrategy;
  readonly attempt?: number;
  readonly failureClass?: ImportFailureClass | null;
  readonly failureDetail?: string | null;
  readonly retryAfterMs?: number | null;
  readonly committed?: boolean;
}

export interface ImportFilePatch {
  readonly state?: ImportFileState;
  readonly strategy?: ImportStrategy;
  readonly destinationIdentity?: string;
  readonly failureClass?: ImportFailureClass | null;
  readonly failureDetail?: string | null;
}

export interface ImportEvent {
  readonly fromState: string | null;
  readonly toState: string;
  readonly failureClass?: string;
  readonly detail?: string;
  readonly atMs: number;
}

/** Raised when a destination is already committed by some other import. */
export class DestinationAlreadyCommittedError extends Error {
  readonly destinationKey: string;

  constructor(destinationKey: string) {
    super("That destination is already committed by another import.");
    this.name = "DestinationAlreadyCommittedError";
    this.destinationKey = destinationKey;
  }
}

const UNIQUE_VIOLATION = "23505";

export interface ImportStore {
  get(id: string): Promise<ImportRecord | null>;
  update(
    id: string,
    expectedState: ImportState,
    patch: ImportPatch,
    detail?: string,
  ): Promise<boolean>;
  listFiles(importId: string): Promise<ImportFileRecord[]>;
  updateFile(
    fileId: string,
    expectedState: ImportFileState,
    patch: ImportFilePatch,
    detail?: string,
  ): Promise<boolean>;
  commitFile(
    fileId: string,
    expectedState: ImportFileState,
    identity: string,
    strategy: ImportStrategy,
  ): Promise<boolean>;
}

export interface ImportRepository extends ImportStore {
  create(input: CreateImportInput): Promise<ImportRecord>;
  addFiles(
    importId: string,
    files: readonly PlannedImportFile[],
  ): Promise<ImportFileRecord[]>;
  list(limit?: number): Promise<ImportRecord[]>;
  listActive(): Promise<ImportRecord[]>;
  /** Rows whose filesystem outcome is unknown and must be read. */
  listUncertain(): Promise<ImportRecord[]>;
  /** The newest import of this acquisition's download, if there is one. */
  latestForAcquisition(acquisitionId: string): Promise<ImportRecord | null>;
  /** Which of these acquisitions already have an import, in any state. */
  acquisitionsWithImports(
    acquisitionIds: readonly string[],
  ): Promise<Set<string>>;
  detail(id: string): Promise<{
    record: ImportRecord;
    files: ImportFileRecord[];
    events: ImportEvent[];
  } | null>;
  /** Any committed file at this destination, whichever import owns it. */
  findCommittedDestination(
    destinationKey: string,
  ): Promise<ImportFileRecord | null>;
  /**
   * Marks the file an upgrade replaced, so the destination is free again.
   *
   * Returns how many rows moved. Called after the old file has been renamed
   * aside and before the new one is recorded, which is the only ordering in
   * which neither a crash nor the unique index can leave the destination
   * claimed by a file that is no longer there.
   */
  supersedeCommittedDestination(
    destinationKey: string,
    exceptFileId: string,
  ): Promise<number>;
}

interface Row {
  id: string;
  acquisition_id: string | null;
  idempotency_key: string;
  state: string;
  strategy: string | null;
  target_kind: string;
  target_title: string;
  target_year: number | null;
  target_season: number | null;
  target_episode: number | null;
  target_item_id: string | null;
  source_root: string;
  library_root: string;
  source_relative: string;
  is_upgrade: boolean;
  attempt: number;
  failure_class: string | null;
  failure_detail: string | null;
  retry_after: Date | null;
  committed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

interface FileRow {
  id: string;
  import_id: string;
  role: string;
  source_relative: string;
  destination_relative: string | null;
  destination_key: string | null;
  state: string;
  strategy: string | null;
  size_bytes: string | number | null;
  source_mtime_ms: string | number | null;
  destination_identity: string | null;
  failure_class: string | null;
  failure_detail: string | null;
  drive_upload: Record<string, unknown> | null;
}

const COLUMNS = `id, acquisition_id, idempotency_key, state, strategy,
  target_kind, target_title, target_year, target_season, target_episode,
  target_item_id, source_root, library_root,
  source_relative, is_upgrade, attempt, failure_class, failure_detail, retry_after,
  committed_at, created_at, updated_at`;

const FILE_COLUMNS = `id, import_id, role, source_relative,
  destination_relative, destination_key, state, strategy, size_bytes,
  source_mtime_ms, destination_identity, failure_class, failure_detail,
  drive_upload`;

function numeric(value: string | number | null): number | undefined {
  if (value === null) return undefined;
  const parsed = Number(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function toRecord(row: Row): ImportRecord {
  return {
    id: row.id,
    ...(row.acquisition_id ? { acquisitionId: row.acquisition_id } : {}),
    idempotencyKey: row.idempotency_key,
    state: row.state as ImportState,
    ...(row.strategy ? { strategy: row.strategy as ImportStrategy } : {}),
    targetKind: row.target_kind,
    targetTitle: row.target_title,
    ...(row.target_year === null ? {} : { targetYear: row.target_year }),
    ...(row.target_season === null ? {} : { targetSeason: row.target_season }),
    ...(row.target_episode === null
      ? {}
      : { targetEpisode: row.target_episode }),
    ...(row.target_item_id ? { targetItemId: row.target_item_id } : {}),
    sourceRoot: row.source_root,
    libraryRoot: row.library_root,
    sourceRelative: row.source_relative,
    isUpgrade: row.is_upgrade,
    attempt: row.attempt,
    ...(row.failure_class ? { failureClass: row.failure_class } : {}),
    ...(row.failure_detail ? { failureDetail: row.failure_detail } : {}),
    ...(row.retry_after ? { retryAfterMs: row.retry_after.getTime() } : {}),
    ...(row.committed_at ? { committedAtMs: row.committed_at.getTime() } : {}),
    createdAtMs: row.created_at.getTime(),
    updatedAtMs: row.updated_at.getTime(),
  };
}

function toFileRecord(row: FileRow): ImportFileRecord {
  const size = numeric(row.size_bytes);
  const mtime = numeric(row.source_mtime_ms);
  const driveUpload = publicDriveUpload(row.drive_upload);
  return {
    id: row.id,
    importId: row.import_id,
    role: row.role as ImportFileRole,
    sourceRelative: row.source_relative,
    ...(row.destination_relative
      ? { destinationRelative: row.destination_relative }
      : {}),
    ...(row.destination_key ? { destinationKey: row.destination_key } : {}),
    state: row.state as ImportFileState,
    ...(row.strategy ? { strategy: row.strategy as ImportStrategy } : {}),
    ...(size === undefined ? {} : { sizeBytes: size }),
    ...(mtime === undefined ? {} : { sourceMtimeMs: mtime }),
    ...(row.destination_identity
      ? { destinationIdentity: row.destination_identity }
      : {}),
    ...(row.failure_class ? { failureClass: row.failure_class } : {}),
    ...(row.failure_detail ? { failureDetail: row.failure_detail } : {}),
    ...(driveUpload ? { driveUpload } : {}),
  };
}

export function createImportRepository(pool: DatabasePool): ImportRepository {
  async function recordEvent(
    importId: string,
    fileId: string | null,
    fromState: string,
    toState: string,
    failureClass: string | null,
    detail: string | null,
  ): Promise<void> {
    await pool.query(
      `INSERT INTO import_events
         (import_id, import_file_id, from_state, to_state, failure_class, detail)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [importId, fileId, fromState, toState, failureClass, detail],
    );
  }

  async function recordEventForFile(
    fileId: string,
    fromState: string,
    toState: string,
  ): Promise<void> {
    await pool.query(
      `INSERT INTO import_events (import_id, import_file_id, from_state, to_state, detail)
       SELECT import_id, id, $2, $3, 'Replaced by an upgrade.'
         FROM import_files WHERE id = $1`,
      [fileId, fromState, toState],
    );
  }

  const repository: ImportRepository = {
    async create(input) {
      const id = randomUUID();
      /*
       * Derived from the row's own identifier, so it is unique by construction
       * and needs no coordination — and written in the same statement that
       * creates the row, before any staging artifact could be named after it.
       */
      const idempotencyKey = `seyirlik-import-${id}`;
      const inserted = await pool.query<Row>(
        `INSERT INTO imports
           (id, acquisition_id, target_kind, target_item_id, target_title,
            target_year, target_season, target_episode, source_root,
            library_root, source_relative, state, idempotency_key, is_upgrade)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'planned',$12,$13)
         RETURNING ${COLUMNS}`,
        [
          id,
          input.acquisitionId ?? null,
          input.target.kind,
          input.target.itemId ?? null,
          input.target.title,
          input.target.year ?? null,
          input.target.season ?? null,
          input.target.episode ?? null,
          input.sourceRoot,
          input.libraryRoot,
          input.sourceRelative,
          idempotencyKey,
          input.isUpgrade ?? false,
        ],
      );
      await recordEvent(id, null, "", "planned", null, "Import planned.");
      return toRecord(inserted.rows[0]!);
    },

    async get(id) {
      const result = await pool.query<Row>(
        `SELECT ${COLUMNS} FROM imports WHERE id = $1`,
        [id],
      );
      return result.rows[0] ? toRecord(result.rows[0]) : null;
    },

    async update(id, expectedState, patch, detail) {
      const result = await pool.query<{ state: string }>(
        `UPDATE imports SET
           state = COALESCE($3, state),
           strategy = COALESCE($4, strategy),
           attempt = COALESCE($5, attempt),
           failure_class = CASE WHEN $6::boolean THEN $7 ELSE failure_class END,
           failure_detail = CASE WHEN $6::boolean THEN $8 ELSE failure_detail END,
           retry_after = CASE WHEN $9::boolean THEN $10 ELSE retry_after END,
           committed_at = CASE WHEN $11::boolean THEN now() ELSE committed_at END,
           completed_at = CASE WHEN $3 = 'complete' THEN now() ELSE completed_at END,
           updated_at = now()
         WHERE id = $1 AND state = $2
         RETURNING state`,
        [
          id,
          expectedState,
          patch.state ?? null,
          patch.strategy ?? null,
          patch.attempt ?? null,
          patch.failureClass !== undefined || patch.failureDetail !== undefined,
          patch.failureClass ?? null,
          patch.failureDetail ?? null,
          patch.retryAfterMs !== undefined,
          patch.retryAfterMs ? new Date(patch.retryAfterMs) : null,
          patch.committed === true,
        ],
      );
      if (result.rows.length === 0) return false;

      if (patch.state && patch.state !== expectedState) {
        await recordEvent(
          id,
          null,
          expectedState,
          patch.state,
          patch.failureClass ?? null,
          detail ?? null,
        );
      }
      return true;
    },

    async addFiles(importId, files) {
      const created: ImportFileRecord[] = [];
      for (const file of files) {
        const inserted = await pool.query<FileRow>(
          `INSERT INTO import_files
             (id, import_id, role, source_relative, destination_relative,
              destination_key, state, size_bytes, source_mtime_ms)
           VALUES ($1,$2,$3,$4,$5,$6,'planned',$7,$8)
           RETURNING ${FILE_COLUMNS}`,
          [
            randomUUID(),
            importId,
            file.role,
            file.sourceRelative,
            file.destinationRelative ?? null,
            file.destinationKey ?? null,
            file.sizeBytes === undefined ? null : Math.round(file.sizeBytes),
            file.sourceMtimeMs === undefined
              ? null
              : Math.round(file.sourceMtimeMs),
          ],
        );
        created.push(toFileRecord(inserted.rows[0]!));
      }
      return created;
    },

    async listFiles(importId) {
      const result = await pool.query<FileRow>(
        `SELECT ${FILE_COLUMNS} FROM import_files
          WHERE import_id = $1 ORDER BY role, source_relative`,
        [importId],
      );
      return result.rows.map(toFileRecord);
    },

    async updateFile(fileId, expectedState, patch, detail) {
      const result = await pool.query<{ import_id: string }>(
        `UPDATE import_files SET
           state = COALESCE($3, state),
           strategy = COALESCE($4, strategy),
           destination_identity = COALESCE($5, destination_identity),
           failure_class = CASE WHEN $6::boolean THEN $7 ELSE failure_class END,
           failure_detail = CASE WHEN $6::boolean THEN $8 ELSE failure_detail END,
           updated_at = now()
         WHERE id = $1 AND state = $2
         RETURNING import_id`,
        [
          fileId,
          expectedState,
          patch.state ?? null,
          patch.strategy ?? null,
          patch.destinationIdentity ?? null,
          patch.failureClass !== undefined || patch.failureDetail !== undefined,
          patch.failureClass ?? null,
          patch.failureDetail ?? null,
        ],
      );
      if (result.rows.length === 0) return false;
      if (patch.state && patch.state !== expectedState) {
        await recordEvent(
          result.rows[0]!.import_id,
          fileId,
          expectedState,
          patch.state,
          patch.failureClass ?? null,
          detail ?? null,
        );
      }
      return true;
    },

    async commitFile(fileId, expectedState, identity, strategy) {
      /*
       * The database decides, not a prior check.
       *
       * A `SELECT` that finds the destination free, followed by an `UPDATE`,
       * has a window between them in which another worker commits the same
       * path. Letting the unique index refuse the write closes that window
       * entirely, and a refusal is information rather than an error: somebody
       * else owns this destination, so reality must be read.
       */
      try {
        return await this.updateFile(
          fileId,
          expectedState,
          { state: "committed", destinationIdentity: identity, strategy },
          "Destination activated.",
        );
      } catch (error) {
        if ((error as { code?: string }).code === UNIQUE_VIOLATION) {
          const file = await pool.query<{ destination_key: string | null }>(
            "SELECT destination_key FROM import_files WHERE id = $1",
            [fileId],
          );
          throw new DestinationAlreadyCommittedError(
            file.rows[0]?.destination_key ?? "(unknown)",
          );
        }
        throw error;
      }
    },

    async findCommittedDestination(destinationKey) {
      const result = await pool.query<FileRow>(
        `SELECT ${FILE_COLUMNS} FROM import_files
          WHERE destination_key = $1 AND state = 'committed'`,
        [destinationKey],
      );
      return result.rows[0] ? toFileRecord(result.rows[0]) : null;
    },

    async supersedeCommittedDestination(destinationKey, exceptFileId) {
      const result = await pool.query<{ id: string }>(
        `UPDATE import_files SET state = 'superseded', updated_at = now()
          WHERE destination_key = $1 AND state = 'committed' AND id <> $2
        RETURNING id`,
        [destinationKey, exceptFileId],
      );
      for (const row of result.rows) {
        await recordEventForFile(row.id, "committed", "superseded");
      }
      return result.rows.length;
    },

    async list(limit = 100) {
      const result = await pool.query<Row>(
        `SELECT ${COLUMNS} FROM imports ORDER BY created_at DESC LIMIT $1`,
        [Math.min(Math.max(limit, 1), 500)],
      );
      return result.rows.map(toRecord);
    },

    async listActive() {
      const result = await pool.query<Row>(
        `SELECT ${COLUMNS} FROM imports
          WHERE state NOT IN ('complete','cancelled','failed')
          ORDER BY created_at`,
      );
      return result.rows.map(toRecord);
    },

    async latestForAcquisition(acquisitionId) {
      const result = await pool.query<Row>(
        `SELECT ${COLUMNS} FROM imports
          WHERE acquisition_id = $1
          ORDER BY created_at DESC
          LIMIT 1`,
        [acquisitionId],
      );
      return result.rows[0] ? toRecord(result.rows[0]) : null;
    },

    async acquisitionsWithImports(acquisitionIds) {
      if (acquisitionIds.length === 0) return new Set();
      const result = await pool.query<{ acquisition_id: string }>(
        `SELECT DISTINCT acquisition_id FROM imports
          WHERE acquisition_id = ANY($1::uuid[])`,
        [acquisitionIds],
      );
      return new Set(result.rows.map((row) => row.acquisition_id));
    },

    async listUncertain() {
      const result = await pool.query<Row>(
        `SELECT ${COLUMNS} FROM imports
          WHERE state IN ('committing','uncertain')
          ORDER BY created_at`,
      );
      return result.rows.map(toRecord);
    },

    async detail(id) {
      const record = await repository.get(id);
      if (!record) return null;
      const [files, events] = await Promise.all([
        repository.listFiles(id),
        pool.query<{
          from_state: string | null;
          to_state: string;
          failure_class: string | null;
          detail: string | null;
          at: Date;
        }>(
          `SELECT from_state, to_state, failure_class, detail, at
             FROM import_events WHERE import_id = $1 ORDER BY id`,
          [id],
        ),
      ]);
      return {
        record,
        files,
        events: events.rows.map((row) => ({
          fromState: row.from_state,
          toState: row.to_state,
          ...(row.failure_class ? { failureClass: row.failure_class } : {}),
          ...(row.detail ? { detail: row.detail } : {}),
          atMs: row.at.getTime(),
        })),
      };
    },
  };

  return repository;
}
