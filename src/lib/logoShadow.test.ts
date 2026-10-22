import { describe, expect, it } from "vitest";
import { contrastRatio, logoShadowFor, relativeLuminance } from "./logoShadow";

describe("logo shadow", () => {
  it("measures luminance and contrast the WCAG way", () => {
    expect(relativeLuminance(255, 255, 255)).toBeCloseTo(1, 5);
    expect(relativeLuminance(0, 0, 0)).toBe(0);
    expect(contrastRatio(1, 0)).toBeCloseTo(21, 5);
  });

  it("never chooses a light glow, even behind a logo darker than its artwork", () => {
    expect(logoShadowFor(0.05, 0.6)).not.toHaveProperty("tone");
    expect(logoShadowFor(0.8, 0.3)).not.toHaveProperty("tone");
  });

  it("is strongest where the logo and the artwork are closest", () => {
    const close = logoShadowFor(0.5, 0.45).strength;
    const apart = logoShadowFor(0.9, 0.02).strength;
    expect(close).toBe(1);
    expect(apart).toBeLessThan(close);
    expect(apart).toBeGreaterThanOrEqual(0.25);
  });
});
