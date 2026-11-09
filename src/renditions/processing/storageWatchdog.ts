import { readdir, stat } from "node:fs/promises";

/**
 * Noticing that the media volume went away, and that it came back.
 *
 * An external drive that is unplugged mid-encode does not produce one clean
 * error: it produces a stream of I/O failures, one per title, and a queue left
 * to itself will march through every remaining item failing each in turn. By
 * the time anyone looks, the queue is empty and every job is marked failed —
 * none of which had anything wrong with it.
 *
 * Watching the root directly turns that into a single fact the queue can act
 * on: the storage is gone, so stop starting work and wait for it to return.
 */

export interface StorageWatchdogOptions {
  /** Directory that must exist and be readable for work to proceed. */
  mediaRoot: string;
  /**
   * Every root the work needs, not only the media it reads.
   *
   * A job reads its source from the media root and writes its staging and
   * published output elsewhere. Those can be separate volumes, and losing
   * either one is equally fatal to an encode, so all of them are watched.
   */
  additionalRoots?: readonly string[];
  /** How often to look. */
  intervalMs?: number;
  onLost?: () => void | Promise<void>;
  onRestored?: () => void | Promise<void>;
  /**
   * Every poll that did not change availability, with the answer it reached.
   *
   * The transitions alone cannot lift a hold that was raised somewhere else.
   * A process that starts while an incident row says the storage is gone, but
   * finds it present, sees no transition at all: the watchdog assumes present
   * at birth, so present is not news. Without this the hold restored from the
   * record waited for a disappearance and a return that had already happened.
   */
  onSteady?: (available: boolean) => void | Promise<void>;
  /** Injected in tests. */
  check?: (path: string) => Promise<boolean>;
}

export interface StorageWatchdog {
  readonly available: boolean;
  /** The roots being watched, for reporting which storage is missing. */
  readonly roots: readonly string[];
  /** Roots that failed their last check, so a person can be told which. */
  readonly missingRoots: readonly string[];
  /** Checks once, right now, and reports availability. */
  poll(): Promise<boolean>;
  start(): void;
  stop(): void;
}

/**
 * A directory that exists, can be listed, and is still the same volume.
 *
 * An unmounted volume under `/Volumes` usually vanishes entirely, but a
 * half-detached one can linger as an empty directory that throws on access, so
 * the check reads it rather than merely testing for its presence.
 *
 * Presence is not enough on its own either. `/Volumes/Something` is an ordinary
 * directory when nothing is mounted there, and macOS will happily mount a
 * *different* disk at the same path — at which point every path the job holds
 * still resolves, to the wrong storage. So the device the root sits on is
 * remembered the first time it is seen, and a root that comes back on a
 * different device is treated as absent rather than as recovered.
 */
export async function isStorageAvailable(path: string): Promise<boolean> {
  return (await storageIdentity(path)) !== null;
}

/**
 * The device a root currently lives on, or null when it cannot be used.
 *
 * Readability is part of the answer: a stat can succeed on a mount point whose
 * volume has gone while listing it fails.
 */
export async function storageIdentity(path: string): Promise<number | null> {
  try {
    const entry = await stat(path);
    if (!entry.isDirectory()) return null;
    await readdir(path);
    return entry.dev;
  } catch {
    return null;
  }
}

export function createStorageWatchdog({
  mediaRoot,
  additionalRoots = [],
  intervalMs = 5_000,
  onLost,
  onRestored,
  onSteady,
  check = isStorageAvailable,
  identify = storageIdentity,
}: StorageWatchdogOptions & {
  identify?: (path: string) => Promise<number | null>;
}): StorageWatchdog {
  // Duplicates are common — the state root often sits under the media root —
  // and checking a path twice would only slow the poll down.
  const roots = [...new Set([mediaRoot, ...additionalRoots])];
  /*
   * The device each root was on when it was last healthy. A root that returns
   * on a different device is a different volume wearing the same path, which
   * must not be mistaken for the storage coming back.
   */
  const knownDevice = new Map<string, number>();
  let missingRoots: string[] = [];
  // Assumed present until proven otherwise: a watchdog that starts by
  // announcing the storage is missing would pause a healthy queue for one
  // interval every time the server restarts.
  let available = true;
  let timer: ReturnType<typeof setInterval> | undefined;
  let inFlight = false;

  const poll = async (): Promise<boolean> => {
    // A slow volume can take longer to answer than the interval; overlapping
    // checks would report flapping that never happened.
    if (inFlight) return available;
    inFlight = true;
    try {
      const missing: string[] = [];
      for (const root of roots) {
        /*
         * `check` decides whether the root is usable; that is the whole of
         * availability. Identity is a second, narrower question — is this the
         * same storage as last time — and it may only ever *demote* a root
         * that `check` accepted. Letting it decide availability made the
         * watchdog depend on the real filesystem even when a caller had
         * injected its own check, which is both surprising and fragile.
         */
        if (!(await check(root))) {
          /*
           * The media root is required outright — nothing can work without the
           * source. The others are created on demand, so one that has never
           * been seen is not evidence of anything, and treating a
           * not-yet-created work directory as missing storage would hold the
           * queue shut on a perfectly healthy machine. Once such a root has
           * been observed it is expected to stay, and its disappearance counts.
           */
          if (root === mediaRoot || knownDevice.has(root)) missing.push(root);
          continue;
        }
        const device = await identify(root);
        // An identity that cannot be read is not evidence of a swap; `check`
        // has already said the root is usable.
        if (device === null) continue;
        const previous = knownDevice.get(root);
        if (previous === undefined) {
          knownDevice.set(root, device);
        } else if (previous !== device) {
          // Something is mounted here, but not what was here before.
          missing.push(root);
        }
      }
      missingRoots = missing;
      const nowAvailable = missing.length === 0;
      if (nowAvailable !== available) {
        available = nowAvailable;
        await (nowAvailable ? onRestored?.() : onLost?.());
      } else {
        await onSteady?.(available);
      }
      return available;
    } finally {
      inFlight = false;
    }
  };

  return {
    get available() {
      return available;
    },
    get roots() {
      return roots;
    },
    get missingRoots() {
      return missingRoots;
    },
    poll,
    start() {
      if (timer) return;
      // A poll that throws — a root that vanished mid-`stat`, a database that
      // blinked while jobs were being paused — must not reach the process as an
      // unhandled rejection, which would end it. The next tick tries again.
      timer = setInterval(() => {
        void poll().catch((error) => {
          console.warn(
            "[Seyirlik] Storage check failed:",
            error instanceof Error ? error.message : String(error),
          );
        });
      }, intervalMs);
      if (typeof timer.unref === "function") timer.unref();
    },
    stop() {
      if (!timer) return;
      clearInterval(timer);
      timer = undefined;
    },
  };
}
