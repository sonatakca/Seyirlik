// @vitest-environment node
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabasePool } from "../database/databasePool";
import { runMigrations } from "../database/migrationRunner";
import { createSubtitleAnalysisStore } from "./subtitleAnalysis";
import {
  TRANSCRIPT_SCHEMA_VERSION,
  type Transcript,
} from "./subtitleTranscript";

/*
 * The transcript cache both machines share: the laptop writes, the server
 * reads, and the key is the audio. Requires a disposable database.
 */
const databaseUrl = process.env.SEYIRLIK_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

const transcript = (text: string): Transcript => ({
  schemaVersion: TRANSCRIPT_SCHEMA_VERSION,
  language: "en",
  engine: { name: "whisper.cpp", model: "ggml-small.bin:1", options: {} },
  durationSeconds: 10,
  segments: [
    {
      startSeconds: 1.23456,
      endSeconds: 2,
      text,
      words: [
        { text, startSeconds: 1.23456, endSeconds: 2, probability: 0.98765 },
      ],
      flags: [],
    },
  ],
});

integration("subtitle audio analyses", () => {
  const pool = createDatabasePool({
    connectionString: databaseUrl as string,
    maxConnections: 4,
  });
  const store = createSubtitleAnalysisStore(pool);
  let mediaFileId = "";

  beforeAll(async () => {
    await pool.query("DROP SCHEMA public CASCADE");
    await pool.query("CREATE SCHEMA public");
    await runMigrations(pool);
    const libraryId = randomUUID();
    const itemId = randomUUID();
    mediaFileId = randomUUID();
    await pool.query(
      `INSERT INTO libraries (id, slug, name, kind) VALUES ($1, 'movies', 'Movies', 'movies')`,
      [libraryId],
    );
    await pool.query(
      `INSERT INTO items (id, library_id, kind, source_key, title, sort_title)
       VALUES ($1, $2, 'movie', 'Series/Arcane', 'Arcane', 'Arcane')`,
      [itemId, libraryId],
    );
    await pool.query(
      `INSERT INTO media_files (id, item_id, relative_path, size_bytes, mtime_ms, fingerprint)
       VALUES ($1, $2, 'Series/Arcane/E01.mkv', 1, 1, 'f')`,
      [mediaFileId, itemId],
    );
  }, 60_000);

  afterAll(async () => {
    await pool.end();
  });

  it("keeps one transcript per audio and engine, and a re-run replaces it", async () => {
    const key = "a".repeat(64);
    const save = (text: string) =>
      store.saveTranscript({
        mediaFileId,
        sourceStreamIndex: 1,
        audioKey: key,
        engine: "whisper.cpp:ggml-small.bin:1",
        transcript: transcript(text),
        elapsedMs: 1000,
      });
    await save("first");
    await save("second");
    const count = await pool.query(
      `SELECT count(*)::int AS n FROM subtitle_audio_analyses WHERE audio_key = $1`,
      [key],
    );
    expect(count.rows[0].n).toBe(1);
    const found = await store.findTranscript(key);
    expect(found?.transcript.segments[0]?.text).toBe("second");
    // Stored compactly: milliseconds and two-place probabilities.
    expect(found?.transcript.segments[0]?.words[0]).toMatchObject({
      startSeconds: 1.235,
      probability: 0.99,
    });
    expect(await store.hasTranscript(key, "whisper.cpp:ggml-small.bin:1")).toBe(
      true,
    );
    expect(await store.hasTranscript(key, "whisper.cpp:ggml-large.bin:2")).toBe(
      false,
    );
  });

  it("never answers for different audio", async () => {
    expect(await store.findTranscript("b".repeat(64))).toBeNull();
  });
});
