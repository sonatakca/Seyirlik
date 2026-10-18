// @vitest-environment node
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabasePool } from "../database/databasePool";
import { runMigrations } from "../database/migrationRunner";
import { createDatabaseDriveUploadStore } from "./driveUpload";
import type { StoredDriveUpload } from "./driveUploadStatus";
import { createProcessingJobStore } from "./jobStore";

/*
 * What a finished attempt keeps on its row: the phase history and the upload
 * to Drive that follows publication. Both must read back through the job
 * store, the upload must be resumable after a restart, and a new attempt must
 * start without either.
 *
 * Requires a disposable database. The schema is dropped.
 */
const databaseUrl = process.env.SEYIRLIK_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

integration("phase history and Drive upload on the job row", () => {
  const pool = createDatabasePool({
    connectionString: databaseUrl as string,
    maxConnections: 2,
  });
  const jobs = createProcessingJobStore(pool);
  const uploads = createDatabaseDriveUploadStore(pool);
  let job = "";

  const upload = (state: StoredDriveUpload["state"]): StoredDriveUpload => ({
    prefix: "media/Movies/One (2001)/",
    members: ["media/Movies/One (2001)/video/1080p.mp4"],
    state,
    totalBytes: 4e9,
    uploadedBytes: state === "uploaded" ? 4e9 : 1e9,
    filesPending: state === "uploaded" ? 0 : 1,
    filesUploading: state === "uploaded" ? 0 : 1,
    startedAtMs: 1_000,
    updatedAtMs: 2_000,
  });

  beforeAll(async () => {
    await pool.query("DROP SCHEMA public CASCADE");
    await pool.query("CREATE SCHEMA public");
    await runMigrations(pool);
    const library = randomUUID();
    const item = randomUUID();
    const file = randomUUID();
    job = randomUUID();
    await pool.query(
      "INSERT INTO libraries (id,slug,name,kind) VALUES ($1,'movies','Movies','movies')",
      [library],
    );
    await pool.query(
      "INSERT INTO items (id, library_id, kind, source_key, title, sort_title) VALUES ($1,$2,'movie','One','One','One')",
      [item, library],
    );
    await pool.query(
      "INSERT INTO media_files (id,item_id,relative_path,size_bytes,mtime_ms,fingerprint) VALUES ($1,$2,'One.mkv',1024,1,'test')",
      [file, item],
    );
    await pool.query(
      "INSERT INTO processing_jobs (id,item_id,media_file_id,source_fingerprint,profile,state) VALUES ($1,$2,$3,'fp','test','succeeded')",
      [job, item, file],
    );
  });

  afterAll(async () => {
    await pool.end();
  });

  it("reads the phase history back from the row", async () => {
    await jobs.update(job, {
      phaseHistory: [
        { phase: "planning", elapsedSeconds: 12, count: 5 },
        { phase: "encoding", elapsedSeconds: 5400, count: 5, bytes: 9e9 },
      ],
    });
    const record = await jobs.get(job);
    expect(record?.phaseHistory).toEqual([
      { phase: "planning", elapsedSeconds: 12, count: 5 },
      { phase: "encoding", elapsedSeconds: 5400, count: 5, bytes: 9e9 },
    ]);
  });

  it("writes upload progress without making the row look freshly touched", async () => {
    const before = (await jobs.get(job))!.updatedAt;
    await uploads.write(job, upload("uploading"));
    const record = await jobs.get(job);
    expect(record?.driveUpload).toMatchObject({
      state: "uploading",
      uploadedBytes: 1e9,
    });
    expect(record?.updatedAt).toEqual(before);
  });

  it("lists an unfinished upload for a restarted helper, and not a finished one", async () => {
    expect(await uploads.listUnfinished()).toEqual([
      { processingJobId: job, upload: upload("uploading") },
    ]);
    await uploads.write(job, upload("uploaded"));
    expect(await uploads.listUnfinished()).toEqual([]);
  });

  it("starts a new attempt without the previous attempt's history or upload", async () => {
    await jobs.beginAttempt(job, {});
    const record = await jobs.get(job);
    expect(record?.phaseHistory).toBeNull();
    expect(record?.driveUpload).toBeNull();
  });
});
