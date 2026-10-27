/**
 * A source with a hole in it, packaged end to end.
 *
 * This is the reproduction of a real failure, reduced to a fixture. A Seagate
 * Expansion volume holding a 02:30 title developed an unreadable physical
 * region; the epoch covering 00:50:00–00:55:00 produced 123.290s of its 299.966s
 * and FFmpeg reported `Read error at pos. 10074169063` followed by
 * `Error during demuxing: Input/output error`. Raw reads against the device
 * confirmed the bytes are gone: a megabyte either side reads in hundredths of a
 * second, the region itself returns EIO after thirty-five.
 *
 * The behaviour under test is what the pipeline does about that. Nothing here
 * relaxes a tolerance, and the epoch that could not be read is never accepted
 * at its short length — it is replaced, at exactly the length the plan gave it,
 * so the film's own timeline survives and 00:55:00 is still at 00:55:00.
 *
 * Everything is real except the disk: a real FFmpeg, real fragments, real
 * validation, and a runner that fails exactly the reads the platter failed.
 */

import { execFile } from "node:child_process";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RenditionPaths } from "../../analysis";
import { computeSourceFingerprint } from "../../registry";
import { runFfmpeg } from "../../processor";
import { packageAdaptiveRendition } from "../packager";
import { validateAdaptivePackage } from "../validation";
import { ADAPTIVE_PROFILE_VERSION } from "../profile";
import { readTitlePackageManifest } from "../publishTitle";
import { parseMediaPlaylist } from "../playlist";
import {
  ensureAdaptiveEpochFixture,
  getAdaptiveFixtureDirectory,
} from "../testFixtures";
import { checkpointRoot, epochsRoot } from "./checkpoints";
import type { EpochCheckpointManifest } from "./checkpoints";
import { readEpochPlanFile } from "./checkpoints";
import { EPOCH_MANIFEST_FILE, epochDirectoryName } from "./policy";
import { stallThresholds } from "./stallPolicy";

import { rejectPublicationCommit } from "../../../test/publicationFault";

const run = promisify(execFile);
const MEDIA_ID = "44444444-4444-4444-8444-444444444444";
/** Six seconds is three segments, so boundaries land on the segment grid. */
const EPOCH_TARGET_SECONDS = 6;
/** The epoch whose source is unreadable — the fixture's stand-in for epoch 10. */
const DAMAGED_EPOCH = 2;

/**
 * The lines FFmpeg actually produced, verbatim apart from the addresses.
 *
 * Written out rather than paraphrased because the classifier reads them, and a
 * classifier tested against invented text proves nothing about the failure it
 * exists for.
 */
const SOURCE_READ_STDERR = [
  "[in#0/matroska,webm @ 0x14b706ce0] Read error at pos. 10074169063",
  "[in#0/matroska,webm @ 0x14b706ce0] Error during demuxing: Input/output error",
  "",
].join("\n");

const OUTPUT_WRITE_STDERR = [
  "[out#0/hls @ 0x14b7071e0] Error writing trailer: Input/output error",
  "av_interleaved_write_frame(): Input/output error",
  "",
].join("\n");

let fixture: string | null = null;
let workspace = "";
/** A process that reads a little, stops, and then will not exit or die. */
let hangingEncoder = "";

/**
 * Thresholds a test can afford.
 *
 * The production figures are a quarter of a minute and ten seconds of grace,
 * chosen against a disk that takes 35 seconds to admit a read has failed. The
 * *behaviour* is what is under test, so it is provoked in a second.
 */
const FAST_STALLS = {
  softStallMs: 200,
  hardStallMs: 700,
  startupStallMs: 10_000,
  terminationGraceMs: 300,
  sourceProbeTimeoutMs: 8_000,
} as const;

/**
 * The shape of the real incident, as a process.
 *
 * It emits FFmpeg's progress format with an advancing timeline, then the exact
 * lines the damaged Seagate volume produced, and then it stops — without
 * exiting, because that is precisely what the real FFmpeg did. Nothing in the
 * pipeline may wait for it.
 */
const HANGING_ENCODER = `
const mode = process.env.SEYIRLIK_TEST_STDERR ?? "source-eio";
let seconds = 0;
for (let index = 0; index < 3; index += 1) {
  seconds += 1;
  const clock = new Date(seconds * 1000).toISOString().slice(11, 23);
  process.stdout.write("out_time=" + clock + "\\n");
  process.stdout.write("speed=1.4x\\n");
  process.stdout.write("progress=continue\\n");
  await new Promise((resolve) => setTimeout(resolve, 40));
}
if (mode === "source-eio") {
  process.stderr.write(
    "[in#0/matroska,webm @ 0x1] Read error at pos. 10074169063\\n" +
      "[in#0/matroska,webm @ 0x1] Error during demuxing: Input/output error\\n",
  );
} else if (mode === "output-eio") {
  process.stderr.write(
    "[out#0/hls @ 0x1] Error writing trailer: Input/output error\\n" +
      "av_interleaved_write_frame(): Input/output error\\n",
  );
}
setInterval(() => {}, 1000);
`;

type Runner = typeof runFfmpeg;

interface Harness {
  paths: RenditionPaths;
  sourcePath: string;
  titleRoot: string;
  fingerprint: string;
  checkpoints: string;
}

async function createHarness(): Promise<Harness> {
  const root = await mkdtemp(path.join(workspace, "run-"));
  const paths: RenditionPaths = {
    mediaRoot: getAdaptiveFixtureDirectory(),
    renditionRoot: path.join(root, "renditions"),
    workRoot: path.join(root, "work"),
    stateRoot: path.join(root, "state"),
    logsRoot: path.join(root, "logs"),
  };
  await mkdir(paths.logsRoot, { recursive: true });
  await mkdir(path.join(paths.stateRoot, "locks"), { recursive: true });

  const titleRoot = await mkdtemp(path.join(workspace, "title-"));
  const sourcePath = path.join(titleRoot, "damaged-source.mp4");
  await copyFile(fixture!, sourcePath);
  const fingerprint = await computeSourceFingerprint(
    sourcePath,
    await stat(sourcePath),
  );
  return {
    paths,
    sourcePath,
    titleRoot,
    fingerprint,
    checkpoints: checkpointRoot(
      paths.workRoot,
      MEDIA_ID,
      ADAPTIVE_PROFILE_VERSION,
      fingerprint,
    ),
  };
}

