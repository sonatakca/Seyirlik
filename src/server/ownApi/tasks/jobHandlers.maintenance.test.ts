import { describe, expect, it } from "vitest";
import type {
  CatalogueRepository,
  ProcessableTitleRow,
} from "../catalogue/catalogueRepository";
import type { LibraryRepository } from "../libraries/libraryRepository";
import type { CatalogueScanStore } from "../scanner/reconciler";
import type { OrganizerFileSystem } from "../scanner/organizeLibrary";
import type {
  TrickplayFrameProgress,
  TrickplayService,
} from "../trickplay/trickplayService";
import type { MaintenanceProgressInput } from "../../../lib/maintenance/maintenanceTasks";
import type { EnqueueOptions, JobQueue, JobRecord } from "./jobQueue";
import { createJobHandlers, JOB_TYPES } from "./jobHandlers";

const LIBRARIES = [
  {
    id: "lib-movies",
    slug: "movies",
    name: "Movies",
    kind: "movies" as const,
    roots: ["Movies"],
  },
  {
    id: "lib-series",
    slug: "series",
    name: "Shows",
    kind: "series" as const,
    roots: ["Series"],
  },
  {
    id: "lib-books",
    slug: "books",
    name: "Books",
    kind: "books" as const,
    roots: ["Books"],
  },
  {
    id: "lib-collections",
    slug: "collections",
    name: "Collections",
    kind: "collections" as const,
    roots: ["Collections"],
  },
  {
    id: "lib-mixed",
    slug: "mixed",
    name: "Mixed",
    kind: "mixed" as const,
    roots: ["Mixed"],
  },
];

function recordingQueue(live: Record<string, number> = {}) {
  const enqueued: EnqueueOptions[] = [];
  const queue: JobQueue = {
    enqueue: async (options) => {
      enqueued.push(options);
      return `task-${enqueued.length}`;
    },
    claim: async () => null,
    heartbeat: async () => true,
    defer: async () => undefined,
    countTasks: async () => ({ active: 0, concluded: 0 }),
    reportProgress: async () => undefined,
    complete: async () => undefined,
    fail: async () => undefined,
    requestCancellation: async () => true,
    isCancellationRequested: async () => false,
    get: async () => null,
    findActive: async () => null,
    concludeCancelled: async () => undefined,
    listActive: async () => [],
    listConcluded: async () => [],
    reorderQueue: async () => [],
    observationTime: async () => new Date().toISOString(),
    list: async ({ jobType }) =>
      Array.from({ length: live[jobType ?? ""] ?? 0 }, () => ({}) as JobRecord),
    reclaimExpiredLeases: async () => 0,
  };
  return { queue, enqueued };
}

function emptyScanStore(items: Array<{ id: string; sourceKey: string }> = []) {
  return {
    listItems: async () =>
      items.map((item) => ({
        ...item,
        kind: "movie",
        lockedFields: [],
        missingSince: null,
      })),
    listFiles: async () => [],
    upsertItem: async () => "unused",
    setItemRelations: async () => undefined,
    upsertFile: async () => ({ id: "unused", changed: false }),
    replaceExternalSubtitles: async () => undefined,
    markItemsSeen: async () => undefined,
    markFilesSeen: async () => undefined,
    markItemsMissing: async () => undefined,
    markFilesMissing: async () => undefined,
    deleteItems: async () => undefined,
    deleteFiles: async () => undefined,
    queueProbe: async () => undefined,
    markPackaged: async () => undefined,
    addReleaseParts: async () => undefined,
    refreshItemCounts: async () => undefined,
  } as unknown as CatalogueScanStore;
}

