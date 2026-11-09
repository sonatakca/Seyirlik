import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EpochPlan } from "./plan";
import {
  alignmentShiftSeconds,
  EPOCH_SOURCE_COPY_FILE,
  parseFrameMd5,
  prepareSourceCopyInput,
  sourceCopyImplicated,
  sourceCopyOutputArgs,
  sourceCopyWindow,
  sourceSupportsStreamCopy,
  subtitleCodecCopies,
  type EpochSourceCopyRecord,
} from "./sourceCopy";

function planWithSeeks(seeks: number[]): EpochPlan {
  return {
    epochs: seeks.map((seekSeconds, index) => ({
      index,
      seekSeconds,
    })),
  } as unknown as EpochPlan;
}

describe("sourceCopyWindow", () => {
  it("gives adjacent epochs the same boundary to the microsecond", () => {
    // 0.1 + 0.2 style values must not leave a one-microsecond seam.
    const plan = planWithSeeks([0, 299.9895, 600.0104999, 900.3]);
    const windows = plan.epochs.map((_, index) =>
      sourceCopyWindow(plan, index),
    );
    expect(windows[0]).toEqual({ startMicros: 0, endMicros: 299_989_500 });
    for (let index = 1; index < windows.length; index += 1) {
      expect(windows[index]!.startMicros).toBe(windows[index - 1]!.endMicros);
    }
    expect(windows.at(-1)!.endMicros).toBeNull();
  });
});

describe("sourceCopyOutputArgs", () => {
  it("drops packets before the seek, stops at the next seek, and keeps source time", () => {
    const args = sourceCopyOutputArgs({
      epochDirectory: path.join("work", "epoch"),
      streams: [
        { index: 1, kind: "audio" },
        { index: 3, kind: "subtitle" },
      ],
      window: { startMicros: 299_989_500, endMicros: 600_010_500 },
    });
    expect(args).toEqual([
      "-map",
      "0:1",
      "-map",
      "0:3",
      "-c",
      "copy",
      "-copypriorss",
      "0",
      "-t",
      "300.021000",
      "-output_ts_offset",
      "299.989500",
      "-f",
      "matroska",
      `work/epoch/${EPOCH_SOURCE_COPY_FILE}`,
    ]);
    // `-sn` would silently drop the mapped subtitle stream.
    expect(args).not.toContain("-sn");
  });

  it("leaves the first epoch's start and the last epoch's end open", () => {
    const first = sourceCopyOutputArgs({
      epochDirectory: "e",
      streams: [{ index: 1, kind: "audio" }],
      window: { startMicros: 0, endMicros: 30_000_000 },
    });
    expect(first).not.toContain("-output_ts_offset");
    expect(first).toContain("-t");
    // Nothing precedes the very start, and FFmpeg 8 would drop AAC priming.
    expect(first).not.toContain("-copypriorss");
    const last = sourceCopyOutputArgs({
      epochDirectory: "e",
      streams: [{ index: 1, kind: "audio" }],
      window: { startMicros: 30_000_000, endMicros: null },
    });
    expect(last).not.toContain("-t");
    expect(last).toContain("-output_ts_offset");
  });
});

describe("sourceCopyImplicated", () => {
  it("recognises FFmpeg blaming the copy output, and nothing else", () => {
    // FFmpeg 7.1's own words for a subtitle codec Matroska cannot hold.
    expect(
      sourceCopyImplicated(
        "[matroska @ 0x7a78c57700] Subtitle codec 94213 is not supported.",
      ),
    ).toBe(true);
    expect(
      sourceCopyImplicated(
        "[out#1/matroska @ 0x7a78d84900] Could not write header (incorrect codec parameters ?)",
      ),
    ).toBe(true);
    expect(sourceCopyImplicated("[aost#1:0/copy @ 0x1] Error submitting")).toBe(
      true,
    );
    // The ladder, the source's demuxer and the stream map are not the copy.
    expect(
      sourceCopyImplicated(
        "[vost#0:0/h264_nvenc @ 0x1] Error while opening encoder\n" +
          "[in#0/matroska,webm @ 0x2] Error during demuxing\n" +
          "  Stream #0:1 -> #1:0 (copy)\nOutput #1, matroska, to 'x.mka':",
      ),
    ).toBe(false);
    expect(sourceCopyImplicated("FFmpeg failed with exit code 1: killed")).toBe(
      false,
    );
  });
});

describe("what is copied", () => {
  it("copies only from containers and subtitle codecs Matroska takes as they are", () => {
    expect(sourceSupportsStreamCopy("/m/Film (2006).MKV")).toBe(true);
    expect(sourceSupportsStreamCopy("/m/film.mp4")).toBe(true);
    expect(sourceSupportsStreamCopy("/m/film.avi")).toBe(false);
    expect(sourceSupportsStreamCopy("/m/film.m2ts")).toBe(false);
    expect(subtitleCodecCopies("subrip")).toBe(true);
    expect(subtitleCodecCopies("ass")).toBe(true);
    expect(subtitleCodecCopies("mov_text")).toBe(false);
  });
});

