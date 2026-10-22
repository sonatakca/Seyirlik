// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { classifySabFailure, createSabnzbdClient, SabError } from "./sabnzbd";

const KEY = "sabkey0123456789abcdef0123456789";

const QUEUE = {
  queue: {
    slots: [
      {
        nzo_id: "SABnzbd_nzo_aaa",
        filename: "seyirlik-1",
        cat: "seyirlik",
        status: "Downloading",
        percentage: "42",
        mb: "1024",
      },
      {
        nzo_id: "SABnzbd_nzo_bbb",
        filename: "Someone.Elses.Job",
        cat: "movies",
        status: "Queued",
        percentage: "0",
        mb: "2048",
      },
    ],
  },
};

const HISTORY = {
  history: {
    slots: [
      {
        nzo_id: "SABnzbd_nzo_ccc",
        name: "seyirlik-2",
        category: "seyirlik",
        status: "Completed",
        bytes: 1073741824,
        storage: "C:\\downloads\\complete\\seyirlik-2",
      },
      {
        nzo_id: "SABnzbd_nzo_ddd",
        name: "seyirlik-3",
        category: "seyirlik",
        status: "Failed",
        fail_message: "Repair failed, not enough repair blocks",
      },
    ],
  },
};

function client(handler: (url: URL, init?: RequestInit) => Response) {
  const calls: URL[] = [];
  const fetchImpl = vi.fn(
    async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = new URL(String(input));
      calls.push(url);
      return handler(url, init);
    },
  ) as unknown as typeof fetch;
  return {
    calls,
    fetchImpl,
    sab: createSabnzbdClient({
      baseUrl: "http://127.0.0.1:8080",
      apiKey: KEY,
      fetchImpl,
    }),
  };
}

const json = (value: unknown) =>
  new Response(JSON.stringify(value), { status: 200 });

const router = (url: URL) => {
  const mode = url.searchParams.get("mode");
  if (mode === "version") return json({ version: "4.3.2" });
  if (mode === "queue" && url.searchParams.get("name") === "delete") {
    return json({ status: true });
  }
  if (mode === "history" && url.searchParams.get("name") === "delete") {
    return json({ status: true });
  }
  if (mode === "queue") return json(QUEUE);
  if (mode === "history") return json(HISTORY);
  if (mode === "addfile")
    return json({ status: true, nzo_ids: ["SABnzbd_nzo_new"] });
  return json({});
};

