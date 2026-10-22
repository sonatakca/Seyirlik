import { describe, expect, it, vi } from "vitest";
import { OwnApiError } from "../ownApiHandler";
import type { BulkEnqueueOutcome } from "../processing/processingEnqueue";
import { createImportJobHandlers, IMPORT_JOB_TYPES } from "./importJobs";
import {
  createImportProcessingSweep,
  IMPORT_PROCESSING_MAX_ATTEMPTS,
  mediaRelativePath,
  type ImportProcessingOutcome,
  type ImportProcessingStore,
  type RegisteredMediaFile,
  type UndecidedImportFile,
} from "./importProcessing";
import type { ImportRepository } from "./importRepository";
import type { ImportService } from "./importService";

describe("where an imported file sits in the library", () => {
  const roots = ["Movies", "Series"];

  it("joins the configured root the import wrote into", () => {
    expect(
      mediaRelativePath(
        "\\\\seyirlik\\drive\\media\\Series",
        "The Sopranos/Season 1/src/The Sopranos - S01E02.mkv",
        roots,
      ),
    ).toBe("Series/The Sopranos/Season 1/src/The Sopranos - S01E02.mkv");
    expect(
      mediaRelativePath(
        "D:\\media\\Movies\\",
        "Dune (2021)\\src\\Dune (2021).mkv",
        roots,
      ),
    ).toBe("Movies/Dune (2021)/src/Dune (2021).mkv");
    expect(
      mediaRelativePath("/srv/media/series", "Show/S01/a.mkv", roots),
    ).toBe("Series/Show/S01/a.mkv");
  });

  it("prefers the longest root and refuses a partial name", () => {
    expect(
      mediaRelativePath("D:\\media\\TV\\Series", "a.mkv", [
        "Series",
        "TV/Series",
      ]),
    ).toBe("TV/Series/a.mkv");
    expect(
      mediaRelativePath("D:\\media\\OldSeries", "a.mkv", roots),
    ).toBeNull();
    expect(mediaRelativePath("D:\\media\\Books", "a.epub", roots)).toBeNull();
  });
});

const FILE_A = "file-a";
const FILE_B = "file-b";

function undecided(
  id: string,
  destinationRelative: string,
  attempts = 0,
): UndecidedImportFile {
  return {
    id,
    importId: `import-${id}`,
    libraryRoot: "\\\\seyirlik\\drive\\media\\Series",
    destinationRelative,
    attempts,
  };
}

function harness(
  files: UndecidedImportFile[],
  registered: RegisteredMediaFile[],
) {
  const decisions = new Map<
    string,
    { outcome: ImportProcessingOutcome; detail?: string; jobId?: string }
  >();
  const postponed = new Map<string, { attempts: number; retryAtMs: number }>();
  const store: ImportProcessingStore = {
    listUndecided: async () => files.filter((file) => !decisions.has(file.id)),
    findMediaFiles: async (paths) =>
      new Map(
        registered
          .filter((file) => paths.includes(file.relativePath))
          .map((file) => [file.relativePath, file]),
      ),
    decide: async (fileId, outcome, extra = {}) => {
      if (decisions.has(fileId)) return;
      decisions.set(fileId, {
        outcome,
        ...(extra.detail ? { detail: extra.detail } : {}),
        ...(extra.processingJobId ? { jobId: extra.processingJobId } : {}),
      });
    },
    postpone: async (fileId, retry) => {
      postponed.set(fileId, retry);
    },
  };
  return { store, decisions, postponed };
}

const outcome = (over: Partial<BulkEnqueueOutcome>): BulkEnqueueOutcome => ({
  queued: 0,
  alreadyQueued: 0,
  alreadyComplete: 0,
  unavailable: 0,
  failed: 0,
  jobIds: [],
  skipped: [],
  ...over,
});

const NEW_E02: RegisteredMediaFile = {
  id: "mf-new",
  itemId: "episode-2",
  relativePath: "Series/The Sopranos/Season 1/src/The Sopranos - S01E02.mkv",
  missing: false,
};

