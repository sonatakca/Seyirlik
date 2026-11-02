import path from "node:path";
import type { DatabasePool } from "../database/databasePool";
import { analyseMediaFile } from "../../../lib/playback-planner/mediaAnalysis";
import type { MediaAnalysis } from "../../../lib/playback-planner/types";
import { toPersistedProbe, type PersistedProbe } from "./probeInventory";

export interface ProbeServiceOptions {
  pool: DatabasePool;
  mediaRoot: string;
  ffprobePath?: string;
  /** Injected in tests so no ffprobe process is spawned. */
  analyse?: (filePath: string, mediaId: string) => Promise<MediaAnalysis>;
  batchSize?: number;
}

export interface ProbeBatchResult {
  probed: number;
  failed: number;
  remaining: number;
}

interface PendingFile {
  id: string;
  item_id: string;
  relative_path: string;
}

/**
 * Reasons an analysis can fail, recognised by exact phrase.
 *
 * FFmpeg reports failures as "<the full input path>: <reason>", and the path
 * routinely contains spaces — so no amount of stripping can reliably separate
 * the two. Matching an allowlist of known reasons and discarding everything
 * else is the only version of this that cannot leak the library layout.
 */
const KNOWN_PROBE_FAILURES = [
  "Invalid data found when processing input",
  "No such file or directory",
  "Permission denied",
  "moov atom not found",
  "Invalid argument",
  "End of file",
  "Protocol not found",
  "Decoder not found",
  "Unknown decoder",
  "Server returned 404 Not Found",
] as const;

export function classifyProbeFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const matched = KNOWN_PROBE_FAILURES.find((reason) =>
    message.includes(reason),
  );
  return matched ?? "The media file could not be analysed.";
}

export function createProbeService({
  pool,
  mediaRoot,
  ffprobePath,
  analyse,
  batchSize = 8,
}: ProbeServiceOptions) {
  const analyseFile =
    analyse ??
    ((filePath: string, mediaId: string) =>
      analyseMediaFile(filePath, mediaId, ffprobePath ?? "ffprobe"));

  async function persist(
    mediaFileId: string,
    itemId: string,
    probe: PersistedProbe,
  ): Promise<void> {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      await client.query(
        `UPDATE media_files
         SET duration_ms = $2,
             bitrate_bps = $3,
             container = COALESCE($4, container),
             probe_state = 'probed',
             probe_error = NULL,
             probed_at = now(),
             updated_at = now()
         WHERE id = $1`,
        [mediaFileId, probe.durationMs, probe.bitrateBps, probe.container],
      );

      // Externally discovered subtitle tracks are owned by the scanner, so a
      // re-probe replaces only the streams that came out of the container.
      await client.query(
        `DELETE FROM media_streams WHERE media_file_id = $1 AND is_external = false`,
        [mediaFileId],
      );

      for (const stream of probe.streams) {
        await client.query(
          `INSERT INTO media_streams (
             media_file_id, stream_index, kind, codec, profile, level, language, title,
             is_default, is_forced, is_external, is_text_subtitle,
             channels, sample_rate, bitrate_bps, width, height, pixel_format,
             frame_rate, video_range, color_transfer, color_primaries, color_space, bit_depth
           ) VALUES (
             $1, $2, $3, $4, $5, $6, $7, $8,
             $9, $10, false, $11,
             $12, $13, $14, $15, $16, $17,
             $18, $19, $20, $21, $22, $23
           )
           ON CONFLICT (media_file_id, stream_index) DO NOTHING`,
          [
            mediaFileId,
            stream.streamIndex,
            stream.kind,
            stream.codec,
            stream.profile,
            stream.level,
            stream.language,
            stream.title,
            stream.isDefault,
            stream.isForced,
            stream.isTextSubtitle,
            stream.channels,
            stream.sampleRate,
            stream.bitrateBps,
            stream.width,
            stream.height,
            stream.pixelFormat,
            stream.frameRate,
            stream.videoRange,
            stream.colorTransfer,
            stream.colorPrimaries,
            stream.colorSpace,
            stream.bitDepth,
          ],
        );
      }

      // Chapters belong to the logical item, and only the primary file defines
      // them; an alternate cut must not overwrite the canonical chapter list.
      const isPrimary = await client.query<{ is_primary: boolean }>(
        `SELECT is_primary FROM media_files WHERE id = $1`,
        [mediaFileId],
      );
      if (isPrimary.rows[0]?.is_primary) {
        await client.query(`DELETE FROM item_chapters WHERE item_id = $1`, [
          itemId,
        ]);
        for (const chapter of probe.chapters) {
          await client.query(
            `INSERT INTO item_chapters (item_id, chapter_index, start_ms, name)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (item_id, chapter_index) DO NOTHING`,
            [itemId, chapter.chapterIndex, chapter.startMs, chapter.name],
          );
        }

        // The item's runtime comes from its primary file — unless the file
        // holds several episodes, when it is the length of none of them.
        if (probe.durationMs !== null) {
          await client.query(
            `UPDATE items SET runtime_ms = $2, updated_at = now()
             WHERE id = $1 AND runtime_ms IS DISTINCT FROM $2
               AND NOT EXISTS (SELECT 1 FROM media_file_episodes WHERE media_file_id = $3)`,
            [itemId, probe.durationMs, mediaFileId],
          );
        }
      }

      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  return {
    /**
     * Probes one batch of pending files. A library-scoped run is used by a
     * library scan so its NFO export cannot race unrelated probe work.
     */
    runBatch: async (libraryId?: string): Promise<ProbeBatchResult> => {
      const pending = await pool.query<PendingFile>(
        `SELECT mf.id, mf.item_id, mf.relative_path
         FROM media_files mf
         JOIN items i ON i.id = mf.item_id
         WHERE mf.probe_state = 'pending'
           AND mf.missing_since IS NULL
           AND ($2::uuid IS NULL OR i.library_id = $2)
         ORDER BY mf.is_primary DESC, mf.created_at
         LIMIT $1`,
        [batchSize, libraryId ?? null],
      );

      let probed = 0;
      let failed = 0;

      for (const file of pending.rows) {
        const absolutePath = path.resolve(
          mediaRoot,
          ...file.relative_path.split("/"),
        );

        try {
          const analysis = await analyseFile(absolutePath, file.id);
          await persist(file.id, file.item_id, toPersistedProbe(analysis));
          probed += 1;
        } catch (error) {
          failed += 1;
          await pool.query(
            `UPDATE media_files
             SET probe_state = 'failed', probe_error = $2, probed_at = now(), updated_at = now()
             WHERE id = $1`,
            [file.id, classifyProbeFailure(error)],
          );
        }
      }

      const remaining = await pool.query<{ total: string }>(
        `SELECT count(*) AS total
         FROM media_files mf
         JOIN items i ON i.id = mf.item_id
         WHERE mf.probe_state = 'pending'
           AND mf.missing_since IS NULL
           AND ($1::uuid IS NULL OR i.library_id = $1)`,
        [libraryId ?? null],
      );

      return {
        probed,
        failed,
        remaining: Number(remaining.rows[0]?.total ?? 0),
      };
    },
  };
}