describe("talking to SABnzbd", () => {
  it("proves the key works", async () => {
    const { sab, calls } = client(router);
    expect(await sab.version()).toBe("4.3.2");
    expect(calls[0]?.searchParams.get("apikey")).toBe(KEY);
    expect(calls[0]?.searchParams.get("output")).toBe("json");
  });

  it("reads the queue, including jobs that are not Seyirlik's", async () => {
    const { sab } = client(router);
    const jobs = await sab.listQueue();
    expect(jobs).toHaveLength(2);
    expect(jobs[0]).toMatchObject({
      nzoId: "SABnzbd_nzo_aaa",
      name: "seyirlik-1",
      category: "seyirlik",
      state: "downloading",
      percentage: 42,
      source: "queue",
    });
    // The adapter reports everything; deciding what is ours is not its job.
    expect(jobs[1]?.name).toBe("Someone.Elses.Job");
  });

  it("converts SABnzbd's megabytes into bytes", async () => {
    const { sab } = client(router);
    expect((await sab.listQueue())[0]?.sizeBytes).toBe(1024 * 1024 * 1024);
  });

  it("reads history, with the path and the failure message", async () => {
    const { sab } = client(router);
    const jobs = await sab.listHistory();
    expect(jobs[0]).toMatchObject({
      state: "completed",
      storagePath: "C:\\downloads\\complete\\seyirlik-2",
      sizeBytes: 1073741824,
    });
    expect(jobs[1]).toMatchObject({
      state: "failed",
      failMessage: "Repair failed, not enough repair blocks",
    });
  });

  it.each([
    ["Queued", "queued"],
    ["Grabbing", "queued"],
    ["Downloading", "downloading"],
    ["Fetching", "downloading"],
    ["Verifying", "processing"],
    ["Repairing", "processing"],
    ["Extracting", "processing"],
    ["Paused", "paused"],
  ])("maps queue status %s to %s", async (status, expected) => {
    const { sab } = client((url) =>
      url.searchParams.get("mode") === "queue"
        ? json({ queue: { slots: [{ nzo_id: "x", filename: "n", status }] } })
        : json({}),
    );
    expect((await sab.listQueue())[0]?.state).toBe(expected);
  });

  it("submits an NZB under the name it was given", async () => {
    const { sab, calls } = client(router);
    const id = await sab.submit({
      bytes: new TextEncoder().encode("<nzb/>"),
      name: "seyirlik-acq-1",
      category: "seyirlik",
    });
    expect(id).toBe("SABnzbd_nzo_new");
    const add = calls.find((u) => u.searchParams.get("mode") === "addfile");
    expect(add?.searchParams.get("nzbname")).toBe("seyirlik-acq-1");
    expect(add?.searchParams.get("cat")).toBe("seyirlik");
  });

  it("treats a missing identifier as accepted rather than failed", async () => {
    /*
     * SABnzbd took the file; only the identifier is absent. Calling that a
     * failure would send the same NZB again, which is the duplicate this whole
     * design exists to avoid — the caller recovers the id by name instead.
     */
    const { sab } = client((url) =>
      url.searchParams.get("mode") === "addfile"
        ? json({ status: true })
        : json({}),
    );
    await expect(
      sab.submit({ bytes: new Uint8Array([1]), name: "n", category: "c" }),
    ).resolves.toBeUndefined();
  });

  it("raises a refusal SABnzbd reported in the body", async () => {
    const { sab } = client((url) =>
      url.searchParams.get("mode") === "addfile"
        ? json({ status: false, error: "nzb file is empty" })
        : json({}),
    );
    await expect(
      sab.submit({ bytes: new Uint8Array([1]), name: "n", category: "c" }),
    ).rejects.toMatchObject({ kind: "rejected" });
  });

  it("finds a job by name across the queue and the history", async () => {
    const { sab } = client(router);
    expect((await sab.findByName("seyirlik-1"))?.source).toBe("queue");
    expect((await sab.findByName("seyirlik-2"))?.source).toBe("history");
    expect(await sab.findByName("never-submitted")).toBeUndefined();
  });

  it("finds a job by identifier across both lists", async () => {
    const { sab } = client(router);
    expect((await sab.getJob("SABnzbd_nzo_aaa"))?.name).toBe("seyirlik-1");
    expect((await sab.getJob("SABnzbd_nzo_ccc"))?.state).toBe("completed");
    expect(await sab.getJob("SABnzbd_nzo_missing")).toBeUndefined();
  });

  it("removes a job from both the queue and the history", async () => {
    const { sab, calls } = client(router);
    await sab.remove("SABnzbd_nzo_aaa", { deleteFiles: true });
    const deletes = calls.filter(
      (u) => u.searchParams.get("name") === "delete",
    );
    // A job may move to history between deciding to remove it and doing so.
    expect(deletes.map((u) => u.searchParams.get("mode"))).toEqual([
      "queue",
      "history",
    ]);
    expect(
      deletes.every((u) => u.searchParams.get("value") === "SABnzbd_nzo_aaa"),
    ).toBe(true);
  });

  it("refuses to remove nothing", async () => {
    const { sab, calls } = client(router);
    await expect(sab.remove("")).rejects.toMatchObject({ kind: "bad-request" });
    expect(calls).toHaveLength(0);
  });
});