function title(
  overrides: Partial<ProcessableTitleRow> = {},
): ProcessableTitleRow {
  return {
    itemId: "item-1",
    libraryId: "lib-movies",
    kind: "movie",
    title: "Dune",
    sortTitle: "dune",
    productionYear: 2021,
    runtimeMs: null,
    indexNumber: null,
    itemMissingSince: null,
    seriesId: null,
    seriesTitle: null,
    seriesSortTitle: null,
    seriesYear: null,
    seasonId: null,
    seasonTitle: null,
    seasonNumber: null,
    mediaFileId: "file-1",
    relativePath: "Movies/Dune (2021)/src/Dune (2021).mkv",
    container: "mkv",
    sizeBytes: "1",
    mtimeMs: "1",
    fingerprint: "f",
    durationMs: "3600000",
    bitrateBps: null,
    probeState: "probed",
    fileMissingSince: null,
    fileCount: 1,
    videoCodec: "hevc",
    videoProfile: null,
    width: 3840,
    height: 2160,
    frameRate: 24,
    pixelFormat: "yuv420p",
    bitDepth: 8,
    videoRange: "SDR",
    colorTransfer: "bt709",
    colorPrimaries: "bt709",
    colorSpace: "bt709",
    audioTrackCount: 1,
    subtitleTrackCount: 0,
    externalSubtitleCount: 0,
    ...overrides,
  };
}

const NO_VOLUME: OrganizerFileSystem = {
  readDirectory: async () => [],
  createDirectory: async () => undefined,
  move: async () => undefined,
};

function handlers(options: {
  queue: JobQueue;
  titles?: ProcessableTitleRow[];
  generated?: string[];
  mode?: "off" | "plan" | "apply";
  scanStore?: CatalogueScanStore;
}) {
  return createJobHandlers({
    libraries: {
      listAll: async () => LIBRARIES,
      getById: async (id: string) =>
        LIBRARIES.find((entry) => entry.id === id) ?? null,
      provision: async () => LIBRARIES,
    } as unknown as LibraryRepository,
    scanStore: options.scanStore ?? emptyScanStore(),
    fileSystem: {
      readDirectory: async () => [],
      readTextFile: async () => "",
      statFile: async () => ({ size: 0, mtimeMs: 0 }),
    },
    probeService: {
      runBatch: async () => ({ probed: 0, failed: 0, remaining: 0 }),
    } as never,
    queue: options.queue,
    catalogue: {
      listProcessableTitles: async () => options.titles ?? [],
    } as unknown as CatalogueRepository,
    trickplayService: {
      listGeneratedMediaFileIds: async () => new Set(options.generated ?? []),
    } as unknown as TrickplayService,
    ...(options.mode
      ? { organizer: { mode: options.mode, fileSystem: NO_VOLUME } }
      : {}),
  });
}

function run(
  handlerMap: Record<string, (context: never) => unknown>,
  jobType: string,
  payload: Record<string, unknown> = {},
) {
  const handler = handlerMap[jobType];
  if (!handler) throw new Error(`no handler for ${jobType}`);
  return handler({
    job: { id: "job", jobType, payload } as JobRecord,
    reportProgress: async () => undefined,
    isCancelled: async () => false,
  } as never) as Promise<Record<string, unknown>>;
}

