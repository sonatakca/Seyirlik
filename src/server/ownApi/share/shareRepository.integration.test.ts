// @vitest-environment node
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabasePool } from "../database/databasePool";
import { runMigrations } from "../database/migrationRunner";
import { createShareRepository } from "./shareRepository";

const databaseUrl = process.env.SEYIRLIK_TEST_DATABASE_URL;
(databaseUrl ? describe : describe.skip)("what a shared link reads", () => {
  const pool = createDatabasePool({
    connectionString: databaseUrl!,
    maxConnections: 4,
  });
  const repository = createShareRepository(pool);
  const library = randomUUID();
  const ids = {
    movie: randomUUID(),
    series: randomUUID(),
    season: randomUUID(),
    episode: randomUUID(),
    collection: randomUUID(),
  };

  async function image(itemId: string, type: "cover" | "logo") {
    await pool.query(
      `INSERT INTO item_images (id, item_id, image_type, content_hash, content_type, size_bytes, storage_key, source)
       VALUES ($1, $2, $3, $4, 'image/png', 1, $5, 'upload')`,
      [
        randomUUID(),
        itemId,
        type,
        `${type}-${itemId}`,
        `${type}/${itemId}.png`,
      ],
    );
  }

  beforeAll(async () => {
    // Only ever an explicitly supplied, disposable test database.
    await pool.query("DROP SCHEMA public CASCADE");
    await pool.query("CREATE SCHEMA public");
    await runMigrations(pool);
    await pool.query(
      `INSERT INTO libraries (id, slug, name, kind) VALUES ($1,'mixed','Mixed','movies')`,
      [library],
    );
    const insert = (
      id: string,
      kind: string,
      title: string,
      extra: { seriesId?: string; season?: number; episode?: number } = {},
    ) =>
      pool.query(
        `INSERT INTO items (id, library_id, kind, source_key, title, sort_title, series_id,
           parent_index_number, index_number, production_year, overview)
         VALUES ($1,$2,$3,$9,$4,$4,$5,$6,$7,2008,$8)`,
        [
          id,
          library,
          kind,
          title,
          extra.seriesId ?? null,
          extra.season ?? null,
          extra.episode ?? null,
          `${title} overview`,
          `share:${id}`,
        ],
      );
    await insert(ids.movie, "movie", "Dune");
    await insert(ids.series, "series", "Ezel");
    await insert(ids.season, "season", "1. Sezon", {
      seriesId: ids.series,
      season: 1,
    });
    await insert(ids.episode, "episode", "Pilot", {
      seriesId: ids.series,
      season: 1,
      episode: 1,
    });
    await insert(ids.collection, "collection", "Dune Collection");
    await image(ids.movie, "cover");
    await image(ids.series, "cover");
    await image(ids.series, "logo");
    await pool.query(
      `UPDATE items SET logo_offset_x = 0.5, logo_offset_y = 0.8, logo_width = 0.5, logo_shadow = 1
       WHERE id = $1`,
      [ids.series],
    );
  });

  afterAll(() => pool.end());

  it("reads a film's own artwork, with no layout when none was saved", async () => {
    const movie = await repository.getItem(ids.movie);
    expect(movie).toMatchObject({
      kind: "movie",
      title: "Dune",
      productionYear: 2008,
      overview: "Dune overview",
      cardItemId: ids.movie,
      cover: { storageKey: `cover/${ids.movie}.png` },
      logo: null,
      logoLayout: null,
    });
  });

  it("draws an episode with its series' card and names the series", async () => {
    const episode = await repository.getItem(ids.episode);
    expect(episode).toMatchObject({
      kind: "episode",
      title: "Pilot",
      seriesTitle: "Ezel",
      seriesOverview: "Ezel overview",
      parentIndexNumber: 1,
      indexNumber: 1,
      cardItemId: ids.series,
      cover: { storageKey: `cover/${ids.series}.png` },
      logo: { storageKey: `logo/${ids.series}.png` },
      logoLayout: { x: 0.5, y: 0.8, width: 0.5, shadow: 1 },
    });
    expect((await repository.getItem(ids.season))?.cardItemId).toBe(ids.series);
  });

  it("answers nothing for what is not a title", async () => {
    expect(await repository.getItem(ids.collection)).toBeNull();
    expect(await repository.getItem(randomUUID())).toBeNull();
  });
});
