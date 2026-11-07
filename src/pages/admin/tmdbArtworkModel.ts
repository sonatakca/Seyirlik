import type { ArtworkCandidate, ArtworkKind } from "../../lib/artworkApi";
import type { MediaItem } from "../../lib/types";
import type { TranslationKey } from "../../i18n/translations";

/**
 * Pure decisions behind the artwork override page, kept out of the component so
 * the filtering and grouping can be tested without a browser.
 */

export const ARTWORK_KINDS: ArtworkKind[] = ["poster", "backdrop", "logo"];

/** The stored image type each provider set replaces. */
export const STORED_TYPE_BY_KIND: Record<ArtworkKind, string> = {
  poster: "cover",
  backdrop: "backdrop",
  logo: "logo",
};

/** `null` means artwork with no text, which TMDB reports as a blank language. */
/**
 * Which images a section shows: all of them, those with no text, or those in
 * one ISO 639-1 language. Any language TMDB has is a valid filter, not only
 * the two the interface is written in.
 */
export type ImageLanguageFilter = "all" | "none" | (string & {});

export function getKindLabelKey(kind: ArtworkKind): TranslationKey {
  return `tmdbArtwork.kind.${kind}` as TranslationKey;
}

export function getKindDescriptionKey(kind: ArtworkKind): TranslationKey {
  return `tmdbArtwork.kind.${kind}Description` as TranslationKey;
}

export function getCustomUploadLabelKey(kind: ArtworkKind): TranslationKey {
  return `tmdbArtwork.uploadCustom.${kind}` as TranslationKey;
}

export function getLanguageLabelKey(language: string | null): TranslationKey {
  if (language === "en") return "tmdbArtwork.language.english";
  if (language === "tr") return "tmdbArtwork.language.turkish";
  return "tmdbArtwork.language.none";
}

/**
 * Only titles can carry their own artwork. Seasons and episodes inherit it from
 * the series, so offering them here would promise something the server refuses.
 */
export function isArtworkEligible(item: MediaItem): boolean {
  return (
    item.Type === "Movie" || item.Type === "Series" || item.Type === "Book"
  );
}

export function supportsTmdbArtwork(item: MediaItem | undefined): boolean {
  return item?.Type === "Movie" || item?.Type === "Series";
}

export function filterTitles(items: MediaItem[], search: string): MediaItem[] {
  const query = search.trim().toLowerCase();
  if (!query) return items;

  return items.filter((item) => {
    const haystack = [
      item.Name,
      item.OriginalTitle,
      item.ProductionYear?.toString(),
      item.Id,
    ]
      .filter((value): value is string => Boolean(value))
      .join(" ")
      .toLowerCase();
    return haystack.includes(query);
  });
}

export function matchesLanguageFilter(
  candidate: ArtworkCandidate,
  filter: ImageLanguageFilter,
): boolean {
  if (filter === "all") return true;
  if (filter === "none") return candidate.language === null;
  return candidate.language === filter;
}

/**
 * How many candidates a set shows at first, and how many each "load more" adds.
 *
 * A popular film can have several hundred posters, and drawing them all at once
 * is megabytes of thumbnails nobody asked for. The sharpest images come first
 * (see `selectCandidates`), so the first page is the part worth seeing; the
 * rest arrives a page at a time rather than all at once or not at all.
 */
export const ARTWORK_PAGE_SIZE = 24;

/**
 * The next page boundary, never past the end. Clamping here rather than at the
 * call site is what keeps "load more" from claiming to have loaded images that
 * do not exist.
 */
export function nextVisibleCount(current: number, total: number): number {
  return Math.min(current + ARTWORK_PAGE_SIZE, total);
}

/** Pixels in an image, or 0 when the provider gave no size. */
function pixelCount(candidate: ArtworkCandidate): number {
  return candidate.width && candidate.height
    ? candidate.width * candidate.height
    : 0;
}