async function runPackage(
  harness: Harness,
  overrides: Record<string, unknown> = {},
) {
  return packageAdaptiveRendition(
    {
      mediaId: MEDIA_ID,
      relativePath: path.basename(harness.sourcePath),
      sourceFingerprint: harness.fingerprint,
      sourcePath: harness.sourcePath,
    },
    harness.paths,
    {
      reserveBytes: 0,
      preset: "ultrafast",
      verifySourceFingerprint: false,
      epochTargetSeconds: EPOCH_TARGET_SECONDS,
      sourceIoBackoffMs: [0, 0, 0],
      storageAvailable: () => true,
      missingRoots: () => [],
      ...overrides,
    } as never,
  );
}

/** The `-ss` this invocation seeks the source to, if it seeks at all. */
function seekOf(args: readonly string[]): number | null {
  const index = args.indexOf("-ss");
  if (index < 0) return null;
  const value = Number(args[index + 1]);
  return Number.isFinite(value) ? value : null;
}

function inputOf(args: readonly string[]): string | undefined {
  return args[args.indexOf("-i") + 1];
}

/**
 * A runner that fails exactly the reads a bad platter would.
 *
 * Targeted by seek position rather than by call count, because the salvage path
 * runs FFmpeg for the replacement too — and a runner that failed by ordinal
 * would break the very repair it is meant to let happen. The generator input is
 * left alone for the same reason, and so are the audio ranges, which read
 * around the hole.
 */
function failingSourceReads(
  harness: Harness,
  {
    window,
    mode = "throw",
    times = Number.POSITIVE_INFINITY,
  }: {
    window: [number, number];
    /**
     * `throw` — FFmpeg exits non-zero, the ordinary shape of the failure.
     * `clean` — FFmpeg reports the read error and *exits zero* after producing
     *   a short output, which is the shape that used to reach the duration
     *   validator and be blamed on the encoder.
     */
    mode?:
      | "throw"
      | "clean"
      | "output-write"
      | "hang"
      | "hang-silently"
      | "hang-writing";
    /** How many times to fail before letting the read succeed. */
    times?: number;
  },
): { runner: Runner; failures: () => number } {
  let failed = 0;
  const runner: Runner = async (command, args, options) => {
    const seek = seekOf(args);
    const targeted =
      inputOf(args) === harness.sourcePath &&
      seek !== null &&
      seek >= window[0] &&
      seek < window[1];
    if (!targeted || failed >= times) {
      // Only the synthetic hanging child uses the accelerated failure clock.
      // Real encodes (including audio finalization) retain production budgets.
      const production = stallThresholds();
      return runFfmpeg(
        command,
        args,
        mode.startsWith("hang") && options.watchdog
          ? {
              ...options,
              watchdog: {
                ...options.watchdog,
                hardStallMs: production.hardStallMs,
                startupStallMs: production.startupStallMs,
                terminationGraceMs: production.terminationGraceMs,
              },
            }
          : options,
      );
    }

    failed += 1;
    if (mode.startsWith("hang")) {
      /*
       * The real failure, and the one every synthetic test missed: a process
       * that stops producing and does not exit. It is spawned through the very
       * runner under test, with the watchdog the engine asked for, so what
       * ends it is the production code path rather than the fixture giving up.
       */
      const previous = process.env.SEYIRLIK_TEST_STDERR;
      process.env.SEYIRLIK_TEST_STDERR =
        mode === "hang-silently"
          ? "none"
          : mode === "hang-writing"
            ? "output-eio"
            : "source-eio";
      try {
        await runFfmpeg(process.execPath, [hangingEncoder], options);
      } finally {
        if (previous === undefined) delete process.env.SEYIRLIK_TEST_STDERR;
        else process.env.SEYIRLIK_TEST_STDERR = previous;
      }
      return;
    }
    if (mode === "output-write") {
      options.onStderr?.(OUTPUT_WRITE_STDERR);
      throw new Error(
        `FFmpeg failed with exit code 1: ${OUTPUT_WRITE_STDERR.trim()}`,
      );
    }
    options.onStderr?.(SOURCE_READ_STDERR);
    if (mode === "throw") {
      throw new Error(
        `FFmpeg failed with exit code 1: ${SOURCE_READ_STDERR.trim()}`,
      );
    }
    /*
     * The clean-exit case, produced honestly: the same command with a shorter
     * output duration, so the epoch really is 2 seconds of a 6 second window
     * and the process really does exit zero.
     */
    const shortened = [...args];
    const duration = shortened.lastIndexOf("-t");
    if (duration >= 0) shortened[duration + 1] = "2";
    await runFfmpeg(command, shortened, options);
  };
  return { runner, failures: () => failed };
}

/** Workspaces that are being written, or were abandoned by a dead attempt. */
async function partialEpochs(harness: Harness): Promise<string[]> {
  return (
    await readdir(epochsRoot(harness.checkpoints)).catch(() => [])
  ).filter((name) => name.includes(".partial"));
}

async function durableEpochs(harness: Harness): Promise<string[]> {
  return (await readdir(epochsRoot(harness.checkpoints)).catch(() => []))
    .filter((name) => /^\d{6}$/.test(name))
    .sort();
}

