import sharp from "sharp";
import {
  DEFAULT_LOGO_SHADOW,
  clampLogoLayout,
  getLogoShadowBackdropStyle,
  getLogoShadowFilter,
  type LogoLayout,
} from "../../../lib/logoLayout";

/**
 * A title's poster card as a picture: the cover, and the logo laid over it
 * exactly where, how large and how shadowed the site draws it.
 *
 * The site draws the card in CSS, so this is a port of that CSS rather than a
 * design of its own. The shadow numbers are read out of the same functions in
 * `src/lib/logoLayout.ts` the card calls; the geometry follows the card's class
 * names in `MediaCard.tsx`. `scripts/share-card-fidelity.ts` renders the real
 * CSS in Chromium and measures the difference.
 *
 * The CSS is written in CSS pixels on a card of a particular width, and the
 * shadows do not scale with the card (`sizeScale` is 1 wherever a poster is
 * drawn). So "the same as the site" needs a card width to mean anything, and
 * it is the width of the DevTools editor's card — where the layout is chosen —
 * 18rem. Everything is laid out on that card and then scaled as a whole.
 */
export const REFERENCE_CARD_WIDTH = 288;
export const REFERENCE_CARD_HEIGHT = 432;

/** `rounded-xl`. */
const CARD_RADIUS = 12;

/** The unadjusted card: `bottom-4 max-h-24 max-w-[80%]` (desktop). */
const DEFAULT_LOGO_BOTTOM = 16;
const DEFAULT_LOGO_MAX_HEIGHT = 96;
const DEFAULT_LOGO_MAX_WIDTH_FRACTION = 0.8;
/** The card asks for its logo at this width; it is never drawn wider. */
const DEFAULT_LOGO_REQUEST_WIDTH = 520;

export interface DropShadow {
  dy: number;
  /**
   * The Gaussian's standard deviation itself. Unlike `box-shadow`, whose blur
   * radius is twice the deviation, `drop-shadow()` passes its length straight
   * to `feGaussianBlur` (Filter Effects 1, and what Chromium draws).
   */
  blur: number;
  opacity: number;
}

const DROP_SHADOW =
  /drop-shadow\(0 (-?[\d.]+)(?:px)? ([\d.]+)px rgba\(0, 0, 0, ([\d.]+)\)\)/g;

/**
 * The card's shadow, read out of the very filter string the card is styled
 * with, so the two cannot drift. CSS applies a filter list left to right,
 * each shadow cast from everything drawn before it.
 */
export function logoShadowChain(shadow: number): DropShadow[] {
  const filter = getLogoShadowFilter(shadow);
  if (!filter) return [];
  return [...filter.matchAll(DROP_SHADOW)].map((match) => ({
    dy: Number(match[1]),
    blur: Number(match[2]),
    opacity: Number(match[3]),
  }));
}

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BackdropField {
  box: Box;
  /** Alpha at each gradient stop, by offset. */
  stops: Array<[offset: number, alpha: number]>;
}

/**
 * The soft field behind an adjusted logo, read out of the style the card
 * gives it (`getLogoShadowBackdropStyle`) and resolved against the logo's box:
 * percent insets against the box's own width and height, the scale about its
 * centre, the gradient's `closest-side` ellipse filling what results.
 */
export function logoBackdropField(
  shadow: number,
  logo: Box,
): BackdropField | null {
  const style = getLogoShadowBackdropStyle(shadow);
  if (!style) return null;

  const inset = /^calc\(6% - ([\d.]+)px\) calc\(6% - ([\d.]+)px\)$/.exec(
    style.inset,
  );
  const scale = /^scale\(([\d.]+)\)$/.exec(style.transform);
  const stops = [
    ...style.background.matchAll(/rgba\(0, 0, 0, ([\d.]+)\) ([\d.]+)%/g),
  ].map(
    (match) => [Number(match[2]) / 100, Number(match[1])] as [number, number],
  );
  if (!inset || !scale || stops.length === 0) return null;

  const insetY = 0.06 * logo.height - Number(inset[1]);
  const insetX = 0.06 * logo.width - Number(inset[2]);
  const width = (logo.width - 2 * insetX) * Number(scale[1]);
  const height = (logo.height - 2 * insetY) * Number(scale[1]);
  return {
    box: {
      x: logo.x + logo.width / 2 - width / 2,
      y: logo.y + logo.height / 2 - height / 2,
      width,
      height,
    },
    stops,
  };
}

