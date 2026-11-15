/**
 * Moving and deleting whole title folders on the Google Drive behind the
 * media mount, on Drive's side.
 *
 * Through the mount, both were wrong for a title of any size. A folder
 * rename goes through WinFsp, which refuses it while anything below holds a
 * handle, and a delete goes file by file: one removal took an hour and
 * forty minutes, and SpongeBob's 8,585 files would have taken most of a day.
 * Drive itself does either in one request — a folder moves by changing its
 * parent, and a whole tree goes to the bin with a single trash call — and
 * rclone's remote control asks Drive to do exactly that.
 *
 * The bin is deliberate: the mount was already started with
 * `--drive-use-trash`, so this keeps what removal has always done, and keeps
 * a removed title recoverable from Drive for thirty days.
 */
import path from "node:path";
import { mountPrefixForAny } from "../processing/driveUpload";

export interface DriveFoldersConfig {
  /** The rclone remote control, e.g. `http://127.0.0.1:5572`. */
  url: string;
  user?: string;
  pass?: string;
  /** Where the remote is mounted, e.g. `D:\`. */
  mountRoot: string;
  /** What is mounted there, e.g. `gdrive:Seyirlik-rescue-2026-10-12`. */
  remote: string;
}

/**
 * Reads `SEYIRLIK_DRIVE_REMOTE`, a JSON object with `url`, `mountRoot`,
 * `remote` and optionally `user`/`pass`. Absent or unreadable: null, and
 * removal works through the filesystem, as it does on a local disk.
 */
export function driveFoldersConfigFromEnvironment(
  environment: Record<string, string | undefined> = process.env,
): DriveFoldersConfig | null {
  const raw = environment.SEYIRLIK_DRIVE_REMOTE?.trim();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<DriveFoldersConfig>;
    if (
      typeof parsed.url !== "string" ||
      typeof parsed.mountRoot !== "string" ||
      typeof parsed.remote !== "string" ||
      !parsed.url ||
      !parsed.mountRoot ||
      !/^[^:/\\]+:/.test(parsed.remote)
    )
      return null;
    return {
      url: parsed.url.replace(/\/+$/, ""),
      mountRoot: parsed.mountRoot,
      remote: parsed.remote.replace(/\/+$/, ""),
      ...(typeof parsed.user === "string" ? { user: parsed.user } : {}),
      ...(typeof parsed.pass === "string" ? { pass: parsed.pass } : {}),
    };
  } catch {
    return null;
  }
}

export interface DriveFolders {
  /**
   * The folder's path under the remote (`/`-separated), or null when it is
   * not on the mount. Never the remote's root or a folder directly under it.
   */
  locate(absolute: string): Promise<string | null>;
  /** Whether a folder exists there, as Drive lists it now. */
  exists(remotePath: string): Promise<boolean>;
  /** One server-side move. Refuses a destination that already exists. */
  move(from: string, to: string): Promise<void>;
  /** The folder and everything in it, to Drive's bin. Absent is done. */
  trash(remotePath: string): Promise<void>;
}

/** A move or trash is one Drive request; listing a folder is a few. */
const CALL_TIMEOUT_MS = 120_000;

export function createDriveFolders(
  config: DriveFoldersConfig,
  fetchImpl: typeof fetch = fetch,
): DriveFolders {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (config.user !== undefined)
    headers.Authorization = `Basic ${Buffer.from(
      `${config.user}:${config.pass ?? ""}`,
    ).toString("base64")}`;

  async function call<T>(
    command: string,
    body: Record<string, unknown>,
  ): Promise<T> {
    const response = await fetchImpl(`${config.url}/${command}`, {
      method: "POST",
      headers,
      // No filter: one set globally on the daemon would turn a server-side
      // folder move into a file-by-file copy that skips what it excludes.
      body: JSON.stringify({ ...body, _filter: {} }),
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
    const text = await response.text();
    if (!response.ok) {
      let reason = text.slice(0, 300);
      try {
        reason = String((JSON.parse(text) as { error?: unknown }).error);
      } catch {
        // Not JSON; the raw text says enough.
      }
      throw new Error(
        `rclone ${command} answered ${response.status}: ${reason}`,
      );
    }
    return (text ? JSON.parse(text) : {}) as T;
  }

  const under = (relative: string) => `${config.remote}/${relative}`;

  function checked(remotePath: string): string {
    const clean = remotePath.replace(/^\/+|\/+$/g, "");
    if (
      clean.split("/").filter(Boolean).length < 2 ||
      clean.split("/").some((segment) => segment === "..")
    )
      throw new Error(`Refusing to touch "${remotePath}" on Drive.`);
    return clean;
  }

  async function exists(remotePath: string): Promise<boolean> {
    const target = checked(remotePath);
    // A fresh listing of the parent, not a cached folder id: an id rclone
    // remembered for a folder since moved would still answer.
    await call("fscache/clear", {});
    const { item } = await call<{ item?: { IsDir?: boolean } | null }>(
      "operations/stat",
      { fs: config.remote, remote: target },
    );
    return Boolean(item);
  }

  return {
    async locate(absolute) {
      const prefix = await mountPrefixForAny(config.mountRoot, absolute);
      if (!prefix) return null;
      const relative = prefix.replace(/\/+$/, "");
      try {
        return checked(relative);
      } catch {
        return null;
      }
    },
    exists,
    async move(from, to) {
      const source = checked(from);
      const destination = checked(to);
      if (path.posix.dirname(source) !== path.posix.dirname(destination))
        throw new Error("A title folder is only ever moved beside itself.");
      if (await exists(destination))
        throw new Error(`"${destination}" already exists on Drive.`);
      await call("sync/move", {
        srcFs: under(source),
        dstFs: under(destination),
        createEmptySrcDirs: true,
        deleteEmptySrcDirs: true,
      });
      // sync/move falls back to moving file by file when Drive refuses the
      // folder move; either way the folder must now be where it was sent.
      if ((await exists(source)) || !(await exists(destination)))
        throw new Error(`Drive did not move "${source}" to "${destination}".`);
    },
    async trash(remotePath) {
      const target = checked(remotePath);
      if (!(await exists(target))) return;
      await call("operations/purge", { fs: config.remote, remote: target });
    },
  };
}
