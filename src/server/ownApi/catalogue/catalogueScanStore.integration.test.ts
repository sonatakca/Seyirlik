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
  async function subtitleItem() {
    const itemId = randomUUID(),
      fileId = randomUUID();
    await pool.query(
      "INSERT INTO items(id,library_id,kind,source_key,title,sort_title) VALUES ($1::uuid,$2,'episode',$1::text,'Episode','episode')",
      [itemId, libraryId],
    );
    await pool.query(
      "INSERT INTO media_files(id,item_id,relative_path,size_bytes,mtime_ms,fingerprint,is_primary) VALUES ($1::uuid,$2,$1::text,1,1,'test',true)",
      [fileId, itemId],
    );
    return { itemId, fileId };
  }
  const subtitle = (relativePath: string) => ({
    relativePath,
    codec: "subrip",
    isText: true,
    isDefault: false,
    isForced: false,
    language: "tur",
  });
  const tracks = async (fileId: string) =>
    (
      await pool.query<{
        stream_index: number;
        external_relative_path: string;
      }>(
        "SELECT stream_index,external_relative_path FROM media_streams WHERE media_file_id=$1 ORDER BY stream_index",
        [fileId],
      )
    ).rows;
  it("keeps a sidecar's index when a scan reorders the list or adds another", async () => {
    const { itemId, fileId } = await subtitleItem();
    await store.replaceExternalSubtitles(itemId, [
      subtitle("Film.tr.srt"),
      subtitle("Film.en.srt"),
    ]);
    const before = await tracks(fileId);
    await store.replaceExternalSubtitles(itemId, [
      subtitle("Film.fr.srt"),
      subtitle("Film.en.srt"),
      subtitle("Film.tr.srt"),
      subtitle("Film.tr.srt"),
    ]);
    const after = await tracks(fileId);
    for (const track of before)
      expect(
        after.find(
          (row) => row.external_relative_path === track.external_relative_path,
        )?.stream_index,
      ).toBe(track.stream_index);
    expect(after).toHaveLength(3);
    await store.replaceExternalSubtitles(itemId, [subtitle("Film.tr.srt")]);
    expect(await tracks(fileId)).toEqual([before[0]]);
  });
  it("serializes concurrent uploads so no track loses its index", async () => {
    const { fileId } = await subtitleItem();
    await Promise.all(
      ["Film.tr.srt", "Film.en.srt", "Film.fr.srt"].map((relativePath) =>
        store.attachExternalSubtitle({
          mediaFileId: fileId,
          relativePath,
          codec: "subrip",
          isText: true,
          language: "tur",
          isForced: false,
        }),
      ),
    );
    expect(await tracks(fileId)).toHaveLength(3);
  });
});
