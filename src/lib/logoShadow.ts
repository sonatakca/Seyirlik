/**
 * A shadow in the shape of a logo, as strong as the artwork behind it needs.
 *
 * It is always dark: Seyirlik never draws a white or bright shadow, a glow
 * behind a dark logo included. The closer the logo and the artwork are in
 * brightness, the stronger it is. A logo that already stands out still gets
 * a trace of one, so it reads as lying over the picture rather than printed
 * into it.
 */

export interface LogoShadow {
  /** 0–1. */
  strength: number;
}

export const DEFAULT_LOGO_SHADOW: LogoShadow = { strength: 0.7 };

/** Relative luminance (WCAG) of an sRGB colour given as 0–255 channels. */
export function relativeLuminance(r: number, g: number, b: number): number {
  const channel = (value: number) => {
    const c = value / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function contrastRatio(a: number, b: number): number {
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/** The shadow for a logo of one brightness over artwork of another. */
export function logoShadowFor(
  logoLuminance: number,
  backdropLuminance: number,
): LogoShadow {
  const ratio = contrastRatio(logoLuminance, backdropLuminance);
  // Full strength at a ratio of 1.5 or less, a trace from about 7.
  const strength = Math.min(1, Math.max(0.25, (7 - ratio) / 5.5));
  return { strength };
}

/** Where, as shares of the artwork, a miniature's logo lies over it. */
export interface SampleRegion {
  left: number;
  top: number;
  width: number;
  height: number;
}

const cache = new Map<string, Promise<LogoShadow>>();

/**
 * Measures both images and returns the shadow for them. Any failure (a
 * request refused, an image that cannot be decoded) gives the default,
 * which suits the common case of a light logo over a darkened picture.
 */
export function measureLogoShadow(
  logoUrl: string,
  backdropUrl: string,
  region: SampleRegion,
): Promise<LogoShadow> {
  const key = `${logoUrl}|${backdropUrl}|${region.left},${region.top},${region.width},${region.height}`;
  const cached = cache.get(key);
  if (cached) return cached;
  const measured = Promise.all([
    averageLuminance(logoUrl, null, 128),
    averageLuminance(backdropUrl, region, 1),
  ])
    .then(([logo, backdrop]) =>
      logo === null || backdrop === null
        ? DEFAULT_LOGO_SHADOW
        : logoShadowFor(logo, backdrop),
    )
    .catch(() => DEFAULT_LOGO_SHADOW);
  cache.set(key, measured);
  return measured;
}

const backdropCache = new Map<string, Promise<number | null>>();

/**
 * Mean luminance of one region of an artwork, or null when it cannot be
 * read. What copy set straight on the picture measures itself against.
 */
export function measureBackdropLuminance(
  backdropUrl: string,
  region: SampleRegion,
): Promise<number | null> {
  const key = `${backdropUrl}|${region.left},${region.top},${region.width},${region.height}`;
  const cached = backdropCache.get(key);
  if (cached) return cached;
  const measured = averageLuminance(backdropUrl, region, 1).catch(() => null);
  backdropCache.set(key, measured);
  return measured;
}

/**
 * Mean luminance of an image, over pixels at least `minAlpha` opaque and,
 * when given, inside `region`. Read through `fetch` so a cross-origin image
 * the API serves with CORS can be measured without tainting a canvas.
 */
async function averageLuminance(
  url: string,
  region: SampleRegion | null,
  minAlpha: number,
): Promise<number | null> {
  const response = await fetch(url, { credentials: "include" });
  if (!response.ok) return null;
  const bitmap = await createImageBitmap(await response.blob());
  try {
    const scale = Math.min(1, 96 / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return null;
    context.drawImage(bitmap, 0, 0, width, height);
    const x0 = region ? Math.floor(region.left * width) : 0;
    const y0 = region ? Math.floor(region.top * height) : 0;
    const x1 = region
      ? Math.max(x0 + 1, Math.ceil((region.left + region.width) * width))
      : width;
    const y1 = region
      ? Math.max(y0 + 1, Math.ceil((region.top + region.height) * height))
      : height;
    const { data } = context.getImageData(x0, y0, x1 - x0, y1 - y0);
    let total = 0;
    let weight = 0;
    for (let index = 0; index < data.length; index += 4) {
      const alpha = data[index + 3]!;
      if (alpha < minAlpha) continue;
      const w = alpha / 255;
      total +=
        w * relativeLuminance(data[index]!, data[index + 1]!, data[index + 2]!);
      weight += w;
    }
    return weight > 0 ? total / weight : null;
  } finally {
    bitmap.close();
  }
}
