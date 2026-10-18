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
  /** Path of the title under the mount root, `/`-separated, trailing `/`. */
  prefix: string;
  /** Queue entries that belong to this package, fixed after the first reads. */
  members?: string[];
}

/** The status without the server-only fields, for the API. */
export function publicDriveUpload(
  stored: Record<string, unknown> | null | undefined,
): DriveUploadStatus | null {
  if (!stored || typeof stored !== "object") return null;
  const {
    prefix: _prefix,
    members: _members,
    ...status
  } = stored as unknown as StoredDriveUpload;
  return status;
}
