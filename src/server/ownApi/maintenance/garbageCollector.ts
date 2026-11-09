/**
 * Removing what Seyirlik left behind and will never read again.
 *
 * Three kinds of leftover, each identified by what owns it rather than by how
 * old it is:
 *
 * - encode workspaces no job can resume from any more — a live job keeps its
 *   own however old it is, a failed or cancelled one only until a later
 *   attempt publishes the title or its retry window passes (see
 *   `processing/workspaceRetention.ts`) — asked of the database again for each
 *   one, immediately before it goes, so a job retried a moment ago keeps its
 *   workspace;
 * - finished downloads nothing will import: a cancelled or superseded
 *   acquisition's, a blocklisted release's, or one whose import completed but
 *   could not remove its source;
 * - temporary folders Seyirlik made for itself and did not get to remove.
 *
 * Age appears only as a race guard. A paused encode's checkpoints may be weeks
 * old and are the most expensive thing on the volume; "older than N days" is
 * exactly the rule that would delete them. Anything this cannot identify as
 * Seyirlik's own is left where it is, because these directories can hold an
 * operator's files too.
 */
import { lstat, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { sweepAbandonedWorkspaces } from "../../../renditions/storageRoles";

/** What a temporary folder made with `mkdtemp("seyirlik-<kind>-")` looks like. */
const TEMP_FOLDER = /^seyirlik-[a-z][a-z-]*-[A-Za-z0-9]{6}$/;

/** A finished download's folder: the acquisition's idempotency key. */
const DOWNLOAD_FOLDER =
  /^seyirlik-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

export type GarbageKind = "workspace" | "download" | "temp";

export interface GarbageRemoval {
  readonly kind: GarbageKind;
  readonly path: string;
  readonly bytes: number;
}

export interface GarbageReport {
  readonly removed: GarbageRemoval[];
  readonly freedBytes: number;
  /** Candidates that could not be removed, and why. Never fatal. */
  readonly errors: string[];
}

export interface GarbageCollectorOptions {
  /** Where encode workspaces live. */
  readonly jobsRoot?: string;
  /** Whether a job still answers to this workspace, asked fresh. */
  readonly isWorkspaceClaimed?: (workspaceId: string) => Promise<boolean>;
  /** The folder finished downloads are left in. */
  readonly downloadRoot?: string;
  /** Whether a finished download is garbage, asked fresh per folder. */
  readonly isDownloadGarbage?: (acquisitionId: string) => Promise<boolean>;
  /** Where Seyirlik's temporary folders are made. */
  readonly tempRoot?: string;
  /** A temporary folder younger than this may still be in use. */
  readonly tempMinimumAgeMs?: number;
  readonly now?: () => number;
}

const DEFAULT_TEMP_MINIMUM_AGE_MS = 2 * 24 * 60 * 60 * 1000;

/** Bytes under a path, never following a link out of it. */
export async function measureTree(target: string): Promise<number> {
  const stats = await lstat(target).catch(() => null);
  if (!stats) return 0;
  if (stats.isSymbolicLink()) return 0;
  if (!stats.isDirectory()) return stats.size;
  let total = 0;
  const entries = await readdir(target, { withFileTypes: true }).catch(
    () => [],
  );
  for (const entry of entries) {
    total += await measureTree(path.join(target, entry.name));
  }
  return total;
}

/**
 * A direct child of `root`, by name, that is a real file or directory.
 *
 * A junction or symbolic link is refused: removing one recursively can reach
 * whatever it points at, which by definition is somewhere else.
 */
async function ownChild(
  root: string,
  name: string,
): Promise<{ path: string; isDirectory: boolean } | null> {
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, name);
  if (path.dirname(target) !== resolvedRoot) return null;
  const stats = await lstat(target).catch(() => null);
  if (!stats || stats.isSymbolicLink()) return null;
  return { path: target, isDirectory: stats.isDirectory() };
}

