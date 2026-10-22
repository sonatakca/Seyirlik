import type { NavItem } from "epubjs";
import type { MediaItem } from "../../lib/types";

export type ReaderFormat =
  | "epub"
  | "pdf"
  | "text"
  | "html"
  | "image"
  | "fallback";
export type ReaderTheme = "night" | "dim" | "sepia" | "paper";
export type ReaderFace = "serif" | "sans";
export type ReaderSpotlight = "off" | "soft" | "strong";
/** What the reading light falls on: the paragraph at the reading line, or the line. */
export type ReaderLightShape = "paragraph" | "line";

export interface ReaderSettings {
  theme: ReaderTheme;
  face: ReaderFace;
  fontScale: number;
  lineHeight: number;
  width: number;
  spotlight: ReaderSpotlight;
  lightShape: ReaderLightShape;
  /** How far the light reaches from the lit paragraph, as a share of the screen. */
  paragraphReach: number;
  /** How far the light reaches from the lit line, centre to centre, as a share of the screen. */
  lineReach: number;
  /** The chapter ruler in the right margin. */
  showRuler: boolean;
  /** "Chapter ends in ≈ N min", above the ruler or at the foot on a phone. */
  showTimeLeft: boolean;
}

/**
 * Exactly where the screen stood: the first block of the book whose bottom is
 * below the top of the screen, and how far the top of the screen was below
 * that block's top, in px (negative when the space above it, a chapter
 * opener's margin, was in view).
 */
export interface ReaderPlace {
  section: number;
  block: number;
  offset: number;
}

export interface StoredReaderProgress {
  cfi?: string;
  scrollRatio?: number;
  place?: ReaderPlace;
  /**
   * When the reader moved to this place, in ms. Unlike updatedAt it does not
   * change when the same place is saved again, so it can be weighed against
   * the place another device saved.
   */
  readAt?: number;
  updatedAt: number;
}

export function isReaderPlace(value: unknown): value is ReaderPlace {
  const place = value as ReaderPlace | null;

  return (
    typeof place === "object" &&
    place !== null &&
    Number.isInteger(place.section) &&
    place.section >= 0 &&
    Number.isInteger(place.block) &&
    place.block >= 0 &&
    Number.isFinite(place.offset)
  );
}

export type ReaderProgressMap = Record<string, StoredReaderProgress>;

export type HighlightColor = "yellow" | "green" | "blue" | "pink" | "purple";

export const HIGHLIGHT_COLORS: HighlightColor[] = [
  "yellow",
  "green",
  "blue",
  "pink",
  "purple",
];

export interface ReaderBookmark {
  id: string;
  cfi: string;
  label: string;
  excerpt: string;
  progress: number | null;
  createdAt: number;
  /** When it last changed, as the server orders changes; see readerMarks. */
  changedAt?: number;
  /**
   * Set on a highlight: `cfi` is then the range it covers and `excerpt` the
   * text it marks. Highlights live in the bookmark list, so the reader finds
   * the sentences they marked beside the places they kept.
   */
  color?: HighlightColor;
}

export function isHighlight(
  bookmark: ReaderBookmark,
): bookmark is ReaderBookmark & { color: HighlightColor } {
  return bookmark.color !== undefined;
}

/** A marker's swatch, and the wash it lays behind text on a light or dark ground. */
const HIGHLIGHT_INKS: Record<
  HighlightColor,
  { swatch: string; light: string; dark: string }
> = {
  yellow: {
    swatch: "#f2c230",
    light: "rgba(250, 204, 21, 0.42)",
    dark: "rgba(242, 194, 48, 0.36)",
  },
  green: {
    swatch: "#6cc07a",
    light: "rgba(108, 192, 122, 0.38)",
    dark: "rgba(108, 192, 122, 0.38)",
  },
  blue: {
    swatch: "#64a6f0",
    light: "rgba(100, 166, 240, 0.36)",
    dark: "rgba(100, 166, 240, 0.42)",
  },
  pink: {
    swatch: "#ee7cb4",
    light: "rgba(238, 124, 180, 0.34)",
    dark: "rgba(238, 124, 180, 0.4)",
  },
  purple: {
    swatch: "#a58cf2",
    light: "rgba(165, 140, 242, 0.36)",
    dark: "rgba(165, 140, 242, 0.42)",
  },
};

export function highlightSwatch(color: HighlightColor): string {
  return HIGHLIGHT_INKS[color].swatch;
}

export function highlightWash(
  color: HighlightColor,
  scheme: "dark" | "light",
): string {
  return HIGHLIGHT_INKS[color][scheme];
}

