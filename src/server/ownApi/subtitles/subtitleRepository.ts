/**
 * Subtitles in PostgreSQL.
 *
 * Three things here carry correctness beyond "the rows are saved".
 *
 * `moveAttempt` is a conditional write: the row must still be in the state the
 * caller last saw. Two workers holding one attempt therefore cannot both
 * advance it — the loser matches no row, is told so, and stops before touching
 * a filesystem or a provider. The legality of the move itself is checked in the
 * domain first, so an impossible transition fails loudly rather than silently
 * matching nothing.
 *
 * `recordInstallation` leans on a unique index rather than on a check. Asking
 * "has anything been installed at this path?" and then inserting is a race with
 * a window in it; inserting and letting the database refuse has none. The
 * refusal is not an error — it means somebody else recorded this path, which is
 * exactly when the caller should re-read rather than overwrite.
 *
 * And `managedDigest` is the whole ownership story. A subtitle file has nowhere
 * to carry a marker, so the only evidence that this system wrote the file at a
 * path is that it said so here, together with the digest of what it wrote. That
 * is what stands between an upgrade and somebody's hand-made translation.
 */

import { randomUUID } from "node:crypto";
import type { DatabasePool } from "../database/databasePool";
import {
  assertTransition,
  type SubtitleFailureClass,
  type SubtitleState,
  type SubtitleSyncState,
  type SubtitleWant,
} from "./subtitleState";

export interface SubtitleWantRow {
  readonly id: string;
  readonly mediaFileId: string;
  readonly language: string;
  readonly forced: boolean;
  readonly hearingImpaired: SubtitleWant["hearingImpaired"];
  readonly active: boolean;
}

export interface SubtitleAttemptRow {
  readonly id: string;
  readonly wantId: string;
  readonly state: SubtitleState;
  readonly attempt: number;
  readonly providerId: string | null;
  readonly candidateId: string | null;
  readonly score: number | null;
  readonly failureClass: SubtitleFailureClass | null;
  readonly failureDetail: string | null;
  readonly awaitingProviderId: string | null;
  readonly runAfter: Date | null;
}

/** An attempt and the want it was made for, which is what names the language. */
export interface SubtitleAttemptWithWant extends SubtitleAttemptRow {
  readonly mediaFileId: string;
  readonly language: string;
  readonly forced: boolean;
  readonly hearingImpaired: string;
  /** What the file is, for a person: the film, or the show and episode. */
  readonly title: string | null;
  readonly seasonNumber: number | null;
  readonly episodeNumber: number | null;
}

export interface RecordInstallationInput {
  readonly mediaFileId: string;
  readonly wantId: string | null;
  readonly attemptId: string | null;
  readonly relativePath: string;
  readonly language: string;
  readonly forced: boolean;
  readonly hearingImpaired: boolean;
  readonly format: "srt" | "vtt";
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly cueCount: number | null;
  readonly providerId: string | null;
  readonly syncState?: SubtitleSyncState;
}

export interface RecordRetimingInput {
  readonly mediaFileId: string;
  readonly relativePath: string;
  /** Only used when there is no row yet; an existing one keeps its own. */
  readonly language: string;
  readonly forced: boolean;
  readonly format: "srt" | "vtt";
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly cueCount: number | null;
  /**
   * What the rewrite says about the file's timing. A correction placed every
   * cue: assumed in sync. A partial one, or bytes put back from a revision:
   * unknown. Defaults to assumed in sync, which is what a retiming meant
   * before corrections could be partial.
   */
  readonly syncState?: Extract<
    SubtitleSyncState,
    "assumed-in-sync" | "unknown"
  >;
}

/** Raised when a conditional write matched no row. */
export class SubtitleAttemptMovedError extends Error {
  constructor(attemptId: string, from: SubtitleState) {
    super(`Attempt ${attemptId} is no longer in ${from}.`);
    this.name = "SubtitleAttemptMovedError";
  }
}

