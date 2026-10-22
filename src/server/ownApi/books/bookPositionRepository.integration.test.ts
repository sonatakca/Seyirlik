// @vitest-environment node
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabasePool } from "../database/databasePool";
import { runMigrations } from "../database/migrationRunner";
import { createBookPositionRepository } from "./bookPositionRepository";

/* Requires a disposable database. The schema is dropped. */
const databaseUrl = process.env.SEYIRLIK_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

/**
 * The rule that decides which device's place wins is SQL (an upsert guarded
 * by read_at, capped at the server clock), so only a real database proves it.
 */
integration("book reading positions in PostgreSQL", () => {
  const pool = createDatabasePool({
    connectionString: databaseUrl as string,
    maxConnections: 4,
  });
  const positions = createBookPositionRepository(pool);
  const reader = randomUUID();
  const other = randomUUID();
  const book = randomUUID();
  const shared = randomUUID();
  const library = randomUUID();
  const minutesAgo = (minutes: number) =>
    new Date(Date.now() - minutes * 60_000);

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
      "INSERT INTO items (id, library_id, kind, source_key, title, sort_title) VALUES ($1,$2,'book','iliad','Iliad','Iliad'), ($3,$2,'book','odyssey','Odyssey','Odyssey')",
      [book, library, shared],
    );
  });

  afterAll(async () => {
    await pool.end();
  });

  it("has no position until one is saved, then returns it whole", async () => {
    expect(await positions.get(reader, book)).toBeNull();

    const saved = await positions.save(reader, book, {
      cfi: "epubcfi(/6/8!/4/2/1:0)",
      place: { section: 3, block: 0, offset: -184 },
      fraction: 0.02,
      readAt: minutesAgo(10),
    });

    expect(saved.accepted).toBe(true);
    expect(saved.position).toMatchObject({
      cfi: "epubcfi(/6/8!/4/2/1:0)",
      place: { section: 3, block: 0, offset: -184 },
      fraction: 0.02,
    });
  });

  it("takes a later place from another device and refuses an earlier one", async () => {
    const later = await positions.save(reader, book, {
      cfi: "epubcfi(/6/12!/4/40/1:15)",
      place: { section: 5, block: 39, offset: 120 },
      fraction: 0.2,
      readAt: minutesAgo(2),
    });
    expect(later.accepted).toBe(true);

    // A save from a tab left open since before, arriving late.
    const stale = await positions.save(reader, book, {
      cfi: "epubcfi(/6/8!/4/2/1:0)",
      place: { section: 3, block: 0, offset: -184 },
      fraction: 0.02,
      readAt: minutesAgo(5),
    });
    expect(stale.accepted).toBe(false);
    // The reply says where the book really is.
    expect(stale.position?.place).toEqual({
      section: 5,
      block: 39,
      offset: 120,
    });
  });

  it("caps a device clock running ahead at the server's", async () => {
    const ahead = await positions.save(reader, book, {
      cfi: "epubcfi(/6/14!/4/2/1:0)",
      place: null,
      fraction: 0.3,
      readAt: new Date(Date.now() + 60 * 60_000),
    });
    expect(ahead.accepted).toBe(true);
    expect(ahead.position?.readAt.getTime()).toBeLessThanOrEqual(
      Date.now() + 1_000,
    );

    // So a device with a correct clock can still move the book a minute later.
    const correct = await positions.save(reader, book, {
      cfi: "epubcfi(/6/16!/4/2/1:0)",
      place: { section: 8, block: 2, offset: 0 },
      fraction: 0.35,
      readAt: new Date(Date.now() + 1_000),
    });
    expect(correct.accepted).toBe(true);
    expect(correct.position?.fraction).toBe(0.35);
  });

  it("keeps each reader's place to themselves", async () => {
    expect(await positions.get(other, book)).toBeNull();
  });

  it("refuses a half-recorded place and a fraction out of range", async () => {
    await expect(
      pool.query(
        "INSERT INTO user_book_positions (user_id,item_id,section,fraction,read_at) VALUES ($1,$2,1,0.5,now())",
        [other, book],
      ),
    ).rejects.toThrow(/user_book_positions_place_whole/);
    await expect(
      pool.query(
        "INSERT INTO user_book_positions (user_id,item_id,fraction,read_at) VALUES ($1,$2,1.5,now())",
        [other, book],
      ),
    ).rejects.toThrow(/user_book_positions_fraction_range/);
  });

  describe("one copy keeps the place", () => {
    const desk = {
      sessionId: randomUUID(),
      openedAt: minutesAgo(30),
      device: "mac" as const,
    };
    const phone = {
      sessionId: randomUUID(),
      openedAt: minutesAgo(20),
      device: "iphone" as const,
    };
    const at = (fraction: number, readAt: Date) => ({
      cfi: null,
      place: null,
      fraction,
      readAt,
    });

    it("goes to the copy opened last, and an older one hears which", async () => {
      expect(await positions.claim(reader, shared, desk)).toMatchObject({
        owner: true,
      });
      expect(await positions.claim(reader, shared, phone)).toMatchObject({
        owner: true,
      });
      const older = await positions.claim(reader, shared, desk);
      expect(older.owner).toBe(false);
      expect(older.session).toEqual(phone);
      // The copy that has it may say so again.
      expect(await positions.claim(reader, shared, phone)).toMatchObject({
        owner: true,
      });
    });

    it("refuses a save from the older copy, whatever its clock says", async () => {
      const saved = await positions.save(
        reader,
        shared,
        at(0.4, minutesAgo(1)),
        phone,
      );
      expect(saved).toMatchObject({ accepted: true, superseded: null });

      const stale = await positions.save(
        reader,
        shared,
        at(0.1, new Date()),
        desk,
      );
      expect(stale.accepted).toBe(false);
      expect(stale.superseded).toEqual(phone);
      expect(stale.position?.fraction).toBe(0.4);
    });

    it("lets a copy opened offline, later, take the place when it comes back", async () => {
      const offline = {
        sessionId: randomUUID(),
        openedAt: minutesAgo(10),
        device: "ipad" as const,
      };
      // Never claimed on opening: its first save is its claim.
      const saved = await positions.save(
        reader,
        shared,
        at(0.6, minutesAgo(2)),
        offline,
      );
      // Read earlier by its clock than the phone's last save, still it wins:
      // it keeps the place now.
      expect(saved).toMatchObject({ accepted: true, superseded: null });
      expect(saved.position?.fraction).toBe(0.6);
      const phoneNow = await positions.save(
        reader,
        shared,
        at(0.45, new Date()),
        phone,
      );
      expect(phoneNow.accepted).toBe(false);
      expect(phoneNow.superseded?.sessionId).toBe(offline.sessionId);
    });

    it("orders a copy's own saves by its own clock", async () => {
      const copy = {
        sessionId: randomUUID(),
        openedAt: minutesAgo(5),
        device: null,
      };
      expect(
        (await positions.save(reader, shared, at(0.7, minutesAgo(1)), copy))
          .accepted,
      ).toBe(true);
      // Its own earlier save, arriving late, does not pull the book back.
      const late = await positions.save(
        reader,
        shared,
        at(0.65, minutesAgo(3)),
        copy,
      );
      expect(late.accepted).toBe(false);
      expect(late.superseded).toBeNull();
      expect(late.position?.fraction).toBe(0.7);
    });

    it("caps a copy's opening at the server's clock", async () => {
      const ahead = {
        sessionId: randomUUID(),
        openedAt: new Date(Date.now() + 60 * 60_000),
        device: "windows" as const,
      };
      const claim = await positions.claim(reader, shared, ahead);
      expect(claim.owner).toBe(true);
      expect(claim.session.openedAt.getTime()).toBeLessThanOrEqual(
        Date.now() + 1_000,
      );
      // So a copy opened a moment later, on a correct clock, can take it.
      const next = await positions.claim(reader, shared, {
        sessionId: randomUUID(),
        openedAt: new Date(Date.now() + 1_000),
        device: "linux",
      });
      expect(next.owner).toBe(true);
    });

    it("still takes a save from a page that names no copy, by its clock", async () => {
      const legacy = await positions.save(reader, shared, at(0.9, new Date()));
      expect(legacy).toMatchObject({ accepted: true, superseded: null });
    });

    it("refuses a device it does not know", async () => {
      await expect(
        pool.query(
          "INSERT INTO user_book_sessions (user_id,item_id,session_id,opened_at,device) VALUES ($1,$2,$3,now(),'toaster')",
          [other, shared, randomUUID()],
        ),
      ).rejects.toThrow(/user_book_sessions_device/);
    });

    it("goes with the book when the book is removed", async () => {
      await pool.query("DELETE FROM items WHERE id = $1", [shared]);
      const left = await pool.query(
        "SELECT count(*)::int AS n FROM user_book_sessions WHERE item_id = $1",
        [shared],
      );
      expect(left.rows[0].n).toBe(0);
    });
  });

  it("goes with the book when the book is removed", async () => {
    await pool.query("DELETE FROM items WHERE id = $1", [book]);
    expect(await positions.get(reader, book)).toBeNull();
  });
});
