// @vitest-environment node
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabasePool } from "../database/databasePool";
import { runMigrations } from "../database/migrationRunner";
import { createCatalogueRepository } from "./catalogueRepository";
import { createCatalogueScanStore } from "./catalogueScanStore";
import { createFileEpisodeRepository } from "./fileEpisodes";
import { createLibraryAdminRepository } from "./libraryAdmin";

/*
 * SpongeBob as it is on disk: a half-hour filed as S01E01 that holds three
 * stories, one of which (1x3) also has a file of its own, and a half-hour
 * filed as S10E11 that really holds 9x2. Requires a disposable database.
 */
const databaseUrl = process.env.SEYIRLIK_TEST_DATABASE_URL;
(databaseUrl ? describe : describe.skip)("files that hold several episodes", () => {
  const pool = createDatabasePool({
    connectionString: databaseUrl!,
    maxConnections: 2,
  });
  const library = randomUUID();
  const series = randomUUID();
  const ids: Record<string, string> = {};
  const files: Record<string, string> = {};

  async function episode(season: number, number: number, title: string) {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO items (id, library_id, series_id, kind, source_key, title, sort_title,
                          index_number, parent_index_number)
       VALUES ($1, $2, $3, 'episode', $4, $5, $5, $6, $7)`,
      [id, library, series, `episode:sb:${season}:${number}`, title, number, season],
    );
    ids[`${season}x${number}`] = id;
    return id;
  }

  async function file(name: string, itemId: string, size = 1000) {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO media_files (id, item_id, relative_path, size_bytes, mtime_ms, fingerprint, probe_state)
       VALUES ($1, $2, $3, $4, 1, $3, 'probed')`,
      [id, itemId, `Series/SpongeBob/${name}.mkv`, size],
    );
    files[name] = id;
    return id;
  }

  beforeAll(async () => {
    // Only ever an explicitly supplied, disposable test database.
    await pool.query("DROP SCHEMA public CASCADE");
    await pool.query("CREATE SCHEMA public");
    await runMigrations(pool);
    await pool.query(
      `INSERT INTO libraries (id, slug, name, kind) VALUES ($1, 'shows', 'Shows', 'series')`,
      [library],
    );
    await pool.query(
      `INSERT INTO items (id, library_id, kind, source_key, title, sort_title)
       VALUES ($1, $2, 'series', 'series:sb', 'SpongeBob SquarePants', 'spongebob')`,
      [series, library],
    );
    await episode(1, 1, "Help Wanted");
    await episode(1, 2, "Reef Blower");
    await episode(1, 3, "Tea at the Treedome");
    await episode(9, 2, "Eek, an Urchin!");
    await episode(10, 11, "Misfiled");
    await file("S01E01", ids["1x1"]!, 2000);
    await file("S01E03", ids["1x3"]!);
    await file("S10E11", ids["10x11"]!);

    const parts = createFileEpisodeRepository(pool);
    await parts.replaceForFile(
      files.S01E01!,
      [
        { itemId: ids["1x1"]!, startMs: 0, endMs: 548_000 },
        { itemId: ids["1x2"]!, startMs: 548_000, endMs: 720_000 },
        { itemId: ids["1x3"]!, startMs: 720_000, endMs: null },
      ],
      "survey",
    );
    await parts.replaceForFile(
      files.S10E11!,
      [{ itemId: ids["9x2"]!, startMs: 0, endMs: null }],
      "survey",
    );
  });
  afterAll(async () => {
    await pool.end();
  });

  it("holds what the files really hold, and not the misfiled number", async () => {
    const episodes = await createLibraryAdminRepository(pool).listEpisodes(
      series,
    );
    const held = Object.fromEntries(
      episodes.map((row) => [`${row.season}x${row.episode}`, row.hasMedia]),
    );
    expect(held).toEqual({
      "1x1": true,
      "1x2": true,
      "1x3": true,
      "9x2": true,
      "10x11": false,
    });
  });

  it("plays a held episode from its host's file, and a whole file of its own first", async () => {
    const catalogue = createCatalogueRepository(pool);
    expect((await catalogue.getPlayableFile(ids["1x2"]!))?.id).toBe(
      files.S01E01,
    );
    expect((await catalogue.getPlayableFile(ids["1x3"]!))?.id).toBe(
      files.S01E03,
    );
    expect((await catalogue.getPlayableFile(ids["9x2"]!))?.id).toBe(
      files.S10E11,
    );
    expect(await catalogue.getPlayableFile(ids["10x11"]!)).toBeNull();
    // The owner rule everything else uses is unchanged.
    expect((await catalogue.getPrimaryFile(ids["10x11"]!))?.id).toBe(
      files.S10E11,
    );

    expect(await catalogue.fileHoldsItem(files.S01E01!, ids["1x2"]!)).toBe(
      true,
    );
    expect(await catalogue.fileHoldsItem(files.S01E03!, ids["1x3"]!)).toBe(
      true,
    );
    expect(await catalogue.fileHoldsItem(files.S10E11!, ids["10x11"]!)).toBe(
      false,
    );
    expect(await catalogue.fileHoldsItem(files.S01E03!, ids["1x2"]!)).toBe(
      false,
    );
  });

  it("describes each held episode's stretch of its file, with the file's parts in order", async () => {
    const views = await createFileEpisodeRepository(pool).listForItems(
      Object.values(ids),
    );
    expect(views.get(ids["1x2"]!)).toEqual({
      playAs: { mediaFileId: files.S01E01, startMs: 548_000, endMs: 720_000 },
      fileParts: [
        expect.objectContaining({ itemId: ids["1x1"], title: "Help Wanted", startMs: 0 }),
        expect.objectContaining({ itemId: ids["1x2"], indexNumber: 2, parentIndexNumber: 1 }),
        expect.objectContaining({ itemId: ids["1x3"], startMs: 720_000 }),
      ],
    });
    expect(views.get(ids["1x1"]!)?.playAs).toEqual({
      mediaFileId: files.S01E01,
      startMs: 0,
      endMs: 548_000,
    });
    // Its own whole file plays, so the view describes nothing.
    expect(views.has(ids["1x3"]!)).toBe(false);
    expect(views.has(ids["10x11"]!)).toBe(false);
    expect(views.get(ids["9x2"]!)?.playAs.mediaFileId).toBe(files.S10E11);
  });

  it("tells the scan which files hold an episode, and never overwrites parts with a release name", async () => {
    const store = createCatalogueScanStore(pool);
    const listed = await store.listItems(library);
    expect(listed.find((item) => item.id === ids["1x2"])?.heldInFileIds).toEqual(
      [files.S01E01],
    );
    expect(listed.find((item) => item.id === ids["10x11"])?.heldInFileIds).toBeUndefined();

    await store.addReleaseParts(files.S01E01!, [ids["1x1"]!]);
    const kept = await pool.query(
      "SELECT count(*)::int AS n FROM media_file_episodes WHERE media_file_id = $1",
      [files.S01E01],
    );
    expect(kept.rows[0].n).toBe(3);

    const plain = await file("S09E02", ids["9x2"]!);
    await store.addReleaseParts(plain, [ids["9x2"]!, ids["1x2"]!]);
    const added = await pool.query<{ item_id: string; ordinal: number; source: string }>(
      "SELECT item_id, ordinal, source FROM media_file_episodes WHERE media_file_id = $1 ORDER BY ordinal",
      [plain],
    );
    expect(added.rows).toEqual([
      { item_id: ids["9x2"], ordinal: 0, source: "release" },
      { item_id: ids["1x2"], ordinal: 1, source: "release" },
    ]);
  });
});
