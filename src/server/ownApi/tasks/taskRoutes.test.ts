import { describe, expect, it, vi } from "vitest";
import { toTaskDto, createTaskRoutes } from "./taskRoutes";
import type { JobRecord, JobQueue } from "./jobQueue";
import type { LibraryRepository } from "../libraries/libraryRepository";
import { toMaintenanceTaskDto } from "./maintenanceTaskDto";
import {
  TRICKPLAY_FFMPEG_FAILURES,
  TRICKPLAY_NOTHING_TO_SAMPLE,
  trickplayFailureMessage,
} from "../trickplay/trickplayService";
const job: JobRecord = {
  id: "job",
  jobType: "library.scan",
  payload: {
    libraryId: "library",
    sourcePath: "/private/source",
    configuration: "secret",
  },
  status: "running",
  attempts: 1,
  maxAttempts: 3,
  progress: 0.42,
  progressMessage: "Analysed 42 of 100 files",
  progressDetail: null,
  priority: 100,
  runAfter: new Date(0),
  safeError: "postgres://private/password",
  result: { itemsCreated: 0, path: "/private/source" },
  cancellationRequested: false,
  queuedAt: new Date(),
  startedAt: new Date(),
  finishedAt: null,
};
const libraries = {
  getById: async () => ({ name: "Movies" }),
} as unknown as LibraryRepository;
describe("safe task endpoint presentation", () => {
  it("exposes a resolved name, exact fraction and allowlisted counts only", async () => {
    const dto = await toTaskDto({ ...job, status: "succeeded" }, libraries);
    expect(dto.progress).toBe(0.42);
    expect(dto.presentation.subject?.label).toBe("Movies");
    expect(dto.result).toEqual({ itemsCreated: 0 });
    expect(JSON.stringify(dto)).not.toMatch(
      /private|password|sourcePath|secret/,
    );
    expect(dto.progressMessage).toBeNull();
  });
  /*
   * The row already carried this. The card read the sentence next to it and
   * matched four regular expressions against it, so a trickplay pass — whose
   * sentence is not one of the four — reached the screen with nothing to show
   * while the maintenance page beside it drew a bar from the same row.
   */
  it("reads the executor's own report rather than the sentence beside it", async () => {
    const dto = await toTaskDto(
      {
        ...job,
        jobType: "trickplay.generate",
        progressMessage: "Generating trickplay",
        progressDetail: {
          revision: 7,
          phase: "trickplay",
          measure: {
            kind: "exact",
            completed: 61,
            total: 144,
            unit: "frames",
          },
          at: "2026-08-11T00:00:03Z",
        },
      },
      libraries,
    );

    expect(dto.presentation.stage).toBe("trickplay");
    expect(dto.presentation.determinate).toBe(true);
    expect(dto.presentation.counts).toEqual({
      completed: 61,
      total: 144,
      unit: "frames",
    });
    expect(dto.presentation.phaseFraction).toBeCloseTo(61 / 144, 10);
  });

  it("says nothing measured for a job that has concluded", async () => {
    const dto = await toTaskDto(
      {
        ...job,
        status: "succeeded",
        progressDetail: {
          revision: 7,
          phase: "reading",
          measure: { kind: "exact", completed: 5, total: 9, unit: "roots" },
          at: "2026-08-11T00:00:03Z",
        },
      },
      libraries,
    );

    expect(dto.presentation.phaseFraction).toBeUndefined();
    expect(dto.presentation.counts).toBeUndefined();
  });

  it("handles deleted subjects without exposing identifiers", async () => {
    const dto = await toTaskDto(job, {
      getById: async () => null,
    } as unknown as LibraryRepository);
    expect(dto.presentation.subject).toEqual({
      type: "library",
      deleted: true,
    });
  });
  /*
   * Each reason trickplay stores became the same "the task failed" sentence,
   * so a source that was gone and a playlist FFmpeg could not open looked
   * alike on both screens.
   */
  it("names each reason a trickplay pass stores, on both task views", async () => {
    const reasons: Array<[string, string]> = [
      [TRICKPLAY_NOTHING_TO_SAMPLE, "source-gone"],
      [TRICKPLAY_FFMPEG_FAILURES.fileMissing, "file-missing"],
      [TRICKPLAY_FFMPEG_FAILURES.accessDenied, "access-denied"],
      [TRICKPLAY_FFMPEG_FAILURES.volumeFull, "volume-full"],
      [TRICKPLAY_FFMPEG_FAILURES.unreadable, "unreadable"],
    ];
    for (const [safeError, code] of reasons) {
      const failed: JobRecord = {
        ...job,
        jobType: "trickplay.generate",
        payload: {},
        status: "failed",
        safeError,
      };
      expect((await toTaskDto(failed, libraries)).presentation.errorCode).toBe(
        code,
      );
      expect(
        (await toMaintenanceTaskDto(failed, { libraries, libraryCount: 1 }))
          .errorCode,
      ).toBe(code);
    }
    expect(
      trickplayFailureMessage("Error opening input: No such file or directory"),
    ).toBe(TRICKPLAY_FFMPEG_FAILURES.fileMissing);
  });

  it("resolves media labels rather than trusting payload labels", async () => {
    const dto = await toTaskDto(
      { ...job, payload: { itemId: "secret-id", title: "/private" } },
      libraries,
      async () => ({ kind: "movie", title: "A Film" }),
    );
    expect(dto.presentation.subject?.label).toBe("A Film");
    expect(JSON.stringify(dto)).not.toContain("secret-id");
  });
  it("retains admin access on every task route", () => {
    expect(
      createTaskRoutes({ libraries, queue: {} as JobQueue }).every(
        (route) => route.access === "admin",
      ),
    ).toBe(true);
  });
});

