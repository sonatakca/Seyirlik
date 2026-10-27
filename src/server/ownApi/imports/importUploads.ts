/**
 * Following an imported file up to Google Drive.
 *
 * The helper imports into the Drive mount, whose write-back cache takes the
 * copy at local-disk speed and uploads it afterwards. The import is complete
 * the moment the copy is, yet the server reads the library from Drive, so for
 * the half hour a remux takes to upload the episode is still missing there and
 * nothing processes it. The same tracker that follows a published package
 * follows each imported file, and writes onto the file's row.
 */
import path from "node:path";
import type { DatabasePool } from "../database/databasePool";
import type {
  DriveUploadStore,
  DriveUploadTracker,
} from "../processing/driveUpload";
import type { StoredDriveUpload } from "../processing/driveUploadStatus";
import type { ImportFileRecord, ImportRecord } from "./importRepository";

export function createDatabaseImportUploadStore(
  pool: DatabasePool,
): DriveUploadStore {
  return {
    async write(importFileId, upload) {
      // Not through the repository: that moves `updated_at`, which says when
      // the import last changed, not when its upload was last read.
      await pool.query(
        `UPDATE import_files SET drive_upload = $2::jsonb WHERE id = $1`,
        [importFileId, JSON.stringify(upload)],
      );
    },
    async listUnfinished() {
      const result = await pool.query<{
        id: string;
        drive_upload: StoredDriveUpload;
      }>(
        `SELECT id, drive_upload FROM import_files
          WHERE drive_upload->>'state' = 'uploading'`,
      );
      return result.rows.map((row) => ({
        processingJobId: row.id,
        upload: row.drive_upload,
      }));
    },
  };
}

/**
 * Starts following every media file an import put in the library. Subtitles
 * are kilobytes and say nothing about when the episode reaches Drive.
 */
export async function followImportUploads(
  tracker: DriveUploadTracker,
  record: Pick<ImportRecord, "libraryRoot">,
  files: readonly ImportFileRecord[],
): Promise<number> {
  let followed = 0;
  for (const file of files) {
    if (file.role !== "media" || file.state !== "committed") continue;
    if (!file.destinationRelative) continue;
    const destination = path.resolve(
      record.libraryRoot,
      ...file.destinationRelative.split("/"),
    );
    const tracking = await tracker
      .track({
        processingJobId: file.id,
        file: destination,
        totalBytes: file.sizeBytes ?? 0,
      })
      .catch(() => false);
    if (tracking) followed += 1;
  }
  return followed;
}