/**
 * Where the logo sits on the reference card.
 *
 * An adjusted card centres the logo on (x, y) at the stored width, its height
 * following the image. An unadjusted one draws it the way the card always has:
 * centred, 16px off the bottom, as large as fits 80% of the width and 96px of
 * height without growing past the 520px it was fetched at.
 */
export function logoBox(
  layout: LogoLayout | null,
  logoWidth: number,
  logoHeight: number,
): Box {
  const aspect = logoWidth / logoHeight;
  if (layout) {
    const { x, y, width } = clampLogoLayout(layout);
    const w = width * REFERENCE_CARD_WIDTH;
    const h = w / aspect;
    return {
      x: x * REFERENCE_CARD_WIDTH - w / 2,
      y: y * REFERENCE_CARD_HEIGHT - h / 2,
      width: w,
      height: h,
    };
  }
  const natural = Math.min(logoWidth, DEFAULT_LOGO_REQUEST_WIDTH);
  const w = Math.min(
    natural,
    DEFAULT_LOGO_MAX_WIDTH_FRACTION * REFERENCE_CARD_WIDTH,
    DEFAULT_LOGO_MAX_HEIGHT * aspect,
  );
  const h = w / aspect;
  return {
    x: (REFERENCE_CARD_WIDTH - w) / 2,
    y: REFERENCE_CARD_HEIGHT - DEFAULT_LOGO_BOTTOM - h,
    width: w,
    height: h,
  };
}

function svgNumber(value: number): string {
  return Number(value.toFixed(3)).toString();
}

/**
 * The logo layer as SVG in reference-card coordinates, for librsvg to paint at
 * any size. The filter is the CSS chain spelled out: each step blurs the alpha
 * of what came before, offsets it, fills it black at the step's opacity, and
 * lays the result underneath.
 */
export function logoLayerSvg(options: {
  logo: Buffer;
  logoType: string;
  logoWidth: number;
  logoHeight: number;
  layout: LogoLayout | null;
  outputWidth: number;
}): string {
  const box = logoBox(options.layout, options.logoWidth, options.logoHeight);
  const shadow = options.layout
    ? clampLogoLayout(options.layout).shadow
    : DEFAULT_LOGO_SHADOW;
  const chain = logoShadowChain(shadow);
  const field = options.layout ? logoBackdropField(shadow, box) : null;
  const primitives: string[] = [];
  let previous = "SourceGraphic";
  chain.forEach((step, index) => {
    const n = `s${index}`;
    primitives.push(
      `<feGaussianBlur in="${previous}" stdDeviation="${svgNumber(step.blur)}" result="${n}b"/>`,
      `<feOffset in="${n}b" dx="0" dy="${svgNumber(step.dy)}" result="${n}o"/>`,
      `<feFlood flood-color="#000" flood-opacity="${step.opacity}" result="${n}c"/>`,
      `<feComposite in="${n}c" in2="${n}o" operator="in" result="${n}s"/>`,
      `<feMerge result="${n}"><feMergeNode in="${n}s"/><feMergeNode in="${previous}"/></feMerge>`,
    );
    previous = n;
  });

  const fieldSvg = field
    ? `<radialGradient id="field" cx="0.5" cy="0.5" r="0.5">${field.stops
        .map(
          ([offset, alpha]) =>
            `<stop offset="${offset}" stop-color="#000" stop-opacity="${alpha}"/>`,
        )
        .join("")}</radialGradient>
       <rect x="${svgNumber(field.box.x)}" y="${svgNumber(field.box.y)}" width="${svgNumber(field.box.width)}" height="${svgNumber(field.box.height)}" fill="url(#field)"/>`
    : "";

  const href = `data:${options.logoType};base64,${options.logo.toString("base64")}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${Math.round(options.outputWidth)}" height="${Math.round(options.outputWidth * 1.5)}" viewBox="0 0 ${REFERENCE_CARD_WIDTH} ${REFERENCE_CARD_HEIGHT}">
  <defs>
    ${
      primitives.length
        ? `<filter id="shadow" filterUnits="userSpaceOnUse" x="-${REFERENCE_CARD_WIDTH}" y="-${REFERENCE_CARD_HEIGHT}" width="${REFERENCE_CARD_WIDTH * 3}" height="${REFERENCE_CARD_HEIGHT * 3}" color-interpolation-filters="sRGB">${primitives.join("")}</filter>`
        : ""
    }
  </defs>
  ${fieldSvg}
  <image x="${svgNumber(box.x)}" y="${svgNumber(box.y)}" width="${svgNumber(box.width)}" height="${svgNumber(box.height)}" preserveAspectRatio="none" xlink:href="${href}" href="${href}"${primitives.length ? ' filter="url(#shadow)"' : ""}/>
</svg>`.replace(/^\s+/gm, "");
}

