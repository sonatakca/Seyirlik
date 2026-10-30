import { mediaAvailableSql } from "./mediaAvailability";
import { contentRatingAllowedSql } from "./contentRating";
import type { DatabasePool } from "../database/databasePool";
import type { SearchCandidate } from "./searchRanking";

export type ItemKind =
  | "movie"
  | "series"
  | "season"
  | "episode"
  | "book"
  | "collection"
  | "trailer";

export interface CatalogueItemRow {
  id: string;
  libraryId: string;
  parentId: string | null;
  seriesId: string | null;
  kind: ItemKind;
  title: string;
  sortTitle: string;
  originalTitle: string | null;
  overview: string | null;
  tagline: string | null;
  productionYear: number | null;
  premiereDate: Date | null;
  officialRating: string | null;
  communityRating: number | null;
  runtimeMs: string | null;
  indexNumber: number | null;
  parentIndexNumber: number | null;
  providerIds: Record<string, string>;
  childCount: number;
  recursiveItemCount: number;
  dateCreated: Date;
  missingSince: Date | null;
  /** Fine logo placement on the card, or null when never adjusted. */
  logoLayout: { x: number; y: number; width: number; shadow: number } | null;
  /**
   * An episode's card shows its series' poster and logo, so it needs the
   * series' placement too. Absent when the series was never adjusted.
   */
  seriesLogoLayout?: { x: number; y: number; width: number; shadow: number };
  seriesTitle: string | null;
  seasonTitle: string | null;
  genres: string[];
}

const ITEM_COLUMNS = `
  item.id,
  item.library_id,
  item.parent_id,
  item.series_id,
  item.kind,
  item.title,
  item.sort_title,
  item.original_title,
  item.overview,
  item.tagline,
  item.production_year,
  item.premiere_date,
  item.official_rating,
  item.community_rating,
  item.runtime_ms,
  item.index_number,
  item.parent_index_number,
  item.provider_ids,
  item.child_count,
  item.recursive_item_count,
  item.date_created,
  item.missing_since,
  item.logo_offset_x,
  item.logo_offset_y,
  item.logo_width,
  item.logo_shadow,
  series.logo_offset_x AS series_logo_offset_x,
  series.logo_offset_y AS series_logo_offset_y,
  series.logo_width AS series_logo_width,
  series.logo_shadow AS series_logo_shadow,
  series.title AS series_title,
  season.title AS season_title,
  COALESCE(
    (
      SELECT array_agg(genre.name ORDER BY item_genre.sort_order)
      FROM item_genres item_genre
      JOIN genres genre ON genre.id = item_genre.genre_id
      WHERE item_genre.item_id = item.id
    ),
    ARRAY[]::varchar[]
  ) AS genres
`;

const ITEM_JOINS = `
  FROM items item
  LEFT JOIN items series ON series.id = item.series_id
  LEFT JOIN items season ON season.id = item.parent_id AND season.kind = 'season'
`;

interface RawItemRow extends Record<string, unknown> {
  id: string;
  library_id: string;
  parent_id: string | null;
  series_id: string | null;
  kind: ItemKind;
  title: string;
  sort_title: string;
  original_title: string | null;
  overview: string | null;
  tagline: string | null;
  production_year: number | null;
  premiere_date: Date | null;
  official_rating: string | null;
  community_rating: number | null;
  runtime_ms: string | null;
  index_number: number | null;
  parent_index_number: number | null;
  provider_ids: Record<string, string>;
  child_count: number;
  recursive_item_count: number;
  date_created: Date;
  missing_since: Date | null;
  logo_offset_x: number | null;
  logo_offset_y: number | null;
  logo_width: number | null;
  logo_shadow: number | null;
  series_logo_offset_x: number | null;
  series_logo_offset_y: number | null;
  series_logo_width: number | null;
  series_logo_shadow: number | null;
  series_title: string | null;
  season_title: string | null;
  genres: string[];
}

function toLogoLayout(
  x: number | null,
  y: number | null,
  width: number | null,
  shadow: number | null,
): CatalogueItemRow["logoLayout"] {
  return x === null || y === null || width === null || shadow === null
    ? null
    : { x, y, width, shadow };
}

function toItemRow(row: RawItemRow): CatalogueItemRow {
  const seriesLogoLayout = toLogoLayout(
    row.series_logo_offset_x,
    row.series_logo_offset_y,
    row.series_logo_width,
    row.series_logo_shadow,
  );
  return {
    id: row.id,
    libraryId: row.library_id,
    parentId: row.parent_id,
    seriesId: row.series_id,
    kind: row.kind,
    title: row.title,
    sortTitle: row.sort_title,
    originalTitle: row.original_title,
    overview: row.overview,
    tagline: row.tagline,
    productionYear: row.production_year,
    premiereDate: row.premiere_date,
    officialRating: row.official_rating,
    communityRating: row.community_rating,
    runtimeMs: row.runtime_ms,
    indexNumber: row.index_number,
    parentIndexNumber: row.parent_index_number,
    providerIds: row.provider_ids ?? {},
    childCount: row.child_count,
    recursiveItemCount: row.recursive_item_count,
    dateCreated: row.date_created,
    missingSince: row.missing_since,
    logoLayout: toLogoLayout(
      row.logo_offset_x,
      row.logo_offset_y,
      row.logo_width,
      row.logo_shadow,
    ),
    ...(seriesLogoLayout ? { seriesLogoLayout } : {}),
    seriesTitle: row.series_title,
    seasonTitle: row.season_title,
    genres: row.genres ?? [],
  };
}