describe("the bulk trickplay pass", () => {
  it("enqueues one durable job per eligible title, keyed by the title", async () => {
    const { queue, enqueued } = recordingQueue();

    const result = await run(
      handlers({
        queue,
        titles: [title(), title({ itemId: "item-2", mediaFileId: "file-2" })],
      }),
      JOB_TYPES.trickplayScan,
    );

    expect(result).toMatchObject({ trickplayQueued: 2, trickplayPending: 0 });
    expect(enqueued.map((entry) => [entry.jobType, entry.dedupeKey])).toEqual([
      [JOB_TYPES.trickplayGenerate, `${JOB_TYPES.trickplayGenerate}:item-1`],
      [JOB_TYPES.trickplayGenerate, `${JOB_TYPES.trickplayGenerate}:item-2`],
    ]);
  });

  it("leaves titles that already have sheets alone", async () => {
    const { queue, enqueued } = recordingQueue();

    const result = await run(
      handlers({ queue, titles: [title()], generated: ["file-1"] }),
      JOB_TYPES.trickplayScan,
    );

    expect(result).toMatchObject({ trickplayQueued: 0 });
    expect(enqueued).toEqual([]);
  });

  it("queues a packaged title, and does not wait for a probe it will never get", async () => {
    const { queue, enqueued } = recordingQueue();

    const result = await run(
      handlers({
        queue,
        titles: [
          title({ probeState: "packaged", durationMs: null, width: null }),
        ],
      }),
      JOB_TYPES.trickplayScan,
    );

    expect(result).toMatchObject({ trickplayQueued: 1, trickplayPending: 0 });
    expect(
      enqueued.some((entry) => entry.jobType === JOB_TYPES.trickplayScan),
    ).toBe(false);
  });

  /*
   * The silent-miss case. A pass that ran seconds after a scan sees half the
   * library unprobed; declaring those ineligible and finishing would leave
   * them with no trickplay until somebody pressed the button again.
   */
  it("comes back for titles the probe has not reached yet", async () => {
    const { queue, enqueued } = recordingQueue();

    const result = await run(
      handlers({
        queue,
        titles: [
          title(),
          title({
            itemId: "item-2",
            mediaFileId: "file-2",
            probeState: "pending",
          }),
        ],
      }),
      JOB_TYPES.trickplayScan,
    );

    expect(result).toMatchObject({ trickplayQueued: 1, trickplayPending: 1 });
    const followUp = enqueued.find(
      (entry) => entry.jobType === JOB_TYPES.trickplayScan,
    );
    expect(followUp?.payload).toMatchObject({ pass: 1 });
    // A durable row with a future `run_after`, not a timer held in memory.
    expect(followUp?.runAfter?.getTime()).toBeGreaterThan(Date.now());
    // Its key carries the pass, so it cannot collapse onto the row creating it.
    expect(followUp?.dedupeKey).toBe(`${JOB_TYPES.trickplayScan}:all:1`);
  });

  it("stops coming back once nothing is waiting", async () => {
    const { queue, enqueued } = recordingQueue();

    await run(handlers({ queue, titles: [title()] }), JOB_TYPES.trickplayScan);

    expect(
      enqueued.some((entry) => entry.jobType === JOB_TYPES.trickplayScan),
    ).toBe(false);
  });

  it("never enqueues a title with no playable file or no probed dimensions", async () => {
    const { queue, enqueued } = recordingQueue();

    await run(
      handlers({
        queue,
        titles: [
          title({ itemId: "no-file", mediaFileId: null, relativePath: null }),
          title({ itemId: "gone", fileMissingSince: new Date() }),
          title({ itemId: "no-size", width: null, height: null }),
          title({ itemId: "no-duration", durationMs: null }),
        ],
      }),
      JOB_TYPES.trickplayScan,
    );

    expect(
      enqueued.filter((entry) => entry.jobType === JOB_TYPES.trickplayGenerate),
    ).toEqual([]);
  });
});

/**
 * The one job on the maintenance page that used to be unable to describe
 * itself.
 *
 * A sweep over a library queues one of these per title — two hundred of them
 * on a series library — and every card and every row said the same thing:
 * running, for however long, with no measure. The decoder does know where it
 * is; it just had to be asked to say so.
 */