const MAX_INPUT_PIXELS = 60_000_000;

/**
 * The card alone, `width` pixels wide, 2:3, as PNG. Corners are rounded unless
 * `square` — an image that stands alone leaves its rounding to whatever shows
 * it, since a JPEG has nothing to fill the corners with.
 */
export async function renderPosterCard(options: {
  cover: Buffer;
  logo: Buffer | null;
  layout: LogoLayout | null;
  width: number;
  square?: boolean;
}): Promise<Buffer> {
  const width = Math.round(options.width);
  const height = Math.round(width * 1.5);

  // `object-cover`: fill the card, crop the overflow evenly.
  const layers: sharp.OverlayOptions[] = [];
  if (options.logo) {
    const logo = sharp(options.logo, { limitInputPixels: MAX_INPUT_PIXELS });
    const meta = await logo.metadata();
    if (meta.width && meta.height) {
      /*
       * Embedded at the size it will be drawn, not the size it was stored.
       * An original logo can be several thousand pixels wide, and as base64
       * inside the SVG that overran libxml2's 10 MB limit on a single
       * attribute ("Resource limit exceeded"), failing the whole card. The
       * geometry still comes from the original's dimensions.
       */
      const drawnWidth = Math.ceil(
        (logoBox(options.layout, meta.width, meta.height).width * width) /
          REFERENCE_CARD_WIDTH,
      );
      const png = await logo
        .rotate()
        .resize({ width: drawnWidth, withoutEnlargement: true })
        .png()
        .toBuffer();
      const svg = logoLayerSvg({
        logo: png,
        logoType: "image/png",
        logoWidth: meta.width,
        logoHeight: meta.height,
        layout: options.layout,
        outputWidth: width,
      });
      layers.push({ input: Buffer.from(svg), top: 0, left: 0 });
    }
  }

  const radius = (CARD_RADIUS * width) / REFERENCE_CARD_WIDTH;
  if (!options.square)
    layers.push({
      input: Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="${width}" height="${height}" rx="${radius}" ry="${radius}"/></svg>`,
      ),
      blend: "dest-in",
    });

  return sharp(options.cover, { limitInputPixels: MAX_INPUT_PIXELS })
    .rotate()
    .resize(width, height, { fit: "cover", position: "centre" })
    .ensureAlpha()
    .composite(layers)
    .png()
    .toBuffer();
}

/**
 * A title's share card: its poster card at the cover's own resolution —
 * never enlarged, never reduced.
 *
 * The width is as much of the cover as a 2:3 card can show: all of it, for a
 * poster that is already 2:3, and the centre crop the card's `object-cover`
 * shows for one that is not.
 *
 * Only a title with both a cover and a logo has one. Anything less is not the
 * card the site draws, so a link to it keeps Seyirlik's own preview image
 * (`public/seyirlik-preview.png`), which is the caller's to fall back to.
 */
export async function renderShareCard(options: {
  cover: Buffer;
  logo: Buffer;
  layout: LogoLayout | null;
}): Promise<{ jpeg: Buffer; width: number; height: number }> {
  const meta = await sharp(options.cover, {
    limitInputPixels: MAX_INPUT_PIXELS,
  })
    .rotate()
    .metadata();
  const coverWidth = meta.autoOrient?.width ?? meta.width;
  const coverHeight = meta.autoOrient?.height ?? meta.height;
  if (!coverWidth || !coverHeight) throw new Error("The cover has no size.");
  // Even, so the height is a whole number and the card exactly 2:3.
  const width = Math.max(
    2,
    2 * Math.floor(Math.min(coverWidth, coverHeight / 1.5) / 2),
  );

  const png = await renderPosterCard({ ...options, width, square: true });
  const jpeg = await sharp(png)
    .flatten({ background: "#000" })
    .jpeg({ quality: 86, mozjpeg: true })
    .toBuffer();
  return { jpeg, width, height: Math.round(width * 1.5) };
}
