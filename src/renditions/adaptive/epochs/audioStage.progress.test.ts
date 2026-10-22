/**
 * What the audio stage says about itself while it runs.
 *
 * The stage was silent for the minutes it spent encoding, and the fix has one
 * rule worth testing directly: every figure comes from FFmpeg's own report of
 * the media it has written, never from a clock. These tests drive a fake
 * encoder that emits the progress fields FFmpeg emits, so the arithmetic is
 * exercised without an encoder being present.
 */

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureAudioStage } from "./audioStage";
import type { AudioPhaseProgress } from "../phaseProgress";
import { EPOCH_CHECKPOINT_SCHEMA_VERSION } from "./policy";
import { writeAuxiliaryStage } from "./checkpoints";
import type { AdaptiveAudioOutput } from "../encoding";

let workspace = "";

beforeEach(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), "seyirlik-audio-progress-"));
});

afterEach(async () => {
  if (workspace) await rm(workspace, { recursive: true, force: true });
});

const MEDIA_ID = "11111111-1111-4111-8111-111111111111";
const FINGERPRINT = "f".repeat(64);
const PROFILE = "cmaf-hls-aligned-v2";
const DURATION = 6_000;

/** The encoder args require exactly one default track, as a real plan has. */
function audioOutput(
  streamIndex: number,
  isDefault = false,
): AdaptiveAudioOutput {
  return {
    sourceStreamIndex: streamIndex,
    isDefault,
    isForced: false,
    action: "encode",
  } as unknown as AdaptiveAudioOutput;
}

/**
 * Runs the stage with a fake encoder that reports the given media positions.
 *
 * The encoder then fails, because completing the stage would mean probing real
 * AAC. Everything asserted here is emitted before that point, which is exactly
 * the window the page is watching.
 */
async function collect(
  streamIndexes: number[],
  positions: Array<{ seconds: number; speed?: number }>,
  trackDetails?: Map<
    number,
    { language?: string; title?: string; channels?: number }
  >,
): Promise<AudioPhaseProgress[]> {
  const samples: AudioPhaseProgress[] = [];
  await ensureAudioStage({
    stageDirectory: path.join(workspace, "audio-stage"),
    mediaId: MEDIA_ID,
    sourceFingerprint: FINGERPRINT,
    adaptiveProfileVersion: PROFILE,
    sourcePath: path.join(workspace, "source.mkv"),
    audioOutputs: streamIndexes.map((streamIndex, index) =>
      audioOutput(streamIndex, index === 0),
    ),
    sourceDurationSeconds: DURATION,
    ffmpegPath: "ffmpeg",
    ffprobePath: "ffprobe",
    logPath: path.join(workspace, "log.txt"),
    ...(trackDetails ? { trackDetails } : {}),
    // Time is supplied so the throttle is deterministic: every sample below is
    // a second apart in the stage's own clock, whatever the machine does.
    now: (() => {
      let tick = 0;
      return () => {
        tick += 1_000;
        return tick;
      };
    })(),
    runEncoder: async (_command, _args, options) => {
      for (const position of positions) {
        options.onProgress?.({
          processedSeconds: position.seconds,
          ...(position.speed === undefined ? {} : { speed: position.speed }),
        });
      }
      throw new Error("fake encoder stopped after reporting");
    },
    onProgress: (progress) => samples.push(progress),
  }).catch(() => undefined);
  return samples;
}