/** The CSS Custom Highlight name a colour is painted under in a book's frames. */
export function highlightName(color: HighlightColor): string {
  return `seyirlik-highlight-${color}`;
}

export type ReaderBookmarkMap = Record<string, ReaderBookmark[]>;

export interface EpubContentView {
  document: Document;
  sectionIndex?: number;
  addClass(className: string): void;
  addStylesheetCss(css: string, key: string): unknown;
}

export const READER_SETTINGS_KEY = "seyirlik.reader.settings";
export const READER_PROGRESS_KEY = "seyirlik.reader.progress";
/** Where bookmarks were kept before the account kept them; see readerMarks. */
export const READER_BOOKMARKS_KEY = "seyirlik.reader.bookmarks";

export const READER_THEMES: ReaderTheme[] = ["night", "dim", "sepia", "paper"];
export const READER_FACES: ReaderFace[] = ["serif", "sans"];
export const READER_SPOTLIGHTS: ReaderSpotlight[] = ["off", "soft", "strong"];
export const READER_LIGHT_SHAPES: ReaderLightShape[] = ["paragraph", "line"];

export const DEFAULT_READER_SETTINGS: ReaderSettings = {
  theme: "night",
  face: "serif",
  fontScale: 100,
  lineHeight: 1.65,
  width: 66,
  spotlight: "soft",
  lightShape: "line",
  paragraphReach: 0.3,
  lineReach: 0.85,
  showRuler: true,
  showTimeLeft: true,
};

export const FONT_SCALE_STEPS = Array.from(
  { length: 14 },
  (_, index) => 80 + index * 5,
);
/** Line spacing and measure are offered as three presets; older stored values
 * outside them still apply and the nearest preset shows as selected. */
export const LINE_HEIGHT_PRESETS = [1.45, 1.65, 1.9];
export const WIDTH_PRESETS = [56, 66, 78];

/** Where the reading line sits, as a fraction of the reading viewport. */
export const READING_LINE = 0.4;
/**
 * Seven reaches for each light, narrowest first, each about half as wide
 * again as the one before. The light falls on the line by default, at the
 * sixth line reach; the paragraph light defaults to its third. The last two
 * run past the screen: at the widest the light is still falling off a screen
 * and a half away, so the page is nearly evenly lit.
 */
export const PARAGRAPH_REACH_PRESETS = [0.1, 0.2, 0.3, 0.45, 0.7, 1, 1.5];
export const LINE_REACH_PRESETS = [0.05, 0.1, 0.18, 0.3, 0.5, 0.85, 1.5];
export const SPOTLIGHT_FLOOR: Record<ReaderSpotlight, number> = {
  off: 1,
  soft: 0.4,
  strong: 0.16,
};

/** epub.js locations are generated at this many characters each. */
export const CHARS_PER_LOCATION = 1200;
/** A typical adult silent reading speed in characters, for estimates only. */
export const READING_CHARS_PER_MINUTE = 1100;

export const EPUB_PREPARATION_TIMEOUT_MS = 15000;
/** How long one epub.js display may take before opening tries the next way in. */
export const EPUB_DISPLAY_LIMIT_MS = 6000;

/**
 * epub.js uses XMLHttpRequest rather than the application's API client. The
 * deployed reader and API can live on sibling origins, so its archive request
 * must opt into sending the session cookie just like OwnApiClient does.
 *
 * epub.js' published type incorrectly declares this boolean option as an
 * object; keeping the cast here isolates that upstream type mismatch.
 */
export const EPUB_REQUEST_CREDENTIALS = true as unknown as object;

export const READER_THEME_LABEL_KEYS = {
  night: "reader.theme.night",
  dim: "reader.theme.dim",
  sepia: "reader.theme.sepia",
  paper: "reader.theme.paper",
} as const;

export const FORMAT_EXTENSIONS: Record<
  Exclude<ReaderFormat, "fallback">,
  string[]
> = {
  epub: ["epub"],
  pdf: ["pdf"],
  text: ["txt", "md", "markdown", "log", "srt", "vtt"],
  html: ["html", "htm", "xhtml"],
  image: ["jpg", "jpeg", "png", "webp", "gif", "avif"],
};

/**
 * One palette per reading light. The values are concrete colours rather than
 * Tailwind classes because the same palette also styles the book's own
 * documents inside epub.js' iframes, where the app's stylesheet never reaches.
 */
