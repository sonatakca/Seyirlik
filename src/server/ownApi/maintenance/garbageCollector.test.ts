// @vitest-environment node
import {
  mkdir,
  mkdtemp,
  readdir,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WORKSPACE_CLAIMING_STATES } from "../processing/jobStore";
import { collectGarbage, createGarbageJobHandler } from "./garbageCollector";

const DAY = 24 * 60 * 60 * 1000;
const ACQ_GONE = "0fc50c90-71e8-4666-ab88-96bce78b1f00";
const ACQ_LIVE = "912fce74-e2d4-42b4-b1c0-f60d3e2ebcfa";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "gc-test-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function folder(
  parent: string,
  name: string,
  bytes = 10,
  ageMs = 0,
): Promise<string> {
  const target = path.join(parent, name);
  await mkdir(target, { recursive: true });
  await writeFile(path.join(target, "data.bin"), Buffer.alloc(bytes));
  if (ageMs > 0) {
    const when = new Date(Date.now() - ageMs);
    await utimes(target, when, when);
  }
  return target;
}

async function workspace(jobsRoot: string, jobId: string, ageMs: number) {
  const target = await folder(jobsRoot, jobId, 1000);
  await writeFile(
    path.join(target, ".seyirlik-job.json"),
    JSON.stringify({
      schemaVersion: 1,
      owner: "seyirlik-processing-job",
      workspaceId: jobId,
    }),
  );
  const when = new Date(Date.now() - ageMs);
  await utimes(target, when, when);
  return target;
}

const names = async (dir: string) => (await readdir(dir)).sort();

describe("encode workspaces", () => {
  it("keeps failed and cancelled workspaces available for retry", async () => {
    const jobsRoot = path.join(root, "jobs");
    await workspace(jobsRoot, "failed-job", 30 * DAY);
    await workspace(jobsRoot, "cancelled-job", 30 * DAY);
    await workspace(jobsRoot, "succeeded-job", 30 * DAY);
    const states: Record<string, string> = {
      "failed-job": "failed",
      "cancelled-job": "cancelled",
      "succeeded-job": "succeeded",
    };
    const claimed = new Set<string>(WORKSPACE_CLAIMING_STATES);
    await collectGarbage({
      jobsRoot,
      isWorkspaceClaimed: async (id) => claimed.has(states[id]!),
    });
    expect(await names(jobsRoot)).toEqual(["cancelled-job", "failed-job"]);
  });

  it("removes the workspaces no live job answers to, and only those", async () => {
    const jobsRoot = path.join(root, "jobs");
    await workspace(jobsRoot, "finished-job", 2 * DAY);
    await workspace(jobsRoot, "paused-job", 30 * DAY);
    // Somebody else's directory: no ownership marker.
    await folder(jobsRoot, "operator-files", 10, 30 * DAY);

    const asked: string[] = [];
    const report = await collectGarbage({
      jobsRoot,
      isWorkspaceClaimed: async (id) => {
        asked.push(id);
        return id === "paused-job";
      },
    });

    expect(await names(jobsRoot)).toEqual(["operator-files", "paused-job"]);
    expect(report.removed).toEqual([
      expect.objectContaining({ kind: "workspace", bytes: expect.any(Number) }),
    ]);
    expect(report.removed[0]!.bytes).toBeGreaterThan(1000);
    expect(asked.sort()).toEqual(["finished-job", "paused-job"]);
  });

  it("leaves a workspace made in the last hour, whoever claims it", async () => {
    const jobsRoot = path.join(root, "jobs");
    await workspace(jobsRoot, "just-made", 0);
    await collectGarbage({ jobsRoot, isWorkspaceClaimed: async () => false });
    expect(await names(jobsRoot)).toEqual(["just-made"]);
  });

  it("removes nothing when the job states cannot be read", async () => {
    const jobsRoot = path.join(root, "jobs");
    await workspace(jobsRoot, "unknown", 2 * DAY);
    const report = await collectGarbage({
      jobsRoot,
      isWorkspaceClaimed: async () => {
        throw new Error("database unavailable");
      },
    });
    expect(await names(jobsRoot)).toEqual(["unknown"]);
    expect(report.errors[0]).toContain("database unavailable");
  });
});