async function manifestOf(
  harness: Harness,
  index: number,
): Promise<EpochCheckpointManifest> {
  return JSON.parse(
    await readFile(
      path.join(
        epochsRoot(harness.checkpoints),
        epochDirectoryName(index),
        EPOCH_MANIFEST_FILE,
      ),
      "utf8",
    ),
  ) as EpochCheckpointManifest;
}

/**
 * The checkpoint state as it stands just before assembly.
 *
 * Publication removes the checkpoints — that is the point of no return for a
 * resumable build — so a test that wants to look at what the encoder produced
 * has to look while it is still there. The assembling stage is the last moment
 * every epoch exists and nothing has been published.
 */
function captureBeforeAssembly(harness: Harness): {
  hook: (event: { type: string; stage?: string }) => void;
  captured: () => Promise<{
    manifests: Map<number, EpochCheckpointManifest>;
    plan: Awaited<ReturnType<typeof readEpochPlanFile>>;
  }>;
} {
  let resolve: (value: {
    manifests: Map<number, EpochCheckpointManifest>;
    plan: Awaited<ReturnType<typeof readEpochPlanFile>>;
  }) => void;
  const promise = new Promise<{
    manifests: Map<number, EpochCheckpointManifest>;
    plan: Awaited<ReturnType<typeof readEpochPlanFile>>;
  }>((settle) => {
    resolve = settle;
  });
  let taken = false;
  return {
    hook: (event) => {
      if (taken || event.type !== "build-stage" || event.stage !== "assembling")
        return;
      taken = true;
      void (async () => {
        const manifests = new Map<number, EpochCheckpointManifest>();
        for (const name of await durableEpochs(harness)) {
          manifests.set(Number(name), await manifestOf(harness, Number(name)));
        }
        resolve({
          manifests,
          plan: await readEpochPlanFile(harness.checkpoints),
        });
      })();
    },
    captured: () => promise,
  };
}

/** Mean volume of a stretch of a packaged audio rendition, in dBFS. */
async function meanVolume(
  mediaPath: string,
  startSeconds: number,
  durationSeconds: number,
): Promise<number> {
  const { stderr } = await run(
    "ffmpeg",
    [
      "-hide_banner",
      "-nostdin",
      "-ss",
      String(startSeconds),
      "-t",
      String(durationSeconds),
      "-i",
      mediaPath,
      "-af",
      "volumedetect",
      "-f",
      "null",
      "-",
    ],
    { maxBuffer: 16 * 1024 * 1024 },
  );
  const match = /mean_volume:\s*(-?[\d.]+) dB/.exec(stderr);
  if (!match) throw new Error(`volumedetect said nothing usable: ${stderr}`);
  return Number(match[1]);
}

beforeAll(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), "seyirlik-salvage-it-"));
  hangingEncoder = path.join(workspace, "hanging-encoder.mjs");
  await writeFile(hangingEncoder, HANGING_ENCODER, "utf8");
  fixture = await ensureAdaptiveEpochFixture();
}, 300_000);

afterAll(async () => {
  if (workspace) await rm(workspace, { recursive: true, force: true });
});

