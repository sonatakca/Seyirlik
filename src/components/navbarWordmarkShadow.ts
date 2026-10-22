import { contrastRatio } from "../lib/logoShadow";

/**
 * The navbar wordmark's shadow, baked into images under its frames.
 *
 * It used to be a CSS `filter: drop-shadow()` on the element holding the six
 * colour frames. On a real iPad the loading cycle's frame swaps repaint that
 * element, and iOS WebKit redrew the filter clipped to the element's own
 * 88x36 box: a dark rectangle with straight edges, starkest on Amber, whose
 * letters run to every edge of its canvas. So each frame's shadow is drawn
 * by `scripts/bake-navbar-wordmark.ts`, on a canvas padded by its full
 * reach, and the page shows plain images with no filter at all: the shadow
 * under the letters, faded by how much the artwork behind them needs it.
 */

/** The size of the plain frames, in their own pixels. */
export const WORDMARK_FRAME_WIDTH = 430;
export const WORDMARK_FRAME_HEIGHT = 176;

/**
 * The phone and iPad navbar draw the wordmark 36 CSS px tall (`h-9`), so the
 * shadow is baked to match the old filter exactly at that size. Taller or
 * shorter wordmarks scale the shadow with the letters.
 */
export const WORDMARK_SHADOW_REFERENCE_HEIGHT = 36;

/** The old filter, in CSS px at the reference height, applied in order. */
export const WORDMARK_SHADOWS = [
  { dy: 1, blur: 2, alpha: 0.6 },
  { dy: 3, blur: 14, alpha: 0.5 },
] as const;

/**
 * The Gaussian deviation each CSS blur radius stands for. Browsers disagree:
 * WebKit's drop-shadow, fitted against its own render of the old filter at
 * the reference size, is closest at 0.85 (mean difference 0.2/255), while
 * Chromium's is wider, near 1. This matches WebKit, which every iPhone and
 * iPad uses and where the clipped filter was seen.
 */
export const WORDMARK_SHADOW_SIGMA_PER_BLUR = 0.85;

/** Frame pixels per CSS pixel at the reference height. */
export const WORDMARK_SHADOW_SCALE =
  WORDMARK_FRAME_HEIGHT / WORDMARK_SHADOW_REFERENCE_HEIGHT;

/**
 * How far the baked canvas extends past the plain frame on each side, in frame
 * pixels: every shadow's offset plus three deviations of its blur, beyond
 * which nothing reaches 1/255.
 */
export function getWordmarkShadowPad() {
  const tail = WORDMARK_SHADOWS.reduce(
    (sum, s) => sum + 3 * WORDMARK_SHADOW_SIGMA_PER_BLUR * s.blur,
    0,
  );
  const drop = WORDMARK_SHADOWS.reduce((sum, s) => sum + s.dy, 0);
  const px = (css: number) =>
    Math.ceil(Math.max(0, css) * WORDMARK_SHADOW_SCALE);
  return {
    top: px(tail - drop),
    right: px(tail),
    bottom: px(tail + drop),
    left: px(tail),
  };
}

/**
 * Where a baked frame sits against the wordmark's box, so the letters land
 * exactly where the plain frame's did. Percentages of the box, which keeps
 * the plain frame's 430:176 shape.
 */
export function getWordmarkShadowFrameStyle() {
  const pad = getWordmarkShadowPad();
  const w = WORDMARK_FRAME_WIDTH;
  const h = WORDMARK_FRAME_HEIGHT;
  const pct = (value: number) => `${(value * 100).toFixed(4)}%`;
  return {
    left: pct(-pad.left / w),
    top: pct(-pad.top / h),
    width: pct((w + pad.left + pad.right) / w),
    height: pct((h + pad.top + pad.bottom) / h),
  };
}

/**
 * How much of its shadow the wordmark needs, 0–1, over artwork of these
 * luminances (one per sampled point behind it), for letters of luminance
 * `letters`. Over anything as dark as the letters or darker, all of it: the
 * halo is what separates them. Over artwork lighter than the letters it
 * fades as the two pull apart, gone by a contrast of 3:1: dark letters on a
 * bright sky read by themselves, and a black halo under them only smears
 * their edge. Averaged over the points, so a mixed backdrop gets some.
 */
export function wordmarkShadowStrength(
  letters: number,
  backdrop: readonly number[],
): number {
  if (backdrop.length === 0) return 1;
  let total = 0;
  for (const luminance of backdrop) {
    if (luminance <= letters) {
      total += 1;
      continue;
    }
    const ratio = contrastRatio(letters, luminance);
    total += Math.min(1, Math.max(0, (3 - ratio) / 1.5));
  }
  return total / backdrop.length;
}
