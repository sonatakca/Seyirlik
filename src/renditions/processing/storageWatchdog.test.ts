import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createStorageWatchdog,
  isStorageAvailable,
  storageIdentity,
} from "./storageWatchdog";

/**
 * Noticing that the media volume went away, and that the *same* one came back.
 *
 * The incident: an external drive was unplugged mid-encode. Every path the job
 * held stopped resolving, and without a single fact to act on the queue would
 * have marched through the remaining titles failing each in turn.
 */

describe("deciding whether the storage is usable", () => {
  it("accepts a readable directory and reports its device", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "seyirlik-storage-"));
    await expect(isStorageAvailable(root)).resolves.toBe(true);
    await expect(storageIdentity(root)).resolves.toEqual(expect.any(Number));
  });

  it("rejects a path that is absent or is not a directory", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "seyirlik-storage-"));
    await expect(isStorageAvailable(path.join(root, "nope"))).resolves.toBe(
      false,
    );
    await expect(storageIdentity(path.join(root, "nope"))).resolves.toBeNull();
  });
});

describe("watching the roots a job needs", () => {
  const watchdog = (
    overrides: Partial<Parameters<typeof createStorageWatchdog>[0]> & {
      identify?: (p: string) => Promise<number | null>;
    } = {},
  ) =>
    createStorageWatchdog({
      mediaRoot: "/vol/media",
      check: async () => true,
      identify: async () => 1,
      ...overrides,
    });

  /** Losing the output volume is as fatal as losing the source. */
  it("watches every configured root, not only the media one", async () => {
    const asked: string[] = [];
    const guard = watchdog({
      additionalRoots: ["/vol/seyirlik/work", "/vol/seyirlik/state"],
      identify: async (root) => {
        asked.push(root);
        return 1;
      },
    });

    await guard.poll();

    expect(guard.roots).toEqual([
      "/vol/media",
      "/vol/seyirlik/work",
      "/vol/seyirlik/state",
    ]);
    expect(asked).toHaveLength(3);
  });

  it("does not check the same root twice when roots overlap", async () => {
    const guard = watchdog({ additionalRoots: ["/vol/media"] });
    expect(guard.roots).toEqual(["/vol/media"]);
  });

  it("reports the storage lost and names the roots that failed", async () => {
    let present = true;
    const lost: number[] = [];
    const guard = watchdog({
      additionalRoots: ["/vol/seyirlik"],
      // Presence is what `check` answers; identity is a separate question.
      check: async (root) => !(root === "/vol/seyirlik" && !present),
      onLost: () => {
        lost.push(1);
      },
    });

    expect(await guard.poll()).toBe(true);
    present = false;
    expect(await guard.poll()).toBe(false);
    expect(guard.missingRoots).toEqual(["/vol/seyirlik"]);
    expect(lost).toHaveLength(1);
  });

  /**
   * The case a bare existence check cannot see: `/Volumes/Name` is an ordinary
   * directory when nothing is mounted, and macOS will mount a different disk
   * at the same path. Every path still resolves — to the wrong storage.
   */
  it("treats a different volume at the same path as still missing", async () => {
    let device = 42;
    const guard = watchdog({ identify: async () => device });

    expect(await guard.poll()).toBe(true);
    // Same path, different disk.
    device = 99;
    expect(await guard.poll()).toBe(false);
    expect(guard.missingRoots).toEqual(["/vol/media"]);

    // And the original coming back is a genuine recovery.
    device = 42;
    expect(await guard.poll()).toBe(true);
    expect(guard.missingRoots).toEqual([]);
  });

  it("announces recovery once when the storage returns", async () => {
    let present = true;
    const events: string[] = [];
    const guard = watchdog({
      check: async () => present,
      onLost: () => {
        events.push("lost");
      },
      onRestored: () => {
        events.push("restored");
      },
    });

    await guard.poll();
    present = false;
    await guard.poll();
    await guard.poll();
    present = true;
    await guard.poll();
    await guard.poll();

    // One of each, however many times it is polled in between.
    expect(events).toEqual(["lost", "restored"]);
  });

  /**
   * 2026-11-09: a process started with a hold restored from the incident row
   * while the volume was already back. Present-at-birth is not a transition,
   * so only a per-poll report could ever tell the guard.
   */
  it("reports every poll that changes nothing, with its answer", async () => {
    let present = true;
    const events: string[] = [];
    const guard = watchdog({
      check: async () => present,
      onLost: () => {
        events.push("lost");
      },
      onRestored: () => {
        events.push("restored");
      },
      onSteady: (available) => {
        events.push(`steady:${available}`);
      },
    });

    await guard.poll();
    await guard.poll();
    present = false;
    await guard.poll();
    await guard.poll();
    present = true;
    await guard.poll();

    // A transition poll reports the transition only, never both.
    expect(events).toEqual([
      "steady:true",
      "steady:true",
      "lost",
      "steady:false",
      "restored",
    ]);
  });

  it("does not overlap checks on a slow volume", async () => {
    let inside = 0;
    let concurrent = 0;
    const guard = watchdog({
      identify: async () => {
        inside += 1;
        concurrent = Math.max(concurrent, inside);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inside -= 1;
        return 1;
      },
    });

    await Promise.all([guard.poll(), guard.poll(), guard.poll()]);
    expect(concurrent).toBe(1);
  });

  /** A real unmount, simulated by removing the directory the watchdog holds. */
  it("follows a real directory disappearing and returning", async () => {
    const base = await mkdtemp(path.join(tmpdir(), "seyirlik-mount-"));
    const root = path.join(base, "volume");
    await mkdir(root, { recursive: true });

    const guard = createStorageWatchdog({ mediaRoot: root });
    expect(await guard.poll()).toBe(true);

    await rm(root, { recursive: true, force: true });
    expect(await guard.poll()).toBe(false);
    expect(guard.missingRoots).toEqual([root]);

    await mkdir(root, { recursive: true });
    expect(await guard.poll()).toBe(true);
  });
});