export interface LibraryRow {
  id: string;
  slug: string;
  name: string;
  kind: string;
  sortOrder: number;
  itemCount: number;
}

export interface MediaFileRow {
  id: string;
  itemId: string;
  relativePath: string;
  container: string | null;
  sizeBytes: string;
  mtimeMs: string;
  fingerprint: string;
  durationMs: string | null;
  bitrateBps: string | null;
  isPrimary: boolean;
  probeState: "pending" | "probed" | "failed" | "packaged";
  missingSince: Date | null;
}

export interface MediaStreamRow {
  streamIndex: number;
  kind: "video" | "audio" | "subtitle" | "attachment" | "data";
  codec: string | null;
  profile: string | null;
  level: number | null;
  language: string | null;
  title: string | null;
  isDefault: boolean;
  isForced: boolean;
  isExternal: boolean;
  isTextSubtitle: boolean;
  externalRelativePath: string | null;
  channels: number | null;
  sampleRate: number | null;
  bitrateBps: string | null;
  width: number | null;
  height: number | null;
  pixelFormat: string | null;
  frameRate: number | null;
  videoRange: string | null;
  colorTransfer: string | null;
  colorPrimaries: string | null;
  colorSpace: string | null;
  bitDepth: number | null;
}

/**
 * Visibility rule shared by every catalogue read: a user sees a library when
 * they are allowed all libraries or hold an explicit grant. Applied inside SQL
 * rather than after the fact so that pagination totals and cursors stay correct.
 */
export const LIBRARY_VISIBILITY_PREDICATE = `
  EXISTS (
    SELECT 1
    FROM libraries visible_library
    JOIN native_users viewer ON viewer.id = $1
    WHERE visible_library.id = item.library_id
      AND viewer.is_disabled = false
      AND ${contentRatingAllowedSql()}
      AND (
        viewer.allow_all_libraries
        OR EXISTS (
          SELECT 1 FROM user_library_permissions grant_row
          WHERE grant_row.user_id = viewer.id
            AND grant_row.library_id = visible_library.id
        )
      )
  )
`;

export interface ItemPersonRow {
  personId: string;
  name: string;
  role: "actor" | "director" | "writer" | "producer" | "composer" | "guest";
  characterName: string | null;
  tmdbProfilePath: string | null;
}

/**
 * Read side of the catalogue. Scan-time writes live in `catalogueScanStore.ts`:
 * the two have colliding operation names (`listItems` over a user's visible
 * catalogue versus over a library's raw rows) and very different authorization
 * rules, so keeping them apart prevents a read path from accidentally reaching
 * an unfiltered query.
 */
export interface CatalogueRepository {
  listLibraries(userId: string): Promise<LibraryRow[]>;
  getLibrary(userId: string, libraryId: string): Promise<LibraryRow | null>;
  getItem(userId: string, itemId: string): Promise<CatalogueItemRow | null>;
  /** Batch variant; result order is unspecified, callers re-order as needed. */
  getItemsByIds(userId: string, itemIds: string[]): Promise<CatalogueItemRow[]>;
  listItems(options: ListItemsOptions): Promise<CatalogueItemRow[]>;
  listChildren(
    userId: string,
    parentId: string,
    kind: ItemKind,
  ): Promise<CatalogueItemRow[]>;
  listSeriesEpisodes(
    userId: string,
    seriesId: string,
  ): Promise<CatalogueItemRow[]>;
  searchItems(
    userId: string,
    query: string,
    limit: number,
  ): Promise<CatalogueItemRow[]>;
  /**
   * Titles only, for the in-memory fuzzy pass. Deliberately not full item rows:
   * this runs over the whole visible catalogue, so it has to stay cheap.
   */
  listSearchCandidates(
    userId: string,
    limit: number,
  ): Promise<SearchCandidate[]>;
  listFilesForItem(itemId: string): Promise<MediaFileRow[]>;
  /**
   * An item's kind, unscoped and without its rows.
   *
   * Read by the processing layer, which needs to know whether a source
   * publishes beside itself or into its own folder, and has an item id rather
   * than a viewer.
   */
  getItemKind(itemId: string): Promise<ItemKind | null>;
  getPrimaryFile(itemId: string): Promise<MediaFileRow | null>;
  getFileById(fileId: string): Promise<MediaFileRow | null>;
  listStreams(mediaFileId: string): Promise<MediaStreamRow[]>;
  /**
   * Streams for many files at once, keyed by file.
   *
   * The single-file read above is per-title by nature; asking it once per
   * episode is the N+1 that makes a season of Ezel cost seventy-one round
   * trips. This is the same rows in one statement.
   */
  listStreamsForFiles(
    mediaFileIds: readonly string[],
  ): Promise<Map<string, MediaStreamRow[]>>;
  listChapters(
    itemId: string,
  ): Promise<Array<{ index: number; startMs: string; name: string | null }>>;
  listSegments(
    itemId: string,
  ): Promise<
    Array<{ id: string; type: string; startMs: string; endMs: string }>
  >;
  /** An item's credited people, cast in billing order and then crew. */
  listPeople(itemId: string): Promise<ItemPersonRow[]>;
  listPendingProbeFiles(limit: number): Promise<MediaFileRow[]>;
  /**
   * Every book's file on disk, chosen as `getPrimaryFile` chooses it.
   * Unscoped by user: the book search prepares the library, not a reader's view
   * of it.
   */
  listBookFiles(): Promise<MediaFileRow[]>;
  /**
   * Every movie and episode the processing page can act on, with its canonical
   * source and that source's persisted probe, in one statement.
   *
   * Unscoped by user, like the other file-level reads here: processing is an
   * administrator's view of the volume rather than a catalogue browse.
   */
  listProcessableTitles(
    options?: ListProcessableTitlesOptions,
  ): Promise<ProcessableTitleRow[]>;
  listGenres(
    userId: string,
    libraryId?: string,
  ): Promise<Array<{ name: string; itemCount: number }>>;
  canUserAccessItem(userId: string, itemId: string): Promise<boolean>;
  /** Films and series the provider has matched, for a pass that asks it more. */
  listEnrichableTitles(): Promise<
    Array<{ itemId: string; kind: "movie" | "series"; title: string }>
  >;
}

