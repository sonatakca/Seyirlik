// @vitest-environment node
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createCatalogueRepository } from "../catalogue/catalogueRepository";
import { createDatabasePool } from "../database/databasePool";
import { runMigrations } from "../database/migrationRunner";
import { createProcessingJobStore } from "../processing/jobStore";
import {
  createProcessingEnqueuer,
  PROCESSING_JOB_TYPE,
} from "../processing/processingEnqueue";
import { createPermissiveStorageGuard } from "../processing/storageGuard";
import { createJobQueue } from "../tasks/jobQueue";
import {
  createImportProcessingStore,
  createImportProcessingSweep,
} from "./importProcessing";

vi.mock("../../../renditions/probe", () => ({
  probeMediaFile: vi.fn(async () => ({
    // Short, so the real disk preflight passes on any temporary volume.
    durationSeconds: 30,
    video: {
      width: 1920,
      height: 1080,
      rotation: 0,
      codec: "hevc",
      isHdr: false,
    },
    audioTracks: [],
    subtitleTracks: [],
    chapters: [],
  })),
  isHdrTransfer: () => false,
  isTextSubtitleCodec: () => true,
}));
vi.mock("../../../renditions/registry", async () => {
  const { createHash } = await import("node:crypto");
  return {
    // The real column is 128 characters; a temporary path is longer.
    computeSourceFingerprint: vi.fn(async (filePath: string) =>
      createHash("sha256").update(filePath).digest("hex"),
    ),
  };
});

/*
 * Imported files reach processing through the real enqueuer, job store and
 * queue — the unique indexes that stop a second job are only real here.
 *
 * Requires a disposable database. The schema is dropped.
 */
const databaseUrl = process.env.SEYIRLIK_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

const E02 = "Series/The Sopranos/Season 1/src/The Sopranos - S01E02.mkv";
const E02_OLD =
  "Series/The Sopranos/Season 1/The Sopranos - S01E02 - 46 Long.mp4";
const E03 = "Series/The Sopranos/Season 1/src/The Sopranos - S01E03.mkv";

