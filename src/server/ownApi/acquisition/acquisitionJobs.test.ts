// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import {
  ACQUISITION_JOB_TYPES,
  createAcquisitionJobHandlers,
} from "./acquisitionJobs";
import type {
  AcquisitionRepository,
  AcquisitionSummary,
} from "./acquisitionRepository";
import type { AcquisitionService } from "./acquisitionService";
import { PermanentJobError } from "../tasks/worker";
import type { JobContext } from "../tasks/worker";
import type { JobRecord } from "../tasks/jobQueue";
import { MAX_ATTEMPTS_PER_RELEASE } from "./acquisitionState";

function summary(over: Partial<AcquisitionSummary> = {}): AcquisitionSummary {
  return {
    id: "a1",
    state: "planned",
    indexerId: "nzbgeek",
    releaseGuid: "g1",
    releaseTitle: "Big.Buck.Bunny.2008.1080p.WEB-DL",
    idempotencyKey: "seyirlik-a1",
    attempt: 1,
    targetTitle: "Big Buck Bunny",
    targetKind: "movie",
    origin: "manual",
    createdAtMs: 0,
    updatedAtMs: 0,
    ...over,
  };
}

function context(payload: Record<string, unknown>): JobContext {
  return {
    job: { payload } as JobRecord,
    reportProgress: vi.fn(async () => undefined),
    isCancelled: async () => false,
  };
}

interface Fakes {
  service: AcquisitionService;
  repository: AcquisitionRepository;
  updates: Array<{ id: string; from: string; patch: Record<string, unknown> }>;
}

function fakes(
  records: AcquisitionSummary[],
  over: Partial<AcquisitionService> = {},
): Fakes {
  const updates: Fakes["updates"] = [];
  const service: AcquisitionService = {
    submit: vi.fn(async () => undefined),
    reconcile: vi.fn(async () => ({ examined: records.length, changed: 0 })),
    cancel: vi.fn(async () => undefined),
    blocklist: vi.fn(async () => true),
    setPaused: vi.fn(async () => undefined),
    move: vi.fn(async () => 0),
    ...over,
  };
  const repository = {
    get: async (id: string) => records.find((r) => r.id === id) ?? null,
    list: async () => records,
    listActive: async () => records,
    update: async (
      id: string,
      from: string,
      patch: Record<string, unknown>,
    ) => {
      updates.push({ id, from, patch });
      return true;
    },
  } as unknown as AcquisitionRepository;
  return { service, repository, updates };
}

const handlers = (f: Fakes) =>
  createAcquisitionJobHandlers(f.service, f.repository);

describe("handing a release to the download client", () => {
  it("submits and reports where the acquisition ended up", async () => {
    const f = fakes([
      summary({ state: "queued", externalId: "SABnzbd_nzo_1" }),
    ]);
    const result = await handlers(f)[ACQUISITION_JOB_TYPES.submit]!(
      context({ acquisitionId: "a1" }),
    );
    expect(f.service.submit).toHaveBeenCalledWith("a1");
    expect(result).toEqual({ state: "queued", externalId: "SABnzbd_nzo_1" });
  });

  it("does not retry a payload that names no acquisition", async () => {
    // Retrying cannot add the field, so the queue must not spend attempts.
    const f = fakes([]);
    await expect(
      handlers(f)[ACQUISITION_JOB_TYPES.submit]!(context({})),
    ).rejects.toBeInstanceOf(PermanentJobError);
    expect(f.service.submit).not.toHaveBeenCalled();
  });

  it("does not retry an acquisition that no longer exists", async () => {
    const f = fakes([]);
    await expect(
      handlers(f)[ACQUISITION_JOB_TYPES.submit]!(
        context({ acquisitionId: "gone" }),
      ),
    ).rejects.toBeInstanceOf(PermanentJobError);
  });

  it("lets a transient submission failure reach the queue's own retry", async () => {
    // Not swallowed: the job queue owns backoff for the work it dispatched.
    const f = fakes([summary()], {
      submit: vi.fn(async () => {
        throw new Error("SABnzbd did not answer.");
      }),
    });
    await expect(
      handlers(f)[ACQUISITION_JOB_TYPES.submit]!(
        context({ acquisitionId: "a1" }),
      ),
    ).rejects.toThrow(/did not answer/);
  });
});

