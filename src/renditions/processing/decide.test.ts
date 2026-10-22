import { describe, expect, it } from "vitest";
import type { HardwareReport } from "../hardware/detect";
import type { RenditionMediaProbe } from "../probe";
import { decideProcessing, DEFAULT_RESERVE_BYTES } from "./decide";

function hardware(overrides: Partial<HardwareReport> = {}): HardwareReport {
  return {
    platform: "darwin",
    ffmpegPath: "ffmpeg",
    probedAt: "2026-01-01T00:00:00.000Z",
    adapters: [],
    selected: {
      h264: "h264_videotoolbox",
      hevc: "hevc_videotoolbox",
      hevcTenBit: "hevc_videotoolbox",
    },
    selectedAdapter: {
      h264: "videotoolbox",
      hevc: "videotoolbox",
      hevcTenBit: "videotoolbox",
    },
    ...overrides,
  };
}

function probe(
  overrides: Partial<RenditionMediaProbe> = {},
): RenditionMediaProbe {
  return {
    durationSeconds: 300,
    video: {
      streamIndex: 0,
      codec: "h264",
      width: 3840,
      height: 1604,
      rotation: 0,
      frameRate: 23.976,
      bitDepth: 10,
      isHdr: true,
    },
    audioTracks: [
      {
        streamIndex: 1,
        codec: "aac",
        channels: 8,
        language: "eng",
        isDefault: true,
        isCommentary: false,
        isVisualImpaired: false,
        isOriginal: false,
      },
    ],
    subtitleTracks: [],
    chapters: [],
    ...overrides,
  };
}

type DecideInput = Parameters<typeof decideProcessing>[0];

const input = (overrides: Partial<DecideInput> = {}) =>
  decideProcessing({
    probe: probe(),
    container: "mp4",
    sizeBytes: 477_590_241,
    hardware: hardware(),
    ...overrides,
  });

