/**
 * Which part of a picture a cropping frame keeps in view.
 *
 * A focus is a point in the image, as fractions of its width and height from
 * its top-left corner: "the face is here". It is not an `object-position`,
 * which says how far along the overflow to slide, because the overflow
 * depends on the frame. The same backdrop is cropped at the sides in a wide
 * desktop hero and at the top and bottom of nothing on a phone, and one point
 * has to serve every shape: each frame keeps the point as near its own middle
 * as the crop allows.
 */
export interface ImageFocus {
  x: number;
  y: number;
}

/** How every picture was drawn before a focus existed. */
export const CENTRE_FOCUS: ImageFocus = { x: 0.5, y: 0.5 };

/** A poster keeps its top, where the faces are, and loses its lettering. */
export const POSTER_FOCUS: ImageFocus = { x: 0.5, y: 0 };

const clamp = (value: number, low: number, high: number) =>
  Math.min(high, Math.max(low, value));

export function clampFocus(focus: ImageFocus): ImageFocus {
  return { x: clamp(focus.x, 0, 1), y: clamp(focus.y, 0, 1) };
}

/** A focus from untrusted data, or undefined when it is not one. */
export function readFocus(value: unknown): ImageFocus | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { x, y } = value as Record<string, unknown>;
  return typeof x === "number" &&
    typeof y === "number" &&
    Number.isFinite(x) &&
    Number.isFinite(y)
    ? clampFocus({ x, y })
    : undefined;
}

export function isCentred(focus: ImageFocus): boolean {
  return Math.abs(focus.x - 0.5) < 0.005 && Math.abs(focus.y - 0.5) < 0.005;
}

/**
 * Where one axis of a cover-fitted picture starts, in the frame's px: 0 or
 * less, and never so far that the picture's far edge comes into the frame.
 */
function axisOffset(frame: number, drawn: number, focus: number): number {
  const overflow = drawn - frame;
  if (overflow <= 0) return (frame - drawn) / 2;
  return clamp(frame / 2 - focus * drawn, -overflow, 0);
}

/**
 * `object-fit: cover` of `natural` in `frame`, keeping `focus` as close to
 * the frame's middle as the picture's edges allow.
 */
export function coverRect(
  natural: { width: number; height: number },
  frame: { width: number; height: number },
  focus: ImageFocus,
): { left: number; top: number; width: number; height: number } {
  const scale = Math.max(
    frame.width / natural.width,
    frame.height / natural.height,
  );
  const width = natural.width * scale;
  const height = natural.height * scale;
  return {
    left: axisOffset(frame.width, width, focus.x),
    top: axisOffset(frame.height, height, focus.y),
    width,
    height,
  };
}

/**
 * The same crop as an `object-position`: on each axis, the share of the
 * overflow the picture is slid by (0.5 on an axis with none).
 */
export function coverPosition(
  natural: { width: number; height: number },
  frame: { width: number; height: number },
  focus: ImageFocus,
): { x: number; y: number } {
  const rect = coverRect(natural, frame, focus);
  const share = (offset: number, drawn: number, size: number) =>
    drawn - size > 0.5 ? -offset / (drawn - size) : 0.5;
  return {
    x: share(rect.left, rect.width, frame.width),
    y: share(rect.top, rect.height, frame.height),
  };
}
