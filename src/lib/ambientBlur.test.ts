import { describe, expect, it } from "vitest";
import {
  blurPixels,
  boxRadii,
  canvasSigma,
  saturatePixels,
} from "./ambientBlur";

function solid(width: number, height: number, rgba: number[]) {
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < pixels.length; i += 4) pixels.set(rgba, i);
  return pixels;
}

describe("the baked ambient light", () => {
  it("turns a CSS blur into canvas px by the field's drawn width", () => {
    // 64 px of blur over a 1000 px wide field, baked 80 px wide.
    expect(
      canvasSigma({ blurPx: 64, saturation: 1, drawnWidth: 1000 }, 80),
    ).toBeCloseTo(5.12);
  });

  it("splits a deviation into three box passes of the same spread", () => {
    for (const sigma of [2, 5.12, 9]) {
      const radii = boxRadii(sigma);
      expect(radii).toHaveLength(3);
      // A box of radius r has variance r(r+1)/3; three passes add up.
      const variance = radii.reduce((sum, r) => sum + (r * (r + 1)) / 3, 0);
      expect(Math.sqrt(variance)).toBeGreaterThan(sigma * 0.8);
      expect(Math.sqrt(variance)).toBeLessThan(sigma * 1.2);
    }
    expect(boxRadii(0)).toEqual([0, 0, 0]);
  });

  it("leaves a flat colour flat, edges included", () => {
    const pixels = solid(12, 18, [200, 40, 10, 255]);
    blurPixels(pixels, 12, 18, 4);
    for (let i = 0; i < pixels.length; i += 4) {
      expect([...pixels.slice(i, i + 4)]).toEqual([200, 40, 10, 255]);
    }
  });

  it("spreads a bright point and keeps its light", () => {
    const width = 41;
    const pixels = solid(width, width, [0, 0, 0, 255]);
    const centre = (20 * width + 20) * 4;
    pixels[centre] = 255;
    blurPixels(pixels, width, width, 3);
    let total = 0;
    for (let i = 0; i < pixels.length; i += 4) total += pixels[i];
    expect(pixels[centre]).toBeLessThan(40);
    expect(pixels[centre + 4]).toBeGreaterThan(0);
    // Rounding to bytes loses a little; the light is not invented or lost.
    expect(total).toBeGreaterThan(200);
    expect(total).toBeLessThan(310);
  });

  it("saturates as CSS saturate() does: greys stay grey, colour grows", () => {
    const grey = new Uint8ClampedArray([128, 128, 128, 255]);
    saturatePixels(grey, 1.5);
    expect([...grey]).toEqual([128, 128, 128, 255]);

    const warm = new Uint8ClampedArray([200, 120, 80, 255]);
    saturatePixels(warm, 1.5);
    // The filter-effects matrix, by hand, for (200, 120, 80) at 1.5:
    // 1.3935r - 0.3575g - 0.036b, and so on.
    expect([...warm.slice(0, 3)]).toEqual([233, 113, 53]);
    expect(warm[3]).toBe(255);
  });
});
