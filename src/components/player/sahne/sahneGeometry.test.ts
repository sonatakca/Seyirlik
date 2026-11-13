import { describe, expect, it } from "vitest";
import {
  containRect,
  rectFor,
  SAHNE_DECK,
  SAHNE_TOP,
  sahneLayout,
  stageTransform,
} from "./sahneGeometry";

const SCOPE = 1920 / 804;

describe("sahneLayout", () => {
  it("fits a scope film to the screen when full", () => {
    const { full } = sahneLayout(1440, 810, SCOPE);
    expect(full.w).toBe(1440);
    expect(full.h).toBeCloseTo(1440 / SCOPE);
    expect(full.y).toBeCloseTo((810 - 1440 / SCOPE) / 2);
  });

  it("leaves the bar above and the deck below the picture with controls", () => {
    const { controls, gutter } = sahneLayout(1440, 810, 16 / 9);
    expect(controls.y).toBeGreaterThanOrEqual(SAHNE_TOP);
    expect(controls.y + controls.h).toBeLessThanOrEqual(810 - SAHNE_DECK + 0.01);
    expect(controls.x).toBeGreaterThanOrEqual(gutter);
    expect(controls.w / controls.h).toBeCloseTo(16 / 9);
  });

  it("puts the lobby picture at the left margin with room beside it", () => {
    const { lobby, gutter } = sahneLayout(1440, 810, SCOPE);
    expect(lobby.x).toBe(gutter);
    expect(lobby.x + lobby.w).toBeLessThan(1440 * 0.6 + 1);
  });

  it("falls back to 16:9 for an unknown aspect", () => {
    const { full } = sahneLayout(1600, 900, Number.NaN);
    expect(full).toEqual({ x: 0, y: 0, w: 1600, h: 900 });
  });
});

describe("stageTransform", () => {
  it("is the identity when the picture stays full", () => {
    const { full } = sahneLayout(1440, 810, SCOPE);
    expect(stageTransform(full, full)).toEqual({ scale: 1, x: 0, y: 0 });
  });

  it("carries the full picture exactly onto the target", () => {
    const layout = sahneLayout(1440, 810, SCOPE);
    const { scale, x, y } = stageTransform(layout.full, layout.controls);
    // Map the full picture's corners through the transform.
    expect(layout.full.x * scale + x).toBeCloseTo(layout.controls.x);
    expect(layout.full.y * scale + y).toBeCloseTo(layout.controls.y);
    expect(layout.full.w * scale).toBeCloseTo(layout.controls.w);
    expect(layout.full.h * scale).toBeCloseTo(layout.controls.h);
  });
});

describe("containRect", () => {
  it("top-aligns when asked, so the lobby picture hugs the top", () => {
    const box = { x: 10, y: 80, w: 800, h: 600 };
    const rect = containRect(box, 16 / 9, "top");
    expect(rect.y).toBe(80);
    expect(rect.w).toBe(800);
    expect(rect.h).toBeCloseTo(450);
  });
});

describe("rectFor", () => {
  it("names each mode's rectangle", () => {
    const layout = sahneLayout(1440, 810, SCOPE);
    expect(rectFor(layout, "full")).toBe(layout.full);
    expect(rectFor(layout, "controls")).toBe(layout.controls);
    expect(rectFor(layout, "lobby")).toBe(layout.lobby);
  });
});
