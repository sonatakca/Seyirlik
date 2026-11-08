import type { DatabasePool } from "../database/databasePool";

/** The kinds of title a link can be shared to. */
export const SHAREABLE_KINDS = [
  "movie",
  "series",
  "season",
  "episode",
  "book",
] as const;
export type ShareableKind = (typeof SHAREABLE_KINDS)[number];

export interface ShareImageRow {
  contentHash: string;
  contentType: string;
  storageKey: string;
}

export interface ShareItemRow {
  id: string;
  kind: ShareableKind;
  title: string;
  overview: string | null;
  productionYear: number | null;
  indexNumber: number | null;
  parentIndexNumber: number | null;
  seriesTitle: string | null;
  seriesOverview: string | null;
  seriesYear: number | null;
  /**
   * The card the link shows. A season or an episode has none of its own on
   * the site — it is drawn with its series' — so these come from the series.
   */
  cardItemId: string;
  cover: ShareImageRow | null;
  logo: ShareImageRow | null;
  logoLayout: { x: number; y: number; width: number; shadow: number } | null;
}

export interface ShareRepository {
  getItem(itemId: string): Promise<ShareItemRow | null>;
}

interface RawRow extends Record<string, unknown> {
  id: string;
  kind: ShareableKind;
  title: string;
  overview: string | null;
  production_year: number | null;
  index_number: number | null;
  parent_index_number: number | null;
  series_title: string | null;
  series_overview: string | null;
  series_year: number | null;
  card_item_id: string;
  cover: ShareImageRow | null;
  logo: ShareImageRow | null;
  logo_offset_x: number | null;
  logo_offset_y: number | null;
  logo_width: number | null;
  logo_shadow: number | null;
}

function imageColumn(alias: string, type: "cover" | "logo"): string {
  return `(
    SELECT json_build_object(
      'contentHash', image.content_hash,
      'contentType', image.content_type,
      'storageKey', image.storage_key
    )
    FROM item_images image
    WHERE image.item_id = ${alias}.id
      AND image.image_type = '${type}'
      AND image.image_index = 0
  )`;
}

/**
 * The language a shared link speaks: `shareText` writes "1. Sezon, 2. Bölüm",
 * and the preview page is `lang="tr"`.
 */
export const SHARE_LANGUAGE = "tr";

/**
 * An episode's name or overview in the share language, unless an
 * administrator wrote the field themselves; null otherwise, so the stored one
 * stands. Films and series are shared under their one shown title.
 */
function shareLanguageColumn(
  field: "title" | "overview",
  column: "localized_titles" | "localized_overviews",
): string {
  return `CASE WHEN item.kind = 'episode' AND NOT ('${field}' = ANY(item.locked_fields))
             THEN NULLIF(btrim(item.${column} ->> '${SHARE_LANGUAGE}'), '') END`;
}

/**
 * What a shared link may say about a title, read without a viewer.
 *
 * This is the only catalogue read that answers an anonymous caller, so it
 * selects exactly what a link preview shows — names, overview, year, the
 * card's artwork and layout — and nothing about files, libraries or people.
 * Holding the title's id is the whole of the authorization: ids are random
 * UUIDs, and a link only exists because someone who could see the title
 * shared it.
 */
export function createShareRepository(pool: DatabasePool): ShareRepository {
  return {
    getItem: async (itemId) => {
      const result = await pool.query<RawRow>(
        `SELECT
           item.id,
           item.kind,
           COALESCE(${shareLanguageColumn("title", "localized_titles")}, item.title) AS title,
           COALESCE(${shareLanguageColumn("overview", "localized_overviews")}, item.overview) AS overview,
           item.production_year,
           item.index_number,
           item.parent_index_number,
           series.title AS series_title,
           series.overview AS series_overview,
           series.production_year AS series_year,
           card.id AS card_item_id,
           ${imageColumn("card", "cover")} AS cover,
           ${imageColumn("card", "logo")} AS logo,
           card.logo_offset_x,
           card.logo_offset_y,
           card.logo_width,
           card.logo_shadow
         FROM items item
         LEFT JOIN items series ON series.id = item.series_id
         JOIN items card ON card.id = CASE
           WHEN item.kind IN ('season', 'episode') AND item.series_id IS NOT NULL
             THEN item.series_id
           ELSE item.id
         END
         WHERE item.id = $1
           AND item.kind = ANY($2)`,
        [itemId, SHAREABLE_KINDS],
      );
      const row = result.rows[0];
      if (!row) return null;
      // The same rule the catalogue's DTO applies: all four, or the card is
      // drawn unadjusted.
      const hasLayout =
        row.logo_offset_x !== null &&
        row.logo_offset_y !== null &&
        row.logo_width !== null &&
        row.logo_shadow !== null;
      return {
        id: row.id,
        kind: row.kind,
        title: row.title,
        overview: row.overview,
        productionYear: row.production_year,
        indexNumber: row.index_number,
        parentIndexNumber: row.parent_index_number,
        seriesTitle: row.series_title,
        seriesOverview: row.series_overview,
        seriesYear: row.series_year,
        cardItemId: row.card_item_id,
        cover: row.cover,
        logo: row.logo,
        logoLayout: hasLayout
          ? {
              x: row.logo_offset_x!,
              y: row.logo_offset_y!,
              width: row.logo_width!,
              shadow: row.logo_shadow!,
            }
          : null,
      };
    },
  };
}
