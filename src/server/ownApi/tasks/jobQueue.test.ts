import { describe, expect, it, vi } from "vitest";
import type { DatabasePool } from "../database/databasePool";
import { createJobQueue } from "./jobQueue";

/**
 * What a job is allowed to carry between the process that queues it and the
 * worker that runs it.
 *
 * A payload is typed `Record<string, unknown>`, so the compiler has nothing to
 * say about it, and `JSON.stringify` is happy to turn things that are not JSON
 * into `{}` rather than complain. The combination is how a forgotten `await`
 * became lost content: `titleRoot` was a Promise, it reached the database as an
 * empty object, the worker saw no usable destination and fell back to the
 * folder beside the source — which for an episode is the season folder shared
 * with its neighbours.
 *
 * So the queue refuses the payload rather than storing a job that will run with
 * a field silently missing.
 */

function poolThatRecords(): {
  pool: DatabasePool;
  query: ReturnType<typeof vi.fn>;
} {
  const query = vi.fn().mockResolvedValue({ rows: [{ id: "job-1" }] });
  return { pool: { query } as unknown as DatabasePool, query };
}

describe("enqueueing a job", () => {
  it("refuses a payload holding an un-awaited Promise", async () => {
    const { pool, query } = poolThatRecords();
    const queue = createJobQueue(pool);

    const titleRoot = Promise.resolve("/media/Series/Show/Season 1/S01E01");
    await expect(
      queue.enqueue({
        jobType: "media.process",
        payload: { processingJobId: "job-1", titleRoot },
      }),
    ).rejects.toThrow(/Promise \(missing `await`\?\)/);

    // Nothing reached the database, so there is no job to run wrongly later.
    expect(query).not.toHaveBeenCalled();
    await titleRoot;
  });

  it("names the field, so the call site is the thing that gets looked at", async () => {
    const { pool } = poolThatRecords();
    const queue = createJobQueue(pool);

    await expect(
      queue.enqueue({
        jobType: "media.process",
        payload: { nested: { titleRoot: Promise.resolve("/somewhere") } },
      }),
    ).rejects.toThrow(/payload\.nested\.titleRoot/);
  });

  it("refuses other values that do not survive JSON", async () => {
    const { pool } = poolThatRecords();
    const queue = createJobQueue(pool);

    for (const payload of [
      { queuedAt: new Date() },
      { size: 10n },
      { onDone: () => undefined },
      { ratio: Number.NaN },
    ]) {
      await expect(
        queue.enqueue({ jobType: "media.process", payload }),
      ).rejects.toThrow();
    }
  });

  it("accepts the JSON a real processing job carries", async () => {
    const { pool, query } = poolThatRecords();
    const queue = createJobQueue(pool);

    await expect(
      queue.enqueue({
        jobType: "media.process",
        payload: {
          processingJobId: "job-1",
          sourcePath: "/media/Series/Show/Season 1/S01E01.mp4",
          relativePath: "Series/Show/Season 1/S01E01.mp4",
          sizeBytes: 8_263_703_861,
          mtimeMs: 1_786_535_398_000,
          titleRoot: "/media/Series/Show/Season 1/S01E01",
          rungs: [2160, 1080],
          optional: undefined,
        },
      }),
    ).resolves.toBe("job-1");
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("puts short work ahead of the backlog unless the caller chose a place", async () => {
    const { pool, query } = poolThatRecords();
    const queue = createJobQueue(pool);
    const priorityOf = (call: number) => query.mock.calls[call]?.[1]?.[3];

    await queue.enqueue({
      jobType: "library.scan",
      payload: { libraryId: "l" },
    });
    await queue.enqueue({
      jobType: "metadata.refresh",
      payload: { itemId: "i" },
    });
    await queue.enqueue({ jobType: "subtitle.run" });
    await queue.enqueue({ jobType: "library.scan", priority: 150 });

    expect([0, 1, 2, 3].map(priorityOf)).toEqual([95, 95, 100, 150]);
  });
});

/**
 * A lane may only take its own kind of work, and the filter has to be applied
 * by PostgreSQL rather than after the fact: a claim that read a media job and
 * then put it back would already have leased it, incremented its attempt and
 * cleared its progress.
 */
describe("claiming with a lane filter", () => {
  it("passes the include and exclude lists to the claim statement", async () => {
    const { pool, query } = poolThatRecords();
    const queue = createJobQueue(pool);

    await queue.claim("worker-1", 60_000, { jobTypes: ["media.process"] });
    expect(query.mock.calls[0]?.[1]).toEqual([
      "worker-1",
      60,
      ["media.process"],
      null,
    ]);

    await queue.claim("worker-1", 60_000, {
      excludeJobTypes: ["media.process"],
    });
    expect(query.mock.calls[1]?.[1]).toEqual([
      "worker-1",
      60,
      null,
      ["media.process"],
    ]);
  });

  it("keeps SKIP LOCKED and the queued-only predicate on the filtered claim", async () => {
    const { pool, query } = poolThatRecords();
    const queue = createJobQueue(pool);

    await queue.claim("worker-1", 60_000, { jobTypes: ["library.scan"] });

    const sql = String(query.mock.calls[0]?.[0]);
    expect(sql).toContain("FOR UPDATE SKIP LOCKED");
    expect(sql).toContain("status = 'queued'");
    expect(sql).toContain("lease_expires_at");
  });

  it("claims anything when no filter is given", async () => {
    const { pool, query } = poolThatRecords();
    const queue = createJobQueue(pool);

    await queue.claim("worker-1", 60_000);
    expect(query.mock.calls[0]?.[1]).toEqual(["worker-1", 60, null, null]);
  });
});