export interface SubtitleRepository {
  getAttempt(attemptId: string): Promise<SubtitleAttemptRow | null>;
  ensureWant(mediaFileId: string, want: SubtitleWant): Promise<SubtitleWantRow>;
  activeWants(mediaFileId: string): Promise<SubtitleWantRow[]>;
  deactivateWant(wantId: string): Promise<void>;
  beginAttempt(wantId: string): Promise<SubtitleAttemptRow>;
  moveAttempt(input: {
    attemptId: string;
    from: SubtitleState;
    to: SubtitleState;
    providerId?: string | null;
    candidateId?: string | null;
    score?: number | null;
    scoreReasons?: readonly string[] | null;
    failureClass?: SubtitleFailureClass | null;
    failureDetail?: string | null;
    awaitingProviderId?: string | null;
    runAfter?: Date | null;
    countsAsAttempt?: boolean;
  }): Promise<SubtitleAttemptRow>;
  /** Attempts a crash could have left with bytes nothing has recorded. */
  uncertainAttempts(limit?: number): Promise<SubtitleAttemptRow[]>;
  /**
   * Recent attempts, with the want each belongs to.
   *
   * For the operations surface, which needs to show what is in progress, what
   * failed and — the reason this exists at all — what is sitting waiting for
   * somebody to sign in to a provider. Newest first.
   */
  recentAttempts(limit?: number): Promise<SubtitleAttemptWithWant[]>;
  /** An attempt for this want that has not finished, if one exists. */
  openAttempt(wantId: string): Promise<string | null>;
  /** The playable file of a film, or of every episode under a show or season. */
  titleMediaFiles(itemId: string): Promise<string[]>;
  /**
   * Where one media file is, library-relative and POSIX.
   *
   * The storage writer derives every destination from this, so it is read from
   * the catalogue and never from anything that arrived in a request.
   */
  mediaFileRelativePath(mediaFileId: string): Promise<string | null>;
  /** Attempts paused for a sign-in to this provider. */
  attemptsAwaiting(providerId: string): Promise<string[]>;
  recordInstallation(input: RecordInstallationInput): Promise<string>;
  /**
   * Records that a subtitle already on disk was moved onto the media's timeline.
   *
   * Separate from `recordInstallation` because retiming is not an installation
   * and must not be written as one. The bytes changed, so the digest that
   * establishes ownership has to move with them or the next upgrade will refuse
   * to touch a file this system itself wrote. Everything else about the
   * installation — which want it answered, which attempt produced it, which
   * provider it came from — is unchanged by moving it and is left alone, which
   * an upsert built for a fresh install would overwrite with nulls.
   *
   * An insert when there is no row is the case where somebody put the subtitle
   * there by hand: correcting it is the moment this system starts being
   * responsible for those bytes, and saying so is what lets it correct them
   * again later.
   */
  recordRetiming(input: RecordRetimingInput): Promise<void>;
  /** The digest this system recorded for a path, or `null` if it wrote none. */
  managedDigest(
    mediaFileId: string,
    relativePath: string,
  ): Promise<string | null>;
  forgetInstallation(mediaFileId: string, relativePath: string): Promise<void>;
}

interface WantRecord {
  id: string;
  media_file_id: string;
  language: string;
  forced: boolean;
  hearing_impaired: string;
  active: boolean;
}

interface AttemptRecord {
  id: string;
  want_id: string;
  state: string;
  attempt: number;
  provider_id: string | null;
  candidate_id: string | null;
  score: number | null;
  failure_class: string | null;
  failure_detail: string | null;
  awaiting_provider_id: string | null;
  run_after: Date | null;
}

const toWant = (row: WantRecord): SubtitleWantRow => ({
  id: row.id,
  mediaFileId: row.media_file_id,
  language: row.language,
  forced: row.forced,
  hearingImpaired: row.hearing_impaired as SubtitleWant["hearingImpaired"],
  active: row.active,
});

const toAttempt = (row: AttemptRecord): SubtitleAttemptRow => ({
  id: row.id,
  wantId: row.want_id,
  state: row.state as SubtitleState,
  attempt: row.attempt,
  providerId: row.provider_id,
  candidateId: row.candidate_id,
  score: row.score,
  failureClass: row.failure_class as SubtitleFailureClass | null,
  failureDetail: row.failure_detail,
  awaitingProviderId: row.awaiting_provider_id,
  runAfter: row.run_after,
});