describe("a source region that cannot be read", () => {
  it("fails the job and keeps every checkpoint under the strict policy", async () => {
    if (!fixture) return;
    const harness = await createHarness();
    const { runner } = failingSourceReads(harness, { window: [11, 13] });

    const events: string[] = [];
    const result = await runPackage(harness, {
      runEncoder: runner,
      sourceDamagePolicy: "fail",
      onEvent: (event: { type: string }) => events.push(event.type),
    });

    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/damaged media|failing disk/i);
    // Nothing was substituted, and the interval is still named — which is
    // what an operator needs to decide between repairing the disc and
    // turning salvage on.
    expect(result.sourceDamage).toHaveLength(1);
    expect(result.sourceDamage![0]!.epochIndex).toBe(DAMAGED_EPOCH);
    expect(result.sourceDamage![0]!.ffmpegByteOffset).toBe(10_074_169_063);
    expect(events).not.toContain("epoch-salvaged");
    // The epochs before the hole are untouched.
    expect(await durableEpochs(harness)).toEqual(["000000", "000001"]);
  }, 900_000);

  it("replaces the interval and finishes the title under the salvage policy", async () => {
    if (!fixture) return;
    const harness = await createHarness();

    /*
     * The strict run first, so the checkpoints before the hole exist and can
     * be compared byte for byte afterwards. This is the case that matters
     * most in the real incident: nine epochs of correct work must survive the
     * tenth being unreadable.
     */
    const { runner: strict } = failingSourceReads(harness, {
      window: [11, 13],
    });
    await runPackage(harness, {
      runEncoder: strict,
      sourceDamagePolicy: "fail",
    });
    const before = [await manifestOf(harness, 0), await manifestOf(harness, 1)];

    const { runner, failures } = failingSourceReads(harness, {
      window: [11, 13],
    });
    const seen: Array<Record<string, unknown>> = [];
    const capture = captureBeforeAssembly(harness);
    const result = await runPackage(harness, {
      runEncoder: runner,
      sourceDamagePolicy: "replace-epoch",
      onEvent: (event: Record<string, unknown>) => {
        seen.push(event);
        capture.hook(event as { type: string; stage?: string });
      },
    });

    expect(result.status).toBe("ready");
    const { manifests, plan } = await capture.captured();

    // Only the damaged epoch was replaced.
    const damage = result.sourceDamage ?? [];
    expect(damage).toHaveLength(1);
    expect(damage[0]!.epochIndex).toBe(DAMAGED_EPOCH);
    expect(damage[0]!.audioReplaced).toBe(true);
    // The evidence travels with it, and carries no filesystem path: this
    // text is served to a browser.
    const evidence = damage[0]!.evidence.join(" ");
    expect(evidence).toContain("Read error at pos.");
    expect(evidence).not.toContain(harness.sourcePath);
    expect(evidence).not.toContain(path.dirname(harness.sourcePath));
    expect(evidence).not.toMatch(/(?:^|\s)\//);
    // And it says each thing once, however many layers repeated it.
    expect(new Set(damage[0]!.evidence).size).toBe(damage[0]!.evidence.length);

    /*
     * The read budget, and the whole point of it. One application read of the
     * damaged region on the real drive took 35-37 seconds, because the kernel
     * retries a failing sector about twenty times before giving up — so the
     * four attempts a transient I/O error is allowed would be two and a half
     * minutes of deliberately re-injuring the same platter. FFmpeg named its
     * input here, so the evidence is decisive after the first failure and
     * exactly one confirming read is spent.
     */
    expect(failures()).toBe(2);
    // And the generic validation retry loop was never entered for this epoch.
    expect(
      seen.filter(
        (event) =>
          event.type === "epoch-invalid" && event.index === DAMAGED_EPOCH,
      ),
    ).toHaveLength(0);

    // The completed epochs were not regenerated: the manifests are the same
    // documents, byte for byte, that the failed run left behind.
    expect(manifests.get(0)).toEqual(before[0]);
    expect(manifests.get(1)).toEqual(before[1]);

    // Exactly one checkpoint is synthetic, and it is the damaged one.
    const salvaged = manifests.get(DAMAGED_EPOCH)!;
    expect(salvaged.salvage?.kind).toBe("source-damage");
    expect(salvaged.salvage?.sourceRetryCount).toBe(2);
    expect(manifests.get(3)!.salvage).toBeUndefined();

    // And it is exactly as long as the plan said, not as long as the source
    // managed to give: this is what keeps 00:55:00 at 00:55:00.
    const planned = plan!.epochs[DAMAGED_EPOCH]!.expectedDurationSeconds;
    expect(salvaged.expectedDurationSeconds).toBeCloseTo(planned, 6);
    expect(Math.abs(salvaged.actualDurationSeconds - planned)).toBeLessThan(
      0.25,
    );

    // The replacement carries every rung, at the same dimensions and codec
    // as the film around it, joined under the same initialisation segment.
    const reference = manifests.get(1)!;
    expect(salvaged.renditions.map((entry) => entry.id).sort()).toEqual(
      reference.renditions.map((entry) => entry.id).sort(),
    );
    for (const rendition of salvaged.renditions) {
      const real = reference.renditions.find(
        (entry) => entry.id === rendition.id,
      )!;
      expect(rendition.width).toBe(real.width);
      expect(rendition.height).toBe(real.height);
      expect(rendition.codec).toBe(real.codec);
      expect(rendition.pixelFormat).toBe(real.pixelFormat);
      expect(rendition.mediaTimescale).toBe(real.mediaTimescale);
      expect(rendition.initDigest).toBe(real.initDigest);
    }
  }, 900_000);

  it("publishes a package that passes its own validation and holds the timeline", async () => {
    if (!fixture) return;
    const harness = await createHarness();
    const { runner } = failingSourceReads(harness, { window: [11, 13] });
    const capture = captureBeforeAssembly(harness);
    const result = await runPackage(harness, {
      runEncoder: runner,
      sourceDamagePolicy: "replace-epoch",
      onEvent: capture.hook,
    });
    expect(result.status).toBe("ready");
    const { plan } = await capture.captured();

    const validation = await validateAdaptivePackage({
      versionRoot: harness.titleRoot,
      mediaId: MEDIA_ID,
      sourceFingerprint: harness.fingerprint,
      profileVersion: ADAPTIVE_PROFILE_VERSION,
      ffprobePath: "ffprobe",
      ffmpegPath: "ffmpeg",
      deep: true,
    });
    expect(validation.issues).toEqual([]);
    expect(validation.ok).toBe(true);

    /*
     * The timeline, which is the whole point. The source is 26s and the
     * package must still be 26s: an epoch collapsed to the 2s that were
     * readable would have produced a 22s title with everything after the
     * hole four seconds early.
     */
    const manifest = (await readTitlePackageManifest(harness.titleRoot))!;
    expect(manifest).not.toBeNull();
    for (const rendition of manifest.video) {
      const playlist = parseMediaPlaylist(
        await readFile(
          path.join(harness.titleRoot, ...rendition.playlistPath.split("/")),
          "utf8",
        ),
      );
      expect(playlist.totalDurationSeconds).toBeCloseTo(
        plan!.sourceDurationSeconds,
        0,
      );
    }

    /*
     * The sound, measured rather than assumed. Silence over exactly the
     * replaced interval, and the fixture's 440 Hz tone still audible after
     * it — which is only true if the material following the hole kept its
     * own place instead of being pulled earlier.
     */
    const hole = {
      start: plan!.epochs[DAMAGED_EPOCH]!.nominalStartSeconds,
      end: plan!.epochs[DAMAGED_EPOCH + 1]!.nominalStartSeconds,
    };
    const audioPath = path.join(
      harness.titleRoot,
      ...manifest.audio[0]!.mediaPath.split("/"),
    );
    const insideHole = await meanVolume(
      audioPath,
      hole.start + 0.5,
      hole.end - hole.start - 1,
    );
    const beforeHole = await meanVolume(audioPath, 1, 4);
    const afterHole = await meanVolume(audioPath, hole.end + 0.5, 4);
    expect(insideHole).toBeLessThan(-60);
    expect(beforeHole).toBeGreaterThan(-40);
    expect(afterHole).toBeGreaterThan(-40);
  }, 900_000);

  it("recognises a read failure even when FFmpeg exits cleanly", async () => {
    if (!fixture) return;
    const harness = await createHarness();
    /*
     * The subtle shape of the incident: the demuxer gives up, the muxer
     * finalises, `progress=end` arrives and the process returns zero — with
     * two seconds of a six second epoch on disk. Read as an encoder fault
     * this costs the retry budget and then fails the title; read from the
     * log it is what it is.
     */
    const { runner } = failingSourceReads(harness, {
      window: [11, 13],
      mode: "clean",
    });
    const seen: Array<Record<string, unknown>> = [];
    const result = await runPackage(harness, {
      runEncoder: runner,
      sourceDamagePolicy: "replace-epoch",
      onEvent: (event: Record<string, unknown>) => seen.push(event),
    });

    expect(result.status).toBe("ready");
    expect(result.sourceDamage).toHaveLength(1);
    // Diagnosed from the log, before the duration validator ever saw the
    // short epoch. Had it reached the validator this would be non-empty.
    expect(
      seen.filter(
        (event) =>
          event.type === "epoch-invalid" && event.index === DAMAGED_EPOCH,
      ),
    ).toHaveLength(0);
    expect(seen.some((event) => event.type === "source-damage-confirmed")).toBe(
      true,
    );
  }, 900_000);

  it("does not salvage a read that recovers on its own", async () => {
    if (!fixture) return;
    const harness = await createHarness();
    // One failure, then the source reads. That is a passing stall, not a
    // dying disk, and replacing five minutes over it would be vandalism.
    const { runner } = failingSourceReads(harness, {
      window: [11, 13],
      times: 1,
    });
    const seen: string[] = [];
    const capture = captureBeforeAssembly(harness);
    const result = await runPackage(harness, {
      runEncoder: runner,
      sourceDamagePolicy: "replace-epoch",
      onEvent: (event: { type: string; stage?: string }) => {
        seen.push(event.type);
        capture.hook(event);
      },
    });

    expect(result.status).toBe("ready");
    expect(result.sourceDamage).toBeUndefined();
    expect(seen).toContain("source-io-retry");
    expect(seen).not.toContain("epoch-salvaged");
    const { manifests } = await capture.captured();
    expect(manifests.get(DAMAGED_EPOCH)!.salvage).toBeUndefined();
  }, 900_000);

  it("does not treat an output write failure as source damage", async () => {
    if (!fixture) return;
    const harness = await createHarness();
    const { runner } = failingSourceReads(harness, {
      window: [11, 13],
      mode: "output-write",
    });
    const result = await runPackage(harness, {
      runEncoder: runner,
      sourceDamagePolicy: "replace-epoch",
    });

    // The destination volume is the problem, so the job waits for storage in
    // the way it always has. No film is replaced with black over it.
    expect(result.status).not.toBe("ready");
    expect(result.sourceDamage).toBeUndefined();
    expect(await durableEpochs(harness)).toEqual(["000000", "000001"]);
  }, 900_000);

  it("uses the existing storage path when the volume itself goes away", async () => {
    if (!fixture) return;
    const harness = await createHarness();
    const { runner } = failingSourceReads(harness, { window: [11, 13] });
    let storageThere = true;
    const result = await runPackage(harness, {
      runEncoder: runner,
      sourceDamagePolicy: "replace-epoch",
      storageAvailable: () => {
        const answer = storageThere;
        storageThere = false;
        return answer;
      },
      missingRoots: () => (storageThere ? [] : ["/Volumes/Expansion"]),
    });

    expect(result.status).toBe("interrupted");
    expect(result.interruption).toBe("storage");
    expect(result.sourceDamage).toBeUndefined();
    expect(await durableEpochs(harness)).toEqual(["000000", "000001"]);
  }, 900_000);
});

