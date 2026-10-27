// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import {
  createAcquisitionService,
  type AcquisitionPatch,
  type AcquisitionRecord,
  type AcquisitionStore,
} from "./acquisitionService";
import { SabError, type SabJob, type SabnzbdClient } from "./sabnzbd";
import { IndexerError, type IndexerProvider } from "../indexers/indexerTypes";
import type { IndexerRegistry } from "../indexers/indexerRegistry";
import {
  MAX_ATTEMPTS_PER_RELEASE,
  type AcquisitionState,
} from "./acquisitionState";

const NZB = new TextEncoder().encode("<nzb/>");
const KEY = "seyirlik-acq-0001";

/** An in-memory store with the same optimistic-update contract as the real one. */
function makeStore(initial: Partial<AcquisitionRecord> = {}) {
  let record: AcquisitionRecord = {
    id: "acq-1",
    state: "planned",
    indexerId: "ix",
    releaseGuid: "guid-1",
    releaseTitle: "Some.Release.1080p-GRP",
    idempotencyKey: KEY,
    attempt: 0,
    updatedAtMs: 1_000,
    ...initial,
  };
  const transitions: Array<{ from: AcquisitionState; to: AcquisitionState }> =
    [];
  const store: AcquisitionStore & { current: () => AcquisitionRecord } = {
    current: () => record,
    get: async () => record,
    listActive: async () => [record],
    update: async (id, expectedState, patch: AcquisitionPatch) => {
      if (id !== record.id || record.state !== expectedState) return false;
      if (patch.state && patch.state !== record.state) {
        transitions.push({ from: record.state, to: patch.state });
      }
      record = {
        ...record,
        ...(patch.state ? { state: patch.state } : {}),
        ...(patch.externalId ? { externalId: patch.externalId } : {}),
        ...(patch.attempt === undefined ? {} : { attempt: patch.attempt }),
        ...(patch.downloadPath ? { downloadPath: patch.downloadPath } : {}),
        ...(patch.sizeBytes === undefined
          ? {}
          : { sizeBytes: patch.sizeBytes }),
        ...(patch.retryAfterMs ? { retryAfterMs: patch.retryAfterMs } : {}),
        updatedAtMs: record.updatedAtMs,
      };
      return true;
    },
  };
  return { store, transitions, current: () => record };
}

function makeIndexers(
  fetchRelease: IndexerProvider["fetchRelease"] = async () => ({ bytes: NZB }),
): IndexerRegistry {
  const provider = {
    id: "ix",
    name: "Indexer",
    protocol: "usenet" as const,
    capabilities: async () => {
      throw new Error("not used");
    },
    search: async () => {
      throw new Error("not used");
    },
    fetchRelease,
  };
  return {
    list: () => [],
    enabled: () => [provider],
    get: (id) => (id === "ix" ? provider : undefined),
    capabilities: async () => {
      throw new Error("not used");
    },
    defaultCategories: () => [],
    search: async () => {
      throw new Error("not used");
    },
  };
}

interface SabStub extends SabnzbdClient {
  readonly submissions: number;
}

function makeSab(
  options: {
    jobs?: SabJob[];
    onSubmit?: (n: number) => string | undefined | never;
  } = {},
): SabStub {
  let jobs = options.jobs ?? [];
  let submissions = 0;
  const client = {
    get submissions() {
      return submissions;
    },
    version: async () => "4.3.2",
    listQueue: async () => jobs.filter((j) => j.source === "queue"),
    listHistory: async () => jobs.filter((j) => j.source === "history"),
    findByName: async (name: string) => jobs.find((j) => j.name === name),
    getJob: async (id: string) => jobs.find((j) => j.nzoId === id),
    submit: async () => {
      submissions += 1;
      const result = options.onSubmit?.(submissions);
      if (result !== undefined) {
        jobs = [
          ...jobs,
          { nzoId: result, name: KEY, state: "queued", source: "queue" },
        ];
      }
      return result;
    },
    remove: async (nzoId: string) => {
      jobs = jobs.filter((j) => j.nzoId !== nzoId);
    },
  };
  return client as unknown as SabStub;
}

const service = (
  store: AcquisitionStore,
  sab: SabnzbdClient,
  indexers = makeIndexers(),
  extra: Partial<Parameters<typeof createAcquisitionService>[0]> = {},
) =>
  createAcquisitionService({
    store,
    indexers,
    sab,
    category: "seyirlik",
    ...extra,
  });

