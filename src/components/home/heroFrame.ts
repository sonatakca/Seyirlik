/**
 * The geometry of a hero frame drawn on the compositor (see HeroComposition):
 * its rounded corners as four clipping boxes, and its artwork's cover crop.
 */

/** The radius each clipping box is drawn with; it is scaled to the frame's. */
export const CLIP_RADIUS = 16;
export const CORNERS = ["tl", "tr", "br", "bl"] as const;
export type Corner = (typeof CORNERS)[number];
export const CORNER_RADIUS: Record<Corner, string> = {
  tl: "borderTopLeftRadius",
  tr: "borderTopRightRadius",
  br: "borderBottomRightRadius",
  bl: "borderBottomLeftRadius",
};

/**
 * Where the four clipping boxes and the picture go for a frame at (x, y), `s`
 * times the stage's size, `height` tall before scaling, with corners `radius`
 * px on screen.
 *
 * Every box is `big` square and rounds one corner; each is placed with that
 * corner on the frame's, and since they are nested, what shows is their
 * intersection — the frame, rounded at all four corners. The outermost box is
 * scaled so its radius is the one asked for; the rest only translate, inside
 * it, by the difference from their parent. The picture goes inside the
 * innermost, undoing the boxes' placement to stand at (x, y) scaled by `s`.
 */
export function frameAt(
  frame: { x: number; y: number; s: number; height: number; width: number },
  radius: number,
  big: number,
) {
  const k = radius / CLIP_RADIUS;
  const right = frame.x + frame.width * frame.s;
  const bottom = frame.y + frame.height * frame.s;
  const at: Record<Corner, [number, number]> = {
    tl: [frame.x, frame.y],
    tr: [right - k * big, frame.y],
    br: [right - k * big, bottom - k * big],
    bl: [frame.x, bottom - k * big],
  };
  const clips = {} as Record<Corner, string>;
  let parent: [number, number] | null = null;
  for (const corner of CORNERS) {
    const [px, py] = at[corner];
    clips[corner] = parent
      ? `translate(${(px - parent[0]) / k}px, ${(py - parent[1]) / k}px)`
      : `translate(${px}px, ${py}px) scale(${k})`;
    parent = [px, py];
  }
  const inner = at.bl;
  const picture = `translate(${(frame.x - inner[0]) / k}px, ${(frame.y - inner[1]) / k}px) scale(${frame.s / k})`;
  return { clips, picture };
}

/**
 * An `object-fit: cover` picture drawn by hand: where it stands in a box the
 * stage's size, and the transform that takes it to where cover would draw it
 * in a box `height` tall — the crop a short frame gives it.
 *
 * Drawn by hand because cover only paints inside the image element's own box:
 * moved or scaled, that element would cut the picture off at its edges.
 */
export function coverFit(
  natural: { width: number; height: number },
  box: { width: number; height: number },
  height: number,
  positionY: number,
) {
  const fit = (h: number) => {
    const scale = Math.max(box.width / natural.width, h / natural.height);
    return {
      scale,
      x: (box.width - natural.width * scale) * 0.5,
      y: (h - natural.height * scale) * positionY,
    };
  };
  const full = fit(box.height);
  const short = fit(height);
  return {
    rect: {
      left: full.x,
      top: full.y,
      width: natural.width * full.scale,
      height: natural.height * full.scale,
    },
    transform:
      height === box.height
        ? "none"
        : `translate(${short.x - full.x}px, ${short.y - full.y}px) scale(${short.scale / full.scale})`,
  };
}
