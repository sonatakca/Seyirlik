import { describe, expect, it, vi } from "vitest";
import type { NfoService } from "../nfo/nfoService";
import type { CatalogueScanStore } from "../scanner/reconciler";
import type { JobQueue, JobRecord } from "./jobQueue";
import { createJobHandlers, JOB_TYPES } from "./jobHandlers";

const LIBRARY_ID = "11111111-1111-4111-8111-111111111111";

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

describe("library scan NFO stage", () => {
  it("writes the library NFOs inside the scan task", async () => {
    const stages: string[] = [];
    const exportLibrary = vi.fn(async () => {
      stages.push("nfo");
      return {
        mode: "sidecar" as const,
        itemsConsidered: 2,
        created: 2,
        updated: 0,
        unchanged: 0,
        skippedConflict: 0,
        skippedNotApplicable: 0,
        failed: 0,
        conflicts: [],
        conflictsTruncated: false,
        cancelled: false,
      };
    });
    const nfoService = {
      config: {
        mode: "sidecar",
        overwritePolicy: "managed-only",
        arrManagedLibrarySlugs: new Set<string>(),
      },
      preview: async () => null,
      exportItem: async () => null,
      exportLibrary,
    } satisfies NfoService;
    const reportProgress = vi.fn(async () => undefined);

    const handlers = createJobHandlers({
      libraries: {
        listAll: async () => [],
        getById: async () => ({
          id: LIBRARY_ID,
          slug: "movies",
          name: "Movies",
          kind: "movies",
          roots: ["Movies"],
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
        runBatch: async (libraryId?: string) => {
          expect(libraryId).toBe(LIBRARY_ID);
          stages.push("probe");
          return { probed: 0, failed: 0, remaining: 0 };
        },
      } as never,
      queue: { enqueue: vi.fn() } as unknown as JobQueue,
      metadataService: {
        processPending: async (_limit: number, libraryId?: string) => {
          expect(libraryId).toBe(LIBRARY_ID);
          stages.push("metadata");
          return [];
        },
      } as never,
      nfoService,
    });

    const result = await handlers[JOB_TYPES.libraryScan]?.({
      job: job(),
      reportProgress,
      isCancelled: async () => false,
    });

    expect(exportLibrary).toHaveBeenCalledOnce();
    expect(exportLibrary).toHaveBeenCalledWith(
      LIBRARY_ID,
      expect.objectContaining({ force: false }),
    );
    expect(stages).toEqual(["probe", "metadata", "nfo"]);
    /*
     * The sentence and the fraction are unchanged; the structured snapshot is
     * the new third argument, and it names the phase rather than leaving the
     * page to recognise the sentence.
     */
    expect(reportProgress).toHaveBeenCalledWith(
      0.9,
      "Writing NFO metadata",
      expect.objectContaining({ phase: "nfo" }),
    );
    expect(result).toMatchObject({
      itemsCreated: 0,
      nfoExport: { mode: "sidecar", created: 2 },
    });
  });
});