describe("bringing the record back into agreement with SABnzbd", () => {
  it("reports what it examined and what it changed", async () => {
    const f = fakes([summary({ state: "downloading" })], {
      reconcile: vi.fn(async () => ({ examined: 4, changed: 2 })),
    });
    const result = await handlers(f)[ACQUISITION_JOB_TYPES.reconcile]!(
      context({}),
    );
    expect(result).toMatchObject({ examined: 4, changed: 2, retried: 0 });
  });

  it("schedules a retry for a transient failure, in the future", async () => {
    const f = fakes([
      summary({ state: "failed", failureClass: "sab-unavailable", attempt: 1 }),
    ]);
    const before = Date.now();
    const result = await handlers(f)[ACQUISITION_JOB_TYPES.reconcile]!(
      context({}),
    );
    expect(result).toMatchObject({ retried: 1 });
    expect(f.updates).toHaveLength(1);
    expect(f.updates[0]).toMatchObject({
      id: "a1",
      from: "failed",
      patch: { state: "awaiting_retry" },
    });
    // A backoff, not an immediate re-run: otherwise an unreachable client
    // would be asked again as fast as the worker can loop.
    expect(f.updates[0]!.patch.retryAfterMs as number).toBeGreaterThan(before);
  });

  it("leaves a terminal failure exactly where it is", async () => {
    // A wrong API key will still be wrong on the next pass.
    const f = fakes([
      summary({ state: "failed", failureClass: "sab-auth", attempt: 1 }),
    ]);
    const result = await handlers(f)[ACQUISITION_JOB_TYPES.reconcile]!(
      context({}),
    );
    expect(result).toMatchObject({ retried: 0, awaitingAlternative: 0 });
    expect(f.updates).toHaveLength(0);
  });

  it("stops retrying a release that has used its attempts", async () => {
    /*
     * It is counted as awaiting an alternative rather than retried, and the
     * reconciler does not choose that alternative itself: searching again is
     * somebody's decision, not an observer's.
     */
    const f = fakes([
      summary({
        state: "failed",
        failureClass: "sab-unavailable",
        attempt: MAX_ATTEMPTS_PER_RELEASE,
      }),
    ]);
    const result = await handlers(f)[ACQUISITION_JOB_TYPES.reconcile]!(
      context({}),
    );
    expect(result).toMatchObject({ retried: 0, awaitingAlternative: 1 });
    expect(f.updates).toHaveLength(0);
  });

  it("does not act on a release whose failure has no class recorded", async () => {
    const f = fakes([summary({ state: "failed" })]);
    await handlers(f)[ACQUISITION_JOB_TYPES.reconcile]!(context({}));
    expect(f.updates).toHaveLength(0);
  });

  it("does not count a retry another worker already took", async () => {
    // The conditional update matched no row, so this pass changed nothing.
    const f = fakes([
      summary({ state: "failed", failureClass: "disk-full", attempt: 1 }),
    ]);
    f.repository.update = async () => false;
    const result = await handlers(f)[ACQUISITION_JOB_TYPES.reconcile]!(
      context({}),
    );
    expect(result).toMatchObject({ retried: 0 });
  });

  it("touches nothing that is not a failure", async () => {
    const f = fakes([
      summary({ state: "downloading" }),
      summary({ id: "a2", state: "downloaded" }),
      summary({ id: "a3", state: "cancelled" }),
    ]);
    await handlers(f)[ACQUISITION_JOB_TYPES.reconcile]!(context({}));
    expect(f.updates).toHaveLength(0);
  });
});
