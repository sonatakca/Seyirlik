// @vitest-environment node
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabasePool } from "../database/databasePool";
import { runMigrations } from "../database/migrationRunner";
import { createCatalogueScanStore } from "./catalogueScanStore";

/*
 * A scan names every item it finds, but a name it had to invent ("Episode 2",
 * from a file named by number alone) must never replace the title the
 * catalogue already holds. Every scan used to do exactly that, undoing the
 * provider's episode titles ten minutes after a metadata refresh wrote them.
 *
 * Requires a disposable database. The schema is dropped.
 */
const databaseUrl = process.env.SEYIRLIK_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

integration("scan upserts and episode titles", () => {
  const pool = createDatabasePool({
    connectionString: databaseUrl as string,
    maxConnections: 2,
  });
  const store = createCatalogueScanStore(pool);
  let libraryId = "";

  const upsert = (title: string, titleIsPlaceholder?: boolean) =>
    store.upsertItem({
      libraryId,
      sourceKey: "series:the-sopranos:1:2",
      kind: "episode",
      title,
      sortTitle: "0001-00002",
      year: undefined,
      indexNumber: 2,
      parentIndexNumber: 1,
      lockedFields: [],
      ...(titleIsPlaceholder ? { titleIsPlaceholder: true } : {}),
    });
  const titleOf = async (id: string) =>
    (
      await pool.query<{ title: string }>(
        "SELECT title FROM items WHERE id = $1",
        [id],
      )
    ).rows[0]?.title;

  beforeAll(async () => {
    await pool.query("DROP SCHEMA public CASCADE");
    await pool.query("CREATE SCHEMA public");
    await runMigrations(pool);
    libraryId = randomUUID();
    await pool.query(
      "INSERT INTO libraries (id,slug,name,kind) VALUES ($1,'series','Series','series')",
      [libraryId],
    );
  });

  afterAll(async () => {
    await pool.end();
  });

  it("names a new episode with the stand-in", async () => {
    const id = await upsert("Episode 2", true);
    expect(await titleOf(id)).toBe("Episode 2");
  });

  it("keeps the provider's title when a later scan has only the stand-in", async () => {
    const id = await upsert("Episode 2", true);
    await pool.query("UPDATE items SET title = '46 Long' WHERE id = $1", [id]);
    await upsert("Episode 2", true);
    expect(await titleOf(id)).toBe("46 Long");
  });

  it("still follows a real title on disk", async () => {
    const id = await upsert("46 Long (Director's Cut)");
    expect(await titleOf(id)).toBe("46 Long (Director's Cut)");
  });
});