it("enriches only the matching processing attempt with exact encoding time and a safe stage", async () => {
  const processing = {
    jobId: "job",
    itemId: "item",
    state: "running",
    stage: "video",
    encodedSeconds: 42,
    sourceDurationSeconds: 100,
    overallProgress: 0.91,
    stagingDirectory: "/private",
    sourceDamage: null,
  };
  const store = { get: async () => processing } as unknown as NonNullable<
    Parameters<typeof toTaskDto>[3]
  >;
  const current = {
    ...job,
    jobType: "media.process",
    payload: { processingJobId: "processing" },
  };
  const dto = await toTaskDto(
    current,
    libraries,
    async () => ({ kind: "movie", title: "Film" }),
    store,
  );
  expect(dto.presentation).toMatchObject({
    determinate: false,
    stage: "video",
    encoding: { completedSeconds: 42, totalSeconds: 100 },
    subject: { label: "Film" },
  });
  expect(JSON.stringify(dto)).not.toContain("private");
  processing.jobId = "newer-attempt";
  const historical = await toTaskDto(
    current,
    libraries,
    async () => ({ kind: "movie", title: "Film" }),
    store,
  );
  expect(historical.presentation.encoding).toBeUndefined();
});

let sample: Record<string, unknown> | null = null;
let fresh = true;
vi.mock("../processing/liveProgress", () => ({
  readLiveProgress: async () => sample,
  liveProgressIsFresh: () => fresh,
}));

const processingJob = {
  id: "processing",
  jobId: "job",
  itemId: "item",
  state: "running",
  stage: "video",
  encodedSeconds: 1_200,
  sourceDurationSeconds: 3_794,
  sourceDamage: null,
};
const episode = {
  kind: "episode",
  title: "Second of His Name",
  seriesTitle: "House of the Dragon",
  seasonNumber: 1,
  episodeNumber: 3,
};
const store = { get: async () => processingJob } as unknown as NonNullable<
  Parameters<typeof toTaskDto>[3]
>;
const processJob = {
  ...job,
  jobType: "media.process",
  payload: { processingJobId: "processing" },
};