describe("decideProcessing", () => {
  it("credits existing scratch without spending the reserve", () => {
    const fresh = input().estimate;
    const required =
      fresh.outputBytes + fresh.stagingBytes + fresh.reserveBytes;
    expect(
      input({ freeBytes: required - 1024, inheritedBytes: 1024 }).estimate
        .sufficient,
    ).toBe(true);
    expect(
      input({ freeBytes: required - 1025, inheritedBytes: 1024 }).estimate
        .sufficient,
    ).toBe(false);
    expect(
      input({ freeBytes: fresh.reserveBytes - 1, inheritedBytes: required * 2 })
        .estimate.sufficient,
    ).toBe(false);
    expect(
      input({ freeBytes: required - 1, inheritedBytes: Number.NaN }).estimate
        .sufficient,
    ).toBe(false);
  });

  /**
   * The summary describes the work, not the destination.
   *
   * A one-rung job announced itself as "Package 2160p, 1440p, 1080p, 720p,
   * 480p, 360p, 240p, 144p", which reads as a full rebuild — exactly what the
   * incremental path exists to avoid.
   */
  it("says what an incremental run will actually encode", () => {
    const decision = input({
      renditionsToEncode: [1440],
      audioTracksToEncode: 0,
    });

    expect(decision.summary).toContain("1440p");
    expect(decision.summary).toMatch(/existing package|reusing/i);
    // It must not read as though every rung is being made again.
    expect(decision.summary).not.toContain("2160p");
    expect(decision.summary).not.toContain("720p");
    // The full ladder is still available to anything that wants it.
    expect(decision.ladder.length).toBeGreaterThan(1);
    expect(decision.renditionsToEncode).toEqual([1440]);
  });

  /** A genuine full build still describes the whole package. */
  it("still describes the whole ladder when everything is being built", () => {
    const decision = input();
    expect(decision.summary).toContain("Package");
    expect(decision.summary).toContain("audio");
  });

  /**
   * Sizing the job, not the finished package.
   *
   * A one-rung run reported the whole package's bytes as its own output — the
   * page showed 35.7 GiB at 3% — and reserved disk for seven renditions it was
   * never going to write.
   */
  it("estimates only the renditions this run will encode", () => {
    const whole = input();
    const oneRung = input({
      renditionsToEncode: [1440],
      audioTracksToEncode: 0,
    });

    expect(oneRung.estimate.outputBytes).toBeLessThan(
      whole.estimate.outputBytes,
    );
    // The ladder still describes the finished package.
    expect(oneRung.ladder.length).toBe(whole.ladder.length);
    // And the staging reservation shrinks with it.
    expect(oneRung.estimate.stagingBytes).toBeLessThan(
      whole.estimate.stagingBytes,
    );
  });

  it("plans the full ladder for a 4K source", () => {
    const decision = input();

    expect(decision.action).toBe("package-adaptive");
    expect(decision.ladder.map((rung) => rung.qualityHeight)).toEqual([
      2160, 1440, 1080, 720, 480, 360, 240, 144,
    ]);
  });

  /** Upscaling costs an encode and gains nothing, so a rung above the source is never planned. */
  it("never plans a rung larger than the source", () => {
    const decision = input({
      probe: probe({
        video: {
          ...probe().video,
          width: 1280,
          height: 534,
          bitDepth: 8,
          isHdr: false,
        },
      }),
    });

    expect(decision.ladder.map((rung) => rung.qualityHeight)).toEqual([
      720, 480, 360, 240, 144,
    ]);
  });

  /**
   * A small source is still worth packaging: it gets its own class and the
   * rungs below it, which is the copy that lets the original file be removed.
   */
  it("packages a small source down from its own class", () => {
    const decision = input({
      probe: probe({
        video: {
          ...probe().video,
          width: 640,
          height: 360,
          bitDepth: 8,
          isHdr: false,
        },
      }),
    });

    expect(decision.action).toBe("package-adaptive");
    expect(decision.ladder.map((rung) => rung.qualityHeight)).toEqual([
      360, 240, 144,
    ]);
  });

  it("rejects a source whose frame has no usable dimensions", () => {
    const decision = input({
      probe: probe({
        video: { ...probe().video, width: 0, height: 0 },
      }),
    });

    expect(decision.action).toBe("reject-no-video");
  });

  it("carries HDR through the 10-bit HEVC lane", () => {
    const decision = input();

    expect(decision.videoCodec).toBe("hevc");
    expect(decision.preservesHdr).toBe(true);
    expect(decision.videoEncoder).toBe("hevc_videotoolbox");
  });

  it("uses H.264 for an SDR source", () => {
    const decision = input({
      probe: probe({
        video: { ...probe().video, bitDepth: 8, isHdr: false },
      }),
    });

    expect(decision.videoCodec).toBe("h264");
    expect(decision.preservesHdr).toBe(false);
    expect(decision.videoEncoder).toBe("h264_videotoolbox");
  });

  it("falls back to software when no accelerator probed successfully", () => {
    const decision = input({
      hardware: hardware({
        selected: { h264: "libx264", hevc: "libx265", hevcTenBit: "libx265" },
        selectedAdapter: {
          h264: "software",
          hevc: "software",
          hevcTenBit: "software",
        },
      }),
    });

    expect(decision.videoEncoder).toBe("libx265");
    expect(decision.hardwareAdapter).toBe("software");
  });

  it("keeps the same peak headroom as the checkpoint packager", () => {
    const bytes = input().estimate.outputBytes;
    const required = Math.ceil(bytes * 1.15 * 2) + DEFAULT_RESERVE_BYTES;
    expect(input({ freeBytes: required - 1 }).estimate.sufficient).toBe(false);
    expect(input({ freeBytes: required }).estimate.sufficient).toBe(true);
  });

  it("reports the disk impact of the package and its staging copy", () => {
    const decision = input({ freeBytes: 900_000_000_000 });

    expect(decision.estimate.outputBytes).toBeGreaterThan(0);
    expect(decision.estimate.stagingBytes).toBeGreaterThan(
      decision.estimate.outputBytes,
    );
    expect(decision.estimate.sufficient).toBe(true);
    expect(decision.estimate.reserveBytes).toBe(DEFAULT_RESERVE_BYTES);
  });

  /**
   * Running out of room halfway through leaves a staging directory that has to
   * be cleaned up by hand, so the shortfall is detected before any encoding.
   */
  it("refuses when the volume cannot hold the package and its staging copy", () => {
    const decision = input({ freeBytes: 1_000_000 });

    expect(decision.estimate.sufficient).toBe(false);
    expect(decision.warnings.join(" ")).toContain("room");
  });

  it("skips a source whose package is already current", () => {
    const decision = input({ alreadyCurrent: true });

    expect(decision.action).toBe("skip-already-current");
  });

  it("summarises the plan in a sentence naming the rungs and tracks", () => {
    const decision = input();

    expect(decision.summary).toContain("1080p, 720p, 480p");
    expect(decision.summary).toContain("HEVC HDR");
    expect(decision.summary).toContain("1 audio rendition");
  });
});
