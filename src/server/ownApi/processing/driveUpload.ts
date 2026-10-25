/**
 * Following a published package up to Google Drive.
 *
 * The helper laptop publishes into an rclone mount with a write-back cache:
 * the copy into the mount finishes at local-disk speed, the job succeeds, and
 * rclone then uploads the files in the background. Nothing in the job knew
 * about that second half, so a title read as finished for the half hour it was
 * still only on the laptop.
 *
 * The mount's remote-control API says exactly what is left: `vfs/queue` lists
 * every file waiting to upload with its size, and `core/stats` the bytes and
 * rate of each one uploading now. Polling both is all this does. It never
 * waits on the job — the encoder is free for the next title the moment the
 * package is published — and it writes progress onto the job row, which the
 * page already reads.
 */
import { realpath } from "node:fs/promises";
import path from "node:path";
import type { DatabasePool } from "../database/databasePool";
import type { StoredDriveUpload } from "./driveUploadStatus";

export interface DriveRcConfig {
  /** e.g. `http://127.0.0.1:5573`. */
  url: string;
  /** The mount's drive letter or directory, e.g. `D:\`. */
  mountRoot: string;
  user?: string;
  pass?: string;
  /**
   * Whether a source is deleted once its package is verified on Drive. On
   * unless the JSON says `"deleteSource": false`.
   */
  deleteSource: boolean;
}

/**
 * Reads `SEYIRLIK_DRIVE_RC`, a JSON object. Absent or unreadable: no tracking,
 * which is the right behaviour everywhere uploads are not done this way.
 */
export function driveRcConfigFromEnvironment(
  environment: Record<string, string | undefined> = process.env,
): DriveRcConfig | null {
  const raw = environment.SEYIRLIK_DRIVE_RC?.trim();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<DriveRcConfig>;
    if (
      typeof parsed.url !== "string" ||
      typeof parsed.mountRoot !== "string" ||
      !parsed.url ||
      !parsed.mountRoot
    ) {
      return null;
    }
    return {
      url: parsed.url.replace(/\/+$/, ""),
      mountRoot: parsed.mountRoot,
      ...(typeof parsed.user === "string" ? { user: parsed.user } : {}),
      ...(typeof parsed.pass === "string" ? { pass: parsed.pass } : {}),
      deleteSource: parsed.deleteSource !== false,
    };
  } catch {
    return null;
  }
}

export interface RcQueueEntry {
  name: string;
  size: number;
  uploading?: boolean;
  tries?: number;
}

export interface RcTransfer {
  name: string;
  bytes: number;
  size: number;
  speed?: number;
  speedAvg?: number;
}

/** One file as Drive itself holds it, from `operations/list`. */
export interface RcRemoteFile {
  /** Relative to the remote's root, `/`-separated, as queue entries are. */
  Path: string;
  Size: number;
}

export interface DriveRcClient {
  queue(): Promise<RcQueueEntry[]>;
  transferring(): Promise<RcTransfer[]>;
  /**
   * Every file under `directory` (a `/`-separated path under the remote's
   * root, no trailing `/`) as Drive lists it — not as the mount's cache sees
   * it, which is the whole point: a file can be whole in the cache and still
   * absent from Drive.
   */
  listRemote(directory: string): Promise<RcRemoteFile[]>;
}

