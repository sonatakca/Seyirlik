import type { PoolClient } from "pg";
import type { DatabasePool } from "../../database/databasePool";
import { withTransaction } from "../../database/transaction";

export type NarrationState = "queued" | "narrating" | "ready" | "failed";

/** The narrator's latest report on a narration; see book_narrations.progress. */
export interface NarrationProgress {
  /** How much of the book is read, 0 to 1. */
  fraction: number;
  sectionsDone: number;
  sectionsTotal: number;
  /** About how long the rest will take, when the narrator can say. */
  etaSeconds: number | null;
  /** What it is doing now, in a word: "loading", "reading", "uploading". */
  activity: string | null;
}

export interface BookNarration {
  itemId: string;
  state: NarrationState;
  requestedAt: Date;
  voice: string | null;
  scriptVersion: number | null;
  narratorKeyId: string | null;
  heartbeatAt: Date | null;
  bookFileId: string | null;
  bookFingerprint: string | null;
  progress: NarrationProgress | null;
  error: string | null;
  finishedAt: Date | null;
}

export interface NarrationSection {
  section: number;
  audioSha256: string;
  audioBytes: number;
  durationSeconds: number;
  wordCount: number;
  uploadedAt: Date;
}

export interface NarratorKey {
  id: string;
  label: string;
  createdAt: Date;
  lastSeenAt: Date | null;
  revokedAt: Date | null;
}

/** The book's file as a narrator reads it: which file, and which edition of it. */
export interface NarratedBook {
  fileId: string;
  fingerprint: string;
}

export interface NarrationClaim {
  narration: BookNarration;
  /** The sections already uploaded, still good for this voice, script and book. */
  sections: NarrationSection[];
  /**
   * The sections uploaded before were read in another voice, from another
   * script or from another edition of the book, and are gone: their files
   * are the caller's to remove.
   */
  reset: boolean;
}

export interface NarrationRepository {
  get(
    itemId: string,
  ): Promise<{ narration: BookNarration; sections: NarrationSection[] } | null>;
  /**
   * Asks for a book to be narrated: a new narration, or one that failed
   * queued again (keeping what it uploaded). False when one is already
   * queued, under way or ready.
   */
  request(itemId: string, userId: string): Promise<boolean>;
  /** Takes a narration away with its sections; true if there was one. */
  remove(itemId: string): Promise<boolean>;
  /**
   * Gives the narrator holding `keyId` its next book: the one it was reading
   * (after a restart), one queued longest, or one whose narrator went silent
   * for `staleSeconds`. `bookOf` names the book's file; a book with none is
   * failed instead and the next one is tried.
   */
  claim(options: {
    keyId: string;
    voice: string;
    scriptVersion: number;
    staleSeconds: number;
    bookOf(itemId: string): Promise<NarratedBook | null>;
  }): Promise<NarrationClaim | null>;
  /** The narrator's report; false if it no longer holds the narration. */
  heartbeat(
    itemId: string,
    keyId: string,
    progress: NarrationProgress,
  ): Promise<boolean>;
  /**
   * Records an uploaded section, whose files are already in place. Null if
   * the narrator no longer holds the narration; otherwise the hash of the
   * audio it replaces, if any, whose files are the caller's to remove.
   */
  commitSection(
    itemId: string,
    keyId: string,
    section: Omit<NarrationSection, "uploadedAt">,
  ): Promise<{ replaced: string | null } | null>;
  /**
   * Ends a narration the narrator holds: ready, once every section in
   * `sections` is uploaded, or failed with what went wrong. Returns false
   * if it no longer holds it, or if sections are missing for ready.
   */
  finish(
    itemId: string,
    keyId: string,
    outcome:
      | { ready: true; sections: number[] }
      | { ready: false; error: string },
  ): Promise<boolean>;

  /** The active key with this SHA-256, or null. */
  findKey(hash: Buffer): Promise<NarratorKey | null>;
  /** A narrator asked for work: it is there to read. */
  touchKey(keyId: string): Promise<void>;
  createKey(id: string, label: string, hash: Buffer): Promise<NarratorKey>;
  listKeys(): Promise<NarratorKey[]>;
  revokeKey(id: string): Promise<boolean>;
  /** When any active narrator last asked for work, or null if none ever has. */
  lastSeen(): Promise<Date | null>;
}

interface RawNarrationRow {
  item_id: string;
  state: NarrationState;
  requested_at: Date;
  voice: string | null;
  script_version: number | null;
  narrator_key_id: string | null;
  heartbeat_at: Date | null;
  book_file_id: string | null;
  book_fingerprint: string | null;
  progress: NarrationProgress | null;
  error: string | null;
  finished_at: Date | null;
}

const NARRATION_COLUMNS = `item_id, state, requested_at, voice, script_version,
  narrator_key_id, heartbeat_at, book_file_id, book_fingerprint, progress,
  error, finished_at`;

