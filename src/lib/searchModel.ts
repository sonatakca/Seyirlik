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
 * Folds text for title matching: lowercase, accents dropped, and Turkish's
 * dotless ı read as i, so "avcisi" typed on any keyboard finds "Avcısı". The
 * same folding the server's search applies (`normalizeSearchText`).
 */
export function foldTitleText(value: string): string {
  return value
    .toLocaleLowerCase("tr")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/ı/g, "i")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Every name a title can be found by: the one it is shown under, its original
 * title, and the provider's names in other languages. An administrator may
 * rename a title, and it must still be found by the names people know.
 */
export function titleSearchNames(item: MediaItem): string[] {
  return [
    item.Name,
    item.OriginalTitle,
    ...Object.values(item.LocalizedTitles ?? {}),
  ].filter((value): value is string => Boolean(value));
}

/** Whether any of a title's names contains the typed text. */
export function matchesTitleQuery(item: MediaItem, query: string): boolean {
  const folded = foldTitleText(query);
  if (!folded) return true;
  return titleSearchNames(item).some((name) =>
    foldTitleText(name).includes(folded),
  );
}
