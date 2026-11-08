// @vitest-environment node
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabasePool } from "../database/databasePool";
import { runMigrations } from "../database/migrationRunner";
import { createCatalogueRepository } from "./catalogueRepository";
import { createLibraryAdminRepository } from "./libraryAdmin";

/*
 * The admin lists search on the client, so they must carry a title's other
 * names: the library board's titles, and the processing view's shows.
 * Requires a disposable database.
 */
const databaseUrl = process.env.SEYIRLIK_TEST_DATABASE_URL;
(databaseUrl ? describe : describe.skip)("search names in admin lists", () => {
  const pool = createDatabasePool({
    connectionString: databaseUrl!,
    maxConnections: 2,
  });
  const movies = randomUUID();
  const shows = randomUUID();

  async function item(input: {
    library: string;
    kind: string;
    title: string;
    originalTitle?: string;
    localized?: Record<string, string>;
    aliases?: string[];
    seriesId?: string;
    parentId?: string;
    season?: number;
    episode?: number;
  }) {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO items (id, library_id, kind, source_key, title, sort_title, original_title,
         localized_titles, search_aliases, series_id, parent_id, parent_index_number, index_number)
       VALUES ($1,$2,$3,$4,$5,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        id,
        input.library,
        input.kind,
        `${input.kind}:${id}`,
        input.title,
        input.originalTitle ?? null,
        JSON.stringify(input.localized ?? {}),
        input.aliases ?? [],
        input.seriesId ?? null,
        input.parentId ?? null,
        input.season ?? null,
        input.episode ?? null,
      ],
    );
    return id;
  }

  beforeAll(async () => {
    // Only ever an explicitly supplied, disposable test database.
    await pool.query("DROP SCHEMA public CASCADE");
    await pool.query("CREATE SCHEMA public");
    await runMigrations(pool);
    await pool.query(
      `INSERT INTO libraries (id, slug, name, kind) VALUES
         ($1, 'movies', 'Movies', 'movies'), ($2, 'shows', 'Shows', 'series')`,
      [movies, shows],
    );
  });
  afterAll(async () => {
    await pool.end();
  });

  it("gives the library board a film's original, translated and added names", async () => {
    const id = await item({
      library: movies,
      kind: "movie",
      title: "Ejderhanı Nasıl Eğitirsin",
      originalTitle: "How to Train Your Dragon",
      localized: { tr: "Ejderhanı Nasıl Eğitirsin" },
      aliases: ["Dragon 1"],
    });
    const title = (
      await createLibraryAdminRepository(pool).listTitles("movie")
    ).find((entry) => entry.id === id);
    expect(title?.searchNames).toEqual(["How to Train Your Dragon", "Dragon 1"]);
  });

  it("gives an episode row its series' other names", async () => {
    const series = await item({
      library: shows,
      kind: "series",
      title: "Ejderha Hanedanı",
      originalTitle: "House of the Dragon",
    });
    const season = await item({
      library: shows,
      kind: "season",
      title: "Sezon 1",
      seriesId: series,
      parentId: series,
      season: 1,
    });
    const episode = await item({
      library: shows,
      kind: "episode",
      title: "Ejderhanın Mirasçıları",
      seriesId: series,
      parentId: season,
      season: 1,
      episode: 1,
    });
    const rows = await createCatalogueRepository(pool).listProcessableTitles({
      kinds: ["episode"],
    });
    expect(rows.find((row) => row.itemId === episode)?.seriesSearchNames).toEqual(
      ["House of the Dragon"],
    );
  });
});
