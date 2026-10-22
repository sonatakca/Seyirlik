import { useEffect, useRef, useState } from "react";
import { useReducedMotion } from "framer-motion";
import { getLogoImageUrl, getPrimaryImageUrl } from "../lib/mediaApi";
import {
  medianCut,
  settlePalette,
  type Rgb,
  type Swatch,
} from "../lib/shelfPalette";
import type { MediaItem } from "../lib/types";
import "./LibraryHeaderArt.css";

/**
 * The picture on the wall above a library's grid: a barcode of the shelf's
 * colours. It does nothing; it is there so the space between the navigation
 * and the search bar is not bare. It never moves once it has arrived, so it
 * cannot pull the eye from the grid the way the rotating logo it replaced did.
 */

/*
 * Each title gives its palette, the way a film's colour script is read off its
 * frames: the few colours its cover is made of, each as wide as the share of
 * the cover it covers, closed by the colour of its logo. Side by side they make
 * a barcode of the whole shelf. Covers and logos are what the page already
 * downloads, so the picture costs no work anywhere else.
 */

/** Palettes past this thin to hairlines; sample the shelf evenly instead. */
const MAX_TITLES = 60;
const SAMPLE_CONCURRENCY = 6;
/** Colours read off each cover, before near-duplicates merge. */
const COVER_COLOURS = 6;
/** The logo's strand, as a share of its title's width. */
const LOGO_SHARE = 0.12;
/** Wider than this and a title's lines turn into paint chips; a small shelf
    makes a short barcode, centred, instead. */
const MAX_TITLE_WIDTH = 72;
/** The page is black; a colour darker than this would not glow at all. */
const DARKEST_CHANNEL = 48;
/** CSS pixels of wall between two titles. */
const TITLE_GAP = 5;
/** About one strand per this many CSS pixels of a title's width. */
const STRAND_SPACING = 3.2;

interface TitlePalette {
  cover: Swatch[];
  logo: Rgb | null;
}

interface PaletteSource {
  coverUrl: string;
  logoUrl: string | null;
}

/** Pixels of an image, reduced to at most `maxSide` on its longer side. */
async function readPixels(
  url: string,
  maxSide: number,
): Promise<Uint8ClampedArray | null> {
  const response = await fetch(url, { credentials: "include" });
  if (!response.ok) return null;
  const bitmap = await createImageBitmap(await response.blob());
  try {
    const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    // Halve in steps so each pixel averages its area instead of picking one.
    let source: CanvasImageSource = bitmap;
    let sourceWidth = bitmap.width;
    let sourceHeight = bitmap.height;
    while (sourceWidth / 2 >= width && sourceHeight / 2 >= height) {
      sourceWidth = Math.round(sourceWidth / 2);
      sourceHeight = Math.round(sourceHeight / 2);
      const step = document.createElement("canvas");
      step.width = sourceWidth;
      step.height = sourceHeight;
      step.getContext("2d")?.drawImage(source, 0, 0, sourceWidth, sourceHeight);
      source = step;
    }
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return null;
    context.drawImage(source, 0, 0, width, height);
    return context.getImageData(0, 0, width, height).data;
  } finally {
    bitmap.close();
  }
}

async function coverPalette(url: string): Promise<Swatch[]> {
  const data = await readPixels(url, 72);
  if (!data) return [];
  const pixels: Rgb[] = [];
  for (let index = 0; index < data.length; index += 4) {
    pixels.push([data[index]!, data[index + 1]!, data[index + 2]!]);
  }
  return settlePalette(medianCut(pixels, COVER_COLOURS));
}

/** The colour a logo is drawn in: its largest opaque colour. */
async function logoColour(url: string): Promise<Rgb | null> {
  const data = await readPixels(url, 160);
  if (!data) return null;
  const pixels: Rgb[] = [];
  for (let index = 0; index < data.length; index += 4) {
    if (data[index + 3]! < 200) continue;
    pixels.push([data[index]!, data[index + 1]!, data[index + 2]!]);
  }
  if (pixels.length < 20) return null;
  const [main] = medianCut(pixels, 3).sort((a, b) => b.share - a.share);
  return main?.rgb ?? null;
}

const paletteCache = new Map<string, Promise<TitlePalette | null>>();

function readPalette(source: PaletteSource): Promise<TitlePalette | null> {
  const key = `${source.coverUrl}|${source.logoUrl ?? ""}`;
  let pending = paletteCache.get(key);
  if (!pending) {
    pending = Promise.all([
      coverPalette(source.coverUrl).catch(() => []),
      source.logoUrl
        ? logoColour(source.logoUrl).catch(() => null)
        : Promise.resolve(null),
    ]).then(([cover, logo]) => (cover.length > 0 ? { cover, logo } : null));
    paletteCache.set(key, pending);
  }
  return pending;
}