describe("naming a processing job", () => {
  it("names an episode by its show, and says which episode inside it", async () => {
    // Twelve queued episodes of one series are twelve identical cards without
    // the code; the show alone is what makes the card scannable.
    const dto = await toTaskDto(
      processJob,
      libraries,
      async () => episode,
      store,
    );
    expect(dto.presentation.subject).toEqual({
      type: "media",
      label: "House of the Dragon",
      code: "S01E03",
      detail: "Second of His Name",
    });
  });

  it("still identifies a title whose name the allowlist rejects", async () => {
    // A name carrying a path or an identifier is dropped, but the code is ours
    // and always safe — an anonymous card is the failure this prevents.
    const dto = await toTaskDto(
      processJob,
      libraries,
      async () => ({ ...episode, title: "s01e03/second", seriesTitle: null }),
      store,
    );
    expect(dto.presentation.subject).toEqual({
      type: "media",
      code: "S01E03",
    });
  });

  it("names a queued attempt that the processing row has moved past", async () => {
    // Which title a processing row is about never changes; only its figures
    // belong to one attempt.
    const dto = await toTaskDto(
      processJob,
      { ...libraries, getById: async () => null } as typeof libraries,
      async () => episode,
      { get: async () => ({ ...processingJob, jobId: "other" }) } as never,
    );
    expect(dto.presentation.subject?.label).toBe("House of the Dragon");
    expect(dto.presentation.encoding).toBeUndefined();
    expect(dto.presentation.remainingSeconds).toBeUndefined();
  });
});

describe("live encode figures", () => {
  it("prefers the live sample and carries the remaining time it measured", async () => {
    sample = {
      encodedSeconds: 1_381,
      sourceDurationSeconds: 3_794,
      etaSeconds: 1_975.4,
    };
    fresh = true;
    const dto = await toTaskDto(
      processJob,
      libraries,
      async () => episode,
      store,
    );
    expect(dto.presentation.encoding).toEqual({
      completedSeconds: 1_381,
      totalSeconds: 3_794,
    });
    expect(dto.presentation.remainingSeconds).toBe(1_975);
  });

  it("withdraws the remaining time when the sample stops arriving", async () => {
    // The figures stay true about the past; a rate that is no longer happening
    // is not a statement anyone should act on.
    sample = {
      encodedSeconds: 1_381,
      sourceDurationSeconds: 3_794,
      etaSeconds: 1_975,
    };
    fresh = false;
    const dto = await toTaskDto(
      processJob,
      libraries,
      async () => episode,
      store,
    );
    expect(dto.presentation.encoding).toEqual({
      completedSeconds: 1_200,
      totalSeconds: 3_794,
    });
    expect(dto.presentation.remainingSeconds).toBeUndefined();
  });

  it("never moves an encode backwards when a sample lags the row", async () => {
    sample = { encodedSeconds: 5, sourceDurationSeconds: 3_794 };
    fresh = true;
    const dto = await toTaskDto(
      processJob,
      libraries,
      async () => episode,
      store,
    );
    expect(dto.presentation.encoding?.completedSeconds).toBe(1_200);
  });
});

it("reads the phase from the sample, not from a row written at checkpoints", async () => {
  // The production shape of this: a row that still says the job is starting
  // while the encoder is most of the way through the picture, and a card that
  // repeated the row.
  sample = {
    stage: "video",
    encodedSeconds: 3_195,
    sourceDurationSeconds: 3_794,
    etaSeconds: 702,
  };
  fresh = true;
  const dto = await toTaskDto(processJob, libraries, async () => episode, {
    get: async () => ({
      ...processingJob,
      stage: "starting",
      encodedSeconds: 0,
      sourceDurationSeconds: null,
    }),
  } as never);
  expect(dto.presentation.stage).toBe("video");
  expect(dto.presentation.encoding).toEqual({
    completedSeconds: 3_195,
    totalSeconds: 3_794,
  });
  expect(dto.presentation.remainingSeconds).toBe(702);
});