export function createSubtitleRepository(
  pool: Pick<DatabasePool, "query">,
): SubtitleRepository {
  return {
    async getAttempt(attemptId) {
      const result = await pool.query<AttemptRecord>(
        `SELECT id, want_id, state, attempt, provider_id, candidate_id,
                score, failure_class, failure_detail, awaiting_provider_id, run_after
           FROM subtitle_attempts WHERE id = $1`,
        [attemptId],
      );
      return result.rows[0] ? toAttempt(result.rows[0]) : null;
    },
    /*
     * Idempotent by the same unique index the domain's identity uses:
     * (media file, language, forced). The hearing-impaired preference is
     * updated rather than keyed on, because it ranks candidates and does not
     * make a different want.
     */
    async ensureWant(mediaFileId, want) {
      const result = await pool.query<WantRecord>(
        `INSERT INTO subtitle_wants
           (id, media_file_id, language, forced, hearing_impaired)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (media_file_id, language, forced) DO UPDATE
           SET hearing_impaired = EXCLUDED.hearing_impaired,
               active = true,
               updated_at = now()
         RETURNING id, media_file_id, language, forced, hearing_impaired, active`,
        [
          randomUUID(),
          mediaFileId,
          want.language,
          want.forced,
          want.hearingImpaired,
        ],
      );
      return toWant(result.rows[0] as WantRecord);
    },

    async activeWants(mediaFileId) {
      const result = await pool.query<WantRecord>(
        `SELECT id, media_file_id, language, forced, hearing_impaired, active
           FROM subtitle_wants
          WHERE media_file_id = $1 AND active
          ORDER BY language, forced`,
        [mediaFileId],
      );
      return result.rows.map(toWant);
    },

    async deactivateWant(wantId) {
      await pool.query(
        `UPDATE subtitle_wants SET active = false, updated_at = now()
          WHERE id = $1`,
        [wantId],
      );
    },

    async beginAttempt(wantId) {
      const result = await pool.query<AttemptRecord>(
        `INSERT INTO subtitle_attempts (id, want_id, state)
         VALUES ($1, $2, 'wanted')
         RETURNING id, want_id, state, attempt, provider_id, candidate_id,
                   score, failure_class, failure_detail, awaiting_provider_id,
                   run_after`,
        [randomUUID(), wantId],
      );
      return toAttempt(result.rows[0] as AttemptRecord);
    },

    async moveAttempt(input) {
      /*
       * The domain decides legality before the database is asked. A move the
       * state machine forbids is a programming error and should say so, rather
       * than becoming an "already moved" that looks like a lost race.
       */
      assertTransition(input.from, input.to);

      const result = await pool.query<AttemptRecord>(
        `UPDATE subtitle_attempts
            SET state = $3,
                attempt = attempt + $4,
                provider_id = COALESCE($5, provider_id),
                candidate_id = COALESCE($6, candidate_id),
                score = COALESCE($7, score),
                score_reasons = COALESCE($8, score_reasons),
                failure_class = $9,
                failure_detail = $10,
                awaiting_provider_id = $11,
                run_after = $12,
                updated_at = now()
          WHERE id = $1 AND state = $2
        RETURNING id, want_id, state, attempt, provider_id, candidate_id,
                  score, failure_class, failure_detail, awaiting_provider_id,
                  run_after`,
        [
          input.attemptId,
          input.from,
          input.to,
          input.countsAsAttempt ? 1 : 0,
          input.providerId ?? null,
          input.candidateId ?? null,
          input.score ?? null,
          input.scoreReasons ? JSON.stringify(input.scoreReasons) : null,
          input.failureClass ?? null,
          input.failureDetail ?? null,
          input.awaitingProviderId ?? null,
          input.runAfter ?? null,
        ],
      );
      const row = result.rows[0];
      if (!row)
        throw new SubtitleAttemptMovedError(input.attemptId, input.from);
      return toAttempt(row);
    },

    async uncertainAttempts(limit = 100) {
      const result = await pool.query<AttemptRecord>(
        `SELECT id, want_id, state, attempt, provider_id, candidate_id,
                score, failure_class, failure_detail, awaiting_provider_id,
                run_after
           FROM subtitle_attempts
          WHERE state IN ('downloading', 'validating')
          ORDER BY updated_at
          LIMIT $1`,
        [limit],
      );
      return result.rows.map(toAttempt);
    },

    async recentAttempts(limit = 100) {
      const result = await pool.query<
        AttemptRecord & {
          media_file_id: string;
          language: string;
          forced: boolean;
          hearing_impaired: string;
          title: string | null;
          season_number: number | null;
          episode_number: number | null;
        }
      >(
        `SELECT a.id, a.want_id, a.state, a.attempt, a.provider_id,
                a.candidate_id, a.score, a.failure_class, a.failure_detail,
                a.awaiting_provider_id, a.run_after,
                w.media_file_id, w.language, w.forced, w.hearing_impaired,
                COALESCE(series.title, i.title) AS title,
                CASE WHEN i.kind = 'episode' THEN i.parent_index_number END AS season_number,
                CASE WHEN i.kind = 'episode' THEN i.index_number END AS episode_number
           FROM subtitle_attempts a
           JOIN subtitle_wants w ON w.id = a.want_id
           LEFT JOIN media_files f ON f.id = w.media_file_id
           LEFT JOIN items i ON i.id = f.item_id
           LEFT JOIN items series ON series.id = i.series_id
          ORDER BY a.updated_at DESC
          LIMIT $1`,
        [Math.min(Math.max(limit, 1), 500)],
      );
      return result.rows.map((row) => ({
        ...toAttempt(row),
        mediaFileId: row.media_file_id,
        language: row.language,
        forced: row.forced,
        hearingImpaired: row.hearing_impaired,
        title: row.title,
        seasonNumber: row.season_number,
        episodeNumber: row.episode_number,
      }));
    },

    async openAttempt(wantId) {
      const result = await pool.query<{ id: string }>(
        `SELECT id FROM subtitle_attempts WHERE want_id = $1
           AND state NOT IN ('installed', 'superseded', 'unavailable', 'failed')
         ORDER BY updated_at DESC LIMIT 1`,
        [wantId],
      );
      return result.rows[0]?.id ?? null;
    },

    async titleMediaFiles(itemId) {
      const result = await pool.query<{ id: string }>(
        `SELECT DISTINCT ON (f.item_id) f.id FROM media_files f JOIN items i ON i.id = f.item_id
          WHERE (i.id = $1 OR i.series_id = $1 OR i.parent_id = $1)
            AND i.kind IN ('movie', 'episode')
            AND f.missing_since IS NULL AND f.size_bytes > 0
          ORDER BY f.item_id, f.is_primary DESC, f.size_bytes DESC
          LIMIT 1000`,
        [itemId],
      );
      return result.rows.map((row) => row.id);
    },

    async mediaFileRelativePath(mediaFileId) {
      const result = await pool.query<{ relative_path: string }>(
        `SELECT relative_path FROM media_files WHERE id = $1`,
        [mediaFileId],
      );
      return result.rows[0]?.relative_path ?? null;
    },

    async attemptsAwaiting(providerId) {
      const result = await pool.query<{ id: string }>(
        `SELECT id FROM subtitle_attempts
          WHERE state = 'needs-authentication' AND awaiting_provider_id = $1
          LIMIT 1000`,
        [providerId],
      );
      return result.rows.map((row) => row.id);
    },

    /*
     * Insert and let the index refuse, rather than checking and then writing.
     * A second install of the same path updates the digest, because a
     * legitimate upgrade replaces what this system previously wrote and the
     * record must follow the file rather than describe a version of it that no
     * longer exists.
     */
    async recordInstallation(input) {
      const result = await pool.query<{ id: string }>(
        `INSERT INTO subtitle_installations
           (id, media_file_id, want_id, attempt_id, relative_path, language,
            forced, hearing_impaired, format, sha256, size_bytes, cue_count,
            provider_id, sync_state)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
         ON CONFLICT (media_file_id, relative_path) DO UPDATE
           SET want_id = EXCLUDED.want_id,
               attempt_id = EXCLUDED.attempt_id,
               language = EXCLUDED.language,
               forced = EXCLUDED.forced,
               hearing_impaired = EXCLUDED.hearing_impaired,
               format = EXCLUDED.format,
               sha256 = EXCLUDED.sha256,
               size_bytes = EXCLUDED.size_bytes,
               cue_count = EXCLUDED.cue_count,
               provider_id = EXCLUDED.provider_id,
               sync_state = EXCLUDED.sync_state,
               updated_at = now()
         RETURNING id`,
        [
          randomUUID(),
          input.mediaFileId,
          input.wantId,
          input.attemptId,
          input.relativePath,
          input.language,
          input.forced,
          input.hearingImpaired,
          input.format,
          input.sha256,
          input.sizeBytes,
          input.cueCount,
          input.providerId,
          input.syncState ?? "unknown",
        ],
      );
      return (result.rows[0] as { id: string }).id;
    },

    async recordRetiming(input) {
      await pool.query(
        `INSERT INTO subtitle_installations
           (id, media_file_id, relative_path, language, forced,
            hearing_impaired, format, sha256, size_bytes, cue_count, sync_state)
         VALUES ($1, $2, $3, $4, $5, false, $6, $7, $8, $9, $10)
         ON CONFLICT (media_file_id, relative_path) DO UPDATE
           SET sha256 = EXCLUDED.sha256,
               size_bytes = EXCLUDED.size_bytes,
               cue_count = EXCLUDED.cue_count,
               format = EXCLUDED.format,
               sync_state = EXCLUDED.sync_state,
               updated_at = now()`,
        [
          randomUUID(),
          input.mediaFileId,
          input.relativePath,
          input.language,
          input.forced,
          input.format,
          input.sha256,
          input.sizeBytes,
          input.cueCount,
          input.syncState ?? "assumed-in-sync",
        ],
      );
    },

    async managedDigest(mediaFileId, relativePath) {
      const result = await pool.query<{ sha256: string }>(
        `SELECT sha256 FROM subtitle_installations
          WHERE media_file_id = $1 AND relative_path = $2`,
        [mediaFileId, relativePath],
      );
      return result.rows[0]?.sha256 ?? null;
    },

    /*
     * Used when a file this system installed is gone or has been edited. The
     * record is removed rather than kept, because a record that no longer
     * matches the disk is worse than none: it would authorise overwriting a
     * file somebody else now owns.
     */
    async forgetInstallation(mediaFileId, relativePath) {
      await pool.query(
        `DELETE FROM subtitle_installations
          WHERE media_file_id = $1 AND relative_path = $2`,
        [mediaFileId, relativePath],
      );
    },
  };
}
