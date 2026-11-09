// @vitest-environment node
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  copyFileResumable,
  waitForCacheRoom,
  type PublicationCache,
} from "./publishTitle";

const GB = 1e9;

/** A cache whose free space and queue follow a script, one reading per poll. */
function scripted(
  readings: Array<{ free: number; pending: number }>,
  reserveBytes = 10 * GB,
): PublicationCache & { polls: number } {
  const cache = {
    polls: 0,
    reserveBytes,
    async freeBytes() {
      return readings[Math.min(cache.polls, readings.length - 1)]!.free;
    },
    async pendingUploads() {
      const reading = readings[Math.min(cache.polls, readings.length - 1)]!;
      cache.polls += 1;
      return reading.pending;
    },
  };
  return cache;
}

const noSleep = async () => undefined;

describe("waitForCacheRoom", () => {
  it("goes straight on when the file and the reserve both fit", async () => {
    const cache = scripted([{ free: 50 * GB, pending: 3 }]);
    await waitForCacheRoom({ cache, bytes: 30 * GB, sleep: noSleep });
    expect(cache.polls).toBe(0);
  });

  it("waits while uploads drain, then goes on", async () => {
    const cache = scripted([
      { free: 5 * GB, pending: 2 },
      { free: 12 * GB, pending: 1 },
      { free: 41 * GB, pending: 0 },
    ]);
    await waitForCacheRoom({ cache, bytes: 30 * GB, sleep: noSleep });
    expect(cache.polls).toBe(2);
  });

  it("defers as out of space when nothing is left to upload and there is still no room", async () => {
    const cache = scripted([{ free: 20 * GB, pending: 0 }]);
    await expect(
      waitForCacheRoom({
        cache,
        bytes: 15 * GB,
        sleep: noSleep,
        idleChecks: 3,
      }),
    ).rejects.toMatchObject({ code: "ENOSPC" });
    // Gave rclone its passes to evict before giving up.
    expect(cache.polls).toBe(3);
  });

  it("gives up on a queue that never drains", async () => {
    let clock = 0;
    const cache = scripted([{ free: 1 * GB, pending: 4 }]);
    await expect(
      waitForCacheRoom({
        cache,
        bytes: 5 * GB,
        maxWaitMs: 60_000,
        now: () => clock,
        sleep: async () => {
          clock += 15_000;
        },
      }),
    ).rejects.toMatchObject({ code: "ENOSPC" });
  });

  it("does not hold publication up when the cache cannot be asked", async () => {
    const cache: PublicationCache = {
      reserveBytes: 10 * GB,
      freeBytes: async () => {
        throw new Error("rclone is not answering");
      },
      pendingUploads: async () => 0,
    };
    await waitForCacheRoom({ cache, bytes: 30 * GB, sleep: noSleep });
  });

  it("stops waiting when the publication is cancelled", async () => {
    const controller = new AbortController();
    const cache = scripted([{ free: 1 * GB, pending: 5 }]);
    const waiting = waitForCacheRoom({
      cache,
      bytes: 5 * GB,
      signal: controller.signal,
      sleep: async () => controller.abort(),
    });
    await expect(waiting).rejects.toThrow("interrupted");
  });
});

describe("copyFileResumable into a cache-backed mount", () => {
  let root = "";
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "seyirlik-cache-copy-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("copies into the mount one file at a time, asking room for what is left", async () => {
    const events: string[] = [];
    let waited = false;
    const cacheFor = (name: string, free: number): PublicationCache => ({
      reserveBytes: 0,
      freeBytes: async () => {
        events.push(`ask ${name}`);
        await new Promise((resolve) => setTimeout(resolve, 5));
        return free;
      },
      pendingUploads: async () => {
        // Reached only when the free space looked too small.
        waited = true;
        throw new Error("should not have had to wait");
      },
    });
    const a = path.join(root, "a.bin");
    const b = path.join(root, "b.bin");
    await writeFile(a, Buffer.alloc(3000, 1));
    await writeFile(b, Buffer.alloc(5000, 2));
    // 2000 bytes of `b` are already there from an earlier attempt, so it needs
    // room for 3000 more and no more than that.
    await writeFile(path.join(root, "b.out"), Buffer.alloc(2000, 2));
    const done = (name: string) => (completed: number, total: number) => {
      if (completed === total) events.push(`done ${name}`);
    };
    await Promise.all([
      copyFileResumable(a, path.join(root, "a.out"), {
        cache: cacheFor("a", 3000),
        onProgress: done("a"),
      }),
      copyFileResumable(b, path.join(root, "b.out"), {
        cache: cacheFor("b", 3000),
        onProgress: done("b"),
      }),
    ]);
    expect(events).toEqual(["ask a", "done a", "ask b", "done b"]);
    expect(waited).toBe(false);
    expect((await readFile(path.join(root, "a.out"))).length).toBe(3000);
    expect(
      (await readFile(path.join(root, "b.out"))).equals(Buffer.alloc(5000, 2)),
    ).toBe(true);
  });
});