describe("handing a release to SABnzbd", () => {
  it("submits once and records the job", async () => {
    const { store, current } = makeStore();
    const sab = makeSab({ onSubmit: () => "nzo-1" });
    await service(store, sab).submit("acq-1");
    expect(sab.submissions).toBe(1);
    expect(current()).toMatchObject({
      state: "queued",
      externalId: "nzo-1",
      attempt: 1,
    });
  });

  it("does not submit twice when two workers run at once", async () => {
    /*
     * The claim is an optimistic update: exactly one worker moves the row out
     * of `planned`, and the loser returns without touching SABnzbd.
     */
    const { store } = makeStore();
    const sab = makeSab({ onSubmit: () => "nzo-1" });
    const runner = service(store, sab);
    await Promise.all([runner.submit("acq-1"), runner.submit("acq-1")]);
    expect(sab.submissions).toBe(1);
  });

  it("adopts a job SABnzbd already has instead of sending it again", async () => {
    // The recovery path after a crash between submitting and recording it.
    const { store, current } = makeStore();
    const sab = makeSab({
      jobs: [
        { nzoId: "nzo-old", name: KEY, state: "downloading", source: "queue" },
      ],
    });
    await service(store, sab).submit("acq-1");
    expect(sab.submissions).toBe(0);
    expect(current()).toMatchObject({
      state: "downloading",
      externalId: "nzo-old",
    });
  });

  it("stays in submitting when the response is lost, and does not resend", async () => {
    /*
     * The case the whole design exists for. A timeout says nothing about
     * whether SABnzbd accepted the file, so the row keeps the uncertain state
     * and the reconciler goes and looks.
     */
    const { store, current } = makeStore();
    const sab = makeSab({
      onSubmit: () => {
        throw new SabError("timeout", "SABnzbd did not answer in time.");
      },
    });
    await service(store, sab).submit("acq-1");
    expect(current().state).toBe("submitting");
    expect(current().externalId).toBeUndefined();
  });

  it("recovers the identifier by name when SABnzbd accepted without giving one", async () => {
    const { store, current } = makeStore();
    const sab = makeSab({ onSubmit: () => "nzo-2" });
    // Accept, but report no id: the job is findable only by the name we chose.
    const original = sab.submit.bind(sab);
    (sab as { submit: SabnzbdClient["submit"] }).submit = async (
      submission,
      signal,
    ) => {
      await original(submission, signal);
      return undefined;
    };
    await service(store, sab).submit("acq-1");
    expect(current()).toMatchObject({ state: "queued", externalId: "nzo-2" });
  });

  it("stops on an authentication failure rather than retrying", async () => {
    const { store, current } = makeStore();
    const sab = makeSab({
      onSubmit: () => {
        throw new SabError("auth", "SABnzbd refused the key.");
      },
    });
    await service(store, sab).submit("acq-1");
    expect(current().state).toBe("failed");
  });

  it("treats a refused NZB as this release being unusable", async () => {
    const { store, current } = makeStore();
    const sab = makeSab({
      onSubmit: () => {
        throw new SabError("rejected", "nzb file is empty");
      },
    });
    await service(store, sab).submit("acq-1");
    // Sending it again will not change SABnzbd's mind; another release might.
    expect(current().state).toBe("failed");
  });

  it("waits rather than failing when the indexer is briefly unavailable", async () => {
    const { store, current } = makeStore();
    const sab = makeSab({ onSubmit: () => "nzo-1" });
    const indexers = makeIndexers(async () => {
      throw new IndexerError(
        "unavailable",
        "The provider could not be reached.",
      );
    });
    await service(store, sab, indexers).submit("acq-1");
    expect(current().state).toBe("awaiting_retry");
    expect(sab.submissions).toBe(0);
  });

  it("says when it will try again, so the wait can end", async () => {
    // A row parked with no time was never picked up again.
    const { store, current } = makeStore();
    const indexers = makeIndexers(async () => {
      throw new IndexerError(
        "unavailable",
        "The provider could not be reached.",
      );
    });
    await service(store, makeSab(), indexers, { now: () => 10_000 }).submit(
      "acq-1",
    );
    expect(current()).toMatchObject({
      state: "awaiting_retry",
      retryAfterMs: 70_000,
    });
  });

  it("fails rather than waits once the release has used its attempts", async () => {
    const { store, current } = makeStore({
      state: "awaiting_retry",
      attempt: MAX_ATTEMPTS_PER_RELEASE - 1,
    });
    const indexers = makeIndexers(async () => {
      throw new IndexerError(
        "unavailable",
        "The provider could not be reached.",
      );
    });
    await service(store, makeSab(), indexers).submit("acq-1");
    expect(current().state).toBe("failed");
  });

  it("stops when the indexer refuses the credential", async () => {
    const { store, current } = makeStore();
    const indexers = makeIndexers(async () => {
      throw new IndexerError("auth", "Incorrect user credentials");
    });
    await service(store, makeSab(), indexers).submit("acq-1");
    expect(current().state).toBe("failed");
  });

  it("ignores an acquisition that is already in flight", async () => {
    const { store } = makeStore({ state: "downloading", externalId: "nzo-9" });
    const sab = makeSab();
    await service(store, sab).submit("acq-1");
    expect(sab.submissions).toBe(0);
  });
});

