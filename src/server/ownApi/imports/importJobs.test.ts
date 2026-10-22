// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createImportJobHandlers, IMPORT_JOB_TYPES } from "./importJobs";
import { parseImportConfig } from "./importConfig";
import { PermanentJobError } from "../tasks/worker";
import type { JobContext } from "../tasks/worker";
import type { JobRecord } from "../tasks/jobQueue";
import type { ImportRepository, ImportRecord } from "./importRepository";
import type { ImportService } from "./importService";
import { MAX_IMPORT_ATTEMPTS, type ImportState } from "./importState";

function record(over: Partial<ImportRecord> = {}): ImportRecord {
  return {
    id: "i1",
    idempotencyKey: "seyirlik-import-i1",
    state: "planned",
    targetKind: "movie",
    targetTitle: "Dune",
    sourceRoot: "C:\\SeyirlikDownloads",
    libraryRoot: "C:\\SeyirlikLibrary",
    sourceRelative: "Dune.2021",
    isUpgrade: false,
    attempt: 0,
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

interface Harness {
  service: ImportService;
  repository: ImportRepository;
  updates: Array<{ id: string; from: string; patch: Record<string, unknown> }>;
}

function harness(
  records: ImportRecord[],
  over: Partial<ImportService> = {},
  fileCount = 1,
): Harness {
  const updates: Harness["updates"] = [];
  /*
   * The fakes move the record as the real service would. The handler decides
   * whether to tidy up by re-reading the row rather than by trusting what
   * `execute` returned, so a fake that never moved it would be testing a
   * different handler.
   */
  const move = (id: string, state: ImportState): void => {
    const index = records.findIndex((row) => row.id === id);
    if (index >= 0) records[index] = { ...records[index]!, state };
  };
  const service: ImportService = {
    plan: vi.fn(async (id: string) => {
      move(id, "staging");
      return { state: "staging", committed: 0, failed: 0 };
    }),
    execute: vi.fn(async (id: string) => {
      move(id, "committed");
      return { state: "committed", committed: fileCount, failed: 0 };
    }),
    reconcile: vi.fn(async () => ({
      state: "committed",
      committed: 1,
      failed: 0,
    })),
    cleanup: vi.fn(async () => ({
      state: "complete",
      committed: 1,
      failed: 0,
    })),
    ...over,
  };
  const repository = {
    get: async (id: string) => records.find((row) => row.id === id) ?? null,
    list: async () => records,
    listUncertain: async () =>
      records.filter((row) =>
        ["committing", "uncertain"].includes(row.state as string),
      ),
    listFiles: async () => Array.from({ length: fileCount }, () => ({})),
    update: async (
      id: string,
      from: string,
      patch: Record<string, unknown>,
    ) => {
      updates.push({ id, from, patch });
      const index = records.findIndex((row) => row.id === id);
      if (index >= 0 && typeof patch.state === "string") {
        records[index] = {
          ...records[index]!,
          state: patch.state as ImportState,
        };
      }
      return true;
    },
  } as unknown as ImportRepository;
  return { service, repository, updates };
}

const handlers = (h: Harness) =>
  createImportJobHandlers(h.service, h.repository);

describe("carrying one import", () => {
  it("plans, executes and tidies up", async () => {
    const h = harness([record({ state: "planned" })]);
    const result = await handlers(h)[IMPORT_JOB_TYPES.run]!(
      context({ importId: "i1" }),
    );
    expect(h.service.plan).toHaveBeenCalledWith("i1");
    expect(h.service.execute).toHaveBeenCalledWith("i1");
    expect(h.service.cleanup).toHaveBeenCalledWith("i1");
    expect(result).toMatchObject({ committed: 1 });
  });

  it("does not re-plan an import that is already under way", async () => {
    // Planning again would claim the row and rewrite a plan being executed.
    const h = harness([record({ state: "staging" })]);
    await handlers(h)[IMPORT_JOB_TYPES.run]!(context({ importId: "i1" }));
    expect(h.service.plan).not.toHaveBeenCalled();
    expect(h.service.execute).toHaveBeenCalled();
  });

  it("does not tidy up an import that did not commit", async () => {
    const h = harness([record({ state: "needs_attention" })], {
      execute: vi.fn(async () => ({
        state: "needs_attention",
        committed: 0,
        failed: 1,
      })),
    });
    await handlers(h)[IMPORT_JOB_TYPES.run]!(context({ importId: "i1" }));
    expect(h.service.cleanup).not.toHaveBeenCalled();
  });

  it("reports progress by phase and by files, never as invented bytes", async () => {
    /*
     * `copyFile` gives no byte-level progress, so a percentage derived from it
     * would be a number nobody measured.
     */
    const h = harness([record({ state: "planned" })]);
    const ctx = context({ importId: "i1" });
    await handlers(h)[IMPORT_JOB_TYPES.run]!(ctx);
    const messages = (ctx.reportProgress as ReturnType<typeof vi.fn>).mock.calls
      .map((call) => call[1])
      .filter(Boolean);
    expect(messages).toContain("Reading the download");
    expect(messages.some((m) => String(m).includes("of 1 file"))).toBe(true);
  });

  it("does not retry a payload that names no import", async () => {
    const h = harness([]);
    await expect(
      handlers(h)[IMPORT_JOB_TYPES.run]!(context({})),
    ).rejects.toBeInstanceOf(PermanentJobError);
  });

  it("does not retry an import that no longer exists", async () => {
    const h = harness([]);
    await expect(
      handlers(h)[IMPORT_JOB_TYPES.run]!(context({ importId: "gone" })),
    ).rejects.toBeInstanceOf(PermanentJobError);
  });
});

describe("sweeping the imports nobody can account for", () => {
  it("reconciles every row whose outcome is unknown", async () => {
    const h = harness([
      record({ id: "a", state: "committing" }),
      record({ id: "b", state: "uncertain" }),
      record({ id: "c", state: "complete" }),
    ]);
    const result = await handlers(h)[IMPORT_JOB_TYPES.reconcile]!(context({}));
    expect(h.service.reconcile).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ examined: 2, resolved: 2 });
  });

  it("counts a row that is still unknown rather than calling it resolved", async () => {
    const h = harness([record({ id: "a", state: "uncertain" })], {
      reconcile: vi.fn(async () => ({
        state: "uncertain",
        committed: 0,
        failed: 1,
      })),
    });
    const result = await handlers(h)[IMPORT_JOB_TYPES.reconcile]!(context({}));
    expect(result).toMatchObject({ resolved: 0, stillUnknown: 1 });
  });

  it("schedules a retry for a transient failure, in the future", async () => {
    const before = Date.now();
    const h = harness([
      record({
        state: "failed",
        failureClass: "destination-locked",
        attempt: 1,
      }),
    ]);
    const result = await handlers(h)[IMPORT_JOB_TYPES.reconcile]!(context({}));
    expect(result).toMatchObject({ retried: 1 });
    expect(h.updates[0]).toMatchObject({
      from: "failed",
      patch: { state: "planned" },
    });
    expect(h.updates[0]!.patch.retryAfterMs as number).toBeGreaterThan(before);
  });

  it("asks a person once the attempts are spent", async () => {
    const h = harness([
      record({
        state: "failed",
        failureClass: "source-locked",
        attempt: MAX_IMPORT_ATTEMPTS,
      }),
    ]);
    const result = await handlers(h)[IMPORT_JOB_TYPES.reconcile]!(context({}));
    expect(result).toMatchObject({ escalated: 1, retried: 0 });
  });

  it("leaves a terminal failure exactly where it is", async () => {
    // A path that escaped its root will escape it again next time.
    const h = harness([
      record({ state: "failed", failureClass: "path-escape", attempt: 1 }),
    ]);
    const result = await handlers(h)[IMPORT_JOB_TYPES.reconcile]!(context({}));
    expect(result).toMatchObject({ retried: 0, escalated: 0 });
    expect(h.updates).toHaveLength(0);
  });

  it("touches nothing that has not failed", async () => {
    const h = harness([
      record({ id: "a", state: "complete" }),
      record({ id: "b", state: "needs_attention" }),
    ]);
    await handlers(h)[IMPORT_JOB_TYPES.reconcile]!(context({}));
    expect(h.updates).toHaveLength(0);
  });
});

