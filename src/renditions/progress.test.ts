import { describe, expect, it } from "vitest";
import {
  estimateRemainingSeconds,
  formatBytes,
  formatDuration,
  parseFfmpegProgressFields,
} from "./progress";

describe("rendition progress reporting", () => {
  it("reads elapsed media time from an FFmpeg progress block", () => {
    expect(
      parseFfmpegProgressFields({
        frame: "195922",
        fps: "96.4",
        total_size: "3575860224",
        out_time_us: "8171530000",
        out_time: "02:16:11.530000",
        speed: "4.01x",
        progress: "continue",
      }),
    ).toEqual({
      processedSeconds: 8171.53,
      frames: 195922,
      fps: 96.4,
      speed: 4.01,
      writtenBytes: 3575860224,
    });
  });

  it("keeps the frame count when a sparse stream leaves out_time N/A", () => {
    const parsed = parseFfmpegProgressFields({
      frame: "1847",
      fps: "57.74",
      out_time_us: "N/A",
      out_time: "N/A",
      speed: "N/A",
      progress: "continue",
    });
    expect(parsed.processedSeconds).toBe(0);
    expect(parsed.frames).toBe(1847);
    expect(parsed.speed).toBeUndefined();
  });

  it("falls back to the microsecond field when out_time is absent", () => {
    expect(
      parseFfmpegProgressFields({
        out_time_ms: "90000000",
        progress: "continue",
      }).processedSeconds,
    ).toBe(90);
  });

  it("ignores unusable throughput values rather than reporting zeroes", () => {
    const parsed = parseFfmpegProgressFields({
      out_time: "00:00:10.000000",
      fps: "0.00",
      speed: "N/A",
      total_size: "N/A",
      progress: "continue",
    });

    expect(parsed).toEqual({ processedSeconds: 10 });
  });

  it("derives remaining wall time from FFmpeg's own speed multiplier", () => {
    // 100s of media left at 4x throughput is 25s of real time.
    expect(estimateRemainingSeconds(50, 150, 4)).toBe(25);
    expect(estimateRemainingSeconds(50, 150, undefined)).toBeUndefined();
    expect(estimateRemainingSeconds(200, 150, 4)).toBe(0);
  });

  it("formats durations and sizes for a terminal", () => {
    expect(formatDuration(8171)).toBe("2:16:11");
    expect(formatDuration(75)).toBe("01:15");
    expect(formatDuration(-1)).toBe("--:--");
    expect(formatBytes(3_575_860_224)).toBe("3.33 GiB");
    expect(formatBytes(1_648_623)).toBe("1.6 MiB");
  });
});