describe("when SABnzbd will not cooperate", () => {
  it.each([
    [401, "auth"],
    [403, "auth"],
    [400, "bad-request"],
    [500, "unavailable"],
    [502, "unavailable"],
  ])("classifies HTTP %s as %s", async (status, kind) => {
    const { sab } = client(() => new Response("", { status }));
    await expect(sab.version()).rejects.toMatchObject({ kind });
  });

  it("notices a wrong key reported with HTTP 200 and plain text", async () => {
    // A status check alone would read this as a successful empty queue.
    const { sab } = client(
      () => new Response("API Key Incorrect", { status: 200 }),
    );
    await expect(sab.listQueue()).rejects.toMatchObject({ kind: "auth" });
  });

  it("reports a non-JSON body as malformed", async () => {
    const { sab } = client(
      () => new Response("<html>nope</html>", { status: 200 }),
    );
    await expect(sab.listQueue()).rejects.toMatchObject({
      kind: "malformed-response",
    });
  });

  it("survives a queue with no slots at all", async () => {
    const { sab } = client(() => json({ queue: {} }));
    await expect(sab.listQueue()).resolves.toEqual([]);
  });

  it("skips a slot with no identifier rather than inventing one", async () => {
    const { sab } = client(() =>
      json({
        queue: {
          slots: [
            { filename: "no id" },
            { nzo_id: "ok", filename: "x", status: "Queued" },
          ],
        },
      }),
    );
    expect((await sab.listQueue()).map((j) => j.nzoId)).toEqual(["ok"]);
  });

  it("reports a timeout as a timeout", async () => {
    const fetchImpl = vi.fn(
      (_input: URL | RequestInfo, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
          );
        }),
    ) as unknown as typeof fetch;
    const sab = createSabnzbdClient({
      baseUrl: "http://127.0.0.1:8080",
      apiKey: KEY,
      fetchImpl,
      timeoutMs: 20,
    });
    await expect(sab.version()).rejects.toMatchObject({ kind: "timeout" });
  });

  it("tells a caller's cancellation apart from a timeout", async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn(
      (_input: URL | RequestInfo, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
          );
        }),
    ) as unknown as typeof fetch;
    const sab = createSabnzbdClient({
      baseUrl: "http://127.0.0.1:8080",
      apiKey: KEY,
      fetchImpl,
    });
    const pending = sab.version(controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ kind: "cancelled" });
  });

  it("never lets the key reach the error a caller sees", async () => {
    const fetchImpl = vi.fn(async (input: URL | RequestInfo) => {
      throw new Error(`ECONNREFUSED ${String(input)}`);
    }) as unknown as typeof fetch;
    const sab = createSabnzbdClient({
      baseUrl: "http://127.0.0.1:8080",
      apiKey: KEY,
      fetchImpl,
    });
    const error: unknown = await sab.version().then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(SabError);
    const failure = error as SabError;
    expect(
      JSON.stringify({ m: failure.message, s: failure.stack }),
    ).not.toContain(KEY);
  });

  it("refuses to exist without a key", () => {
    expect(() =>
      createSabnzbdClient({ baseUrl: "http://x", apiKey: "  " }),
    ).toThrow(/API key/);
  });
});

describe("reading SABnzbd's failure message", () => {
  it.each([
    ["Repair failed, not enough repair blocks", "repair-failed"],
    ["Unpacking failed, archive is corrupt", "unpack-failed"],
    ["Passworded archive", "password-required"],
    ["Out of disk space", "disk-full"],
    ["Aborted, cannot be completed - Missing articles", "missing-articles"],
    ["Not enough articles found", "missing-articles"],
  ])("reads %s as %s", (message, expected) => {
    expect(classifySabFailure(message)).toBe(expected);
  });

  it("says unknown rather than guessing", () => {
    // Unknown is terminal, so a wrong guess stops instead of looping.
    expect(classifySabFailure("Something nobody anticipated")).toBe("unknown");
    expect(classifySabFailure(undefined)).toBe("unknown");
    expect(classifySabFailure("")).toBe("unknown");
  });
});