export interface ReaderPalette {
  ground: string;
  ink: string;
  ink2: string;
  ink3: string;
  ink4: string;
  hair: string;
  /** Accent for text on this ground (links); fills use the live `--accent`. */
  mark: string;
  glass: string;
  glassSolid: string;
  glassEdge: string;
  glassHighlight: string;
  lift: string;
  selection: string;
  scheme: "dark" | "light";
}

export const themePalettes: Record<ReaderTheme, ReaderPalette> = {
  night: {
    ground: "#050607",
    ink: "#e8e5de",
    ink2: "rgba(232, 229, 222, 0.66)",
    ink3: "rgba(232, 229, 222, 0.52)",
    ink4: "rgba(232, 229, 222, 0.14)",
    hair: "rgba(255, 255, 255, 0.09)",
    mark: "#7fb8a2",
    glass: "rgba(16, 17, 19, 0.72)",
    glassSolid: "rgba(20, 21, 23, 0.92)",
    glassEdge: "rgba(255, 255, 255, 0.1)",
    glassHighlight: "rgba(255, 255, 255, 0.1)",
    lift: "0 18px 60px rgba(0, 0, 0, 0.55), 0 2px 10px rgba(0, 0, 0, 0.4)",
    selection: "rgba(127, 184, 162, 0.3)",
    scheme: "dark",
  },
  dim: {
    ground: "#1b1c1e",
    ink: "#d9d6cf",
    ink2: "rgba(217, 214, 207, 0.7)",
    ink3: "rgba(217, 214, 207, 0.57)",
    ink4: "rgba(217, 214, 207, 0.15)",
    hair: "rgba(255, 255, 255, 0.1)",
    mark: "#86bba6",
    glass: "rgba(33, 34, 37, 0.74)",
    glassSolid: "rgba(36, 37, 40, 0.94)",
    glassEdge: "rgba(255, 255, 255, 0.11)",
    glassHighlight: "rgba(255, 255, 255, 0.1)",
    lift: "0 18px 60px rgba(0, 0, 0, 0.5), 0 2px 10px rgba(0, 0, 0, 0.35)",
    selection: "rgba(134, 187, 166, 0.3)",
    scheme: "dark",
  },
  sepia: {
    ground: "#efe4cf",
    ink: "#2b2218",
    ink2: "rgba(43, 34, 24, 0.8)",
    ink3: "rgba(43, 34, 24, 0.67)",
    ink4: "rgba(43, 34, 24, 0.13)",
    hair: "rgba(43, 34, 24, 0.12)",
    mark: "#2f6a57",
    glass: "rgba(246, 238, 222, 0.76)",
    glassSolid: "rgba(247, 240, 226, 0.96)",
    glassEdge: "rgba(43, 34, 24, 0.12)",
    glassHighlight: "rgba(255, 255, 255, 0.6)",
    lift: "0 18px 50px rgba(64, 44, 20, 0.18), 0 2px 8px rgba(64, 44, 20, 0.1)",
    selection: "rgba(47, 106, 87, 0.22)",
    scheme: "light",
  },
  paper: {
    ground: "#f7f6f2",
    ink: "#1c1c1b",
    ink2: "rgba(28, 28, 27, 0.75)",
    ink3: "rgba(28, 28, 27, 0.62)",
    ink4: "rgba(28, 28, 27, 0.11)",
    hair: "rgba(28, 28, 27, 0.1)",
    mark: "#2f6a57",
    glass: "rgba(250, 250, 247, 0.76)",
    glassSolid: "rgba(251, 251, 249, 0.96)",
    glassEdge: "rgba(28, 28, 27, 0.1)",
    glassHighlight: "rgba(255, 255, 255, 0.8)",
    lift: "0 18px 50px rgba(20, 20, 20, 0.12), 0 2px 8px rgba(20, 20, 20, 0.07)",
    selection: "rgba(47, 106, 87, 0.2)",
    scheme: "light",
  },
};

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function nearest(values: number[], value: number): number {
  return values.reduce((best, next) =>
    Math.abs(next - value) < Math.abs(best - value) ? next : best,
  );
}

export function isReaderTheme(value: unknown): value is ReaderTheme {
  return READER_THEMES.includes(value as ReaderTheme);
}

