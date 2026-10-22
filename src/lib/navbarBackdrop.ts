import { useEffect, useSyncExternalStore } from "react";
import { readIsMobileView } from "../hooks/useIsMobileView";
import { relativeLuminance } from "./logoShadow";

/**
 * The picture the navbar stands on, when one does: a hero's stage artwork,
 * shown `object-fit: cover` in a box under the bar. The hero that owns the
 * stage registers it; the navbar wordmark measures the part of it behind its
 * own letters to decide how much shadow they need.
 */
export interface NavbarBackdrop {
  /** The artwork, at any size: only its brightness is read. */
  url: string;
  /** The box the artwork covers at rest, in viewport px. */
  getBox: () => DOMRect;
  /** Its `object-position`, as shares of the overflow on each axis. */
  position: { x: number; y: number };
}

const owners: { key: symbol; backdrop: NavbarBackdrop }[] = [];
const listeners = new Set<() => void>();
let current: NavbarBackdrop | null = null;

function publish() {
  current = owners.at(-1)?.backdrop ?? null;
  listeners.forEach((listener) => listener());
}

/** Registers `backdrop` while mounted; the latest registered one is current. */
export function useRegisterNavbarBackdrop(backdrop: NavbarBackdrop | null) {
  useEffect(() => {
    if (!backdrop) return;
    const entry = { key: Symbol("navbar-backdrop"), backdrop };
    owners.push(entry);
    publish();
    return () => {
      owners.splice(owners.indexOf(entry), 1);
      publish();
    };
  }, [backdrop]);
}

export function useNavbarBackdrop(): NavbarBackdrop | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => current,
    () => null,
  );
}

/**
 * A light black veil along a stage's top edge, under the navbar only: it
 * fades out a little below the bar's contents, eased so no line marks where
 * it ends.
 * Stops are [share of the veil's height, alpha].
 */
const VEIL_STOPS = [
  [0, 0.45],
  [0.25, 0.38],
  [0.5, 0.24],
  [0.72, 0.11],
  [0.88, 0.04],
  [1, 0],
] as const;

/**
 * The veil's height in px, from the stage's top edge (8px below the
 * viewport's). The desktop bar's contents end 64px down it, the tablet's
 * 46px; tall enough that their lower half still stands on its stronger part.
 */
export function navbarVeilHeight(isMobileView: boolean): number {
  return isMobileView ? 108 : 144;
}

export function navbarVeilGradient(height: number): string {
  const stops = VEIL_STOPS.map(
    ([at, alpha]) => `rgba(0,0,0,${alpha}) ${Math.round(at * height)}px`,
  );
  return `linear-gradient(180deg, ${stops.join(", ")})`;
}

/** The veil's alpha at `y` px below the stage's top edge. */
export function navbarVeilAlpha(y: number, height: number): number {
  const at = y / height;
  if (at <= 0) return VEIL_STOPS[0][1];
  for (let index = 1; index < VEIL_STOPS.length; index++) {
    const [x1, a1] = VEIL_STOPS[index]!;
    if (at <= x1) {
      const [x0, a0] = VEIL_STOPS[index - 1]!;
      return a0 + ((a1 - a0) * (at - x0)) / (x1 - x0);
    }
  }
  return 0;
}

/** A rectangle in viewport px. */
export interface ViewportRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

const SAMPLE_COLUMNS = 24;
const SAMPLE_ROWS = 10;
const cache = new Map<string, Promise<number[] | null>>();

/**
 * Luminances of the artwork as shown under `target`, on a small grid, or null
 * when it cannot be read or does not reach there. Read through `fetch`, as
 * the logo shadows are, so a CORS image never taints the canvas.
 */
export function measureBackdropUnder(
  backdrop: NavbarBackdrop,
  target: ViewportRect,
): Promise<number[] | null> {
  const box = backdrop.getBox();
  // Relative to the box, so scrolling the box under the bar keeps the key.
  const rel = {
    left: Math.round(target.left - box.left),
    top: Math.round(target.top - box.top),
    width: Math.round(target.width),
    height: Math.round(target.height),
  };
  const veil = navbarVeilHeight(readIsMobileView());
  const key = [
    backdrop.url,
    veil,
    Math.round(box.width),
    Math.round(box.height),
    backdrop.position.x,
    backdrop.position.y,
    rel.left,
    rel.top,
    rel.width,
    rel.height,
  ].join("|");
  const cached = cache.get(key);
  if (cached) return cached;
  const measured = readCover(backdrop, box, rel, veil).catch(() => null);
  cache.set(key, measured);
  return measured;
}

async function readCover(
  { url, position }: NavbarBackdrop,
  box: DOMRect,
  rel: ViewportRect,
  veil: number,
): Promise<number[] | null> {
  const response = await fetch(url, { credentials: "include" });
  if (!response.ok) return null;
  const bitmap = await createImageBitmap(await response.blob());
  try {
    // Where the box's px fall on the image under object-fit: cover.
    const scale = Math.max(
      box.width / bitmap.width,
      box.height / bitmap.height,
    );
    const offsetX = (box.width - bitmap.width * scale) * position.x;
    const offsetY = (box.height - bitmap.height * scale) * position.y;
    const sx = (rel.left - offsetX) / scale;
    const sy = (rel.top - offsetY) / scale;
    const sw = rel.width / scale;
    const sh = rel.height / scale;
    const x0 = Math.max(0, sx);
    const y0 = Math.max(0, sy);
    const x1 = Math.min(bitmap.width, sx + sw);
    const y1 = Math.min(bitmap.height, sy + sh);
    if (x1 - x0 < 1 || y1 - y0 < 1) return null;
    const canvas = document.createElement("canvas");
    canvas.width = SAMPLE_COLUMNS;
    canvas.height = SAMPLE_ROWS;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return null;
    context.drawImage(
      bitmap,
      x0,
      y0,
      x1 - x0,
      y1 - y0,
      0,
      0,
      SAMPLE_COLUMNS,
      SAMPLE_ROWS,
    );
    const { data } = context.getImageData(0, 0, SAMPLE_COLUMNS, SAMPLE_ROWS);
    // Seen through the stage's veil, which darkens the artwork in sRGB.
    const values: number[] = [];
    for (let index = 0; index < data.length; index += 4) {
      const row = Math.floor(index / 4 / SAMPLE_COLUMNS);
      const y = rel.top + ((row + 0.5) * rel.height) / SAMPLE_ROWS;
      const keep = 1 - navbarVeilAlpha(y, veil);
      values.push(
        relativeLuminance(
          data[index]! * keep,
          data[index + 1]! * keep,
          data[index + 2]! * keep,
        ),
      );
    }
    return values;
  } finally {
    bitmap.close();
  }
}
