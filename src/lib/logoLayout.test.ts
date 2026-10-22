import { describe, expect, it } from "vitest";
import type { MediaItem } from "./types";
import {
  INITIAL_LOGO_LAYOUT,
  MAX_LOGO_WIDTH,
  MIN_LOGO_WIDTH,
  MAX_LOGO_SHADOW,
  clampLogoLayout,
  getLogoLayout,
  getLogoShadowBackdropStyle,
  getLogoShadowFilter,
  getLogoShadowFrameStyle,
  getLogoShadowReach,
  getDropShadowReach,
  getLogoLayoutStyle,
  moveLogoLayout,
  resizeLogoLayout,
} from "./logoLayout";

const CARD = { width: 200, height: 300 };

function item(layout?: unknown): MediaItem {
  return { Id: "a", Name: "Dune", LogoLayout: layout } as MediaItem;
}

describe("reading a stored layout", () => {
  it("treats an absent layout as never adjusted", () => {
    // Null is not a position. It means "draw the card the way it has always
    // been drawn", which no set of numbers can express.
    expect(getLogoLayout(item())).toBeNull();
    expect(getLogoLayout(undefined)).toBeNull();
    expect(getLogoLayout(null)).toBeNull();
  });

  it("rejects a partial or non-numeric layout rather than half-applying it", () => {
    expect(getLogoLayout(item({ x: 0.5, y: 0.5 }))).toBeNull();
    expect(
      getLogoLayout(item({ x: "0.5", y: 0.5, width: 0.5, shadow: 1 })),
    ).toBeNull();
    expect(
      getLogoLayout(item({ x: Number.NaN, y: 0.5, width: 0.5, shadow: 1 })),
    ).toBeNull();
  });

  it("clamps a stored layout that is out of range", () => {
    expect(getLogoLayout(item({ x: 2, y: -1, width: 5, shadow: 9 }))).toEqual({
      x: 1,
      y: 0,
      width: MAX_LOGO_WIDTH,
      shadow: MAX_LOGO_SHADOW,
    });
  });
});

describe("layout geometry", () => {
  it("anchors by centre so a drag tracks the pointer", () => {
    expect(
      getLogoLayoutStyle({ x: 0.25, y: 0.4, width: 0.6, shadow: 1 }),
    ).toEqual({
      left: "25%",
      top: "40%",
      width: "60%",
      transform: "translate(-50%, -50%)",
    });
  });

  it("pads the placed box by the shadow's reach, keeping the logo where it was", () => {
    expect(
      getLogoLayoutStyle({ x: 0.25, y: 0.4, width: 0.6, shadow: 1 }, 92),
    ).toEqual({
      left: "25%",
      top: "40%",
      width: "calc(60% + 184px)",
      padding: "92px",
      transform: "translate(-50%, -50%)",
    });
    expect(getLogoShadowReach(1)).toBe(92);
    expect(getLogoShadowReach(0)).toBe(0);
  });

  it("keeps a logo legible and smaller than the card", () => {
    expect(
      clampLogoLayout({ x: 0.5, y: 0.5, width: 0.01, shadow: 1 }).width,
    ).toBe(MIN_LOGO_WIDTH);
    expect(clampLogoLayout({ x: 0.5, y: 0.5, width: 9, shadow: 1 }).width).toBe(
      MAX_LOGO_WIDTH,
    );
  });

  it("falls back to the opening size when the width is not a number", () => {
    expect(
      clampLogoLayout({ x: 0.5, y: 0.5, width: Number.NaN, shadow: 1 }).width,
    ).toBe(INITIAL_LOGO_LAYOUT.width);
  });
});