/**
 * One section's images, the sharpest first.
 *
 * Sorted by pixel count rather than by quality tier, so a 3000 px poster
 * still comes before a 2400 px one. The sort is stable, so images of the same
 * size keep the server's order, which is the provider's vote; images with no
 * known size come last. Sorting happens before the page limit, so "load more"
 * always reveals smaller images, never sharper ones that were held back.
 */
export function selectCandidates(
  candidates: ArtworkCandidate[],
  kind: ArtworkKind,
  filter: ImageLanguageFilter,
  limit: number = ARTWORK_PAGE_SIZE,
): ArtworkCandidate[] {
  return candidates
    .filter(
      (candidate) =>
        candidate.kind === kind && matchesLanguageFilter(candidate, filter),
    )
    .sort((a, b) => pixelCount(b) - pixelCount(a))
    .slice(0, limit);
}

export function countCandidates(
  candidates: ArtworkCandidate[],
  kind: ArtworkKind,
  filter: ImageLanguageFilter,
): number {
  return candidates.filter(
    (candidate) =>
      candidate.kind === kind && matchesLanguageFilter(candidate, filter),
  ).length;
}

export function isKindLocked(
  lockedTypes: readonly string[],
  kind: ArtworkKind,
): boolean {
  return lockedTypes.includes(STORED_TYPE_BY_KIND[kind]);
}

/**
 * Whether a stored image exists for a kind. A locked type always has one; an
 * automatic type may not, when the provider had nothing to offer.
 */
export function hasStoredArtwork(
  current: ReadonlyArray<{ imageType: string; imageIndex: number }>,
  kind: ArtworkKind,
): boolean {
  return current.some(
    (image) =>
      image.imageType === STORED_TYPE_BY_KIND[kind] && image.imageIndex === 0,
  );
}

export function getStoredArtworkTag(
  current: ReadonlyArray<{
    imageType: string;
    imageIndex: number;
    contentHash: string;
  }>,
  kind: ArtworkKind,
): string | undefined {
  return current.find(
    (image) =>
      image.imageType === STORED_TYPE_BY_KIND[kind] && image.imageIndex === 0,
  )?.contentHash;
}

export function formatDimensions(
  width: number | null,
  height: number | null,
): string {
  return width && height ? `${width} × ${height}` : "—";
}

/** Whether an image is sharp enough for where Seyirlik draws it. */
export type ArtworkQualityTone = "high" | "good" | "low";

export interface ArtworkQuality {
  readonly tone: ArtworkQualityTone;
  /**
   * A screen-resolution name for backdrops ("4K", "Full HD"), which is how
   * people already think about a full-screen picture. Posters and logos have
   * no such names, so they carry only the tone.
   */
  readonly resolution: string | null;
}

/**
 * How good one image is for its kind, judged by the edge that limits it where
 * it is drawn.
 *
 * - Backdrops fill the screen, so their width is measured against display
 *   resolutions; anything under Full HD is soft on a laptop's retina screen.
 * - Posters are tall cards, so their height counts. TMDB serves 2000 × 3000,
 *   1000 × 1500 and 500 × 750 most often; the last is visibly soft on a phone.
 * - Logos sit over the backdrop at up to roughly half the screen's width.
 *
 * `null` when the provider gave no size, since a guess would be worse than
 * saying nothing.
 */
export function artworkQuality(
  kind: ArtworkKind,
  width: number | null,
  height: number | null,
): ArtworkQuality | null {
  if (!width || !height) return null;
  if (kind === "backdrop") {
    if (width >= 3840) return { tone: "high", resolution: "4K" };
    if (width >= 2560) return { tone: "high", resolution: "2K" };
    if (width >= 1920) return { tone: "good", resolution: "Full HD" };
    if (width >= 1280) return { tone: "low", resolution: "HD" };
    return { tone: "low", resolution: "SD" };
  }
  const edge = kind === "poster" ? height : width;
  const [high, good] = kind === "poster" ? [2400, 1400] : [1000, 500];
  if (edge >= high) return { tone: "high", resolution: null };
  if (edge >= good) return { tone: "good", resolution: null };
  return { tone: "low", resolution: null };
}

