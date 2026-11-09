/**
 * The watchdog, against an encoder that really does hang.
 *
 * This is the regression the synthetic tests missed. Everything before it
 * proved that a *stall* was detected; none of it proved that anything was done
 * about one, because the fake encoders all returned. Here the fixture prints
 * FFmpeg's progress format, stops printing, and stays alive for ever — which is
 * what the real process did on the damaged Seagate volume while the only
 * reaction in the whole system was a label on a web page.
 *
 * The fixture never exits on its own. If the watchdog does not end it, these
 * tests hang, which is the correct way for them to fail.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runFfmpeg, EncoderAbortedError } from "./processor";
import { createPauseController } from "./processing/pauseController";
import { readSourceIoEvidence } from "./adaptive/epochs/sourceIo";

let workspace = "";
let fixture = "";
let logPath = "";

/**
 * An encoder that advances, then stops, and then does not exit.
 *
 * `STEPS` progress blocks a quarter of a second apart, exactly as FFmpeg's
 * `-stats_period 0.25` produces them; then the stderr the case needs; then
 * either a timeline that keeps moving (a slow but working encode) or silence.
 */
const FIXTURE = `
const steps = Number(process.env.STEPS ?? "3");
const mode = process.env.STDERR_MODE ?? "none";
const keepMoving = process.env.KEEP_MOVING === "true";
const emitEnd = process.env.EMIT_END === "true";
const outTimeHeld = process.env.OUT_TIME_HELD === "true";

let seconds = 0;
const report = (state) => {
  const clock = new Date(seconds * 1000).toISOString().slice(11, 23);
  // Beside a copied subtitle track with no cue yet, FFmpeg has no out_time
  // at all; only the video's frame count moves.
  process.stdout.write("frame=" + seconds * 24 + "\\n");
  process.stdout.write("out_time=" + (outTimeHeld ? "N/A" : clock) + "\\n");
  if (outTimeHeld) process.stdout.write("out_time_us=N/A\\n");
  process.stdout.write("speed=1.5x\\n");
  process.stdout.write("fps=48\\n");
  process.stdout.write("progress=" + state + "\\n");
};

for (let index = 0; index < steps; index += 1) {
  seconds += 1;
  report("continue");
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

if (keepMoving) {
  for (;;) {
    seconds += 1;
    report("continue");
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
}

if (emitEnd) {
  /*
   * The shape that used to be believed: the timeline never moves again, but
   * the reporting pipe says the run is over. "progress=end" is a statement
   * about the pipe, not about the media.
   */
  setInterval(() => report("end"), 40);
} else {
  setInterval(() => {}, 1000);
}
`;

beforeAll(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), "seyirlik-watchdog-"));
  fixture = path.join(workspace, "hanging-encoder.mjs");
  logPath = path.join(workspace, "encoder.log");
  await writeFile(fixture, FIXTURE, "utf8");
});

afterAll(async () => {
  if (workspace) await rm(workspace, { recursive: true, force: true });
});

interface RunOptions {
  steps?: number;
  stderrMode?: "none" | "source-eio" | "output-eio";
  keepMoving?: boolean;
  emitEnd?: boolean;
  outTimeHeld?: boolean;
}

async function runFixture(
  environment: RunOptions,
  options: Parameters<typeof runFfmpeg>[2],
): Promise<{ error?: unknown; samples: number[] }> {
  const previous = { ...process.env };
  process.env.STEPS = String(environment.steps ?? 3);
  process.env.STDERR_MODE = environment.stderrMode ?? "none";
  process.env.KEEP_MOVING = environment.keepMoving ? "true" : "false";
  process.env.EMIT_END = environment.emitEnd ? "true" : "false";
  process.env.OUT_TIME_HELD = environment.outTimeHeld ? "true" : "false";
  const samples: number[] = [];
  try {
    await runFfmpeg(process.execPath, [fixture], {
      ...options,
      onProgress: (progress) => {
        samples.push(progress.processedSeconds);
        options.onProgress?.(progress);
      },
    });
    return { samples };
  } catch (error) {
    return { error, samples };
  } finally {
    process.env.STEPS = previous.STEPS ?? "";
    process.env.STDERR_MODE = previous.STDERR_MODE ?? "";
    process.env.KEEP_MOVING = previous.KEEP_MOVING ?? "";
    process.env.EMIT_END = previous.EMIT_END ?? "";
    process.env.OUT_TIME_HELD = previous.OUT_TIME_HELD ?? "";
  }
}

