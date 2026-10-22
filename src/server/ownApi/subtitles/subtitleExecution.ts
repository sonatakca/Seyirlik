import type { DatabasePool } from "../database/databasePool";
import {
  tracksFromStreams,
  type SubtitleStreamFacts,
} from "./subtitleDetection";
import type { ScoredCandidate, SubtitleQuery } from "./subtitleProvider";
import {
  createSubtitleRepository,
  type SubtitleAttemptRow,
  type SubtitleRepository,
  type SubtitleWantRow,
} from "./subtitleRepository";
import type { SubtitleTrack } from "./subtitleState";
import type { SubtitleWriteIntent } from "./subtitleStorage";

export type SubtitleEvent =
  | "search-started"
  | "candidate-selected"
  | "installed"
  | "existing"
  | "unavailable"
  | "authentication-required"
  | "authentication-resumed"
  | "failed"
  | "operator-attention"
  | "playback-refresh"
  | "catalogue-attached";
export interface SubtitleWork {
  attempt: SubtitleAttemptRow;
  want: SubtitleWantRow;
  query: SubtitleQuery;
  embedded: SubtitleTrack[];
  relativePath: string;
  selected: ScoredCandidate | null;
  intent: SubtitleWriteIntent | null;
  replace: boolean;
  resumeStage: "searching" | "downloading" | null;
  repository: SubtitleRepository;
  signal: AbortSignal;
  checkpoint(patch: {
    selected?: ScoredCandidate;
    intent?: SubtitleWriteIntent;
    replace?: boolean;
    resumeStage?: "searching" | "downloading";
  }): Promise<void>;
  event(
    type: SubtitleEvent,
    data?: Record<string, string | number | boolean | null>,
  ): Promise<void>;
  transaction<T>(operation: () => Promise<T>): Promise<T>;
}
export interface SubtitleExecutionRepository {
  withAttempt<T>(
    attemptId: string,
    operation: (work: SubtitleWork) => Promise<T>,
  ): Promise<T | undefined>;
}

/** A path's last segment without its extension: `…/Dune.2021.2160p-X.mkv` → `Dune.2021.2160p-X`. */
export function releaseNameOf(relativePath: string): string | null {
  const name = relativePath.split(/[\\/]/).pop() ?? "";
  const bare = name.replace(/\.[A-Za-z0-9]{2,4}$/, "");
  return bare || null;
}