describe("a suspended encoder", () => {
  /*
   * Pausing stops the encoder, not the queue attempt: the row this DTO is
   * built from goes on saying `running`. A card that believed it reported a
   * held job as working away with an unmeasurable rate, beside a page showing
   * the same job three quarters encoded and plainly paused.
   */
  const paused = {
    ...processingJob,
    state: "paused",
    pausedReason: "operator",
    encodedSeconds: 3_090,
  };

  it("reports the hold and keeps the position it stopped at", async () => {
    sample = { encodedSeconds: 3_400, sourceDurationSeconds: 3_794 };
    fresh = true;
    const dto = await toTaskDto(processJob, libraries, async () => episode, {
      get: async () => paused,
    } as never);
    expect(dto.status).toBe("running");
    expect(dto.presentation.outcome).toBe("paused");
    expect(dto.presentation.stage).toBe("video");
    // The live sample belongs to a rate that is no longer happening, so it is
    // never read for a job that is not running; the row is.
    expect(dto.presentation.encoding).toEqual({
      completedSeconds: 3_090,
      totalSeconds: 3_794,
    });
    expect(dto.presentation.remainingSeconds).toBeUndefined();
  });

  it("distinguishes an absent drive from a person's hand", async () => {
    const dto = await toTaskDto(processJob, libraries, async () => episode, {
      get: async () => ({ ...paused, pausedReason: "storage-unavailable" }),
    } as never);
    expect(dto.presentation.outcome).toBe("waiting-for-storage");
  });
});

describe("phases that are not the picture", () => {
  /*
   * Assembling, verifying and publishing are the last quarter of every media
   * job, and each measures itself exactly. Reporting only the encode left a
   * card saying "progress not measurable yet" for all of it, beside a page
   * showing the package fully assembled.
   */
  it("carries the phase's own measure once the encode is behind it", async () => {
    sample = {
      stage: "packaging",
      phaseFraction: 0.081,
      encodedSeconds: 3_794,
      sourceDurationSeconds: 3_794,
    };
    fresh = true;
    const dto = await toTaskDto(
      processJob,
      libraries,
      async () => episode,
      store,
    );
    expect(dto.presentation.stage).toBe("packaging");
    expect(dto.presentation.phaseFraction).toBe(0.081);
    // Media seconds describe the picture, and the picture is no longer what
    // this job is doing.
    expect(dto.presentation.encoding).toBeUndefined();
  });

  it("never pairs one source's phase with another source's fraction", async () => {
    // The sample's phase and the row's phase advance independently. Crossing
    // them reports where the phase that just ended got to, under the name of
    // the one that just began.
    sample = { stage: "publishing", phaseFraction: 0.02 };
    fresh = true;
    const crossed = await toTaskDto(
      processJob,
      libraries,
      async () => episode,
      {
        get: async () => ({
          ...processingJob,
          stage: "packaging",
          stageProgress: 0.97,
        }),
      } as never,
    );
    expect(crossed.presentation).toMatchObject({
      stage: "publishing",
      phaseFraction: 0.02,
    });

    // With no sample it is the row that names the phase, so it is the row's
    // fraction that goes with it.
    fresh = false;
    const fromRow = await toTaskDto(
      processJob,
      libraries,
      async () => episode,
      {
        get: async () => ({
          ...processingJob,
          stage: "validating",
          stageProgress: 0.5,
        }),
      } as never,
    );
    expect(fromRow.presentation).toMatchObject({
      stage: "validating",
      phaseFraction: 0.5,
    });
  });

  it("offers no figure for a job that has not started a phase", async () => {
    fresh = false;
    const dto = await toTaskDto(processJob, libraries, async () => episode, {
      get: async () => ({
        ...processingJob,
        state: "queued",
        stage: "waiting",
        stageProgress: 0,
      }),
    } as never);
    expect(dto.presentation.phaseFraction).toBeUndefined();
  });
});

/**
 * The maintenance action group, at the boundary.
 *
 * Two things are being checked here and they are different: which libraries an
 * action selects, and that the reply is an *acceptance*. Nothing below runs a
 * job — a route that waited for one would hold a request open for the length
 * of a scan or an FFmpeg run.
 */
