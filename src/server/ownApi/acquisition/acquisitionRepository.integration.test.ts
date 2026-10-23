// @vitest-environment node
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabasePool } from "../database/databasePool";
import { runMigrations } from "../database/migrationRunner";
import { createAcquisitionRepository } from "./acquisitionRepository";
import type { CreateAcquisitionInput } from "./acquisitionRepository";

/*
 * The parts of an acquisition that only PostgreSQL can answer: that migration
 * 021 produces the schema the repository writes, that the unique idempotency
 * key really is unique, and — the one that matters — that a conditional update
 * lets exactly one of two workers win a row.
 *
 * Requires a disposable database. The schema is dropped.
 */
const databaseUrl = process.env.SEYIRLIK_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

integration("acquisitions in PostgreSQL", () => {
  const pool = createDatabasePool({
    connectionString: databaseUrl as string,
    maxConnections: 4,
  });
  const repository = createAcquisitionRepository(pool);

  const input: CreateAcquisitionInput = {
    target: { kind: "movie", title: "Big Buck Bunny", year: 2008 },
    indexerId: "nzbgeek",
    releaseGuid: "abc123",
    releaseTitle: "Big.Buck.Bunny.2008.1080p.WEB-DL",
    origin: "manual",
    evidence: {
      profileName: "HD-1080p",
      policySnapshot: { cutoff: "webdl-1080p" },
      releaseFacts: { resolution: 1080 },
      score: 42,
      reasons: [{ code: "quality", detail: "Meets the cutoff." }],
      rejected: [],
    },
  };

  beforeAll(async () => {
    await pool.query("DROP SCHEMA public CASCADE");
    await pool.query("CREATE SCHEMA public");
    await runMigrations(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  it("creates an acquisition with an idempotency key already on it", async () => {
    /*
     * The key exists before anything could be submitted under it. Generating
     * it later — at submission — would leave a window in which two workers
     * invent two different keys for one acquisition and send it twice.
     */
    const created = await repository.create(input);
    expect(created.state).toBe("planned");
    expect(created.idempotencyKey).toBe(`seyirlik-${created.id}`);
    // Attempts made, not the attempt about to be made: nothing has been sent
    // yet, and `submit` is what raises it. Counting from one here would give
    // every release one retry more than the cap allows.
    expect(created.attempt).toBe(0);
    expect(created.externalId).toBeUndefined();
  });

  it("refuses two rows with the same idempotency key", async () => {
    const created = await repository.create(input);
    await expect(
      pool.query(
        `INSERT INTO acquisitions
           (id, target_kind, target_title, indexer_id, release_guid,
            release_title, state, origin, idempotency_key)
         VALUES ($1,'movie','Copy','nzbgeek','abc123','Copy','planned','manual',$2)`,
        [randomUUID(), created.idempotencyKey],
      ),
    ).rejects.toThrow(/duplicate key|unique/i);
  });

  it("records the decision that chose the release", async () => {
    const created = await repository.create(input);
    const decisions = await pool.query<{
      profile_name: string;
      score: number;
      policy_snapshot: unknown;
    }>(
      `SELECT profile_name, score, policy_snapshot
         FROM acquisition_decisions WHERE acquisition_id = $1`,
      [created.id],
    );
    expect(decisions.rows).toHaveLength(1);
    expect(decisions.rows[0]).toMatchObject({
      profile_name: "HD-1080p",
      score: 42,
      // A snapshot, not a reference: the policy may be edited afterwards, and
      // the record must still say what was decided at the time.
      policy_snapshot: { cutoff: "webdl-1080p" },
    });
  });

  it("lets exactly one of two workers move the same row", async () => {
    // The whole of the concurrency argument, against a real database.
    const created = await repository.create(input);
    const [first, second] = await Promise.all([
      repository.update(created.id, "planned", { state: "resolving" }, "A"),
      repository.update(created.id, "planned", { state: "resolving" }, "B"),
    ]);
    expect([first, second].filter(Boolean)).toHaveLength(1);
    expect((await repository.get(created.id))?.state).toBe("resolving");
  });

  it("refuses an update from a state the row has left", async () => {
    const created = await repository.create(input);
    await repository.update(created.id, "planned", { state: "resolving" });
    expect(
      await repository.update(created.id, "planned", { state: "submitting" }),
    ).toBe(false);
    expect((await repository.get(created.id))?.state).toBe("resolving");
  });

  it("writes one event per state change, and none for a repeated observation", async () => {
    const created = await repository.create(input);
    await repository.update(created.id, "planned", { state: "resolving" });
    await repository.update(created.id, "resolving", { state: "queued" });
    // A poll that finds nothing new must not grow the audit trail.
    await repository.update(created.id, "queued", { state: "queued" });

    const detail = await repository.detail(created.id);
    expect(detail?.events.map((event) => event.toState)).toEqual([
      "planned",
      "resolving",
      "queued",
    ]);
    expect(detail?.events[0]!.fromState).toBeNull();
  });

  it("keeps a failure class and detail with the event that recorded it", async () => {
    const created = await repository.create(input);
    await repository.update(
      created.id,
      "planned",
      {
        state: "failed",
        failureClass: "missing-articles",
        failureDetail: "SABnzbd could not find enough of it.",
      },
      "Failed during download.",
    );
    const detail = await repository.detail(created.id);
    expect(detail?.acquisition).toMatchObject({
      state: "failed",
      failureClass: "missing-articles",
    });
    expect(detail?.events.at(-1)).toMatchObject({
      toState: "failed",
      failureClass: "missing-articles",
      detail: "Failed during download.",
    });
  });

  it("leaves a field alone when the patch does not mention it", async () => {
    const created = await repository.create(input);
    await repository.update(created.id, "planned", {
      state: "queued",
      externalId: "SABnzbd_nzo_1",
    });
    await repository.update(created.id, "queued", { state: "downloading" });
    expect((await repository.get(created.id))?.externalId).toBe(
      "SABnzbd_nzo_1",
    );
  });

  it("clears a retry delay when asked to, and only then", async () => {
    /*
     * `retry_after` is the one field a patch must be able to blank, so a
     * person pressing retry gets it now. `COALESCE` cannot express that, which
     * is why the statement carries an explicit "was it mentioned" flag.
     */
    const created = await repository.create(input);
    await repository.update(created.id, "planned", {
      state: "awaiting_retry",
      retryAfterMs: Date.now() + 60_000,
    });
    const withDelay = await pool.query<{ retry_after: Date | null }>(
      "SELECT retry_after FROM acquisitions WHERE id = $1",
      [created.id],
    );
    expect(withDelay.rows[0]!.retry_after).not.toBeNull();

    await repository.update(created.id, "awaiting_retry", { attempt: 2 });
    const untouched = await pool.query<{ retry_after: Date | null }>(
      "SELECT retry_after FROM acquisitions WHERE id = $1",
      [created.id],
    );
    expect(untouched.rows[0]!.retry_after).not.toBeNull();

    await repository.update(created.id, "awaiting_retry", {
      retryAfterMs: null,
    });
    const cleared = await pool.query<{ retry_after: Date | null }>(
      "SELECT retry_after FROM acquisitions WHERE id = $1",
      [created.id],
    );
    expect(cleared.rows[0]!.retry_after).toBeNull();
  });

  it("stores a size larger than a 32-bit integer", async () => {
    // A UHD remux is comfortably past 2 GB, and past 2^31 bytes.
    const created = await repository.create(input);
    const huge = 80_000_000_000;
    await repository.update(created.id, "planned", {
      state: "downloading",
      sizeBytes: huge,
    });
    expect((await repository.get(created.id))?.sizeBytes).toBe(huge);
  });

  it("offers only finished downloads to the import phase", async () => {
    const finished = await repository.create(input);
    await repository.update(finished.id, "planned", {
      state: "downloaded",
      downloadPath: "C:/SeyirlikDownloads/complete/seyirlik/Big Buck Bunny",
    });
    const running = await repository.create(input);
    await repository.update(running.id, "planned", { state: "downloading" });

    const ready = await repository.listReadyForImport();
    const ids = ready.map((row) => row.id);
    expect(ids).toContain(finished.id);
    expect(ids).not.toContain(running.id);
    expect(ready.every((row) => row.downloadPath)).toBe(true);
  });

  it("does not offer a finished download that has no path yet", async () => {
    // Completion is observed before the path is known; a handoff without one
    // would tell the import phase to go looking for nothing.
    const created = await repository.create(input);
    await repository.update(created.id, "planned", { state: "downloaded" });
    const ready = await repository.listReadyForImport();
    expect(ready.map((row) => row.id)).not.toContain(created.id);
  });

  it("lists what is still running and nothing that has finished", async () => {
    const active = await repository.create(input);
    await repository.update(active.id, "planned", { state: "downloading" });
    const done = await repository.create(input);
    await repository.update(done.id, "planned", { state: "downloaded" });
    const stopped = await repository.create(input);
    await repository.update(stopped.id, "planned", { state: "cancelled" });

    const ids = (await repository.listActive()).map((row) => row.id);
    expect(ids).toContain(active.id);
    expect(ids).not.toContain(done.id);
    expect(ids).not.toContain(stopped.id);
  });

  it("stamps a completion time when the download finishes", async () => {
    const created = await repository.create(input);
    await repository.update(created.id, "planned", { state: "downloaded" });
    const completed = await pool.query<{ completed_at: Date | null }>(
      "SELECT completed_at FROM acquisitions WHERE id = $1",
      [created.id],
    );
    expect(completed.rows[0]!.completed_at).toBeInstanceOf(Date);
  });

  it("knows whether an episode already has a download, by its own title", async () => {
    const episode = (n: number) => ({
      ...input,
      target: {
        kind: "episode" as const,
        title: "Replacement Show",
        season: 1,
        episode: n,
      },
    });
    const first = await repository.create(episode(1));
    expect(await repository.hasLiveAcquisitionFor(episode(1).target)).toBe(
      true,
    );
    expect(await repository.hasLiveAcquisitionFor(episode(2).target)).toBe(
      false,
    );

    // A failed download is not one: the episode is still wanted.
    await repository.update(first.id, "planned", {
      state: "failed",
      failureClass: "missing-articles",
    });
    expect(await repository.hasLiveAcquisitionFor(episode(1).target)).toBe(
      false,
    );
  });

  it("keeps two seasons of one series apart when both name the series", async () => {
    // A season pack and an episode the catalogue has no row for both point
    // at their series, so the item alone cannot tell them apart.
    const libraryId = randomUUID();
    const seriesId = randomUUID();
    await pool.query(
      `INSERT INTO libraries (id, slug, name, kind) VALUES ($1,'tv','TV','series')`,
      [libraryId],
    );
    await pool.query(
      `INSERT INTO items (id, library_id, kind, source_key, title, sort_title)
       VALUES ($1,$2,'series','series:sopranos','The Sopranos','sopranos')`,
      [seriesId, libraryId],
    );
    const pack = (season: number) => ({
      ...input,
      target: {
        kind: "season" as const,
        itemId: seriesId,
        title: "The Sopranos",
        season,
      },
    });
    const episode = (n: number) => ({
      ...input,
      target: {
        kind: "episode" as const,
        itemId: seriesId,
        // A title the matching by name could not join on.
        title: `Sopranos ${n}`,
        season: 6,
        episode: n,
      },
    });

    const failed = await repository.create(pack(5));
    await repository.update(failed.id, "planned", {
      state: "failed",
      failureClass: "missing-articles",
    });
    const other = await repository.create(pack(6));
    expect(await repository.supersedeFailedFor(other.id)).toBe(0);
    expect(await repository.hasLiveAcquisitionFor(pack(6).target)).toBe(true);
    expect(await repository.hasLiveAcquisitionFor(pack(4).target)).toBe(false);

    await repository.create(episode(2));
    expect(await repository.hasLiveAcquisitionFor(episode(2).target)).toBe(
      true,
    );
    expect(await repository.hasLiveAcquisitionFor(episode(3).target)).toBe(
      false,
    );

    // The same season is still the same target.
    const again = await repository.create(pack(5));
    expect(await repository.supersedeFailedFor(again.id)).toBe(1);
  });

  it("stops counting a finished download once its import is done with it", async () => {
    const pack = (season: number) => ({
      ...input,
      target: { kind: "season" as const, title: "Imported Show", season },
    });
    const finish = async (season: number) => {
      const created = await repository.create(pack(season));
      await repository.update(created.id, "planned", { state: "downloaded" });
      return created.id;
    };
    const importOf = async (acquisitionId: string, state: string) =>
      pool.query(
        `INSERT INTO imports (id, acquisition_id, target_kind, target_title, target_season,
           source_root, library_root, source_relative, state, idempotency_key)
         VALUES ($1,$2,'season','Imported Show',1,'/d','/l','x',$3,$4)`,
        [randomUUID(), acquisitionId, state, `k-${randomUUID()}`],
      );

    // Just downloaded, nothing has picked it up yet: still coming.
    await finish(1);
    expect(await repository.hasLiveAcquisitionFor(pack(1).target)).toBe(true);

    // Being imported: still coming.
    await importOf(await finish(2), "staging");
    expect(await repository.hasLiveAcquisitionFor(pack(2).target)).toBe(true);

    // Imported, or given up on: whatever it did not file is missing again.
    await importOf(await finish(3), "complete");
    expect(await repository.hasLiveAcquisitionFor(pack(3).target)).toBe(false);
    await importOf(await finish(4), "failed");
    expect(await repository.hasLiveAcquisitionFor(pack(4).target)).toBe(false);

    // Imported, but the library scan has not registered the file yet: the
    // episode has no media and must not be searched again. The sweep decides
    // the file once the scan sees it; after that, the import is done.
    const landing = async (season: number) => {
      const importId = randomUUID();
      await pool.query(
        `INSERT INTO imports (id, acquisition_id, target_kind, target_title, target_season,
           source_root, library_root, source_relative, state, idempotency_key, committed_at)
         VALUES ($1,$2,'season','Imported Show',$3,'/d','/l','x','complete',$4, now())`,
        [importId, await finish(season), season, `k-${randomUUID()}`],
      );
      const fileId = randomUUID();
      await pool.query(
        `INSERT INTO import_files (id, import_id, role, source_relative, destination_relative, state)
         VALUES ($1,$2,'media','x.mkv','Imported Show/x.mkv','committed')`,
        [fileId, importId],
      );
      return { importId, fileId };
    };
    await landing(6);
    expect(await repository.hasLiveAcquisitionFor(pack(6).target)).toBe(true);
    const decided = await landing(7);
    await pool.query(
      "UPDATE import_files SET processing_outcome = 'queued' WHERE id = $1",
      [decided.fileId],
    );
    expect(await repository.hasLiveAcquisitionFor(pack(7).target)).toBe(false);
    // Nothing ever decides with the sweep switched off, so a day-old import
    // no longer stands for anything coming.
    const forgotten = await landing(8);
    await pool.query(
      "UPDATE imports SET committed_at = now() - interval '2 days' WHERE id = $1",
      [forgotten.importId],
    );
    expect(await repository.hasLiveAcquisitionFor(pack(8).target)).toBe(false);

    // Downloaded long ago and never imported: no longer on its way.
    const stale = await finish(5);
    await pool.query(
      "UPDATE acquisitions SET completed_at = now() - interval '2 days' WHERE id = $1",
      [stale],
    );
    expect(await repository.hasLiveAcquisitionFor(pack(5).target)).toBe(false);
  });

  it("counts the replacements a title has had", async () => {
    const season = {
      ...input,
      target: { kind: "season" as const, title: "Counted Show", season: 2 },
    };
    const original = await repository.create(season);
    expect(await repository.replacementsFor(original.id)).toBe(0);
    await repository.create({ ...season, origin: "fallback" });
    await repository.create({ ...season, origin: "fallback" });
    // Another season of the same show is another title.
    await repository.create({
      ...season,
      target: { ...season.target, season: 3 },
      origin: "fallback",
    });
    expect(await repository.replacementsFor(original.id)).toBe(2);
  });

  it("returns nothing for an acquisition that does not exist", async () => {
    const absent = "00000000-0000-4000-8000-000000000000";
    expect(await repository.get(absent)).toBeNull();
    expect(await repository.detail(absent)).toBeNull();
    expect(
      await repository.update(absent, "planned", { state: "queued" }),
    ).toBe(false);
  });
});
