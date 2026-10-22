import type { MediaItem } from "./types";

/**
 * Where a title's logo sits on its media card, and how large it is.
 *
 * Fractions of the card rather than pixels, because the same card is drawn at
 * several sizes — a poster in the grid, a wide tile in Continue Watching — and
 * a layout chosen at one size has to hold at the others.
 *
 * `x` and `y` locate the centre of the logo; `width` is its width. Anchoring by
 * centre is what makes dragging feel right: the logo moves with the pointer
 * instead of pivoting around a corner.
 */
export interface LogoLayout {
  x: number;
  y: number;
  width: number;
  /**
   * Shadow strength. 0 turns it off, 1 matches the hero's treatment, and above
   * that deepens it for a logo sitting on bright artwork.
   */
  shadow: number;
}

/**
 * A logo may not be scaled below this or it stops being legible, nor above it
 * or it stops being a logo and becomes the card.
 */
export const MIN_LOGO_WIDTH = 0.15;
export const MAX_LOGO_WIDTH = 1;

export const MIN_LOGO_SHADOW = 0;
export const MAX_LOGO_SHADOW = 2;
export const DEFAULT_LOGO_SHADOW = 1;

/**
 * A transparent, full-card logo layer rendered by the API. Poster cards use
 * this instead of asking iOS WebKit to apply a live CSS filter to the logo.
 */
export const CARD_LOGO_OVERLAY_VARIANT = "card-logo-overlay-v1";

/**
 * The layout an editor opens on when a title has never been adjusted.
 *
 * Deliberately close to where the untouched card already draws its logo, so
 * picking the title up and putting it down again changes as little as possible.
 */
export const INITIAL_LOGO_LAYOUT: LogoLayout = {
  x: 0.5,
  y: 0.8,
  width: 0.74,
  shadow: DEFAULT_LOGO_SHADOW,
};

