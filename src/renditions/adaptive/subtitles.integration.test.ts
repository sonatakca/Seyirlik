/**
 * One read for every subtitle track, against one read per track.
 *
 * Extracting tracks together exists only to stop a slow source being read once
 * per track. It must not change a single byte of what any track produces.
 */

import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hasFfmpeg } from "./testFixtures";
import { extractWebVttFile, extractWebVttFiles } from "./subtitles";

const run = promisify(execFile);
let workspace = "";
let source: string | null = null;

function srt(cues: Array<[number, number, string]>): string {
  const clock = (seconds: number) => {
    const ms = Math.round(seconds * 1000);
    const pad = (value: number, width = 2) =>
      String(value).padStart(width, "0");
    return `${pad(Math.floor(ms / 3_600_000))}:${pad(Math.floor(ms / 60_000) % 60)}:${pad(Math.floor(ms / 1000) % 60)},${pad(ms % 1000, 3)}`;
  };
  return cues
    .map(
      ([from, to, text], index) =>
        `${index + 1}\n${clock(from)} --> ${clock(to)}\n${text}\n`,
    )
    .join("\n");
}

beforeAll(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), "seyirlik-webvtt-it-"));
  if (!(await hasFfmpeg())) return;
  const english = path.join(workspace, "en.srt");
  const turkish = path.join(workspace, "tr.srt");
  await writeFile(
    english,
    srt([
      [1, 2.5, "Remember, remember"],
      [9.2, 11, "the fifth of November"],
      [17, 19.5, "<i>gunpowder, treason and plot</i>"],
    ]),
  );
  await writeFile(
    turkish,
    srt([
      [1.1, 2.4, "Hatırla, hatırla"],
      [12, 14, "Kasımın beşini"],
    ]),
  );
  source = path.join(workspace, "two-tracks.mkv");
  await run("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=160x90:rate=25",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:sample_rate=48000",
    "-i",
    english,
    "-i",
    turkish,
    "-t",
    "20",
    "-map",
    "0:v",
    "-map",
    "1:a",
    "-map",
    "2:s",
    "-map",
    "3:s",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-c:a",
    "aac",
    "-c:s",
    "srt",
    source,
  ]);
}, 120_000);

afterAll(async () => {
  if (workspace) await rm(workspace, { recursive: true, force: true });
});

describe("extractWebVttFiles", () => {
  it("writes every track byte for byte as a read per track would", async () => {
    if (!source) {
      console.warn("FFmpeg is not available; skipping WebVTT extraction test.");
      return;
    }
    const fractions: number[] = [];
    const together = await extractWebVttFiles({
      ffmpegPath: "ffmpeg",
      inputPath: source,
      tracks: [
        { streamIndex: 2, outputPath: path.join(workspace, "both-2.vtt") },
        { streamIndex: 3, outputPath: path.join(workspace, "both-3.vtt") },
      ],
      sourceDurationSeconds: 20,
      onProgress: (fraction) => fractions.push(fraction),
    });
    for (const streamIndex of [2, 3]) {
      const alone = await extractWebVttFile({
        ffmpegPath: "ffmpeg",
        inputPath: source,
        streamIndex,
        outputPath: path.join(workspace, `alone-${streamIndex}.vtt`),
      });
      expect(together.get(streamIndex)?.contents).toBe(alone.contents);
      expect(
        await readFile(path.join(workspace, `both-${streamIndex}.vtt`), "utf8"),
      ).toBe(alone.contents);
    }
    expect(together.get(2)?.contents).toContain("the fifth of November");
    expect(together.get(3)?.contents).toContain("Kasımın beşini");
    // Never backwards, and done only once both files were checked.
    expect(fractions).toEqual([...fractions].sort((a, b) => a - b));
    expect(fractions.at(-1)).toBe(1);
  }, 120_000);

  it("fails as a whole when one track cannot be read, so the caller can fall back", async () => {
    if (!source) return;
    await expect(
      extractWebVttFiles({
        ffmpegPath: "ffmpeg",
        inputPath: source,
        tracks: [
          { streamIndex: 2, outputPath: path.join(workspace, "ok.vtt") },
          { streamIndex: 9, outputPath: path.join(workspace, "missing.vtt") },
        ],
      }),
    ).rejects.toThrow(/streams 2, 9/);
  }, 120_000);
});
