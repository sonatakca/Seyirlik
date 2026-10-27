/**
 * Every version of a subtitle, and the only way this system rewrites one.
 *
 * A retimed subtitle is still somebody's translation, and a retiming can be
 * wrong. So nothing here writes a sidecar without first holding, in the
 * database, both the bytes it is about to replace and the bytes it is about to
 * write — and nothing reports a write as done until the file has been read back
 * as exactly those bytes. Any version can then be put back, which is itself a
 * new version rather than an erasure of the ones in between.
 *
 * A write is a small state machine with the database as its memory:
 *
 *   observe   the bytes the decision was made from are recorded — as the
 *             path's `original` the first time, as `external` if somebody
 *             changed the file since this system last wrote it
 *   begin     the new bytes are recorded `pending`, pointing at that parent
 *   write     the existing guarded rewrite: same lock, same digest check
 *   settle    `committed` once the file reads back as the new bytes,
 *             `abandoned` when it does not
 *
 * A crash anywhere in that leaves either no pending row or one whose fate the
 * file itself decides, and every operation on a path settles a pending row
 * left behind before it starts its own. A retry is therefore safe to run at
 * any time and never needs to know what the previous run got to.
 *
 * Only the always-on server runs this: the media volume is a Google Drive
 * mount on each machine, and two machines writing one file through two
 * mounts has already lost writes. A heavy worker may *propose* a retiming; it
 * reaches a sidecar only through a job this server runs.
 */

import { randomUUID } from "node:crypto";
import type { DatabasePool } from "../database/databasePool";
import { withTransaction } from "../database/transaction";
import { InvalidSubtitleError, validateSubtitle } from "./subtitlePayload";
import { subtitleDigest, type SubtitleStorage } from "./subtitleStorage";

export type RevisionOrigin =
  | "original"
  | "external"
  | "download"
  | "fit"
  | "sync"
  | "manual"
  | "restore";

export type RevisionState = "pending" | "committed" | "abandoned";

export interface SubtitleRevision {
  readonly id: string;
  readonly mediaFileId: string | null;
  readonly relativePath: string;
  readonly revision: number;
  readonly origin: RevisionOrigin;
  readonly state: RevisionState;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly parentId: string | null;
  readonly provenance: Record<string, unknown>;
  readonly failure: string | null;
  readonly createdAt: Date;
  readonly settledAt: Date | null;
}

export interface SubtitleRevisionWithContent extends SubtitleRevision {
  readonly content: Uint8Array;
}

export interface SubtitleRevisionStore {
  /** Every revision of one path, newest first, without the bytes. */
  list(mediaFileId: string, relativePath: string): Promise<SubtitleRevision[]>;
  get(id: string): Promise<SubtitleRevisionWithContent | null>;
  /** The newest committed revision, which is what the file should hold. */
  head(
    mediaFileId: string,
    relativePath: string,
  ): Promise<SubtitleRevision | null>;
  pending(
    mediaFileId: string,
    relativePath: string,
  ): Promise<SubtitleRevisionWithContent | null>;
  /** Paths with a revision still pending, for the reconcile sweep. */
  pendingPaths(): Promise<{ mediaFileId: string; relativePath: string }[]>;
  /**
   * Records bytes that are on disk now and returns the revision they are: the
   * head when they match it, a new `original` when the path has no history,
   * and a new `external` when somebody else has written there since.
   */
  observe(input: {
    mediaFileId: string;
    relativePath: string;
    bytes: Uint8Array;
    provenance?: Record<string, unknown>;
  }): Promise<SubtitleRevision>;
  /** Records bytes that settle at once — a download that was never on disk. */
  record(input: {
    mediaFileId: string;
    relativePath: string;
    origin: RevisionOrigin;
    bytes: Uint8Array;
    parentId?: string | null;
    provenance?: Record<string, unknown>;
  }): Promise<SubtitleRevision>;
  /** Fails with `RevisionBusyError` while another write of this path is pending. */
  begin(input: {
    mediaFileId: string;
    relativePath: string;
    origin: RevisionOrigin;
    bytes: Uint8Array;
    parentId: string;
    provenance?: Record<string, unknown>;
  }): Promise<SubtitleRevision>;
  settle(
    id: string,
    state: "committed" | "abandoned",
    failure?: string,
  ): Promise<void>;
}

