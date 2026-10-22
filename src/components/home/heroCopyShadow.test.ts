import { describe, expect, it } from "vitest";
import { copyShadowFor } from "./heroCopyShadow";

describe("the hero copy's shadow", () => {
  it("is the lighter edge and cloud over bright art, the heavier cloud over dark", () => {
    const bright = copyShadowFor(1);
    const dark = copyShadowFor(0.25);
    expect(bright).not.toBe(dark);
    // Soft clouds, never a one-pixel outline.
    for (const shadow of [bright, dark]) expect(shadow).not.toMatch(/0 0 1px/);
    // Before the artwork is measured the copy stands on the heavier one.
    expect(copyShadowFor(0.5)).toBe(dark);
  });

  it("is only ever black", () => {
    for (const shade of [0, 0.25, 0.5, 0.6, 1]) {
      for (const colour of copyShadowFor(shade).match(/rgba\([^)]*\)/g) ?? []) {
        expect(colour).toMatch(/^rgba\(0,0,0,/);
      }
    }
  });
});
