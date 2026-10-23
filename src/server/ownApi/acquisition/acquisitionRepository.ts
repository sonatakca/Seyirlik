/**
 * Acquisitions in PostgreSQL.
 *
 * `update` is the piece that matters. It is a conditional write — the row must
 * still be in the state the caller last saw — which is what makes two workers
 * holding the same acquisition safe without a separate lock table: the second
 * one's update matches no row, it is told so, and it stops.
 */
import { randomUUID } from "node:crypto";
import type { DatabasePool } from "../database/databasePool";
import type {
  AcquisitionPatch,
  AcquisitionRecord,
  AcquisitionStore,
} from "./acquisitionService";
import type {
  AcquisitionOrigin,
  AcquisitionState,
  FailureClass,
} from "./acquisitionState";
import { isTerminal } from "./acquisitionState";

export interface AcquisitionTarget {
  readonly kind: "movie" | "season" | "episode";
  readonly itemId?: string;
  readonly title: string;
  readonly year?: number;
  readonly season?: number;
  readonly episode?: number;
}

export interface AcquisitionDecisionEvidence {
  readonly profileId?: string;
  readonly profileName: string;
  readonly policySnapshot: unknown;
  readonly releaseFacts: unknown;
  readonly score: number;
  readonly reasons: unknown;
  readonly rejected: unknown;
}

export interface CreateAcquisitionInput {
  readonly target: AcquisitionTarget;
  readonly indexerId: string;
  readonly releaseGuid: string;
  readonly releaseTitle: string;
  readonly origin: AcquisitionOrigin;
  readonly evidence: AcquisitionDecisionEvidence;
}

export interface AcquisitionSummary extends AcquisitionRecord {
  readonly targetTitle: string;
  readonly targetKind: string;
  readonly targetItemId?: string;
  readonly targetYear?: number;
  readonly targetSeason?: number;
  readonly targetEpisode?: number;
  readonly origin: string;
  readonly failureClass?: string;
  readonly failureDetail?: string;
  readonly createdAtMs: number;
}

/**
 * Why this release was chosen, as it was recorded at the time.
 *
 * Written since Phase 4 and, until now, never read: the evidence existed in
 * the database with no way out of it, so an operator could see that a download
 * happened and not why. The policy is a snapshot rather than a reference, so
 * this answers what was decided then, not what the profile says today.
 */
export interface AcquisitionDecision {
  readonly profileName: string;
  readonly score: number;
  readonly reasons: unknown;
  readonly rejected: unknown;
  readonly decidedAtMs: number;
}

export interface AcquisitionEvent {
  readonly fromState: string | null;
  readonly toState: string;
  readonly failureClass?: string;
  readonly detail?: string;
  readonly atMs: number;
}

export interface AcquisitionRepository extends AcquisitionStore {
  create(input: CreateAcquisitionInput): Promise<AcquisitionSummary>;
  /**
   * Narrower than the store's, and truthfully so.
   *
   * `AcquisitionStore` is what the service needs — the state machine's fields
   * and nothing else. The repository has always returned the whole summary,
   * and the import phase needs the target it names.
   */
  get(id: string): Promise<AcquisitionSummary | null>;
  list(limit?: number): Promise<AcquisitionSummary[]>;
  detail(id: string): Promise<{
    acquisition: AcquisitionSummary;
    events: AcquisitionEvent[];
    decision: AcquisitionDecision | null;
  } | null>;
  /** Acquisitions finished downloading and not yet handed on. */
  listReadyForImport(limit?: number): Promise<AcquisitionSummary[]>;
  /**
   * Retires every failed acquisition for the same target as this one.
   *
   * A failure is in "Needs you" because nothing is getting the title. Once a
   * newer download is, the failure is history, and leaving it there makes
   * the page say a title needs attention while it is downloading.
   */
  supersedeFailedFor(acquisitionId: string): Promise<number>;
  /**
   * Whether this target already has a download that is running or done.
   *
   * Asked before a season is replaced episode by episode, so an episode that
   * is already downloading, or already downloaded, is not fetched twice.
   */
  hasLiveAcquisitionFor(target: AcquisitionTarget): Promise<boolean>;
  /**
   * How many replacements this acquisition's target has had: the fallback
   * acquisitions for the same title. Bounds automatic retries per title.
   */
  replacementsFor(acquisitionId: string): Promise<number>;
  /** What was asked for, and against which profile — enough to ask again. */
  searchContext(id: string): Promise<{
    target: AcquisitionTarget;
    profileId?: string;
  } | null>;
}

interface Row {
  id: string;
  state: string;
  indexer_id: string;
  release_guid: string;
  release_title: string;
  idempotency_key: string;
  external_id: string | null;
  attempt: number;
  retry_after: Date | null;
  download_path: string | null;
  size_bytes: string | number | null;
  failure_class: string | null;
  failure_detail: string | null;
  target_title: string;
  target_kind: string;
  target_item_id: string | null;
  target_year: number | null;
  target_season: number | null;
  target_episode: number | null;
  origin: string;
  created_at: Date;
  updated_at: Date;
}