/**
 * One unit of processable media, with everything the processing page needs to
 * describe it, read in a single statement.
 *
 * A movie is one of these. So is an episode — the hierarchy above it comes
 * along on the same row rather than being fetched per episode, because a
 * library of eighty-six Sopranos episodes must cost one query and not
 * eighty-six. Every technical figure here is the persisted probe result, so
 * building this view runs no ffprobe at all.
 */
export interface ProcessableTitleRow {
  itemId: string;
  libraryId: string;
  kind: "movie" | "episode";
  title: string;
  sortTitle: string;
  productionYear: number | null;
  runtimeMs: string | null;
  /** Episode number within its season; null for a movie. */
  indexNumber: number | null;
  itemMissingSince: Date | null;

  seriesId: string | null;
  seriesTitle: string | null;
  seriesSortTitle: string | null;
  seriesYear: number | null;
  seasonId: string | null;
  seasonTitle: string | null;
  /**
   * The season's own number. Read from the season item rather than from the
   * episode's `parent_index_number` so a season folder that was renamed is
   * still one season, and so seasons sort by the same value they display.
   */
  seasonNumber: number | null;

  /**
   * The canonical playable file, chosen the way the rest of Seyirlik chooses
   * it. Null only for an item the catalogue kept with no file rows at all.
   */
  mediaFileId: string | null;
  relativePath: string | null;
  container: string | null;
  sizeBytes: string | null;
  mtimeMs: string | null;
  fingerprint: string | null;
  durationMs: string | null;
  bitrateBps: string | null;
  probeState: string | null;
  fileMissingSince: Date | null;
  /** How many playable files the catalogue holds for this item, canonical included. */
  fileCount: number;

  videoCodec: string | null;
  videoProfile: string | null;
  width: number | null;
  height: number | null;
  frameRate: number | null;
  pixelFormat: string | null;
  bitDepth: number | null;
  videoRange: string | null;
  colorTransfer: string | null;
  colorPrimaries: string | null;
  colorSpace: string | null;

  audioTrackCount: number;
  /** Subtitle streams inside the container. */
  subtitleTrackCount: number;
  /** Subtitle files sitting beside the source that the scanner matched to it. */
  externalSubtitleCount: number;
}

export interface ListProcessableTitlesOptions {
  /** Restrict to one library's titles. */
  libraryId?: string;
  /** Restrict to one series' episodes. */
  seriesId?: string;
  /** Restrict to one season's episodes. */
  seasonId?: string;
  kinds?: Array<"movie" | "episode">;
}

export interface ListItemsOptions {
  userId: string;
  libraryId?: string;
  kinds?: ItemKind[];
  parentId?: string;
  seriesId?: string;
  genre?: string;
  sort?: "title" | "dateCreated" | "premiereDate" | "communityRating" | "index";
  order?: "asc" | "desc";
  limit: number;
  cursor?: { key: string; id: string } | null;
  includeMissing?: boolean;
}

const SORT_COLUMNS: Record<
  NonNullable<ListItemsOptions["sort"]>,
  { expression: string; cursorKey: string }
> = {
  title: { expression: "item.sort_title", cursorKey: "sort_title" },
  dateCreated: { expression: "item.date_created", cursorKey: "date_created" },
  premiereDate: {
    expression: "item.premiere_date",
    cursorKey: "premiere_date",
  },
  communityRating: {
    expression: "item.community_rating",
    cursorKey: "community_rating",
  },
  index: {
    expression:
      "(COALESCE(item.parent_index_number, 0), COALESCE(item.index_number, 0))",
    cursorKey: "sort_title",
  },
};

