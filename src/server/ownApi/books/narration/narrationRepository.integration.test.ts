// @vitest-environment node
import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDatabasePool } from "../../database/databasePool";
import { runMigrations } from "../../database/migrationRunner";
import { createNarrationRepository } from "./narrationRepository";

/* Requires a disposable database. The schema is dropped. */
const databaseUrl = process.env.SEYIRLIK_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const progress = {
  fraction: 0.5,
  sectionsDone: 1,
  sectionsTotal: 3,
  etaSeconds: 600,
  activity: "reading",
};
const section = (number: number, audio = `audio-${number}`) => ({
  section: number,
  audioSha256: sha(audio),
  audioBytes: 1000,
  durationSeconds: 60,
  wordCount: 120,
});

/**
 * Who reads which book, and what a narrator that lost a book may still
 * write, are SQL (row locks, SKIP LOCKED, guarded updates), so only a real
 * database proves them.
 */
integration("book narrations in PostgreSQL", () => {
  const pool = createDatabasePool({
    connectionString: databaseUrl as string,
    maxConnections: 6,
  });
  const narrations = createNarrationRepository(pool);
  const admin = randomUUID();
  const library = randomUUID();
  const book = randomUUID();
  const other = randomUUID();
  const mac = randomUUID();
  const spare = randomUUID();
  const book1 = { fileId: randomUUID(), fingerprint: "edition-1" };
  const bookOf = async () => book1;
  const claim = (keyId: string, voice = "mk", extra = {}) =>
    narrations.claim({
      keyId,
      voice,
      scriptVersion: 1,
      staleSeconds: 900,
      bookOf,
      ...extra,
    });

  beforeAll(async () => {
    await pool.query("DROP SCHEMA public CASCADE");
    await pool.query("CREATE SCHEMA public");
    await runMigrations(pool);
    await pool.query(
      "INSERT INTO native_users (id,normalized_username,display_name,password_hash) VALUES ($1,'admin','admin','$argon2id$test')",
      [admin],
    );
    await pool.query(
      "INSERT INTO libraries (id,slug,name,kind) VALUES ($1,'books','Books','books')",
      [library],
    );
    await pool.query(
      "INSERT INTO items (id, library_id, kind, source_key, title, sort_title) VALUES ($1,$2,'book','kurk','Kürk','Kürk'), ($3,$2,'book','iliad','Iliad','Iliad')",
      [book, library, other],
    );
    await narrations.createKey(
      mac,
      "MacBook Pro",
      createHash("sha256").update("mac").digest(),
    );
    await narrations.createKey(
      spare,
      "Spare",
      createHash("sha256").update("spare").digest(),
    );
  });

  beforeEach(async () => {
    await pool.query("DELETE FROM book_narrations");
    await pool.query("DELETE FROM narration_pronunciations");
  });

  afterAll(async () => {
    await pool.end();
  });

  it("queues a request once, and a narrator takes it with its voice", async () => {
    expect(await narrations.get(book)).toBeNull();
    expect(await narrations.request(book, admin)).toBe(true);
    expect(await narrations.request(book, admin)).toBe(false);

    const taken = await claim(mac);
    expect(taken?.narration).toMatchObject({
      itemId: book,
      state: "narrating",
      voice: "mk",
      scriptVersion: 1,
      narratorKeyId: mac,
      bookFingerprint: "edition-1",
    });
    expect(taken?.reset).toBe(false);
    // Another narrator finds nothing: the book is being read.
    expect(await claim(spare)).toBeNull();
    // The narrator that holds it gets it back after a restart.
    expect((await claim(mac))?.narration.itemId).toBe(book);
  });

  it("lets only the narrator that holds a book report and upload", async () => {
    await narrations.request(book, admin);
    await claim(mac);

    expect(await narrations.heartbeat(book, spare, progress)).toBe(false);
    expect(await narrations.heartbeat(book, mac, progress)).toBe(true);
    expect((await narrations.get(book))?.narration.progress).toEqual(progress);

    expect(await narrations.commitSection(book, spare, section(1))).toBeNull();
    expect(await narrations.commitSection(book, mac, section(1))).toEqual({
      replaced: null,
    });
    // The same audio again replaces nothing; new audio names the old one.
    expect(await narrations.commitSection(book, mac, section(1))).toEqual({
      replaced: null,
    });
    expect(
      await narrations.commitSection(book, mac, section(1, "retake")),
    ).toEqual({ replaced: sha("audio-1") });
    expect((await narrations.get(book))?.sections).toMatchObject([
      { section: 1, audioSha256: sha("retake"), wordCount: 120 },
    ]);
  });

  it("hands a silent narrator's book to another, and the first can then write nothing", async () => {
    await narrations.request(book, admin);
    await claim(mac);
    await narrations.commitSection(book, mac, section(0));
    await pool.query(
      "UPDATE book_narrations SET heartbeat_at = now() - interval '1 hour'",
    );

    const taken = await claim(spare);
    expect(taken?.narration.narratorKeyId).toBe(spare);
    // Same voice, script and edition: what was uploaded is still good.
    expect(taken?.reset).toBe(false);
    expect(taken?.sections.map((row) => row.section)).toEqual([0]);

    expect(await narrations.heartbeat(book, mac, progress)).toBe(false);
    expect(await narrations.commitSection(book, mac, section(1))).toBeNull();
    expect(
      await narrations.finish(book, mac, { ready: false, error: "x" }),
    ).toBe(false);
  });

  it("drops sections read in another voice or from another edition", async () => {
    await narrations.request(book, admin);
    await claim(mac);
    await narrations.commitSection(book, mac, section(0));

    const voice = await claim(mac, "deep");
    expect(voice?.reset).toBe(true);
    expect(voice?.sections).toEqual([]);

    await narrations.commitSection(book, mac, section(0));
    const edition = await claim(mac, "deep", {
      bookOf: async () => ({ fileId: book1.fileId, fingerprint: "edition-2" }),
    });
    expect(edition?.reset).toBe(true);
    expect((await narrations.get(book))?.sections).toEqual([]);
  });

  it("is ready only with every section, and a failed one can be asked for again", async () => {
    await narrations.request(book, admin);
    await claim(mac);
    await narrations.commitSection(book, mac, section(0));

    expect(
      await narrations.finish(book, mac, { ready: true, sections: [0, 1] }),
    ).toBe(false);
    expect(
      await narrations.finish(book, mac, {
        ready: false,
        error: "The voice is missing.",
      }),
    ).toBe(true);
    expect((await narrations.get(book))?.narration).toMatchObject({
      state: "failed",
      error: "The voice is missing.",
    });

    // Asked for again: queued, with what it had uploaded.
    expect(await narrations.request(book, admin)).toBe(true);
    const again = await claim(mac);
    expect(again?.sections.map((row) => row.section)).toEqual([0]);
    await narrations.commitSection(book, mac, section(1));
    expect(
      await narrations.finish(book, mac, { ready: true, sections: [0, 1] }),
    ).toBe(true);
    expect((await narrations.get(book))?.narration.state).toBe("ready");
    expect(await narrations.request(book, admin)).toBe(false);
    // A finished book is no narrator's to write to.
    expect(await narrations.commitSection(book, mac, section(2))).toBeNull();
  });

  it("fails a book with no file and goes on to the next", async () => {
    await narrations.request(book, admin);
    await narrations.request(other, admin);
    const taken = await claim(mac, "mk", {
      bookOf: async (itemId: string) => (itemId === book ? null : book1),
    });

    expect(taken?.narration.itemId).toBe(other);
    expect((await narrations.get(book))?.narration).toMatchObject({
      state: "failed",
      error: "The book has no file to read.",
    });
  });

  it("never gives one book to two narrators asking at once", async () => {
    await narrations.request(book, admin);
    const [first, second] = await Promise.all([claim(mac), claim(spare)]);

    expect([first, second].filter(Boolean)).toHaveLength(1);
  });

  it("takes a removed narration's sections with it", async () => {
    await narrations.request(book, admin);
    await claim(mac);
    await narrations.commitSection(book, mac, section(0));

    expect(await narrations.remove(book)).toBe(true);
    expect(await narrations.get(book)).toBeNull();
    const left = await pool.query("SELECT 1 FROM book_narration_sections");
    expect(left.rowCount).toBe(0);
    expect(await narrations.commitSection(book, mac, section(1))).toBeNull();
  });

  it("gives a book back to read what changed, keeping its sections", async () => {
    await narrations.request(book, admin);
    await claim(mac);
    await narrations.commitSection(book, mac, section(0));

    // Asked for while it is read: it is read again once this reading ends.
    expect(await narrations.readAgain(book)).toBe(true);
    expect((await narrations.get(book))?.narration.state).toBe("narrating");
    expect(
      await narrations.finish(book, mac, { ready: true, sections: [0] }),
    ).toBe(true);
    expect((await narrations.get(book))?.narration.state).toBe("queued");

    const again = await claim(mac);
    expect(again?.reset).toBe(false);
    expect(again?.sections.map((row) => row.section)).toEqual([0]);
    await narrations.finish(book, mac, { ready: true, sections: [0] });
    expect((await narrations.get(book))?.narration.state).toBe("ready");

    // Read through: queued again at once. Queued or failed: nothing to give back.
    expect(await narrations.readAgain(book)).toBe(true);
    expect((await narrations.get(book))?.narration).toMatchObject({
      state: "queued",
      finishedAt: null,
    });
    expect(await narrations.readAgain(book)).toBe(false);
    expect(await narrations.readAgain(other)).toBe(false);
  });

  it("knows which upload's lines were sent, and forgets on a new upload", async () => {
    await narrations.request(book, admin);
    await claim(mac);
    await narrations.commitSection(book, mac, section(0));
    expect(await narrations.markChecked(book, spare, 0, sha("audio-0"))).toBe(
      false,
    );
    expect(await narrations.markChecked(book, mac, 0, sha("other"))).toBe(
      false,
    );
    expect(await narrations.markChecked(book, mac, 0, sha("audio-0"))).toBe(
      true,
    );
    expect((await narrations.get(book))?.sections[0]?.checked).toBe(true);

    // The same audio sent again keeps its lines; another does not.
    await narrations.commitSection(book, mac, section(0));
    expect((await narrations.get(book))?.sections[0]?.checked).toBe(true);
    await narrations.commitSection(book, mac, section(0, "retake"));
    expect((await narrations.get(book))?.sections[0]?.checked).toBe(false);
  });

  it("counts the times a line is asked for, and lists the narrated books", async () => {
    await narrations.request(book, admin);
    await claim(mac);
    await narrations.commitSection(book, mac, section(0));
    expect(await narrations.addRetake(book, "0-12-1", admin)).toBe(1);
    expect(await narrations.addRetake(book, "0-12-1", admin)).toBe(2);
    expect(await narrations.addRetake(book, "0-3-0", admin)).toBe(1);
    expect(await narrations.retakes(book)).toEqual([
      { chunk: "0-12-1", count: 2 },
      { chunk: "0-3-0", count: 1 },
    ]);
    await expect(narrations.addRetake(book, "0-12", admin)).rejects.toThrow();

    expect(await narrations.list()).toMatchObject([
      {
        itemId: book,
        title: "Kürk",
        state: "narrating",
        sections: 1,
        duration: 60,
      },
    ]);
    // A removed narration takes its requests with it.
    await narrations.remove(book);
    expect(await narrations.retakes(book)).toEqual([]);
  });

  it("keeps one pronunciation a word, written as its lookup key", async () => {
    await narrations.setPronunciation("sergievi", "sergi evi", admin);
    await narrations.setPronunciation("sergievi", "sergi-evi", admin);
    expect(await narrations.pronunciations()).toMatchObject([
      { word: "sergievi", spoken: "sergi-evi" },
    ]);
    await expect(
      narrations.setPronunciation("Sergievi", "x", admin),
    ).rejects.toThrow();
    await expect(
      narrations.setPronunciation("iki kelime", "x", admin),
    ).rejects.toThrow();
    expect(await narrations.removePronunciation("sergievi")).toBe(true);
    expect(await narrations.removePronunciation("sergievi")).toBe(false);
  });

  it("finds a key by its hash until it is revoked, and knows when a narrator was last there", async () => {
    const hash = createHash("sha256").update("mac").digest();
    expect((await narrations.findKey(hash))?.id).toBe(mac);

    await narrations.touchKey(mac);
    const seen = await narrations.lastSeen();
    expect(seen).toBeInstanceOf(Date);

    const temporary = randomUUID();
    const temporaryHash = createHash("sha256").update("temporary").digest();
    await narrations.createKey(temporary, "Temporary", temporaryHash);
    expect(await narrations.revokeKey(temporary)).toBe(true);
    expect(await narrations.revokeKey(temporary)).toBe(false);
    expect(await narrations.findKey(temporaryHash)).toBeNull();
  });
});