export function readJsonStorage<T>(key: string, fallback: T): T {
  try {
    const value = localStorage.getItem(key);
    return value ? (JSON.parse(value) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function writeJsonStorage(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage can be full or blocked; the reader keeps working without it.
  }
}

export function readStoredReaderSettings(): ReaderSettings {
  const stored = readJsonStorage<Partial<ReaderSettings>>(
    READER_SETTINGS_KEY,
    {},
  );

  return {
    theme: isReaderTheme(stored.theme)
      ? stored.theme
      : DEFAULT_READER_SETTINGS.theme,
    face: READER_FACES.includes(stored.face as ReaderFace)
      ? (stored.face as ReaderFace)
      : DEFAULT_READER_SETTINGS.face,
    fontScale:
      typeof stored.fontScale === "number"
        ? clamp(stored.fontScale, 80, 145)
        : DEFAULT_READER_SETTINGS.fontScale,
    lineHeight:
      typeof stored.lineHeight === "number"
        ? clamp(stored.lineHeight, 1.25, 2.2)
        : DEFAULT_READER_SETTINGS.lineHeight,
    width:
      typeof stored.width === "number"
        ? clamp(stored.width, 48, 96)
        : DEFAULT_READER_SETTINGS.width,
    spotlight: READER_SPOTLIGHTS.includes(stored.spotlight as ReaderSpotlight)
      ? (stored.spotlight as ReaderSpotlight)
      : DEFAULT_READER_SETTINGS.spotlight,
    lightShape: READER_LIGHT_SHAPES.includes(
      stored.lightShape as ReaderLightShape,
    )
      ? (stored.lightShape as ReaderLightShape)
      : DEFAULT_READER_SETTINGS.lightShape,
    paragraphReach:
      typeof stored.paragraphReach === "number" && stored.paragraphReach > 0
        ? clamp(stored.paragraphReach, 0.02, 1.5)
        : DEFAULT_READER_SETTINGS.paragraphReach,
    lineReach:
      typeof stored.lineReach === "number" && stored.lineReach > 0
        ? clamp(stored.lineReach, 0.02, 1.5)
        : DEFAULT_READER_SETTINGS.lineReach,
    showRuler:
      typeof stored.showRuler === "boolean"
        ? stored.showRuler
        : DEFAULT_READER_SETTINGS.showRuler,
    showTimeLeft:
      typeof stored.showTimeLeft === "boolean"
        ? stored.showTimeLeft
        : DEFAULT_READER_SETTINGS.showTimeLeft,
  };
}

export function readReaderProgress(
  itemId: string,
): StoredReaderProgress | null {
  const progress = readJsonStorage<ReaderProgressMap>(READER_PROGRESS_KEY, {});
  return progress[itemId] ?? null;
}

export function writeReaderProgress(
  itemId: string,
  nextProgress: Omit<StoredReaderProgress, "updatedAt">,
): void {
  const progress = readJsonStorage<ReaderProgressMap>(READER_PROGRESS_KEY, {});
  progress[itemId] = {
    ...progress[itemId],
    ...nextProgress,
    updatedAt: Date.now(),
  };
  writeJsonStorage(READER_PROGRESS_KEY, progress);
}

/** Minutes to read a span of generated epub.js locations. */
export function minutesForLocations(locations: number): number {
  return Math.max(
    0,
    Math.round((locations * CHARS_PER_LOCATION) / READING_CHARS_PER_MINUTE),
  );
}

export function getNormalizedExtension(value?: string): string | null {
  if (!value) {
    return null;
  }

  const cleanedValue = value.split(/[?#]/)[0]?.trim().toLowerCase() ?? "";
  const finalSegment = cleanedValue.split(/[\\/]/).pop() ?? cleanedValue;
  const extension = finalSegment.includes(".")
    ? finalSegment.slice(finalSegment.lastIndexOf(".") + 1)
    : finalSegment;
  const normalizedExtension = extension.replace(/[^a-z0-9]/g, "");

  return normalizedExtension || null;
}

export function getReaderFormat(item: MediaItem): ReaderFormat {
  const candidates = [
    item.MediaSources?.find((source) => source.Container)?.Container,
    item.MediaSources?.find((source) => source.Path)?.Path,
    item.Path,
    item.Name,
  ]
    .map(getNormalizedExtension)
    .filter((extension): extension is string => Boolean(extension));

  for (const extension of candidates) {
    for (const [format, extensions] of Object.entries(FORMAT_EXTENSIONS)) {
      if (extensions.includes(extension)) {
        return format as ReaderFormat;
      }
    }
  }

  return "fallback";
}

export function getFormatLabel(format: ReaderFormat): string {
  if (format === "fallback") {
    return "FILE";
  }

  return format.toUpperCase();
}

export function flattenToc(
  items: NavItem[],
  depth = 0,
): Array<NavItem & { depth: number }> {
  return items.flatMap((item) => [
    { ...item, depth },
    ...(item.subitems ? flattenToc(item.subitems, depth + 1) : []),
  ]);
}