describe("audio progress comes from the encoder, not from a clock", () => {
  it("reports the fraction of the source that has been written", async () => {
    const samples = await collect(
      [1],
      [
        { seconds: 0 },
        { seconds: DURATION * 0.25 },
        { seconds: DURATION * 0.5 },
        { seconds: DURATION },
      ],
    );

    expect(samples.map((sample) => sample.fraction)).toEqual([0, 0.25, 0.5, 1]);
    expect(samples[3]!.processedSeconds).toBe(DURATION);
    expect(samples[3]!.durationSeconds).toBe(DURATION);
  });

  /**
   * One FFmpeg pass writes every track, so the tracks are listed and the
   * timeline is shared. A "track 2 of 3" counter would be easier to read and
   * would describe a pipeline this is not.
   */
  it("lists every track against one shared timeline", async () => {
    const samples = await collect(
      [1, 2, 3],
      [{ seconds: DURATION * 0.4 }],
      new Map([
        [1, { language: "eng", channels: 6 }],
        [2, { language: "tur", channels: 2 }],
        [3, { title: "Commentary", channels: 2 }],
      ]),
    );

    const sample = samples[0]!;
    expect(sample.tracks.map((track) => track.id)).toEqual([
      "track-1",
      "track-2",
      "track-3",
    ]);
    expect(sample.tracks[0]!.language).toBe("eng");
    expect(sample.tracks[0]!.channels).toBe(6);
    expect(sample.tracks[2]!.title).toBe("Commentary");
    // One position, not three: the tracks advance together.
    expect(sample.fraction).toBeCloseTo(0.4, 5);
  });

  it("survives tracks the source declares nothing about", async () => {
    const samples = await collect([4], [{ seconds: 1 }]);
    const track = samples[0]!.tracks[0]!;
    expect(track.language).toBeUndefined();
    expect(track.channels).toBe(0);
    expect(track.codec).toBe("aac");
  });

  it("offers an estimate only once a throughput has been reported", async () => {
    const withoutSpeed = await collect([1], [{ seconds: 100 }]);
    expect(withoutSpeed[0]!.etaSeconds).toBeUndefined();
    expect(withoutSpeed[0]!.speed).toBeUndefined();

    /*
     * The estimator ignores the first samples of a run — they are dominated by
     * process start — so a real one takes a while to appear. Feeding enough
     * samples proves it appears at all, and that it is derived from the
     * remaining media rather than from elapsed time.
     */
    const positions = Array.from({ length: 30 }, (_, index) => ({
      seconds: index * 100,
      speed: 20,
    }));
    const withSpeed = await collect([1], positions);
    const last = withSpeed[withSpeed.length - 1]!;
    expect(last.speed).toBeCloseTo(20, 1);
    expect(last.etaSeconds).toBe(
      Math.round((DURATION - last.processedSeconds) / 20),
    );
  });

  it("never reports a fraction outside [0,1]", async () => {
    // FFmpeg can report a position past the end when a stream runs long.
    const samples = await collect([1], [{ seconds: DURATION * 2 }]);
    expect(samples[0]!.fraction).toBe(1);
  });

  it("reports a stage that was already encoded rather than staying silent", async () => {
    const stageDirectory = path.join(workspace, "audio-stage");
    await mkdir(path.join(stageDirectory, "audio", "track-1"), {
      recursive: true,
    });
    await writeFile(
      path.join(stageDirectory, "audio", "track-1", "media.m4s"),
      "bytes",
    );
    await writeFile(
      path.join(stageDirectory, "audio", "track-1", "playlist.m3u8"),
      "#EXTM3U",
    );
    await writeAuxiliaryStage(stageDirectory, {
      schemaVersion: EPOCH_CHECKPOINT_SCHEMA_VERSION,
      mediaId: MEDIA_ID,
      sourceFingerprint: FINGERPRINT,
      adaptiveProfileVersion: PROFILE,
      stage: "audio",
      streamIndexes: [1],
      totalBytes: 4_096,
      completedAt: new Date().toISOString(),
    });

    const samples: AudioPhaseProgress[] = [];
    const result = await ensureAudioStage({
      stageDirectory,
      mediaId: MEDIA_ID,
      sourceFingerprint: FINGERPRINT,
      adaptiveProfileVersion: PROFILE,
      sourcePath: path.join(workspace, "source.mkv"),
      audioOutputs: [audioOutput(1, true)],
      sourceDurationSeconds: DURATION,
      ffmpegPath: "ffmpeg",
      ffprobePath: "ffprobe",
      logPath: path.join(workspace, "log.txt"),
      runEncoder: async () => {
        throw new Error("the encoder must not run for a reused stage");
      },
      onProgress: (progress) => samples.push(progress),
    });

    expect(result.reused).toBe(true);
    expect(samples).toHaveLength(1);
    expect(samples[0]!.reused).toBe(true);
    expect(samples[0]!.fraction).toBe(1);
    expect(samples[0]!.writtenBytes).toBe(4_096);
  });

  /**
   * An abort leaves the last honest sample behind and nothing after it. The
   * stage must not report itself complete on the way out — a paused or
   * cancelled job that showed audio at 100% would be claiming work that was
   * thrown away.
   */
  it("stops reporting where the encoder stopped", async () => {
    const samples = await collect(
      [1],
      [{ seconds: DURATION * 0.3 }, { seconds: DURATION * 0.6 }],
    );
    expect(samples).toHaveLength(2);
    expect(samples[samples.length - 1]!.fraction).toBeCloseTo(0.6, 5);
    expect(samples.some((sample) => sample.fraction === 1)).toBe(false);
  });
});

