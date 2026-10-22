import type { PoolClient } from "pg";
import type { DatabasePool } from "../database/databasePool";
import { withTransaction } from "../database/transaction";

/** Exactly where the screen stood; see user_book_positions. */
export interface BookPlace {
  section: number;
  block: number;
  offset: number;
}

export interface BookPosition {
  cfi: string | null;
  place: BookPlace | null;
  fraction: number;
  readAt: Date;
}

/** The kinds of device a reading session can say it is. */
export const READER_DEVICES = [
  "iphone",
  "ipad",
  "android",
  "mac",
  "windows",
  "linux",
] as const;

export type ReaderDevice = (typeof READER_DEVICES)[number];

/** One opening of a book in a page; see user_book_sessions. */
export interface ReadingSession {
  sessionId: string;
  openedAt: Date;
  device: ReaderDevice | null;
}

export interface BookPositionRepository {
  get(userId: string, itemId: string): Promise<BookPosition | null>;
  /**
   * Makes this session the one that keeps the place, unless a session opened
   * later already does. Returns the session that now keeps it.
   */
  claim(
    userId: string,
    itemId: string,
    session: ReadingSession,
  ): Promise<{ owner: boolean; session: ReadingSession }>;
  /**
   * Stores the position. With a session: only if that session keeps the
   * place (claiming it when it was opened last), and then over a place
   * another session wrote whatever its clock said; `superseded` is the
   * session that keeps it when this one does not. Without one (a page from
   * before sessions): unless a later place is already stored.
   */
  save(
    userId: string,
    itemId: string,
    position: BookPosition,
    session?: ReadingSession,
  ): Promise<{
    accepted: boolean;
    position: BookPosition | null;
    superseded: ReadingSession | null;
  }>;
}

interface RawSessionRow {
  session_id: string;
  opened_at: Date;
  device: ReaderDevice | null;
}

function toSession(row: RawSessionRow): ReadingSession {
  return {
    sessionId: row.session_id,
    openedAt: row.opened_at,
    device: row.device,
  };
}

/**
 * The claim itself. The session opened last keeps the place (opened_at, then
 * the id, so two opened in the same millisecond still agree on one); the
 * session that keeps it may say so again. opened_at is capped at the
 * server's clock, as read_at is. The upsert locks the row, so in a
 * transaction nothing else claims between this and what follows.
 */
async function claimIn(
  client: Pick<PoolClient, "query">,
  userId: string,
  itemId: string,
  { sessionId, openedAt, device }: ReadingSession,
): Promise<{ owner: boolean; session: ReadingSession }> {
  await client.query(
    `INSERT INTO user_book_sessions (user_id, item_id, session_id, opened_at, device)
     VALUES ($1, $2, $3, LEAST($4::timestamptz, now()), $5)
     ON CONFLICT (user_id, item_id) DO UPDATE SET
       session_id = EXCLUDED.session_id,
       opened_at = EXCLUDED.opened_at,
       device = EXCLUDED.device,
       updated_at = now()
     WHERE EXCLUDED.session_id = user_book_sessions.session_id
        OR (EXCLUDED.opened_at, EXCLUDED.session_id)
           > (user_book_sessions.opened_at, user_book_sessions.session_id)`,
    [userId, itemId, sessionId, openedAt, device],
  );
  const result = await client.query<RawSessionRow>(
    `SELECT session_id, opened_at, device FROM user_book_sessions
     WHERE user_id = $1 AND item_id = $2`,
    [userId, itemId],
  );
  const session = toSession(result.rows[0] as RawSessionRow);
  return { owner: session.sessionId === sessionId, session };
}

interface RawPositionRow {
  cfi: string | null;
  section: number | null;
  block: number | null;
  block_offset: number | null;
  fraction: number;
  read_at: Date;
}

const POSITION_COLUMNS = "cfi, section, block, block_offset, fraction, read_at";

function toPosition(row: RawPositionRow): BookPosition {
  return {
    cfi: row.cfi,
    place:
      row.section === null || row.block === null || row.block_offset === null
        ? null
        : { section: row.section, block: row.block, offset: row.block_offset },
    fraction: Number(row.fraction),
    readAt: row.read_at,
  };
}

export function createBookPositionRepository(
  pool: DatabasePool,
): BookPositionRepository {
  const get = async (userId: string, itemId: string) => {
    const result = await pool.query<RawPositionRow>(
      `SELECT ${POSITION_COLUMNS} FROM user_book_positions
       WHERE user_id = $1 AND item_id = $2`,
      [userId, itemId],
    );
    const row = result.rows[0];
    return row ? toPosition(row) : null;
  };

  return {
    get,

    claim: (userId, itemId, session) =>
      withTransaction(pool, (client) =>
        claimIn(client, userId, itemId, session),
      ),

    save: (userId, itemId, { cfi, place, fraction, readAt }, session) =>
      withTransaction(pool, async (client) => {
        if (session) {
          const claim = await claimIn(client, userId, itemId, session);
          if (!claim.owner) {
            const current = await client.query<RawPositionRow>(
              `SELECT ${POSITION_COLUMNS} FROM user_book_positions
               WHERE user_id = $1 AND item_id = $2`,
              [userId, itemId],
            );
            return {
              accepted: false,
              position: current.rows[0] ? toPosition(current.rows[0]) : null,
              superseded: claim.session,
            };
          }
        }

        // read_at is capped at the server's clock: a device whose clock runs
        // ahead would otherwise hold the book's place against every other
        // device until real time caught up. A tie goes to the newer write, so
        // saving the same moment twice is harmless. A session's own saves are
        // ordered by read_at, its own clock; the session that keeps the place
        // writes over another's whatever their clocks say.
        const result = await client.query<RawPositionRow>(
          `INSERT INTO user_book_positions (
             user_id, item_id, cfi, section, block, block_offset, fraction,
             read_at, session_id, updated_at
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7, LEAST($8::timestamptz, now()), $9, now())
           ON CONFLICT (user_id, item_id) DO UPDATE SET
             cfi = EXCLUDED.cfi,
             section = EXCLUDED.section,
             block = EXCLUDED.block,
             block_offset = EXCLUDED.block_offset,
             fraction = EXCLUDED.fraction,
             read_at = EXCLUDED.read_at,
             session_id = EXCLUDED.session_id,
             updated_at = now()
           WHERE EXCLUDED.read_at >= user_book_positions.read_at
              OR (
                EXCLUDED.session_id IS NOT NULL
                AND user_book_positions.session_id IS DISTINCT FROM EXCLUDED.session_id
              )
           RETURNING ${POSITION_COLUMNS}`,
          [
            userId,
            itemId,
            cfi,
            place?.section ?? null,
            place?.block ?? null,
            place?.offset ?? null,
            fraction,
            readAt,
            session?.sessionId ?? null,
          ],
        );
        if (result.rows[0]) {
          return {
            accepted: true,
            position: toPosition(result.rows[0]),
            superseded: null,
          };
        }
        const current = await client.query<RawPositionRow>(
          `SELECT ${POSITION_COLUMNS} FROM user_book_positions
           WHERE user_id = $1 AND item_id = $2`,
          [userId, itemId],
        );
        return {
          accepted: false,
          position: current.rows[0] ? toPosition(current.rows[0]) : null,
          superseded: null,
        };
      }),
  };
}