describe("declaring where downloads are read from", () => {
  const env = (value?: string): NodeJS.ProcessEnv =>
    (value === undefined
      ? {}
      : { SEYIRLIK_IMPORT: value }) as NodeJS.ProcessEnv;

  it("returns nothing when importing is not configured", () => {
    expect(parseImportConfig(env())).toBeUndefined();
    expect(parseImportConfig(env("  "))).toBeUndefined();
  });

  it("reads a complete declaration", () => {
    expect(
      parseImportConfig(
        env(
          JSON.stringify({
            downloadRoot: "C:\\SeyirlikDownloads\\complete\\seyirlik\\",
            retainSource: true,
            forceCopy: true,
          }),
        ),
      ),
    ).toEqual({
      downloadRoot: "C:\\SeyirlikDownloads\\complete\\seyirlik",
      retainSource: true,
      forceCopy: true,
      autoProcess: true,
    });
  });

  it("defaults to linking and to tidying up", () => {
    expect(
      parseImportConfig(env(JSON.stringify({ downloadRoot: "/downloads" }))),
    ).toEqual({
      downloadRoot: "/downloads",
      retainSource: false,
      forceCopy: false,
      autoProcess: true,
    });
  });

  it("queues imports for processing unless told not to", () => {
    expect(
      parseImportConfig(
        env(JSON.stringify({ downloadRoot: "/d", autoProcess: false })),
      )?.autoProcess,
    ).toBe(false);
    expect(() =>
      parseImportConfig(
        env(JSON.stringify({ downloadRoot: "/d", autoProcess: "no" })),
      ),
    ).toThrow(/autoProcess must be true or false/);
  });

  it.each([
    ["not json", "{"],
    ["an array", "[]"],
    ["no download root", "{}"],
    ["a relative root", JSON.stringify({ downloadRoot: "downloads" })],
    [
      "a non-boolean flag",
      JSON.stringify({ downloadRoot: "/d", retainSource: "yes" }),
    ],
  ])("refuses %s at startup", (_name, raw) => {
    expect(() => parseImportConfig(env(raw))).toThrow(
      /SEYIRLIK_IMPORT is invalid/,
    );
  });

  it("accepts the absolute forms either platform uses", () => {
    for (const root of [
      "C:\\Downloads",
      "C:/Downloads",
      "\\\\nas\\share",
      "/srv/downloads",
    ]) {
      expect(
        parseImportConfig(env(JSON.stringify({ downloadRoot: root }))),
      ).toBeDefined();
    }
  });
});
