// @vitest-environment node
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabasePool } from "../database/databasePool";
import { runMigrations } from "../database/migrationRunner";
import { createImageRepository } from "./imageRepository";

/* Requires a disposable database. The schema is dropped. */
const databaseUrl = process.env.SEYIRLIK_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

integration("a backdrop's focus, in PostgreSQL", () => {
  const pool = createDatabasePool({
    connectionString: databaseUrl as string,
    maxConnections: 4,
  });
  const images = createImageRepository(pool);
  const libraryId = randomUUID();

  async function film(): Promise<string> {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO items (id, library_id, kind, source_key, title, sort_title)
       VALUES ($1, $2, 'movie', $3, 'Film', 'film')`,
      [id, libraryId, `movie:${id}`],
    );
    return id;
  }

  function backdrop(itemId: string, contentHash: string) {
    return {
      itemId,
      imageType: "backdrop",
      imageIndex: 0,
      contentHash,
      contentType: "image/jpeg",
      width: 3840,
      height: 1600,
      sizeBytes: 10,
      storageKey: `aa/${contentHash}.jpg`,
      source: "tmdb",
      sourceUrl: null,
    };
  }

  const focusOf = async (itemId: string) =>
    (await images.listForItems([itemId])).find(
      (image) => image.imageType === "backdrop",
    )?.focus;

  beforeAll(async () => {
    await pool.query("DROP SCHEMA public CASCADE");
    await pool.query("CREATE SCHEMA public");
    await runMigrations(pool);
    await pool.query(
      `INSERT INTO libraries (id, slug, name, kind) VALUES ($1, 'films', 'Films', 'movies')`,
      [libraryId],
    );
  });

  afterAll(async () => {
    await pool.end();
  });

  it("stores a point and reads it back with the image", async () => {
    const id = await film();
    await images.upsert(backdrop(id, "first"));
    expect(await focusOf(id)).toBeNull();

    expect(await images.setFocus(id, "backdrop", 0, { x: 0.8, y: 0.3 })).toBe(
      true,
    );
    const focus = await focusOf(id);
    expect(focus?.x).toBeCloseTo(0.8);
    expect(focus?.y).toBeCloseTo(0.3);

    expect(await images.setFocus(id, "backdrop", 0, null)).toBe(true);
    expect(await focusOf(id)).toBeNull();
  });

  it("says when there is no backdrop to set it on", async () => {
    const id = await film();
    expect(await images.setFocus(id, "backdrop", 0, { x: 0.5, y: 0.5 })).toBe(
      false,
    );
  });

  it("keeps it through a refresh that brings the same picture", async () => {
    const id = await film();
    await images.upsert(backdrop(id, "same"));
    await images.setFocus(id, "backdrop", 0, { x: 0.2, y: 0.6 });

    await images.upsert(backdrop(id, "same"));
    expect((await focusOf(id))?.x).toBeCloseTo(0.2);
  });

  it("clears it when the picture is replaced, automatically or by hand", async () => {
    const automatic = await film();
    await images.upsert(backdrop(automatic, "old"));
    await images.setFocus(automatic, "backdrop", 0, { x: 0.2, y: 0.6 });
    await images.upsert(backdrop(automatic, "new"));
    expect(await focusOf(automatic)).toBeNull();

    const chosen = await film();
    await images.upsert(backdrop(chosen, "old"));
    await images.setFocus(chosen, "backdrop", 0, { x: 0.9, y: 0.1 });
    await images.replaceLocked(backdrop(chosen, "picked"));
    expect(await focusOf(chosen)).toBeNull();
  });

  it("refuses half a point or one outside the picture", async () => {
    const id = await film();
    await images.upsert(backdrop(id, "checked"));
    await expect(
      pool.query(`UPDATE item_images SET focus_x = 0.5 WHERE item_id = $1`, [
        id,
      ]),
    ).rejects.toThrow(/item_images_focus_complete/);
    await expect(
      pool.query(
        `UPDATE item_images SET focus_x = 1.5, focus_y = 0.5 WHERE item_id = $1`,
        [id],
      ),
    ).rejects.toThrow(/item_images_focus_in_range/);
  });
});