describe("reconciling with SABnzbd", () => {
  it("follows a job forward through its states", async () => {
    for (const [sabState, expected] of [
      ["queued", "queued"],
      ["downloading", "downloading"],
      ["processing", "processing"],
    ] as const) {
      const { store, current } = makeStore({
        state: "submitting",
        externalId: "nzo-1",
      });
      const sab = makeSab({
        jobs: [{ nzoId: "nzo-1", name: KEY, state: sabState, source: "queue" }],
      });
      await service(store, sab).reconcile();
      expect(current().state).toBe(expected);
    }
  });

  it("discovers a completed job after a restart, with its path", async () => {
    const { store, current } = makeStore({
      state: "downloading",
      externalId: "nzo-1",
    });
    const sab = makeSab({
      jobs: [
        {
          nzoId: "nzo-1",
          name: KEY,
          state: "completed",
          source: "history",
          storagePath: "C:/downloads/complete/x",
          sizeBytes: 1024,
        },
      ],
    });
    await service(store, sab).reconcile();
    expect(current()).toMatchObject({
      state: "downloaded",
      downloadPath: "C:/downloads/complete/x",
      sizeBytes: 1024,
    });
  });

  it("waits for SABnzbd to name the path before calling it downloaded", async () => {
    // History can say Completed before `storage` is filled.
    const { store, current } = makeStore({
      state: "processing",
      externalId: "nzo-1",
    });
    const job: SabJob = {
      nzoId: "nzo-1",
      name: KEY,
      state: "completed",
      source: "history",
    };
    const runner = service(store, makeSab({ jobs: [job] }));
    expect((await runner.reconcile()).changed).toBe(0);
    expect(current().state).toBe("processing");

    const later = service(
      store,
      makeSab({ jobs: [{ ...job, storagePath: "C:/downloads/complete/x" }] }),
    );
    await later.reconcile();
    expect(current()).toMatchObject({
      state: "downloaded",
      downloadPath: "C:/downloads/complete/x",
    });
  });

  it("finds a lost submission by name and adopts it", async () => {
    // Seyirlik never learned the id; SABnzbd has the job under our name.
    const { store, current } = makeStore({ state: "submitting" });
    const sab = makeSab({
      jobs: [
        {
          nzoId: "nzo-found",
          name: KEY,
          state: "downloading",
          source: "queue",
        },
      ],
    });
    await service(store, sab).reconcile();
    expect(current()).toMatchObject({
      state: "downloading",
      externalId: "nzo-found",
    });
  });

  it("waits out the grace period before deciding a submission never landed", async () => {
    /*
     * SABnzbd does not always list a job the instant it accepts it. Concluding
     * "not there" too early is how the duplicate this design prevents would be
     * created anyway.
     */
    const { store, current } = makeStore({
      state: "submitting",
      updatedAtMs: 1_000,
    });
    const sab = makeSab();
    const early = service(store, sab, makeIndexers(), {
      now: () => 1_500,
      submitGraceMs: 60_000,
    });
    await early.reconcile();
    expect(current().state).toBe("submitting");

    const late = service(store, sab, makeIndexers(), {
      now: () => 100_000,
      submitGraceMs: 60_000,
    });
    await late.reconcile();
    expect(current().state).toBe("awaiting_retry");
    expect(current().retryAfterMs).toBeGreaterThan(100_000);
  });

  it("marks a job that vanished after we knew its id as removed elsewhere", async () => {
    const { store, current } = makeStore({
      state: "downloading",
      externalId: "nzo-gone",
    });
    await service(store, makeSab()).reconcile();
    expect(current().state).toBe("failed");
  });

  it("changes nothing when SABnzbd is unreachable", async () => {
    // A broken API call is not evidence about any job.
    const { store, current } = makeStore({
      state: "downloading",
      externalId: "nzo-1",
    });
    const sab = makeSab();
    (sab as { listQueue: SabnzbdClient["listQueue"] }).listQueue = async () => {
      throw new SabError("unavailable", "SABnzbd could not be reached.");
    };
    const result = await service(store, sab).reconcile();
    expect(result.changed).toBe(0);
    expect(current().state).toBe("downloading");
  });

  it("ignores jobs that are not Seyirlik's", async () => {
    const { store, current } = makeStore({
      state: "downloading",
      externalId: "nzo-mine",
    });
    const sab = makeSab({
      jobs: [
        {
          nzoId: "nzo-theirs",
          name: "Radarr.Job",
          state: "downloading",
          source: "queue",
        },
        {
          nzoId: "nzo-alsotheirs",
          name: "Sonarr.Job",
          state: "completed",
          source: "history",
        },
      ],
    });
    await service(store, sab).reconcile();
    // Ours is absent, so it is reported gone — not confused with somebody else's.
    expect(current().state).toBe("failed");
  });

  it("records the failure SABnzbd reported, classified", async () => {
    const { store, current } = makeStore({
      state: "downloading",
      externalId: "nzo-1",
    });
    const sab = makeSab({
      jobs: [
        {
          nzoId: "nzo-1",
          name: KEY,
          state: "failed",
          source: "history",
          failMessage: "Passworded archive",
        },
      ],
    });
    await service(store, sab).reconcile();
    expect(current().state).toBe("failed");
  });

  it("does nothing when the observed state has not changed", async () => {
    const { store, transitions } = makeStore({
      state: "downloading",
      externalId: "nzo-1",
    });
    const sab = makeSab({
      jobs: [
        { nzoId: "nzo-1", name: KEY, state: "downloading", source: "queue" },
      ],
    });
    const result = await service(store, sab).reconcile();
    expect(result.changed).toBe(0);
    expect(transitions).toEqual([]);
  });

  it("reads the queue and history once for the whole batch", async () => {
    const { store } = makeStore({ state: "downloading", externalId: "nzo-1" });
    const sab = makeSab({
      jobs: [
        { nzoId: "nzo-1", name: KEY, state: "downloading", source: "queue" },
      ],
    });
    const queue = vi.spyOn(sab, "listQueue");
    const history = vi.spyOn(sab, "listHistory");
    await service(store, sab).reconcile();
    expect(queue).toHaveBeenCalledTimes(1);
    expect(history).toHaveBeenCalledTimes(1);
  });
});

