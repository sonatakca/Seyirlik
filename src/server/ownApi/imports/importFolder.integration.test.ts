// @vitest-environment node
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabasePool } from "../database/databasePool";
import { runMigrations } from "../database/migrationRunner";
import { createDesiredItemRepository } from "../catalogue/desiredItems";
import { ownedFolderForItem } from "./importFolder";

/* Requires a disposable database. The schema is dropped. */
const databaseUrl = process.env.SEYIRLIK_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

const SERIES_ROOT = "D:\\media\\Series";

integration("the folder an import's item owns, in PostgreSQL", () => {
  const pool = createDatabasePool({
    connectionString: databaseUrl as string,
    maxConnections: 4,
  });
  const libraryId = randomUUID();

  async function child(
    seriesId: string,
    kind: "season" | "episode",
    sourceKey: string,
  ): Promise<string> {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO items (id, library_id, kind, source_key, title, sort_title, parent_id, series_id)
       VALUES ($1, $2, $3, $4::text, $4::text, $4::text, $5, $5)`,
      [id, libraryId, kind, sourceKey, seriesId],
    );
    return id;
  }

  beforeAll(async () => {
    await pool.query("DROP SCHEMA public CASCADE");
    await pool.query("CREATE SCHEMA public");
    await runMigrations(pool);
    await pool.query(
      `INSERT INTO libraries (id, slug, name, kind) VALUES ($1, 'series', 'Series', 'series')`,
      [libraryId],
    );
  });

  afterAll(async () => {
    await pool.end();
  });

  it("files an episode of a wanted series where the want keyed the series", async () => {
    const series = await createDesiredItemRepository(pool).desire({
      libraryId,
      libraryRoot: "Series",
      kind: "series",
      title: "Lilyhammer",
      year: 2012,
    });
    const episode = await child(series.id, "episode", "episode:lilyhammer:1:1");
    expect(await ownedFolderForItem(pool, series.id, SERIES_ROOT)).toBe(
      "Lilyhammer (2012)",
    );
    expect(await ownedFolderForItem(pool, episode, SERIES_ROOT)).toBe(
      "Lilyhammer (2012)",
    );
  });

  it("keeps a series that has files in the folder they are in", async () => {
    const seriesId = randomUUID();
    await pool.query(
      `INSERT INTO items (id, library_id, kind, source_key, title, sort_title, production_year)
       VALUES ($1, $2, 'series', 'series:series/the sopranos', 'The Sopranos', 'sopranos', 1999)`,
      [seriesId, libraryId],
    );
    const episode = await child(seriesId, "episode", "episode:sopranos:5:13");
    await pool.query(
      `INSERT INTO media_files
         (id, item_id, relative_path, container, size_bytes, mtime_ms, fingerprint, is_primary)
       VALUES ($1, $2, $3, 'mkv', 1, 1, 'fp', true)`,
      [
        randomUUID(),
        episode,
        "Series/The Sopranos/Season 5/src/The Sopranos - S05E13.mkv",
      ],
    );
    const another = await child(seriesId, "episode", "episode:sopranos:6:16");
    expect(await ownedFolderForItem(pool, another, SERIES_ROOT)).toBe(
      "The Sopranos",
    );
  });

  it("names nothing for an item that does not exist", async () => {
    expect(
      await ownedFolderForItem(pool, randomUUID(), SERIES_ROOT),
    ).toBeUndefined();
  });
});
