import { describe, expect, it, vi } from "vitest";
import { DeferredJobError, PermanentJobError } from "../tasks/worker";
import { createSubtitleJobHandlers, SUBTITLE_JOB_TYPES } from "./subtitleJobs";
import type {
  SubtitleRepository,
  SubtitleAttemptRow,
} from "./subtitleRepository";
import type { SubtitleService } from "./subtitleService";

/**
 * The handlers, against fakes.
 *
 * What matters here is not that a subtitle is found — that is the pipeline's
 * business and is tested there — but that the queue is told the truth: which
 * failures are permanent, which are worth deferring, and above all that a
 * provider wanting a person is neither of those.
 */

const ATTEMPT = "11111111-2222-4333-8444-555555555555";

const attemptRow = (
  over: Partial<SubtitleAttemptRow> = {},
): SubtitleAttemptRow =>
  ({
    id: ATTEMPT,
    wantId: "want",
    state: "wanted",
    attempt: 0,
    providerId: null,
    candidateId: null,
    score: null,
    failureClass: null,
    failureDetail: null,
    awaitingProviderId: null,
    runAfter: null,
    ...over,
  }) as SubtitleAttemptRow;

function harness(
  over: {
    run?: SubtitleService["run"];
    getAttempt?: SubtitleRepository["getAttempt"];
    uncertainAttempts?: SubtitleRepository["uncertainAttempts"];
  } = {},
) {
  const run = over.run ?? vi.fn(async () => ({ state: "installed" }));
  const service = { run } as unknown as SubtitleService;
  const repository = {
    getAttempt: over.getAttempt ?? vi.fn(async () => attemptRow()),
    uncertainAttempts: over.uncertainAttempts ?? vi.fn(async () => []),
  } as unknown as SubtitleRepository;
  const reportProgress = vi.fn(async () => {});
  const isCancelled = vi.fn(async () => false);
  const handlers = createSubtitleJobHandlers(service, repository);
  const invoke = (type: string, payload: Record<string, unknown> = {}) =>
    handlers[type]!({
      job: { payload },
      reportProgress,
      isCancelled,
    } as unknown as Parameters<(typeof handlers)[string]>[0]);
  return { handlers, invoke, run, repository, reportProgress, isCancelled };
}

describe("what the queue is told", () => {
  it("registers exactly the three job types", () => {
    const { handlers } = harness();
    expect(Object.keys(handlers).sort()).toEqual(
      Object.values(SUBTITLE_JOB_TYPES).sort(),
    );
  });

  /*
   * A payload naming no attempt, or one shaped like something else, cannot
   * become valid by being retried. Permanent rather than deferred, so it stops
   * rather than occupying the queue.
   */
  it.each([
    [{}],
    [{ attemptId: 42 }],
    [{ attemptId: "not-a-uuid" }],
    [{ attemptId: "" }],
  ])("refuses %j permanently", async (payload) => {
    const { invoke } = harness();
    await expect(
      invoke(SUBTITLE_JOB_TYPES.run, payload),
    ).rejects.toBeInstanceOf(PermanentJobError);
  });

  it("refuses an attempt that no longer exists, permanently", async () => {
    const { invoke } = harness({ getAttempt: vi.fn(async () => null) });
    await expect(
      invoke(SUBTITLE_JOB_TYPES.run, { attemptId: ATTEMPT }),
    ).rejects.toBeInstanceOf(PermanentJobError);
  });

  /*
   * Another worker owns this media file. That is a moment, not a fault, so the
   * queue is asked to come back rather than being told the work failed.
   */
  it("defers rather than fails when another worker holds the file", async () => {
    const { invoke } = harness({
      run: vi.fn(async () => ({ state: "busy" })),
    });
    const error = await invoke(SUBTITLE_JOB_TYPES.run, {
      attemptId: ATTEMPT,
    }).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(DeferredJobError);
    expect((error as DeferredJobError).retryAfterMs).toBeGreaterThan(0);
  });
});

