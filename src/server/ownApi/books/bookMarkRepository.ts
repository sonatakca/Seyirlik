import type { DatabasePool } from "../database/databasePool";
import { withTransaction } from "../database/transaction";

export type BookMarkColor = "yellow" | "green" | "blue" | "pink" | "purple";

export const BOOK_MARK_COLORS: readonly BookMarkColor[] = [
  "yellow",
  "green",
  "blue",
  "pink",
  "purple",
];

/** A bookmark, or a highlight when it has a colour; see user_book_marks. */
export interface BookMark {
  id: string;
  cfi: string;
  label: string;
  excerpt: string;
  progress: number | null;
  color: BookMarkColor | null;
  createdAt: Date;
  changedAt: Date;
}

/** A mark as one device last left it: its content, or null once removed. */
export interface BookMarkChange {
  id: string;
  changedAt: Date;
  mark: Omit<BookMark, "id" | "changedAt"> | null;
}

export interface BookMarkRepository {
  list(userId: string, itemId: string): Promise<BookMark[]>;
  /**
   * Applies each change unless a later change to the same mark is already
   * stored, then returns the marks now on record.
   */
  apply(
    userId: string,
    itemId: string,
    changes: readonly BookMarkChange[],
  ): Promise<BookMark[]>;
}

interface RawMarkRow {
  mark_id: string;
  cfi: string;
  label: string;
  excerpt: string;
  progress: number | null;
  color: BookMarkColor | null;
  created_at: Date;
  changed_at: Date;
}

const LIST_SQL = `SELECT mark_id, cfi, label, excerpt, progress, color, created_at, changed_at
  FROM user_book_marks
  WHERE user_id = $1 AND item_id = $2 AND NOT removed
  ORDER BY progress ASC NULLS LAST, created_at ASC, mark_id ASC`;

function toMark(row: RawMarkRow): BookMark {
  return {
    id: row.mark_id,
    cfi: row.cfi,
    label: row.label,
    excerpt: row.excerpt,
    progress: row.progress === null ? null : Number(row.progress),
    color: row.color,
    createdAt: row.created_at,
    changedAt: row.changed_at,
  };
}

export function createBookMarkRepository(
  pool: DatabasePool,
): BookMarkRepository {
  return {
    list: async (userId, itemId) =>
      (await pool.query<RawMarkRow>(LIST_SQL, [userId, itemId])).rows.map(
        toMark,
      ),

    apply: (userId, itemId, changes) =>
      // One transaction, so a list read back never shows half a batch.
      withTransaction(pool, async (client) => {
        for (const { id, changedAt, mark } of changes) {
          // changed_at is capped at the server's clock, as a reading
          // position's read_at is: a device whose clock runs ahead would
          // otherwise hold a mark against every later change. A tie goes to
          // the incoming change, so sending the same change twice is harmless.
          await client.query(
            `INSERT INTO user_book_marks (
               user_id, item_id, mark_id, cfi, label, excerpt, progress, color,
               created_at, removed, changed_at, updated_at
             )
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
               LEAST($11::timestamptz, now()), now())
             ON CONFLICT (user_id, item_id, mark_id) DO UPDATE SET
               cfi = EXCLUDED.cfi,
               label = EXCLUDED.label,
               excerpt = EXCLUDED.excerpt,
               progress = EXCLUDED.progress,
               color = EXCLUDED.color,
               created_at = EXCLUDED.created_at,
               removed = EXCLUDED.removed,
               changed_at = EXCLUDED.changed_at,
               updated_at = now()
             WHERE EXCLUDED.changed_at >= user_book_marks.changed_at`,
            [
              userId,
              itemId,
              id,
              mark?.cfi ?? null,
              mark?.label ?? null,
              mark?.excerpt ?? null,
              mark?.progress ?? null,
              mark?.color ?? null,
              mark?.createdAt ?? null,
              mark === null,
              changedAt,
            ],
          );
        }

        return (
          await client.query<RawMarkRow>(LIST_SQL, [userId, itemId])
        ).rows.map(toMark);
      }),
  };
}