function paletteSources(items: MediaItem[]): PaletteSource[] {
  const seen = new Set<string>();
  const sources: PaletteSource[] = [];
  for (const item of items) {
    if (!item.ImageTags?.Primary) continue;
    const coverUrl = getPrimaryImageUrl(item.Id, item.ImageTags.Primary, 160);
    if (seen.has(coverUrl)) continue;
    seen.add(coverUrl);
    const logoUrl = item.ImageTags.Logo
      ? getLogoImageUrl(item.Id, item.ImageTags.Logo, 400)
      : item.ParentLogoItemId && item.ParentLogoImageTag
        ? getLogoImageUrl(item.ParentLogoItemId, item.ParentLogoImageTag, 400)
        : null;
    sources.push({ coverUrl, logoUrl });
  }
  if (sources.length <= MAX_TITLES) return sources;
  const step = sources.length / MAX_TITLES;
  return Array.from(
    { length: MAX_TITLES },
    (_, index) => sources[Math.floor(index * step)]!,
  );
}

async function readAllPalettes(
  sources: PaletteSource[],
): Promise<TitlePalette[]> {
  const palettes: (TitlePalette | null)[] = new Array(sources.length).fill(
    null,
  );
  let next = 0;
  const worker = async () => {
    while (next < sources.length) {
      const index = next;
      next += 1;
      palettes[index] = await readPalette(sources[index]!);
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(SAMPLE_CONCURRENCY, sources.length) },
      worker,
    ),
  );
  return palettes.filter((palette): palette is TitlePalette => !!palette);
}

/** A stable stream of 0–1 numbers, so a shelf draws the same strands twice. */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Splits `total` strands across shares, every colour keeping at least one. */
function strandCounts(shares: number[], total: number): number[] {
  const counts = shares.map((share) => Math.max(1, Math.floor(share * total)));
  let left = total - counts.reduce((sum, count) => sum + count, 0);
  const byRemainder = shares
    .map((share, index) => ({ index, rest: share * total - counts[index]! }))
    .sort((a, b) => b.rest - a.rest);
  for (const { index } of byRemainder) {
    if (left <= 0) break;
    counts[index]! += 1;
    left -= 1;
  }
  return counts;
}

/**
 * Light, not paint: each colour is drawn as a few hairline strands, the way
 * the light breaks into ribbons in a streaming service's opening ident. A
 * strand has its own thickness, its own brightness and its own fade at each
 * end, and a soft glow of its colour around it; strands are added together
 * as light is, so where two cross they brighten. Paints at the canvas's own
 * device size, so a hairline stays a hairline.
 */
