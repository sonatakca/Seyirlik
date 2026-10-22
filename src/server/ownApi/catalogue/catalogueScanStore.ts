import { PROVIDER_COLLECTION_KEY_PREFIX } from "../collections/collectionRepository";
import { randomUUID } from "node:crypto";
import type { DatabasePool } from "../database/databasePool";
import { BOOK_EXTENSIONS } from "../scanner/nameParser";
import type { ScannedSubtitle } from "../scanner/libraryScan";
import type {
  OrganizeMove,
  OrganizedFileRecorder,
} from "../scanner/organizeLibrary";
import type {
  CatalogueScanStore,
  ExistingFileRow,
  ExistingItemRow,
  UpsertFileInput,
  UpsertItemInput,
} from "../scanner/reconciler";

/**
 * Scan-time write side of the catalogue.
 *
 * Every statement is written so that re-running an unchanged scan produces no
 * observable change: upserts are keyed on the scanner's stable source key or
 * relative path, and locked fields are preserved by the SQL itself rather than
 * by a read-modify-write that could race a concurrent metadata edit.
 */
/**
 * Recording one sidecar outside a scan.
 *
 * Kept off `CatalogueScanStore` on purpose: the reconciler does not need it,
 * and widening the scanner's contract with an operation only the subtitle
 * upload uses would invite a future scan to reach for the single-row write
 * where it should be rewriting the set.
 */
export interface ExternalSubtitleRecorder {
  attachExternalSubtitle(input: {
    mediaFileId: string;
    relativePath: string;
    codec: string;
    isText: boolean;
    language: string | null;
    isForced: boolean;
  }): Promise<void>;
}

