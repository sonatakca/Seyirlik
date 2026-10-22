import { randomUUID } from "node:crypto";
import { resolveTitleRoot } from "./titleRoot";
import type { DatabasePool } from "../database/databasePool";
import type { TmdbPerson } from "./tmdbClient";

export interface MetadataTarget {
  id: string;
  kind: string;
  title: string;
  productionYear: number | null;
  providerIds: Record<string, string>;
  lockedFields: string[];
  seriesId: string | null;
  indexNumber: number | null;
  parentIndexNumber: number | null;
  /** Existing title directory, relative to the media root, when the item owns one. */
  titleRoot?: string;
  metadataState?: string;
}

export interface TitleMetadataUpdate {
  title?: string;
  originalTitle?: string;
  overview?: string;
  tagline?: string;
  premiereDate?: string;
  endDate?: string;
  productionYear?: number;
  officialRating?: string;
  communityRating?: number;
  runtimeMs?: number;
  providerIds?: Record<string, string>;
  metadataState?: "matched" | "unmatched" | "failed" | "locked";
}

export interface MetadataRepository {
  listPendingItems(
    limit: number,
    libraryId?: string,
  ): Promise<MetadataTarget[]>;
  getTarget(itemId: string): Promise<MetadataTarget | null>;
  listSeasonsForSeries(seriesId: string): Promise<MetadataTarget[]>;
  listEpisodesForSeries(seriesId: string): Promise<MetadataTarget[]>;
  applyTitleMetadata(
    itemId: string,
    update: TitleMetadataUpdate,
  ): Promise<void>;
  replaceGenres(itemId: string, genres: string[]): Promise<void>;
  replacePeople(itemId: string, people: TmdbPerson[]): Promise<void>;
  markFailed(itemId: string): Promise<void>;
  lockFields(itemId: string, fields: string[]): Promise<void>;
  /**
   * Places and sizes the logo on this title's card, or clears the adjustment
   * with null. Returns false for an unknown id.
   */
  setLogoLayout(
    itemId: string,
    layout: { x: number; y: number; width: number; shadow: number } | null,
  ): Promise<boolean>;
}

const TARGET_COLUMNS = `
  id, kind, title, production_year, provider_ids, locked_fields,
  series_id, index_number, parent_index_number, source_key, metadata_state,
  (SELECT relative_path FROM media_files
   WHERE media_files.item_id = items.id AND media_files.is_primary = true
   ORDER BY media_files.created_at LIMIT 1) AS primary_relative_path,
  -- A series owns no file of its own, so its folder can only be read off an
  -- episode's path. Without this a series has no title root and its artwork
  -- never reaches the folder a person browses.
  (SELECT mf.relative_path FROM media_files mf
   JOIN items child ON child.id = mf.item_id
   WHERE child.series_id = items.id
   ORDER BY mf.created_at LIMIT 1) AS descendant_relative_path
`;

interface RawTargetRow {
  id: string;
  kind: string;
  title: string;
  production_year: number | null;
  provider_ids: Record<string, string>;
  locked_fields: string[];
  series_id: string | null;
  index_number: number | null;
  parent_index_number: number | null;
  source_key: string;
  metadata_state: string;
  primary_relative_path: string | null;
  descendant_relative_path: string | null;
}

function toTarget(row: RawTargetRow): MetadataTarget {
  const titleRoot = resolveTitleRoot({
    kind: row.kind,
    sourceKey: row.source_key,
    primaryRelativePath: row.primary_relative_path,
    descendantRelativePath: row.descendant_relative_path,
  });

  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    productionYear: row.production_year,
    providerIds: row.provider_ids ?? {},
    lockedFields: row.locked_fields ?? [],
    seriesId: row.series_id,
    indexNumber: row.index_number,
    parentIndexNumber: row.parent_index_number,
    ...(titleRoot ? { titleRoot } : {}),
    ...(row.metadata_state ? { metadataState: row.metadata_state } : {}),
  };
}