const COLUMNS = `id, state, indexer_id, release_guid, release_title,
  idempotency_key, external_id, attempt, retry_after, download_path, size_bytes,
  failure_class, failure_detail, target_title, target_kind, target_item_id,
  target_year, target_season, target_episode, origin, created_at, updated_at`;

function toSummary(row: Row): AcquisitionSummary {
  const size = row.size_bytes === null ? undefined : Number(row.size_bytes);
  return {
    id: row.id,
    state: row.state as AcquisitionState,
    indexerId: row.indexer_id,
    releaseGuid: row.release_guid,
    releaseTitle: row.release_title,
    idempotencyKey: row.idempotency_key,
    ...(row.external_id ? { externalId: row.external_id } : {}),
    attempt: row.attempt,
    ...(row.retry_after ? { retryAfterMs: row.retry_after.getTime() } : {}),
    ...(row.download_path ? { downloadPath: row.download_path } : {}),
    ...(size === undefined || Number.isNaN(size) ? {} : { sizeBytes: size }),
    ...(row.failure_class ? { failureClass: row.failure_class } : {}),
    ...(row.failure_detail ? { failureDetail: row.failure_detail } : {}),
    targetTitle: row.target_title,
    targetKind: row.target_kind,
    ...(row.target_item_id === null
      ? {}
      : { targetItemId: row.target_item_id }),
    ...(row.target_year === null ? {} : { targetYear: row.target_year }),
    ...(row.target_season === null ? {} : { targetSeason: row.target_season }),
    ...(row.target_episode === null
      ? {}
      : { targetEpisode: row.target_episode }),
    origin: row.origin,
    createdAtMs: row.created_at.getTime(),
    updatedAtMs: row.updated_at.getTime(),
  };
}