/** A PostgreSQL session lock serializes all wants for one media file, across workers. */
export function createSubtitleExecutionRepository(
  pool: DatabasePool,
): SubtitleExecutionRepository {
  return {
    async withAttempt(attemptId, operation) {
      const client = await pool.connect();
      const controller = new AbortController();
      const disconnected = () => controller.abort();
      client.on("error", disconnected);
      let key: string | undefined;
      try {
        const owner = await client.query<{ media_file_id: string }>(
          `SELECT w.media_file_id FROM subtitle_attempts a JOIN subtitle_wants w ON w.id=a.want_id WHERE a.id=$1`,
          [attemptId],
        );
        if (!owner.rows[0])
          throw new Error("The subtitle attempt no longer exists.");
        key = `subtitle:${owner.rows[0].media_file_id}`;
        const lock = await client.query<{ acquired: boolean }>(
          "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired",
          [key],
        );
        if (!lock.rows[0]?.acquired) {
          key = undefined;
          return undefined;
        }
        const repository = createSubtitleRepository(client);
        const attempt = await repository.getAttempt(attemptId);
        if (!attempt) throw new Error("The subtitle attempt no longer exists.");
        const loaded = await client.query<{
          want: SubtitleWantRow;
          relative_path: string;
          title: string;
          production_year: number | null;
          season: number | null;
          episode: number | null;
          duration_ms: number | null;
          selected_candidate: ScoredCandidate | null;
          pending_installation: SubtitleWriteIntent | null;
          resume_stage: SubtitleWork["resumeStage"];
          replace_existing: boolean;
          imdb_id: string | null;
          frame_rate: number | null;
          release_name: string | null;
        }>(
          `SELECT jsonb_build_object('id',w.id,'mediaFileId',w.media_file_id,'language',w.language,'forced',w.forced,'hearingImpaired',w.hearing_impaired,'active',w.active) AS want,
            f.relative_path, COALESCE(series.title,i.title) AS title, COALESCE(series.production_year,i.production_year) AS production_year,
            CASE WHEN i.kind='episode' THEN i.parent_index_number END AS season,
            CASE WHEN i.kind='episode' THEN i.index_number END AS episode, f.duration_ms,
            a.selected_candidate,a.pending_installation,a.resume_stage,a.replace_existing,
            COALESCE(series.provider_ids->>'imdb',i.provider_ids->>'imdb') AS imdb_id,
            (SELECT s.frame_rate FROM media_streams s WHERE s.media_file_id=f.id AND s.kind='video' AND NOT s.is_external ORDER BY s.stream_index LIMIT 1) AS frame_rate,
            (SELECT ifl.source_relative FROM import_files ifl JOIN imports imp ON imp.id=ifl.import_id
              WHERE imp.target_item_id IN (i.id,i.parent_id,i.series_id) AND ifl.role='media' AND ifl.destination_relative IS NOT NULL
                AND right(lower(replace(f.relative_path,'\\','/')),length(ifl.destination_relative))=lower(replace(ifl.destination_relative,'\\','/'))
              ORDER BY ifl.updated_at DESC LIMIT 1) AS release_name
          FROM subtitle_attempts a JOIN subtitle_wants w ON w.id=a.want_id
          JOIN media_files f ON f.id=w.media_file_id JOIN items i ON i.id=f.item_id
          LEFT JOIN items series ON series.id=i.series_id
          WHERE a.id=$1 AND f.missing_since IS NULL`,
          [attemptId],
        );
        const row = loaded.rows[0];
        if (!row) throw new Error("The subtitle media is missing.");
        const streams = await client.query<SubtitleStreamFacts>(
          `SELECT stream_index AS "streamIndex",kind,codec,language,title,is_forced AS "isForced",is_external AS "isExternal",external_relative_path AS "externalRelativePath" FROM media_streams WHERE media_file_id=$1 AND kind='subtitle' AND NOT is_external`,
          [row.want.mediaFileId],
        );
        const work: SubtitleWork = {
          attempt,
          want: row.want,
          relativePath: row.relative_path,
          query: {
            title: row.title,
            year: row.production_year,
            season: row.season,
            episode: row.episode,
            language: row.want.language,
            wantForced: row.want.forced,
            // The release a download was named for says more than the tidy
            // name the importer gave the file, so it is preferred when known.
            releaseTitle: releaseNameOf(row.release_name ?? row.relative_path),
            releaseGroup: null,
            source: null,
            resolution: null,
            videoHash: null,
            durationSeconds:
              row.duration_ms === null ? null : Number(row.duration_ms) / 1000,
            imdbId:
              row.imdb_id && /^tt\d{1,10}$/.test(row.imdb_id)
                ? row.imdb_id
                : null,
            frameRate: row.frame_rate === null ? null : Number(row.frame_rate),
          },
          embedded: tracksFromStreams(streams.rows),
          selected: row.selected_candidate,
          intent: row.pending_installation,
          resumeStage: row.resume_stage,
          replace: row.replace_existing,
          repository,
          signal: controller.signal,
          async checkpoint(patch) {
            if (controller.signal.aborted)
              throw new Error("Subtitle execution lost its database owner.");
            await client.query(
              `UPDATE subtitle_attempts SET selected_candidate=COALESCE($2,selected_candidate),pending_installation=COALESCE($3,pending_installation),resume_stage=COALESCE($4,resume_stage),replace_existing=COALESCE($5,replace_existing),updated_at=now() WHERE id=$1`,
              [
                attemptId,
                patch.selected ? JSON.stringify(patch.selected) : null,
                patch.intent ? JSON.stringify(patch.intent) : null,
                patch.resumeStage ?? null,
                patch.replace ?? null,
              ],
            );
            if (patch.replace !== undefined) work.replace = patch.replace;
            if (patch.selected) work.selected = patch.selected;
            if (patch.intent) work.intent = patch.intent;
            if (patch.resumeStage) work.resumeStage = patch.resumeStage;
          },
          async event(type, data = {}) {
            await client.query(
              "INSERT INTO subtitle_events(attempt_id,event_type,data) VALUES($1,$2,$3)",
              [attemptId, type, JSON.stringify(data)],
            );
          },
          async transaction(operation) {
            await client.query("BEGIN");
            try {
              const result = await operation();
              await client.query("COMMIT");
              return result;
            } catch (error) {
              await client.query("ROLLBACK").catch(() => undefined);
              throw error;
            }
          },
        };
        return await operation(work);
      } finally {
        if (key)
          await client
            .query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [key])
            .catch(() => controller.abort());
        client.removeListener("error", disconnected);
        client.release(controller.signal.aborted);
      }
    },
  };
}