/**
 * The regression the hardware found.
 *
 * Every case here uses a process that genuinely hangs. Before the watchdog
 * existed the engine would simply wait for it — the real one sat for minutes,
 * walking from one unreadable block to the next — and when it was eventually
 * killed by hand the failure escaped as a generic error and the whole job was
 * requeued straight back into the damaged region.
 */
describe("an encoder that hangs on a damaged region", () => {
  it("is stopped, diagnosed and salvaged inside the same job", async () => {
    if (!fixture) return;
    const harness = await createHarness();
    const { runner, failures } = failingSourceReads(harness, {
      window: [11, 13],
      mode: "hang",
    });

    const seen: Array<Record<string, unknown>> = [];
    const capture = captureBeforeAssembly(harness);
    const started = Date.now();
    const result = await runPackage(harness, {
      runEncoder: runner,
      sourceDamagePolicy: "replace-epoch",
      stalls: FAST_STALLS,
      onEvent: (event: Record<string, unknown>) => {
        seen.push(event);
        capture.hook(event as { type: string; stage?: string });
      },
    });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe("ready");
    // Bounded. The fixture never exits on its own, so finishing at all is
    // the property under test.
    expect(Date.now() - started).toBeLessThan(600_000);

    // The escalation was announced before the diagnosis, so a page is never
    // silent through it.
    const order = seen
      .map((event) => event.type)
      .filter(
        (type) =>
          type === "source-stall-abort" ||
          type === "source-io-retry" ||
          type === "source-damage-confirmed" ||
          type === "epoch-salvage-start" ||
          type === "epoch-salvaged",
      );
    expect(order.indexOf("source-stall-abort")).toBe(0);
    expect(order.indexOf("source-damage-confirmed")).toBeGreaterThan(
      order.indexOf("source-io-retry"),
    );
    expect(order.at(-1)).toBe("epoch-salvaged");

    // Diagnosed from the input side, and never handed to the duration
    // validator.
    expect(result.sourceDamage).toHaveLength(1);
    expect(result.sourceDamage![0]!.ffmpegByteOffset).toBe(10_074_169_063);
    expect(
      seen.filter(
        (event) =>
          event.type === "epoch-invalid" && event.index === DAMAGED_EPOCH,
      ),
    ).toHaveLength(0);
    // And the damaged region was read twice, not four times.
    expect(failures()).toBe(2);

    const { manifests } = await capture.captured();
    expect(manifests.get(DAMAGED_EPOCH)!.salvage?.kind).toBe("source-damage");
    expect(manifests.get(0)!.salvage).toBeUndefined();
    expect(manifests.get(3)!.salvage).toBeUndefined();
    // Nothing was left behind by the attempts that were killed.
    expect(await partialEpochs(harness)).toEqual([]);
  }, 900_000);

  it("will not salvage a hang the source is innocent of", async () => {
    if (!fixture) return;
    const harness = await createHarness();
    const { runner } = failingSourceReads(harness, {
      window: [11, 13],
      mode: "hang-silently",
    });

    const seen: string[] = [];
    const result = await runPackage(harness, {
      runEncoder: runner,
      sourceDamagePolicy: "replace-epoch",
      stalls: FAST_STALLS,
      onEvent: (event: { type: string }) => seen.push(event.type),
    });

    /*
     * The encoder stopped producing and the source reads perfectly. Turning
     * that into black picture would be erasing five minutes of a film to work
     * around a bug, so it is a failure with its own name instead.
     */
    expect(result.status).toBe("failed");
    expect(result.failureKind).toBe("media-progress-timeout");
    expect(result.sourceDamage).toBeUndefined();
    expect(seen).not.toContain("epoch-salvaged");
    expect(seen).toContain("source-stall-abort");
    expect(await durableEpochs(harness)).toEqual(["000000", "000001"]);
  }, 900_000);

  /*
   * The regression the real hardware run exposed, and the reason this file
   * exists twice over.
   *
   * With the watchdog stopping the encoder *before* Darwin's twenty-retry
   * recovery returns `EIO`, FFmpeg writes nothing about its input — so the
   * readability probe becomes the only evidence there is, and it has to be
   * pointed at the right bytes. It was pointed at the epoch's start, which the
   * encoder had just finished reading successfully, so a genuinely damaged
   * title was cleared of suspicion and failed as an encoder fault.
   */
  it("asks about the stretch it could not read, not the part it already had", async () => {
    if (!fixture) return;
    const harness = await createHarness();
    const { runner } = failingSourceReads(harness, {
      window: [11, 13],
      mode: "hang-silently",
    });

    const windows: Array<{
      epochIndex: number;
      fromSeconds: number;
      toSeconds: number;
    }> = [];
    await runPackage(harness, {
      runEncoder: runner,
      sourceDamagePolicy: "replace-epoch",
      stalls: FAST_STALLS,
      verifySourceReadable: async (window: {
        epochIndex: number;
        fromSeconds: number;
        toSeconds: number;
      }) => {
        windows.push(window);
        return { verdict: "readable" as const };
      },
    });

    expect(windows.length).toBeGreaterThan(0);
    const asked = windows[0]!;
    expect(asked.epochIndex).toBe(DAMAGED_EPOCH);
    /*
     * The fixture produces three seconds and then stops, so the question is
     * about what lies past 00:15 — never about 00:12, which is where the epoch
     * began and where the read demonstrably worked.
     */
    expect(asked.fromSeconds).toBeGreaterThan(14);
    expect(asked.fromSeconds).toBeLessThan(16);
    expect(asked.toSeconds).toBeGreaterThan(asked.fromSeconds);
    expect(asked.toSeconds).toBeLessThanOrEqual(19);
  }, 900_000);

  /*
   * And the behaviour that window buys: a hang with nothing in stderr is
   * salvaged when — and only when — the bytes it stopped on will not come back.
   * This is the shape of the real incident once the watchdog is fast enough to
   * stop the encoder before it can report anything.
   */
  it("salvages a silent hang whose window will not read", async () => {
    if (!fixture) return;
    const harness = await createHarness();
    const { runner } = failingSourceReads(harness, {
      window: [11, 13],
      mode: "hang-silently",
    });

    const seen: string[] = [];
    let asked = 0;
    const result = await runPackage(harness, {
      runEncoder: runner,
      sourceDamagePolicy: "replace-epoch",
      stalls: FAST_STALLS,
      verifySourceReadable: async () => {
        asked += 1;
        return { verdict: "timeout" as const };
      },
      onEvent: (event: { type: string }) => seen.push(event.type),
    });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe("ready");
    expect(seen).toContain("source-stall-abort");
    expect(seen).toContain("epoch-salvaged");
    expect(result.sourceDamage).toHaveLength(1);
    expect(result.sourceDamage![0]!.epochIndex).toBe(DAMAGED_EPOCH);
    // One confirming read, not a budget spent re-injuring the same region.
    expect(asked).toBe(1);
    expect(await partialEpochs(harness)).toEqual([]);
  }, 900_000);

  it("will not salvage a hang whose errors name the output", async () => {
    if (!fixture) return;
    const harness = await createHarness();
    const { runner } = failingSourceReads(harness, {
      window: [11, 13],
      mode: "hang-writing",
    });

    const seen: string[] = [];
    const result = await runPackage(harness, {
      runEncoder: runner,
      sourceDamagePolicy: "replace-epoch",
      stalls: FAST_STALLS,
      onEvent: (event: { type: string }) => seen.push(event.type),
    });

    expect(result.status).not.toBe("ready");
    expect(result.sourceDamage).toBeUndefined();
    expect(seen).not.toContain("epoch-salvaged");
    expect(await durableEpochs(harness)).toEqual(["000000", "000001"]);
  }, 900_000);

  it("lets a vanished volume win over a source diagnosis", async () => {
    if (!fixture) return;
    const harness = await createHarness();
    const { runner } = failingSourceReads(harness, {
      window: [11, 13],
      mode: "hang",
    });
    let storageThere = true;
    const result = await runPackage(harness, {
      runEncoder: runner,
      sourceDamagePolicy: "replace-epoch",
      stalls: FAST_STALLS,
      storageAvailable: () => {
        const answer = storageThere;
        storageThere = false;
        return answer;
      },
      missingRoots: () => (storageThere ? [] : ["/Volumes/Expansion"]),
    });

    // A drive that has gone is waited for, not blamed. Salvage must not
    // consume the storage-interruption path.
    expect(result.status).toBe("interrupted");
    expect(result.interruption).toBe("storage");
    expect(result.sourceDamage).toBeUndefined();
    expect(await durableEpochs(harness)).toEqual(["000000", "000001"]);
  }, 900_000);

  it("lets a person cancelling win over a source diagnosis", async () => {
    if (!fixture) return;
    const harness = await createHarness();
    const controller = new AbortController();
    const { runner } = failingSourceReads(harness, {
      window: [11, 13],
      mode: "hang",
    });

    const seen: string[] = [];
    const result = await runPackage(harness, {
      runEncoder: (async (command, args, options) => {
        if (seekOf(args) !== null && inputOf(args) === harness.sourcePath) {
          // Cancelled while the damaged epoch is running, which is when the
          // two decisions could be confused for one another.
          setTimeout(() => controller.abort(), 200);
        }
        return runner(command, args, options);
      }) satisfies Runner,
      signal: controller.signal,
      sourceDamagePolicy: "replace-epoch",
      stalls: FAST_STALLS,
      onEvent: (event: { type: string }) => seen.push(event.type),
    });

    expect(result.status).toBe("interrupted");
    expect(result.interruption).toBe("cancelled");
    expect(result.sourceDamage).toBeUndefined();
    expect(seen).not.toContain("epoch-salvaged");
  }, 900_000);

  it("fails promptly under the strict policy without hammering the region", async () => {
    if (!fixture) return;
    const harness = await createHarness();
    const { runner, failures } = failingSourceReads(harness, {
      window: [11, 13],
      mode: "hang",
    });

    const result = await runPackage(harness, {
      runEncoder: runner,
      sourceDamagePolicy: "fail",
      stalls: FAST_STALLS,
    });

    expect(result.status).toBe("failed");
    expect(result.failureKind).toBe("source-io");
    expect(result.sourceDamage).toHaveLength(1);
    // Two reads of a region that takes half a minute to refuse one, rather
    // than the four a transient error is allowed.
    expect(failures()).toBe(2);
    expect(await durableEpochs(harness)).toEqual(["000000", "000001"]);
    expect(await partialEpochs(harness)).toEqual([]);
  }, 900_000);
});