export function createAcquisitionRepository(
  pool: DatabasePool,
): AcquisitionRepository {
  return {
    async create(input) {
      const id = randomUUID();
      /*
       * The key is derived from the row's own identifier, so it is unique by
       * construction and needs no coordination — and it is written in the same
       * statement that creates the row, before anything could be submitted
       * under it.
       */
      const idempotencyKey = `seyirlik-${id}`;
      const inserted = await pool.query<Row>(
        `INSERT INTO acquisitions
           (id, target_kind, target_item_id, target_title, target_year,
            target_season, target_episode, indexer_id, release_guid,
            release_title, state, origin, idempotency_key)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'planned',$11,$12)
         RETURNING ${COLUMNS}`,
        [
          id,
          input.target.kind,
          input.target.itemId ?? null,
          input.target.title,
          input.target.year ?? null,
          input.target.season ?? null,
          input.target.episode ?? null,
          input.indexerId,
          input.releaseGuid,
          input.releaseTitle,
          input.origin,
          idempotencyKey,
        ],
      );
      await pool.query(
        `INSERT INTO acquisition_decisions
           (acquisition_id, profile_id, profile_name, policy_snapshot,
            release_facts, score, reasons, rejected)
         VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7::jsonb,$8::jsonb)`,
        [
          id,
          input.evidence.profileId ?? null,
          input.evidence.profileName,
          JSON.stringify(input.evidence.policySnapshot),
          JSON.stringify(input.evidence.releaseFacts),
          input.evidence.score,
          JSON.stringify(input.evidence.reasons),
          JSON.stringify(input.evidence.rejected),
        ],
      );
      await pool.query(
        `INSERT INTO acquisition_events (acquisition_id, from_state, to_state, detail)
         VALUES ($1, NULL, 'planned', $2)`,
        [id, `Chosen by ${input.origin} decision.`],
      );
      return toSummary(inserted.rows[0]!);
    },

    async get(id) {
      const result = await pool.query<Row>(
        `SELECT ${COLUMNS} FROM acquisitions WHERE id = $1`,
        [id],
      );
      return result.rows[0] ? toSummary(result.rows[0]) : null;
    },

    async listActive() {
      const result = await pool.query<Row>(
        `SELECT ${COLUMNS} FROM acquisitions
          WHERE state NOT IN ('downloaded','cancelled','superseded','failed')
          ORDER BY created_at`,
      );
      return result.rows.map(toSummary);
    },

    async update(id, expectedState, patch: AcquisitionPatch, detail) {
      /*
       * One statement, guarded on the state the caller saw. Two workers cannot
       * both win it, and no separate lock has to be kept in step with the row.
       */
      const result = await pool.query<{ state: string }>(
        `UPDATE acquisitions SET
           state = COALESCE($3, state),
           external_id = COALESCE($4, external_id),
           attempt = COALESCE($5, attempt),
           failure_class = CASE WHEN $6::boolean THEN $7 ELSE failure_class END,
           failure_detail = CASE WHEN $6::boolean THEN $8 ELSE failure_detail END,
           download_path = COALESCE($9, download_path),
           size_bytes = COALESCE($10, size_bytes),
           retry_after = CASE WHEN $11::boolean THEN $12 ELSE retry_after END,
           completed_at = CASE WHEN $3 = 'downloaded' THEN now() ELSE completed_at END,
           updated_at = now()
         WHERE id = $1 AND state = $2
         RETURNING state`,
        [
          id,
          expectedState,
          patch.state ?? null,
          patch.externalId ?? null,
          patch.attempt ?? null,
          patch.failureClass !== undefined || patch.failureDetail !== undefined,
          patch.failureClass ?? null,
          patch.failureDetail ?? null,
          patch.downloadPath ?? null,
          patch.sizeBytes ?? null,
          patch.retryAfterMs !== undefined,
          patch.retryAfterMs ? new Date(patch.retryAfterMs) : null,
        ],
      );
      if (result.rows.length === 0) return false;

      if (patch.state && patch.state !== expectedState) {
        await pool.query(
          `INSERT INTO acquisition_events
             (acquisition_id, from_state, to_state, failure_class, detail)
           VALUES ($1,$2,$3,$4,$5)`,
          [
            id,
            expectedState,
            patch.state,
            (patch.failureClass as FailureClass | null | undefined) ?? null,
            detail ?? null,
          ],
        );
      }
      return true;
    },

    async list(limit = 100) {
      const result = await pool.query<Row>(
        `SELECT ${COLUMNS} FROM acquisitions ORDER BY created_at DESC LIMIT $1`,
        [Math.min(Math.max(limit, 1), 500)],
      );
      return result.rows.map(toSummary);
    },

    async detail(id) {
      const acquisition = await this.get(id);
      if (!acquisition) return null;
      const events = await pool.query<{
        from_state: string | null;
        to_state: string;
        failure_class: string | null;
        detail: string | null;
        at: Date;
      }>(
        `SELECT from_state, to_state, failure_class, detail, at
           FROM acquisition_events WHERE acquisition_id = $1 ORDER BY id`,
        [id],
      );
      const decision = await pool.query<{
        profile_name: string;
        score: number;
        reasons: unknown;
        rejected: unknown;
        decided_at: Date;
      }>(
        `SELECT profile_name, score, reasons, rejected, decided_at
           FROM acquisition_decisions WHERE acquisition_id = $1`,
        [id],
      );

      return {
        acquisition: acquisition as AcquisitionSummary,
        decision: decision.rows[0]
          ? {
              profileName: decision.rows[0].profile_name,
              score: decision.rows[0].score,
              reasons: decision.rows[0].reasons,
              rejected: decision.rows[0].rejected,
              decidedAtMs: decision.rows[0].decided_at.getTime(),
            }
          : null,
        events: events.rows.map((row) => ({
          fromState: row.from_state,
          toState: row.to_state,
          ...(row.failure_class ? { failureClass: row.failure_class } : {}),
          ...(row.detail ? { detail: row.detail } : {}),
          atMs: row.at.getTime(),
        })),
      };
    },

    async supersedeFailedFor(acquisitionId) {
      /*
       * The same target: the catalogue item when both name one, otherwise
       * the kind, title, season and episode. A year counts only when both
       * rows recorded one, because a search by hand may leave it out. The
       * item alone is not enough: a season pack, and an episode the catalogue
       * has no row for yet, name their series, so two seasons of one show
       * share an item and differ only in their numbers.
       */
      const result = await pool.query<{ acquisition_id: string }>(
        `WITH newer AS (SELECT * FROM acquisitions WHERE id = $1),
         retired AS (
           UPDATE acquisitions a
              SET state = 'superseded', updated_at = now()
             FROM newer n
            WHERE a.id <> n.id
              AND a.state = 'failed'
              AND a.target_kind = n.target_kind
              AND (
                (a.target_item_id IS NOT NULL AND a.target_item_id = n.target_item_id
                 AND a.target_season IS NOT DISTINCT FROM n.target_season
                 AND a.target_episode IS NOT DISTINCT FROM n.target_episode)
                OR (
                  lower(a.target_title) = lower(n.target_title)
                  AND (a.target_year IS NULL OR n.target_year IS NULL
                       OR a.target_year = n.target_year)
                  AND a.target_season IS NOT DISTINCT FROM n.target_season
                  AND a.target_episode IS NOT DISTINCT FROM n.target_episode
                )
              )
            RETURNING a.id
         )
         INSERT INTO acquisition_events
           (acquisition_id, from_state, to_state, detail)
         SELECT id, 'failed', 'superseded',
                'A newer download for the same title replaced it.'
           FROM retired
         RETURNING acquisition_id`,
        [acquisitionId],
      );
      return result.rows.length;
    },

    async hasLiveAcquisitionFor(target) {
      /*
       * The same matching `supersedeFailedFor` uses: the catalogue item when
       * both name one, otherwise kind, title, season and episode.
       *
       * `downloaded` never changes again, so it cannot mean "still coming" on
       * its own. A finished download covers its target while its import is
       * under way, or for a day while it waits for one; after that, whatever
       * the import did not file is missing again. A season pack that filed
       * half its episodes used to block every later search of its season.
       */
      const result = await pool.query<{ live: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM acquisitions a
            WHERE a.state NOT IN ('failed','cancelled','superseded')
              AND (
                a.state <> 'downloaded'
                OR EXISTS (SELECT 1 FROM imports i WHERE i.acquisition_id = a.id
                             AND i.state NOT IN ('complete','cancelled','failed'))
                OR (NOT EXISTS (SELECT 1 FROM imports i WHERE i.acquisition_id = a.id)
                    AND a.completed_at > now() - interval '1 day')
              )
              AND a.target_kind = $1
              AND (
                ($2::uuid IS NOT NULL AND a.target_item_id = $2::uuid
                 AND a.target_season IS NOT DISTINCT FROM $5::int
                 AND a.target_episode IS NOT DISTINCT FROM $6::int)
                OR (
                  lower(a.target_title) = lower($3)
                  AND (a.target_year IS NULL OR $4::int IS NULL
                       OR a.target_year = $4::int)
                  AND a.target_season IS NOT DISTINCT FROM $5::int
                  AND a.target_episode IS NOT DISTINCT FROM $6::int
                )
              )
         ) AS live`,
        [
          target.kind,
          target.itemId ?? null,
          target.title,
          target.year ?? null,
          target.season ?? null,
          target.episode ?? null,
        ],
      );
      return result.rows[0]?.live === true;
    },

    async replacementsFor(acquisitionId) {
      const result = await pool.query<{ count: string }>(
        `WITH this AS (SELECT * FROM acquisitions WHERE id = $1)
         SELECT count(*) AS count
           FROM acquisitions a, this n
          WHERE a.origin = 'fallback'
            AND a.target_kind = n.target_kind
            AND (
              (a.target_item_id IS NOT NULL AND a.target_item_id = n.target_item_id
               AND a.target_season IS NOT DISTINCT FROM n.target_season
               AND a.target_episode IS NOT DISTINCT FROM n.target_episode)
              OR (
                lower(a.target_title) = lower(n.target_title)
                AND (a.target_year IS NULL OR n.target_year IS NULL
                     OR a.target_year = n.target_year)
                AND a.target_season IS NOT DISTINCT FROM n.target_season
                AND a.target_episode IS NOT DISTINCT FROM n.target_episode
              )
            )`,
        [acquisitionId],
      );
      return Number(result.rows[0]?.count ?? 0);
    },

    async searchContext(id) {
      const result = await pool.query<{
        target_kind: string;
        target_item_id: string | null;
        target_title: string;
        target_year: number | null;
        target_season: number | null;
        target_episode: number | null;
        profile_id: string | null;
      }>(
        `SELECT a.target_kind, a.target_item_id, a.target_title, a.target_year,
                a.target_season, a.target_episode, d.profile_id
           FROM acquisitions a
           LEFT JOIN acquisition_decisions d ON d.acquisition_id = a.id
          WHERE a.id = $1`,
        [id],
      );
      const row = result.rows[0];
      if (!row) return null;
      return {
        target: {
          kind: row.target_kind as AcquisitionTarget["kind"],
          title: row.target_title,
          ...(row.target_item_id ? { itemId: row.target_item_id } : {}),
          ...(row.target_year === null ? {} : { year: row.target_year }),
          ...(row.target_season === null ? {} : { season: row.target_season }),
          ...(row.target_episode === null
            ? {}
            : { episode: row.target_episode }),
        },
        ...(row.profile_id ? { profileId: row.profile_id } : {}),
      };
    },

    async listReadyForImport(limit = 100) {
      // The handoff. Everything the import phase needs to find the bytes, and
      // nothing this phase is allowed to do with them.
      const result = await pool.query<Row>(
        `SELECT ${COLUMNS} FROM acquisitions
          WHERE state = 'downloaded' AND download_path IS NOT NULL
          ORDER BY completed_at
          LIMIT $1`,
        [Math.min(Math.max(limit, 1), 500)],
      );
      return result.rows.map(toSummary);
    },
  };
}

/** Whether an acquisition may still be retried by an operator. */
export function isRetryable(summary: AcquisitionSummary): boolean {
  return summary.state === "failed" && !isTerminal(summary.state);
}
