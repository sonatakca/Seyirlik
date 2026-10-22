/**
 * A poster's colours as a soft field of light, baked once into a tiny image.
 *
 * The phone and upright-tablet home hero lit its room with the front poster
 * itself, full size, under a live `blur(64px) saturate(1.5)`, and cross-faded
 * a second copy in on every slide. Two screen-sized live filters re-composited
 * for a second at each turn is what held the deck to 20 fps on an iPad. A
 * blur of that size keeps no detail an 80 px thumbnail lacks, so the field is
 * blurred and saturated here, at thumbnail size, and shown as a plain image:
 * scaled up, it is the same light, and the turn moves only opacity.
 *
 * Safari has no canvas `filter`, and the work is a few thousand pixels, so the
 * blur and saturation are done on the pixels directly.
 */

/** The smallest variant the artwork pipeline renders. */
export const AMBIENT_SOURCE_WIDTH = 80;

export interface AmbientLook {
  /** The CSS blur the field stands in for, in CSS px. */
  blurPx: number;
  /** The CSS `saturate()` amount. */
  saturation: number;
  /** How wide the field is drawn on screen, in CSS px. */
  drawnWidth: number;
}

/** The standard deviation, in canvas px, a CSS blur becomes at this size. */
export function canvasSigma(look: AmbientLook, canvasWidth: number): number {
  return (look.blurPx * canvasWidth) / Math.max(1, look.drawnWidth);
}

/**
 * Box radii whose three passes approximate a Gaussian of this deviation
 * (Kovesi, "Fast almost-Gaussian filtering").
 */
export function boxRadii(sigma: number, passes = 3): number[] {
  if (sigma <= 0) return Array.from({ length: passes }, () => 0);
  const ideal = Math.sqrt((12 * sigma * sigma) / passes + 1);
  let lower = Math.floor(ideal);
  if (lower % 2 === 0) lower -= 1;
  const upper = lower + 2;
  const m = Math.round(
    (12 * sigma * sigma -
      passes * lower * lower -
      4 * passes * lower -
      3 * passes) /
      (-4 * lower - 4),
  );
  return Array.from({ length: passes }, (_, i) =>
    Math.max(0, ((i < m ? lower : upper) - 1) / 2),
  );
}

/** One box pass along rows or columns, edges clamped, all four channels. */
function boxPass(
  source: Float32Array,
  target: Float32Array,
  width: number,
  height: number,
  radius: number,
  horizontal: boolean,
) {
  const lines = horizontal ? height : width;
  const length = horizontal ? width : height;
  const step = horizontal ? 4 : width * 4;
  const span = radius * 2 + 1;
  for (let line = 0; line < lines; line += 1) {
    const start = horizontal ? line * width * 4 : line * 4;
    for (let channel = 0; channel < 4; channel += 1) {
      const at = (i: number) =>
        source[start + Math.min(length - 1, Math.max(0, i)) * step + channel];
      let sum = 0;
      for (let i = -radius; i <= radius; i += 1) sum += at(i);
      for (let i = 0; i < length; i += 1) {
        target[start + i * step + channel] = sum / span;
        sum += at(i + radius + 1) - at(i - radius);
      }
    }
  }
}

/** Blurs RGBA pixels in place with three box passes each way. */
export function blurPixels(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  sigma: number,
): void {
  let a = Float32Array.from(pixels);
  let b = new Float32Array(a.length);
  for (const radius of boxRadii(sigma)) {
    if (radius < 1) continue;
    boxPass(a, b, width, height, Math.round(radius), true);
    [a, b] = [b, a];
    boxPass(a, b, width, height, Math.round(radius), false);
    [a, b] = [b, a];
  }
  pixels.set(a);
}

/** CSS `saturate()`, by the filter-effects matrix. */
export function saturatePixels(
  pixels: Uint8ClampedArray,
  amount: number,
): void {
  const s = amount;
  const m = [
    0.213 + 0.787 * s,
    0.715 - 0.715 * s,
    0.072 - 0.072 * s,
    0.213 - 0.213 * s,
    0.715 + 0.285 * s,
    0.072 - 0.072 * s,
    0.213 - 0.213 * s,
    0.715 - 0.715 * s,
    0.072 + 0.928 * s,
  ];
  for (let i = 0; i < pixels.length; i += 4) {
    const r = pixels[i];
    const g = pixels[i + 1];
    const b = pixels[i + 2];
    pixels[i] = m[0] * r + m[1] * g + m[2] * b;
    pixels[i + 1] = m[3] * r + m[4] * g + m[5] * b;
    pixels[i + 2] = m[6] * r + m[7] * g + m[8] * b;
  }
}

async function bake(source: string, look: AmbientLook): Promise<string> {
  const response = await fetch(source, { credentials: "include" });
  if (!response.ok)
    throw new Error(`Ambient request failed: ${response.status}`);
  const bitmap = await createImageBitmap(await response.blob());
  try {
    const width = Math.min(bitmap.width, AMBIENT_SOURCE_WIDTH);
    const height = Math.max(
      1,
      Math.round((bitmap.height * width) / bitmap.width),
    );
    const canvas = Object.assign(document.createElement("canvas"), {
      width,
      height,
    });
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("No ambient canvas context");
    context.drawImage(bitmap, 0, 0, width, height);
    const image = context.getImageData(0, 0, width, height);
    saturatePixels(image.data, look.saturation);
    blurPixels(image.data, width, height, canvasSigma(look, width));
    context.putImageData(image, 0, 0);
    // A few thousand pixels: the encode is far below a frame.
    const blob = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error("No ambient blob"))),
        "image/png",
      ),
    );
    return URL.createObjectURL(blob);
  } finally {
    bitmap.close();
  }
}

/**
 * Baked fields, kept while the deck can come back to them: a deck turns
 * through the same dozen titles, and each is baked once.
 */
const MAX_BAKED = 24;
const baked = new Map<string, Promise<string>>();

export function bakeAmbient(
  source: string,
  look: AmbientLook,
): Promise<string> {
  const key = `${source}|${Math.round(look.blurPx)}|${look.saturation}|${Math.round(look.drawnWidth / 32)}`;
  const known = baked.get(key);
  if (known) {
    // Most recently wanted last, so the oldest is the one let go.
    baked.delete(key);
    baked.set(key, known);
    return known;
  }
  const pending = bake(source, look);
  baked.set(key, pending);
  pending.catch(() => baked.delete(key));
  while (baked.size > MAX_BAKED) {
    const [oldestKey, oldest] = baked.entries().next().value as [
      string,
      Promise<string>,
    ];
    baked.delete(oldestKey);
    void oldest.then((url) => URL.revokeObjectURL(url)).catch(() => {});
  }
  return pending;
}