/**
 * The same silent hang on a network volume.
 *
 * The 2026-10-23 incident: an epoch read over the Drive mount went quiet, the
 * bounded probe timed out too, and the hang above was read as damage — so a
 * healthy library was quarantined. On a network source that silence is waited
 * out, and only a production circuit breaker that is never called proves it.
 */
describe("an encoder that hangs on a network volume", () => {
  it("waits out a stall that clears and finishes the title", async () => {
    if (!fixture) return;
    const harness = await createHarness();
    const { runner, failures } = failingSourceReads(harness, {
      window: [11, 13],
      mode: "hang-silently",
      times: 1,
    });

    const hardFaults: string[] = [];
    const verdicts: string[] = [];
    const result = await runPackage(harness, {
      runEncoder: runner,
      stalls: FAST_STALLS,
      sourceOnNetworkVolume: true,
      networkStallBackoffMs: [0, 0, 0],
      verifySourceReadable: async () => ({ verdict: "timeout" as const }),
      onHardStorageFault: async (failure: { kind: string }) => {
        hardFaults.push(failure.kind);
      },
      onEvent: (event: { type: string; verdict?: string }) => {
        if (event.type === "source-io-retry" && event.verdict) {
          verdicts.push(event.verdict);
        }
      },
    });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe("ready");
    expect(result.sourceDamage).toBeUndefined();
    expect(hardFaults).toEqual([]);
    expect(verdicts).toEqual(["network-stall"]);
    expect(failures()).toBe(1);
  }, 900_000);

  it("hands a stall that never clears back to the queue, not to quarantine", async () => {
    if (!fixture) return;
    const harness = await createHarness();
    const { runner, failures } = failingSourceReads(harness, {
      window: [11, 13],
      mode: "hang-silently",
    });

    const hardFaults: string[] = [];
    let asked = 0;
    const result = await runPackage(harness, {
      runEncoder: runner,
      sourceDamagePolicy: "replace-epoch",
      stalls: FAST_STALLS,
      sourceOnNetworkVolume: true,
      networkStallBackoffMs: [0, 0, 0],
      verifySourceReadable: async () => {
        asked += 1;
        return { verdict: "timeout" as const };
      },
      onHardStorageFault: async (failure: { kind: string }) => {
        hardFaults.push(failure.kind);
      },
    });

    expect(result.status).toBe("failed");
    expect(result.failureKind).toBe("network-read-stall");
    // Never salvaged, even where salvage is allowed: nothing is wrong with it.
    expect(result.sourceDamage).toBeUndefined();
    expect(hardFaults).toEqual([]);
    // Four reads, one per wait, before the queue gets it back.
    expect(failures()).toBe(4);
    expect(asked).toBe(4);
    expect(await durableEpochs(harness)).toEqual(["000000", "000001"]);
    expect(await partialEpochs(harness)).toEqual([]);
  }, 900_000);
});