async function removeOwned(
  kind: GarbageKind,
  target: string,
  removed: GarbageRemoval[],
  errors: string[],
): Promise<void> {
  const bytes = await measureTree(target);
  try {
    await rm(target, { recursive: true, force: true });
    removed.push({ kind, path: target, bytes });
  } catch (error) {
    errors.push(
      `${target}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function collectGarbage(
  options: GarbageCollectorOptions,
): Promise<GarbageReport> {
  const removed: GarbageRemoval[] = [];
  const errors: string[] = [];
  const now = options.now ?? Date.now;

  // Encode workspaces: the existing ownership sweep, asking afresh each time.
  if (options.jobsRoot && options.isWorkspaceClaimed) {
    const claimed = options.isWorkspaceClaimed;
    const sizes = new Map<string, number>();
    for (const entry of await readdir(options.jobsRoot, {
      withFileTypes: true,
    }).catch(() => [])) {
      if (entry.isDirectory()) {
        const target = path.join(options.jobsRoot, entry.name);
        sizes.set(target, await measureTree(target));
      }
    }
    try {
      const sweep = await sweepAbandonedWorkspaces({
        jobsRoot: options.jobsRoot,
        stillClaimed: (workspaceId) => claimed(workspaceId),
        now,
      });
      for (const target of sweep.removed) {
        removed.push({
          kind: "workspace",
          path: target,
          bytes: sizes.get(target) ?? 0,
        });
      }
    } catch (error) {
      errors.push(
        `encode workspaces: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // Finished downloads that nothing will import.
  if (options.downloadRoot && options.isDownloadGarbage) {
    for (const entry of await readdir(options.downloadRoot).catch(() => [])) {
      const match = DOWNLOAD_FOLDER.exec(entry);
      if (!match) continue;
      const child = await ownChild(options.downloadRoot, entry);
      if (!child) continue;
      if (!(await options.isDownloadGarbage(match[1]!))) continue;
      await removeOwned("download", child.path, removed, errors);
    }
  }

  // Seyirlik's own temporary folders, once nothing can still be using them.
  if (options.tempRoot) {
    const minimumAgeMs =
      options.tempMinimumAgeMs ?? DEFAULT_TEMP_MINIMUM_AGE_MS;
    for (const entry of await readdir(options.tempRoot).catch(() => [])) {
      if (!TEMP_FOLDER.test(entry)) continue;
      const child = await ownChild(options.tempRoot, entry);
      if (!child?.isDirectory) continue;
      const stats = await lstat(child.path).catch(() => null);
      if (!stats || Math.max(0, now() - stats.mtimeMs) < minimumAgeMs) {
        continue;
      }
      await removeOwned("temp", child.path, removed, errors);
    }
  }

  return {
    removed,
    freedBytes: removed.reduce((sum, entry) => sum + entry.bytes, 0),
    errors,
  };
}

export const GARBAGE_JOB_TYPES = { collect: "storage.collect" } as const;

/**
 * The collector as a queue job, so it holds a lease like any other work and
 * a tick that arrives while the last pass is still running collapses onto it.
 *
 * Reports only counts — the queue forwards numbers, not paths — and names
 * every path it removed and every one it could not in the worker's log.
 */
export function createGarbageJobHandler(
  options: GarbageCollectorOptions,
  log: Pick<Console, "info" | "warn"> = console,
): (context: {
  reportProgress: (fraction: number, message?: string) => Promise<void>;
}) => Promise<{ itemsRemoved: number; megabytesFreed: number }> {
  return async ({ reportProgress }) => {
    await reportProgress(0, "Looking for Seyirlik's leftovers");
    const report = await collectGarbage(options);
    for (const entry of report.removed) {
      log.info(
        `[Seyirlik] Removed ${entry.kind} leftover ${entry.path} (${entry.bytes} bytes).`,
      );
    }
    for (const error of report.errors) {
      log.warn(`[Seyirlik] Could not remove a leftover: ${error}`);
    }
    return {
      itemsRemoved: report.removed.length,
      megabytesFreed: Math.round(report.freedBytes / 1e6),
    };
  };
}