function paintBarcode(canvas: HTMLCanvasElement, palettes: TitlePalette[]) {
  const { width: cssWidth, height: cssHeight } = canvas.getBoundingClientRect();
  if (cssWidth === 0 || cssHeight === 0) return;
  const scale = window.devicePixelRatio || 1;
  canvas.width = Math.round(cssWidth * scale);
  canvas.height = Math.round(cssHeight * scale);
  const context = canvas.getContext("2d");
  if (!context) return;
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.globalCompositeOperation = "lighter";

  const height = canvas.height;
  const titleGap = Math.round(TITLE_GAP * scale);
  const titleWidth = Math.min(
    (canvas.width + titleGap) / palettes.length,
    MAX_TITLE_WIDTH * scale,
  );
  const left = (canvas.width + titleGap - titleWidth * palettes.length) / 2;
  const strandsPerTitle = Math.max(
    3,
    Math.round(titleWidth / scale / STRAND_SPACING),
  );

  // Light on black: a colour too dark to glow is raised, keeping its hue.
  const light = (rgb: Rgb) => {
    const brightest = Math.max(...rgb);
    return brightest >= DARKEST_CHANNEL
      ? rgb
      : brightest < 1
        ? ([DARKEST_CHANNEL, DARKEST_CHANNEL, DARKEST_CHANNEL] as Rgb)
        : (rgb.map(
            (channel) => (channel * DARKEST_CHANNEL) / brightest,
          ) as Rgb);
  };
  const rgba = ([r, g, b]: Rgb, alpha: number) =>
    `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${alpha})`;

  const strand = (
    x: number,
    width: number,
    rgb: Rgb,
    alpha: number,
    random: () => number,
  ) => {
    // Each end fades at its own height, so the strands never line up.
    const top = height * (0.02 + random() * 0.3);
    const bottom = height * (0.7 + random() * 0.3);
    const fadeIn = 0.18 + random() * 0.22;
    const fadeOut = 0.18 + random() * 0.22;
    const layers: [number, number][] = [
      [width * 7, alpha * 0.07],
      [width * 3, alpha * 0.18],
      [width, alpha],
    ];
    for (const [layerWidth, layerAlpha] of layers) {
      const gradient = context.createLinearGradient(0, top, 0, bottom);
      gradient.addColorStop(0, rgba(rgb, 0));
      gradient.addColorStop(fadeIn, rgba(rgb, layerAlpha));
      gradient.addColorStop(1 - fadeOut, rgba(rgb, layerAlpha));
      gradient.addColorStop(1, rgba(rgb, 0));
      context.fillStyle = gradient;
      context.fillRect(x - layerWidth / 2, top, layerWidth, bottom - top);
    }
  };

  palettes.forEach((palette, title) => {
    const random = seededRandom(title * 7919 + 17);
    const start = left + title * titleWidth;
    const span = titleWidth - titleGap;
    const colours: Swatch[] = palette.logo
      ? [
          ...palette.cover.map((swatch) => ({
            ...swatch,
            share: swatch.share * (1 - LOGO_SHARE),
          })),
          { rgb: palette.logo, share: LOGO_SHARE },
        ]
      : palette.cover;
    const counts = strandCounts(
      colours.map((colour) => colour.share),
      strandsPerTitle,
    );
    let x = start;
    colours.forEach((colour, index) => {
      const width = span * colour.share;
      const isLogo = palette.logo !== null && index === colours.length - 1;
      const rgb = light(colour.rgb);
      const count = counts[index]!;
      for (let n = 0; n < count; n += 1) {
        const step = width / count;
        const at = x + step * (n + 0.5) + (random() - 0.5) * step * 0.7;
        const thickness =
          (isLogo ? 1.6 + random() * 1.2 : 0.5 + random() ** 2 * 2.2) * scale;
        const alpha = isLogo ? 1 : 0.55 + random() * 0.45;
        strand(at, thickness, rgb, alpha, random);
      }
      x += width;
    });
  });
}

export function LibraryHeaderArt({
  items,
  compact = false,
}: {
  items: MediaItem[];
  /** The phone's header, whose titles are a quarter as wide. */
  compact?: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [isPainted, setIsPainted] = useState(false);
  const reduceMotion = useReducedMotion();
  const sources = paletteSources(items);
  const sourcesKey = JSON.stringify(sources);

  useEffect(() => {
    let isCurrent = true;
    let observer: ResizeObserver | undefined;
    const wanted = JSON.parse(sourcesKey) as PaletteSource[];
    if (wanted.length === 0) return;
    void readAllPalettes(wanted).then((palettes) => {
      const canvas = canvasRef.current;
      if (!isCurrent || !canvas || palettes.length === 0) return;
      paintBarcode(canvas, palettes);
      setIsPainted(true);
      observer = new ResizeObserver(() => paintBarcode(canvas, palettes));
      observer.observe(canvas);
    });
    return () => {
      isCurrent = false;
      observer?.disconnect();
    };
  }, [sourcesKey]);

  return (
    <div className="library-art library-art--barcode" aria-hidden="true">
      <LibraryBarcodePlaceholder
        compact={compact}
        className={isPainted ? "is-leaving" : undefined}
      />
      <div className="library-art__barcode-fade">
        <div
          className={`library-art__barcode-wipe${
            isPainted ? " is-painted" : ""
          }${reduceMotion ? " is-still" : ""}`}
        >
          <div className="library-art__barcode-reveal">
            <div className="library-art__barcode-counter">
              <canvas ref={canvasRef} className="library-art__barcode-canvas" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * The barcode before its colours: shimmering strands where the light will
 * be. The page's skeleton shows it, and the page keeps it on until the
 * palettes are read, so skeleton, page and picture are one piece.
 */
export function LibraryBarcodePlaceholder({
  compact = false,
  className,
}: {
  compact?: boolean;
  className?: string;
}) {
  return (
    <div
      aria-hidden="true"
      className={`library-art library-art__placeholder${
        compact ? " is-compact" : ""
      }${className ? ` ${className}` : ""}`}
    >
      <div className="library-art__placeholder-fade">
        <div className="shimmer library-art__placeholder-stripes" />
      </div>
    </div>
  );
}