describe("prepareSourceCopyInput", () => {
  let root = "";
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "seyirlik-copy-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const epochPath = (index: number) => path.join(root, `epoch-${index}`);
  const streams = [
    { index: 1, kind: "audio" as const },
    { index: 4, kind: "subtitle" as const },
  ];

  async function epochWithCopy(
    index: number,
    startSeconds: number,
    bytes = "copy",
  ): Promise<{ epochIndex: number; sourceCopy: EpochSourceCopyRecord }> {
    await mkdir(epochPath(index), { recursive: true });
    await writeFile(path.join(epochPath(index), EPOCH_SOURCE_COPY_FILE), bytes);
    return {
      epochIndex: index,
      sourceCopy: {
        path: EPOCH_SOURCE_COPY_FILE,
        streams,
        fileSizeBytes: bytes.length,
        startSeconds,
        windowStartSeconds: startSeconds,
        windowEndSeconds: null,
      },
    };
  }

  it("chains the copies by their measured starts and restores the first", async () => {
    const manifests = [
      await epochWithCopy(1, 30.004),
      await epochWithCopy(0, 0.479),
      await epochWithCopy(2, 60.01),
    ];
    const listPath = path.join(root, "list.ffconcat");
    const outcome = await prepareSourceCopyInput({
      manifests,
      epochCount: 3,
      epochPath,
      listPath,
    });
    if (!("input" in outcome)) throw new Error(outcome.unavailable);
    expect(outcome.input.inputOptions).toEqual([
      "-safe",
      "0",
      "-itsoffset",
      "0.479000",
    ]);
    expect([...outcome.input.positionOf]).toEqual([
      [1, 0],
      [4, 1],
    ]);
    const list = await readFile(listPath, "utf8");
    // No `inpoint`: seeking a Matroska file to a cue drops other tracks' packets.
    expect(list).not.toContain("inpoint");
    expect(
      list.split("\n").filter((line) => line.startsWith("duration")),
    ).toEqual(["duration 29.525000", "duration 30.006000"]);
    expect(list.indexOf("epoch-0")).toBeLessThan(list.indexOf("epoch-1"));
  });

  it("adds no offset when the first copy starts at zero", async () => {
    const outcome = await prepareSourceCopyInput({
      manifests: [await epochWithCopy(0, 0), await epochWithCopy(1, 30)],
      epochCount: 2,
      epochPath,
      listPath: path.join(root, "list.ffconcat"),
    });
    if (!("input" in outcome)) throw new Error(outcome.unavailable);
    expect(outcome.input.inputOptions).toEqual(["-safe", "0"]);
  });

  it("refuses unless every epoch has an intact copy of the same tracks", async () => {
    const listPath = path.join(root, "list.ffconcat");
    const zero = await epochWithCopy(0, 0);
    const one = await epochWithCopy(1, 30);

    expect(
      await prepareSourceCopyInput({
        manifests: [zero],
        epochCount: 2,
        epochPath,
        listPath,
      }),
    ).toEqual({ unavailable: "1 of 2 epochs have checkpoints" });

    expect(
      await prepareSourceCopyInput({
        manifests: [zero, { epochIndex: 1 }],
        epochCount: 2,
        epochPath,
        listPath,
      }),
    ).toEqual({ unavailable: "epoch 1 has no stream copy" });

    expect(
      await prepareSourceCopyInput({
        manifests: [
          zero,
          {
            ...one,
            sourceCopy: { ...one.sourceCopy, streams: [streams[0]!] },
          },
        ],
        epochCount: 2,
        epochPath,
        listPath,
      }),
    ).toEqual({ unavailable: "epoch 1 copied different tracks" });

    await writeFile(
      path.join(epochPath(1), EPOCH_SOURCE_COPY_FILE),
      "truncated or rewritten",
    );
    expect(
      await prepareSourceCopyInput({
        manifests: [zero, one],
        epochCount: 2,
        epochPath,
        listPath,
      }),
    ).toEqual({ unavailable: "epoch 1's stream copy is missing or changed" });
  });
});

describe("lining the copies up with the source", () => {
  const frameMd5 = (shiftMs: number, hashes = ["a", "b", "c", "d", "e", "f"]) =>
    [
      "#format: frame checksums",
      "#tb 0: 1/1000",
      "#tb 1: 1/48000",
      ...hashes.flatMap((hash, index) => [
        `0,${index * 21 + shiftMs},${index * 21 + shiftMs},21,375,${hash}`,
        `1,${(index * 32 + shiftMs) * 48},${(index * 32 + shiftMs) * 48},1536,600,${hash}x`,
      ]),
    ].join("\n");

  it("reads packet times in each stream's own time base", () => {
    const parsed = parseFrameMd5(frameMd5(0));
    expect(parsed.get(0)![1]).toEqual({ seconds: 0.021, hash: "b" });
    expect(parsed.get(1)![1]!.seconds).toBeCloseTo(0.032, 9);
  });

  it("finds one constant shift across every track", () => {
    const shift = alignmentShiftSeconds(
      parseFrameMd5(frameMd5(-21)),
      parseFrameMd5(frameMd5(0)),
      2,
    );
    expect(shift).toBeCloseTo(0.021, 9);
    expect(
      alignmentShiftSeconds(
        parseFrameMd5(frameMd5(0)),
        parseFrameMd5(frameMd5(0)),
        2,
      ),
    ).toBe(0);
  });

  it("refuses when the packets are not the same packets", () => {
    expect(
      alignmentShiftSeconds(
        parseFrameMd5(frameMd5(0)),
        parseFrameMd5(frameMd5(0, ["a", "b", "X", "d", "e", "f"])),
        2,
      ),
    ).toBeUndefined();
    // Too few packets to judge by.
    expect(
      alignmentShiftSeconds(
        parseFrameMd5(frameMd5(0, ["a", "b"])),
        parseFrameMd5(frameMd5(0, ["a", "b"])),
        2,
      ),
    ).toBeUndefined();
  });
});
