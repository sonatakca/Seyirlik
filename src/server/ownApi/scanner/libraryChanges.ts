import { watch, type FSWatcher } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type {
  LibraryRepository,
  LibraryWithRoots,
} from "../libraries/libraryRepository";
import type { JobQueue } from "../tasks/jobQueue";
import type { ScannerFileSystem } from "./libraryScan";
import { isIgnoredEntry } from "./nameParser";

const SCAN = "library.scan";
const RELEVANT =
  /\.(mkv|mp4|m4v|avi|mov|webm|ts|m2ts|mpg|mpeg|mp3|m4a|aac|flac|wav|ogg|srt|vtt|ass|ssa|sub|idx|sup|nfo|epub|pdf|cbz|cbr|jpg|jpeg|png|webp|json)$/i;
function visible(relative: string) {
  const parts = relative.replace(/\\/g, "/").split("/");
  return !parts.some(isIgnoredEntry);
}
function within(file: string, root: string) {
  return file === root || file.startsWith(`${root}/`);
}

/** File events are hints; snapshots recover missed network/mount events. */
export function createLibraryChangeMonitor(options: {
  mediaRoot: string;
  libraries: Pick<LibraryRepository, "listAll">;
  queue: Pick<JobQueue, "enqueue" | "findActive" | "get">;
  fileSystem: ScannerFileSystem;
  watch?: typeof watch;
  onError?: (message: string) => void;
}) {
  const dirty = new Map<string, string>();
  const snapshots = new Map<string, Map<string, string>>();
  const watchers = new Map<string, FSWatcher>();
  let flushRunning: Promise<void> | undefined;
  let pollRunning: Promise<void> | undefined;
  let flushTimer: ReturnType<typeof setInterval> | undefined;
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let closed = false;
  const mark = (libraryId: string) => {
    dirty.set(libraryId, randomUUID());
  };
  let lastWarning = 0;
  const error = () => {
    if (Date.now() - lastWarning < 30_000) return;
    lastWarning = Date.now();
    options.onError?.(
      "A library change could not be refreshed; it remains pending.",
    );
  };

  async function flush() {
    if (closed) return;
    if (flushRunning) return flushRunning;
    flushRunning = (async () => {
      for (const [libraryId, token] of dirty) {
        if (closed) break;
        try {
          const active = await options.queue.findActive({
            jobType: SCAN,
            payload: { libraryId },
          });
          // Never collapse a change into a scan that has already read its files.
          if (active?.status === "running") continue;
          if (!active) {
            const id = await options.queue.enqueue({
              jobType: SCAN,
              payload: { libraryId, changeToken: token },
              dedupeKey: `${SCAN}:${libraryId}`,
            });
            const accepted = await options.queue.get(id);
            if (
              !accepted ||
              (accepted.status === "running" &&
                accepted.payload.changeToken !== token)
            )
              continue;
          }
          if (dirty.get(libraryId) === token) dirty.delete(libraryId);
        } catch {
          error();
        }
      }
    })();
    try {
      await flushRunning;
    } finally {
      flushRunning = undefined;
    }
  }

  async function notifyPath(relativePath: string) {
    const relative = relativePath.replace(/\\/g, "/");
    if (!visible(relative)) return;
    for (const library of await options.libraries.listAll()) {
      if (
        library.roots.some((root) =>
          within(relative, root.replace(/\\/g, "/").replace(/\/$/, "")),
        )
      )
        mark(library.id);
    }
    await flush();
  }

  async function snapshot(library: LibraryWithRoots) {
    const files = new Map<string, string>();
    const walk = async (directory: string, depth: number): Promise<void> => {
      if (closed || depth > 12) return;
      for (const entry of await options.fileSystem.readDirectory(directory)) {
        if (closed) return;
        if (isIgnoredEntry(entry.name)) continue;
        const relative = `${directory}/${entry.name}`;
        if (entry.isDirectory) {
          await walk(relative, depth + 1);
        } else if (RELEVANT.test(entry.name)) {
          const stat = await options.fileSystem.statFile(relative);
          let stamp = `${stat.size}:${stat.mtimeMs}`;
          // Retiming often leaves the byte count unchanged, and cloud tools
          // may preserve mtime. Check small subtitle contents as well.
          if (
            /\.(srt|vtt|ass|ssa|sub)$/i.test(entry.name) &&
            stat.size <= 32 * 1024 * 1024
          ) {
            stamp += `:${createHash("sha256")
              .update(await options.fileSystem.readTextFile(relative))
              .digest("hex")}`;
          }
          files.set(relative, stamp);
        }
      }
    };
    for (const root of library.roots) await walk(root, 0);
    return files;
  }

  async function poll() {
    if (closed) return;
    if (pollRunning) return pollRunning;
    pollRunning = (async () => {
      for (const library of await options.libraries.listAll()) {
        if (closed) break;
        for (const root of library.roots) {
          const absolute = path.resolve(options.mediaRoot, root);
          if (!watchers.has(absolute)) {
            try {
              const watcher = (options.watch ?? watch)(
                absolute,
                { recursive: true, persistent: false },
                (_event, name) => {
                  const relative = name?.toString().replace(/\\/g, "/");
                  if (
                    !relative ||
                    (visible(relative) &&
                      (RELEVANT.test(relative) || !path.extname(relative)))
                  )
                    mark(library.id);
                },
              );
              watcher.on("error", () => {
                watcher.close();
                watchers.delete(absolute);
              });
              watchers.set(absolute, watcher);
            } catch {
              /* Cloud mounts may not support watch; snapshots still do. */
            }
          }
        }
        try {
          const next = await snapshot(library);
          const previous = snapshots.get(library.id);
          if (
            !previous ||
            previous.size !== next.size ||
            [...next].some(([file, stamp]) => previous.get(file) !== stamp)
          )
            mark(library.id);
          // Only a complete read replaces the baseline; a missing mount cannot
          // turn into a successful empty snapshot and remove the library.
          snapshots.set(library.id, next);
        } catch {
          error();
        }
      }
      await flush();
    })();
    try {
      await pollRunning;
    } finally {
      pollRunning = undefined;
    }
  }

  return {
    notifyPath,
    flush,
    poll,
    start(watchFiles: boolean) {
      if (flushTimer || closed) return;
      flushTimer = setInterval(() => {
        void flush().catch(error);
      }, 1_000);
      flushTimer.unref();
      if (watchFiles) {
        void poll().catch(error);
        pollTimer = setInterval(() => {
          void poll().catch(error);
        }, 30_000);
        pollTimer.unref();
      }
    },
    async close() {
      closed = true;
      if (flushTimer) clearInterval(flushTimer);
      if (pollTimer) clearInterval(pollTimer);
      for (const watcher of watchers.values()) watcher.close();
      watchers.clear();
      await Promise.allSettled([flushRunning, pollRunning]);
    },
  };
}
