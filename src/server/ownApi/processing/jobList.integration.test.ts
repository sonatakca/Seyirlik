// @vitest-environment node
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { runMigrations } from "../database/migrationRunner";
import { createJobQueue } from "../tasks/jobQueue";
import { createProcessingJobStore, type ProcessingState } from "./jobStore";

// Disposable database only: this suite resets its public schema.
const connectionString = process.env.SEYIRLIK_TEST_DATABASE_URL;
const integration = connectionString ? describe : describe.skip;
integration("processing job listing", () => {
  const pool = new Pool({ connectionString });
  const store = createProcessingJobStore(pool);
  const queue = createJobQueue(pool);
  const libraryId = randomUUID();
  beforeAll(async () => {
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
    await runMigrations(pool);
    await pool.query(
      "INSERT INTO libraries(id,slug,name,kind) VALUES ($1,'listing','Listing','movies')",
      [libraryId],
    );
  });
  beforeEach(async () => {
    await pool.query(
      "DELETE FROM processing_jobs; DELETE FROM jobs; DELETE FROM items",
    );
  });
  afterAll(async () => {
    await pool.end();
  });
  async function make(state: ProcessingState, priority?: number) {
    const item = randomUUID(),
      file = randomUUID();
    await pool.query(
      "INSERT INTO items(id,library_id,kind,source_key,title,sort_title) VALUES ($1::uuid,$2,'movie',$1::text,'Film','film')",
      [item, libraryId],
    );
    await pool.query(
      "INSERT INTO media_files(id,item_id,relative_path,size_bytes,mtime_ms,fingerprint) VALUES ($1::uuid,$2,$1::text,1,1,'test')",
      [file, item],
    );
    const job = await store.create({
      itemId: item,
      mediaFileId: file,
      sourceFingerprint: "a".repeat(64),
      profile: "test",
    });
    if (priority !== undefined) {
      const attempt = await queue.enqueue({
        jobType: "media.process",
        priority,
      });
      await store.attachQueueJob(job.id, attempt);
    }
    await store.update(job.id, { state });
    return job.id;
  }
  it("keeps an older running encode visible despite more than 50 newer jobs", async () => {
    const running = await make("running");
    await pool.query(
      "UPDATE processing_jobs SET created_at='2020-01-01' WHERE id=$1",
      [running],
    );
    for (let n = 0; n < 55; n++) await make("succeeded");
    const queued = await make("queued", 100);
    const jobs = await store.list({ limit: 50 });
    expect(jobs[0]?.id).toBe(running);
    expect(jobs.some((job) => job.id === queued)).toBe(true);
    expect(jobs).toHaveLength(50);
  });
  it("uses queue priority when waiting jobs exceed the listing limit", async () => {
    const next = await make("queued", 1);
    await make("queued", 30);
    const second = await make("queued", 2);
    expect((await store.list({ limit: 2 })).map((job) => job.id)).toEqual([
      next,
      second,
    ]);
  });
  it("keeps paused work ahead of newer concluded jobs", async () => {
    const paused = await make("paused");
    await make("failed");
    expect((await store.list({ limit: 1 }))[0]?.id).toBe(paused);
  });
  it("retains newest-first history for an explicit terminal-state filter", async () => {
    const old = await make("succeeded");
    await pool.query(
      "UPDATE processing_jobs SET created_at='2020-01-01' WHERE id=$1",
      [old],
    );
    const recent = await make("succeeded");
    expect((await store.list({ state: "succeeded", limit: 1 }))[0]?.id).toBe(
      recent,
    );
  });
  it("lists the whole queue past the old page size, with no history in it", async () => {
    const running = await make("running");
    for (let n = 0; n < 5; n++) await make("succeeded");
    const waiting: string[] = [];
    for (let n = 0; n < 230; n++) waiting.push(await make("queued", 100 + n));
    const jobs = await store.list({ outcome: "active" });
    expect(jobs).toHaveLength(231);
    expect(jobs[0]?.id).toBe(running);
    expect(jobs.slice(1).map((job) => job.id)).toEqual(waiting);
  });
  it("pages concluded jobs newest-ended first without repeating a row", async () => {
    await make("queued", 100);
    const ended: string[] = [];
    for (let n = 0; n < 7; n++) {
      const id = await make(n % 2 ? "failed" : "succeeded");
      await pool.query(
        "UPDATE processing_jobs SET finished_at = now() - make_interval(mins => $2) WHERE id = $1",
        [id, n],
      );
      ended.push(id);
    }
    const first = await store.list({ outcome: "finished", limit: 3 });
    const second = await store.list({
      outcome: "finished",
      limit: 3,
      offset: 3,
    });
    const third = await store.list({
      outcome: "finished",
      limit: 3,
      offset: 6,
    });
    expect([...first, ...second, ...third].map((job) => job.id)).toEqual(
      ended,
    );
  });
});
