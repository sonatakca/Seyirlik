/**
 * Files that hold several episodes, and where each one plays.
 *
 * TMDB numbers SpongeBob per eleven-minute story while the files are
 * half-hours of two or three of them; `media_file_episodes` says which
 * episodes a file really holds (see migration 050). An episode held that way
 * has no file of its own, so it plays from its host's file, starting at its own
 * offset, and the player names whichever part is under the playhead.
 *
 * Which file an item plays from is ranked the same way by playback
 * (`getPlayableFile`) and by the item DTO here, so the strip cannot offer an
 * offset into a different file from the one that plays.
 */
import type { DatabasePool } from "../database/databasePool";
import { withTransaction } from "../database/transaction";

export type FileEpisodeSource = "release" | "detected" | "manual" | "survey";

export interface FileEpisodePartInput {
  readonly itemId: string;
  readonly startMs: number | null;
  readonly endMs: number | null;
}

export interface FilePartDto {
  itemId: string;
  title: string;
  indexNumber?: number;
  parentIndexNumber?: number;
  startMs?: number;
  endMs?: number;
}

export interface FileEpisodeView {
  /** The file this item plays from and its stretch of it. */
  playAs: { mediaFileId: string; startMs?: number; endMs?: number };
  /** Every episode in that file, in playing order. */
  fileParts: FilePartDto[];
}

export interface FileEpisodeRepository {
  /** Only items that play from a file with parts appear in the map. */
  listForItems(itemIds: readonly string[]): Promise<Map<string, FileEpisodeView>>;
  /**
   * Replaces what one file holds, in playing order. An empty list returns the
   * file to holding just the item it is filed under.
   */
  replaceForFile(
    mediaFileId: string,
    parts: readonly FileEpisodePartInput[],
    source: FileEpisodeSource,
  ): Promise<void>;
}

/** A file the last scan found and the prober did not reject. */
export const FILE_PLAYABLE = (file: string) =>
  `${file}.missing_since IS NULL AND ${file}.size_bytes > 0 AND ${file}.probe_state <> 'failed'`;

/**
 * The candidates an item can play from, best first: a whole file of its own
 * (no parts) beats any part, and among parts its own file beats a host's.
 * `$1` is the item id; the select list is the caller's.
 */
export function playableFileCandidatesSql(select: string): string {
  return `SELECT ${select}, 0 AS playable_rank, NULL::bigint AS part_start_ms, NULL::bigint AS part_end_ms
      FROM media_files f
     WHERE f.item_id = $1 AND f.missing_since IS NULL
       AND NOT EXISTS (SELECT 1 FROM media_file_episodes whole WHERE whole.media_file_id = f.id)
    UNION ALL
    SELECT ${select}, CASE WHEN f.item_id = $1 THEN 1 ELSE 2 END, part.start_ms, part.end_ms
      FROM media_file_episodes part JOIN media_files f ON f.id = part.media_file_id
     WHERE part.item_id = $1 AND f.missing_since IS NULL`;
}

export const PLAYABLE_FILE_ORDER =
  "playable_rank, is_primary DESC, size_bytes DESC";

function optionalNumber(value: string | number | null): number | undefined {
  return value === null ? undefined : Number(value);
}

export function createFileEpisodeRepository(
  pool: Pick<DatabasePool, "query" | "connect">,
): FileEpisodeRepository {
  return {
    async listForItems(itemIds) {
      const views = new Map<string, FileEpisodeView>();
      if (itemIds.length === 0) return views;

      /*
       * The same ranking as `getPlayableFile`, per item. An item with a whole
       * file of its own plays that and gets no view; the rest play the best
       * part that holds them.
       */
      const chosen = await pool.query<{
        item_id: string;
        media_file_id: string;
        start_ms: string | number | null;
        end_ms: string | number | null;
      }>(
        `SELECT DISTINCT ON (part.item_id) part.item_id, part.media_file_id, part.start_ms, part.end_ms
           FROM media_file_episodes part JOIN media_files f ON f.id = part.media_file_id
          WHERE part.item_id = ANY($1::uuid[]) AND ${FILE_PLAYABLE("f")}
            AND NOT EXISTS (SELECT 1 FROM media_files own WHERE own.item_id = part.item_id
              AND ${FILE_PLAYABLE("own")}
              AND NOT EXISTS (SELECT 1 FROM media_file_episodes whole WHERE whole.media_file_id = own.id))
          ORDER BY part.item_id, (f.item_id = part.item_id) DESC, f.is_primary DESC, f.size_bytes DESC`,
        [[...itemIds]],
      );
      if (chosen.rows.length === 0) return views;

      const parts = await pool.query<{
        media_file_id: string;
        item_id: string;
        title: string;
        index_number: number | null;
        parent_index_number: number | null;
        start_ms: string | number | null;
        end_ms: string | number | null;
      }>(
        `SELECT part.media_file_id, part.item_id, item.title, item.index_number, item.parent_index_number,
                part.start_ms, part.end_ms
           FROM media_file_episodes part JOIN items item ON item.id = part.item_id
          WHERE part.media_file_id = ANY($1::uuid[])
          ORDER BY part.media_file_id, part.ordinal`,
        [[...new Set(chosen.rows.map((row) => row.media_file_id))]],
      );
      const partsByFile = new Map<string, FilePartDto[]>();
      for (const row of parts.rows) {
        const startMs = optionalNumber(row.start_ms);
        const endMs = optionalNumber(row.end_ms);
        const list = partsByFile.get(row.media_file_id) ?? [];
        list.push({
          itemId: row.item_id,
          title: row.title,
          ...(row.index_number === null ? {} : { indexNumber: row.index_number }),
          ...(row.parent_index_number === null
            ? {}
            : { parentIndexNumber: row.parent_index_number }),
          ...(startMs === undefined ? {} : { startMs }),
          ...(endMs === undefined ? {} : { endMs }),
        });
        partsByFile.set(row.media_file_id, list);
      }

      for (const row of chosen.rows) {
        const startMs = optionalNumber(row.start_ms);
        const endMs = optionalNumber(row.end_ms);
        views.set(row.item_id, {
          playAs: {
            mediaFileId: row.media_file_id,
            ...(startMs === undefined ? {} : { startMs }),
            ...(endMs === undefined ? {} : { endMs }),
          },
          fileParts: partsByFile.get(row.media_file_id) ?? [],
        });
      }
      return views;
    },

    async replaceForFile(mediaFileId, parts, source) {
      await withTransaction(pool, async (client) => {
        await client.query(
          "DELETE FROM media_file_episodes WHERE media_file_id = $1",
          [mediaFileId],
        );
        for (const [ordinal, part] of parts.entries()) {
          await client.query(
            `INSERT INTO media_file_episodes (media_file_id, item_id, ordinal, start_ms, end_ms, source)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [mediaFileId, part.itemId, ordinal, part.startMs, part.endMs, source],
          );
        }
      });
    },
  };
}