export class RevisionBusyError extends Error {
  constructor() {
    super("Another change to this subtitle has not finished.");
    this.name = "RevisionBusyError";
  }
}

interface RevisionRecord {
  id: string;
  media_file_id: string | null;
  relative_path: string;
  revision: number;
  origin: RevisionOrigin;
  state: RevisionState;
  sha256: string;
  size_bytes: number;
  parent_id: string | null;
  provenance: Record<string, unknown>;
  failure: string | null;
  created_at: Date;
  settled_at: Date | null;
  content?: Buffer;
}

const COLUMNS = `id, media_file_id, relative_path, revision, origin, state,
  sha256, size_bytes, parent_id, provenance, failure, created_at, settled_at`;

function toRevision(row: RevisionRecord): SubtitleRevision {
  return {
    id: row.id,
    mediaFileId: row.media_file_id,
    relativePath: row.relative_path,
    revision: row.revision,
    origin: row.origin,
    state: row.state,
    sha256: row.sha256,
    sizeBytes: row.size_bytes,
    parentId: row.parent_id,
    provenance: row.provenance ?? {},
    failure: row.failure,
    createdAt: row.created_at,
    settledAt: row.settled_at,
  };
}

function withContent(row: RevisionRecord): SubtitleRevisionWithContent {
  return {
    ...toRevision(row),
    content: new Uint8Array(row.content ?? Buffer.alloc(0)),
  };
}

