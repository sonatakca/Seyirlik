import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DatabasePool } from "../database/databasePool";
import type { ProcessableTitleRow } from "../catalogue/catalogueRepository";
import { createSegmentService } from "./segmentService";

const ffmpegAvailable =
  spawnSync("ffmpeg", ["-hide_banner", "-version"], { stdio: "ignore" })
    .status === 0;

/** Above the detector's own rate, so FFmpeg still has to resample it. */
const RATE = 11_025;

function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 4_294_967_296;
  };
}

/** Programme-like audio: partials that wander at irregular moments, over noise. */
function programme(seconds: number, seed: number): Float64Array {
  const next = random(seed);
  const samples = new Float64Array(Math.round(seconds * RATE));
  const partials = Array.from({ length: 5 }, () => ({
    frequency: 0,
    level: 0,
    phase: 0,
    until: 0,
  }));
  let noiseLevel = 0.1;
  let smoothed = 0;
  for (let index = 0; index < samples.length; index += 1) {
    let value = 0;
    for (const partial of partials) {
      if (index >= partial.until) {
        partial.frequency = 200 + next() * 1_800;
        partial.level = next();
        partial.until = index + Math.round((0.03 + next() * 0.3) * RATE);
      }
      partial.phase += (2 * Math.PI * partial.frequency) / RATE;
      value += partial.level * Math.sin(partial.phase);
    }
    if (index % 1_600 === 0) noiseLevel = next() * 0.4;
    smoothed = 0.7 * smoothed + 0.3 * (next() - 0.5);
    samples[index] = value / 5 + smoothed * noiseLevel;
  }
  return samples;
}

