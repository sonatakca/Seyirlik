import { describe, expect, it, vi } from "vitest";
import type { CatalogueScanStore } from "../scanner/reconciler";
import type {
  OrganizeMove,
  OrganizerFileSystem,
} from "../scanner/organizeLibrary";
import type { JobQueue, JobRecord } from "./jobQueue";
import { createJobHandlers, JOB_TYPES } from "./jobHandlers";

const LIBRARY_ID = "11111111-1111-4111-8111-111111111111";

const SEASON = "Series/Andor/Season 1";
const MEDIA = [
  `${SEASON}/season.nfo`,
  `${SEASON}/Andor - S01E01 - Kassa.mp4`,
  `${SEASON}/Andor - S01E01 - Kassa.nfo`,
];

function scanStore(): CatalogueScanStore {
  return {
    listItems: async () => [],
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
  };
}

function job(): JobRecord {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    jobType: JOB_TYPES.libraryScan,
    payload: { libraryId: LIBRARY_ID },
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

function memoryVolume(paths: string[]) {
  const files = new Set(paths);
  const directories = new Set<string>();
  for (const path of paths) {
    const segments = path.split("/");
    for (let index = 1; index < segments.length; index += 1) {
      directories.add(segments.slice(0, index).join("/"));
    }
  }

  const fileSystem: OrganizerFileSystem = {
    readDirectory: async (relativePath) => {
      if (!directories.has(relativePath)) throw new Error("missing");
      const prefix = `${relativePath}/`;
      const names = new Map<string, boolean>();
      for (const path of [...files, ...directories]) {
        if (!path.startsWith(prefix)) continue;
        const rest = path.slice(prefix.length);
        if (rest.includes("/")) continue;
        names.set(rest, directories.has(`${relativePath}/${rest}`));
      }
      return [...names].map(([name, isDirectory]) => ({ name, isDirectory }));
    },
    createDirectory: async (relativePath) => {
      directories.add(relativePath);
    },
    move: async (from, to) => {
      files.delete(from);
      files.add(to);
    },
  };

  return { fileSystem, snapshot: () => [...files].sort() };
}

function handlersFor(options: {
  mode: "off" | "plan" | "apply";
  volume: ReturnType<typeof memoryVolume>;
  recordMoves?: (moves: OrganizeMove[]) => Promise<number>;
  /** Statuses the processing queue reports something live under. */
  live?: Array<"queued" | "running">;
}) {
  return createJobHandlers({
    libraries: {
      listAll: async () => [],
      getById: async () => ({
        id: LIBRARY_ID,
        slug: "series",
        name: "Series",
        kind: "series",
        roots: ["Series"],
      }),
      provision: async () => [],
    },
    scanStore: scanStore(),
    fileSystem: {
      readDirectory: async () => [],
      readTextFile: async () => {
        throw new Error("not used");
      },
      statFile: async () => {
        throw new Error("not used");
      },
    },
    probeService: {
      runBatch: async () => ({ probed: 0, failed: 0, remaining: 0 }),
    } as never,
    queue: {
      enqueue: vi.fn(),
      list: async ({ status }: { status?: string }) =>
        options.live?.includes(status as "queued" | "running") ? [job()] : [],
    } as unknown as JobQueue,
    organizer: {
      mode: options.mode,
      fileSystem: options.volume.fileSystem,
      ...(options.recordMoves ? { recordMoves: options.recordMoves } : {}),
    },
  });
}

function runOrganize(options: Parameters<typeof handlersFor>[0]) {
  return handlersFor(options)[JOB_TYPES.libraryOrganize]?.({
    job: { ...job(), jobType: JOB_TYPES.libraryOrganize },
    reportProgress: async () => undefined,
    isCancelled: async () => false,
  });
}

describe("the folder organiser, as its own maintenance job", () => {
  it("does not touch the media volume when it is off", async () => {
    const volume = memoryVolume(MEDIA);

    const result = await runOrganize({ mode: "off", volume });

    expect(result).toMatchObject({ mode: "off", disabled: true });
    expect(volume.snapshot()).toEqual([...MEDIA].sort());
  });

  /*
   * The step worth having: the exact list of moves, against the real library,
   * with nothing moved.
   */
  it("reports what it would move without moving it", async () => {
    const volume = memoryVolume(MEDIA);

    const result = await runOrganize({ mode: "plan", volume });

    expect(result).toMatchObject({
      mode: "plan",
      planned: 2,
      moved: 0,
      planOnly: true,
    });
    // Counts, never paths: the result reaches a browser through the task DTO.
    expect(JSON.stringify(result)).not.toContain("Andor");
    expect(volume.snapshot()).toEqual([...MEDIA].sort());
  });

  it("moves the files and takes the catalogue rows with them", async () => {
    const volume = memoryVolume(MEDIA);
    const recorded: OrganizeMove[][] = [];

    const result = await runOrganize({
      mode: "apply",
      volume,
      recordMoves: async (moves) => {
        recorded.push(moves);
        return moves.length;
      },
    });

    expect(result).toMatchObject({
      mode: "apply",
      moved: 2,
      applied: true,
    });
    expect(volume.snapshot()).toEqual([
      `${SEASON}/Andor - S01E01 - Kassa/Andor - S01E01 - Kassa.nfo`,
      `${SEASON}/season.nfo`,
      `${SEASON}/src/Andor - S01E01 - Kassa.mp4`,
    ]);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.map((move) => move.to)).toContain(
      `${SEASON}/src/Andor - S01E01 - Kassa.mp4`,
    );
  });

  /*
   * An encode in flight re-opens its source at the start of every epoch, so
   * the file cannot be moved out from under it even between FFmpeg runs.
   */
  it("stands down while a processing job is running", async () => {
    const volume = memoryVolume(MEDIA);

    const result = await runOrganize({
      mode: "apply",
      volume,
      live: ["running"],
    });

    expect(result).toMatchObject({
      mode: "apply",
      deferred: "processing-active",
    });
    expect(volume.snapshot()).toEqual([...MEDIA].sort());
  });

  /*
   * The subtler one. A queued attempt froze the absolute path of its source
   * into its queue row when it was queued, and nothing re-reads it before
   * FFmpeg is handed that path — so moving the file now would leave every
   * queued attempt pointing at a file that is not there.
   */
  it("stands down while a processing job is merely queued", async () => {
    const volume = memoryVolume(MEDIA);

    const result = await runOrganize({
      mode: "apply",
      volume,
      live: ["queued"],
    });

    expect(result).toMatchObject({
      mode: "apply",
      deferred: "processing-active",
    });
    expect(volume.snapshot()).toEqual([...MEDIA].sort());
  });

  /*
   * Reporting reads nothing but directory listings, so there is no reason for
   * a busy queue to hide the plan from an operator who asked for it.
   */
  it("still reports the plan while the queue is busy", async () => {
    const volume = memoryVolume(MEDIA);

    const result = await runOrganize({
      mode: "plan",
      volume,
      live: ["running"],
    });

    expect(result).toMatchObject({ mode: "plan", planned: 2 });
    expect(volume.snapshot()).toEqual([...MEDIA].sort());
  });

  /*
   * The reason organisation is a job of its own. Reading a library and
   * reconciling rows conflicts with nothing an encoder is doing, and while
   * both lived in one handler a queued encode of an unrelated title stopped
   * every library being re-read.
   */
  it("does not stop a pure scan from running while an encode is live", async () => {
    const volume = memoryVolume(MEDIA);

    const result = await handlersFor({
      mode: "apply",
      volume,
      live: ["running", "queued"],
    })[JOB_TYPES.libraryScan]?.({
      job: job(),
      reportProgress: async () => undefined,
      isCancelled: async () => false,
    });

    expect(result).toMatchObject({
      itemsCreated: 0,
      removalsSuppressed: false,
    });
    expect(result).not.toHaveProperty("deferred");
    // And it moved nothing: a scan no longer writes to the volume at all.
    expect(volume.snapshot()).toEqual([...MEDIA].sort());
  });
});
