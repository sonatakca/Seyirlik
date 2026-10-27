import type { DatabasePool } from "../database/databasePool";

/**
 * The language a title was made in, for the audio policy.
 *
 * Metadata records it on films and series; an episode answers with its
 * series'. Undefined when nothing is recorded yet, which leaves the policy
 * keeping the source default exactly as it did before the language was known.
 */
export type OriginalLanguageLookup = (
  itemId: string,
) => Promise<string | undefined>;

export function createOriginalLanguageLookup(
  pool: DatabasePool,
): OriginalLanguageLookup {
  return async (itemId) => {
    const result = await pool.query<{ original_language: string | null }>(
      `SELECT COALESCE(item.original_language, series.original_language)
              AS original_language
         FROM items item
         LEFT JOIN items series ON series.id = item.series_id
        WHERE item.id = $1`,
      [itemId],
    );
    return result.rows[0]?.original_language ?? undefined;
  };
}