describe("cancelling", () => {
  it("removes the job it owns and nothing else", async () => {
    const { store, current } = makeStore({
      state: "downloading",
      externalId: "nzo-mine",
    });
    const sab = makeSab({
      jobs: [
        { nzoId: "nzo-mine", name: KEY, state: "downloading", source: "queue" },
        {
          nzoId: "nzo-theirs",
          name: "Radarr.Job",
          state: "downloading",
          source: "queue",
        },
      ],
    });
    const remove = vi.spyOn(sab, "remove");
    await service(store, sab).cancel("acq-1");
    expect(remove).toHaveBeenCalledWith(
      "nzo-mine",
      expect.objectContaining({ deleteFiles: true }),
    );
    expect(remove).toHaveBeenCalledTimes(1);
    expect(current().state).toBe("cancelled");
  });

  it("cancels an acquisition that never reached SABnzbd", async () => {
    const { store, current } = makeStore({ state: "planned" });
    const sab = makeSab();
    const remove = vi.spyOn(sab, "remove");
    await service(store, sab).cancel("acq-1");
    expect(remove).not.toHaveBeenCalled();
    expect(current().state).toBe("cancelled");
  });

  it("refuses to pretend a finished download never happened", async () => {
    const { store } = makeStore({ state: "downloaded", externalId: "nzo-1" });
    await expect(service(store, makeSab()).cancel("acq-1")).rejects.toThrow(
      /completed acquisition/,
    );
  });

  it("still cancels when SABnzbd will not remove the job", async () => {
    // The user's intent is recorded either way; the orphan is reconciled later.
    const { store, current } = makeStore({
      state: "downloading",
      externalId: "nzo-1",
    });
    const sab = makeSab();
    (sab as { remove: SabnzbdClient["remove"] }).remove = async () => {
      throw new SabError("unavailable", "SABnzbd could not be reached.");
    };
    await service(store, sab).cancel("acq-1");
    expect(current().state).toBe("cancelled");
  });
});