export function createCatalogueRepository(
  pool: DatabasePool,
): CatalogueRepository {
  async function query<T extends Record<string, unknown>>(
    text: string,
    values: unknown[],
  ): Promise<T[]> {
    const result = await pool.query<T>(text, values);
    return result.rows;
  }

  async function selectItems(
    where: string,
    values: unknown[],
    orderBy: string,
    limit?: number,
  ): Promise<CatalogueItemRow[]> {
    const rows = await query<RawItemRow>(
      `SELECT ${ITEM_COLUMNS} ${ITEM_JOINS} WHERE ${where} ORDER BY ${orderBy}${
        limit === undefined ? "" : ` LIMIT ${Math.trunc(limit)}`
      }`,
      values,
    );
    return rows.map(toItemRow);
  }

  return {
    // ---------------------------------------------------------------- reads

    listLibraries: async (userId) => {
      const rows = await query<{
        id: string;
        slug: string;
        name: string;
        kind: string;
        sort_order: number;
        item_count: string;
      }>(
        `SELECT
           library.id,
           library.slug,
           library.name,
           library.kind,
           library.sort_order,
           (
             SELECT count(*)
             FROM items counted
             WHERE counted.library_id = library.id
               AND counted.kind IN ('movie', 'series', 'book')
               AND ${mediaAvailableSql("counted")}
           ) AS item_count
         FROM libraries library
         JOIN native_users viewer ON viewer.id = $1
         WHERE viewer.is_disabled = false
           AND (
             viewer.allow_all_libraries
             OR EXISTS (
               SELECT 1 FROM user_library_permissions grant_row
               WHERE grant_row.user_id = viewer.id
                 AND grant_row.library_id = library.id
             )
           )
         ORDER BY library.sort_order, library.name`,
        [userId],
      );

      return rows.map((row) => ({
        id: row.id,
        slug: row.slug,
        name: row.name,
        kind: row.kind,
        sortOrder: row.sort_order,
        itemCount: Number(row.item_count),
      }));
    },

    getLibrary: async (userId, libraryId) => {
      const rows = await query<{
        id: string;
        slug: string;
        name: string;
        kind: string;
        sort_order: number;
        item_count: string;
      }>(
        `SELECT
           library.id, library.slug, library.name, library.kind, library.sort_order,
           (
             SELECT count(*) FROM items counted
             WHERE counted.library_id = library.id
               AND counted.kind IN ('movie', 'series', 'book')
               AND ${mediaAvailableSql("counted")}
           ) AS item_count
         FROM libraries library
         JOIN native_users viewer ON viewer.id = $1
         WHERE library.id = $2
           AND viewer.is_disabled = false
           AND (
             viewer.allow_all_libraries
             OR EXISTS (
               SELECT 1 FROM user_library_permissions grant_row
               WHERE grant_row.user_id = viewer.id AND grant_row.library_id = library.id
             )
           )`,
        [userId, libraryId],
      );

      const row = rows[0];
      return row
        ? {
            id: row.id,
            slug: row.slug,
            name: row.name,
            kind: row.kind,
            sortOrder: row.sort_order,
            itemCount: Number(row.item_count),
          }
        : null;
    },

    getItem: async (userId, itemId) => {
      const rows = await selectItems(
        `item.id = $2 AND ${LIBRARY_VISIBILITY_PREDICATE}`,
        [userId, itemId],
        "item.sort_title",
        1,
      );
      return rows[0] ?? null;
    },

    getItemsByIds: async (userId, itemIds) => {
      if (itemIds.length === 0) return [];
      return selectItems(
        `item.id = ANY($2) AND ${mediaAvailableSql()} AND ${LIBRARY_VISIBILITY_PREDICATE}`,
        [userId, itemIds],
        "item.sort_title",
      );
    },

    canUserAccessItem: async (userId, itemId) => {
      const rows = await query<{ allowed: boolean }>(
        `SELECT true AS allowed
         FROM items item
         WHERE item.id = $2 AND ${LIBRARY_VISIBILITY_PREDICATE}
         LIMIT 1`,
        [userId, itemId],
      );
      return rows.length > 0;
    },

    listEnrichableTitles: async () => {
      const rows = await query<{
        id: string;
        kind: "movie" | "series";
        title: string;
      }>(
        `SELECT id, kind, title FROM items
         WHERE kind IN ('movie', 'series')
           AND missing_since IS NULL
           AND provider_ids ? 'tmdb'
         ORDER BY kind, sort_title`,
        [],
      );
      return rows.map((row) => ({
        itemId: row.id,
        kind: row.kind,
        title: row.title,
      }));
    },

    listItems: async ({
      userId,
      libraryId,
      kinds,
      parentId,
      seriesId,
      genre,
      sort = "title",
      order = "asc",
      limit,
      cursor,
      includeMissing = false,
    }) => {
      const values: unknown[] = [userId];
      const conditions = [LIBRARY_VISIBILITY_PREDICATE];

      if (!includeMissing) conditions.push(mediaAvailableSql());
      if (libraryId) {
        values.push(libraryId);
        conditions.push(`item.library_id = $${values.length}`);
      }
      if (kinds && kinds.length > 0) {
        values.push(kinds);
        conditions.push(`item.kind = ANY($${values.length})`);
      }
      if (parentId) {
        values.push(parentId);
        // A collection's films are its members, not rows parented to it.
        conditions.push(
          `(item.parent_id = $${values.length} OR item.id IN (
             SELECT member.item_id FROM collection_members member
             WHERE member.collection_id = $${values.length}))`,
        );
      }
      if (seriesId) {
        values.push(seriesId);
        conditions.push(`item.series_id = $${values.length}`);
      }
      if (genre) {
        values.push(genre.toLowerCase());
        conditions.push(
          `EXISTS (
             SELECT 1 FROM item_genres ig
             JOIN genres g ON g.id = ig.genre_id
             WHERE ig.item_id = item.id AND g.normalized_name = $${values.length}
           )`,
        );
      }

      const sortColumn = SORT_COLUMNS[sort];
      const direction = order === "desc" ? "DESC" : "ASC";
      const comparison = order === "desc" ? "<" : ">";

      if (cursor) {
        // Keyset pagination: strictly after the last row in the sort order, with
        // the id as a tiebreaker so equal keys cannot repeat or be skipped.
        values.push(cursor.key, cursor.id);
        conditions.push(
          `(${sortColumn.expression}, item.id) ${comparison} ($${values.length - 1}, $${values.length})`,
        );
      }

      return selectItems(
        conditions.join(" AND "),
        values,
        `${sortColumn.expression} ${direction} NULLS LAST, item.id ${direction}`,
        limit,
      );
    },

    listChildren: async (userId, parentId, kind) =>
      selectItems(
        `item.parent_id = $2 AND item.kind = $3 AND ${mediaAvailableSql()} AND ${LIBRARY_VISIBILITY_PREDICATE}`,
        [userId, parentId, kind],
        "COALESCE(item.index_number, 0), item.sort_title",
      ),

    listSeriesEpisodes: async (userId, seriesId) =>
      selectItems(
        `item.series_id = $2 AND item.kind = 'episode' AND ${mediaAvailableSql()} AND ${LIBRARY_VISIBILITY_PREDICATE}`,
        [userId, seriesId],
        "COALESCE(item.parent_index_number, 0), COALESCE(item.index_number, 0)",
      ),

    searchItems: async (userId, searchQuery, limit) => {
      const pattern = `%${searchQuery.toLowerCase().replace(/[%_\\]/g, "\\$&")}%`;
      return selectItems(
        `item.kind IN ('movie', 'series', 'episode', 'book')
         AND ${mediaAvailableSql()}
         AND (lower(item.title) LIKE $2 ESCAPE '\\' OR lower(COALESCE(item.original_title, '')) LIKE $2 ESCAPE '\\')
         AND ${LIBRARY_VISIBILITY_PREDICATE}`,
        [userId, pattern],
        // Prefix matches first, then alphabetical.
        `CASE WHEN lower(item.title) LIKE $2 ESCAPE '\\' THEN 0 ELSE 1 END, item.sort_title`,
        limit,
      );
    },

    listSearchCandidates: async (userId, limit) => {
      const rows = await query<{
        id: string;
        kind: string;
        title: string;
        original_title: string | null;
        series_title: string | null;
      }>(
        `SELECT item.id, item.kind, item.title, item.original_title,
                series.title AS series_title
         FROM items item
         LEFT JOIN items series ON series.id = item.series_id
         WHERE item.kind IN ('movie', 'series', 'episode', 'book')
           AND ${mediaAvailableSql()}
           AND ${LIBRARY_VISIBILITY_PREDICATE}
         ORDER BY item.sort_title
         LIMIT ${Math.trunc(limit)}`,
        [userId],
      );

      return rows.map((row) => ({
        id: row.id,
        kind: row.kind,
        title: row.title,
        originalTitle: row.original_title,
        seriesTitle: row.series_title,
      }));
    },

    listFilesForItem: async (itemId) => {
      const rows = await query<Record<string, never>>(
        `SELECT id, item_id, relative_path, container, size_bytes, mtime_ms,
                fingerprint, duration_ms, bitrate_bps, is_primary, probe_state, missing_since
         FROM media_files
         WHERE item_id = $1
         ORDER BY is_primary DESC, size_bytes DESC`,
        [itemId],
      );
      return rows.map(toMediaFileRow);
    },

    getItemKind: async (itemId) => {
      const rows = await query<{ kind: ItemKind }>(
        `SELECT kind FROM items WHERE id = $1`,
        [itemId],
      );
      return rows[0]?.kind ?? null;
    },

    getPrimaryFile: async (itemId) => {
      const rows = await query<Record<string, never>>(
        `SELECT id, item_id, relative_path, container, size_bytes, mtime_ms,
                fingerprint, duration_ms, bitrate_bps, is_primary, probe_state, missing_since
         FROM media_files
         WHERE item_id = $1 AND missing_since IS NULL
         ORDER BY is_primary DESC, size_bytes DESC
         LIMIT 1`,
        [itemId],
      );
      const row = rows[0];
      return row ? toMediaFileRow(row) : null;
    },

    getFileById: async (fileId) => {
      const rows = await query<Record<string, never>>(
        `SELECT id, item_id, relative_path, container, size_bytes, mtime_ms,
                fingerprint, duration_ms, bitrate_bps, is_primary, probe_state, missing_since
         FROM media_files WHERE id = $1`,
        [fileId],
      );
      const row = rows[0];
      return row ? toMediaFileRow(row) : null;
    },

    listStreams: async (mediaFileId) => {
      const rows = await query<Record<string, never>>(
        `SELECT stream_index, kind, codec, profile, level, language, title,
                is_default, is_forced, is_external, is_text_subtitle, external_relative_path,
                channels, sample_rate, bitrate_bps, width, height, pixel_format,
                frame_rate, video_range, color_transfer, color_primaries, color_space, bit_depth
         FROM media_streams WHERE media_file_id = $1 ORDER BY stream_index`,
        [mediaFileId],
      );
      return rows.map(toMediaStreamRow);
    },

    listStreamsForFiles: async (mediaFileIds) => {
      const byFile = new Map<string, MediaStreamRow[]>();
      if (mediaFileIds.length === 0) return byFile;
      const rows = await query<Record<string, never>>(
        `SELECT media_file_id, stream_index, kind, codec, profile, level, language, title,
                is_default, is_forced, is_external, is_text_subtitle, external_relative_path,
                channels, sample_rate, bitrate_bps, width, height, pixel_format,
                frame_rate, video_range, color_transfer, color_primaries, color_space, bit_depth
         FROM media_streams
         WHERE media_file_id = ANY($1::uuid[])
         ORDER BY media_file_id, stream_index`,
        [[...mediaFileIds]],
      );
      for (const row of rows) {
        const fileId = (row as Record<string, unknown>).media_file_id as string;
        const existing = byFile.get(fileId);
        if (existing) existing.push(toMediaStreamRow(row));
        else byFile.set(fileId, [toMediaStreamRow(row)]);
      }
      return byFile;
    },

    listChapters: async (itemId) => {
      const rows = await query<{
        chapter_index: number;
        start_ms: string;
        name: string | null;
      }>(
        `SELECT chapter_index, start_ms, name FROM item_chapters
         WHERE item_id = $1 ORDER BY chapter_index`,
        [itemId],
      );
      return rows.map((row) => ({
        index: row.chapter_index,
        startMs: row.start_ms,
        name: row.name,
      }));
    },

    listSegments: async (itemId) => {
      const rows = await query<{
        id: string;
        segment_type: string;
        start_ms: string;
        end_ms: string;
      }>(
        `SELECT id, segment_type, start_ms, end_ms FROM item_segments
         WHERE item_id = $1 ORDER BY start_ms`,
        [itemId],
      );
      return rows.map((row) => ({
        id: row.id,
        type: row.segment_type,
        startMs: row.start_ms,
        endMs: row.end_ms,
      }));
    },

    listPeople: async (itemId) => {
      const rows = await query<{
        person_id: string;
        name: string;
        role: ItemPersonRow["role"];
        character_name: string | null;
        provider_ids: Record<string, string> | null;
      }>(
        `SELECT ip.person_id, p.name, ip.role, ip.character_name, p.provider_ids
         FROM item_people ip
         JOIN people p ON p.id = ip.person_id
         WHERE ip.item_id = $1
         ORDER BY ip.sort_order, p.name`,
        [itemId],
      );
      return rows.map((row) => ({
        personId: row.person_id,
        name: row.name,
        role: row.role,
        characterName: row.character_name,
        tmdbProfilePath: row.provider_ids?.tmdbProfilePath ?? null,
      }));
    },

    listGenres: async (userId, libraryId) => {
      const values: unknown[] = [userId];
      let libraryFilter = "";
      if (libraryId) {
        values.push(libraryId);
        libraryFilter = `AND item.library_id = $${values.length}`;
      }

      const rows = await query<{ name: string; item_count: string }>(
        `SELECT genre.name, count(*) AS item_count
         FROM item_genres item_genre
         JOIN genres genre ON genre.id = item_genre.genre_id
         JOIN items item ON item.id = item_genre.item_id
         WHERE ${mediaAvailableSql()}
           AND item.kind IN ('movie', 'series', 'book')
           ${libraryFilter}
           AND ${LIBRARY_VISIBILITY_PREDICATE}
         GROUP BY genre.name
         ORDER BY genre.name`,
        values,
      );
      return rows.map((row) => ({
        name: row.name,
        itemCount: Number(row.item_count),
      }));
    },

    listProcessableTitles: async (options = {}) => {
      const kinds = options.kinds ?? ["movie", "episode"];
      const values: unknown[] = [kinds];
      const conditions = ["item.kind = ANY($1::text[])"];
      if (options.libraryId) {
        values.push(options.libraryId);
        conditions.push(`item.library_id = $${values.length}`);
      }
      if (options.seriesId) {
        values.push(options.seriesId);
        conditions.push(`item.series_id = $${values.length}`);
      }
      if (options.seasonId) {
        values.push(options.seasonId);
        conditions.push(`item.parent_id = $${values.length}`);
      }

      /*
       * One statement, three lateral lookups.
       *
       * `canonical` is the same choice `getPrimaryFile` makes — the primary
       * row, largest first — widened only by preferring a file that is still
       * on disk, so a title whose alternate cut vanished still describes
       * itself from the copy that has not. It is what stops the `.mkv` and the
       * `.mp4` of one episode reaching the page as two episodes.
       *
       * `video` and the two counts read `media_streams`, which the probe
       * service already wrote. Nothing here opens a media file.
       */
      const rows = await query<Record<string, unknown>>(
        `SELECT
           item.id AS item_id,
           item.library_id,
           item.kind,
           item.title,
           item.sort_title,
           item.production_year,
           item.runtime_ms,
           item.index_number,
           item.missing_since AS item_missing_since,
           item.series_id,
           series.title AS series_title,
           series.sort_title AS series_sort_title,
           series.production_year AS series_year,
           season.id AS season_id,
           season.title AS season_title,
           COALESCE(season.index_number, item.parent_index_number) AS season_number,
           canonical.id AS media_file_id,
           canonical.relative_path,
           canonical.container,
           canonical.size_bytes,
           canonical.mtime_ms,
           canonical.fingerprint,
           canonical.duration_ms,
           canonical.bitrate_bps,
           canonical.probe_state,
           canonical.missing_since AS file_missing_since,
           COALESCE(counted.file_count, 0) AS file_count,
           video.codec AS video_codec,
           video.profile AS video_profile,
           video.width,
           video.height,
           video.frame_rate,
           video.pixel_format,
           video.bit_depth,
           video.video_range,
           video.color_transfer,
           video.color_primaries,
           video.color_space,
           COALESCE(tracks.audio_count, 0) AS audio_track_count,
           COALESCE(tracks.subtitle_count, 0) AS subtitle_track_count,
           COALESCE(tracks.external_subtitle_count, 0) AS external_subtitle_count
         FROM items item
         LEFT JOIN items series ON series.id = item.series_id AND series.kind = 'series'
         LEFT JOIN items season ON season.id = item.parent_id AND season.kind = 'season'
         LEFT JOIN LATERAL (
           SELECT file.*
           FROM media_files file
           WHERE file.item_id = item.id
           ORDER BY (file.missing_since IS NULL) DESC,
                    file.is_primary DESC,
                    file.size_bytes DESC,
                    file.id
           LIMIT 1
         ) canonical ON true
         LEFT JOIN LATERAL (
           SELECT count(*)::int AS file_count
           FROM media_files file
           WHERE file.item_id = item.id
         ) counted ON true
         LEFT JOIN LATERAL (
           SELECT stream.*
           FROM media_streams stream
           WHERE stream.media_file_id = canonical.id AND stream.kind = 'video'
           ORDER BY stream.stream_index
           LIMIT 1
         ) video ON true
         LEFT JOIN LATERAL (
           SELECT
             count(*) FILTER (WHERE stream.kind = 'audio')::int AS audio_count,
             count(*) FILTER (WHERE stream.kind = 'subtitle'
                              AND stream.is_external = false)::int AS subtitle_count,
             count(*) FILTER (WHERE stream.kind = 'subtitle'
                              AND stream.is_external = true)::int AS external_subtitle_count
           FROM media_streams stream
           WHERE stream.media_file_id = canonical.id
         ) tracks ON true
         WHERE ${conditions.join(" AND ")}
         ORDER BY
           COALESCE(series.sort_title, item.sort_title),
           item.series_id NULLS FIRST,
           COALESCE(season.index_number, item.parent_index_number, 0),
           COALESCE(item.index_number, 0),
           item.sort_title,
           item.id`,
        values,
      );

      return rows.map(toProcessableTitleRow);
    },

    listBookFiles: async () => {
      const rows = await query<Record<string, never>>(
        `SELECT DISTINCT ON (file.item_id)
                file.id, file.item_id, file.relative_path, file.container,
                file.size_bytes, file.mtime_ms, file.fingerprint, file.duration_ms,
                file.bitrate_bps, file.is_primary, file.probe_state, file.missing_since
         FROM media_files file
         JOIN items item ON item.id = file.item_id
         WHERE item.kind = 'book' AND file.missing_since IS NULL
         ORDER BY file.item_id, file.is_primary DESC, file.size_bytes DESC`,
        [],
      );
      return rows.map(toMediaFileRow);
    },

    listPendingProbeFiles: async (limit) => {
      const rows = await query<Record<string, never>>(
        `SELECT id, item_id, relative_path, container, size_bytes, mtime_ms,
                fingerprint, duration_ms, bitrate_bps, is_primary, probe_state, missing_since
         FROM media_files
         WHERE probe_state = 'pending' AND missing_since IS NULL
         ORDER BY is_primary DESC, created_at
         LIMIT $1`,
        [limit],
      );
      return rows.map(toMediaFileRow);
    },
  };
}

