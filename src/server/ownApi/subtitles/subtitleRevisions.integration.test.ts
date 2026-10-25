// @vitest-environment node
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDatabasePool } from "../database/databasePool";
import { runMigrations } from "../database/migrationRunner";
import {
  createSubtitleRevisionStore,
  RevisionBusyError,
  settlePendingRevision,
  writeSubtitleRevision,
} from "./subtitleRevisions";
import { createSubtitleStorage, subtitleDigest } from "./subtitleStorage";

/*
 * The write path every retiming goes through, against a real database and a
 * real library directory. The properties under test are the ones a double
 * would only restate: an original is in the database before its file is
 * touched, a crash at any point is settled by the file and nothing else, and
 * somebody else's edit is neither overwritten nor lost.
 *
 * Requires a disposable database. The schema is dropped.
 */
const databaseUrl = process.env.SEYIRLIK_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

const srt = (start: string, text = "Merhaba.") =>
  new TextEncoder().encode(
    ["1", `${start} --> 00:00:09,000`, text, "", ""].join("\n"),
  );

integration("subtitle revisions", () => {
  const pool = createDatabasePool({
    connectionString: databaseUrl as string,
    maxConnections: 4,
  });
  const store = createSubtitleRevisionStore(pool);
  let mediaFileId = "";
  let root = "";
  const mediaRelative = "Movies/Dune (2021)/Dune (2021).mkv";
  const sidecar = "Movies/Dune (2021)/Dune (2021).tr.srt";
  const onDisk = () =>
    readFile(path.join(root, ...sidecar.split("/"))).then(
      (bytes) => new Uint8Array(bytes),
    );
  const put = (bytes: Uint8Array) =>
    writeFile(path.join(root, ...sidecar.split("/")), bytes);
  let storage: ReturnType<typeof createSubtitleStorage>;

  beforeAll(async () => {
    await pool.query("DROP SCHEMA public CASCADE");
    await pool.query("CREATE SCHEMA public");
    await runMigrations(pool);
    const libraryId = randomUUID();
    const itemId = randomUUID();
    await pool.query(
      `INSERT INTO libraries (id, slug, name, kind) VALUES ($1, 'movies', 'Movies', 'movies')`,
      [libraryId],
    );
    await pool.query(
      `INSERT INTO items (id, library_id, kind, source_key, title, sort_title)
       VALUES ($1, $2, 'movie', 'Movies/Dune (2021)', 'Dune', 'Dune')`,
      [itemId, libraryId],
    );
    mediaFileId = randomUUID();
    await pool.query(
      `INSERT INTO media_files (id, item_id, relative_path, size_bytes, mtime_ms, fingerprint)
       VALUES ($1, $2, $3, 1, 1, 'f')`,
      [mediaFileId, itemId, mediaRelative],
    );
  }, 60_000);

  beforeEach(async () => {
    await pool.query("DELETE FROM subtitle_revisions");
    if (root) await rm(root, { recursive: true, force: true });
    root = await mkdtemp(path.join(tmpdir(), "seyirlik-revisions-"));
    await mkdir(path.join(root, "Movies", "Dune (2021)"), { recursive: true });
    await writeFile(path.join(root, ...mediaRelative.split("/")), "video");
    storage = createSubtitleStorage({
      libraryRoot: root,
      resolveMedia: async () => mediaRelative,
      managedDigest: async () => null,
    });
  });

  afterAll(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    await pool.end();
  });

  const write = (read: Uint8Array, next: Uint8Array) =>
    writeSubtitleRevision({
      store,
      storage,
      mediaFileId,
      relativePath: sidecar,
      read,
      next,
      origin: "sync",
      provenance: { test: true },
    });

  it("keeps the original in the database before the file is rewritten", async () => {
    const original = srt("00:00:01,000");
    const corrected = srt("00:00:02,000");
    await put(original);

    const result = await write(original, corrected);

    expect(result.outcome).toBe("committed");
    expect(await onDisk()).toEqual(corrected);
    const history = await store.list(mediaFileId, sidecar);
    expect(
      history.map((revision) => [
        revision.revision,
        revision.origin,
        revision.state,
      ]),
    ).toEqual([
      [2, "sync", "committed"],
      [1, "original", "committed"],
    ]);
    const first = await store.get(history[1]!.id);
    expect(first?.content).toEqual(original);
    expect(history[0]?.parentId).toBe(history[1]?.id);
  });

  it("records somebody else's edit as its own revision before writing over it", async () => {
    const original = srt("00:00:01,000");
    await put(original);
    await write(original, srt("00:00:02,000"));
    const edited = srt("00:00:02,000", "Elle düzeltildi.");
    await put(edited);

    const result = await write(edited, srt("00:00:03,000", "Elle düzeltildi."));

    expect(result.outcome).toBe("committed");
    expect(
      (await store.list(mediaFileId, sidecar)).map(
        (revision) => revision.origin,
      ),
    ).toEqual(["sync", "external", "sync", "original"]);
  });

  it("refuses to write over a file that changed after it was read, and keeps both", async () => {
    const original = srt("00:00:01,000");
    await put(original);
    const edited = srt("00:00:01,000", "Başkası değiştirdi.");
    await put(edited);

    const result = await write(original, srt("00:00:02,000"));

    expect(result.outcome).toBe("refused");
    expect(await onDisk()).toEqual(edited);
    const history = await store.list(mediaFileId, sidecar);
    expect(history[0]).toMatchObject({ origin: "sync", state: "abandoned" });
    // The next operation records what is really there before doing anything.
    await settlePendingRevision(store, storage, mediaFileId, sidecar);
    const again = await write(
      edited,
      srt("00:00:02,000", "Başkası değiştirdi."),
    );
    expect(again.outcome).toBe("committed");
    expect(
      (await store.list(mediaFileId, sidecar)).some(
        (revision) => revision.sha256 === subtitleDigest(edited),
      ),
    ).toBe(true);
  });

  it("settles a write that landed before a crash as committed", async () => {
    const original = srt("00:00:01,000");
    const corrected = srt("00:00:02,000");
    await put(original);
    const parent = await store.observe({
      mediaFileId,
      relativePath: sidecar,
      bytes: original,
    });
    await store.begin({
      mediaFileId,
      relativePath: sidecar,
      origin: "sync",
      bytes: corrected,
      parentId: parent.id,
    });
    await put(corrected); // the write landed; the process died before settling

    expect(
      await settlePendingRevision(store, storage, mediaFileId, sidecar),
    ).toBe("committed");
    expect((await store.head(mediaFileId, sidecar))?.sha256).toBe(
      subtitleDigest(corrected),
    );
  });

  it("settles a write that never landed as abandoned, and the file is untouched", async () => {
    const original = srt("00:00:01,000");
    await put(original);
    const parent = await store.observe({
      mediaFileId,
      relativePath: sidecar,
      bytes: original,
    });
    await store.begin({
      mediaFileId,
      relativePath: sidecar,
      origin: "sync",
      bytes: srt("00:00:02,000"),
      parentId: parent.id,
    });

    // The next write settles it first, then does its own.
    const result = await write(original, srt("00:00:05,000"));
    expect(result.outcome).toBe("committed");
    expect(
      (await store.list(mediaFileId, sidecar)).map(
        (revision) => revision.state,
      ),
    ).toEqual(["committed", "abandoned", "committed"]);
  });

  it("allows one pending write per path", async () => {
    const original = srt("00:00:01,000");
    await put(original);
    const parent = await store.observe({
      mediaFileId,
      relativePath: sidecar,
      bytes: original,
    });
    const begin = () =>
      store.begin({
        mediaFileId,
        relativePath: sidecar,
        origin: "sync",
        bytes: srt("00:00:02,000"),
        parentId: parent.id,
      });
    await begin();
    await expect(begin()).rejects.toBeInstanceOf(RevisionBusyError);
  });

  it("numbers concurrent observations without colliding", async () => {
    const original = srt("00:00:01,000");
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        store.observe({ mediaFileId, relativePath: sidecar, bytes: original }),
      ),
    );
    // One original, observed six times.
    expect(new Set(results.map((revision) => revision.id)).size).toBe(1);
  });

  it("restores an earlier revision as a new one", async () => {
    const original = srt("00:00:01,000");
    const corrected = srt("00:00:02,000");
    await put(original);
    await write(original, corrected);
    const first = (await store.list(mediaFileId, sidecar)).at(-1)!;
    const content = (await store.get(first.id))!.content;

    const restored = await writeSubtitleRevision({
      store,
      storage,
      mediaFileId,
      relativePath: sidecar,
      read: corrected,
      next: content,
      origin: "restore",
      provenance: { restoredFrom: first.id },
    });

    expect(restored.outcome).toBe("committed");
    expect(await onDisk()).toEqual(original);
    expect(
      (await store.list(mediaFileId, sidecar)).map(
        (revision) => revision.origin,
      ),
    ).toEqual(["restore", "sync", "original"]);
  });

  it("refuses bytes that are not a subtitle without touching anything", async () => {
    const original = srt("00:00:01,000");
    await put(original);
    const result = await write(
      original,
      new TextEncoder().encode("<html>no</html>"),
    );
    expect(result).toMatchObject({
      outcome: "refused",
      failure: "payload-invalid",
    });
    expect(await onDisk()).toEqual(original);
    expect(await store.list(mediaFileId, sidecar)).toEqual([]);
  });

  it("keeps the history when the catalogue forgets the file", async () => {
    const original = srt("00:00:01,000");
    await put(original);
    await write(original, srt("00:00:02,000"));
    const forgotten = randomUUID();
    // A second file row to delete, so the shared one survives for other tests.
    await pool.query(
      `INSERT INTO media_files (id, item_id, relative_path, size_bytes, mtime_ms, fingerprint)
       SELECT $1, item_id, 'Movies/Dune (2021)/Other.mkv', 1, 1, 'g' FROM media_files WHERE id = $2`,
      [forgotten, mediaFileId],
    );
    await store.record({
      mediaFileId: forgotten,
      relativePath: "Movies/Dune (2021)/Other.tr.srt",
      origin: "original",
      bytes: original,
    });
    await pool.query(`DELETE FROM media_files WHERE id = $1`, [forgotten]);
    const kept = await pool.query(
      `SELECT media_file_id, relative_path FROM subtitle_revisions WHERE relative_path = $1`,
      ["Movies/Dune (2021)/Other.tr.srt"],
    );
    expect(kept.rows).toEqual([
      { media_file_id: null, relative_path: "Movies/Dune (2021)/Other.tr.srt" },
    ]);
  });
});
