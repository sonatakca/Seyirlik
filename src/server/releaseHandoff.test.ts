// @vitest-environment node
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { watchReleaseHandoff } from "./releaseHandoff";
import { createWorker, type WorkerControl } from "./ownApi/tasks/worker";
import type { JobQueue, JobRecord } from "./ownApi/tasks/jobQueue";

/** A worker whose one held job finishes when the test says so. */
function fakeWorker(holding: boolean) {
  let finish: () => void = () => undefined;
  let idle = holding
    ? new Promise<void>((resolve) => {
        finish = resolve;
      })
    : Promise.resolve();
  const calls: string[] = [];
  const worker: WorkerControl = {
    pause: () => void calls.push("pause"),
    resume: () => void calls.push("resume"),
    whenIdle: () => idle,
    activeJobs: () =>
      holding ? [{ id: "encode-1", jobType: "media.process" }] : [],
  };
  return {
    worker,
    calls,
    finish: () => {
      holding = false;
      idle = Promise.resolve();
      finish();
    },
  };
}

const quiet = { info: () => undefined, warn: () => undefined };

/** The pointer, as the test moves it. */
function pointer(initial: string) {
  let at: string | null = initial;
  return {
    resolve: async () => {
      if (at === null) throw new Error("ENOENT");
      return at;
    },
    point: (to: string | null) => {
      at = to;
    },
  };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

describe("handing a worker over to a new release", () => {
  it("does nothing while current still names this release", async () => {
    const link = pointer("/app/releases/1");
    const { worker, calls } = fakeWorker(false);
    const exit = vi.fn();
    const handoff = await watchReleaseHandoff({
      pointer: "/app/current",
      worker,
      exit,
      resolve: link.resolve,
      logger: quiet,
    });

    await handoff.check();
    await settle();

    expect(handoff.release).toBe("/app/releases/1");
    expect(calls).toEqual([]);
    expect(exit).not.toHaveBeenCalled();
    handoff.stop();
  });

  it("finishes the encode it holds before it exits", async () => {
    const link = pointer("/app/releases/1");
    const held = fakeWorker(true);
    const exit = vi.fn();
    const handoff = await watchReleaseHandoff({
      pointer: "/app/current",
      worker: held.worker,
      exit,
      resolve: link.resolve,
      logger: quiet,
    });

    link.point("/app/releases/2");
    await handoff.check();
    await settle();
    expect(held.calls).toEqual(["pause"]);
    expect(exit).not.toHaveBeenCalled();

    // Later looks while it waits change nothing.
    await handoff.check();
    await settle();
    expect(held.calls).toEqual(["pause"]);

    held.finish();
    await settle();
    expect(exit).toHaveBeenCalledTimes(1);
    handoff.stop();
  });

  it("exits at once when it holds nothing", async () => {
    const link = pointer("/app/releases/1");
    const idle = fakeWorker(false);
    const exit = vi.fn();
    const handoff = await watchReleaseHandoff({
      pointer: "/app/current",
      worker: idle.worker,
      exit,
      resolve: link.resolve,
      logger: quiet,
    });

    link.point("/app/releases/2");
    await handoff.check();
    await settle();
    expect(exit).toHaveBeenCalledTimes(1);
    handoff.stop();
  });

  /*
   * An encode can hold the wait for hours. The short work moves to the new
   * release meanwhile, through whatever `onLongWait` starts — and again if a
   * newer release lands before the encode ends.
   */
  it("offers the short work to the new release while an encode holds the wait", async () => {
    const link = pointer("/app/releases/1");
    const held = fakeWorker(true);
    const offered: string[] = [];
    const handoff = await watchReleaseHandoff({
      pointer: "/app/current",
      worker: held.worker,
      exit: vi.fn(),
      isLong: (jobType) => jobType === "media.process",
      onLongWait: (release) => void offered.push(release),
      resolve: link.resolve,
      logger: quiet,
    });

    link.point("/app/releases/2");
    await handoff.check();
    await handoff.check();
    await settle();
    expect(offered).toEqual(["/app/releases/2"]);

    link.point("/app/releases/3");
    await handoff.check();
    await settle();
    expect(offered).toEqual(["/app/releases/2", "/app/releases/3"]);
    handoff.stop();
  });

  it("offers nothing when what it holds is short", async () => {
    const link = pointer("/app/releases/1");
    const held = fakeWorker(true);
    const onLongWait = vi.fn();
    const handoff = await watchReleaseHandoff({
      pointer: "/app/current",
      worker: held.worker,
      exit: vi.fn(),
      isLong: () => false,
      onLongWait,
      resolve: link.resolve,
      logger: quiet,
    });

    link.point("/app/releases/2");
    await handoff.check();
    await settle();
    expect(onLongWait).not.toHaveBeenCalled();
    handoff.stop();
  });

  /*
   * Activation puts `current` back when the new server does not come up. The
   * worker was only waiting to leave; it goes back to work instead.
   */
  it("goes back to work when an activation rolls back", async () => {
    const link = pointer("/app/releases/1");
    const held = fakeWorker(true);
    const exit = vi.fn();
    const handoff = await watchReleaseHandoff({
      pointer: "/app/current",
      worker: held.worker,
      exit,
      resolve: link.resolve,
      logger: quiet,
    });

    link.point("/app/releases/2");
    await handoff.check();
    link.point("/app/releases/1");
    await handoff.check();
    held.finish();
    await settle();

    expect(held.calls).toEqual(["pause", "resume"]);
    expect(exit).not.toHaveBeenCalled();
    handoff.stop();
  });

  it("goes back to work when the rollback lands as the last job ends", async () => {
    const link = pointer("/app/releases/1");
    const held = fakeWorker(true);
    const exit = vi.fn();
    const handoff = await watchReleaseHandoff({
      pointer: "/app/current",
      worker: held.worker,
      exit,
      resolve: link.resolve,
      logger: quiet,
    });

    link.point("/app/releases/2");
    await handoff.check();
    // No look in between: the job ends first, and the final look sees it.
    link.point("/app/releases/1");
    held.finish();
    await settle();

    expect(held.calls).toEqual(["pause", "resume"]);
    expect(exit).not.toHaveBeenCalled();
    handoff.stop();
  });

  it("takes a missing junction for a switch in progress, not a release", async () => {
    vi.useFakeTimers();
    try {
      const link = pointer("/app/releases/1");
      const held = fakeWorker(true);
      const exit = vi.fn();
      const handoff = await watchReleaseHandoff({
        pointer: "/app/current",
        worker: held.worker,
        exit,
        resolve: link.resolve,
        logger: quiet,
      });

      // Mid-switch on its own: nothing to move to.
      link.point(null);
      await handoff.check();
      expect(held.calls).toEqual([]);

      // Seen on the new release, then gone again just as the last job ends:
      // it waits for the junction rather than restarting into nothing.
      link.point("/app/releases/2");
      await handoff.check();
      link.point(null);
      held.finish();
      await vi.advanceTimersByTimeAsync(0);
      expect(exit).not.toHaveBeenCalled();

      link.point("/app/releases/2");
      await vi.advanceTimersByTimeAsync(1_000);
      expect(exit).toHaveBeenCalledTimes(1);
      handoff.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("turns itself off when the start directory cannot be read", async () => {
    const { worker, calls } = fakeWorker(false);
    const exit = vi.fn();
    const handoff = await watchReleaseHandoff({
      pointer: "/nowhere",
      worker,
      exit,
      resolve: async () => {
        throw new Error("ENOENT");
      },
      logger: quiet,
    });

    await handoff.check();
    expect(handoff.release).toBeNull();
    expect(calls).toEqual([]);
    expect(exit).not.toHaveBeenCalled();
  });

  /*
   * The real resolver against a real link, the way both Windows hosts start
   * the worker: from `current`, never from the release folder itself.
   */
  it("follows a real link that is swapped under it", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "seyirlik-handoff-"));
    try {
      await mkdir(path.join(root, "1"));
      await mkdir(path.join(root, "2"));
      const current = path.join(root, "current");
      await symlink(path.join(root, "1"), current, "dir");

      const idle = fakeWorker(false);
      const exit = vi.fn();
      const handoff = await watchReleaseHandoff({
        pointer: current,
        worker: idle.worker,
        exit,
        logger: quiet,
      });
      expect(path.basename(handoff.release ?? "")).toBe("1");

      await handoff.check();
      expect(exit).not.toHaveBeenCalled();

      await rm(current);
      await symlink(path.join(root, "2"), current, "dir");
      await handoff.check();
      // Real I/O this time, so wait for it rather than for microtasks.
      await vi.waitFor(() => expect(exit).toHaveBeenCalledTimes(1));
      handoff.stop();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  /*
   * The pieces together: the real job loop and the real watcher, over a real
   * link. Only the process boundary is missing, and the clean exit there is
   * `shutdown()` in mediaWorker.ts.
   */
  it("lets a real worker finish its encode, take nothing else, then exit", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "seyirlik-handoff-"));
    try {
      await mkdir(path.join(root, "1"));
      await mkdir(path.join(root, "2"));
      const current = path.join(root, "current");
      await symlink(path.join(root, "1"), current, "dir");

      const rows: JobRecord[] = [
        row("encode", "media.process"),
        row("next-encode", "media.process"),
      ];
      const taken: string[] = [];
      const queue = {
        claim: async () => {
          const next = rows.shift() ?? null;
          if (next) taken.push(next.id);
          return next;
        },
        heartbeat: async () => true,
        reportProgress: async () => undefined,
        complete: async () => undefined,
        fail: async () => undefined,
        reclaimExpiredLeases: async () => 0,
        isCancellationRequested: async () => false,
      } as unknown as JobQueue;
      let finishEncode: () => void = () => undefined;
      const worker = createWorker({
        queue,
        pollIntervalMs: 20,
        lanes: [{ name: "media", jobTypes: ["media.process"], concurrency: 1 }],
        handlers: {
          "media.process": () =>
            new Promise<void>((resolve) => {
              finishEncode = resolve;
            }),
        },
      });
      worker.start();
      await vi.waitFor(() => expect(taken).toEqual(["encode"]));

      const exit = vi.fn();
      const handoff = await watchReleaseHandoff({
        pointer: current,
        worker,
        exit,
        logger: quiet,
      });
      await rm(current);
      await symlink(path.join(root, "2"), current, "dir");
      await handoff.check();

      // Long enough for many polls: the queue still has an encode, and the
      // worker must not take it.
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(exit).not.toHaveBeenCalled();
      expect(taken).toEqual(["encode"]);

      finishEncode();
      await vi.waitFor(() => expect(exit).toHaveBeenCalledTimes(1));
      expect(taken).toEqual(["encode"]);
      handoff.stop();
      await worker.stop();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function row(id: string, jobType: string): JobRecord {
  return {
    id,
    jobType,
    payload: {},
    status: "running",
    attempts: 1,
    maxAttempts: 3,
    progress: 0,
    progressMessage: null,
    progressDetail: null,
    priority: 100,
    runAfter: new Date(0),
    safeError: null,
    result: null,
    cancellationRequested: false,
    queuedAt: new Date(),
    startedAt: new Date(),
    finishedAt: null,
  };
}