describe("a provider that wants a person", () => {
  /*
   * The defining behaviour of this phase. `needs-authentication` is a resumable
   * state, so the handler returns it as a result. Throwing would mark the job
   * failed, spend a retry, and — with a queue that backs off — turn a person's
   * response time into a retry storm.
   */
  it("returns needs-authentication as a result, never as a failure", async () => {
    const { invoke, run } = harness({
      run: vi.fn(async () => ({
        state: "needs-authentication",
        providerId: "turkcealtyazilar",
      })),
    });
    const result = await invoke(SUBTITLE_JOB_TYPES.run, { attemptId: ATTEMPT });
    expect(result).toMatchObject({ state: "needs-authentication" });
    expect(run).toHaveBeenCalledOnce();
  });

  it("carries no session material in what it returns", async () => {
    const { invoke } = harness({
      run: vi.fn(async () => ({
        state: "needs-authentication",
        providerId: "turkcealtyazilar",
        reason: "A session is required.",
      })),
    });
    const result = await invoke(SUBTITLE_JOB_TYPES.run, { attemptId: ATTEMPT });
    expect(JSON.stringify(result)).not.toMatch(
      /cookie|cf_clearance|authorization|set-cookie/i,
    );
  });

  /*
   * Resuming is the same work with the previous stage remembered, which is why
   * it is one implementation and a flag rather than a second handler that could
   * drift from the first.
   */
  it("resumes through the same path, saying so", async () => {
    const { invoke, run } = harness();
    await invoke(SUBTITLE_JOB_TYPES.resume, { attemptId: ATTEMPT });
    expect(run).toHaveBeenCalledWith(
      ATTEMPT,
      expect.objectContaining({ resume: true }),
    );
  });

  it("does not resume when it was not asked to", async () => {
    const { invoke, run } = harness();
    await invoke(SUBTITLE_JOB_TYPES.run, { attemptId: ATTEMPT });
    expect(run).toHaveBeenCalledWith(
      ATTEMPT,
      expect.objectContaining({ resume: false }),
    );
  });

  it("passes an explicit replacement request through, and defaults it off", async () => {
    const { invoke, run } = harness();
    await invoke(SUBTITLE_JOB_TYPES.run, { attemptId: ATTEMPT, replace: true });
    expect(run).toHaveBeenCalledWith(
      ATTEMPT,
      expect.objectContaining({ replace: true }),
    );
    await invoke(SUBTITLE_JOB_TYPES.run, { attemptId: ATTEMPT });
    expect(run).toHaveBeenLastCalledWith(
      ATTEMPT,
      expect.objectContaining({ replace: false }),
    );
  });
});

describe("reporting what it is doing", () => {
  it("reports each phase with a structured measure", async () => {
    const { invoke, reportProgress } = harness({
      run: vi.fn(
        async (_id: string, options?: { progress?: (e: unknown) => void }) => {
          options?.progress?.({ phase: "searching", completed: 1, total: 3 });
          options?.progress?.({ phase: "installing", completed: 1, total: 1 });
          return { state: "installed" };
        },
      ) as unknown as SubtitleService["run"],
    });
    await invoke(SUBTITLE_JOB_TYPES.run, { attemptId: ATTEMPT });
    expect(reportProgress).toHaveBeenCalledWith(
      0,
      "Subtitle searching",
      expect.objectContaining({
        phase: "selecting",
        measure: expect.objectContaining({ completed: 1, total: 3 }),
      }),
    );
    expect(reportProgress).toHaveBeenLastCalledWith(
      0,
      "Subtitle installing",
      expect.objectContaining({
        measure: expect.objectContaining({ unit: "files" }),
      }),
    );
  });
});

