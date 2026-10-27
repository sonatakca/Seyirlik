// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabasePool } from "../database/databasePool";
import { runMigrations } from "../database/migrationRunner";
import type { StoredDriveUpload } from "../processing/driveUploadStatus";
import { createImportRepository } from "./importRepository";
import { createDatabaseImportUploadStore } from "./importUploads";

/*
 * Requires a disposable database. The schema is dropped.
 */
const databaseUrl = process.env.SEYIRLIK_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

integration("an imported file's upload in PostgreSQL", () => {
  const pool = createDatabasePool({
    connectionString: databaseUrl as string,
    maxConnections: 4,
  });
  const repository = createImportRepository(pool);
  const uploads = createDatabaseImportUploadStore(pool);

  beforeAll(async () => {
    await pool.query("DROP SCHEMA public CASCADE");
    await pool.query("CREATE SCHEMA public");
    await runMigrations(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  it("keeps the upload on the file, and tells the page nothing of the path", async () => {
    const record = await repository.create({
      target: { kind: "episode", title: "Arcane", season: 1, episode: 9 },
      sourceRoot: "C:\\Seyirlik\\work\\downloads\\complete\\seyirlik",
      libraryRoot: "D:\\media\\Series",
      sourceRelative: "seyirlik-1/Arcane.S01E09.mkv",
    });
    const [file] = await repository.addFiles(record.id, [
      {
        role: "media",
        sourceRelative: "seyirlik-1/Arcane.S01E09.mkv",
        destinationRelative: "Arcane/Season 1/src/Arcane - S01E09.mkv",
        destinationKey:
          "d:\\media\\series\\arcane\\season 1\\src\\arcane - s01e09.mkv",
        sizeBytes: 7_603_618_701,
      },
    ]);
    const before = (await repository.get(record.id))!.updatedAtMs;

    const uploading: StoredDriveUpload = {
      prefix: "media/Series/Arcane/Season 1/src/Arcane - S01E09.mkv",
      members: ["media/Series/Arcane/Season 1/src/Arcane - S01E09.mkv"],
      state: "uploading",
      totalBytes: 7_603_618_701,
      uploadedBytes: 3_500_000_000,
      filesPending: 1,
      filesUploading: 1,
      startedAtMs: 1,
      updatedAtMs: 2,
    };
    await uploads.write(file!.id, uploading);

    const [read] = await repository.listFiles(record.id);
    expect(read?.driveUpload).toMatchObject({
      state: "uploading",
      uploadedBytes: 3_500_000_000,
    });
    expect(read?.driveUpload).not.toHaveProperty("prefix");
    expect(read?.driveUpload).not.toHaveProperty("members");
    // Reading the queue is not a change to the import.
    expect((await repository.get(record.id))!.updatedAtMs).toBe(before);

    expect(await uploads.listUnfinished()).toEqual([
      { processingJobId: file!.id, upload: uploading },
    ]);
    await uploads.write(file!.id, {
      ...uploading,
      state: "uploaded",
      uploadedBytes: uploading.totalBytes,
      filesPending: 0,
      finishedAtMs: 3,
    });
    expect(await uploads.listUnfinished()).toEqual([]);
  });
});