export function createSubtitleRevisionStore(
  pool: DatabasePool,
): SubtitleRevisionStore {
  /*
   * Numbering is "one more than the highest", which two writers could both
   * compute. The advisory lock serialises them per path for the length of the
   * transaction, and the unique index is there for anything that forgets to
   * take it.
   */
  async function insert(input: {
    mediaFileId: string;
    relativePath: string;
    origin: RevisionOrigin;
    state: RevisionState;
    bytes: Uint8Array;
    parentId: string | null;
    provenance: Record<string, unknown>;
    /**
     * Decided under the lock from the path's current head: reuse an existing
     * revision instead of inserting, or insert with this origin.
     */
    decide?: (
      head: SubtitleRevision | null,
    ) => { reuse: SubtitleRevision } | { origin: RevisionOrigin };
  }): Promise<SubtitleRevision> {
    try {
      return await withTransaction(pool, async (client) => {
        await client.query(
          `SELECT pg_advisory_xact_lock(hashtextextended($1 || '|' || $2, 7042))`,
          [input.mediaFileId, input.relativePath],
        );
        let origin = input.origin;
        if (input.decide) {
          const head = await client.query<RevisionRecord>(
            `SELECT ${COLUMNS} FROM subtitle_revisions
              WHERE media_file_id = $1 AND relative_path = $2 AND state = 'committed'
              ORDER BY revision DESC LIMIT 1`,
            [input.mediaFileId, input.relativePath],
          );
          const decision = input.decide(
            head.rows[0] ? toRevision(head.rows[0]) : null,
          );
          if ("reuse" in decision) return decision.reuse;
          origin = decision.origin;
        }
        const next = await client.query<{ next: number }>(
          `SELECT COALESCE(MAX(revision), 0) + 1 AS next FROM subtitle_revisions
            WHERE media_file_id = $1 AND relative_path = $2`,
          [input.mediaFileId, input.relativePath],
        );
        const bytes = Buffer.from(input.bytes);
        const inserted = await client.query<RevisionRecord>(
          `INSERT INTO subtitle_revisions
             (id, media_file_id, relative_path, revision, origin, state,
              sha256, size_bytes, content, parent_id, provenance, settled_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
                   CASE WHEN $6 = 'pending' THEN NULL ELSE now() END)
           RETURNING ${COLUMNS}`,
          [
            randomUUID(),
            input.mediaFileId,
            input.relativePath,
            next.rows[0]?.next ?? 1,
            origin,
            input.state,
            subtitleDigest(bytes),
            bytes.length,
            bytes,
            input.parentId,
            JSON.stringify(input.provenance),
          ],
        );
        return toRevision(inserted.rows[0] as RevisionRecord);
      });
    } catch (error) {
      if (
        (error as { code?: string }).code === "23505" &&
        input.state === "pending"
      )
        throw new RevisionBusyError();
      throw error;
    }
  }

  return {
    async list(mediaFileId, relativePath) {
      const result = await pool.query<RevisionRecord>(
        `SELECT ${COLUMNS} FROM subtitle_revisions
          WHERE media_file_id = $1 AND relative_path = $2
          ORDER BY revision DESC`,
        [mediaFileId, relativePath],
      );
      return result.rows.map(toRevision);
    },

    async get(id) {
      const result = await pool.query<RevisionRecord>(
        `SELECT ${COLUMNS}, content FROM subtitle_revisions WHERE id = $1`,
        [id],
      );
      return result.rows[0] ? withContent(result.rows[0]) : null;
    },

    async head(mediaFileId, relativePath) {
      const result = await pool.query<RevisionRecord>(
        `SELECT ${COLUMNS} FROM subtitle_revisions
          WHERE media_file_id = $1 AND relative_path = $2 AND state = 'committed'
          ORDER BY revision DESC LIMIT 1`,
        [mediaFileId, relativePath],
      );
      return result.rows[0] ? toRevision(result.rows[0]) : null;
    },

    async pending(mediaFileId, relativePath) {
      const result = await pool.query<RevisionRecord>(
        `SELECT ${COLUMNS}, content FROM subtitle_revisions
          WHERE media_file_id = $1 AND relative_path = $2 AND state = 'pending'`,
        [mediaFileId, relativePath],
      );
      return result.rows[0] ? withContent(result.rows[0]) : null;
    },

    async pendingPaths() {
      const result = await pool.query<{
        media_file_id: string;
        relative_path: string;
      }>(
        `SELECT media_file_id, relative_path FROM subtitle_revisions
          WHERE state = 'pending' AND media_file_id IS NOT NULL`,
      );
      return result.rows.map((row) => ({
        mediaFileId: row.media_file_id,
        relativePath: row.relative_path,
      }));
    },

    observe(input) {
      const sha256 = subtitleDigest(input.bytes);
      return insert({
        mediaFileId: input.mediaFileId,
        relativePath: input.relativePath,
        origin: "original",
        state: "committed",
        bytes: input.bytes,
        parentId: null,
        provenance: input.provenance ?? {},
        decide: (head) =>
          head && head.sha256 === sha256
            ? { reuse: head }
            : { origin: head ? "external" : "original" },
      });
    },

    record(input) {
      return insert({
        mediaFileId: input.mediaFileId,
        relativePath: input.relativePath,
        origin: input.origin,
        state: "committed",
        bytes: input.bytes,
        parentId: input.parentId ?? null,
        provenance: input.provenance ?? {},
      });
    },

    begin(input) {
      return insert({
        mediaFileId: input.mediaFileId,
        relativePath: input.relativePath,
        origin: input.origin,
        state: "pending",
        bytes: input.bytes,
        parentId: input.parentId,
        provenance: input.provenance ?? {},
      });
    },

    async settle(id, state, failure) {
      await pool.query(
        `UPDATE subtitle_revisions
            SET state = $2, failure = $3, settled_at = now()
          WHERE id = $1 AND state = 'pending'`,
        [id, state, failure ?? null],
      );
    },
  };
}

export type RevisionWriteResult =
  | {
      readonly outcome: "committed";
      readonly revision: SubtitleRevision;
      readonly previous: SubtitleRevision;
      readonly sha256: string;
      readonly cueCount: number;
    }
  /** The new bytes are the bytes already there. Nothing was written. */
  | { readonly outcome: "unchanged"; readonly revision: SubtitleRevision }
  | {
      readonly outcome: "refused";
      readonly failure: string;
      readonly reason: string;
    };

/**
 * Settles a write a crash or an ambiguous commit left pending, by asking the
 * file. Its bytes are the new revision's: the write landed. Anything else: it
 * did not, and if the file is not the parent either, somebody else's bytes are
 * recorded as they are, so they are not lost to the next write.
 */
