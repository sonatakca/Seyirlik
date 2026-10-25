// @vitest-environment node
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabasePool } from "../database/databasePool";
import { runMigrations } from "../database/migrationRunner";
import { createOriginalLanguageLookup } from "../processing/originalLanguage";
import { createMetadataRepository } from "./metadataRepository";

/* Requires a disposable database. The schema is dropped. */
const databaseUrl = process.env.SEYIRLIK_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

integration("titles waiting for metadata, in PostgreSQL", () => {
  const pool = createDatabasePool({
    connectionString: databaseUrl as string,
    maxConnections: 4,
  });
  const repository = createMetadataRepository(pool);
  const libraryId = randomUUID();

  async function item(
    kind: string,
    state: string,
    seriesId: string | null = null,
  ): Promise<string> {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO items (id, library_id, kind, source_key, title, sort_title, series_id, parent_id, metadata_state)
       VALUES ($1, $2, $3::text, $4::text, 'Title', 'title', $5::uuid, $5::uuid, $6::text)`,
      [id, libraryId, kind, `${kind}:${id}`, seriesId, state],
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

  it("selects an identified series again while a new episode is undescribed", async () => {
    const waiting = await item("series", "matched");
    await item("episode", "matched", waiting);
    await item("episode", "pending", waiting);
    const settled = await item("series", "matched");
    await item("episode", "matched", settled);
    await item("episode", "unmatched", settled);
    const fresh = await item("series", "pending");

    const pending = (await repository.listPendingItems(50, libraryId)).map(
      (target) => target.id,
    );
    expect(pending).toContain(waiting);
    expect(pending).toContain(fresh);
    expect(pending).not.toContain(settled);
  });

  it("reads an episode's state back for the refresh to settle", async () => {
    const series = await item("series", "matched");
    const episode = await item("episode", "pending", series);
    const episodes = await repository.listEpisodesForSeries(series);
    expect(
      episodes.find((target) => target.id === episode)?.metadataState,
    ).toBe("pending");
  });

  it("records the original language, and an episode answers with its series'", async () => {
    const series = await item("series", "pending");
    const episode = await item("episode", "pending", series);
    const originalLanguageFor = createOriginalLanguageLookup(pool);
    expect(await originalLanguageFor(episode)).toBeUndefined();

    await repository.applyTitleMetadata(series, { originalLanguage: "en" });
    // A later refresh that brings no language keeps the one already known.
    await repository.applyTitleMetadata(series, { overview: "Again." });

    expect(await originalLanguageFor(series)).toBe("en");
    expect(await originalLanguageFor(episode)).toBe("en");
  });
});
