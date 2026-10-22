import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { setPriority } from "node:os";
import path from "node:path";
import { BACKGROUND_PROCESS_NICENESS } from "../../../renditions/processExecution";
import type { DatabasePool } from "../database/databasePool";
import { withTransaction } from "../database/transaction";
import type {
  CatalogueRepository,
  MediaFileRow,
  ProcessableTitleRow,
} from "../catalogue/catalogueRepository";
import type { RenditionService } from "../../renditionService";
import { FINGERPRINT_SAMPLE_RATE, fingerprintPcm } from "./audioFingerprint";
import {
  closingWindow,
  openingWindowSeconds,
  planSeasonSegments,
  segmentsFromChapters,
  type AudioWindow,
  type EpisodeAudio,
  type PlannedSegment,
} from "./segmentPlanning";

/**
 * Bumped whenever detection changes enough that old results should be
 * replaced; a sweep re-analyses every season recorded under an older one.
 */
export const SEGMENT_DETECTOR_VERSION = 1;

/** A season or a film that should be (re)analysed, and why it qualifies. */
export interface SegmentSubject {
  subjectId: string;
  kind: "season" | "movie";
  title: string;
}

export interface SegmentDetectionResult {
  subjectKind: "season" | "movie";
  episodes: number;
  /** Episodes whose audio could not be read; they get chapter segments only. */
  unreadable: number;
  intros: number;
  credits: number;
  fromChapters: number;
}

export interface SegmentService {
  /** Seasons and films never analysed, or analysed by an older detector. */
  listPendingSubjects(): Promise<SegmentSubject[]>;
  detectSeason(
    seasonId: string,
    options?: {
      isCancelled?: () => Promise<boolean>;
      onEpisode?: (completed: number, total: number, title: string) => void;
    },
  ): Promise<SegmentDetectionResult>;
  detectMovie(itemId: string): Promise<SegmentDetectionResult>;
}

export interface CreateSegmentServiceOptions {
  pool: DatabasePool;
  catalogue: Pick<
    CatalogueRepository,
    "listProcessableTitles" | "listChapters" | "listStreams" | "getFileById"
  >;
  mediaRoot: string;
  ffmpegPath?: string;
  findPackagedAudio?: RenditionService["findPackagedAudio"];
  /** Injected in tests: PCM for a window, or null when unreadable. */
  decodeWindow?: (
    input: DecodeInput,
    startSeconds: number,
    seconds: number,
  ) => Promise<Int16Array | null>;
}

export interface DecodeInput {
  path: string;
  map: string;
}

/** Enough to hold ten minutes at the decode rate, with room to spare. */
const MAX_PCM_BYTES = 16 * 1024 * 1024;