function toNarration(row: RawNarrationRow): BookNarration {
  return {
    itemId: row.item_id,
    state: row.state,
    requestedAt: row.requested_at,
    voice: row.voice,
    scriptVersion: row.script_version,
    narratorKeyId: row.narrator_key_id,
    heartbeatAt: row.heartbeat_at,
    bookFileId: row.book_file_id,
    bookFingerprint: row.book_fingerprint,
    progress: row.progress,
    error: row.error,
    finishedAt: row.finished_at,
  };
}

interface RawSectionRow {
  section: number;
  audio_sha256: string;
  audio_bytes: string;
  duration_seconds: number;
  word_count: number;
  uploaded_at: Date;
}

function toSection(row: RawSectionRow): NarrationSection {
  return {
    section: row.section,
    audioSha256: row.audio_sha256,
    audioBytes: Number(row.audio_bytes),
    durationSeconds: Number(row.duration_seconds),
    wordCount: row.word_count,
    uploadedAt: row.uploaded_at,
  };
}

interface RawKeyRow {
  id: string;
  label: string;
  created_at: Date;
  last_seen_at: Date | null;
  revoked_at: Date | null;
}

const toKey = (row: RawKeyRow): NarratorKey => ({
  id: row.id,
  label: row.label,
  createdAt: row.created_at,
  lastSeenAt: row.last_seen_at,
  revokedAt: row.revoked_at,
});

async function sectionsOf(
  client: Pick<PoolClient, "query">,
  itemId: string,
): Promise<NarrationSection[]> {
  const result = await client.query<RawSectionRow>(
    `SELECT section, audio_sha256, audio_bytes, duration_seconds, word_count, uploaded_at
     FROM book_narration_sections WHERE item_id = $1 ORDER BY section`,
    [itemId],
  );
  return result.rows.map(toSection);
}

