import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { extractWebVttFile } from "./subtitles";

/**
 * A stand-in FFmpeg: prints the `-progress` blocks it is given, then writes a
 * WebVTT file to its last argument. Shell, so not on Windows.
 */
async function fakeFfmpeg(
  directory: string,
  outTimes: string[],
): Promise<string> {
  const script = path.join(directory, "ffmpeg");
  const blocks = outTimes
    .map((value) => `printf 'out_time_us=${value}\\nprogress=continue\\n'`)
    .join("\n");
  await writeFile(
    script,
    `#!/bin/sh
${blocks}
printf 'out_time_us=10000000\\nprogress=end\\n'
for last; do :; done
printf 'WEBVTT\\n\\n00:00:01.000 --> 00:00:02.000\\nHello\\n' > "$last"
`,
    "utf8",
  );
  await chmod(script, 0o755);
  return script;
}

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe.skipIf(process.platform === "win32")(
  "subtitle extraction progress",
  () => {
    it("reports the read as a fraction of the source that only moves forward", async () => {
      const directory = await mkdtemp(
        path.join(tmpdir(), "seyirlik-vtt-progress-"),
      );
      directories.push(directory);
      const ffmpegPath = await fakeFfmpeg(directory, [
        // FFmpeg's "no timestamp yet" sentinel, before the first cue.
        "-9223372036854775807",
        "N/A",
        "2500000",
        "6000000",
        // A late block that reads behind an earlier one must not pull it back.
        "5000000",
      ]);
      const fractions: number[] = [];
      const outputPath = path.join(directory, "out.vtt");

      const result = await extractWebVttFile({
        ffmpegPath,
        inputPath: "/source/movie.mkv",
        streamIndex: 3,
        outputPath,
        sourceDurationSeconds: 10,
        onProgress: (fraction) => fractions.push(fraction),
      });

      expect(fractions).toEqual([0.25, 0.6, 0.999, 1]);
      expect(result.contents).toContain("Hello");
      expect(await readFile(outputPath, "utf8")).toMatch(/^WEBVTT/);
    });

    it("stays silent without a duration to measure against", async () => {
      const directory = await mkdtemp(
        path.join(tmpdir(), "seyirlik-vtt-progress-"),
      );
      directories.push(directory);
      const ffmpegPath = await fakeFfmpeg(directory, ["4000000"]);
      const fractions: number[] = [];

      await extractWebVttFile({
        ffmpegPath,
        inputPath: "/source/movie.mkv",
        streamIndex: 3,
        outputPath: path.join(directory, "out.vtt"),
        onProgress: (fraction) => fractions.push(fraction),
      });

      // Only the finish, which is known without a duration.
      expect(fractions).toEqual([1]);
    });
  },
);