/**
 * The Sopranos S06E01 failure: the source carries a second of sound after its
 * last frame, the ladder stops at that frame, and audio encoded to the
 * container's end failed the package's coverage check after a full encode.
 */
describe("audio ends where the video ends", () => {
  const VIDEO_END = DURATION - 0.986;

  async function run(endSeconds?: number) {
    let args: string[] = [];
    const samples: AudioPhaseProgress[] = [];
    await ensureAudioStage({
      stageDirectory: path.join(workspace, "audio-stage"),
      mediaId: MEDIA_ID,
      sourceFingerprint: FINGERPRINT,
      adaptiveProfileVersion: PROFILE,
      sourcePath: path.join(workspace, "source.mkv"),
      audioOutputs: [audioOutput(1, true)],
      sourceDurationSeconds: DURATION,
      ...(endSeconds === undefined ? {} : { endSeconds }),
      ffmpegPath: "ffmpeg",
      ffprobePath: "ffprobe",
      logPath: path.join(workspace, "log.txt"),
      now: (() => {
        let tick = 0;
        return () => (tick += 1_000);
      })(),
      runEncoder: async (_command, encoderArgs, options) => {
        args = encoderArgs;
        options.onProgress?.({ processedSeconds: VIDEO_END / 2 });
        throw new Error("fake encoder stopped after reporting");
      },
      onProgress: (progress) => samples.push(progress),
    }).catch(() => undefined);
    return { args, samples };
  }

  /** The output duration, as distinct from an input `-t` before `-i`. */
  function outputDuration(args: string[]): string | undefined {
    const afterInputs = args.slice(args.lastIndexOf("-i") + 2);
    const at = afterInputs.indexOf("-t");
    return at === -1 ? undefined : afterInputs[at + 1];
  }

  it("cuts the audio at the last frame", async () => {
    const { args, samples } = await run(VIDEO_END);
    expect(outputDuration(args)).toBe(VIDEO_END.toFixed(6));
    expect(samples[0]!.durationSeconds).toBe(VIDEO_END);
    expect(samples[0]!.fraction).toBeCloseTo(0.5, 5);
  });

  it("runs to the source's end when the video lasts as long", async () => {
    expect(outputDuration((await run()).args)).toBeUndefined();
    expect(outputDuration((await run(DURATION)).args)).toBeUndefined();
  });

  it("rebuilds a stage encoded to the container's end", async () => {
    const stageDirectory = path.join(workspace, "audio-stage");
    await mkdir(path.join(stageDirectory, "audio", "track-1"), {
      recursive: true,
    });
    await writeFile(
      path.join(stageDirectory, "audio", "track-1", "media.m4s"),
      "bytes",
    );
    await writeFile(
      path.join(stageDirectory, "audio", "track-1", "playlist.m3u8"),
      "#EXTM3U",
    );
    await writeAuxiliaryStage(stageDirectory, {
      schemaVersion: EPOCH_CHECKPOINT_SCHEMA_VERSION,
      mediaId: MEDIA_ID,
      sourceFingerprint: FINGERPRINT,
      adaptiveProfileVersion: PROFILE,
      stage: "audio",
      streamIndexes: [1],
      totalBytes: 4_096,
      completedAt: new Date().toISOString(),
    });

    const { args } = await run(VIDEO_END);
    expect(outputDuration(args)).toBe(VIDEO_END.toFixed(6));
  });
});