export function createDriveRcClient(
  config: DriveRcConfig,
  fetchImpl: typeof fetch = fetch,
): DriveRcClient {
  const headers: Record<string, string> = {};
  if (config.user !== undefined) {
    headers.Authorization = `Basic ${Buffer.from(
      `${config.user}:${config.pass ?? ""}`,
    ).toString("base64")}`;
  }
  const call = async <T>(
    command: string,
    body?: Record<string, unknown>,
    timeoutMs = 5_000,
  ): Promise<T> => {
    const response = await fetchImpl(`${config.url}/${command}`, {
      method: "POST",
      headers: body
        ? { ...headers, "Content-Type": "application/json" }
        : headers,
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      throw new Error(`rclone ${command} answered ${response.status}`);
    }
    return (await response.json()) as T;
  };
  return {
    async queue() {
      const result = await call<{ queue?: RcQueueEntry[] }>("vfs/queue");
      return result.queue ?? [];
    },
    async transferring() {
      const result = await call<{ transferring?: RcTransfer[] }>("core/stats");
      return result.transferring ?? [];
    },
    async listRemote(directory) {
      /*
       * The mount's own remote, as rclone names it (`gdrive{6Cm8i}:Folder`
       * when the mount was given flags of its own). Asked rather than
       * configured, so it cannot drift from what is actually mounted. More
       * than one would make "the" remote a guess, and a guess is not what a
       * deletion may rest on.
       */
      const { vfses } = await call<{ vfses?: string[] }>("vfs/list", {});
      if (!vfses || vfses.length !== 1) {
        throw new Error(
          `rclone serves ${vfses?.length ?? 0} mounts, so the remote to check cannot be told apart.`,
        );
      }
      const result = await call<{ list?: RcRemoteFile[] }>(
        "operations/list",
        {
          fs: vfses[0],
          remote: directory,
          opt: {
            recurse: true,
            filesOnly: true,
            noModTime: true,
            noMimeType: true,
          },
        },
        // A Drive listing walks one request per folder.
        60_000,
      );
      return result.list ?? [];
    },
  };
}

/**
 * The title folder's path under the mount, as rclone names queue entries:
 * `/`-separated, relative to the remote root, with a trailing `/`. Null when
 * the folder is not under the mount, which is when there is nothing to track.
 */
export function mountPrefixFor(
  mountRoot: string,
  directory: string,
): string | null {
  const windows = /^[A-Za-z]:/.test(mountRoot) || mountRoot.includes("\\");
  const paths = windows ? path.win32 : path.posix;
  const relative = paths.relative(mountRoot, directory);
  if (
    !relative ||
    relative === ".." ||
    relative.startsWith(`..${paths.sep}`) ||
    paths.isAbsolute(relative)
  ) {
    return null;
  }
  return `${relative.split(paths.sep).join("/")}/`;
}

/**
 * The same, trying each name the mount goes by.
 *
 * In network mode a realpath under `D:\` comes back as the volume's UNC
 * name (`\\seyirlik\drive\…`), and since the library root is resolved that
 * way every job queued by the import sweep carries a UNC title root. Compared
 * against `D:\` alone those matched nothing, and their uploads went untracked.
 */
export async function mountPrefixForAny(
  mountRoot: string,
  directory: string,
  resolve: (target: string) => Promise<string> = realpath,
): Promise<string | null> {
  const direct = mountPrefixFor(mountRoot, directory);
  if (direct) return direct;
  const resolved = await resolve(mountRoot).catch(() => null);
  return resolved && resolved !== mountRoot
    ? mountPrefixFor(resolved, directory)
    : null;
}

/** How long new queue entries are still taken as this package's own. */
export const MEMBERSHIP_WINDOW_MS = 30_000;
/** Empty reads in a row before a package counts as uploaded. */
export const EMPTY_READS_TO_FINISH = 2;
/**
 * Never finished sooner than this after tracking began. rclone queues a file
 * when it is closed and holds it for its write-back delay (10 s on the
 * helper); this is that delay with room to spare.
 */
export const MINIMUM_TRACKING_MS = 15_000;

/**
 * One reading of the queue, applied to one package.
 *
 * Pure, so the arithmetic can be tested against recorded rclone output.
 * `members` is fixed once the membership window closes: a neighbour published
 * into the same season folder later must not keep this episode "uploading".
 */
export function nextDriveUpload(
  previous: StoredDriveUpload,
  queue: readonly RcQueueEntry[],
  transfers: readonly RcTransfer[],
  nowMs: number,
  emptyReads: number,
): { upload: StoredDriveUpload; emptyReads: number } {
  const inWindow = nowMs - previous.startedAtMs < MEMBERSHIP_WINDOW_MS;
  const known = previous.members?.length ? previous.members : null;
  // A folder's prefix ends in `/` and takes in what is under it; a file's is
  // the file itself.
  const underPrefix = (name: string) =>
    previous.prefix.endsWith("/")
      ? name.startsWith(previous.prefix)
      : name === previous.prefix;
  const mine = queue.filter((entry) =>
    known && !inWindow ? known.includes(entry.name) : underPrefix(entry.name),
  );
  const members =
    known && !inWindow
      ? known
      : [...new Set([...(known ?? []), ...mine.map((entry) => entry.name)])];

  const transferBy = new Map(transfers.map((t) => [t.name, t]));
  let pendingBytes = 0;
  let bytesPerSecond = 0;
  let uploading = 0;
  let retries = 0;
  for (const entry of mine) {
    const transfer = transferBy.get(entry.name);
    const sent = transfer ? Math.min(entry.size, transfer.bytes) : 0;
    pendingBytes += Math.max(0, entry.size - sent);
    if (transfer) {
      uploading += 1;
      bytesPerSecond += transfer.speed ?? transfer.speedAvg ?? 0;
    }
    retries = Math.max(retries, (entry.tries ?? 0) - 1);
  }
  const queuedBytes = mine.reduce((sum, entry) => sum + entry.size, 0);
  const totalBytes = Math.max(previous.totalBytes, queuedBytes);
  const uploadedBytes = Math.min(
    totalBytes,
    Math.max(previous.uploadedBytes, totalBytes - pendingBytes),
  );

  const nextEmpty = mine.length === 0 ? emptyReads + 1 : 0;
  const finished =
    nextEmpty >= EMPTY_READS_TO_FINISH &&
    nowMs - previous.startedAtMs >= MINIMUM_TRACKING_MS;

  const upload: StoredDriveUpload = {
    prefix: previous.prefix,
    members,
    state: finished ? "uploaded" : "uploading",
    totalBytes,
    uploadedBytes: finished ? totalBytes : uploadedBytes,
    filesPending: mine.length,
    filesUploading: uploading,
    startedAtMs: previous.startedAtMs,
    updatedAtMs: nowMs,
    ...(previous.deleteSource ? { deleteSource: true } : {}),
    ...(bytesPerSecond > 0 && !finished
      ? {
          bytesPerSecond,
          etaSeconds: Math.round(pendingBytes / bytesPerSecond),
        }
      : {}),
    ...(retries > 0 && !finished ? { retries } : {}),
    ...(finished ? { finishedAtMs: nowMs } : {}),
  };
  return { upload, emptyReads: nextEmpty };
}

export interface DriveUploadStore {
  write(processingJobId: string, upload: StoredDriveUpload): Promise<void>;
  /** Uploads a stopped helper left unfinished, to pick up again. */
  listUnfinished(): Promise<
    Array<{ processingJobId: string; upload: StoredDriveUpload }>
  >;
}

export function createDatabaseDriveUploadStore(
  pool: DatabasePool,
): DriveUploadStore {
  return {
    async write(processingJobId, upload) {
      // Not through the job store's update: that moves `updated_at`, and a
      // finished job's row should not look freshly touched every two seconds.
      await pool.query(
        `UPDATE processing_jobs SET drive_upload = $2::jsonb WHERE id = $1`,
        [processingJobId, JSON.stringify(upload)],
      );
    },
    async listUnfinished() {
      const result = await pool.query<{
        id: string;
        drive_upload: StoredDriveUpload;
      }>(
        `SELECT id, drive_upload FROM processing_jobs
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
 * A file's path under the mount, as rclone names its queue entry: the same as
 * `mountPrefixForAny` without the trailing `/`, so it matches the file itself
 * and nothing beside it.
 */
export async function mountPathForAny(
  mountRoot: string,
  file: string,
  resolve: (target: string) => Promise<string> = realpath,
): Promise<string | null> {
  const prefix = await mountPrefixForAny(mountRoot, file, resolve);
  return prefix ? prefix.replace(/\/$/, "") : null;
}

/**
 * The tracker is keyed by the row its store writes to: a processing job, or an
 * imported file for the importer's own tracker. The field keeps the name it was
 * born with.
 */
export interface DriveUploadTracker {
  /**
   * Starts following a package just published into `directory`, or one file
   * just written to `file`. Resolves false, and does nothing, when it is not
   * on the mount.
   */
  track(
    input: {
      processingJobId: string;
      totalBytes: number;
    } & ({ directory: string } | { file: string }),
  ): Promise<boolean>;
  /** Picks up uploads a previous run of this worker left unfinished. */
  resume(): Promise<number>;
  stop(): void;
}

export const DRIVE_UPLOAD_POLL_MS = 2_000;
/** Longest gap between writes while nothing changes. */
export const DRIVE_UPLOAD_HEARTBEAT_MS = 10_000;

export function createDriveUploadTracker({
  config,
  client,
  store,
  now = Date.now,
  pollMs = DRIVE_UPLOAD_POLL_MS,
  resolvePath = realpath,
  onFinished,
}: {
  config: DriveRcConfig;
  client: DriveRcClient;
  store: DriveUploadStore;
  now?: () => number;
  pollMs?: number;
  resolvePath?: (target: string) => Promise<string>;
  onFinished?: (processingJobId: string, upload: StoredDriveUpload) => void;
}): DriveUploadTracker {
  const tracked = new Map<
    string,
    {
      upload: StoredDriveUpload;
      emptyReads: number;
      lastWritten: string;
      lastWriteMs: number;
    }
  >();
  let timer: ReturnType<typeof setInterval> | null = null;
  let polling = false;

  const poll = async (): Promise<void> => {
    if (polling || tracked.size === 0) return;
    polling = true;
    try {
      let queue: RcQueueEntry[];
      let transfers: RcTransfer[];
      try {
        [queue, transfers] = await Promise.all([
          client.queue(),
          client.transferring(),
        ]);
      } catch {
        // The mount is restarting or gone. The rows keep their last reading,
        // and its age is what tells the page nobody is watching.
        return;
      }
      const at = now();
      for (const [id, entry] of tracked) {
        const next = nextDriveUpload(
          entry.upload,
          queue,
          transfers,
          at,
          entry.emptyReads,
        );
        entry.upload = next.upload;
        entry.emptyReads = next.emptyReads;
        const { updatedAtMs: _at, ...comparable } = next.upload;
        const signature = JSON.stringify(comparable);
        // An unchanged reading is still written now and then, so the age of
        // `updatedAtMs` keeps meaning "the tracker is alive".
        if (
          signature !== entry.lastWritten ||
          at - entry.lastWriteMs >= DRIVE_UPLOAD_HEARTBEAT_MS
        ) {
          entry.lastWritten = signature;
          entry.lastWriteMs = at;
          await store.write(id, next.upload).catch(() => undefined);
        }
        if (next.upload.state === "uploaded") {
          tracked.delete(id);
          onFinished?.(id, next.upload);
        }
      }
    } finally {
      polling = false;
      if (tracked.size === 0 && timer) {
        clearInterval(timer);
        timer = null;
      }
    }
  };

  const ensureTimer = () => {
    if (timer) return;
    timer = setInterval(() => void poll(), pollMs);
    timer.unref?.();
  };

  const add = (processingJobId: string, upload: StoredDriveUpload) => {
    tracked.set(processingJobId, {
      upload,
      emptyReads: 0,
      lastWritten: "",
      lastWriteMs: 0,
    });
    ensureTimer();
  };

  return {
    async track(input) {
      const { processingJobId, totalBytes } = input;
      const prefix =
        "file" in input
          ? await mountPathForAny(config.mountRoot, input.file, resolvePath)
          : await mountPrefixForAny(
              config.mountRoot,
              input.directory,
              resolvePath,
            );
      if (!prefix) return false;
      const at = now();
      const upload: StoredDriveUpload = {
        prefix,
        ...(config.deleteSource ? { deleteSource: true } : {}),
        state: "uploading",
        totalBytes,
        uploadedBytes: 0,
        filesPending: 0,
        filesUploading: 0,
        startedAtMs: at,
        updatedAtMs: at,
      };
      await store.write(processingJobId, upload).catch(() => undefined);
      add(processingJobId, upload);
      void poll();
      return true;
    },
    async resume() {
      const unfinished = await store.listUnfinished().catch(() => []);
      for (const { processingJobId, upload } of unfinished) {
        if (!tracked.has(processingJobId) && upload?.prefix) {
          add(processingJobId, upload);
        }
      }
      return unfinished.length;
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
      tracked.clear();
    },
  };
}