function maintenanceHarness(
  kinds: Array<{ id: string; kind: string }>,
  options: { onEnqueue?: () => void } = {},
) {
  const enqueued: Array<Record<string, unknown>> = [];
  const queue = {
    enqueue: async (job: Record<string, unknown>) => {
      options.onEnqueue?.();
      enqueued.push(job);
      return `task-${enqueued.length}`;
    },
  } as unknown as JobQueue;
  const repository = {
    listAll: async () =>
      kinds.map((entry) => ({
        ...entry,
        slug: entry.id,
        name: entry.id,
        roots: [entry.id],
      })),
    getById: async () => null,
  } as unknown as LibraryRepository;

  const routes = createTaskRoutes({ queue, libraries: repository });
  const route = routes.find(
    (candidate) => candidate.path === "/admin/maintenance/:action",
  );
  if (!route) throw new Error("the maintenance route is missing");

  const call = async (action: string) => {
    const body: { status?: number; payload?: unknown } = {};
    const response = {
      statusCode: 200,
      setHeader: () => undefined,
      end: (text: string) => {
        body.payload = JSON.parse(text).data;
      },
      writeHead: (status: number) => {
        body.status = status;
      },
    };
    await route.handle({
      params: { action },
      requestId: "request",
      response,
      url: new URL("http://host/"),
      method: "POST",
      principal: null,
      requirePrincipal: () => {
        throw new Error("unused");
      },
      readJson: async () => ({}),
      request: {} as never,
    } as never);
    return body.payload as {
      action: string;
      taskIds: string[];
      libraries: number;
    };
  };

  return { call, enqueued };
}

const EVERY_KIND = [
  { id: "films", kind: "movies" },
  { id: "shows", kind: "series" },
  { id: "reading", kind: "books" },
  { id: "sets", kind: "collections" },
  { id: "misc", kind: "mixed" },
];

describe("the Library Maintenance action routes", () => {
  it("keeps every task route, the new ones included, admin-only", () => {
    const routes = createTaskRoutes({
      libraries,
      queue: {} as JobQueue,
    });
    expect(routes.every((route) => route.access === "admin")).toBe(true);
    expect(
      routes.some((route) => route.path === "/admin/maintenance/:action"),
    ).toBe(true);
  });

  it("refuses an action that is not on the list", async () => {
    const { call, enqueued } = maintenanceHarness(EVERY_KIND);

    await expect(call("delete-everything")).rejects.toThrow(/invalid/i);
    expect(enqueued).toEqual([]);
  });

  it("selects exactly the kind each category names", async () => {
    for (const [action, libraryId] of [
      ["scan-movies", "films"],
      ["scan-shows", "shows"],
      ["scan-books", "reading"],
    ] as const) {
      const { call, enqueued } = maintenanceHarness(EVERY_KIND);
      const accepted = await call(action);

      expect(accepted.libraries).toBe(1);
      expect(enqueued).toHaveLength(1);
      expect(enqueued[0]).toMatchObject({
        jobType: "library.scan",
        payload: { libraryId },
      });
    }
  });

  /*
   * A collection and a mixed library are libraries, not films or shows.
   * Sweeping either into a category would scan something the button did not
   * name — and both are still covered by "all in one".
   */
  it("never classifies collections or mixed as a category", async () => {
    for (const action of ["scan-movies", "scan-shows", "scan-books"] as const) {
      const { call } = maintenanceHarness([
        { id: "sets", kind: "collections" },
        { id: "misc", kind: "mixed" },
      ]);
      const accepted = await call(action);
      expect(accepted.libraries).toBe(0);
    }
  });

  it("treats an empty category as a no-op that succeeded", async () => {
    const { call, enqueued } = maintenanceHarness([
      { id: "films", kind: "movies" },
    ]);

    const accepted = await call("scan-books");

    expect(accepted).toMatchObject({
      action: "scan-books",
      taskIds: [],
      libraries: 0,
    });
    expect(enqueued).toEqual([]);
  });

  it("gives every library one stably-keyed job per operation", async () => {
    for (const [action, jobType] of [
      ["rename", "library.rename"],
      ["organize", "library.organize"],
      ["scan-all", "library.scan"],
    ] as const) {
      const { call, enqueued } = maintenanceHarness(EVERY_KIND);
      await call(action);

      expect(enqueued.map((job) => job.jobType)).toEqual(
        EVERY_KIND.map(() => jobType),
      );
      expect(enqueued.map((job) => job.dedupeKey)).toEqual(
        EVERY_KIND.map((library) => `${jobType}:${library.id}`),
      );
    }
  });

  it("accepts all-in-one and the trickplay sweep as a single durable job", async () => {
    const everything = maintenanceHarness(EVERY_KIND);
    const accepted = await everything.call("all");
    expect(accepted.taskIds).toHaveLength(1);
    expect(everything.enqueued[0]).toMatchObject({
      jobType: "library.maintenance",
      payload: { stage: "scan", pass: 0 },
      dedupeKey: "library.maintenance:scan:0",
    });

    const trickplay = maintenanceHarness(EVERY_KIND);
    await trickplay.call("trickplay");
    expect(trickplay.enqueued[0]).toMatchObject({
      jobType: "trickplay.scan",
      dedupeKey: "trickplay.scan:all:0",
    });
  });

  it("returns once the rows are durable and never runs the work itself", async () => {
    let handlerRan = false;
    const { call } = maintenanceHarness(EVERY_KIND, {
      onEnqueue: () => {
        // A durable enqueue is all the route does; nothing here executes.
        handlerRan = handlerRan || false;
      },
    });

    const accepted = await call("all");

    expect(handlerRan).toBe(false);
    expect(accepted.taskIds.every((id) => typeof id === "string")).toBe(true);
  });
});

