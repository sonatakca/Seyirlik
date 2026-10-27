import { describe, expect, it, vi } from "vitest";
import {
  createWorker,
  DeferredJobError,
  PermanentJobError,
  sanitizeJobError,
  type JobHandler,
} from "./worker";
import type { JobQueue, JobRecord, JobStatus } from "./jobQueue";
import type { MaintenanceProgress } from "../../../lib/maintenance/maintenanceTasks";

function job(overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    id: "job-1",
    jobType: "library.scan",
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
    ...overrides,
  };
}

interface FakeQueue extends JobQueue {
  completed: Array<{
    id: string;
    leaseOwner: string;
    result?: Record<string, unknown>;
  }>;
  cancelled: Array<{ id: string; leaseOwner: string }>;
  failures: Array<{ id: string; error: string; retry: boolean }>;
  deferrals: Array<{ id: string; retryAfterMs: number; reason: string }>;
  progress: Array<{ id: string; detail?: MaintenanceProgress }>;
}

function fakeQueue(pending: JobRecord[]): FakeQueue {
  const queue: FakeQueue = {
    completed: [],
    cancelled: [],
    failures: [],
    deferrals: [],
    progress: [],
    enqueue: async () => "job-1",
    claim: async () => pending.shift() ?? null,
    heartbeat: async () => true,
    reportProgress: async (id, _progress, _message, detail) => {
      queue.progress.push({ id, ...(detail ? { detail } : {}) });
    },
    complete: async (id, leaseOwner, result) => {
      queue.completed.push({ id, leaseOwner, ...(result ? { result } : {}) });
    },
    concludeCancelled: async (id, leaseOwner) => {
      queue.cancelled.push({ id, leaseOwner });
    },
    fail: async (id, _leaseOwner, error, retry) => {
      queue.failures.push({ id, error, retry });
    },
    defer: async (id, _leaseOwner, retryAfterMs, reason) => {
      queue.deferrals.push({ id, retryAfterMs, reason });
    },
    countTasks: async () => ({ active: 0, concluded: 0 }),
    requestCancellation: async () => true,
    isCancellationRequested: async () => false,
    get: async () => null,
    findActive: async () => null,
    observationTime: async () => new Date().toISOString(),
    list: async () => [],
    listActive: async () => [],
    listConcluded: async () => [],
    reorderQueue: async () => [],
    reclaimExpiredLeases: async () => 0,
  };
  return queue;
}