describe("finished downloads", () => {
  it("removes only the downloads it is told are garbage, by acquisition", async () => {
    const downloadRoot = path.join(root, "complete");
    await folder(downloadRoot, `seyirlik-${ACQ_GONE}`, 5000);
    await folder(downloadRoot, `seyirlik-${ACQ_LIVE}`);
    // Not named by Seyirlik: never asked about, never touched.
    await folder(downloadRoot, "Some.Other.Download.2024.1080p");
    await folder(downloadRoot, "seyirlik-not-a-uuid");

    const asked: string[] = [];
    const report = await collectGarbage({
      downloadRoot,
      isDownloadGarbage: async (id) => {
        asked.push(id);
        return id === ACQ_GONE;
      },
    });

    expect(await names(downloadRoot)).toEqual([
      "Some.Other.Download.2024.1080p",
      `seyirlik-${ACQ_LIVE}`,
      "seyirlik-not-a-uuid",
    ]);
    expect(asked.sort()).toEqual([ACQ_GONE, ACQ_LIVE].sort());
    expect(report.freedBytes).toBeGreaterThanOrEqual(5000);
  });

  it("never follows a link out of the download folder", async () => {
    const downloadRoot = path.join(root, "complete");
    await mkdir(downloadRoot, { recursive: true });
    const elsewhere = await folder(root, "library-film", 100);
    await symlink(
      elsewhere,
      path.join(downloadRoot, `seyirlik-${ACQ_GONE}`),
      "junction",
    );

    await collectGarbage({
      downloadRoot,
      isDownloadGarbage: async () => true,
    });

    expect(await names(elsewhere)).toEqual(["data.bin"]);
  });
});

describe("temporary folders", () => {
  it("removes Seyirlik's stale temp folders and nothing else", async () => {
    const tempRoot = path.join(root, "temp");
    await folder(tempRoot, "seyirlik-webvtt-Ab12Cd", 10, 3 * DAY);
    await folder(tempRoot, "seyirlik-nfo-service-Zx9Yw8", 10, 3 * DAY);
    // Too new: may still be in use.
    await folder(tempRoot, "seyirlik-webvtt-Fresh1", 10, 0);
    // Seyirlik's, but not temporary.
    await folder(tempRoot, "seyirlik-live-progress", 10, 30 * DAY);
    await folder(tempRoot, "seyirlik-adaptive-fixtures", 10, 30 * DAY);
    // Somebody else's.
    await folder(tempRoot, "postgresql_installer_aa3c66ac43", 10, 30 * DAY);
    await folder(tempRoot, "tsx-SeyirlikWorker", 10, 30 * DAY);

    const report = await collectGarbage({ tempRoot });

    expect(await names(tempRoot)).toEqual([
      "postgresql_installer_aa3c66ac43",
      "seyirlik-adaptive-fixtures",
      "seyirlik-live-progress",
      "seyirlik-webvtt-Fresh1",
      "tsx-SeyirlikWorker",
    ]);
    expect(report.removed.map((entry) => entry.kind)).toEqual(["temp", "temp"]);
  });
});

describe("as a background job", () => {
  it("reports counts the task card can show, and logs every path", async () => {
    const tempRoot = path.join(root, "temp");
    await folder(tempRoot, "seyirlik-webvtt-Ab12Cd", 2_500_000, 3 * DAY);
    const log = { info: vi.fn(), warn: vi.fn() };
    const handler = createGarbageJobHandler({ tempRoot }, log);

    const result = await handler({ reportProgress: async () => undefined });

    expect(result).toEqual({ itemsRemoved: 1, megabytesFreed: 3 });
    expect(log.info.mock.calls[0]![0]).toContain("seyirlik-webvtt-Ab12Cd");
  });
});