function toProcessableTitleRow(
  row: Record<string, unknown>,
): ProcessableTitleRow {
  const numberOrNull = (value: unknown): number | null =>
    value === null || value === undefined ? null : Number(value);
  const textOrNull = (value: unknown): string | null =>
    value === null || value === undefined ? null : String(value);

  return {
    itemId: row.item_id as string,
    libraryId: row.library_id as string,
    kind: row.kind as "movie" | "episode",
    title: row.title as string,
    sortTitle: row.sort_title as string,
    productionYear: numberOrNull(row.production_year),
    runtimeMs: textOrNull(row.runtime_ms),
    indexNumber: numberOrNull(row.index_number),
    itemMissingSince: (row.item_missing_since as Date | null) ?? null,
    seriesId: textOrNull(row.series_id),
    seriesTitle: textOrNull(row.series_title),
    seriesSortTitle: textOrNull(row.series_sort_title),
    seriesYear: numberOrNull(row.series_year),
    seasonId: textOrNull(row.season_id),
    seasonTitle: textOrNull(row.season_title),
    seasonNumber: numberOrNull(row.season_number),
    mediaFileId: textOrNull(row.media_file_id),
    relativePath: textOrNull(row.relative_path),
    container: textOrNull(row.container),
    sizeBytes: textOrNull(row.size_bytes),
    mtimeMs: textOrNull(row.mtime_ms),
    fingerprint: textOrNull(row.fingerprint),
    durationMs: textOrNull(row.duration_ms),
    bitrateBps: textOrNull(row.bitrate_bps),
    probeState: textOrNull(row.probe_state),
    fileMissingSince: (row.file_missing_since as Date | null) ?? null,
    fileCount: Number(row.file_count ?? 0),
    videoCodec: textOrNull(row.video_codec),
    videoProfile: textOrNull(row.video_profile),
    width: numberOrNull(row.width),
    height: numberOrNull(row.height),
    frameRate: numberOrNull(row.frame_rate),
    pixelFormat: textOrNull(row.pixel_format),
    bitDepth: numberOrNull(row.bit_depth),
    videoRange: textOrNull(row.video_range),
    colorTransfer: textOrNull(row.color_transfer),
    colorPrimaries: textOrNull(row.color_primaries),
    colorSpace: textOrNull(row.color_space),
    audioTrackCount: Number(row.audio_track_count ?? 0),
    subtitleTrackCount: Number(row.subtitle_track_count ?? 0),
    externalSubtitleCount: Number(row.external_subtitle_count ?? 0),
  };
}