describe("an encoder whose media time stops", () => {
  it("is still stopped when its frame count stops too", async () => {
    const { error } = await runFixture(
      { steps: 3, outTimeHeld: true },
      {
        logPath,
        watchdog: { hardStallMs: 700, terminationGraceMs: 300 },
      },
    );
    expect(error).toBeInstanceOf(EncoderAbortedError);
    expect((error as EncoderAbortedError).reason).toBe("media-watchdog");
  }, 30_000);

  it("is stopped by the watchdog rather than waited for", async () => {
    const started = Date.now();
    const { error, samples } = await runFixture(
      { steps: 3 },
      {
        logPath,
        watchdog: { hardStallMs: 700, terminationGraceMs: 300 },
      },
    );

    expect(error).toBeInstanceOf(EncoderAbortedError);
    const aborted = error as EncoderAbortedError;
    expect(aborted.reason).toBe("media-watchdog");
    // The position where it stopped is kept: it is still true, and it is where
    // a finer salvage would begin.
    expect(aborted.lastMediaSeconds).toBeCloseTo(3, 3);
    expect(aborted.stalledForMs).toBeGreaterThanOrEqual(700);
    expect(samples.at(-1)).toBeCloseTo(3, 3);
    // Bounded: this is the whole regression. The fixture never exits.
    expect(Date.now() - started).toBeLessThan(20_000);
  }, 30_000);

  it("hands the caller FFmpeg's own account of why", async () => {
    const { error } = await runFixture(
      { steps: 2, stderrMode: "source-eio" },
      {
        logPath,
        watchdog: { hardStallMs: 600, terminationGraceMs: 300 },
      },
    );
    const aborted = error as EncoderAbortedError;
    const evidence = readSourceIoEvidence(aborted.stderrTail);
    expect(evidence.sourceRead).toBe(true);
    expect(evidence.outputWrite).toBe(false);
    expect(evidence.byteOffset).toBe(10_074_169_063);
  }, 30_000);

  it("keeps an output failure an output failure", async () => {
    const { error } = await runFixture(
      { steps: 2, stderrMode: "output-eio" },
      {
        logPath,
        watchdog: { hardStallMs: 600, terminationGraceMs: 300 },
      },
    );
    const aborted = error as EncoderAbortedError;
    const evidence = readSourceIoEvidence(aborted.stderrTail);
    expect(evidence.outputWrite).toBe(true);
    expect(evidence.sourceRead).toBe(false);
  }, 30_000);

  it("is not talked out of it by progress=end", async () => {
    /*
     * The subtlest form of the failure: the timeline is frozen and the
     * reporting pipe cheerfully says the run has finished. Believing it would
     * hand a two-minute epoch to the duration validator as a completed one.
     */
    const { error } = await runFixture(
      { steps: 2, emitEnd: true },
      {
        logPath,
        watchdog: { hardStallMs: 600, terminationGraceMs: 300 },
      },
    );
    expect(error).toBeInstanceOf(EncoderAbortedError);
    expect((error as EncoderAbortedError).reason).toBe("media-watchdog");
  }, 30_000);
});

