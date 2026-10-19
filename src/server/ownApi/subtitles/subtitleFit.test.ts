// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  createSubtitleFitter,
  fitNeedsRetiming,
  retimeToFit,
} from "./subtitleFit";

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
  it("aligns against a subtitle that was inside the video when there is no audio", async () => {
    const fitter = createSubtitleFitter({
      ffmpegPath: "ffmpeg",
      audio: null,
      subtitles: [srt(400)],
    });
    const fit = await fitter.measure(bytes(srt(400, 4)));
    expect(fit?.trusted).toBe(true);
    expect(fit!.proposal.offsetSeconds).toBeCloseTo(-4, 1);
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