function normalizeName(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

export function createMetadataRepository(
  pool: DatabasePool,
): MetadataRepository {
  return {
    listPendingItems: async (limit, libraryId) => {
      const values: unknown[] = [limit];
      let libraryFilter = "";
      if (libraryId) {
        values.push(libraryId);
        libraryFilter = `AND library_id = $${values.length}`;
      }

      const result = await pool.query<RawTargetRow>(
        /*
         * A series identified before some of its episodes arrived is pending
         * again until they are described: its episodes are only ever filled
         * in by the series' own refresh, and a matched series is never
         * selected for one otherwise.
         */
        `SELECT ${TARGET_COLUMNS} FROM items
         WHERE (
             (metadata_state = 'pending' AND kind IN ('movie', 'series'))
             OR (metadata_state = 'matched' AND kind = 'series'
                 AND EXISTS (
                   SELECT 1 FROM items episode
                    WHERE episode.series_id = items.id
                      AND episode.kind = 'episode'
                      AND episode.metadata_state = 'pending'
                      AND episode.missing_since IS NULL))
           )
           AND missing_since IS NULL
           ${libraryFilter}
         ORDER BY date_created
         LIMIT $1`,
        values,
      );
      return result.rows.map(toTarget);
    },

    getTarget: async (itemId) => {
      const result = await pool.query<RawTargetRow>(
        `SELECT ${TARGET_COLUMNS} FROM items WHERE id = $1`,
        [itemId],
      );
      const row = result.rows[0];
      return row ? toTarget(row) : null;
    },

    listSeasonsForSeries: async (seriesId) => {
      const result = await pool.query<RawTargetRow>(
        `SELECT ${TARGET_COLUMNS} FROM items
         WHERE parent_id = $1 AND kind = 'season'
         ORDER BY COALESCE(index_number, 0)`,
        [seriesId],
      );
      return result.rows.map(toTarget);
    },

    listEpisodesForSeries: async (seriesId) => {
      const result = await pool.query<RawTargetRow>(
        `SELECT ${TARGET_COLUMNS} FROM items
         WHERE series_id = $1 AND kind = 'episode'
         ORDER BY COALESCE(parent_index_number, 0), COALESCE(index_number, 0)`,
        [seriesId],
      );
      return result.rows.map(toTarget);
    },

    applyTitleMetadata: async (itemId, update) => {
      // Each field is guarded by its own lock inside the statement, so an admin
      // edit made while a refresh is in flight is never clobbered by a
      // read-modify-write race.
      await pool.query(
        `UPDATE items SET
           title = CASE WHEN $2::text IS NOT NULL AND NOT ('title' = ANY(locked_fields))
                        THEN $2 ELSE title END,
           sort_title = CASE WHEN $3::text IS NOT NULL AND NOT ('title' = ANY(locked_fields))
                        THEN $3 ELSE sort_title END,
           original_title = CASE WHEN NOT ('originalTitle' = ANY(locked_fields))
                        THEN COALESCE($4, original_title) ELSE original_title END,
           overview = CASE WHEN NOT ('overview' = ANY(locked_fields))
                        THEN COALESCE($5, overview) ELSE overview END,
           tagline = CASE WHEN NOT ('tagline' = ANY(locked_fields))
                        THEN COALESCE($6, tagline) ELSE tagline END,
           premiere_date = CASE WHEN NOT ('premiereDate' = ANY(locked_fields))
                        THEN COALESCE($7::timestamptz, premiere_date) ELSE premiere_date END,
           end_date = COALESCE($8::timestamptz, end_date),
           production_year = CASE WHEN NOT ('productionYear' = ANY(locked_fields))
                        THEN COALESCE($9::int, production_year) ELSE production_year END,
           official_rating = CASE WHEN NOT ('officialRating' = ANY(locked_fields))
                        THEN COALESCE($10, official_rating) ELSE official_rating END,
           community_rating = COALESCE($11::real, community_rating),
           -- Runtime measured from the file always wins over the provider's.
           runtime_ms = COALESCE(runtime_ms, $12::bigint),
           provider_ids = provider_ids || COALESCE($13::jsonb, '{}'::jsonb),
           metadata_state = COALESCE($14, metadata_state),
           metadata_refreshed_at = now(),
           updated_at = now()
         WHERE id = $1`,
        [
          itemId,
          update.title ?? null,
          update.title
            ? update.title
                .normalize("NFKD")
                .replace(/\p{M}/gu, "")
                .toLowerCase()
                .replace(/^(the|a|an)\s+/, "")
                .trim()
            : null,
          update.originalTitle ?? null,
          update.overview ?? null,
          update.tagline ?? null,
          update.premiereDate ?? null,
          update.endDate ?? null,
          update.productionYear ?? null,
          update.officialRating ?? null,
          update.communityRating ?? null,
          update.runtimeMs ?? null,
          update.providerIds ? JSON.stringify(update.providerIds) : null,
          update.metadataState ?? null,
        ],
      );
    },

    replaceGenres: async (itemId, genres) => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(`DELETE FROM item_genres WHERE item_id = $1`, [
          itemId,
        ]);

        for (const [index, genre] of genres.entries()) {
          const normalized = normalizeName(genre);
          if (!normalized) continue;

          const inserted = await client.query<{ id: string }>(
            `INSERT INTO genres (id, name, normalized_name)
             VALUES ($1, $2, $3)
             ON CONFLICT (normalized_name) DO UPDATE SET name = genres.name
             RETURNING id`,
            [randomUUID(), genre.trim(), normalized],
          );
          const genreId = inserted.rows[0]?.id;
          if (!genreId) continue;

          await client.query(
            `INSERT INTO item_genres (item_id, genre_id, sort_order)
             VALUES ($1, $2, $3)
             ON CONFLICT (item_id, genre_id) DO UPDATE SET sort_order = EXCLUDED.sort_order`,
            [itemId, genreId, index],
          );
        }
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },

    replacePeople: async (itemId, people) => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(`DELETE FROM item_people WHERE item_id = $1`, [
          itemId,
        ]);

        for (const person of people) {
          const normalized = normalizeName(person.name);
          if (!normalized) continue;

          const inserted = await client.query<{ id: string }>(
            `INSERT INTO people (id, name, normalized_name, provider_ids)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (normalized_name) DO UPDATE SET
               provider_ids = people.provider_ids || EXCLUDED.provider_ids
             RETURNING id`,
            [
              randomUUID(),
              person.name.trim(),
              normalized,
              // The headshot path rides with the TMDB id: it is TMDB's, and the
              // merge below keeps the last one TMDB gave.
              JSON.stringify({
                tmdb: person.providerId,
                ...(person.profilePath
                  ? { tmdbProfilePath: person.profilePath }
                  : {}),
              }),
            ],
          );
          const personId = inserted.rows[0]?.id;
          if (!personId) continue;

          await client.query(
            `INSERT INTO item_people (item_id, person_id, role, character_name, sort_order)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (item_id, person_id, role) DO UPDATE SET
               character_name = EXCLUDED.character_name,
               sort_order = EXCLUDED.sort_order`,
            [
              itemId,
              personId,
              person.role,
              person.character ?? null,
              person.order,
            ],
          );
        }
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },

    markFailed: async (itemId) => {
      await pool.query(
        `UPDATE items SET metadata_state = 'failed', metadata_refreshed_at = now()
         WHERE id = $1`,
        [itemId],
      );
    },

    setLogoLayout: async (itemId, layout) => {
      // The three columns move together: a half-set layout would fail the
      // constraint, and a partly-cleared one would be meaningless.
      const result = await pool.query(
        `UPDATE items SET
           logo_offset_x = $2::real,
           logo_offset_y = $3::real,
           logo_width = $4::real,
           logo_shadow = $5::real,
           updated_at = now()
         WHERE id = $1`,
        [
          itemId,
          layout?.x ?? null,
          layout?.y ?? null,
          layout?.width ?? null,
          layout?.shadow ?? null,
        ],
      );
      return (result.rowCount ?? 0) > 0;
    },

    lockFields: async (itemId, fields) => {
      await pool.query(
        `UPDATE items SET
           locked_fields = ARRAY(SELECT DISTINCT unnest(locked_fields || $2::text[])),
           updated_at = now()
         WHERE id = $1`,
        [itemId, fields],
      );
    },
  };
}