describe("one title's trickplay pass", () => {
  /** A service whose fake decode announces the frames a test gives it. */
  function generatingService(announce: TrickplayFrameProgress[]) {
    return {
      listGeneratedMediaFileIds: async () => new Set<string>(),
      generateForItem: async (
        _itemId: string,
        options?: { onProgress?: (progress: TrickplayFrameProgress) => void },
      ) => {
        for (const progress of announce) options?.onProgress?.(progress);
        return { spriteCount: 2 };
      },
    } as unknown as TrickplayService;
  }

  function runGenerate(
    trickplayService: TrickplayService,
    reportProgress: (
      progress: number,
      message?: string,
      detail?: MaintenanceProgressInput,
    ) => Promise<void>,
  ) {
    const { queue } = recordingQueue();
    const handler = createJobHandlers({
      libraries: {
        listAll: async () => LIBRARIES,
        getById: async () => LIBRARIES[0] ?? null,
        provision: async () => LIBRARIES,
      } as unknown as LibraryRepository,
      scanStore: emptyScanStore(),
      fileSystem: {
        readDirectory: async () => [],
        readTextFile: async () => "",
        statFile: async () => ({ size: 0, mtimeMs: 0 }),
      },
      probeService: {
        runBatch: async () => ({ probed: 0, failed: 0, remaining: 0 }),
      } as never,
      queue,
      catalogue: {
        listProcessableTitles: async () => [],
      } as unknown as CatalogueRepository,
      trickplayService,
    })[JOB_TYPES.trickplayGenerate];
    if (!handler) throw new Error("no trickplay handler");
    return handler({
      job: {
        id: "job",
        jobType: JOB_TYPES.trickplayGenerate,
        payload: { itemId: "item-1" },
      } as unknown as JobRecord,
      reportProgress,
      isCancelled: async () => false,
    } as never) as Promise<Record<string, unknown>>;
  }

  it("turns the frame the decoder has reached into both halves of a fraction", async () => {
    const details: MaintenanceProgressInput[] = [];

    await runGenerate(
      generatingService([{ completed: 61, total: 144 }]),
      async (_progress, _message, detail) => {
        if (detail) details.push(detail);
      },
    );

    expect(details.at(0)?.measure).toEqual({ kind: "indeterminate" });
    expect(details.at(-1)).toMatchObject({
      phase: "trickplay",
      measure: { kind: "exact", completed: 61, total: 144, unit: "frames" },
    });
  });

  /*
   * The sampler speaks hundreds of times over one episode and the page reads
   * the row every two seconds. Writing each announcement would be database
   * traffic for figures nobody can see, so a burst of them is one write —
   * carrying a position rather than a delta, so nothing between two writes is
   * lost.
   */
  it("writes at a cadence a page can read, not once per frame", async () => {
    const exact: MaintenanceProgressInput[] = [];

    await runGenerate(
      generatingService(
        Array.from({ length: 40 }, (_unused, index) => ({
          completed: index + 1,
          total: 144,
        })),
      ),
      async (_progress, _message, detail) => {
        if (detail?.measure.kind === "exact") exact.push(detail);
      },
    );

    expect(exact).toHaveLength(1);
  });
});

describe("the rename job's configuration contract", () => {
  it("reports itself disabled rather than writing when organisation is off", async () => {
    const { queue, enqueued } = recordingQueue();

    const result = await run(
      handlers({ queue, mode: "off" }),
      JOB_TYPES.libraryRename,
      { libraryId: "lib-movies" },
    );

    expect(result).toMatchObject({ mode: "off", disabled: true });
    expect(enqueued).toEqual([]);
  });

  it("says planning only, and never that files were renamed", async () => {
    const { queue } = recordingQueue();

    const result = await run(
      handlers({ queue, mode: "plan" }),
      JOB_TYPES.libraryRename,
      { libraryId: "lib-movies" },
    );

    expect(result).toMatchObject({ mode: "plan", renamed: 0, planOnly: true });
    expect(result).not.toHaveProperty("applied");
  });

  it("stands down while media processing owns the paths", async () => {
    const { queue } = recordingQueue({ [JOB_TYPES.mediaProcess]: 1 });

    for (const jobType of [
      JOB_TYPES.libraryRename,
      JOB_TYPES.libraryOrganize,
    ]) {
      expect(
        await run(handlers({ queue, mode: "apply" }), jobType, {
          libraryId: "lib-movies",
        }),
      ).toMatchObject({ deferred: "processing-active" });
    }
  });
});

