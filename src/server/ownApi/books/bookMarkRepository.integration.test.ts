// @vitest-environment node
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabasePool } from "../database/databasePool";
import { runMigrations } from "../database/migrationRunner";
import { createBookMarkRepository } from "./bookMarkRepository";

/* Requires a disposable database. The schema is dropped. */
const databaseUrl = process.env.SEYIRLIK_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

/**
 * Which device's change to a mark wins is SQL (an upsert guarded by
 * changed_at, capped at the server clock), so only a real database proves it.
 */
integration("book marks in PostgreSQL", () => {
  const pool = createDatabasePool({
    connectionString: databaseUrl as string,
    maxConnections: 4,
  });
  const marks = createBookMarkRepository(pool);
  const reader = randomUUID();
  const other = randomUUID();
  const book = randomUUID();
  const library = randomUUID();
  const minutesAgo = (minutes: number) =>
    new Date(Date.now() - minutes * 60_000);
  const highlight = {
    cfi: "epubcfi(/6/4!/4/2,/1:0,/1:12)",
    label: "Bir",
    excerpt: "Vurgulanan cümle.",
    progress: 0.1,
    color: "green" as const,
    createdAt: minutesAgo(30),
  };

  beforeAll(async () => {
    await pool.query("DROP SCHEMA public CASCADE");
    await pool.query("CREATE SCHEMA public");
    await runMigrations(pool);
    for (const [id, name] of [
      [reader, "reader"],
      [other, "other"],
    ]) {
      await pool.query(
        "INSERT INTO native_users (id,normalized_username,display_name,password_hash) VALUES ($1,$2,$2,'$argon2id$test')",
        [id, name],
      );
    }
    await pool.query(
      "INSERT INTO libraries (id,slug,name,kind) VALUES ($1,'books','Books','books')",
      [library],
    );
    await pool.query(
      "INSERT INTO items (id, library_id, kind, source_key, title, sort_title) VALUES ($1,$2,'book','iliad','Iliad','Iliad')",
      [book, library],
    );
  });

  afterAll(async () => {
    await pool.end();
  });

  it("has no marks until one is made, then keeps them in reading order", async () => {
    expect(await marks.list(reader, book)).toEqual([]);

    const kept = await marks.apply(reader, book, [
      {
        id: "late",
        changedAt: minutesAgo(10),
        mark: { ...highlight, progress: 0.8 },
      },
      {
        id: "early",
        changedAt: minutesAgo(10),
        mark: {
          ...highlight,
          cfi: "epubcfi(/6/2!/4/2/1:0)",
          progress: 0.05,
          color: null,
        },
      },
    ]);
    expect(kept.map((mark) => [mark.id, mark.color, mark.progress])).toEqual([
      ["early", null, 0.05],
      ["late", "green", 0.8],
    ]);
    expect(await marks.list(reader, book)).toEqual(kept);
  });

  it("takes a later change from another device and refuses an earlier one", async () => {
    await marks.apply(reader, book, [
      {
        id: "late",
        changedAt: minutesAgo(2),
        mark: { ...highlight, progress: 0.8, color: "pink" },
      },
    ]);
    // A change from a device that was offline since before, arriving late.
    const stale = await marks.apply(reader, book, [
      {
        id: "late",
        changedAt: minutesAgo(5),
        mark: { ...highlight, progress: 0.8, color: "blue" },
      },
    ]);
    expect(stale.find((mark) => mark.id === "late")?.color).toBe("pink");
  });

  it("keeps a removal against an older copy of the mark", async () => {
    const removed = await marks.apply(reader, book, [
      { id: "early", changedAt: minutesAgo(1), mark: null },
    ]);
    expect(removed.map((mark) => mark.id)).toEqual(["late"]);

    // The other device still had it, made before the removal: it stays gone.
    const resent = await marks.apply(reader, book, [
      {
        id: "early",
        changedAt: minutesAgo(10),
        mark: {
          ...highlight,
          cfi: "epubcfi(/6/2!/4/2/1:0)",
          progress: 0.05,
          color: null,
        },
      },
    ]);
    expect(resent.map((mark) => mark.id)).toEqual(["late"]);

    // The removed row keeps nothing of what it marked.
    const row = await pool.query(
      "SELECT removed, cfi, excerpt FROM user_book_marks WHERE user_id = $1 AND mark_id = 'early'",
      [reader],
    );
    expect(row.rows[0]).toEqual({ removed: true, cfi: null, excerpt: null });
  });

  it("caps a device clock running ahead at the server's", async () => {
    const [ahead] = (
      await marks.apply(reader, book, [
        {
          id: "late",
          changedAt: new Date(Date.now() + 60 * 60_000),
          mark: { ...highlight, progress: 0.8, color: "yellow" },
        },
      ])
    ).filter((mark) => mark.id === "late");
    expect(ahead.changedAt.getTime()).toBeLessThanOrEqual(Date.now() + 1_000);

    const [correct] = (
      await marks.apply(reader, book, [
        {
          id: "late",
          changedAt: new Date(Date.now() + 1_000),
          mark: { ...highlight, progress: 0.8, color: "purple" },
        },
      ])
    ).filter((mark) => mark.id === "late");
    expect(correct.color).toBe("purple");
  });

  it("keeps each reader's marks to themselves", async () => {
    expect(await marks.list(other, book)).toEqual([]);
  });

  it("applies a batch whole or not at all", async () => {
    await expect(
      marks.apply(other, book, [
        { id: "fine", changedAt: minutesAgo(1), mark: highlight },
        { id: "bad id", changedAt: minutesAgo(1), mark: highlight },
      ]),
    ).rejects.toThrow(/user_book_marks_id_format/);
    expect(await marks.list(other, book)).toEqual([]);
  });

  it("refuses an unknown colour and a removed row that keeps its text", async () => {
    await expect(
      pool.query(
        "INSERT INTO user_book_marks (user_id,item_id,mark_id,cfi,label,excerpt,created_at,color,changed_at) VALUES ($1,$2,'c','epubcfi(/1)','','',now(),'teal',now())",
        [other, book],
      ),
    ).rejects.toThrow(/user_book_marks_color/);
    await expect(
      pool.query(
        "INSERT INTO user_book_marks (user_id,item_id,mark_id,cfi,removed,changed_at) VALUES ($1,$2,'c','epubcfi(/1)',true,now())",
        [other, book],
      ),
    ).rejects.toThrow(/user_book_marks_content/);
  });

  it("goes with the book when the book is removed", async () => {
    await pool.query("DELETE FROM items WHERE id = $1", [book]);
    expect(await marks.list(reader, book)).toEqual([]);
  });
});