describe("how far a download has got", () => {
  const LIVE = {
    queue: {
      paused: false,
      kbpersec: "30720.5",
      slots: [
        {
          index: 0,
          nzo_id: "SABnzbd_nzo_aaa",
          filename: "seyirlik-1",
          status: "Downloading",
          percentage: "49",
          mb: "25000",
          mbleft: "12750.5",
          timeleft: "0:07:05",
        },
        {
          index: 1,
          nzo_id: "SABnzbd_nzo_bbb",
          filename: "seyirlik-2",
          status: "Queued",
          percentage: "0",
          mb: "8000",
          mbleft: "8000",
          timeleft: "0:00:00",
        },
        {
          index: 2,
          nzo_id: "SABnzbd_nzo_ccc",
          filename: "seyirlik-3",
          status: "Queued",
          mb: "100",
          timeleft: "1:02:03:04",
        },
      ],
    },
  };

  it("reads remaining size, time left, place and status from the queue", async () => {
    const { sab } = client(() => json(LIVE));
    const snapshot = await sab.queueSnapshot();
    expect(snapshot.paused).toBe(false);
    expect(snapshot.speedBytesPerSecond).toBe(Math.round(30720.5 * 1024));
    expect(snapshot.jobs[0]).toMatchObject({
      state: "downloading",
      statusText: "Downloading",
      sizeBytes: 25000 * 1024 * 1024,
      remainingBytes: Math.round(12750.5 * 1024 * 1024),
      timeLeftSeconds: 7 * 60 + 5,
      queuePosition: 0,
    });
  });

  it("treats a zero estimate as unknown, and reads days", async () => {
    const { sab } = client(() => json(LIVE));
    const [, waiting, later] = (await sab.queueSnapshot()).jobs;
    expect(waiting!.timeLeftSeconds).toBeUndefined();
    expect(later!.timeLeftSeconds).toBe(86_400 + 2 * 3600 + 3 * 60 + 4);
  });

  it("reads a paused queue", async () => {
    const { sab } = client(() =>
      json({ queue: { paused: true, kbpersec: "0", slots: [] } }),
    );
    expect(await sab.queueSnapshot()).toMatchObject({ paused: true, jobs: [] });
  });

  it("carries the post-processing step from the history", async () => {
    const { sab } = client(() =>
      json({
        history: {
          slots: [
            {
              nzo_id: "x",
              name: "seyirlik-9",
              status: "Repairing",
              action_line: "Repairing: 45%",
            },
          ],
        },
      }),
    );
    expect((await sab.listHistory())[0]).toMatchObject({
      state: "processing",
      statusText: "Repairing",
      actionLine: "Repairing: 45%",
    });
  });
});

describe("steering the queue", () => {
  it("reads what is left and the free space alongside the jobs", async () => {
    const { sab } = client(() =>
      json({
        queue: {
          paused: false,
          mbleft: "2048",
          diskspace1: "491.5",
          slots: [],
        },
      }),
    );
    expect(await sab.queueSnapshot()).toMatchObject({
      remainingBytes: 2048 * 1024 * 1024,
      freeBytes: Math.round(491.5 * 1024 ** 3),
    });
  });

  it("holds and releases one job by its identifier", async () => {
    const { sab, calls } = client(() => json({ status: true }));
    await sab.pauseJob("SABnzbd_nzo_aaa");
    await sab.resumeJob("SABnzbd_nzo_aaa");
    expect(
      calls.map((url) => [
        url.searchParams.get("mode"),
        url.searchParams.get("name"),
        url.searchParams.get("value"),
      ]),
    ).toEqual([
      ["queue", "pause", "SABnzbd_nzo_aaa"],
      ["queue", "resume", "SABnzbd_nzo_aaa"],
    ]);
  });

  it("moves a job to a place and reports where it landed", async () => {
    const { sab, calls } = client(() =>
      json({ result: { position: 2, priority: 0 } }),
    );
    expect(await sab.moveJob("SABnzbd_nzo_aaa", 3)).toBe(2);
    expect(calls[0]!.searchParams.get("mode")).toBe("switch");
    expect(calls[0]!.searchParams.get("value")).toBe("SABnzbd_nzo_aaa");
    expect(calls[0]!.searchParams.get("value2")).toBe("3");
  });

  it("reports a move SABnzbd could not make as refused", async () => {
    const { sab } = client(() => json({ result: { position: -1 } }));
    await expect(sab.moveJob("gone", 0)).rejects.toMatchObject({
      kind: "rejected",
    });
    await expect(sab.moveJob("x", -1)).rejects.toMatchObject({
      kind: "bad-request",
    });
  });

  it("pauses and resumes the whole queue", async () => {
    const { sab, calls } = client(() => json({ status: true }));
    await sab.pauseQueue();
    await sab.resumeQueue();
    expect(calls.map((url) => url.searchParams.get("mode"))).toEqual([
      "pause",
      "resume",
    ]);
  });
});
