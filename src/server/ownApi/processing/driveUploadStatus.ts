/**
 * What the page is told about a package's upload to Google Drive.
 *
 * Pure data, imported as a type by the browser. The machine that encodes
 * publishes into a Drive mount, and the mount uploads in the background after
 * the job has already succeeded — for a full ladder that is tens of gigabytes
 * and tens of minutes during which the title is "done" here and still absent
 * from Drive, which is where the server plays it from.
 */
export interface DriveUploadStatus {
  /**
   * `uploading` until the mount's queue holds nothing of this package;
   * `uploaded` after. There is no failed state: the mount retries on its own,
   * and a stopped helper resumes the queue the next time it starts.
   */
  state: "uploading" | "uploaded";
  /** Bytes of this package to upload, as known when tracking began. */
  totalBytes: number;
  /** Bytes already on Drive: the total less what is still queued. */
  uploadedBytes: number;
  /** Files of this package still waiting or uploading. */
  filesPending: number;
  /** Of those, how many are uploading right now. */
  filesUploading: number;
  /** The mount's own measured rate for this package's transfers. */
  bytesPerSecond?: number;
  etaSeconds?: number;
  /** Highest retry count among the pending files; absent when none. */
  retries?: number;
  startedAtMs: number;
  /** When the tracker last read the queue. A stale value: the helper stopped. */
  updatedAtMs: number;
  finishedAtMs?: number;
}

/** What is stored: the status plus what the tracker needs to resume. */
export interface StoredDriveUpload extends DriveUploadStatus {
  /**
   * Path of the title under the mount root, `/`-separated, trailing `/`; for
   * one imported file, that file's own path with no trailing `/`.
   */
  prefix: string;
  /** Queue entries that belong to this package, fixed after the first reads. */
  members?: string[];
  /**
   * Set when tracking began on a helper that deletes sources: once uploaded,
   * this package's source is removed if Drive is verified to hold all of it.
   * Uploads tracked before that existed never carry it, so no source is ever
   * removed after the fact.
   */
  deleteSource?: boolean;
  /** What became of the source, once decided. Absent: not decided yet. */
  source?: SourceCleanupOutcome;
}

/**
 * The source's fate after its package reached Drive. `kept` is final: a
 * refusal names what made the source still needed, and the operator decides
 * from there.
 */
export type SourceCleanupOutcome =
  | { state: "deleted"; atMs: number; freedBytes: number }
  | { state: "absent"; atMs: number }
  | { state: "kept"; atMs: number; reason: string };

/** The status without the server-only fields, for the API. */
export function publicDriveUpload(
  stored: Record<string, unknown> | null | undefined,
): DriveUploadStatus | null {
  if (!stored || typeof stored !== "object") return null;
  const {
    prefix: _prefix,
    members: _members,
    deleteSource: _deleteSource,
    source: _source,
    ...status
  } = stored as unknown as StoredDriveUpload;
  return status;
}

/**
 * Several files' uploads read as one, for an import that brought in a whole
 * season: bytes and files add up, the rate is shared, and it is uploaded only
 * when every file is. Null when none of them is uploaded this way.
 */
export function combineDriveUploads(
  uploads: ReadonlyArray<DriveUploadStatus | null | undefined>,
): DriveUploadStatus | null {
  const present = uploads.filter(
    (upload): upload is DriveUploadStatus => !!upload,
  );
  if (present.length <= 1) return present[0] ?? null;
  const sum = (pick: (upload: DriveUploadStatus) => number | undefined) =>
    present.reduce((total, upload) => total + (pick(upload) ?? 0), 0);
  const uploading = present.filter((upload) => upload.state === "uploading");
  const done = uploading.length === 0;
  const totalBytes = sum((upload) => upload.totalBytes);
  const uploadedBytes = sum((upload) => upload.uploadedBytes);
  const bytesPerSecond = uploading.reduce(
    (total, upload) => total + (upload.bytesPerSecond ?? 0),
    0,
  );
  const retries = Math.max(
    0,
    ...uploading.map((upload) => upload.retries ?? 0),
  );
  return {
    state: done ? "uploaded" : "uploading",
    totalBytes,
    uploadedBytes,
    filesPending: sum((upload) => upload.filesPending),
    filesUploading: sum((upload) => upload.filesUploading),
    ...(bytesPerSecond > 0
      ? {
          bytesPerSecond,
          etaSeconds: Math.round(
            Math.max(0, totalBytes - uploadedBytes) / bytesPerSecond,
          ),
        }
      : {}),
    ...(retries > 0 ? { retries } : {}),
    startedAtMs: Math.min(...present.map((upload) => upload.startedAtMs)),
    // While uploading, the oldest reading: one file nobody is watching shows.
    updatedAtMs: done
      ? Math.max(...present.map((upload) => upload.updatedAtMs))
      : Math.min(...uploading.map((upload) => upload.updatedAtMs)),
    ...(done
      ? {
          finishedAtMs: Math.max(
            ...present.map(
              (upload) => upload.finishedAtMs ?? upload.updatedAtMs,
            ),
          ),
        }
      : {}),
  };
}
