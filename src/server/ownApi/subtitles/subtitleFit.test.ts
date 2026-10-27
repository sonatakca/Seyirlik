// @vitest-environment node
import { rm } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  createSubtitleFitter,
  fitNeedsRetiming,
  retimeToFit,
} from "./subtitleFit";
import {
  ffmpegAvailable,
  writeSpacedAudioPackage,
} from "./packagedAudioTestFixture";

/** Dialogue with a rhythm, like the aligner's own tests use. */
function srt(count: number, offsetSeconds = 0): string {
  const stamp = (seconds: number) => {
    const total = Math.round(seconds * 1000);
    const ms = total % 1000;
    const whole = (total - ms) / 1000;
    return `${[
      Math.floor(whole / 3600),
      Math.floor((whole % 3600) / 60),
      whole % 60,
    ]
      .map((part) => String(part).padStart(2, "0"))
      .join(":")},${String(ms).padStart(3, "0")}`;
  };
  const blocks: string[] = [];
  let at = 30;
  for (let index = 0; index < count; index += 1) {
    const wobble = (index * Math.SQRT2) % 1;
    const duration = 1 + wobble * 2;
    blocks.push(
      `${index + 1}\n${stamp(at + offsetSeconds)} --> ${stamp(at + duration + offsetSeconds)}\nLine ${index + 1}.`,
    );
    at += duration + 2 + wobble * 3;
  }
  return `${blocks.join("\n\n")}\n`;
}
const bytes = (text: string) => new TextEncoder().encode(text);

describe("measuring a download against the title", () => {
  it("does not trust a candidate timed to another cut, and will not retime it", async () => {
    // Right for its first half, eight seconds late after that: one transform
    // cannot fit it, and the regions say so.
    const lateHalf = srt(400)
      .split("\n\n")
      .map((block, index) =>
        index < 200
          ? block
          : block.replace(
              /(\d\d):(\d\d):(\d\d),(\d\d\d)/g,
              (_m, h, m, sec, ms) => {
                const total =
                  Number(h) * 3600 +
                  Number(m) * 60 +
                  Number(sec) +
                  Number(ms) / 1000 +
                  8;
                const whole = Math.floor(total);
                return `${String(Math.floor(whole / 3600)).padStart(2, "0")}:${String(Math.floor((whole % 3600) / 60)).padStart(2, "0")}:${String(whole % 60).padStart(2, "0")},${String(Math.round((total - whole) * 1000)).padStart(3, "0")}`;
              },
            ),
      )
      .join("\n\n");
    const fitter = createSubtitleFitter({
      ffmpegPath: "ffmpeg",
      audio: null,
      subtitles: [srt(400)],
    });
    const fit = await fitter.measure(bytes(lateHalf));
    // Every line is accounted for by two regions, so it is correctable…
    expect(
      fit?.alignment.segments
        .filter((s) => s.status !== "inferred")
        .map((s) => s.status),
    ).toEqual(["aligned", "corrected"]);
    // …and retiming moves only the late half.
    const retimed = new TextDecoder().decode(
      retimeToFit(bytes(lateHalf), fit!),
    );
    expect(retimed.split("\n\n").slice(0, 200).join("\n\n")).toBe(
      srt(400).split("\n\n").slice(0, 200).join("\n\n"),
    );
  });

  it("aligns against a subtitle that was inside the video when there is no audio", async () => {
    const fitter = createSubtitleFitter({
      ffmpegPath: "ffmpeg",
      audio: null,
      subtitles: [srt(400)],
    });
    const fit = await fitter.measure(bytes(srt(400, 4)));
    expect(fit?.trusted).toBe(true);
    expect(fit!.offsetSeconds).toBeCloseTo(-4, 1);
    expect(fitNeedsRetiming(fit!)).toBe(true);
    expect(
      new TextDecoder().decode(retimeToFit(bytes(srt(400, 4)), fit!)),
    ).toContain("00:00:30,000 -->");
  });

  it("does not ask to move a subtitle that already fits", async () => {
    const fitter = createSubtitleFitter({
      ffmpegPath: "ffmpeg",
      audio: null,
      subtitles: [srt(400)],
    });
    const fit = await fitter.measure(bytes(srt(400)));
    expect(fit?.trusted).toBe(true);
    expect(fitNeedsRetiming(fit!)).toBe(false);
  });

  it("keeps the subtitle reference when the audio cannot be read", async () => {
    const fitter = createSubtitleFitter({
      ffmpegPath: "/nonexistent/ffmpeg",
      audio: { path: "/nonexistent/audio.m3u8", streamIndex: 0 },
      subtitles: [srt(400)],
    });
    expect((await fitter.measure(bytes(srt(400, 2))))?.trusted).toBe(true);
  });

  it("throws when nothing at all can be aligned against", async () => {
    const fitter = createSubtitleFitter({
      ffmpegPath: "/nonexistent/ffmpeg",
      audio: { path: "/nonexistent/audio.m3u8", streamIndex: 0 },
    });
    await expect(fitter.measure(bytes(srt(10)))).rejects.toThrow();
  });
});

describe.skipIf(!ffmpegAvailable)(
  "measuring against a packaged track whose name has a space in it",
  { timeout: 120_000 },
  () => {
    it("listens through the package playlist and finds the offset", async () => {
      const pkg = await writeSpacedAudioPackage(srt(120));
      try {
        const fitter = createSubtitleFitter({
          ffmpegPath: "ffmpeg",
          audio: {
            path: pkg.playlistPath,
            streamIndex: 0,
            isPackagePlaylist: true,
          },
        });
        const fit = await fitter.measure(bytes(srt(120, 4)));
        expect(fit?.trusted).toBe(true);
        expect(fit!.offsetSeconds).toBeCloseTo(-4, 0);
      } finally {
        await rm(pkg.root, { recursive: true, force: true });
      }
    });
  },
);
