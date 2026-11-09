// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  DEFAULT_WORKSPACE_RETENTION,
  workspaceClaim,
  workspaceRetentionFromEnvironment,
  type WorkspaceJob,
} from "./workspaceRetention";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = Date.parse("2026-11-08T22:00:00Z");

function job(
  state: string,
  idleMs: number,
  overrides: Partial<WorkspaceJob> = {},
): WorkspaceJob {
  const touched = new Date(NOW - idleMs);
  return {
    id: "job",
    itemId: "item",
    profile: "cmaf-hls-aligned-v3",
    state: state as WorkspaceJob["state"],
    createdAt: new Date(NOW - idleMs - DAY),
    updatedAt: touched,
    finishedAt: state === "failed" || state === "cancelled" ? touched : null,
    ...overrides,
  };
}

const nothingSucceeded = async () => false;

async function claimed(
  record: WorkspaceJob | null,
  laterAttemptSucceeded: (jobId: string) => Promise<boolean> = nothingSucceeded,
): Promise<boolean> {
  return (
    await workspaceClaim({ job: record, laterAttemptSucceeded, now: NOW })
  ).claimed;
}

describe("workspaceClaim", () => {
  it("keeps a live job's workspace however old it is", async () => {
    for (const state of ["pending", "queued", "running", "paused"]) {
      expect(await claimed(job(state, 90 * DAY)), state).toBe(true);
    }
  });

  it("keeps a workspace whose job is in a state it does not know", async () => {
    expect(await claimed(job("archived", 90 * DAY))).toBe(true);
  });

  it("releases a workspace no job answers to, or whose job succeeded", async () => {
    expect(await claimed(null)).toBe(false);
    expect(await claimed(job("succeeded", 0))).toBe(false);
  });

  it("keeps a failed job's workspace for a retry, then releases it", async () => {
    expect(await claimed(job("failed", 6 * DAY))).toBe(true);
    expect(await claimed(job("failed", 7 * DAY))).toBe(false);
  });

  it("gives a cancelled job's workspace a day's grace", async () => {
    expect(await claimed(job("cancelled", 23 * HOUR))).toBe(true);
    expect(await claimed(job("cancelled", 25 * HOUR))).toBe(false);
  });

  it("measures idleness from the latest touch, so a retry restarts the clock", async () => {
    // Failed long ago, but the row was updated an hour ago.
    const retried = job("failed", HOUR, {
      finishedAt: new Date(NOW - 30 * DAY),
    });
    expect(await claimed(retried)).toBe(true);
  });

  it("releases a failed or cancelled attempt once a later one for the same title succeeded", async () => {
    const asked: string[] = [];
    const later = async (jobId: string) => {
      asked.push(jobId);
      return true;
    };
    expect(
      await claimed(job("failed", HOUR, { id: "failed-job" }), later),
    ).toBe(false);
    expect(
      await claimed(job("cancelled", HOUR, { id: "cancelled-job" }), later),
    ).toBe(false);
    // Asked about the attempt itself; the database compares the rest.
    expect(asked).toEqual(["failed-job", "cancelled-job"]);
  });

  it("never asks the database about a live job", async () => {
    let asked = false;
    await workspaceClaim({
      job: job("paused", 30 * DAY),
      laterAttemptSucceeded: async () => {
        asked = true;
        return true;
      },
      now: NOW,
    });
    expect(asked).toBe(false);
  });

  it("fails closed when the database cannot answer", async () => {
    await expect(
      workspaceClaim({
        job: job("failed", 30 * DAY),
        laterAttemptSucceeded: async () => {
          throw new Error("database unavailable");
        },
        now: NOW,
      }),
    ).rejects.toThrow("database unavailable");
  });
});

describe("workspaceRetentionFromEnvironment", () => {
  it("reads days and hours, and ignores values that are not positive numbers", () => {
    expect(
      workspaceRetentionFromEnvironment({
        SEYIRLIK_FAILED_WORKSPACE_RETENTION_DAYS: "14",
        SEYIRLIK_CANCELLED_WORKSPACE_GRACE_HOURS: "2",
      }),
    ).toEqual({ failedRetentionMs: 14 * DAY, cancelledGraceMs: 2 * HOUR });
    for (const value of ["0", "-3", "soon", ""]) {
      expect(
        workspaceRetentionFromEnvironment({
          SEYIRLIK_FAILED_WORKSPACE_RETENTION_DAYS: value,
          SEYIRLIK_CANCELLED_WORKSPACE_GRACE_HOURS: value,
        }),
        value,
      ).toEqual(DEFAULT_WORKSPACE_RETENTION);
    }
  });
});