describe("all in one", () => {
  it("scans every configured library, collections and mixed included", async () => {
    const { queue, enqueued } = recordingQueue();

    await run(handlers({ queue }), JOB_TYPES.libraryMaintenance, {
      stage: "scan",
      pass: 0,
    });

    const scans = enqueued.filter(
      (entry) => entry.jobType === JOB_TYPES.libraryScan,
    );
    expect(scans.map((entry) => entry.payload?.libraryId).sort()).toEqual(
      LIBRARIES.map((library) => library.id).sort(),
    );
    // The same per-library key the individual buttons use, so a scan already
    // due is joined rather than duplicated.
    expect(scans[0]?.dedupeKey).toBe(`${JOB_TYPES.libraryScan}:lib-movies`);
  });

  it("waits for the stage's own jobs before moving to the next one", async () => {
    const { queue, enqueued } = recordingQueue({
      [JOB_TYPES.libraryScan]: 1,
    });

    await run(handlers({ queue }), JOB_TYPES.libraryMaintenance, {
      stage: "scan",
      pass: 1,
    });

    const follow = enqueued.find(
      (entry) => entry.jobType === JOB_TYPES.libraryMaintenance,
    );
    expect(follow?.payload).toMatchObject({ stage: "scan", pass: 2 });
  });

  it("moves scan -> organize -> trickplay once each stage is clear", async () => {
    const afterScan = recordingQueue();
    await run(handlers(afterScan), JOB_TYPES.libraryMaintenance, {
      stage: "scan",
      pass: 1,
    });
    expect(
      afterScan.enqueued.find(
        (entry) => entry.jobType === JOB_TYPES.libraryMaintenance,
      )?.payload,
    ).toMatchObject({ stage: "organize", pass: 0 });

    const afterOrganize = recordingQueue();
    await run(handlers(afterOrganize), JOB_TYPES.libraryMaintenance, {
      stage: "organize",
      pass: 1,
    });
    expect(
      afterOrganize.enqueued.find(
        (entry) => entry.jobType === JOB_TYPES.libraryMaintenance,
      )?.payload,
    ).toMatchObject({ stage: "trickplay", pass: 0 });

    const afterTrickplay = recordingQueue();
    const done = await run(
      handlers(afterTrickplay),
      JOB_TYPES.libraryMaintenance,
      { stage: "trickplay", pass: 1 },
    );
    expect(done).toMatchObject({ completed: true });
  });

  /*
   * Renaming changes a basename inside the folder the file is already in;
   * organising then moves that file, under its settled name, into the layout.
   * Neither button does the other's work, so "all in one" has to say the order.
   */
  it("queues renaming before folder organisation, per library", async () => {
    const { queue, enqueued } = recordingQueue();

    await run(handlers({ queue }), JOB_TYPES.libraryMaintenance, {
      stage: "organize",
      pass: 0,
    });

    const forMovies = enqueued
      .filter((entry) => entry.payload?.libraryId === "lib-movies")
      .map((entry) => entry.jobType);
    expect(forMovies).toEqual([
      JOB_TYPES.libraryRename,
      JOB_TYPES.libraryOrganize,
    ]);
    expect(
      (enqueued.find((entry) => entry.jobType === JOB_TYPES.libraryRename)
        ?.priority ?? 0) <
        (enqueued.find((entry) => entry.jobType === JOB_TYPES.libraryOrganize)
          ?.priority ?? 0),
    ).toBe(true);
  });

  it("schedules the trickplay sweep last, after everything it depends on", async () => {
    const { queue, enqueued } = recordingQueue();

    await run(handlers({ queue }), JOB_TYPES.libraryMaintenance, {
      stage: "trickplay",
      pass: 0,
    });

    expect(
      enqueued.find((entry) => entry.jobType === JOB_TYPES.trickplayScan)
        ?.dedupeKey,
    ).toBe(`${JOB_TYPES.trickplayScan}:all:0`);
  });
});
