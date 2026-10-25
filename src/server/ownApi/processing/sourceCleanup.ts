/**
 * Removing a source once its package is safely on Google Drive.
 *
 * The helper laptop encodes from a source on the Drive mount and publishes the
 * package back into it. Until now the source then stayed on Drive for good,
 * unless someone pressed "Remove source" title by title. This presses it for
 * them, at the one moment it is safe to: after the upload tracker has watched
 * every file of the package leave the mount's queue.
 *
 * An empty queue is not taken as proof. The queue says what the mount still
 * means to send, and a file can be absent from it because it was never queued
 * at all. So Drive itself is listed, and every file the manifest names must be
 * there at the size the manifest records. Only then are the ordinary checks of
 * the button run — no job still reading the file, a whole package on the
 * mount, the source still the bytes the package was built from, today's ladder
 * satisfied — and only they unlink anything.
 *
 * The package on Drive is not enough on its own either. Playback finds it only
 * through the rendition registry, so a source whose registry entry is missing
 * or not ready is the only way that title plays. On 2026-10-20 Lilyhammer
 * S01E01 lost both: its registry save never reached Drive, its source was then
 * removed, and playback fell back to transcoding a file that was gone. The
 * entry playback would use must be there, ready, before anything is unlinked.
 *
 * A refusal is recorded and final; the operator can still remove the source by
 * hand. A failure to *ask* — rclone restarting, Drive unreachable, the volume
 * guarded — records nothing, and the next start of the worker asks again.
 */
import { stat } from "node:fs/promises";
import path from "node:path";
import type { DatabasePool } from "../database/databasePool";
import { OwnApiError } from "../ownApiHandler";
import {
  PUBLICATION_POINTER,
  resolvePublishedTitleRoot,
} from "../../../renditions/adaptive/publishedRoot";
import {
  readTitlePackageManifest,
  type TitlePackageManifest,
} from "../../../renditions/adaptive/publishTitle";
import {
  TITLE_PACKAGE_DIRECTORY,
  TITLE_PACKAGE_MANIFEST,
} from "../../../renditions/adaptive/titleLayout";
import {
  registryGapForPlayback,
  type RenditionRegistryStore,
} from "../../../renditions/registry";
import { mountPrefixForAny, type DriveRcClient } from "./driveUpload";
import type {
  SourceCleanupOutcome,
  StoredDriveUpload,
} from "./driveUploadStatus";
import type { ProcessingJobStore } from "./jobStore";
import {
  describeMissingPackageAssets,
  missingPackageAssets,
} from "./packageAssets";
import type { ProcessingEnqueuer } from "./processingEnqueue";

export interface SourceCleanupStore {
  /** Records the outcome beside the upload, leaving the upload untouched. */
  record(processingJobId: string, outcome: SourceCleanupOutcome): Promise<void>;
  /** Uploads that finished, asked for a deletion, and have no outcome yet. */
  listAwaiting(): Promise<string[]>;
}

export function createDatabaseSourceCleanupStore(
  pool: DatabasePool,
): SourceCleanupStore {
  return {
    async record(processingJobId, outcome) {
      // A merge, not a rewrite: the upload's own reading stays as it was, and
      // `updated_at` is left alone for the same reason the tracker leaves it.
      await pool.query(
        `UPDATE processing_jobs
            SET drive_upload = drive_upload || jsonb_build_object('source', $2::jsonb)
          WHERE id = $1 AND drive_upload IS NOT NULL`,
        [processingJobId, JSON.stringify(outcome)],
      );
    },
    async listAwaiting() {
      const result = await pool.query<{ id: string }>(
        `SELECT id FROM processing_jobs
          WHERE drive_upload->>'state' = 'uploaded'
            AND drive_upload->>'deleteSource' = 'true'
            AND NOT (drive_upload ? 'source')
          ORDER BY finished_at`,
      );
      return result.rows.map((row) => row.id);
    },
  };
}

/**
 * What Drive is missing of a published package: every manifest file, at its
 * recorded size, plus the manifest itself and any publication pointer. Throws
 * when Drive could not be asked, which is not the same as Drive lacking files.
 */
export async function packageGapsOnDrive({
  client,
  mountRoot,
  titleRoot,
  manifest,
  resolvePath,
}: {
  client: Pick<DriveRcClient, "listRemote">;
  mountRoot: string;
  titleRoot: string;
  manifest: TitlePackageManifest;
  resolvePath?: (target: string) => Promise<string>;
}): Promise<string[]> {
  const publishedRoot = await resolvePublishedTitleRoot(titleRoot);
  const prefix = await mountPrefixForAny(mountRoot, titleRoot, resolvePath);
  const publishedPrefix = await mountPrefixForAny(
    mountRoot,
    publishedRoot,
    resolvePath,
  );
  if (!prefix || !publishedPrefix) {
    throw new Error(`${titleRoot} is not on the Drive mount.`);
  }

  const onDrive = new Map<string, number>();
  for (const file of await client.listRemote(prefix.slice(0, -1))) {
    onDrive.set(file.Path, file.Size);
  }
  const remoteSize = (relativeToTitle: string) =>
    onDrive.get(`${prefix}${relativeToTitle}`);

  const gaps: string[] = [];
  const missing = await missingPackageAssets(
    publishedRoot,
    manifest,
    async (absolutePath) =>
      onDrive.get(
        `${publishedPrefix}${path
          .relative(publishedRoot, absolutePath)
          .split(path.sep)
          .join("/")}`,
      ),
  );
  if (missing.length > 0) {
    gaps.push(describeMissingPackageAssets(missing, "on Drive"));
  }

  // The files that make the rest findable are not in the manifest's list.
  const anchors = [
    path.join(publishedRoot, TITLE_PACKAGE_DIRECTORY, TITLE_PACKAGE_MANIFEST),
    ...(publishedRoot === titleRoot
      ? []
      : [path.join(titleRoot, ...PUBLICATION_POINTER.split("/"))]),
  ];
  for (const anchor of anchors) {
    const relative = path.relative(titleRoot, anchor).split(path.sep).join("/");
    const local = await stat(anchor).then(
      (stats) => stats.size,
      () => undefined,
    );
    const remote = remoteSize(relative);
    if (local === undefined || remote !== local) {
      gaps.push(
        remote === undefined
          ? `${relative} is not on Drive`
          : `${relative} is ${remote} bytes on Drive and ${local ?? "absent"} here`,
      );
    }
  }
  return gaps;
}