export function createNarrationRepository(
  pool: DatabasePool,
): NarrationRepository {
  return {
    get: async (itemId) => {
      const result = await pool.query<RawNarrationRow>(
        `SELECT ${NARRATION_COLUMNS} FROM book_narrations WHERE item_id = $1`,
        [itemId],
      );
      const row = result.rows[0];
      return row
        ? {
            narration: toNarration(row),
            sections: await sectionsOf(pool, itemId),
          }
        : null;
    },

    request: async (itemId, userId) => {
      const result = await pool.query(
        `INSERT INTO book_narrations (item_id, state, requested_by)
         VALUES ($1, 'queued', $2)
         ON CONFLICT (item_id) DO UPDATE SET
           state = 'queued',
           requested_by = EXCLUDED.requested_by,
           requested_at = now(),
           narrator_key_id = NULL,
           heartbeat_at = NULL,
           progress = NULL,
           error = NULL,
           finished_at = NULL,
           updated_at = now()
         WHERE book_narrations.state = 'failed'`,
        [itemId, userId],
      );
      return (result.rowCount ?? 0) > 0;
    },

    remove: async (itemId) => {
      const result = await pool.query(
        "DELETE FROM book_narrations WHERE item_id = $1",
        [itemId],
      );
      return (result.rowCount ?? 0) > 0;
    },

    claim: async ({ keyId, voice, scriptVersion, staleSeconds, bookOf }) => {
      // A book that turns out to have no file is failed and the next tried;
      // bounded, so a queue of such books cannot hold one request forever.
      for (let attempt = 0; attempt < 8; attempt++) {
        const claimed = await withTransaction(pool, async (client) => {
          // Its own book first, then the longest waiting. SKIP LOCKED: two
          // narrators asking at once never take the same book.
          const next = await client.query<RawNarrationRow>(
            `SELECT ${NARRATION_COLUMNS} FROM book_narrations
             WHERE state = 'queued'
                OR (state = 'narrating' AND (
                     narrator_key_id = $1
                     OR narrator_key_id IS NULL
                     OR heartbeat_at < now() - make_interval(secs => $2)))
             ORDER BY (state = 'narrating' AND narrator_key_id = $1) DESC, requested_at
             LIMIT 1
             FOR UPDATE SKIP LOCKED`,
            [keyId, staleSeconds],
          );
          const row = next.rows[0];
          if (!row) return { done: true as const, claim: null };

          const book = await bookOf(row.item_id);
          if (!book) {
            await client.query(
              `UPDATE book_narrations SET state = 'failed',
                 error = 'The book has no file to read.', finished_at = now(),
                 updated_at = now()
               WHERE item_id = $1`,
              [row.item_id],
            );
            return { done: false as const, claim: null };
          }

          // Sections read in another voice, from another script or from
          // another edition do not belong to this reading of the book.
          const reset =
            row.voice !== null &&
            (row.voice !== voice ||
              row.script_version !== scriptVersion ||
              row.book_fingerprint !== book.fingerprint);
          if (reset) {
            await client.query(
              "DELETE FROM book_narration_sections WHERE item_id = $1",
              [row.item_id],
            );
          }
          const updated = await client.query<RawNarrationRow>(
            `UPDATE book_narrations SET
               state = 'narrating', narrator_key_id = $2, heartbeat_at = now(),
               voice = $3, script_version = $4, book_file_id = $5,
               book_fingerprint = $6, error = NULL, finished_at = NULL,
               updated_at = now()
             WHERE item_id = $1
             RETURNING ${NARRATION_COLUMNS}`,
            [
              row.item_id,
              keyId,
              voice,
              scriptVersion,
              book.fileId,
              book.fingerprint,
            ],
          );
          return {
            done: true as const,
            claim: {
              narration: toNarration(updated.rows[0] as RawNarrationRow),
              sections: await sectionsOf(client, row.item_id),
              reset,
            },
          };
        });
        if (claimed.done) return claimed.claim;
      }
      return null;
    },

    heartbeat: async (itemId, keyId, progress) => {
      const result = await pool.query(
        `UPDATE book_narrations SET heartbeat_at = now(), progress = $3, updated_at = now()
         WHERE item_id = $1 AND state = 'narrating' AND narrator_key_id = $2`,
        [itemId, keyId, JSON.stringify(progress)],
      );
      return (result.rowCount ?? 0) > 0;
    },

    commitSection: (itemId, keyId, section) =>
      withTransaction(pool, async (client) => {
        // Held for the transaction: a narration taken away or handed to
        // another narrator meanwhile cannot have this one's section.
        const held = await client.query(
          `SELECT 1 FROM book_narrations
           WHERE item_id = $1 AND state = 'narrating' AND narrator_key_id = $2
           FOR UPDATE`,
          [itemId, keyId],
        );
        if (held.rowCount === 0) return null;
        const before = await client.query<{ audio_sha256: string }>(
          `SELECT audio_sha256 FROM book_narration_sections
           WHERE item_id = $1 AND section = $2`,
          [itemId, section.section],
        );
        await client.query(
          `INSERT INTO book_narration_sections
             (item_id, section, audio_sha256, audio_bytes, duration_seconds, word_count)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (item_id, section) DO UPDATE SET
             audio_sha256 = EXCLUDED.audio_sha256,
             audio_bytes = EXCLUDED.audio_bytes,
             duration_seconds = EXCLUDED.duration_seconds,
             word_count = EXCLUDED.word_count,
             uploaded_at = now()`,
          [
            itemId,
            section.section,
            section.audioSha256,
            section.audioBytes,
            section.durationSeconds,
            section.wordCount,
          ],
        );
        await client.query(
          `UPDATE book_narrations SET heartbeat_at = now(), updated_at = now()
           WHERE item_id = $1`,
          [itemId],
        );
        const replaced = before.rows[0]?.audio_sha256 ?? null;
        return { replaced: replaced === section.audioSha256 ? null : replaced };
      }),

    finish: (itemId, keyId, outcome) =>
      withTransaction(pool, async (client) => {
        const held = await client.query(
          `SELECT 1 FROM book_narrations
           WHERE item_id = $1 AND state = 'narrating' AND narrator_key_id = $2
           FOR UPDATE`,
          [itemId, keyId],
        );
        if (held.rowCount === 0) return false;
        if (outcome.ready) {
          const uploaded = new Set(
            (await sectionsOf(client, itemId)).map((row) => row.section),
          );
          if (outcome.sections.some((section) => !uploaded.has(section)))
            return false;
        }
        await client.query(
          `UPDATE book_narrations SET state = $2, error = $3, finished_at = now(),
             updated_at = now()
           WHERE item_id = $1`,
          [
            itemId,
            outcome.ready ? "ready" : "failed",
            outcome.ready ? null : outcome.error.slice(0, 2000),
          ],
        );
        return true;
      }),

    findKey: async (hash) => {
      const result = await pool.query<RawKeyRow>(
        `SELECT id, label, created_at, last_seen_at, revoked_at FROM narrator_keys
         WHERE key_hash = $1 AND revoked_at IS NULL`,
        [hash],
      );
      return result.rows[0] ? toKey(result.rows[0]) : null;
    },

    touchKey: async (keyId) => {
      await pool.query(
        "UPDATE narrator_keys SET last_seen_at = now() WHERE id = $1",
        [keyId],
      );
    },

    createKey: async (id, label, hash) => {
      const result = await pool.query<RawKeyRow>(
        `INSERT INTO narrator_keys (id, label, key_hash) VALUES ($1, $2, $3)
         RETURNING id, label, created_at, last_seen_at, revoked_at`,
        [id, label, hash],
      );
      return toKey(result.rows[0] as RawKeyRow);
    },

    listKeys: async () => {
      const result = await pool.query<RawKeyRow>(
        `SELECT id, label, created_at, last_seen_at, revoked_at FROM narrator_keys
         ORDER BY created_at`,
      );
      return result.rows.map(toKey);
    },

    revokeKey: async (id) => {
      const result = await pool.query(
        `UPDATE narrator_keys SET revoked_at = now()
         WHERE id = $1 AND revoked_at IS NULL`,
        [id],
      );
      return (result.rowCount ?? 0) > 0;
    },

    lastSeen: async () => {
      const result = await pool.query<{ seen: Date | null }>(
        "SELECT max(last_seen_at) AS seen FROM narrator_keys WHERE revoked_at IS NULL",
      );
      return result.rows[0]?.seen ?? null;
    },
  };
}
