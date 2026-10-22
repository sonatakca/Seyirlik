// @vitest-environment node
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabasePool } from "../database/databasePool";
import { runMigrations } from "../database/migrationRunner";
import {
  createDatabaseLiveProgressStore,
  type LiveProgressSnapshot,
} from "./liveProgress";

/*
 * The shared live-progress store against PostgreSQL: a sample from the
 * machine encoding is readable by the API on another, an older sample never
 * replaces a newer one, and pruning keeps only running jobs.
 *
 * Requires a disposable database. The schema is dropped.
 */
const databaseUrl = process.env.SEYIRLIK_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

integration("live progress in PostgreSQL", () => {
  const pool = createDatabasePool({
    connectionString: databaseUrl as string,
    maxConnections: 2,
  });
  const store = createDatabaseLiveProgressStore(pool);
  const jobs: string[] = [];

  const sample = (
    processingJobId: string,
    timestampMs: number,
    phase: LiveProgressSnapshot["phase"],
  ) =>
    ({
      processingJobId,
      revision: timestampMs,
      timestampMs,
      stage: "video",
      phase,
      epochIndex: null,
      epochCount: null,
      epochStartSeconds: null,
      epochEndSeconds: null,
      epochFraction: null,
      completedEpochs: 0,
      protectedSeconds: 0,
      encodedSeconds: 0,
      sourceDurationSeconds: 60,
    }) as LiveProgressSnapshot;

  beforeAll(async () => {
    await pool.query("DROP SCHEMA public CASCADE");
    await pool.query("CREATE SCHEMA public");
    await runMigrations(pool);
    const library = randomUUID();
    await pool.query(
      "INSERT INTO libraries (id,slug,name,kind) VALUES ($1,'movies','Movies','movies')",
      [library],
    );
    for (const title of ["One", "Two"]) {
      const item = randomUUID();
      const file = randomUUID();
      const job = randomUUID();
      await pool.query(
        "INSERT INTO items (id, library_id, kind, source_key, title, sort_title) VALUES ($1,$2,'movie',$3::text,$3::text,$3::text)",
        [item, library, title],
      );
      await pool.query(
        "INSERT INTO media_files (id,item_id,relative_path,size_bytes,mtime_ms,fingerprint) VALUES ($1,$2,$3,1024,1,'test')",
        [file, item, `${title}.mkv`],
      );
      await pool.query(
        "INSERT INTO processing_jobs (id,item_id,media_file_id,source_fingerprint,profile,state) VALUES ($1,$2,$3,'fp','test','running')",
        [job, item, file],
      );
      jobs.push(job);
    }
  });

  afterAll(async () => {
    await pool.end();
  });

  it("hands one machine's sample to another and keeps the newest", async () => {
    const [job] = jobs;
    await store.write(sample(job!, 2_000, "audio"));
    // A write that overtook it on the way, carrying an older sample.
    await store.write(sample(job!, 1_000, "encoding"));
    expect((await store.read(job!))?.phase).toBe("audio");
  });

  it("keeps only running jobs' samples when pruned, and clears one", async () => {
    const [one, two] = jobs;
    await store.write(sample(one!, 3_000, "publishing"));
    await store.write(sample(two!, 3_000, "audio"));
    await store.prune([two!]);
    expect(await store.read(one!)).toBeNull();
    expect(await store.read(two!)).not.toBeNull();
    await store.clear(two!);
    expect(await store.read(two!)).toBeNull();
  });
});