function wav(parts: Float64Array[]): Buffer {
  const length = parts.reduce((total, part) => total + part.length, 0);
  const buffer = Buffer.alloc(44 + length * 2);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + length * 2, 4);
  buffer.write("WAVEfmt ", 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(RATE, 24);
  buffer.writeUInt32LE(RATE * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(length * 2, 40);
  let offset = 44;
  for (const part of parts) {
    for (const value of part) {
      buffer.writeInt16LE(
        Math.max(-32_768, Math.min(32_767, Math.round(value * 0.6 * 32_767))),
        offset,
      );
      offset += 2;
    }
  }
  return buffer;
}

/** Runs every query a transaction makes against an in-memory log. */
function recordingPool(log: Array<{ sql: string; values: unknown[] }>) {
  const client = {
    query: async (sql: string, values: unknown[] = []) => {
      log.push({ sql, values });
      return { rows: [] };
    },
    release: () => undefined,
  };
  return {
    connect: async () => client,
    query: async (sql: string, values: unknown[] = []) => {
      log.push({ sql, values });
      return { rows: [] };
    },
  } as unknown as DatabasePool;
}

describe.skipIf(!ffmpegAvailable)(
  "segment detection through FFmpeg",
  { timeout: 120_000 },
  () => {
    let root: string;
    const theme = programme(45, 7);
    const credits = programme(30, 8);
    /** Intro start and episode length, per episode. */
    const layout = [
      { lead: 20, body: 150 },
      { lead: 65, body: 170 },
      { lead: 5, body: 140 },
    ];

    beforeAll(async () => {
      root = await mkdtemp(path.join(tmpdir(), "seyirlik-segments-"));
      for (const [index, episode] of layout.entries()) {
        await writeFile(
          path.join(root, `episode${index + 1}.wav`),
          wav([
            programme(episode.lead, 100 + index),
            theme,
            programme(episode.body, 200 + index),
            credits,
          ]),
        );
      }
    }, 120_000);
    afterAll(async () => {
      await rm(root, { recursive: true, force: true });
    });

    it("finds each episode's intro and runs its credits to the end", async () => {
      const titles = layout.map(
        (episode, index) =>
          ({
            itemId: `episode-${index + 1}`,
            kind: "episode",
            title: `Episode ${index + 1}`,
            sortTitle: `Episode ${index + 1}`,
            indexNumber: index + 1,
            seasonId: "season-1",
            mediaFileId: `file-${index + 1}`,
            relativePath: `episode${index + 1}.wav`,
            probeState: "probed",
            durationMs: String((episode.lead + 45 + episode.body + 30) * 1_000),
            runtimeMs: null,
            itemMissingSince: null,
            fileMissingSince: null,
          }) as unknown as ProcessableTitleRow,
      );
      const log: Array<{ sql: string; values: unknown[] }> = [];
      const service = createSegmentService({
        pool: recordingPool(log),
        mediaRoot: root,
        catalogue: {
          listProcessableTitles: async () => titles,
          listChapters: async () => [],
          listStreams: async () =>
            [{ kind: "audio", streamIndex: 0, isDefault: true }] as never,
          getFileById: async () => null,
        },
      });

      const result = await service.detectSeason("season-1");

      expect(result).toMatchObject({
        episodes: 3,
        unreadable: 0,
        intros: 3,
        credits: 3,
      });
      const inserted = log
        .filter((entry) => entry.sql.includes("INSERT INTO item_segments"))
        .map((entry) => ({
          itemId: entry.values[1],
          type: entry.values[2],
          startMs: entry.values[3] as number,
          endMs: entry.values[4] as number,
        }));
      for (const [index, episode] of layout.entries()) {
        const itemId = `episode-${index + 1}`;
        const intro = inserted.find(
          (segment) => segment.itemId === itemId && segment.type === "intro",
        )!;
        expect(intro.startMs / 1_000).toBeCloseTo(episode.lead, -0.3);
        expect(intro.endMs / 1_000).toBeCloseTo(episode.lead + 45, -0.3);
        const outro = inserted.find(
          (segment) => segment.itemId === itemId && segment.type === "outro",
        )!;
        const duration = episode.lead + 45 + episode.body + 30;
        expect(outro.startMs / 1_000).toBeCloseTo(duration - 30, -0.3);
        expect(outro.endMs / 1_000).toBe(duration);
      }
      expect(
        log.some((entry) =>
          entry.sql.includes("INSERT INTO segment_detection_runs"),
        ),
      ).toBe(true);
    });
  },
);

describe("listening to a title whose source is gone", () => {
  it("decodes the package's default audio through its playlist, not its M4A", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "seyirlik-segments-"));
    try {
      const decoded: Array<{ path: string; map: string }> = [];
      const service = createSegmentService({
        pool: recordingPool([]),
        mediaRoot: root,
        catalogue: {
          listProcessableTitles: async () => [
            {
              itemId: "episode-1",
              kind: "episode",
              title: "Episode 1",
              sortTitle: "Episode 1",
              indexNumber: 1,
              seasonId: "season-1",
              mediaFileId: "file-1",
              // Never written: packaging consumed the source.
              relativePath: "episode1.mkv",
              probeState: "probed",
              durationMs: "3600000",
              runtimeMs: null,
              itemMissingSince: null,
              fileMissingSince: null,
            } as unknown as ProcessableTitleRow,
          ],
          listChapters: async () => [],
          listStreams: async () => [],
          getFileById: async () =>
            ({ id: "file-1", sizeBytes: "1", mtimeMs: "1" }) as never,
        },
        findPackagedAudio: async () => ({
          path: path.join(root, "audio", "track-1.m4a"),
          playlistPath: path.join(root, ".seyirlik", "audio", "track-1.m3u8"),
          durationSeconds: 3_600,
        }),
        decodeWindow: async (input) => {
          decoded.push(input);
          return null;
        },
      });

      await service.detectSeason("season-1");

      // The playlist's byte ranges are the fragment index the MP4 demuxer
      // would otherwise rebuild with a seek per fragment, through Drive.
      expect(decoded.length).toBeGreaterThan(0);
      for (const input of decoded) {
        expect(input).toEqual({
          path: path.join(root, ".seyirlik", "audio", "track-1.m3u8"),
          map: "0:a:0",
        });
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