function decodeWithFfmpeg(ffmpegPath: string) {
  return (input: DecodeInput, startSeconds: number, seconds: number) =>
    new Promise<Int16Array | null>((resolve) => {
      // Argument array only; a filename can never become a command.
      const child = spawn(
        ffmpegPath,
        [
          "-hide_banner",
          "-nostdin",
          "-v",
          "error",
          "-ss",
          startSeconds.toFixed(3),
          "-t",
          seconds.toFixed(3),
          "-i",
          input.path,
          "-map",
          input.map,
          "-vn",
          "-sn",
          "-dn",
          "-ac",
          "1",
          "-ar",
          String(FINGERPRINT_SAMPLE_RATE),
          "-f",
          "s16le",
          "pipe:1",
        ],
        { stdio: ["ignore", "pipe", "ignore"] },
      );
      if (child.pid !== undefined) {
        try {
          setPriority(child.pid, BACKGROUND_PROCESS_NICENESS);
        } catch {
          // Already gone, or a platform that will not reprioritise.
        }
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      child.stdout?.on("data", (chunk: Buffer) => {
        if (bytes + chunk.length > MAX_PCM_BYTES) {
          child.kill();
          return;
        }
        chunks.push(chunk);
        bytes += chunk.length;
      });
      child.on("error", () => resolve(null));
      child.on("close", (code) => {
        if (code !== 0 || bytes < 2) return resolve(null);
        const buffer = Buffer.concat(chunks, bytes - (bytes % 2));
        // Copied so the view is aligned regardless of the pool buffer's offset.
        const samples = new Int16Array(buffer.length / 2);
        for (let index = 0; index < samples.length; index += 1) {
          samples[index] = buffer.readInt16LE(index * 2);
        }
        resolve(samples);
      });
    });
}

export function createSegmentService({
  pool,
  catalogue,
  mediaRoot,
  ffmpegPath = "ffmpeg",
  findPackagedAudio,
  decodeWindow = decodeWithFfmpeg(ffmpegPath),
}: CreateSegmentServiceOptions): SegmentService {
  const resolvedMediaRoot = path.resolve(mediaRoot);

  /**
   * What to listen to: the source's default audio while the source is on
   * disk, the package's default audio rendition once packaging consumed it.
   */
  async function audioInputFor(
    title: ProcessableTitleRow,
  ): Promise<{ input: DecodeInput; durationSeconds: number } | null> {
    if (!title.mediaFileId || !title.relativePath) return null;
    const sourcePath = path.resolve(
      resolvedMediaRoot,
      ...title.relativePath.split("/"),
    );
    if (
      sourcePath !== resolvedMediaRoot &&
      !sourcePath.startsWith(resolvedMediaRoot + path.sep)
    ) {
      return null;
    }
    const present = await stat(sourcePath).then(
      (stats) => stats.isFile(),
      () => false,
    );
    const durationSeconds = title.durationMs
      ? Number(title.durationMs) / 1_000
      : Number(title.runtimeMs ?? 0) / 1_000;

    if (present && title.probeState === "probed" && durationSeconds > 0) {
      const streams = await catalogue.listStreams(title.mediaFileId);
      const audio = streams.filter((stream) => stream.kind === "audio");
      const chosen = audio.find((stream) => stream.isDefault) ?? audio[0];
      if (!chosen) return null;
      return {
        input: { path: sourcePath, map: `0:${chosen.streamIndex}` },
        durationSeconds,
      };
    }

    if (!present && findPackagedAudio) {
      const file: MediaFileRow | null = await catalogue.getFileById(
        title.mediaFileId,
      );
      if (!file) return null;
      const packaged = await findPackagedAudio({
        mediaId: file.id,
        filePath: sourcePath,
        size: Number(file.sizeBytes),
        mtimeMs: Number(file.mtimeMs),
      });
      if (packaged && packaged.durationSeconds > 0) {
        return {
          /*
           * The playlist rather than the M4A behind it: the same samples,
           * without a seek per fragment before the first one decodes. See
           * `PackagedVideo.playlistPath`.
           */
          input: { path: packaged.playlistPath, map: "0:a:0" },
          durationSeconds: packaged.durationSeconds,
        };
      }
    }
    return null;
  }

  async function windowOf(
    input: DecodeInput,
    startSeconds: number,
    seconds: number,
  ): Promise<AudioWindow | null> {
    if (seconds <= 1) return null;
    const samples = await decodeWindow(input, startSeconds, seconds);
    if (!samples) return null;
    const words = fingerprintPcm(samples);
    return words.length > 0 ? { startSeconds, words } : null;
  }

  async function chaptersOf(itemId: string) {
    return (await catalogue.listChapters(itemId)).map((chapter) => ({
      startMs: Number(chapter.startMs),
      name: chapter.name,
    }));
  }

  /**
   * Replaces what detection and chapters said about these titles, and keeps
   * anything a person entered by hand.
   */
  async function store(
    subjectId: string,
    subjectKind: "season" | "movie",
    itemIds: string[],
    segments: PlannedSegment[],
  ): Promise<void> {
    await withTransaction(pool, async (client) => {
      await client.query(
        `DELETE FROM item_segments
         WHERE item_id = ANY($1::uuid[]) AND source IN ('detected', 'chapter')`,
        [itemIds],
      );
      for (const segment of segments) {
        await client.query(
          `INSERT INTO item_segments
             (id, item_id, segment_type, start_ms, end_ms, source)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (item_id, segment_type, start_ms) DO NOTHING`,
          [
            randomUUID(),
            segment.itemId,
            segment.type,
            segment.startMs,
            segment.endMs,
            segment.source,
          ],
        );
      }
      await client.query(
        `INSERT INTO segment_detection_runs
           (subject_id, subject_kind, detector_version, episode_count, segments_found)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (subject_id) DO UPDATE SET
           subject_kind = EXCLUDED.subject_kind,
           detector_version = EXCLUDED.detector_version,
           episode_count = EXCLUDED.episode_count,
           segments_found = EXCLUDED.segments_found,
           detected_at = now()`,
        [
          subjectId,
          subjectKind,
          SEGMENT_DETECTOR_VERSION,
          itemIds.length,
          segments.length,
        ],
      );
    });
  }

  function summarise(
    subjectKind: "season" | "movie",
    episodes: number,
    unreadable: number,
    segments: PlannedSegment[],
  ): SegmentDetectionResult {
    return {
      subjectKind,
      episodes,
      unreadable,
      intros: segments.filter(
        (segment) => segment.type === "intro" && segment.source === "detected",
      ).length,
      credits: segments.filter(
        (segment) => segment.type === "outro" && segment.source === "detected",
      ).length,
      fromChapters: segments.filter((segment) => segment.source === "chapter")
        .length,
    };
  }

  return {
    listPendingSubjects: async () => {
      const titles = await catalogue.listProcessableTitles();
      const runs = await pool.query<{
        subject_id: string;
        detector_version: number;
        episode_count: number;
      }>(
        `SELECT subject_id, detector_version, episode_count
         FROM segment_detection_runs`,
      );
      const byId = new Map(runs.rows.map((row) => [row.subject_id, row]));
      const playable = titles.filter(
        (title) =>
          title.mediaFileId !== null &&
          title.itemMissingSince === null &&
          title.fileMissingSince === null &&
          (title.probeState === "probed" || title.probeState === "packaged"),
      );

      const seasons = new Map<string, { title: string; count: number }>();
      const subjects: SegmentSubject[] = [];
      for (const title of playable) {
        if (title.kind === "episode" && title.seasonId) {
          const season = seasons.get(title.seasonId);
          if (season) season.count += 1;
          else
            seasons.set(title.seasonId, {
              title: [title.seriesTitle, title.seasonTitle]
                .filter(Boolean)
                .join(" · "),
              count: 1,
            });
        } else if (title.kind === "movie") {
          const run = byId.get(title.itemId);
          if (!run || run.detector_version < SEGMENT_DETECTOR_VERSION) {
            subjects.push({
              subjectId: title.itemId,
              kind: "movie",
              title: title.title,
            });
          }
        }
      }
      for (const [seasonId, season] of seasons) {
        const run = byId.get(seasonId);
        if (
          !run ||
          run.detector_version < SEGMENT_DETECTOR_VERSION ||
          run.episode_count !== season.count
        ) {
          subjects.push({
            subjectId: seasonId,
            kind: "season",
            title: season.title,
          });
        }
      }
      return subjects;
    },

    detectSeason: async (seasonId, options = {}) => {
      const titles = (
        await catalogue.listProcessableTitles({ seasonId, kinds: ["episode"] })
      )
        .filter(
          (title) =>
            title.mediaFileId !== null &&
            title.itemMissingSince === null &&
            title.fileMissingSince === null,
        )
        .sort(
          (a, b) =>
            (a.indexNumber ?? Number.MAX_SAFE_INTEGER) -
              (b.indexNumber ?? Number.MAX_SAFE_INTEGER) ||
            a.sortTitle.localeCompare(b.sortTitle),
        );

      const episodes: EpisodeAudio[] = [];
      let unreadable = 0;
      for (const [index, title] of titles.entries()) {
        if (await options.isCancelled?.()) break;
        options.onEpisode?.(index, titles.length, title.title);
        const chapters = await chaptersOf(title.itemId);
        const audio = await audioInputFor(title);
        if (!audio) {
          unreadable += 1;
          episodes.push({
            itemId: title.itemId,
            durationSeconds:
              Number(title.durationMs ?? title.runtimeMs ?? 0) / 1_000,
            chapters,
            opening: null,
            closing: null,
          });
          continue;
        }
        const closing = closingWindow(audio.durationSeconds);
        const opening = await windowOf(
          audio.input,
          0,
          openingWindowSeconds(audio.durationSeconds),
        );
        const closingAudio = await windowOf(
          audio.input,
          closing.startSeconds,
          closing.seconds,
        );
        if (!opening && !closingAudio) unreadable += 1;
        episodes.push({
          itemId: title.itemId,
          durationSeconds: audio.durationSeconds,
          chapters,
          opening,
          closing: closingAudio,
        });
      }
      options.onEpisode?.(titles.length, titles.length, "");

      const segments = planSeasonSegments(episodes);
      await store(
        seasonId,
        "season",
        episodes.map((episode) => episode.itemId),
        segments,
      );
      return summarise("season", episodes.length, unreadable, segments);
    },

    /**
     * A film has nothing to compare its audio against, so only the chapters
     * it was released with can say where its credits start.
     */
    detectMovie: async (itemId) => {
      const [title] = (
        await catalogue.listProcessableTitles({ kinds: ["movie"] })
      ).filter((candidate) => candidate.itemId === itemId);
      const durationSeconds = title
        ? Number(title.durationMs ?? title.runtimeMs ?? 0) / 1_000
        : 0;
      const segments = segmentsFromChapters(
        itemId,
        await chaptersOf(itemId),
        durationSeconds,
      );
      await store(itemId, "movie", [itemId], segments);
      return summarise("movie", 1, 0, segments);
    },
  };
}