export function createCatalogueScanStore(
  pool: DatabasePool,
): CatalogueScanStore & OrganizedFileRecorder & ExternalSubtitleRecorder {
  return {
    /*
     * Follow a file the organiser moved, one row at a time.
     *
     * One statement per move rather than one big update because a move that
     * cannot be recorded — a row already at that path, put there by something
     * else — must not take the other two hundred down with it. The scan that
     * runs next reconciles whatever was missed.
     */
    recordMoves: async (moves: OrganizeMove[]) => {
      let recorded = 0;
      for (const move of moves) {
        try {
          const result = await pool.query(
            `UPDATE media_files
               SET relative_path = $2, updated_at = now()
             WHERE relative_path = $1`,
            [move.from, move.to],
          );
          recorded += result.rowCount ?? 0;
        } catch {
          // Reconciliation is the fallback, and it is not destructive: the old
          // path is marked missing and kept for the grace period.
        }
      }
      return recorded;
    },

    listItems: async (libraryId) => {
      const result = await pool.query<{
        id: string;
        source_key: string;
        kind: string;
        locked_fields: string[];
        missing_since: Date | null;
        desired: boolean;
      }>(
        // A provider collection has no folder to be found in, so it is not
        // the scan's to reconcile: listing it here would retire every box set
        // on the first pass.
        `SELECT id, source_key, kind, locked_fields, missing_since, desired
         FROM items
         WHERE library_id = $1
           AND source_key NOT LIKE '${PROVIDER_COLLECTION_KEY_PREFIX}%'`,
        [libraryId],
      );
      return result.rows.map<ExistingItemRow>((row) => ({
        id: row.id,
        sourceKey: row.source_key,
        kind: row.kind,
        lockedFields: row.locked_fields ?? [],
        missingSince: row.missing_since,
        desired: row.desired,
      }));
    },

    listFiles: async (libraryId) => {
      const result = await pool.query<{
        id: string;
        item_id: string;
        relative_path: string;
        fingerprint: string;
        missing_since: Date | null;
      }>(
        `SELECT file.id, file.item_id, file.relative_path, file.fingerprint, file.missing_since
         FROM media_files file
         JOIN items item ON item.id = file.item_id
         WHERE item.library_id = $1`,
        [libraryId],
      );
      return result.rows.map<ExistingFileRow>((row) => ({
        id: row.id,
        itemId: row.item_id,
        relativePath: row.relative_path,
        fingerprint: row.fingerprint,
        missingSince: row.missing_since,
      }));
    },

    upsertItem: async (input: UpsertItemInput) => {
      const result = await pool.query<{ id: string }>(
        `INSERT INTO items (
           id, library_id, source_key, kind, title, sort_title,
           production_year, index_number, parent_index_number, last_seen_at, missing_since
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now(), NULL)
         ON CONFLICT (library_id, source_key) DO UPDATE SET
           -- A locked field keeps the curated value; everything else follows
           -- disk. A stand-in title ("Episode 4", from a name with no title in
           -- it) only names a new item: it never replaces a real one.
           title = CASE WHEN 'title' = ANY(items.locked_fields) OR $10::boolean
                        THEN items.title ELSE EXCLUDED.title END,
           sort_title = CASE WHEN 'title' = ANY(items.locked_fields)
                        THEN items.sort_title ELSE EXCLUDED.sort_title END,
           production_year = CASE WHEN 'productionYear' = ANY(items.locked_fields)
                        THEN items.production_year
                        ELSE COALESCE(EXCLUDED.production_year, items.production_year) END,
           index_number = COALESCE(EXCLUDED.index_number, items.index_number),
           parent_index_number = COALESCE(EXCLUDED.parent_index_number, items.parent_index_number),
           last_seen_at = now(),
           missing_since = NULL,
           updated_at = now()
         RETURNING id`,
        [
          randomUUID(),
          input.libraryId,
          input.sourceKey,
          input.kind,
          input.title,
          input.sortTitle,
          input.year ?? null,
          input.indexNumber ?? null,
          input.parentIndexNumber ?? null,
          input.titleIsPlaceholder === true,
        ],
      );
      const row = result.rows[0];
      if (!row) throw new Error("Item upsert returned no row.");
      return row.id;
    },

    setItemRelations: async (itemId, { parentId, seriesId }) => {
      await pool.query(
        `UPDATE items SET parent_id = $2, series_id = $3, updated_at = now()
         WHERE id = $1
           AND (parent_id IS DISTINCT FROM $2 OR series_id IS DISTINCT FROM $3)`,
        [itemId, parentId, seriesId],
      );
    },

    upsertFile: async (input: UpsertFileInput) => {
      // ffprobe cannot read an epub, and asking it to only produces a failed
      // row and a log line. A book is complete the moment it is catalogued.
      const initialProbeState = BOOK_EXTENSIONS.has(
        (input.container ?? "").toLowerCase(),
      )
        ? "probed"
        : "pending";

      const result = await pool.query<{ id: string; changed: boolean }>(
        `INSERT INTO media_files (
           id, item_id, relative_path, container, size_bytes, mtime_ms,
           fingerprint, is_primary, probe_state, last_seen_at, missing_since
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now(), NULL)
         ON CONFLICT (relative_path) DO UPDATE SET
           item_id = EXCLUDED.item_id,
           container = EXCLUDED.container,
           size_bytes = EXCLUDED.size_bytes,
           mtime_ms = EXCLUDED.mtime_ms,
           fingerprint = EXCLUDED.fingerprint,
           is_primary = EXCLUDED.is_primary,
           -- A container that is never probed is settled by definition, so a
           -- verdict recorded before it was excluded — a book that ffprobe was
           -- pointed at and predictably rejected — is corrected here. Otherwise
           -- it would stay failed forever, since only a content change
           -- invalidates a stored probe and a book's content never changes.
           probe_state = CASE
             WHEN EXCLUDED.probe_state = 'probed' THEN 'probed'
             WHEN media_files.fingerprint IS DISTINCT FROM EXCLUDED.fingerprint
               THEN EXCLUDED.probe_state
             ELSE media_files.probe_state END,
           probe_error = CASE
             WHEN EXCLUDED.probe_state = 'probed' THEN NULL
             WHEN media_files.fingerprint IS DISTINCT FROM EXCLUDED.fingerprint
               THEN NULL
             ELSE media_files.probe_error END,
           last_seen_at = now(),
           missing_since = NULL,
           updated_at = now()
         RETURNING id, (xmax = 0 OR media_files.probe_state = 'pending') AS changed`,
        [
          randomUUID(),
          input.itemId,
          input.relativePath,
          input.container || null,
          input.size,
          Math.trunc(input.mtimeMs),
          input.fingerprint,
          input.isPrimary,
          initialProbeState,
        ],
      );
      const row = result.rows[0];
      if (!row) throw new Error("Media file upsert returned no row.");
      return { id: row.id, changed: row.changed };
    },

    /**
     * One sidecar, recorded against one file, without touching the others.
     *
     * `replaceExternalSubtitles` is the scan's operation: it knows the whole
     * set for a title and rewrites it. A subtitle somebody has just uploaded is
     * the opposite case — one new file among however many are already recorded
     * — and rewriting the set from a single addition would drop every row the
     * scan had put there. Idempotent by path, so uploading the same subtitle
     * twice records it once, and a later scan renumbers the whole set anyway.
     */
    attachExternalSubtitle: async (input: {
      mediaFileId: string;
      relativePath: string;
      codec: string;
      isText: boolean;
      language: string | null;
      isForced: boolean;
    }) => {
      const existing = await pool.query(
        `SELECT 1 FROM media_streams
          WHERE media_file_id = $1 AND is_external = true
            AND external_relative_path = $2`,
        [input.mediaFileId, input.relativePath],
      );
      if ((existing.rowCount ?? 0) > 0) return;
      /*
       * The next index above whatever is already there, in the range the scan
       * reserves for sidecars, so a synthetic index can never collide with a
       * real stream's.
       */
      const used = await pool.query<{ next: number | null }>(
        `SELECT MAX(stream_index) + 1 AS next FROM media_streams
          WHERE media_file_id = $1 AND is_external = true`,
        [input.mediaFileId],
      );
      const streamIndex = Math.max(10_000, used.rows[0]?.next ?? 10_000);
      await pool.query(
        `INSERT INTO media_streams (
           media_file_id, stream_index, kind, codec, language, is_default, is_forced,
           is_external, is_text_subtitle, external_relative_path
         )
         VALUES ($1, $2, 'subtitle', $3, $4, false, $5, true, $6, $7)
         ON CONFLICT (media_file_id, stream_index) DO NOTHING`,
        [
          input.mediaFileId,
          streamIndex,
          input.codec,
          input.language,
          input.isForced,
          input.isText,
          input.relativePath,
        ],
      );
    },

    replaceExternalSubtitles: async (
      itemId: string,
      subtitles: ScannedSubtitle[],
    ) => {
      const fileResult = await pool.query<{ id: string }>(
        `SELECT id FROM media_files
         WHERE item_id = $1 AND missing_since IS NULL
         ORDER BY is_primary DESC, size_bytes DESC, id
         LIMIT 1`,
        [itemId],
      );
      const mediaFileId = fileResult.rows[0]?.id;
      if (!mediaFileId) return;

      // A replacement file can leave the former primary row around during the
      // missing-file grace period. Remove sidecars from every cut before
      // attaching them to the currently playable primary; otherwise a rescan
      // can strand a valid subtitle on a file that no longer exists.
      await pool.query(
        `DELETE FROM media_streams
         WHERE is_external = true
           AND media_file_id IN (SELECT id FROM media_files WHERE item_id = $1)`,
        [itemId],
      );

      // External subtitles occupy a high index range so they cannot collide with
      // the container's own stream indexes.
      let externalIndex = 10_000;
      for (const subtitle of subtitles) {
        await pool.query(
          `INSERT INTO media_streams (
             media_file_id, stream_index, kind, codec, language, is_default, is_forced,
             is_external, is_text_subtitle, external_relative_path
           )
           VALUES ($1, $2, 'subtitle', $3, $4, $5, $6, true, $7, $8)
           ON CONFLICT (media_file_id, stream_index) DO NOTHING`,
          [
            mediaFileId,
            externalIndex,
            subtitle.codec,
            subtitle.language ?? null,
            subtitle.isDefault,
            subtitle.isForced,
            subtitle.isText,
            subtitle.relativePath,
          ],
        );
        externalIndex += 1;
      }
    },

    markItemsSeen: async (itemIds) => {
      if (itemIds.length === 0) return;
      await pool.query(
        `UPDATE items SET last_seen_at = now(), missing_since = NULL
         WHERE id = ANY($1) AND missing_since IS NOT NULL`,
        [itemIds],
      );
    },

    markFilesSeen: async (fileIds) => {
      if (fileIds.length === 0) return;
      await pool.query(
        `UPDATE media_files SET last_seen_at = now(), missing_since = NULL
         WHERE id = ANY($1) AND missing_since IS NOT NULL`,
        [fileIds],
      );
    },

    markItemsMissing: async (itemIds, missingSince) => {
      if (itemIds.length === 0) return;
      await pool.query(
        `UPDATE items SET missing_since = $2 WHERE id = ANY($1) AND missing_since IS NULL`,
        [itemIds, missingSince],
      );
    },

    markFilesMissing: async (fileIds, missingSince) => {
      if (fileIds.length === 0) return;
      await pool.query(
        `UPDATE media_files SET missing_since = $2 WHERE id = ANY($1) AND missing_since IS NULL`,
        [fileIds, missingSince],
      );
    },

    deleteItems: async (itemIds) => {
      if (itemIds.length === 0) return;
      await pool.query(`DELETE FROM items WHERE id = ANY($1)`, [itemIds]);
    },

    deleteFiles: async (fileIds) => {
      if (fileIds.length === 0) return;
      await pool.query(`DELETE FROM media_files WHERE id = ANY($1)`, [fileIds]);
    },

    markPackaged: async (fileIds) => {
      if (fileIds.length === 0) return;
      // A probe that succeeded before packaging keeps its streams; only a row
      // that was waiting for, or failed, a probe of the vanished source changes.
      await pool.query(
        `UPDATE media_files SET probe_state = 'packaged', probe_error = NULL, updated_at = now()
         WHERE id = ANY($1) AND probe_state IN ('pending', 'failed')`,
        [fileIds],
      );
    },

    queueProbe: async (fileIds) => {
      if (fileIds.length === 0) return;
      // A book is reported as changed like any other file, but there is still
      // nothing for ffprobe to read, so it must not be put back into the queue.
      await pool.query(
        `UPDATE media_files SET probe_state = 'pending', probe_error = NULL
         WHERE id = ANY($1) AND lower(COALESCE(container, '')) <> ALL($2)`,
        [fileIds, [...BOOK_EXTENSIONS]],
      );
    },

    refreshItemCounts: async (libraryId) => {
      // A collection counts the members still on disk, as a season does.
      await pool.query(
        `UPDATE items collection SET
           child_count = counts.total,
           recursive_item_count = counts.total,
           updated_at = now()
         FROM (
           SELECT parent.id, count(member.item_id)
             FILTER (WHERE film.missing_since IS NULL)::int AS total
           FROM items parent
           LEFT JOIN collection_members member ON member.collection_id = parent.id
           LEFT JOIN items film ON film.id = member.item_id
           WHERE parent.kind = 'collection' AND parent.library_id = $1
           GROUP BY parent.id
         ) counts
         WHERE collection.id = counts.id
           AND (collection.child_count, collection.recursive_item_count)
               IS DISTINCT FROM (counts.total, counts.total)`,
        [libraryId],
      );

      // A LATERAL subquery in UPDATE ... FROM cannot reference the update
      // target, so the counts are computed over the whole library first and
      // joined back by id. The LEFT JOIN is what makes an emptied season reset
      // to zero: a plain grouped join would produce no row for it at all.
      await pool.query(
        `UPDATE items season SET
           child_count = counts.total,
           recursive_item_count = counts.total,
           updated_at = now()
         FROM (
           SELECT parent.id, count(episode.id)::int AS total
           FROM items parent
           LEFT JOIN items episode
             ON episode.parent_id = parent.id
            AND episode.kind = 'episode'
            AND episode.missing_since IS NULL
           WHERE parent.kind = 'season' AND parent.library_id = $1
           GROUP BY parent.id
         ) counts
         WHERE season.id = counts.id
           AND (season.child_count, season.recursive_item_count)
               IS DISTINCT FROM (counts.total, counts.total)`,
        [libraryId],
      );

      await pool.query(
        `UPDATE items series SET
           child_count = counts.season_total,
           recursive_item_count = counts.episode_total,
           updated_at = now()
         FROM (
           SELECT
             parent.id,
             count(DISTINCT season.id)::int AS season_total,
             count(DISTINCT episode.id)::int AS episode_total
           FROM items parent
           LEFT JOIN items season
             ON season.parent_id = parent.id
            AND season.kind = 'season'
            AND season.missing_since IS NULL
           LEFT JOIN items episode
             ON episode.series_id = parent.id
            AND episode.kind = 'episode'
            AND episode.missing_since IS NULL
           WHERE parent.kind = 'series' AND parent.library_id = $1
           GROUP BY parent.id
         ) counts
         WHERE series.id = counts.id
           AND (series.child_count, series.recursive_item_count)
               IS DISTINCT FROM (counts.season_total, counts.episode_total)`,
        [libraryId],
      );
    },
  };
}