describe("blocklisting", () => {
  it("stops the download, removes its job, and leaves it failed", async () => {
    const { store, current } = makeStore({
      state: "downloading",
      externalId: "nzo-mine",
    });
    const sab = makeSab({
      jobs: [
        { nzoId: "nzo-mine", name: KEY, state: "downloading", source: "queue" },
      ],
    });
    const remove = vi.spyOn(sab, "remove");
    await expect(service(store, sab).blocklist("acq-1")).resolves.toBe(true);
    expect(remove).toHaveBeenCalledWith(
      "nzo-mine",
      expect.objectContaining({ deleteFiles: true }),
    );
    // Failed, not cancelled: the title is still wanted.
    expect(current().state).toBe("failed");
  });

  it("blocklists a failure that is already failed", async () => {
    const { store, current } = makeStore({ state: "failed" });
    await expect(service(store, makeSab()).blocklist("acq-1")).resolves.toBe(
      true,
    );
    expect(current().state).toBe("failed");
  });

  it.each(["resolving", "submitting", "downloaded", "cancelled"] as const)(
    "refuses while the acquisition is %s",
    async (state) => {
      const { store } = makeStore({ state, externalId: "nzo-1" });
      const sab = makeSab();
      const remove = vi.spyOn(sab, "remove");
      await expect(service(store, sab).blocklist("acq-1")).rejects.toThrow(
        /cannot be blocklisted/,
      );
      expect(remove).not.toHaveBeenCalled();
    },
  );
});

describe("steering its own job in the queue", () => {
  function steerable(jobs: SabJob[]) {
    const sab = {
      ...makeSab({ jobs }),
      pauseJob: vi.fn(async () => undefined),
      resumeJob: vi.fn(async () => undefined),
      moveJob: vi.fn(async (_id: string, index: number) => index),
    };
    return sab;
  }
  const own: SabJob = {
    nzoId: "nzo-own",
    name: KEY,
    category: "seyirlik",
    state: "queued",
    source: "queue",
  };
  const other: SabJob = {
    nzoId: "nzo-other",
    name: "Someone.Elses.Job",
    category: "movies",
    state: "queued",
    source: "queue",
  };

  it("holds and releases the job it owns, found by identifier", async () => {
    const { store } = makeStore({ state: "queued", externalId: "nzo-own" });
    const sab = steerable([other, own]);
    const svc = service(store, sab);
    await svc.setPaused("acq-1", true);
    await svc.setPaused("acq-1", false);
    expect(sab.pauseJob).toHaveBeenCalledWith("nzo-own", undefined);
    expect(sab.resumeJob).toHaveBeenCalledWith("nzo-own", undefined);
  });

  it("refuses a job whose identifier now names something it does not own", async () => {
    // The row remembers an identifier SABnzbd has since given to another job.
    const { store } = makeStore({ state: "queued", externalId: "nzo-other" });
    const sab = steerable([other]);
    await expect(
      service(store, sab).setPaused("acq-1", true),
    ).rejects.toMatchObject({ kind: "not-in-queue" });
    expect(sab.pauseJob).not.toHaveBeenCalled();
  });

  it("refuses a download that has left the queue", async () => {
    const { store } = makeStore({ state: "processing", externalId: "nzo-own" });
    const sab = steerable([{ ...own, source: "history", state: "processing" }]);
    await expect(service(store, sab).move("acq-1", 0)).rejects.toMatchObject({
      kind: "not-in-queue",
    });
    expect(sab.moveJob).not.toHaveBeenCalled();
  });

  it("moves the job, keeping the place inside the queue", async () => {
    const { store } = makeStore({ state: "queued" });
    const sab = steerable([other, own]);
    const svc = service(store, sab);
    expect(await svc.move("acq-1", 0)).toBe(0);
    expect(await svc.move("acq-1", 99)).toBe(1);
    expect(sab.moveJob).toHaveBeenLastCalledWith("nzo-own", 1, undefined);
  });

  it("leaves a job already in place alone", async () => {
    const { store } = makeStore({ state: "queued" });
    const sab = steerable([{ ...own, queuePosition: 0 }, other]);
    expect(await service(store, sab).move("acq-1", 0)).toBe(0);
    expect(sab.moveJob).not.toHaveBeenCalled();
  });
});
