/**
 * Where the picture stands in the Sahne player.
 *
 * The picture is an object in a room. It has three places: `full`, alone and
 * as large as the screen allows; `controls`, stepped back far enough to leave
 * a bar above and a deck below; and `lobby`, at the top left, with the title's
 * details beside it and the settings under it. Everything here is plain
 * arithmetic on rectangles so the three places can be tested without a
 * browser.
 */
export type SahneMode = "full" | "controls" | "lobby";

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface SahneLayout {
  /** The picture where the classic player draws it: fitted to the screen. */
  full: Rect;
  controls: Rect;
  lobby: Rect;
  /** The room's side margin. */
  gutter: number;
}

/** Height of the bar above the picture, and of the deck below it. */
export const SAHNE_TOP = 72;
export const SAHNE_DECK = 132;
/** What the lobby keeps under the picture: the deck and the settings rows. */
const LOBBY_TOP = 80;
const LOBBY_FOOT = 344;
const LOBBY_PICTURE_SHARE = 0.6;
/** How long a paused film is left alone before its lobby opens by itself. */
export const SAHNE_LOBBY_IDLE_MS = 4000;
/** The picture's corner radius, in screen pixels, whenever the room shows. */
export const SAHNE_RADIUS = 14;

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

/** The largest rectangle of `aspect` inside the box, centred or top-aligned. */
export function containRect(
  box: Rect,
  aspect: number,
  align: "center" | "top" = "center",
): Rect {
  const w = Math.min(box.w, box.h * aspect);
  const h = w / aspect;
  return {
    x: box.x + (box.w - w) / 2,
    y: align === "top" ? box.y : box.y + (box.h - h) / 2,
    w,
    h,
  };
}

export function sahneLayout(
  width: number,
  height: number,
  /** Width over height of the picture as it is drawn. */
  aspect: number,
): SahneLayout {
  const safeAspect = Number.isFinite(aspect) && aspect > 0 ? aspect : 16 / 9;
  const gutter = clamp(width * 0.03, 18, 48);
  const full = containRect({ x: 0, y: 0, w: width, h: height }, safeAspect);
  const controls = containRect(
    {
      x: gutter,
      y: SAHNE_TOP,
      w: width - 2 * gutter,
      h: Math.max(height - SAHNE_TOP - SAHNE_DECK, 80),
    },
    safeAspect,
  );
  const lobby = containRect(
    {
      x: gutter,
      y: LOBBY_TOP,
      w: Math.max(width * LOBBY_PICTURE_SHARE - gutter, 300),
      h: Math.max(height - LOBBY_TOP - LOBBY_FOOT, 140),
    },
    safeAspect,
    "top",
  );
  // The lobby picture hugs the left margin; what the fit leaves over goes to
  // the details beside it.
  lobby.x = gutter;
  return { full, controls, lobby, gutter };
}

export interface StageTransform {
  scale: number;
  x: number;
  y: number;
}

/**
 * The transform that carries the picture from `full` to `target`.
 *
 * It is applied to a box the size of the screen with its origin at the top
 * left, inside which the picture sits at `full`; so the offset has to place
 * the scaled picture, not the scaled box.
 */
export function stageTransform(full: Rect, target: Rect): StageTransform {
  const scale = full.w > 0 ? target.w / full.w : 1;
  return {
    scale,
    x: target.x - full.x * scale,
    y: target.y - full.y * scale,
  };
}

export function rectFor(layout: SahneLayout, mode: SahneMode): Rect {
  return mode === "lobby"
    ? layout.lobby
    : mode === "controls"
      ? layout.controls
      : layout.full;
}
