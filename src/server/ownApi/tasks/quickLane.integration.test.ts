// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { runMigrations } from "../database/migrationRunner";
import { SUBTITLE_JOB_TYPES } from "../subtitles/subtitleJobs";
import { JOB_TYPES } from "./jobHandlers";
import { createJobQueue } from "./jobQueue";
import { createWorker, type JobHandler, type WorkerLane } from "./worker";
import { workerLanes } from "./workerRole";

/*
 * The always-on server as the dashboard showed it: three subtitle searches
 * holding every library slot, twenty more behind them, and a library scan that
 * needs a second of work sitting "queued" until a search finished.
 */

// Disposable database only: this suite resets its public schema.
const connectionString = process.env.SEYIRLIK_TEST_DATABASE_URL;
const integration = connectionString ? describe : describe.skip;

integration("short work beside a full library lane", () => {
  const pool = new Pool({ connectionString });
  const queue = createJobQueue(pool);
  let release: () => void = () => undefined;
  let searchesHeld: Promise<void> = Promise.resolve();

  const handlers: Record<string, JobHandler> = {
    [SUBTITLE_JOB_TYPES.run]: async () => {
      await searchesHeld;
    },
    [JOB_TYPES.libraryScan]: async () => undefined,
    [JOB_TYPES.metadataRefresh]: async () => undefined,
  };

  beforeAll(async () => {
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
    await runMigrations(pool);
  });
  beforeEach(async () => {
    await pool.query("DELETE FROM jobs");
    searchesHeld = new Promise((resolve) => {
      release = resolve;
    });
  });
  afterAll(async () => {
    await pool.end();
  });

  async function statusOf(id: string): Promise<string | undefined> {
    return (await queue.get(id))?.status;
  }

  async function until(check: () => Promise<boolean>, ms: number) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (await check()) return true;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return false;
  }

  async function runningSearches(): Promise<number> {
    const result = await pool.query<{ n: string }>(
      "SELECT count(*) AS n FROM jobs WHERE job_type = $1 AND status = 'running'",
      [SUBTITLE_JOB_TYPES.run],
    );
    return Number(result.rows[0]?.n ?? 0);
  }

  async function scenario(lanes: WorkerLane[]) {
    for (let n = 0; n < 23; n++) {
      await queue.enqueue({ jobType: SUBTITLE_JOB_TYPES.run });
    }
    const worker = createWorker({ queue, handlers, lanes, pollIntervalMs: 25 });
    worker.start();
    expect(
      await until(async () => (await runningSearches()) === 3, 5_000),
    ).toBe(true);
    const scan = await queue.enqueue({
      jobType: JOB_TYPES.libraryScan,
      payload: { libraryId: "movies" },
    });
    const refresh = await queue.enqueue({
      jobType: JOB_TYPES.metadataRefresh,
      payload: { itemId: "berlin" },
    });
    const finished = await until(
      async () =>
        (await statusOf(scan)) === "succeeded" &&
        (await statusOf(refresh)) === "succeeded",
      2_000,
    );
    const searchesStillRunning = await runningSearches();
    const head = await pool.query<{ id: string }>(
      `SELECT id FROM jobs WHERE status = 'queued'
        ORDER BY priority, run_after, queued_at LIMIT 1`,
    );
    await worker.stop();
    release();
    await worker.whenIdle();
    return { finished, searchesStillRunning, scan, head: head.rows[0]?.id };
  }

  it("runs a scan and a refresh while three searches hold the library lane", async () => {
    const { finished, searchesStillRunning } = await scenario(
      workerLanes("light", []),
    );
    expect(finished).toBe(true);
    expect(searchesStillRunning).toBe(3);
  });

  it("left them waiting without the quick slot", async () => {
    const { finished, scan, head } = await scenario(
      workerLanes("light", []).filter((lane) => lane.name !== "quick"),
    );
    expect(finished).toBe(false);
    // Still, it is next in line: ahead of the twenty searches queued before it.
    expect(head).toBe(scan);
  });
});
