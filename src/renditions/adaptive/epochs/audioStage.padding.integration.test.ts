// @vitest-environment node
/**
 * A source whose sound stops before its picture.
 *
 * The 4K77 restoration of Star Wars carries 5.1 and stereo tracks that end at
 * 2:01:08 under a picture that runs to 2:01:40. Packaged as it was, the audio
 * stopped 32 s short of every video rendition and the whole ladder was thrown
 * away at validation. The audio stage now pads each encoded track with silence
 * to the end of the picture.
 */
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureAudioStage, padToPicture } from "./audioStage";
import { writeAuxiliaryStage } from "./checkpoints";
import { EPOCH_CHECKPOINT_SCHEMA_VERSION } from "./policy";
import { runFfmpeg } from "../../processor";
import { probePackagedAudio } from "../probePackaged";
import {
  ADAPTIVE_AUDIO_DIRECTORY,
  ADAPTIVE_MEDIA_FILE,
  audioRenditionId,
} from "../profile";
import type { AdaptiveAudioOutput } from "../encoding";

const run = promisify(execFile);
const MEDIA_ID = "33333333-3333-4333-8333-333333333333";
const FINGERPRINT = "a".repeat(64);
const PROFILE = "cmaf-hls-aligned-v3";
const PICTURE_SECONDS = 8;
const SOUND_SECONDS = 5;

const transcoded: AdaptiveAudioOutput = {
  sourceStreamIndex: 1,
  action: "transcode",
  bitrate: 128_000,
  channels: 2,
  isDefault: true,
  isForced: false,
};

describe("padding audio to the picture", () => {
  it("pads an encoded track to the picture's end with one apad", () => {
    const plan = padToPicture([transcoded], 7300.335);
    expect(plan?.filterComplex).toBe("[0:1]apad=whole_dur=7300.335000[apad0]");
    expect(plan?.outputs[0]?.mapLabel).toBe("[apad0]");
    expect(plan?.toSeconds).toBe(7300.335);
  });

  it("leaves a copied track alone, and plans nothing when every track is copied", () => {
    expect(
      padToPicture([{ ...transcoded, action: "copy" }], 7300.335),
    ).toBeNull();
  });
});

const ffmpegAvailable = await run("ffmpeg", ["-version"]).then(
  () => true,
  () => false,
);

describe.skipIf(!ffmpegAvailable)("a source whose sound ends early", () => {
  let workspace = "";
  let source = "";

  beforeAll(async () => {
    workspace = await mkdtemp(path.join(tmpdir(), "seyirlik-audio-pad-"));
    source = path.join(workspace, "source.mkv");
    await run("ffmpeg", [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      `testsrc=size=160x90:rate=24:duration=${PICTURE_SECONDS}`,
      "-f",
      "lavfi",
      "-i",
      `sine=frequency=440:sample_rate=48000:duration=${SOUND_SECONDS}`,
      "-c:v",
      "libx264",
      "-c:a",
      "eac3",
      source,
    ]);
  });

  afterAll(async () => {
    if (workspace) await rm(workspace, { recursive: true, force: true });
  });

  const stage = (stageDirectory: string) =>
    ensureAudioStage({
      stageDirectory,
      mediaId: MEDIA_ID,
      sourceFingerprint: FINGERPRINT,
      adaptiveProfileVersion: PROFILE,
      sourcePath: source,
      audioOutputs: [transcoded],
      sourceDurationSeconds: PICTURE_SECONDS,
      ffmpegPath: "ffmpeg",
      ffprobePath: "ffprobe",
      logPath: path.join(workspace, "audio.log"),
      runEncoder: runFfmpeg,
    });

  const covered = async (stageDirectory: string) =>
    (
      await probePackagedAudio(
        path.join(
          stageDirectory,
          ADAPTIVE_AUDIO_DIRECTORY,
          audioRenditionId(1),
          ADAPTIVE_MEDIA_FILE,
        ),
        "ffprobe",
      )
    ).durationSeconds;

  it("covers the whole picture, the rest in silence", async () => {
    const directory = path.join(workspace, "fresh");
    const result = await stage(directory);
    expect(result.reused).toBe(false);
    expect(result.manifest.paddedToSeconds).toBe(PICTURE_SECONDS);
    // Package validation allows half a second between audio and picture.
    expect(Math.abs((await covered(directory)) - PICTURE_SECONDS)).toBeLessThan(
      0.5,
    );
  });

  it("rebuilds a stage made before padding, rather than reuse its short tracks", async () => {
    const directory = path.join(workspace, "before-padding");
    const first = await stage(directory);
    const { paddedToSeconds: _dropped, ...unpadded } = first.manifest;
    await writeAuxiliaryStage(directory, {
      ...unpadded,
      schemaVersion: EPOCH_CHECKPOINT_SCHEMA_VERSION,
    });
    const again = await stage(directory);
    expect(again.reused).toBe(false);
    expect(again.manifest.paddedToSeconds).toBe(PICTURE_SECONDS);
    expect((await stage(directory)).reused).toBe(true);
  });
});