/**
 * What a killed attempt leaves on disk.
 *
 * The real incident left two `000010.partial-*` directories behind, because the
 * processes were killed from outside. Nothing may depend on someone noticing
 * them, and nothing may sweep up a valid checkpoint along with them.
 */
describe("workspaces left by attempts that were killed", () => {
  it("clears stale partials and leaves every completed epoch alone", async () => {
    if (!fixture) return;
    const harness = await createHarness();
    const { runner } = failingSourceReads(harness, { window: [11, 13] });
    await runPackage(harness, {
      runEncoder: runner,
      sourceDamagePolicy: "fail",
    });
    const durableBefore = await durableEpochs(harness);
    expect(durableBefore).toEqual(["000000", "000001"]);
    const manifestsBefore = new Map<string, string>();
    for (const name of durableBefore) {
      manifestsBefore.set(
        name,
        await readFile(
          path.join(epochsRoot(harness.checkpoints), name, EPOCH_MANIFEST_FILE),
          "utf8",
        ),
      );
    }

    /*
     * Two abandoned workspaces for the damaged epoch, named after a process
     * that no longer exists — exactly what the real incident left.
     */
    for (const token of ["f9a9386a", "324ba491"]) {
      const stale = path.join(
        epochsRoot(harness.checkpoints),
        `${epochDirectoryName(DAMAGED_EPOCH)}.partial-424242-${token}`,
      );
      await mkdir(path.join(stale, "video", "360p"), { recursive: true });
      await writeFile(
        path.join(stale, "OWNER.json"),
        JSON.stringify({
          pid: 424_242,
          hostname: (await import("node:os")).hostname(),
          attemptId: "dead",
          startedAt: new Date(Date.now() - 600_000).toISOString(),
          heartbeatAt: new Date(Date.now() - 600_000).toISOString(),
        }),
        "utf8",
      );
    }
    expect((await partialEpochs(harness)).length).toBe(2);

    const capture = captureBeforeAssembly(harness);
    const salvaging = failingSourceReads(harness, { window: [11, 13] });
    const result = await runPackage(harness, {
      runEncoder: salvaging.runner,
      sourceDamagePolicy: "replace-epoch",
      onEvent: capture.hook,
    });

    expect(result.status).toBe("ready");
    // The stale workspaces are gone, and nothing that was valid went with
    // them: the two completed manifests are the same documents as before.
    expect(await partialEpochs(harness)).toEqual([]);
    const { manifests } = await capture.captured();
    for (const [name, text] of manifestsBefore) {
      expect(manifests.get(Number(name))).toEqual(JSON.parse(text));
    }
  }, 900_000);
});