export async function settlePendingRevision(
  store: SubtitleRevisionStore,
  storage: Pick<SubtitleStorage, "read">,
  mediaFileId: string,
  relativePath: string,
): Promise<"none" | "committed" | "abandoned" | "unreadable"> {
  const pending = await store.pending(mediaFileId, relativePath);
  if (!pending) return "none";
  let current: Uint8Array;
  try {
    current = await storage.read(mediaFileId, relativePath);
  } catch {
    return "unreadable";
  }
  if (subtitleDigest(current) === pending.sha256) {
    await store.settle(pending.id, "committed");
    return "committed";
  }
  await store.settle(
    pending.id,
    "abandoned",
    "The file did not hold this revision when it was checked.",
  );
  await store.observe({ mediaFileId, relativePath, bytes: current });
  return "abandoned";
}

/**
 * Replaces a sidecar with new bytes, keeping both versions.
 *
 * `read` is what the caller read and decided from. The write is refused if the
 * file no longer holds it — somebody edited the subtitle after it was
 * analysed, and their edit is not ours to overwrite — and those bytes are
 * recorded first either way, so the version being replaced is never only on
 * the disk that is about to be written.
 */
export async function writeSubtitleRevision(input: {
  store: SubtitleRevisionStore;
  storage: Pick<SubtitleStorage, "read" | "rewrite">;
  mediaFileId: string;
  relativePath: string;
  read: Uint8Array;
  next: Uint8Array;
  origin: RevisionOrigin;
  provenance?: Record<string, unknown>;
}): Promise<RevisionWriteResult> {
  const { store, storage, mediaFileId, relativePath } = input;

  const settled = await settlePendingRevision(
    store,
    storage,
    mediaFileId,
    relativePath,
  );
  if (settled === "unreadable")
    return {
      outcome: "refused",
      failure: "commit-ambiguous",
      reason:
        "An earlier change to this subtitle has not been confirmed, and the file cannot be read to confirm it.",
    };

  // The writer validates too; checking first keeps a bad document out of the history.
  let cueCount: number;
  try {
    cueCount = validateSubtitle({
      bytes: input.next,
      declaredFormat: null,
      declaredFileName: null,
    }).cueCount;
  } catch (error) {
    return {
      outcome: "refused",
      failure: "payload-invalid",
      reason:
        error instanceof InvalidSubtitleError
          ? error.reason
          : "The corrected subtitle is not a valid subtitle.",
    };
  }

  const previous = await store.observe({
    mediaFileId,
    relativePath,
    bytes: input.read,
  });
  const sha256 = subtitleDigest(input.next);
  if (sha256 === previous.sha256)
    return { outcome: "unchanged", revision: previous };

  let pending: SubtitleRevision;
  try {
    pending = await store.begin({
      mediaFileId,
      relativePath,
      origin: input.origin,
      bytes: input.next,
      parentId: previous.id,
      ...(input.provenance ? { provenance: input.provenance } : {}),
    });
  } catch (error) {
    if (error instanceof RevisionBusyError)
      return { outcome: "refused", failure: "busy", reason: error.message };
    throw error;
  }

  const written = await storage.rewrite({
    mediaFileId,
    relativePath,
    bytes: input.next,
    expectedSha256: previous.sha256,
  });

  if (written.outcome === "installed" || written.outcome === "duplicate") {
    await store.settle(pending.id, "committed");
    return {
      outcome: "committed",
      revision: { ...pending, state: "committed" },
      previous,
      sha256,
      cueCount: written.outcome === "installed" ? written.cueCount : cueCount,
    };
  }
  if (written.outcome === "cancelled") {
    await store.settle(pending.id, "abandoned", "cancelled");
    return {
      outcome: "refused",
      failure: "cancelled",
      reason: "The change was cancelled.",
    };
  }
  /*
   * An ambiguous commit may or may not have landed. The file says which, and
   * if it cannot be read now the row stays pending for the next operation (or
   * the reconcile sweep) to settle — which is the whole point of the row.
   */
  if (written.failure === "commit-ambiguous") {
    const outcome = await settlePendingRevision(
      store,
      storage,
      mediaFileId,
      relativePath,
    );
    if (outcome === "committed")
      return {
        outcome: "committed",
        revision: { ...pending, state: "committed" },
        previous,
        sha256,
        cueCount,
      };
    return {
      outcome: "refused",
      failure: written.failure,
      reason: written.reason,
    };
  }
  await store.settle(pending.id, "abandoned", written.failure);
  return {
    outcome: "refused",
    failure: written.failure,
    reason: written.reason,
  };
}