export interface SourceCleanup {
  /** Decides one finished upload's source. Never throws. */
  afterUpload(
    processingJobId: string,
    upload: StoredDriveUpload,
  ): Promise<void>;
  /** Decides every finished upload a previous run left undecided. */
  resume(): Promise<void>;
}

export function createSourceCleanup({
  jobs,
  enqueuer,
  store,
  registry,
  verifyOnDrive,
  mayDelete,
  now = Date.now,
  log = (message) => console.warn(`[Seyirlik] ${message}`),
}: {
  jobs: Pick<ProcessingJobStore, "get" | "appendEvent">;
  enqueuer: Pick<
    ProcessingEnqueuer,
    "locateSource" | "titleRootFor" | "removeSource"
  >;
  store: SourceCleanupStore;
  /** The registry playback reads, so its entry is checked before deleting. */
  registry: Pick<RenditionRegistryStore, "read">;
  verifyOnDrive: (
    titleRoot: string,
    manifest: TitlePackageManifest,
  ) => Promise<string[]>;
  /** False while the media volume is gone or guarded: decide nothing then. */
  mayDelete: () => boolean | Promise<boolean>;
  now?: () => number;
  log?: (message: string) => void;
}): SourceCleanup {
  const inFlight = new Set<string>();

  const decide = async (
    processingJobId: string,
  ): Promise<SourceCleanupOutcome | null> => {
    const kept = (reason: string): SourceCleanupOutcome => ({
      state: "kept",
      atMs: now(),
      reason,
    });

    const job = await jobs.get(processingJobId);
    if (!job || job.state !== "succeeded" || !job.publishedVersion) {
      return kept("The job is no longer a finished publication.");
    }
    if (!(await mayDelete())) return null;

    const located = await enqueuer.locateSource(job.itemId, job.mediaFileId);
    const titleRoot = await enqueuer.titleRootFor(
      job.itemId,
      located.absolutePath,
    );
    const manifest = await readTitlePackageManifest(titleRoot);
    if (!manifest) {
      return kept("The package manifest could not be read.");
    }
    if (manifest.sourceFingerprint !== job.sourceFingerprint) {
      return kept(
        "The package in the folder is no longer the one this job published.",
      );
    }

    // Throws when Drive cannot be asked: undecided, asked again next start.
    const gaps = await verifyOnDrive(titleRoot, manifest);
    if (gaps.length > 0) {
      return kept(`Drive does not hold the whole package: ${gaps.join("; ")}.`);
    }

    /*
     * Last, closest to the unlink: the entry playback will serve this title
     * from. Missing or not ready is not a refusal but a reason to wait, so it
     * throws and the next worker start asks again; until then the source
     * stays, and the title plays from it.
     */
    const gap = registryGapForPlayback(await registry.read(), {
      relativePath: located.file.relativePath,
      size: Number(located.file.sizeBytes),
      mtimeMs: Number(located.file.mtimeMs),
      sourceFingerprint: job.sourceFingerprint,
    });
    if (gap) throw new Error(`Playback cannot find this package yet: ${gap}.`);

    try {
      const removal = await enqueuer.removeSource(job.itemId, job.mediaFileId, {
        expectedFingerprint: job.sourceFingerprint,
      });
      return removal.deleted
        ? { state: "deleted", atMs: now(), freedBytes: removal.freedBytes }
        : { state: "absent", atMs: now() };
    } catch (error) {
      // A refusal is a decision. Anything else — an I/O error, a probe that
      // could not run — is not, and leaves the source for the next attempt.
      if (error instanceof OwnApiError) return kept(error.message);
      throw error;
    }
  };

  const settle = async (processingJobId: string): Promise<void> => {
    if (inFlight.has(processingJobId)) return;
    inFlight.add(processingJobId);
    try {
      const outcome = await decide(processingJobId);
      if (!outcome) return;
      await store.record(processingJobId, outcome);
      await jobs
        .appendEvent({
          processingJobId,
          stage: "complete",
          ...(outcome.state === "kept" ? { level: "warning" as const } : {}),
          message:
            outcome.state === "deleted"
              ? `Source removed after Drive was checked to hold the whole package (${(outcome.freedBytes / 1e9).toFixed(1)} GB freed).`
              : outcome.state === "absent"
                ? "The package is on Drive, and its source was already gone."
                : `Source kept: ${outcome.reason}`,
        })
        .catch(() => undefined);
    } catch (error) {
      log(
        `Could not decide the source of processing job ${processingJobId}; it is kept and checked again next start: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    } finally {
      inFlight.delete(processingJobId);
    }
  };

  return {
    async afterUpload(processingJobId, upload) {
      if (upload.deleteSource && !upload.source) await settle(processingJobId);
    },
    async resume() {
      const awaiting = await store.listAwaiting().catch(() => []);
      // One at a time: each one probes a source over the mount.
      for (const processingJobId of awaiting) await settle(processingJobId);
    },
  };
}