describe("reconciling what a crash left behind", () => {
  it("walks every uncertain attempt", async () => {
    const rows = [attemptRow({ id: "a" }), attemptRow({ id: "b" })];
    const { invoke, run } = harness({
      uncertainAttempts: vi.fn(async () => rows),
    });
    const result = await invoke(SUBTITLE_JOB_TYPES.reconcile);
    expect(result).toMatchObject({ examined: 2 });
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("stops when it is cancelled, without pretending it finished", async () => {
    const rows = [attemptRow({ id: "a" }), attemptRow({ id: "b" })];
    const isCancelled = vi
      .fn<() => Promise<boolean>>()
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true);
    const run = vi.fn(async () => ({ state: "installed" }));
    const handlers = createSubtitleJobHandlers(
      { run } as unknown as SubtitleService,
      {
        getAttempt: async () => attemptRow(),
        uncertainAttempts: async () => rows,
      } as unknown as SubtitleRepository,
    );
    const result = await handlers[SUBTITLE_JOB_TYPES.reconcile]!({
      job: { payload: {} },
      reportProgress: async () => {},
      isCancelled,
    } as unknown as Parameters<(typeof handlers)[string]>[0]);
    expect(result).toMatchObject({ examined: 1 });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("does nothing when a crash left nothing behind", async () => {
    const { invoke, run } = harness();
    expect(await invoke(SUBTITLE_JOB_TYPES.reconcile)).toMatchObject({
      examined: 0,
    });
    expect(run).not.toHaveBeenCalled();
  });
});

describe("a search every provider rate-limited", () => {
  function limited(retryAfterMs: number, open: string | null = null) {
    const run = vi.fn(async () => ({
      state: "failed",
      failure: "provider-rate-limited",
      retryAfterMs,
    }));
    const repository = {
      getAttempt: vi.fn(async () => attemptRow()),
      openAttempt: vi.fn(async () => open),
      beginAttempt: vi.fn(async () => attemptRow({ id: "next-attempt" })),
    } as unknown as SubtitleRepository;
    const runLater = vi.fn(async () => {});
    const handlers = createSubtitleJobHandlers(
      { run } as unknown as SubtitleService,
      repository,
      undefined,
      runLater,
    );
    const invoke = () =>
      handlers[SUBTITLE_JOB_TYPES.run]!({
        job: { payload: { attemptId: ATTEMPT } },
        reportProgress: vi.fn(async () => {}),
        isCancelled: vi.fn(async () => false),
      } as unknown as Parameters<(typeof handlers)[string]>[0]);
    return { invoke, repository, runLater };
  }

  it("starts a fresh attempt for when the provider renews", async () => {
    const { invoke, repository, runLater } = limited(3 * 60 * 60 * 1000);
    const started = Date.now();
    await expect(invoke()).resolves.toMatchObject({
      retryAttemptId: "next-attempt",
    });
    expect(repository.beginAttempt).toHaveBeenCalledWith("want");
    const [attemptId, runAfter] = runLater.mock.calls[0] as unknown as [
      string,
      Date,
    ];
    expect(attemptId).toBe("next-attempt");
    expect(runAfter.getTime() - started).toBeGreaterThanOrEqual(
      3 * 60 * 60 * 1000,
    );
    expect(runAfter.getTime() - started).toBeLessThan(
      3 * 60 * 60 * 1000 + 5_000,
    );
  });

  it("waits at least a minute, and never longer than a day and an hour", async () => {
    const soon = limited(0);
    await soon.invoke();
    const [, early] = soon.runLater.mock.calls[0] as unknown as [string, Date];
    expect(early.getTime() - Date.now()).toBeGreaterThan(55_000);
    const far = limited(30 * 24 * 60 * 60 * 1000);
    await far.invoke();
    const [, late] = far.runLater.mock.calls[0] as unknown as [string, Date];
    expect(late.getTime() - Date.now()).toBeLessThanOrEqual(
      25 * 60 * 60 * 1000,
    );
  });

  it("leaves a want alone that already has an attempt under way", async () => {
    const { invoke, repository, runLater } = limited(60_000, "other-attempt");
    await invoke();
    expect(repository.beginAttempt).not.toHaveBeenCalled();
    expect(runLater).not.toHaveBeenCalled();
  });
});