describe("queueing imported files for processing", () => {
  it("names the imported media file, never the item's other files", async () => {
    const { store, decisions } = harness(
      [
        undecided(
          FILE_A,
          "The Sopranos/Season 1/src/The Sopranos - S01E02.mkv",
        ),
      ],
      [
        NEW_E02,
        // The same episode on the drive that is gone: same item, different path.
        {
          id: "mf-old",
          itemId: "episode-2",
          relativePath:
            "Series/The Sopranos/Season 1/The Sopranos - S01E02.mp4",
          missing: true,
        },
      ],
    );
    const enqueueAll = vi.fn(async () =>
      outcome({ queued: 1, jobIds: ["job-1"] }),
    );
    const result = await createImportProcessingSweep({
      store,
      enqueueAll,
      libraryRoots: ["Movies", "Series"],
    })();

    expect(enqueueAll).toHaveBeenCalledTimes(1);
    expect(enqueueAll).toHaveBeenCalledWith([
      { itemId: "episode-2", mediaFileId: "mf-new" },
    ]);
    expect(decisions.get(FILE_A)).toEqual({
      outcome: "queued",
      jobId: "job-1",
    });
    expect(result).toMatchObject({ examined: 1, queued: 1, waiting: 0 });
  });

  it("waits for the scan, and asks nothing of processing until then", async () => {
    const files = [
      undecided(FILE_A, "The Sopranos/Season 1/src/The Sopranos - S01E02.mkv"),
    ];
    const registered: RegisteredMediaFile[] = [];
    const { store, decisions } = harness(files, registered);
    const enqueueAll = vi.fn(async () =>
      outcome({ queued: 1, jobIds: ["job-1"] }),
    );
    const sweep = createImportProcessingSweep({
      store,
      enqueueAll,
      libraryRoots: ["Series"],
    });

    expect(await sweep()).toMatchObject({ waiting: 1, queued: 0 });
    expect(enqueueAll).not.toHaveBeenCalled();

    // Registered, but as missing: still not something to process.
    registered.push({ ...NEW_E02, missing: true });
    expect(await sweep()).toMatchObject({ waiting: 1 });
    expect(enqueueAll).not.toHaveBeenCalled();

    registered[0] = NEW_E02;
    expect(await sweep()).toMatchObject({ queued: 1 });
    expect(decisions.get(FILE_A)?.outcome).toBe("queued");
  });

  it("asks once per file however often it runs", async () => {
    const { store } = harness(
      [
        undecided(
          FILE_A,
          "The Sopranos/Season 1/src/The Sopranos - S01E02.mkv",
        ),
      ],
      [NEW_E02],
    );
    const enqueueAll = vi.fn(async () =>
      outcome({ queued: 1, jobIds: ["job-1"] }),
    );
    const sweep = createImportProcessingSweep({
      store,
      enqueueAll,
      libraryRoots: ["Series"],
    });
    await sweep();
    await sweep();
    expect(await sweep()).toMatchObject({ examined: 0 });
    expect(enqueueAll).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["already-queued", "already-queued"],
    ["already-complete", "already-complete"],
    ["rejected", "rejected"],
  ] as const)("records %s as a definite answer", async (reason, recorded) => {
    const { store, decisions } = harness(
      [
        undecided(
          FILE_A,
          "The Sopranos/Season 1/src/The Sopranos - S01E02.mkv",
        ),
      ],
      [NEW_E02],
    );
    await createImportProcessingSweep({
      store,
      enqueueAll: async () =>
        outcome({
          skipped: [
            {
              itemId: NEW_E02.itemId,
              mediaFileId: NEW_E02.id,
              reason,
              ...(reason === "rejected" ? { detail: "No video." } : {}),
            },
          ],
        }),
      libraryRoots: ["Series"],
    })();
    expect(decisions.get(FILE_A)?.outcome).toBe(recorded);
  });

  it("backs off a failing file and gives up after a bounded number of tries", async () => {
    let now = 1_000_000;
    const file = undecided(
      FILE_A,
      "The Sopranos/Season 1/src/The Sopranos - S01E02.mkv",
    );
    const { store, decisions, postponed } = harness([file], [NEW_E02]);
    const failing = async () =>
      outcome({
        failed: 1,
        skipped: [
          {
            itemId: NEW_E02.itemId,
            mediaFileId: NEW_E02.id,
            reason: "error",
            detail: "ffprobe exited 1",
          },
        ],
      });
    const warn = vi.fn();
    const sweep = createImportProcessingSweep({
      store,
      enqueueAll: failing,
      libraryRoots: ["Series"],
      now: () => now,
      warn,
    });

    await sweep();
    expect(postponed.get(FILE_A)).toEqual({
      attempts: 1,
      retryAtMs: now + 2 * 60_000,
      detail: "ffprobe exited 1",
    });

    // The store would hand it back once its retry time came; the attempt
    // count is what it carries back.
    for (
      let attempt = 1;
      attempt < IMPORT_PROCESSING_MAX_ATTEMPTS;
      attempt += 1
    ) {
      now += 3_600_000;
      (file as { attempts: number }).attempts = attempt;
      await sweep();
    }
    expect(decisions.get(FILE_A)).toEqual({
      outcome: "gave-up",
      detail: "ffprobe exited 1",
    });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("stops at a full disk without counting it against the file", async () => {
    const { store, postponed } = harness(
      [
        undecided(
          FILE_A,
          "The Sopranos/Season 1/src/The Sopranos - S01E02.mkv",
          2,
        ),
        undecided(
          FILE_B,
          "The Sopranos/Season 1/src/The Sopranos - S01E03.mkv",
        ),
      ],
      [
        NEW_E02,
        {
          id: "mf-e03",
          itemId: "episode-3",
          relativePath:
            "Series/The Sopranos/Season 1/src/The Sopranos - S01E03.mkv",
          missing: false,
        },
      ],
    );
    const enqueueAll = vi.fn(async () =>
      outcome({
        failed: 1,
        skipped: [
          {
            itemId: "episode-2",
            mediaFileId: "mf-new",
            reason: "insufficient-space",
          },
        ],
      }),
    );
    const result = await createImportProcessingSweep({
      store,
      enqueueAll,
      libraryRoots: ["Series"],
      now: () => 0,
    })();
    expect(enqueueAll).toHaveBeenCalledTimes(1);
    expect(postponed.get(FILE_A)).toMatchObject({ attempts: 2 });
    expect(postponed.has(FILE_B)).toBe(false);
    expect(result.postponed).toBe(1);
  });

  it("records nothing while the storage guard refuses new work", async () => {
    const { store, decisions, postponed } = harness(
      [
        undecided(
          FILE_A,
          "The Sopranos/Season 1/src/The Sopranos - S01E02.mkv",
        ),
      ],
      [NEW_E02],
    );
    const result = await createImportProcessingSweep({
      store,
      enqueueAll: async () => {
        throw new OwnApiError("PROCESSING_STORAGE_GUARDED", "Held.", 409);
      },
      libraryRoots: ["Series"],
    })();
    expect(result.guarded).toBe(1);
    expect(decisions.size).toBe(0);
    expect(postponed.size).toBe(0);
  });
});

describe("the processing handoff job", () => {
  it("runs the sweep and reports its counts", async () => {
    const queueProcessing = vi.fn(async () => ({
      examined: 2,
      waiting: 1,
      queued: 1,
      alreadyQueued: 0,
      alreadyComplete: 0,
      rejected: 0,
      postponed: 0,
      gaveUp: 0,
      guarded: 0,
    }));
    const handlers = createImportJobHandlers(
      {} as ImportService,
      {} as ImportRepository,
      { queueProcessing },
    );
    const result = await handlers[IMPORT_JOB_TYPES.process]!({
      job: { payload: {} },
      reportProgress: async () => undefined,
    } as never);
    expect(result).toMatchObject({ examined: 2, queued: 1 });
  });

  it("does nothing where automatic processing is off", async () => {
    const handlers = createImportJobHandlers(
      {} as ImportService,
      {} as ImportRepository,
    );
    expect(
      await handlers[IMPORT_JOB_TYPES.process]!({
        job: { payload: {} },
        reportProgress: async () => undefined,
      } as never),
    ).toEqual({ examined: 0 });
  });
});
