import { describe, expect, it } from "vitest";
import {
  CENTRE_FOCUS,
  POSTER_FOCUS,
  coverPosition,
  coverRect,
  readFocus,
} from "./imageFocus";

// A 2.4:1 film still, like the Wolf of Wall Street backdrop.
const SCOPE = { width: 2400, height: 1000 };
const DESKTOP = { width: 1600, height: 900 };
const PHONE = { width: 343, height: 320 };

describe("cover crop around a focus", () => {
  it("draws the centre exactly as object-position: center did", () => {
    const rect = coverRect(SCOPE, DESKTOP, CENTRE_FOCUS);
    // Height-bound: 900 / 1000, so the picture is 2160 wide.
    expect(rect.width).toBeCloseTo(2160);
    expect(rect.height).toBeCloseTo(900);
    expect(rect.left).toBeCloseTo((1600 - 2160) / 2);
    expect(rect.top).toBeCloseTo(0);
    expect(coverPosition(SCOPE, DESKTOP, CENTRE_FOCUS).x).toBeCloseTo(0.5);
  });

  it("keeps a poster's top, as the hero always has", () => {
    const poster = { width: 2000, height: 3000 };
    const rect = coverRect(poster, DESKTOP, POSTER_FOCUS);
    expect(rect.top).toBe(0);
    expect(coverPosition(poster, DESKTOP, POSTER_FOCUS).y).toBeCloseTo(0);
  });

  it("brings a face on the right into the middle of the frame", () => {
    // The face sits at 70% across; centred, a phone frame would cut it off.
    const focus = { x: 0.7, y: 0.4 };
    const rect = coverRect(SCOPE, PHONE, focus);
    const faceOnScreen = rect.left + focus.x * rect.width;
    expect(faceOnScreen).toBeCloseTo(PHONE.width / 2);
  });

  it("never slides past the picture's edge to centre a point near it", () => {
    const rect = coverRect(SCOPE, DESKTOP, { x: 1, y: 0.5 });
    // The right edge lands on the frame's right edge, not inside it.
    expect(rect.left + rect.width).toBeCloseTo(DESKTOP.width);
    expect(coverPosition(SCOPE, DESKTOP, { x: 1, y: 0.5 }).x).toBeCloseTo(1);

    const left = coverRect(SCOPE, DESKTOP, { x: 0, y: 0.5 });
    expect(left.left).toBe(0);
  });

  it("ignores the axis a frame does not crop", () => {
    // Height-bound, so nothing is cut top or bottom whatever the focus says.
    expect(coverRect(SCOPE, DESKTOP, { x: 0.5, y: 0 }).top).toBeCloseTo(0);
    expect(coverRect(SCOPE, DESKTOP, { x: 0.5, y: 1 }).top).toBeCloseTo(0);
    expect(coverPosition(SCOPE, DESKTOP, { x: 0.5, y: 1 }).y).toBe(0.5);
  });
});

describe("reading a focus", () => {
  it("accepts a point and keeps it inside the picture", () => {
    expect(readFocus({ x: 0.2, y: 0.7 })).toEqual({ x: 0.2, y: 0.7 });
    expect(readFocus({ x: 1.4, y: -0.2 })).toEqual({ x: 1, y: 0 });
  });

  it("refuses anything that is not one", () => {
    expect(readFocus(null)).toBeUndefined();
    expect(readFocus({ x: "0.5", y: 0.5 })).toBeUndefined();
    expect(readFocus({ x: Number.NaN, y: 0.5 })).toBeUndefined();
  });
});
