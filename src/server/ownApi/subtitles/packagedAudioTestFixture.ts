import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { mediaUriFromPlaylist } from "../../../renditions/adaptive/titleLayout";

export const ffmpegAvailable =
  spawnSync("ffmpeg", ["-hide_banner", "-version"], { stdio: "ignore" })
    .status === 0;

const RATE = 16_000;

/** Every `start --> end` an SRT or WebVTT document holds, in seconds. */
function cueTimes(subtitle: string): Array<[number, number]> {
  const seconds = (stamp: string) => {
    const [hours, minutes, rest] = stamp.split(":");
    return (
      Number(hours) * 3_600 +
      Number(minutes) * 60 +
      Number((rest as string).replace(",", "."))
    );
  };
  return [
    ...subtitle.matchAll(
      /(\d{2}:\d{2}:\d{2}[,.]\d{3}) --> (\d{2}:\d{2}:\d{2}[,.]\d{3})/g,
    ),
  ].map((match) => [seconds(match[1] as string), seconds(match[2] as string)]);
}

/** A tone in the speech band wherever a cue is on screen, silence elsewhere. */
function dialogueWav(subtitle: string): Buffer {
  const cues = cueTimes(subtitle);
  const end = (cues.at(-1)?.[1] ?? 0) + 10;
  const length = Math.round(end * RATE);
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
  let cue = 0;
  for (let index = 0; index < length; index += 1) {
    const at = index / RATE;
    while (cue < cues.length && at >= (cues[cue] as [number, number])[1]) {
      cue += 1;
    }
    const speaking =
      cue < cues.length && at >= (cues[cue] as [number, number])[0];
    const level = speaking ? 0.5 * Math.sin(2 * Math.PI * 900 * at) : 0;
    buffer.writeInt16LE(Math.round(level * 32_767), 44 + index * 2);
  }
  return buffer;
}

/**
 * A package's audio rendition whose speech follows `subtitle`'s cues.
 *
 * Named and pointed at exactly the way the packager does it: the file is
 * `audio/english (original).m4a`, a single fragmented MP4, and its playlist in
 * `.seyirlik/audio/` reaches it as `english%20(original).m4a`.
 */
export async function writeSpacedAudioPackage(subtitle: string): Promise<{
  root: string;
  playlistPath: string;
  mediaPath: string;
}> {
  const stem = "english (original)";
  const root = await mkdtemp(path.join(tmpdir(), "seyirlik-audio-package-"));
  await mkdir(path.join(root, "audio"), { recursive: true });
  await mkdir(path.join(root, ".seyirlik", "audio"), { recursive: true });
  const wav = path.join(root, "dialogue.wav");
  await writeFile(wav, dialogueWav(subtitle));
  const encoded = spawnSync(
    "ffmpeg",
    [
      "-hide_banner",
      "-v",
      "error",
      "-i",
      wav,
      "-c:a",
      "aac",
      "-f",
      "hls",
      "-hls_segment_type",
      "fmp4",
      "-hls_flags",
      "single_file",
      "-hls_time",
      "6",
      "-hls_playlist_type",
      "vod",
      path.join(root, `${stem}.m3u8`),
    ],
    { stdio: "ignore" },
  );
  if (encoded.status !== 0) throw new Error("FFmpeg could not encode.");
  const mediaPath = path.join(root, "audio", `${stem}.m4a`);
  await rename(path.join(root, `${stem}.m4s`), mediaPath);
  const playlist = (await readFile(path.join(root, `${stem}.m3u8`), "utf8"))
    .split(`${stem}.m4s`)
    .join(mediaUriFromPlaylist(`audio/${stem}.m4a`));
  const playlistPath = path.join(root, ".seyirlik", "audio", `${stem}.m3u8`);
  await writeFile(playlistPath, playlist);
  return { root, playlistPath, mediaPath };
}