function clampUnit(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

export function clampLogoLayout(layout: LogoLayout): LogoLayout {
  const width = Number.isFinite(layout.width)
    ? Math.min(MAX_LOGO_WIDTH, Math.max(MIN_LOGO_WIDTH, layout.width))
    : INITIAL_LOGO_LAYOUT.width;

  const shadow = Number.isFinite(layout.shadow)
    ? Math.min(MAX_LOGO_SHADOW, Math.max(MIN_LOGO_SHADOW, layout.shadow))
    : DEFAULT_LOGO_SHADOW;

  return { x: clampUnit(layout.x), y: clampUnit(layout.y), width, shadow };
}

/**
 * Reads a stored layout, or null when the title has never been adjusted.
 *
 * Null is meaningful rather than a missing value: it means "draw the card the
 * way it has always been drawn", which is not the same as any particular set of
 * numbers and must stay pixel-identical.
 */
export function getLogoLayout(item?: MediaItem | null): LogoLayout | null {
  const layout = item?.LogoLayout;
  if (
    !layout ||
    typeof layout.x !== "number" ||
    typeof layout.y !== "number" ||
    typeof layout.width !== "number" ||
    !Number.isFinite(layout.x) ||
    !Number.isFinite(layout.y) ||
    !Number.isFinite(layout.width)
  ) {
    return null;
  }
  return clampLogoLayout(layout);
}

/**
 * Inline style placing the logo on a card, given a stored layout.
 *
 * `reach` pads the box by the shadow's reach (`getLogoShadowReach`) and widens
 * it by as much, so the logo's own box, inside the padding, stays exactly
 * where the layout puts it. This box is positioned and stacked above the
 * artwork, so WebKit may give it a layer as large as the box and no larger;
 * the padding keeps normal filter output inside that layer. Production poster
 * cards rasterize placed shadows on the server because iOS can also lose the
 * transparent bitmap's alpha while applying a live filter, which geometry
 * cannot repair. Children placed against the logo's box belong inside an inner
 * box, since the padding moves the edges `absolute` children measure from.
 */
export function getLogoLayoutStyle(
  layout: LogoLayout,
  reach = 0,
): {
  left: string;
  top: string;
  width: string;
  transform: string;
  padding?: string;
} {
  const style = {
    left: `${layout.x * 100}%`,
    top: `${layout.y * 100}%`,
    width: `${layout.width * 100}%`,
    transform: "translate(-50%, -50%)",
  };
  if (!(reach > 0)) return style;
  return {
    ...style,
    width: `calc(${layout.width * 100}% + ${2 * reach}px)`,
    padding: `${reach}px`,
  };
}

export interface Rect {
  width: number;
  height: number;
}

/**
 * Moves the logo by a pointer delta measured in pixels on a card of `bounds`.
 *
 * The delta is converted to fractions here rather than at the call site so the
 * editor never has to know that the stored units are not pixels.
 */
export function moveLogoLayout(
  layout: LogoLayout,
  deltaXPx: number,
  deltaYPx: number,
  bounds: Rect,
): LogoLayout {
  if (bounds.width <= 0 || bounds.height <= 0) return layout;
  return clampLogoLayout({
    ...layout,
    x: layout.x + deltaXPx / bounds.width,
    y: layout.y + deltaYPx / bounds.height,
  });
}

/** Which corner a resize is being dragged from. */
export type ResizeCorner =
  | "top-left"
  | "top-right"
  | "bottom-left"
  | "bottom-right";

/**
 * Resizes about the centre, so the logo grows evenly in both directions and
 * does not crawl across the card while being scaled.
 *
 * Dragging a left-hand corner leftwards makes it wider, which is why the
 * horizontal delta is inverted for those corners.
 */
export function resizeLogoLayout(
  layout: LogoLayout,
  corner: ResizeCorner,
  deltaXPx: number,
  bounds: Rect,
): LogoLayout {
  if (bounds.width <= 0) return layout;

  const outward = corner === "top-left" || corner === "bottom-left" ? -1 : 1;
  // Doubled because the centre stays put: each edge moves by half the change.
  const widthDelta = (2 * outward * deltaXPx) / bounds.width;

  return clampLogoLayout({ ...layout, width: layout.width + widthDelta });
}

/** One arrow-key press, as a fraction of the card. */
export const LOGO_NUDGE_STEP = 0.01;

/**
 * The card logo's shadow, scaled.
 *
 * Two stacked drop-shadows like the hero's: a long soft one that lifts the logo
 * off the artwork, and a tight one that keeps its edges readable. Both scale
 * together, so a single control covers "barely there" to "over a white sky".
 *
 * Returns undefined at zero rather than a no-op filter, so a logo that needs no
 * shadow does not pay for one being composited.
 */
/**
 * How far a shadow reaches is measured in pixels, and those pixels were chosen
 * for a card about this wide. A poster drawn smaller passes its own width over
 * this as `scale`, so its shadow keeps the same proportion to the artwork
 * instead of spilling over the whole thumbnail.
 */
export const LOGO_SHADOW_REFERENCE_WIDTH = 200;

export function getLogoShadowFilter(
  shadow: number,
  sizeScale = 1,
): string | undefined {
  const strength = Number.isFinite(shadow)
    ? Math.min(MAX_LOGO_SHADOW, Math.max(MIN_LOGO_SHADOW, shadow))
    : DEFAULT_LOGO_SHADOW;
  if (strength <= 0) return undefined;
  const size = Number.isFinite(sizeScale) && sizeScale > 0 ? sizeScale : 1;

  /*
   * Up to the default the shadow grows in reach and density together. Past it
   * the reach stays put and only the density rises: the opacities are already
   * at their ceiling there, so a longer blur would spread the same darkness
   * thinner, and around thin lettering the strongest setting drew the faintest
   * shadow of all.
   */
  const reach = Math.min(strength, 1);
  const spread = Math.max(1, Math.round(34 * reach * size));
  const glow = Math.max(1, Math.round(18 * reach * size));
  const drop = Math.max(1, Math.round(14 * reach * size));
  const extra = Math.max(0, strength - 1);
  const far = Math.min(0.9, 0.9 * strength).toFixed(2);
  const near = (0.65 * reach + 0.3 * extra).toFixed(2);
  const soft = `drop-shadow(0 ${drop}px ${spread}px rgba(0, 0, 0, ${far})) drop-shadow(0 0 ${glow}px rgba(0, 0, 0, ${near}))`;

  if (extra === 0) return soft;

  // Tight edges hugging the letters, first in the chain, so the soft shadows
  // after them are cast from a fuller shape and deepen with it.
  const edge = (0.9 * extra).toFixed(2);
  const tight = Math.max(1, Math.round(2 * size));
  const wide = Math.max(1, Math.round(6 * size));
  return `drop-shadow(0 0 ${tight}px rgba(0, 0, 0, ${edge})) drop-shadow(0 0 ${wide}px rgba(0, 0, 0, ${edge})) ${soft}`;
}

/**
 * The logo's drop-shadows, on a frame wide enough to hold all of them.
 *
 * The filter goes on an element around the logo, padded out by the shadow's
 * full reach and pulled back by the same negative margin, so its content box
 * is exactly where the logo was and nothing moves. This contains ordinary
 * filter overflow for the artwork editor, heroes and non-own-API fallbacks.
 * Placed own-API poster logos use `CARD_LOGO_OVERLAY_VARIANT` instead: real
 * iPad WebKit can shadow the transparent bitmap's whole rectangle even when
 * every compositing box already contains the filter output.
 */
export function getLogoShadowFrameStyle(
  shadow: number,
  sizeScale = 1,
): { filter: string; padding: string; margin: string } | undefined {
  const filter = getLogoShadowFilter(shadow, sizeScale);
  if (!filter) return undefined;
  const reach = getLogoShadowReach(shadow, sizeScale);
  return { filter, padding: `${reach}px`, margin: `-${reach}px` };
}

/**
 * How far past the logo its shadow can paint, in whole px; 0 with no shadow.
 * The soft field behind a placed logo (`getLogoShadowBackdropStyle`) spills
 * less far than the drop-shadows at every strength, so this holds it too.
 */
export function getLogoShadowReach(shadow: number, sizeScale = 1): number {
  const filter = getLogoShadowFilter(shadow, sizeScale);
  return filter ? Math.ceil(getDropShadowReach(filter)) : 0;
}

/**
 * How far a chain of `drop-shadow()`s can paint past the shape casting it.
 * Each one casts from the output of the one before, so their reaches add up.
 * A blur of radius r fades out by about 1.4r in WebKit and Chromium; 1.5r
 * leaves a margin.
 */
export function getDropShadowReach(filter: string): number {
  let reach = 0;
  for (const [, x, y, blur] of filter.matchAll(
    /drop-shadow\(\s*(-?[\d.]+)(?:px)?\s+(-?[\d.]+)(?:px)?\s+([\d.]+)px/g,
  )) {
    reach += Math.max(Math.abs(Number(x)), Math.abs(Number(y)));
    reach += 1.5 * Number(blur);
  }
  return reach;
}

/**
 * A soft field behind the complete logo image.
 *
 * `drop-shadow()` follows transparent pixels, which is ideal for provider
 * logos but almost invisible when an uploaded logo has an opaque rectangular
 * background. This field gives those custom images the same adjustable
 * separation from the artwork without changing the image itself.
 *
 * The softness is painted as a radial gradient, never as `filter: blur()`:
 * iOS Safari clips a blurred element to its own box, so on an iPhone the
 * field drew as a hard dark rectangle around the logo. A gradient fades to
 * nothing inside its box on every engine. `inset` overrides the callers'
 * `inset-[6%]`, widening the box by the reach the blur used to spill past it.
 */
export function getLogoShadowBackdropStyle(
  shadow: number,
  sizeScale = 1,
):
  | {
      background: string;
      inset: string;
      transform: string;
    }
  | undefined {
  const strength = Number.isFinite(shadow)
    ? Math.min(MAX_LOGO_SHADOW, Math.max(MIN_LOGO_SHADOW, shadow))
    : DEFAULT_LOGO_SHADOW;
  if (strength <= 0) return undefined;
  const size = Number.isFinite(sizeScale) && sizeScale > 0 ? sizeScale : 1;

  const alpha = Math.min(0.76, 0.38 * strength);
  const ink = (share: number) => `rgba(0, 0, 0, ${(alpha * share).toFixed(2)})`;
  // Held at the default's reach for the same reason as the drop-shadows.
  const reach = Math.max(1, Math.round(18 * Math.min(strength, 1) * size));
  const scale = (1 + 0.12 * strength).toFixed(2);

  return {
    // Eased like a Gaussian so no ring marks where the field ends.
    background: `radial-gradient(closest-side, ${ink(1)} 0%, ${ink(0.92)} 25%, ${ink(0.7)} 48%, ${ink(0.42)} 68%, ${ink(0.18)} 84%, ${ink(0.05)} 94%, rgba(0, 0, 0, 0) 100%)`,
    // Twice the reach above and below: an ellipse's fade scales with its
    // radius, so on a wide, short logo it would otherwise end abruptly.
    inset: `calc(6% - ${2 * reach}px) calc(6% - ${reach}px)`,
    transform: `scale(${scale})`,
  };
}