describe("shadow", () => {
  it("turns off completely at zero rather than compositing a no-op filter", () => {
    // A logo that carries its own outline needs no shadow, and should not pay
    // for one being drawn.
    expect(getLogoShadowFilter(0)).toBeUndefined();
    expect(getLogoShadowFilter(-1)).toBeUndefined();
    expect(getLogoShadowBackdropStyle(0)).toBeUndefined();
  });

  it("grows in reach up to the default, then only in density", () => {
    const light = getLogoShadowFilter(0.5) ?? "";
    const normal = getLogoShadowFilter(1) ?? "";
    const strong = getLogoShadowFilter(2) ?? "";

    expect(light).toContain("17px");
    expect(normal).toContain("drop-shadow(0 14px 34px rgba(0, 0, 0, 0.90))");
    expect(normal).not.toContain(" 2px");
    // Past the default a longer blur would only thin the same darkness out,
    // which made the strongest setting the faintest around thin lettering.
    expect(strong).not.toContain("68px");
    expect(strong).toContain("34px");
    expect(strong.startsWith("drop-shadow(0 0 2px rgba(0, 0, 0, 0.90))")).toBe(
      true,
    );

    const normalBackdrop = getLogoShadowBackdropStyle(1);
    const strongBackdrop = getLogoShadowBackdropStyle(2);
    expect(normalBackdrop?.inset).toBe("calc(6% - 36px) calc(6% - 18px)");
    expect(strongBackdrop?.inset).toBe("calc(6% - 36px) calc(6% - 18px)");
    expect(strongBackdrop?.background).toContain("rgba(0, 0, 0, 0.76) 0%");
    // iOS Safari clips a blurred element to its box and drew a hard rectangle.
    expect(strongBackdrop).not.toHaveProperty("filter");
  });

  it("puts the shadow on a frame that already holds all of it", () => {
    // The live editor and fallback paths still keep ordinary filter overflow
    // inside the element that a browser may composite.
    expect(getLogoShadowFrameStyle(0)).toBeUndefined();
    expect(getDropShadowReach(getLogoShadowFilter(1)!)).toBe(
      14 + 1.5 * 34 + 1.5 * 18,
    );
    // The strongest setting adds two tight shadows to the chain.
    expect(getDropShadowReach(getLogoShadowFilter(2)!)).toBe(
      1.5 * 2 + 1.5 * 6 + 14 + 1.5 * 34 + 1.5 * 18,
    );
    const frame = getLogoShadowFrameStyle(1, 0.75);
    expect(frame?.filter).toBe(getLogoShadowFilter(1, 0.75));
    expect(frame?.padding).toBe("71px");
    expect(frame?.margin).toBe("-71px");
  });

  it("falls back to the default when the strength is not a number", () => {
    expect(getLogoShadowFilter(Number.NaN)).toBe(getLogoShadowFilter(1));
  });

  it("does not deepen past full opacity however high it is pushed", () => {
    expect(getLogoShadowFilter(2)).toContain("0.90");
  });
});

describe("dragging", () => {
  it("converts a pixel delta into a fraction of the card", () => {
    const moved = moveLogoLayout(
      { x: 0.5, y: 0.5, width: 0.5, shadow: 1 },
      20,
      -30,
      CARD,
    );

    expect(moved.x).toBeCloseTo(0.6);
    expect(moved.y).toBeCloseTo(0.4);
  });

  it("stops at the edges of the card", () => {
    const moved = moveLogoLayout(
      { x: 0.9, y: 0.1, width: 0.5, shadow: 1 },
      400,
      -400,
      CARD,
    );
    expect(moved).toMatchObject({ x: 1, y: 0 });
  });

  it("does nothing before the card has been measured", () => {
    const layout = { x: 0.5, y: 0.5, width: 0.5, shadow: 1 };
    expect(moveLogoLayout(layout, 20, 20, { width: 0, height: 0 })).toBe(
      layout,
    );
  });
});

describe("resizing", () => {
  it("grows about the centre, so the logo does not crawl while scaling", () => {
    const layout = { x: 0.5, y: 0.5, width: 0.5, shadow: 1 };
    const resized = resizeLogoLayout(layout, "bottom-right", 20, CARD);

    // Each edge moves by the drag, so the width changes by twice it.
    expect(resized.width).toBeCloseTo(0.7);
    expect(resized.x).toBe(layout.x);
    expect(resized.y).toBe(layout.y);
  });

  it("treats a leftward drag on a left-hand corner as growing", () => {
    const layout = { x: 0.5, y: 0.5, width: 0.5, shadow: 1 };

    expect(resizeLogoLayout(layout, "top-left", -20, CARD).width).toBeCloseTo(
      0.7,
    );
    expect(resizeLogoLayout(layout, "bottom-left", 20, CARD).width).toBeCloseTo(
      0.3,
    );
  });

  it("will not shrink below legible or grow past the card", () => {
    const layout = { x: 0.5, y: 0.5, width: 0.5, shadow: 1 };
    expect(resizeLogoLayout(layout, "bottom-right", -500, CARD).width).toBe(
      MIN_LOGO_WIDTH,
    );
    expect(resizeLogoLayout(layout, "bottom-right", 500, CARD).width).toBe(
      MAX_LOGO_WIDTH,
    );
  });
});