function toMediaFileRow(row: Record<string, unknown>): MediaFileRow {
  return {
    id: row.id as string,
    itemId: row.item_id as string,
    relativePath: row.relative_path as string,
    container: (row.container as string | null) ?? null,
    sizeBytes: String(row.size_bytes),
    mtimeMs: String(row.mtime_ms),
    fingerprint: row.fingerprint as string,
    durationMs: row.duration_ms === null ? null : String(row.duration_ms),
    bitrateBps: row.bitrate_bps === null ? null : String(row.bitrate_bps),
    isPrimary: row.is_primary as boolean,
    probeState: row.probe_state as MediaFileRow["probeState"],
    missingSince: (row.missing_since as Date | null) ?? null,
  };
}

function toMediaStreamRow(row: Record<string, unknown>): MediaStreamRow {
  return {
    streamIndex: row.stream_index as number,
    kind: row.kind as MediaStreamRow["kind"],
    codec: (row.codec as string | null) ?? null,
    profile: (row.profile as string | null) ?? null,
    level: (row.level as number | null) ?? null,
    language: (row.language as string | null) ?? null,
    title: (row.title as string | null) ?? null,
    isDefault: row.is_default as boolean,
    isForced: row.is_forced as boolean,
    isExternal: row.is_external as boolean,
    isTextSubtitle: row.is_text_subtitle as boolean,
    externalRelativePath: (row.external_relative_path as string | null) ?? null,
    channels: (row.channels as number | null) ?? null,
    sampleRate: (row.sample_rate as number | null) ?? null,
    bitrateBps: row.bitrate_bps === null ? null : String(row.bitrate_bps),
    width: (row.width as number | null) ?? null,
    height: (row.height as number | null) ?? null,
    pixelFormat: (row.pixel_format as string | null) ?? null,
    frameRate: (row.frame_rate as number | null) ?? null,
    videoRange: (row.video_range as string | null) ?? null,
    colorTransfer: (row.color_transfer as string | null) ?? null,
    colorPrimaries: (row.color_primaries as string | null) ?? null,
    colorSpace: (row.color_space as string | null) ?? null,
    bitDepth: (row.bit_depth as number | null) ?? null,
  };
}
