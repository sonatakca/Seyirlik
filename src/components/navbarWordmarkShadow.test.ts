import { describe, expect, it } from "vitest";
import {
  WORDMARK_FRAME_HEIGHT,
  WORDMARK_FRAME_WIDTH,
  getWordmarkShadowFrameStyle,
  getWordmarkShadowPad,
  wordmarkShadowStrength,
} from "./navbarWordmarkShadow";
import { relativeLuminance } from "../lib/logoShadow";

const percent = (value: string) => Number.parseFloat(value) / 100;

describe("navbar wordmark shadow frames", () => {
  it("pads furthest below, where both shadows fall", () => {
    const pad = getWordmarkShadowPad();

    expect(pad.left).toBe(pad.right);
    expect(pad.bottom).toBeGreaterThan(pad.left);
    expect(pad.top).toBeLessThan(pad.left);
    expect(pad.top).toBeGreaterThan(0);
  });

  it("lands the letters exactly on the wordmark's box", () => {
    const pad = getWordmarkShadowPad();
    const style = getWordmarkShadowFrameStyle();
    const left = percent(style.left);
    const top = percent(style.top);
    const width = percent(style.width);
    const height = percent(style.height);
    const bakedWidth = WORDMARK_FRAME_WIDTH + pad.left + pad.right;
    const bakedHeight = WORDMARK_FRAME_HEIGHT + pad.top + pad.bottom;

    // Where the plain frame's corners fall, as fractions of the box.
    expect(left + (width * pad.left) / bakedWidth).toBeCloseTo(0, 5);
    expect(top + (height * pad.top) / bakedHeight).toBeCloseTo(0, 5);
    expect(
      left + (width * (pad.left + WORDMARK_FRAME_WIDTH)) / bakedWidth,
    ).toBeCloseTo(1, 5);
    expect(
      top + (height * (pad.top + WORDMARK_FRAME_HEIGHT)) / bakedHeight,
    ).toBeCloseTo(1, 5);
  });
});

describe("how much shadow the wordmark needs", () => {
  const teal = relativeLuminance(0x33, 0x7b, 0x6c);
  const gold = relativeLuminance(0xd3, 0xca, 0x22);
  const sky = relativeLuminance(222, 230, 238);
  const night = relativeLuminance(20, 24, 30);

  it("drops it for dark letters on a bright sky", () => {
    expect(wordmarkShadowStrength(teal, [sky, sky, sky])).toBe(0);
  });

  it("keeps all of it for light letters on the same sky", () => {
    expect(wordmarkShadowStrength(gold, [sky, sky])).toBe(1);
  });

  it("keeps all of it over anything as dark as the letters", () => {
    expect(wordmarkShadowStrength(teal, [night, night])).toBe(1);
    expect(wordmarkShadowStrength(gold, [night])).toBe(1);
  });

  it("gives a mixed backdrop a share", () => {
    expect(wordmarkShadowStrength(teal, [sky, night])).toBe(0.5);
  });

  it("keeps all of it when nothing was measured", () => {
    expect(wordmarkShadowStrength(teal, [])).toBe(1);
  });
});
