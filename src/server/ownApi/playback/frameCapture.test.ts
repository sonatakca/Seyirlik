import { describe, expect, it } from "vitest";
import { buildFrameCaptureArgs, isHdrTransfer } from "./frameCapture";

function filterOf(args: string[]): string {
  return args[args.indexOf("-vf") + 1];
}

describe("frame capture", () => {
  it("seeks the input, then writes exactly one frame of the real video stream", () => {
    const args = buildFrameCaptureArgs("/media/Film.mkv", 4 * 60 + 44.5, {
      toneMap: false,
    });

    expect(args.indexOf("-ss")).toBeLessThan(args.indexOf("-i"));
    // Half a second early: the decode has to pass the frame on screen.
    expect(args[args.indexOf("-ss") + 1]).toBe("284.000");
    expect(args[args.indexOf("-map") + 1]).toBe("0:V:0");
    expect(args[args.indexOf("-frames:v") + 1]).toBe("1");
    expect(args.slice(-5)).toEqual([
      "-c:v",
      "png",
      "-f",
      "image2pipe",
      "pipe:1",
    ]);
  });

  it("tone-maps only an HDR source", () => {
    const sdr = filterOf(
      buildFrameCaptureArgs("/media/Film.mkv", 1, { toneMap: false }),
    );
    const hdr = filterOf(
      buildFrameCaptureArgs("/media/Film.mkv", 1, { toneMap: true }),
    );

    expect(sdr).not.toContain("tonemap");
    // YUV-to-RGB options on any filter but `scale` make FFmpeg refuse the run.
    expect(sdr.split(",")[2]).toMatch(/^scale=.*:in_color_matrix=auto/);
    expect(sdr.split(",")[3]).toBe("setsar=1");
    expect(hdr).toContain("tonemap=tonemap=mobius");
    // Both leave square pixels and an 8-bit RGB PNG.
    for (const filter of [sdr, hdr]) {
      expect(filter).toContain("setsar=1");
      expect(filter.endsWith("format=rgb24")).toBe(true);
    }
  });

  it("keeps the frames up to the paused time and converts only the last", () => {
    const filter = filterOf(
      buildFrameCaptureArgs("/media/Film.mkv", 2110.17, { toneMap: true }),
    );

    expect(filter.split(",").slice(0, 2)).toEqual([
      "trim=end=0.501000",
      "reverse",
    ]);
  });

  it("looks back only as far as the start of the film", () => {
    const args = buildFrameCaptureArgs("/media/Film.mkv", 0.2, {
      toneMap: false,
    });

    expect(args[args.indexOf("-ss") + 1]).toBe("0.000");
    expect(filterOf(args).split(",")[0]).toBe("trim=end=0.201000");
  });

  it("treats PQ and HLG as HDR and anything else as SDR", () => {
    expect(isHdrTransfer("smpte2084")).toBe(true);
    expect(isHdrTransfer("arib-std-b67")).toBe(true);
    expect(isHdrTransfer("bt709")).toBe(false);
    expect(isHdrTransfer(null)).toBe(false);
  });
});