export function getQualityLabelKey(tone: ArtworkQualityTone): TranslationKey {
  return `tmdbArtwork.quality.${tone}` as TranslationKey;
}

export type StatusTone = "idle" | "busy" | "success" | "error";

export interface ActionStatus {
  tone: StatusTone;
  message: string;
}

export function getStatusClasses(tone: StatusTone): string {
  if (tone === "error") return "text-rose-300";
  if (tone === "success") return "text-emerald-300";
  if (tone === "busy") return "text-sky-300";
  return "text-white/45";
}

/**
 * The server distinguishes "never identified" from "cannot have artwork", and
 * the page should say which rather than showing a bare failure.
 */
export function getArtworkErrorKey(code: unknown): TranslationKey {
  if (code === "PROVIDER_ID_MISSING") {
    return "tmdbArtwork.itemMetadataRequiresMatch";
  }
  if (code === "ARTWORK_NOT_APPLICABLE") {
    return "tmdbArtwork.artworkNotApplicable";
  }
  return "tmdbArtwork.couldNotLoadImages";
}

export interface LanguageOption {
  /** `all`, `none`, or an ISO 639-1 code. */
  readonly value: ImageLanguageFilter;
  readonly count: number;
}

/** The interface's own languages first; after them, the rest by how many images. */
const FAVOURED_LANGUAGES = ["tr", "en"];

/**
 * The languages one section's images come in, with how many of each.
 *
 * Built from what TMDB actually returned for this title and this kind, so a
 * section never offers a language it has nothing in, and a Japanese film's
 * logo section offers Japanese without anybody having listed it.
 */
export function languageOptions(
  candidates: readonly ArtworkCandidate[],
  kind: ArtworkKind,
): LanguageOption[] {
  const counts = new Map<string, number>();
  let total = 0;
  for (const candidate of candidates) {
    if (candidate.kind !== kind) continue;
    total += 1;
    const key = candidate.language ?? "none";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const rank = (code: string) => {
    const favoured = FAVOURED_LANGUAGES.indexOf(code);
    if (favoured >= 0) return favoured;
    return code === "none" ? FAVOURED_LANGUAGES.length : 99;
  };
  const languages = [...counts.entries()]
    .sort(
      ([a, countA], [b, countB]) =>
        rank(a) - rank(b) || countB - countA || a.localeCompare(b),
    )
    .map(([value, count]) => ({ value, count }));
  return [{ value: "all", count: total }, ...languages];
}

/**
 * A language's name in the interface's language: "Türkçe", "Japanese".
 *
 * `Intl.DisplayNames` knows every code TMDB uses; the code itself is the
 * fallback for one it does not.
 */
export function languageName(code: string, uiLanguage: string): string {
  try {
    const names = new Intl.DisplayNames([uiLanguage], { type: "language" });
    const name = names.of(code);
    if (name && name !== code)
      return name.charAt(0).toLocaleUpperCase(uiLanguage) + name.slice(1);
  } catch {
    // An invalid code: fall through to the code itself.
  }
  return code.toUpperCase();
}

/** What a list thumbnail needs to draw a title as its card does. */
export function titleArtworkOf(item: MediaItem): {
  coverTag: string | null;
  logoTag: string | null;
  logoLayout: NonNullable<MediaItem["LogoLayout"]> | null;
} {
  return {
    coverTag: item.ImageTags?.Primary ?? null,
    logoTag: item.ImageTags?.Logo ?? null,
    logoLayout: item.LogoLayout ?? null,
  };
}

export type TitleKindFilter = "all" | "Movie" | "Series" | "Book";

export const TITLE_KIND_FILTERS: readonly TitleKindFilter[] = [
  "all",
  "Movie",
  "Series",
  "Book",
];

export function filterByKind(
  items: readonly MediaItem[],
  kind: TitleKindFilter,
): MediaItem[] {
  return kind === "all"
    ? [...items]
    : items.filter((item) => item.Type === kind);
}