describe("job worker", () => {
  it("drains every queued job in one pass rather than one per interval", async () => {
    const queue = fakeQueue([
      job({ id: "a" }),
      job({ id: "b" }),
      job({ id: "c" }),
    ]);
    const handler: JobHandler = async () => ({ ok: true });
    const worker = createWorker({
      queue,
      handlers: { "library.scan": handler },
    });

    await worker.runPending();

    expect(queue.completed.map((entry) => entry.id)).toEqual(["a", "b", "c"]);
  });

  it("stores the handler's result with the job", async () => {
    const queue = fakeQueue([job()]);
    const worker = createWorker({
      queue,
      handlers: { "library.scan": async () => ({ itemsCreated: 4 }) },
    });

    await worker.runPending();

    expect(queue.completed[0]?.result).toEqual({ itemsCreated: 4 });
  });

  it("retries a transient failure but not a permanent one", async () => {
    const transient = fakeQueue([job({ id: "transient" })]);
    await createWorker({
      queue: transient,
      handlers: {
        "library.scan": async () => {
          throw new Error("the volume was busy");
        },
      },
    }).runPending();
    expect(transient.failures[0]).toMatchObject({ retry: true });

    const permanent = fakeQueue([job({ id: "permanent" })]);
    await createWorker({
      queue: permanent,
      handlers: {
        "library.scan": async () => {
          throw new PermanentJobError("the library no longer exists");
        },
      },
    }).runPending();
    expect(permanent.failures[0]).toMatchObject({ retry: false });
  });

  it("fails a job with no registered handler without retrying forever", async () => {
    const queue = fakeQueue([job({ jobType: "unknown.type" })]);
    await createWorker({ queue, handlers: {} }).runPending();

    expect(queue.failures[0]).toMatchObject({ retry: false });
  });

  it("keeps the lease alive while a long job runs", async () => {
    vi.useFakeTimers();
    try {
      const queue = fakeQueue([job()]);
      const heartbeat = vi.spyOn(queue, "heartbeat");
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });

      const worker = createWorker({
        queue,
        handlers: { "library.scan": () => gate.then(() => undefined) },
        leaseMs: 9_000,
      });

      const pass = worker.runPending();
      await vi.advanceTimersByTimeAsync(7_000);
      expect(heartbeat).toHaveBeenCalled();

      release();
      await vi.runAllTimersAsync();
      await pass;
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("sanitizeJobError", () => {
  it("strips filesystem paths from an operator-visible message", () => {
    expect(
      sanitizeJobError(new Error("cannot open /media/Movies/Secret.mkv")),
    ).toBe("cannot open");
    expect(
      sanitizeJobError(new Error("failed reading D:\\media\\Shows\\x.mkv")),
    ).toBe("failed reading");
  });

  it("strips connection strings", () => {
    expect(
      sanitizeJobError(
        new Error("connect failed postgresql://user:pw@host/db"),
      ),
    ).toBe("connect failed");
  });

  it("keeps only the first line", () => {
    expect(sanitizeJobError(new Error("headline\nstack frame one"))).toBe(
      "headline",
    );
  });

  it("falls back to a generic message when nothing safe remains", () => {
    expect(sanitizeJobError(new Error("/var/lib/secret"))).toBe(
      "The task failed.",
    );
  });

  /*
   * Every Node `fs` error quotes its path, so this is the shape almost every
   * real failure arrives in — and the one the original rule, which needed
   * whitespace in front of the path, let through untouched.
   */
  it("strips a path the way node's fs errors actually quote it", () => {
    expect(
      sanitizeJobError(
        new Error("EACCES: permission denied, mkdir '/Volumes/Expansion'"),
      ),
    ).toBe("EACCES: permission denied, mkdir");
  });

  it("strips a quoted path that has spaces in it", () => {
    // A real title does. A rule that stopped at whitespace left the rest of
    // the path standing as debris.
    const leaked = sanitizeJobError(
      new Error(
        "ENOENT: no such file or directory, open " +
          "'/Volumes/Expansion/media/Movies/Dune (2021)/video/2160p HDR.mp4'",
      ),
    );
    expect(leaked).toBe("ENOENT: no such file or directory, open");
    expect(leaked).not.toContain("Dune");
    expect(leaked).not.toContain("mp4");
  });

  it("leaves a message that only looks like it has a path alone", () => {
    expect(
      sanitizeJobError(
        new Error(
          "This title is HDR, and trickplay for HDR needs an FFmpeg built " +
            "with the zscale filter (libzimg).",
        ),
      ),
    ).toContain("zscale");
  });
});

describe("a deferred job", () => {
  /*
   * The distinction that matters: an attempt spent on a volume that was not
   * plugged in is an attempt gone forever, and 243 sheet jobs lost all three
   * that way in about a minute. A deferral has to reach `defer`, never `fail`.
   */
  it("is handed back rather than failed, with its attempt intact", async () => {
    const queue = fakeQueue([job({ jobType: "trickplay.generate" })]);
    const worker = createWorker({
      queue,
      handlers: {
        "trickplay.generate": async () => {
          throw new DeferredJobError("The volume is not available.", 120_000);
        },
      },
    });

    await worker.runPending();

    expect(queue.failures).toHaveLength(0);
    expect(queue.completed).toHaveLength(0);
    expect(queue.deferrals).toEqual([
      {
        id: "job-1",
        retryAfterMs: 120_000,
        reason: "The volume is not available.",
      },
    ]);
  });

  it("still sanitises the reason it records", async () => {
    const queue = fakeQueue([job({ jobType: "trickplay.generate" })]);
    const worker = createWorker({
      queue,
      handlers: {
        "trickplay.generate": async () => {
          throw new DeferredJobError(
            "gone: mkdir '/Volumes/Expansion'",
            60_000,
          );
        },
      },
    });

    await worker.runPending();

    expect(queue.deferrals[0]?.reason).toBe("gone: mkdir");
  });

  it("does not swallow an ordinary failure", async () => {
    const queue = fakeQueue([job()]);
    const worker = createWorker({
      queue,
      handlers: {
        "library.scan": async () => {
          throw new Error("something broke");
        },
      },
    });

    await worker.runPending();

    expect(queue.deferrals).toHaveLength(0);
    expect(queue.failures).toEqual([
      { id: "job-1", error: "something broke", retry: true },
    ]);
  });
});

describe("job status typing", () => {
  it("keeps the status union in sync with the queue contract", () => {
    const statuses: JobStatus[] = [
      "queued",
      "running",
      "succeeded",
      "failed",
      "cancelled",
    ];
    expect(statuses).toHaveLength(5);
  });
});

/**
 * An in-memory stand-in that honours a lane's claim filter and refuses to hand
 * the same row to two callers — the two properties `SKIP LOCKED` gives in
 * PostgreSQL, so a lane bug shows up here rather than only in production.
 */
function lanedQueue(pending: JobRecord[]) {
  const claimed = new Set<string>();
  const running = new Set<string>();
  const peakByType = new Map<string, number>();
  const state: JobQueue & { peak(type: string): number } = {
    enqueue: async () => "job",
    claim: async (_owner, _lease, filter) => {
      const index = pending.findIndex(
        (job) =>
          !claimed.has(job.id) &&
          (!filter?.jobTypes || filter.jobTypes.includes(job.jobType)) &&
          (!filter?.excludeJobTypes ||
            !filter.excludeJobTypes.includes(job.jobType)),
      );
      if (index === -1) return null;
      const job = pending[index] as JobRecord;
      if (claimed.has(job.id)) throw new Error("claimed twice");
      claimed.add(job.id);
      return job;
    },
    heartbeat: async () => true,
    defer: async () => undefined,
    countTasks: async () => ({ active: 0, concluded: 0 }),
    reportProgress: async () => undefined,
    concludeCancelled: async () => undefined,
    listActive: async () => [],
    listConcluded: async () => [],
    reorderQueue: async () => [],
    complete: async () => undefined,
    fail: async () => undefined,
    requestCancellation: async () => true,
    isCancellationRequested: async () => false,
    get: async () => null,
    findActive: async () => null,
    observationTime: async () => new Date().toISOString(),
    list: async () => [],
    reclaimExpiredLeases: async () => 0,
    peak: (type) => peakByType.get(type) ?? 0,
  };

  const enter = (job: JobRecord) => {
    running.add(job.id);
    const live = [...running].filter((id) =>
      pending.some((row) => row.id === id && row.jobType === job.jobType),
    ).length;
    peakByType.set(
      job.jobType,
      Math.max(peakByType.get(job.jobType) ?? 0, live),
    );
  };
  const leave = (job: JobRecord) => running.delete(job.id);
  return { queue: state, enter, leave, running };
}

const LANES = [
  { name: "media", jobTypes: ["media.process"], concurrency: 1 },
  { name: "library", excludeJobTypes: ["media.process"], concurrency: 3 },
];

describe("worker lanes", () => {
  it("runs independent library scans concurrently, bounded by the lane", async () => {
    const scans = [
      job({ id: "scan-a" }),
      job({ id: "scan-b" }),
      job({ id: "scan-c" }),
      job({ id: "scan-d" }),
    ];
    const { queue, enter, leave } = lanedQueue(scans);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered = 0;

    const worker = createWorker({
      queue,
      lanes: LANES,
      handlers: {
        "library.scan": async ({ job: current }) => {
          enter(current);
          entered += 1;
          // Hold the first wave open so overlap is observable rather than
          // inferred from ordering.
          if (entered >= 3) release();
          await gate;
          leave(current);
        },
      },
    });

    await worker.runPending();

    expect(queue.peak("library.scan")).toBe(3);
  });

  it("does not raise media-processing concurrency above one", async () => {
    const encodes = [
      job({ id: "encode-a", jobType: "media.process" }),
      job({ id: "encode-b", jobType: "media.process" }),
      job({ id: "encode-c", jobType: "media.process" }),
    ];
    const { queue, enter, leave } = lanedQueue(encodes);

    await createWorker({
      queue,
      lanes: LANES,
      handlers: {
        "media.process": async ({ job: current }) => {
          enter(current);
          // A real yield, so a second slot would genuinely have time to claim
          // the next encode if the library lane could see one.
          await new Promise((resolve) => setTimeout(resolve, 1));
          leave(current);
        },
      },
    }).runPending();

    expect(queue.peak("media.process")).toBe(1);
  });

  /*
   * The whole point of the split. A scan reads directories; an encode holds
   * the encoder. Draining both from one serial loop is what made a library
   * un-scannable for the length of an unrelated encode.
   */
  it("runs a scan while a media encode is still going", async () => {
    const rows = [
      job({ id: "encode", jobType: "media.process" }),
      job({ id: "scan", jobType: "library.scan" }),
    ];
    const { queue } = lanedQueue(rows);
    const order: string[] = [];
    let releaseEncode: () => void = () => undefined;
    const encodeGate = new Promise<void>((resolve) => {
      releaseEncode = resolve;
    });

    const pass = createWorker({
      queue,
      lanes: LANES,
      handlers: {
        "media.process": async () => {
          order.push("encode-started");
          await encodeGate;
          order.push("encode-finished");
        },
        "library.scan": async () => {
          order.push("scan-finished");
          releaseEncode();
        },
      },
    }).runPending();

    await pass;
    expect(order).toEqual([
      "encode-started",
      "scan-finished",
      "encode-finished",
    ]);
  });

  it("never hands one row to two lanes", async () => {
    const rows = [
      job({ id: "scan-a" }),
      job({ id: "encode", jobType: "media.process" }),
    ];
    const { queue } = lanedQueue(rows);
    const seen: string[] = [];

    await createWorker({
      queue,
      lanes: LANES,
      handlers: {
        "library.scan": async ({ job: current }) => {
          seen.push(current.id);
        },
        "media.process": async ({ job: current }) => {
          seen.push(current.id);
        },
      },
    }).runPending();

    expect([...seen].sort()).toEqual(["encode", "scan-a"]);
  });

  it("keeps a lane's failure from stopping the others", async () => {
    const rows = [
      job({ id: "encode", jobType: "media.process" }),
      job({ id: "scan" }),
    ];
    const { queue } = lanedQueue(rows);
    const original = queue.claim.bind(queue);
    let scanRan = false;
    queue.claim = async (owner, lease, filter) => {
      if (filter?.jobTypes?.includes("media.process")) {
        throw new Error("the database blinked");
      }
      return original(owner, lease, filter);
    };

    await createWorker({
      queue,
      lanes: LANES,
      handlers: {
        // Registered so the media lane really asks for it: a lane claims only
        // the types this process has a handler for.
        "media.process": async () => undefined,
        "library.scan": async () => {
          scanRan = true;
        },
      },
    }).runPending();

    expect(scanRan).toBe(true);
  });

  /*
   * Releases overlap now: an older worker finishes its job while a newer
   * server is already enqueueing. A type it has never heard of is not its to
   * fail, and "everything except the media lane's" used to make it exactly
   * that.
   */
  it("leaves a type it has no handler for to a worker that has one", async () => {
    const rows = [
      job({ id: "future", jobType: "future.task" }),
      job({ id: "scan", jobType: "library.scan" }),
    ];
    const { queue } = lanedQueue(rows);
    const fail = vi.spyOn(queue, "fail");
    const ran: string[] = [];

    await createWorker({
      queue,
      lanes: LANES,
      handlers: {
        "library.scan": async ({ job: current }) => {
          ran.push(current.id);
        },
      },
    }).runPending();

    expect(ran).toEqual(["scan"]);
    expect(fail).not.toHaveBeenCalled();
  });
});

/**
 * The running worker, as opposed to a single drain pass.
 *
 * `runPending` resolves only when the slowest lane is done, which is fine for
 * a one-shot CLI and wrong for a server: if the next poll is scheduled from
 * that, an encode holding its slot for hours decides when every other lane
 * next looks at the queue.
 */
describe("a started worker", () => {
  it("claims library work queued while an encode is still running", async () => {
    vi.useFakeTimers();
    try {
      const pending: JobRecord[] = [
        job({ id: "encode", jobType: "media.process" }),
      ];
      const { queue } = lanedQueue(pending);
      let encodeStarted = false;
      let scanRan = false;

      const worker = createWorker({
        queue,
        lanes: LANES,
        pollIntervalMs: 1_000,
        handlers: {
          // Never resolves: the encode is still going, at 94%, exactly as the
          // queue page shows it.
          "media.process": () =>
            new Promise<void>(() => {
              encodeStarted = true;
            }),
          "library.scan": async () => {
            scanRan = true;
          },
        },
      });

      worker.start();
      await vi.advanceTimersByTimeAsync(10);
      expect(encodeStarted).toBe(true);

      // A minute into the encode, somebody presses "Scan movies".
      pending.push(job({ id: "scan", jobType: "library.scan" }));
      await vi.advanceTimersByTimeAsync(2_000);

      expect(scanRan).toBe(true);
      await worker.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps reclaiming expired leases while a lane is busy", async () => {
    vi.useFakeTimers();
    try {
      const { queue } = lanedQueue([
        job({ id: "encode", jobType: "media.process" }),
      ]);
      const reclaim = vi.spyOn(queue, "reclaimExpiredLeases");

      const worker = createWorker({
        queue,
        lanes: LANES,
        pollIntervalMs: 1_000,
        handlers: { "media.process": () => new Promise<void>(() => {}) },
      });

      worker.start();
      await vi.advanceTimersByTimeAsync(5_000);

      // A crashed worker's jobs must not wait for this one's longest encode.
      expect(reclaim.mock.calls.length).toBeGreaterThan(1);
      await worker.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops every lane's timer, not just the last one scheduled", async () => {
    vi.useFakeTimers();
    try {
      const { queue } = lanedQueue([]);
      const claim = vi.spyOn(queue, "claim");
      const worker = createWorker({
        queue,
        lanes: LANES,
        pollIntervalMs: 1_000,
        handlers: {},
      });

      worker.start();
      await vi.advanceTimersByTimeAsync(2_000);
      await worker.stop();
      const afterStop = claim.mock.calls.length;
      await vi.advanceTimersByTimeAsync(10_000);

      expect(claim.mock.calls.length).toBe(afterStop);
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * Pausing for a release hand-off: take nothing new, let what is held finish,
 * and say when nothing is.
 */
describe("a paused worker", () => {
  it("finishes the job it holds, takes nothing new, and resumes", async () => {
    vi.useFakeTimers();
    try {
      const pending: JobRecord[] = [
        job({ id: "encode", jobType: "media.process" }),
      ];
      const { queue } = lanedQueue(pending);
      let finishEncode: () => void = () => undefined;
      const ran: string[] = [];

      const worker = createWorker({
        queue,
        lanes: LANES,
        pollIntervalMs: 1_000,
        handlers: {
          "media.process": () =>
            new Promise<void>((resolve) => {
              finishEncode = () => {
                ran.push("encode");
                resolve();
              };
            }),
          "library.scan": async ({ job: current }) => {
            ran.push(current.id);
          },
        },
      });

      worker.start();
      await vi.advanceTimersByTimeAsync(10);
      worker.pause();
      expect(worker.activeJobs()).toEqual([
        { id: "encode", jobType: "media.process" },
      ]);

      let idle = false;
      void worker.whenIdle().then(() => {
        idle = true;
      });
      pending.push(job({ id: "scan", jobType: "library.scan" }));
      await vi.advanceTimersByTimeAsync(5_000);
      expect(ran).toEqual([]);
      expect(idle).toBe(false);

      finishEncode();
      await vi.advanceTimersByTimeAsync(10);
      expect(idle).toBe(true);
      expect(worker.activeJobs()).toEqual([]);

      // Still paused: idle is not a licence to start again.
      await vi.advanceTimersByTimeAsync(5_000);
      expect(ran).toEqual(["encode"]);

      worker.resume();
      await vi.advanceTimersByTimeAsync(2_000);
      expect(ran).toEqual(["encode", "scan"]);
      await worker.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("is idle at once when it holds nothing", async () => {
    const { queue } = lanedQueue([]);
    const worker = createWorker({ queue, lanes: LANES, handlers: {} });
    worker.pause();
    await expect(worker.whenIdle()).resolves.toBeUndefined();
  });

  /*
   * The gap that matters: a claim asked for before the pause and answered
   * after it. Announcing idle in between would let the process exit holding a
   * row it had just marked running.
   */
  it("counts a claim still in flight as held", async () => {
    const { queue } = lanedQueue([]);
    let answer: (row: JobRecord | null) => void = () => undefined;
    let asked: () => void = () => undefined;
    const claimAsked = new Promise<void>((resolve) => {
      asked = resolve;
    });
    let claims = 0;
    queue.claim = () => {
      claims += 1;
      // One row, then an empty queue.
      if (claims > 1) return Promise.resolve(null);
      asked();
      return new Promise<JobRecord | null>((resolve) => {
        answer = resolve;
      });
    };
    const order: string[] = [];
    const worker = createWorker({
      queue,
      handlers: {
        "library.scan": async () => {
          order.push("ran");
        },
      },
    });

    const pass = worker.runPending();
    await claimAsked;
    worker.pause();
    void worker.whenIdle().then(() => order.push("idle"));
    await Promise.resolve();
    expect(order).toEqual([]);

    answer(job({ id: "late" }));
    await pass;
    await Promise.resolve();
    expect(order).toEqual(["ran", "idle"]);
  });
});