describe("an encoder that is still working", () => {
  it("is left alone however slowly it goes", async () => {
    /*
     * Slower than the threshold in wall time, but the timeline never stops.
     * A watchdog that could not tell these apart would be worse than none.
     */
    const controller = new AbortController();
    const runPromise = runFixture(
      { steps: 2, keepMoving: true },
      {
        logPath,
        signal: controller.signal,
        watchdog: { hardStallMs: 600, terminationGraceMs: 300 },
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 1_800));
    controller.abort();
    const { error, samples } = await runPromise;

    // Ended by the caller, not by the watchdog.
    expect((error as EncoderAbortedError).reason).toBe("caller");
    expect(samples.length).toBeGreaterThan(10);
    expect(samples.at(-1)!).toBeGreaterThan(samples[0]!);
  }, 30_000);

  it("is left alone while only its frame count moves", async () => {
    /*
     * Dune 2 and How to Train Your Dragon 3, 2026-11-09: each epoch also copies
     * the source's subtitles, and FFmpeg's out_time is the least advanced
     * stream, so it read N/A until the first spoken line while the video
     * encoded at 58 fps. Thirty seconds of that was called a wedged encoder.
     */
    const controller = new AbortController();
    const runPromise = runFixture(
      { steps: 2, keepMoving: true, outTimeHeld: true },
      {
        logPath,
        signal: controller.signal,
        watchdog: { hardStallMs: 600, terminationGraceMs: 300 },
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 1_800));
    controller.abort();
    const { error, samples } = await runPromise;

    expect((error as EncoderAbortedError).reason).toBe("caller");
    expect(samples.length).toBeGreaterThan(10);
    expect(samples.every((seconds) => seconds === 0)).toBe(true);
  }, 30_000);

  it("survives a freeze shorter than the threshold", async () => {
    /*
     * The transient case: media time stops for a moment and comes back. The
     * page may say "waiting for source data" and then stop saying it; nothing
     * is killed and nothing is salvaged.
     */
    const stalls: number[] = [];
    const controller = new AbortController();
    const runPromise = runFixture(
      { steps: 2, keepMoving: true },
      {
        logPath,
        signal: controller.signal,
        watchdog: {
          hardStallMs: 5_000,
          terminationGraceMs: 300,
          onStall: (detail) => stalls.push(detail.stalledForMs),
        },
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    controller.abort();
    const { error } = await runPromise;
    expect(stalls).toEqual([]);
    expect((error as EncoderAbortedError).reason).toBe("caller");
  }, 30_000);

  it("is given room to seek before it has produced anything", async () => {
    /*
     * An accurate `-ss` decodes forward from the preceding keyframe and reports
     * nothing until the first frame it keeps, so silence at the start of an
     * epoch is normal and can legitimately last a long time on a large source.
     * The running threshold must not apply to it.
     */
    const stalls: number[] = [];
    const controller = new AbortController();
    const runPromise = runFixture(
      { steps: 0 },
      {
        logPath,
        signal: controller.signal,
        watchdog: {
          hardStallMs: 300,
          startupStallMs: 60_000,
          terminationGraceMs: 300,
          onStall: (detail) => stalls.push(detail.stalledForMs),
        },
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(stalls).toEqual([]);
    controller.abort();
    await runPromise;
  }, 30_000);

  it("does not call a paused encoder a stalled one", async () => {
    /*
     * A suspended process produces nothing because it was told to. Killing it
     * would turn a pause — which exists precisely to keep the work — into a
     * lost epoch.
     */
    const pauseController = createPauseController();
    const stalls: number[] = [];
    const controller = new AbortController();
    const runPromise = runFixture(
      { steps: 2, keepMoving: true },
      {
        logPath,
        signal: controller.signal,
        pauseController,
        watchdog: {
          hardStallMs: 500,
          terminationGraceMs: 300,
          onStall: (detail) => stalls.push(detail.stalledForMs),
        },
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    // Awaited, because the suspension is now something the operating system
    // acknowledges rather than a boolean this process flips. The watchdog is
    // only allowed to stand down once it has.
    await pauseController.pause();
    expect(pauseController.paused).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(stalls).toEqual([]);
    await pauseController.resume();
    await new Promise((resolve) => setTimeout(resolve, 200));
    controller.abort();
    await runPromise;
  }, 30_000);

  it("keeps watching an encoder whose pause has only been asked for", async () => {
    /*
     * The other half of the same rule, and the one that matters on a bad drive.
     *
     * A pause request is not a pause. Until the operating system has confirmed
     * the suspension the encoder is an ordinary running process — it can wedge
     * on an unreadable sector exactly as it always could — and standing the
     * watchdog down on the strength of the request alone would be the old bug
     * with a new name: nothing suspended, nothing watching, and a label on a
     * web page saying it was fine.
     */
    const pauseController = createPauseController();
    /*
     * A suspension that never lands. Bound first, so the serialised transition
     * queue never reaches the real child behind it — which is exactly what a
     * genuine helper process taking its time looks like from here.
     */
    pauseController.bind({
      describe: "The encoder could not be suspended:",
      apply: () => new Promise(() => {}),
    });

    void pauseController.pause();
    expect(pauseController.pauseRequested).toBe(true);
    expect(pauseController.paused).toBe(false);

    const stalls: number[] = [];
    const { error } = await runFixture(
      { steps: 2, keepMoving: false },
      {
        logPath,
        pauseController,
        watchdog: {
          hardStallMs: 500,
          terminationGraceMs: 300,
          onStall: (detail) => stalls.push(detail.stalledForMs),
        },
      },
    );

    expect(pauseController.paused).toBe(false);
    expect(stalls).toHaveLength(1);
    expect((error as EncoderAbortedError).reason).toBe("media-watchdog");
  }, 30_000);

  it("still reports an ordinary success", async () => {
    const { error } = await runFixture(
      { steps: 2, keepMoving: false, emitEnd: false },
      {
        logPath,
        watchdog: { hardStallMs: 600, terminationGraceMs: 300 },
      },
    );
    // The fixture hangs, so this is the watchdog; a process that exits cleanly
    // is covered by the runner's own suite. What matters here is that the error
    // says which of the two happened.
    expect((error as EncoderAbortedError).reason).toBe("media-watchdog");
  }, 30_000);
});

describe("a cancellation during a stall", () => {
  it("is reported as a cancellation, never as source trouble", async () => {
    const controller = new AbortController();
    const runPromise = runFixture(
      { steps: 1, stderrMode: "source-eio" },
      {
        logPath,
        signal: controller.signal,
        watchdog: { hardStallMs: 60_000, terminationGraceMs: 300 },
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 400));
    controller.abort();
    const { error } = await runPromise;
    /*
     * A person pressing Cancel is never a damaged disk, even when the log
     * happens to contain an input error. Silently converting one into the other
     * would replace five minutes of a film because somebody stopped a job.
     */
    expect((error as EncoderAbortedError).reason).toBe("caller");
    expect((error as Error).message).toBe("FFmpeg was cancelled.");
  }, 30_000);
});