integration("imported files queued for processing, in PostgreSQL", () => {
  const pool = createDatabasePool({
    connectionString: databaseUrl as string,
    maxConnections: 4,
  });
  const store = createImportProcessingStore(pool);
  const jobs = createProcessingJobStore(pool);
  let mediaRoot = "";
  let sweep: ReturnType<typeof createImportProcessingSweep>;
  const ids = {
    library: randomUUID(),
    series: randomUUID(),
    season: randomUUID(),
    e02: randomUUID(),
    e03: randomUUID(),
    oldFile: randomUUID(),
    newFile: randomUUID(),
    e03File: randomUUID(),
    importE02: randomUUID(),
    importE03: randomUUID(),
    importFileE02: randomUUID(),
    importFileE03: randomUUID(),
  };

  const item = (
    id: string,
    kind: string,
    title: string,
    parent: string | null,
  ) =>
    pool.query(
      `INSERT INTO items (id, library_id, parent_id, kind, source_key, title, sort_title)
       VALUES ($1, $2, $3, $4, $5, $6, $6)`,
      [id, ids.library, parent, kind, `key:${id}`, title],
    );

  const importedFile = async (
    importId: string,
    fileId: string,
    itemId: string,
    destinationRelative: string,
  ) => {
    await pool.query(
      `INSERT INTO imports (id, idempotency_key, target_kind, target_item_id,
                            target_title, source_root, library_root,
                            source_relative, state, committed_at)
       VALUES ($1, $2, 'episode', $3, 'The Sopranos', 'C:\\SeyirlikDownloads',
               '\\\\seyirlik\\drive\\media\\Series', 'release', 'complete', now())`,
      [importId, `seyirlik-import-${importId}`, itemId],
    );
    await pool.query(
      `INSERT INTO import_files (id, import_id, role, source_relative,
                                 destination_relative, destination_key, state)
       VALUES ($1, $2, 'media', 'release.mkv', $3, lower($3), 'committed')`,
      [fileId, importId, destinationRelative],
    );
  };

  const mediaFile = async (
    id: string,
    itemId: string,
    relativePath: string,
    { missing = false, primary = true, size = 1000 } = {},
  ) => {
    await pool.query(
      `INSERT INTO media_files (id, item_id, relative_path, size_bytes, mtime_ms,
                                fingerprint, is_primary, probe_state, missing_since)
       VALUES ($1, $2, $3, $4, 1, 'fp', $5, 'probed', $6)`,
      [id, itemId, relativePath, size, primary, missing ? new Date() : null],
    );
    if (!missing) {
      const absolute = path.join(mediaRoot, ...relativePath.split("/"));
      await mkdir(path.dirname(absolute), { recursive: true });
      await writeFile(absolute, "pretend source");
    }
  };

  const processingJobsFor = async (mediaFileId: string) =>
    (
      await pool.query<{ id: string }>(
        "SELECT id FROM processing_jobs WHERE media_file_id = $1",
        [mediaFileId],
      )
    ).rows;

  const decision = async (importFileId: string) =>
    (
      await pool.query<{
        processing_outcome: string | null;
        processing_job_id: string | null;
      }>(
        "SELECT processing_outcome, processing_job_id FROM import_files WHERE id = $1",
        [importFileId],
      )
    ).rows[0];

  beforeAll(async () => {
    await pool.query("DROP SCHEMA public CASCADE");
    await pool.query("CREATE SCHEMA public");
    await runMigrations(pool);
    mediaRoot = await mkdtemp(path.join(tmpdir(), "seyirlik-import-process-"));

    await pool.query(
      "INSERT INTO libraries (id, slug, name, kind) VALUES ($1, 'series', 'Series', 'series')",
      [ids.library],
    );
    await item(ids.series, "series", "The Sopranos", null);
    await item(ids.season, "season", "Season 1", ids.series);
    await item(ids.e02, "episode", "46 Long", ids.season);
    await item(ids.e03, "episode", "Denial, Anger, Acceptance", ids.season);

    // The copy from the drive that is gone: primary, larger, and missing.
    await mediaFile(ids.oldFile, ids.e02, E02_OLD, {
      missing: true,
      size: 9000,
    });
    await mediaFile(ids.newFile, ids.e02, E02, { primary: false });
    await importedFile(
      ids.importE02,
      ids.importFileE02,
      ids.e02,
      E02.replace("Series/", ""),
    );
    // Imported, but the scan has not registered it yet.
    await importedFile(
      ids.importE03,
      ids.importFileE03,
      ids.e03,
      E03.replace("Series/", ""),
    );

    const enqueuer = createProcessingEnqueuer({
      catalogue: createCatalogueRepository(pool),
      store: jobs,
      queue: createJobQueue(pool),
      mediaRoot,
      workRoot: mediaRoot,
      ffprobePath: "ffprobe",
      hardware: async () =>
        ({
          platform: "test",
          probedAt: new Date().toISOString(),
          adapters: [],
          selected: {
            h264: "h264_test",
            hevc: "hevc_test",
            hevcTenBit: "hevc_test",
          },
          selectedAdapter: { h264: "test", hevc: "test", hevcTenBit: "test" },
        }) as never,
      storageGuard: createPermissiveStorageGuard(mediaRoot),
    });
    sweep = createImportProcessingSweep({
      store,
      enqueueAll: enqueuer.enqueueAll,
      libraryRoots: ["Movies", "Series"],
    });
  });

  afterAll(async () => {
    await pool.end();
    if (mediaRoot) await rm(mediaRoot, { recursive: true, force: true });
  });

  it("queues the imported file, not the item's missing primary", async () => {
    const result = await sweep();
    expect(result).toMatchObject({ examined: 2, queued: 1, waiting: 1 });

    expect(await processingJobsFor(ids.oldFile)).toHaveLength(0);
    const created = await processingJobsFor(ids.newFile);
    expect(created).toHaveLength(1);
    expect(await decision(ids.importFileE02)).toEqual({
      processing_outcome: "queued",
      processing_job_id: created[0]!.id,
    });

    const attempts = await pool.query<{ payload: { sourcePath: string } }>(
      "SELECT payload FROM jobs WHERE job_type = $1",
      [PROCESSING_JOB_TYPE],
    );
    expect(attempts.rows).toHaveLength(1);
    expect(attempts.rows[0]!.payload.sourcePath).toBe(
      path.join(mediaRoot, ...E02.split("/")),
    );
  });

  it("creates nothing more when run again, or twice at once", async () => {
    await sweep();
    await Promise.all([sweep(), sweep()]);
    expect(await processingJobsFor(ids.newFile)).toHaveLength(1);
  });

  it("converges on the existing job when its decision was lost", async () => {
    // A crash between creating the job and recording it.
    await pool.query(
      "UPDATE import_files SET processing_outcome = NULL, processing_job_id = NULL WHERE id = $1",
      [ids.importFileE02],
    );
    const result = await sweep();
    expect(result.alreadyQueued).toBe(1);
    expect(await processingJobsFor(ids.newFile)).toHaveLength(1);
    expect((await decision(ids.importFileE02))?.processing_outcome).toBe(
      "already-queued",
    );
  });

  it("queues a file on the pass after the scan registers it", async () => {
    await mediaFile(ids.e03File, ids.e03, E03);
    const result = await sweep();
    expect(result).toMatchObject({ examined: 1, queued: 1, waiting: 0 });
    expect(await processingJobsFor(ids.e03File)).toHaveLength(1);
    expect(await sweep()).toMatchObject({ examined: 0 });
  });

  it("leaves a cancelled job cancelled", async () => {
    await pool.query(
      "UPDATE processing_jobs SET state = 'cancelled', finished_at = now() WHERE media_file_id = $1",
      [ids.e03File],
    );
    await sweep();
    expect(await processingJobsFor(ids.e03File)).toHaveLength(1);
  });

  it("refuses an outcome the sweep does not know", async () => {
    await expect(
      pool.query(
        "UPDATE import_files SET processing_outcome = 'maybe' WHERE id = $1",
        [ids.importFileE03],
      ),
    ).rejects.toThrow(/import_files_processing_outcome_known/);
  });
});
