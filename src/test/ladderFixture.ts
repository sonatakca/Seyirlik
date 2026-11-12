/**
 * A package whose ladder is priced like a real one, for testing which rung a
 * player opens on and how fast it corrects.
 *
 * The epoch fixture cannot do this: its rungs are encoded from a tiny test
 * pattern and all cost about 250 kbps, so every bandwidth picks the same rung
 * and every fragment is too small to be a throughput measurement. Encoding a
 * true seven-rung ladder would take minutes, and the decision under test does
 * not need it — the policy chooses by the bitrates the master declares, and
 * what the player measures is the link, not the picture.
 *
 * So one real stream is encoded (noisy 720p at ~2.4 Mbps, two-second
 * fragments of roughly 600 kB, i.e. sized like a real mid-ladder rung), and
 * the master declares Seyirlik's real ladder over it. Each rung gets its own
 * copy of the media playlist, so the request log says which rung the player
 * asked for.
 *
 * Built rather than committed, and cached between runs.
 */

import { execFile } from "node:child_process";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { LADDER_FIXTURE_RUNGS } from "./ladderFixtureRungs";

export { LADDER_FIXTURE_RUNGS };

const run = promisify(execFile);

const VERSION = "v1";

export function ladderFixtureDirectory(): string {
  return path.join(tmpdir(), `seyirlik-ladder-fixture-${VERSION}`);
}

async function exists(candidate: string): Promise<boolean> {
  try {
    await access(candidate);
    return true;
  } catch {
    return false;
  }
}

/** Builds the fixture if needed; null when FFmpeg is unavailable. */
export async function ensureLadderFixture(): Promise<string | null> {
  const root = ladderFixtureDirectory();
  if (await exists(path.join(root, "master.m3u8"))) return root;
  try {
    await run("ffmpeg", ["-version"]);
  } catch {
    return null;
  }

  await rm(root, { recursive: true, force: true });
  await mkdir(path.join(root, "media"), { recursive: true });
  await run(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      // Noise defeats the encoder, so the bitrate is spent as a film's would be.
      "testsrc2=size=1280x720:rate=24,noise=alls=40:allf=t+u",
      "-t",
      "20",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-profile:v",
      "high",
      "-level",
      "3.1",
      "-pix_fmt",
      "yuv420p",
      "-b:v",
      "2400k",
      "-maxrate",
      "2400k",
      "-bufsize",
      "4800k",
      "-g",
      "48",
      "-keyint_min",
      "48",
      "-sc_threshold",
      "0",
      "-an",
      "-f",
      "hls",
      "-hls_time",
      "2",
      "-hls_playlist_type",
      "vod",
      "-hls_segment_type",
      "fmp4",
      "-hls_fmp4_init_filename",
      "init.mp4",
      "-hls_segment_filename",
      path.join(root, "media", "seg_%03d.m4s"),
      path.join(root, "media", "stream.m3u8"),
    ],
    { timeout: 300_000 },
  );

  const media = await readFile(path.join(root, "media", "stream.m3u8"), "utf8");
  const lines = [
    "#EXTM3U",
    "#EXT-X-VERSION:7",
    "#EXT-X-INDEPENDENT-SEGMENTS",
    "",
  ];
  for (const rung of LADDER_FIXTURE_RUNGS) {
    const playlist = `media/${rung.height}p.m3u8`;
    await writeFile(path.join(root, playlist), media);
    lines.push(
      `#EXT-X-STREAM-INF:BANDWIDTH=${rung.averageBps * 2},AVERAGE-BANDWIDTH=${rung.averageBps},RESOLUTION=${rung.width}x${rung.height},FRAME-RATE=24.000,CODECS="avc1.64001f",VIDEO-RANGE=SDR`,
      playlist,
      "",
    );
  }
  await writeFile(path.join(root, "master.m3u8"), `${lines.join("\n")}\n`);
  return root;
}
