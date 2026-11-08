import type { TranslationKey } from "../i18n/translations";
import type { MediaItem } from "./types";

export const SEARCH_OVERLAY_OPEN_EVENT = "seyirlik:open-search";

export const MIN_SEARCH_QUERY_LENGTH = 2;
export const SEARCH_DEBOUNCE_MS = 220;

export type SearchGroupId = "movies" | "shows" | "episodes" | "books" | "other";

export interface SearchGroup {
  id: SearchGroupId;
  labelKey: TranslationKey;
  items: MediaItem[];
}

const GROUP_LABEL_KEYS: Record<SearchGroupId, TranslationKey> = {
  movies: "search.groupMovies",
  shows: "search.groupShows",
  episodes: "search.groupEpisodes",
  books: "search.groupBooks",
  other: "search.groupOther",
};

// Ordered by how often people search for each kind, so the most likely hit is
// the first thing under the cursor when the results land.
const GROUP_ORDER: SearchGroupId[] = [
  "movies",
  "shows",
  "episodes",
  "books",
  "other",
];

export function getSearchGroupId(item: MediaItem): SearchGroupId {
  switch (item.Type) {
    case "Movie":
      return "movies";
    case "Series":
      return "shows";
    case "Episode":
      return "episodes";
    case "Book":
      return "books";
    default:
      return "other";
  }
}

/** Buckets results by kind, dropping groups that matched nothing. */
export function groupSearchResults(items: MediaItem[]): SearchGroup[] {
  const buckets = new Map<SearchGroupId, MediaItem[]>();

  for (const item of items) {
    const groupId = getSearchGroupId(item);
    const bucket = buckets.get(groupId);

    if (bucket) {
      bucket.push(item);
    } else {
      buckets.set(groupId, [item]);
    }
  }

  return GROUP_ORDER.filter((groupId) => buckets.get(groupId)?.length).map(
    (groupId) => ({
      id: groupId,
      labelKey: GROUP_LABEL_KEYS[groupId],
      items: buckets.get(groupId) ?? [],
    }),
  );
}

/** Flattens groups back into the visual order, for arrow-key navigation. */
export function flattenSearchGroups(groups: SearchGroup[]): MediaItem[] {
  return groups.flatMap((group) => group.items);
}

export function isSearchableQuery(query: string): boolean {
  return query.trim().length >= MIN_SEARCH_QUERY_LENGTH;
}

export function openSearchOverlay(): void {
  if (typeof window === "undefined") {
    return;
  }

  window.dispatchEvent(new Event(SEARCH_OVERLAY_OPEN_EVENT));
}

/**
 * True for the Cmd+K / Ctrl+K chord that opens search from anywhere.
 */
export function isSearchShortcut(event: KeyboardEvent): boolean {
  return (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k";
}

/**
 * Typing into a field should never be hijacked by the shortcut-free "/" style
 * handlers, and the overlay must not open on top of an active text entry.
 */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  const tagName = target.tagName;

  return (
    tagName === "INPUT" ||
    tagName === "TEXTAREA" ||
    tagName === "SELECT" ||
    Boolean(target.isContentEditable)
  );
}

/**
 * Folds text for matching: lowercase, accents dropped, Turkish's dotless ı read
 * as i, and punctuation read as a space, so "avcisi" typed on any keyboard
 * finds "Avcısı" and "spider man" finds "Spider-Man". The same folding the
 * server's search applies (`normalizeSearchText`), except that letters outside
 * the Latin alphabet are kept rather than dropped.
 */
export function foldTitleText(value: string): string {
  return value
    .toLocaleLowerCase("tr")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/ı/g, "i")
    .replace(/ø/g, "o")
    .replace(/æ/g, "ae")
    .replace(/ß/g, "ss")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/**
 * The one rule every search box on the site matches by: each typed word must
 * appear, folded, in one of the values, in any order. Pass a title's every
 * name (`titleSearchNames`, or the `searchNames` an admin endpoint sends) next
 * to whatever else the box searches, so a title is found by the names people
 * know it by wherever they look for it, not only in the main search.
 */
export function matchesSearchText(
  query: string,
  values: Iterable<string | number | null | undefined>,
): boolean {
  const words = foldTitleText(query).split(" ").filter(Boolean);
  if (words.length === 0) return true;
  const folded: string[] = [];
  for (const value of values) {
    if (value === null || value === undefined || value === "") continue;
    folded.push(foldTitleText(String(value)));
  }
  return words.every((word) => folded.some((text) => text.includes(word)));
}

/**
 * Every name a title can be found by: the one it is shown under, its original
 * title, the provider's names in other languages, and the names an
 * administrator added. An administrator may rename a title, and it must still
 * be found by the names people know.
 */
export function titleSearchNames(item: MediaItem): string[] {
  return [
    item.Name,
    item.OriginalTitle,
    ...Object.values(item.LocalizedTitles ?? {}),
    ...(item.SearchAliases ?? []),
  ].filter((value): value is string => Boolean(value));
}

/** Whether the typed text finds a title by any of its names. */
export function matchesTitleQuery(item: MediaItem, query: string): boolean {
  return matchesSearchText(query, titleSearchNames(item));
}