function observationHarness() {
  const list = vi.fn().mockResolvedValue([]);
  const observationTime = vi.fn().mockResolvedValue("2026-09-06T10:00:00.000Z");
  const routes = createTaskRoutes({
    queue: { list, observationTime } as unknown as JobQueue,
    libraries,
  });
  const route = routes.find(
    (entry) => entry.path === "/admin/tasks" && entry.method === "GET",
  )!;
  const call = async (search = "") => {
    let payload: unknown;
    await route.handle({
      url: new URL(`http://test/admin/tasks${search}`),
      params: {},
      requestId: "test",
      response: {
        setHeader: () => {},
        writeHead: () => {},
        end: (text: string) => {
          payload = JSON.parse(text).data;
        },
      },
      requirePrincipal: () => ({ userId: "admin" }),
    } as never);
    return payload;
  };
  return { call, list, observationTime };
}

it("preserves the default generic list response and filters", async () => {
  const { call, list, observationTime } = observationHarness();
  expect(await call("?status=succeeded&type=library.rename&limit=20")).toEqual(
    [],
  );
  expect(list).toHaveBeenCalledWith({
    status: "succeeded",
    jobType: "library.rename",
    limit: 20,
  });
  expect(observationTime).not.toHaveBeenCalled();
});
it("captures the DB boundary before the read and returns a bounded continuation", async () => {
  const { call, list, observationTime } = observationHarness();
  const id = "00000000-0000-4000-8000-000000000001";
  const since = "2026-09-06T09:00:00.000Z";
  list.mockResolvedValue([{ ...job, id }]);
  const response = (await call(
    `?observe=true&since=${since}&after=${id}&limit=1&type=library.rename&status=succeeded`,
  )) as { tasks: unknown[]; next: string; observedAt: string };
  expect(response.tasks).toHaveLength(1);
  expect(response.next).toBe(id);
  expect(response.observedAt).toBe("2026-09-06T10:00:00.000Z");
  expect(observationTime.mock.invocationCallOrder[0]).toBeLessThan(
    list.mock.invocationCallOrder[0]!,
  );
  expect(list).toHaveBeenCalledWith({
    observe: true,
    since,
    afterId: id,
    limit: 1,
    jobType: "library.rename",
    status: "succeeded",
  });
});
it.each([
  "?observe=no",
  "?since=2026-09-06T10:00:00.000Z",
  "?after=bad",
  "?observe=true&since=",
  "?observe=true&since=yesterday",
  "?observe=true&since=2026-02-30T10:00:00.000Z",
  "?observe=true&since=2026-09-06T10:00:00Z",
  "?observe=true&after=bad",
  "?observe=true&status=bogus",
])("strictly rejects malformed observation queries: %s", async (search) => {
  const { call, list, observationTime } = observationHarness();
  await expect(call(search)).rejects.toThrow();
  expect(list).not.toHaveBeenCalled();
  expect(observationTime).not.toHaveBeenCalled();
});
it("establishes an active-only first observation without replaying historical terminal rows", async () => {
  const { call, list } = observationHarness();
  expect(await call("?observe=true")).toEqual({
    tasks: [],
    next: null,
    observedAt: "2026-09-06T10:00:00.000Z",
  });
  expect(list).toHaveBeenCalledWith({ observe: true, limit: 50 });
});