describe("a replacement that is already on disk", () => {
  it("is recognised on a restart and never encoded twice", async () => {
    if (!fixture) return;
    const harness = await createHarness();

    /*
     * A salvaged build that dies before it can publish, which is exactly the
     * shape of a worker being killed or a machine restarting: the epochs are
     * durable, the package is not. The filesystem rejects the publication
     * rename, leaving everything upstream intact.
     */
    const { runner } = failingSourceReads(harness, { window: [11, 13] });
    const fault = await rejectPublicationCommit(harness.titleRoot);
    try {
      const failed = await runPackage(harness, {
        publicationFileSystem: fault.fileSystem,
        runEncoder: runner,
        sourceDamagePolicy: "replace-epoch",
      });
      expect(failed.status).not.toBe("ready");
    } finally {
      fault.restore();
    }
    expect(fault.rejected()).toBeGreaterThan(0);

    const durable = await durableEpochs(harness);
    expect(durable).toEqual(["000000", "000001", "000002", "000003"]);
    const placeholder = await manifestOf(harness, DAMAGED_EPOCH);
    expect(placeholder.salvage?.kind).toBe("source-damage");

    /*
     * The restart. The package had already been assembled and verified before
     * publication failed, so the job does not plan epochs at all this time: it
     * recognises the verified scratch package and goes straight to publishing
     * it. Nothing is encoded — not the epochs before the damage, not the
     * replacement, not the epochs after — and the sector that cannot be read
     * is not read a second time.
     */
    let encodes = 0;
    let planned = false;
    const { runner: stillBroken } = failingSourceReads(harness, {
      window: [11, 13],
    });
    const resumed = await runPackage(harness, {
      sourceDamagePolicy: "replace-epoch",
      runEncoder: (async (command, args, options) => {
        encodes += 1;
        return stillBroken(command, args, options);
      }) satisfies Runner,
      onEvent: (event: { type: string; reusedEpochs?: number }) => {
        if (event.type === "epoch-plan") planned = true;
      },
    });

    expect(resumed.status).toBe("ready");
    // Publication-only: the build was never re-planned, let alone re-encoded.
    expect(planned).toBe(false);
    expect(encodes).toBe(0);
    // And the title still says it is salvaged, from the checkpoint's own
    // record rather than from the run that discovered the damage.
    expect(resumed.sourceDamage).toHaveLength(1);
    expect(resumed.sourceDamage![0]!.epochIndex).toBe(DAMAGED_EPOCH);
    expect(resumed.sourceDamage![0]!.sourceRetryCount).toBe(2);
  }, 900_000);

  it("is not reused once the source file has been replaced", async () => {
    if (!fixture) return;
    const harness = await createHarness();
    const { runner } = failingSourceReads(harness, { window: [11, 13] });
    const fault = await rejectPublicationCommit(harness.titleRoot);
    try {
      await runPackage(harness, {
        publicationFileSystem: fault.fileSystem,
        runEncoder: runner,
        sourceDamagePolicy: "replace-epoch",
      });
    } finally {
      fault.restore();
    }
    expect(fault.rejected()).toBeGreaterThan(0);
    expect((await manifestOf(harness, DAMAGED_EPOCH)).salvage).toBeDefined();

    /*
     * A healthy copy of the same film, replaced in place. Its bytes differ,
     * so its fingerprint differs, so the checkpoint root differs — and
     * nothing about the damaged build can reach the new one. That is what
     * stops a repaired source from inheriting five minutes of black.
     */
    const healthy = await createHarness();
    expect(healthy.checkpoints).not.toBe(harness.checkpoints);
    const capture = captureBeforeAssembly(healthy);
    const clean = await runPackage(healthy, {
      sourceDamagePolicy: "replace-epoch",
      onEvent: capture.hook,
    });

    expect(clean.status).toBe("ready");
    expect(clean.sourceDamage).toBeUndefined();
    const { manifests } = await capture.captured();
    for (const manifest of manifests.values()) {
      expect(manifest.salvage).toBeUndefined();
    }
  }, 900_000);
});
