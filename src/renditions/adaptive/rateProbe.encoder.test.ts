import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The probe's FFmpeg side, with FFmpeg replaced: which rungs are encoded,
 * which stream each score reads, and that every encode happens while the
 * encoder is held and no score does.
 */

const calls: Array<{
  describe: string;
  args: readonly string[];
  held: boolean;
}> = [];
let held = false;

vi.mock("../processExecution", () => ({
  runBoundedProcess: async ({
    args,
    describe,
  }: {
    args: readonly string[];
    describe: string;
  }) => {
    if (describe === "ffmpeg -filters") {
      return {
        stdout: " ... libvmaf  VV->V  Calculate the VMAF\n",
        stderr: "",
      };
    }
    calls.push({ describe, args, held });
    if (describe === "rate probe measurement") {
      const graph = args[args.indexOf("-lavfi") + 1]!;
      const logPath = /log_path='([^']+)'/
        .exec(graph)![1]!
        .replace(/\\:/g, ":");
      const factor = Number(/-f([\d.]+)-w/.exec(logPath)![1]);
      const score = factor >= 0.7 ? 97 : 90;
      await writeFile(
        logPath,
        JSON.stringify({
          frames: Array.from({ length: 20 }, () => ({
            metrics: { vmaf: score },
          })),
        }),
      );
    }
    return { stdout: "", stderr: "" };
  },
}));

const { probeTitleRates, RATE_PROBE_FACTORS } = await import("./rateProbe");

describe("probeTitleRates", () => {
  let root: string;
  beforeEach(async () => {
    calls.length = 0;
    held = false;
    root = await mkdtemp(path.join(tmpdir(), "rate-probe-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("encodes only the scored rungs, all inside one hold of the encoder", async () => {
    let holds = 0;
    const result = await probeTitleRates({
      ffmpegPath: "ffmpeg-with-vmaf",
      sourcePath: path.join(root, "source.mkv"),
      durationSeconds: 1_400,
      // Smallest first, so a rung's place in the ladder and its stream in a
      // sample file differ.
      outputs: [
        { qualityHeight: 480, width: 854, height: 480 },
        { qualityHeight: 720, width: 1280, height: 720 },
      ],
      encoder: "h264_nvenc",
      codecFamily: "h264",
      preset: "p5",
      segmentSeconds: 2,
      checkpointRoot: root,
      holdEncoder: async (work) => {
        holds += 1;
        held = true;
        try {
          return await work();
        } finally {
          held = false;
        }
      },
    });

    expect(holds).toBe(1);
    const encodes = calls.filter(
      (call) => call.describe === "rate probe encode",
    );
    expect(encodes).toHaveLength(RATE_PROBE_FACTORS.length * 5);
    for (const encode of encodes) {
      expect(encode.held).toBe(true);
      expect(encode.args.filter((arg) => arg === "-map")).toHaveLength(1);
    }
    const measurements = calls.filter(
      (call) => call.describe === "rate probe measurement",
    );
    expect(measurements.length).toBeGreaterThan(0);
    for (const measurement of measurements) {
      expect(measurement.held).toBe(false);
      expect(measurement.args[measurement.args.indexOf("-lavfi") + 1]).toMatch(
        /^\[0:v:0\]/,
      );
    }
    expect(result?.rates[720]?.factor).toBe(0.7);
  });
});
