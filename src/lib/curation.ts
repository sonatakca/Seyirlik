import type { MediaItem } from "./types";

/**
 * The shelves that can carry a hand-placed order. Mirrors the server's closed
 * set in `curationRepository.ts`; a name that is not in both places is a list
 * that either nothing writes or nothing reads.
 */
export const CURATED_SURFACES = ["home-hero", "library"] as const;

export type CuratedSurface = (typeof CURATED_SURFACES)[number];

export interface CuratedEntry {
  itemId: string;
  /**
   * Keeps the title off the home page — its Latest row, or the carousel.
   * The library grid ignores it, because one list drives both and hiding a
   * title from its own library would make it unreachable.
   */
  hidden: boolean;
}

export interface CuratedList {
  surface: CuratedSurface;
  libraryId: string | null;
  updatedAt: string | null;
  entries: CuratedEntry[];
}

export function emptyCuratedList(
  surface: CuratedSurface,
  libraryId: string | null = null,
): CuratedList {
  return { surface, libraryId, updatedAt: null, entries: [] };
}

export function hasCuratedOrder(list: CuratedList | null): boolean {
  return Boolean(list && list.entries.length > 0);
}

/**
 * Places the curated titles first, in their saved order, and leaves everything
 * else behind them in whatever order the shelf already used.
 *
 * The saved order is deliberately partial. A person pins the handful of titles
 * they care about to the front; requiring them to rank all nine hundred films
 * before the first one moves would make the feature useless.
 */
export function orderItemsByCuration(
  items: MediaItem[],
  list: CuratedList | null,
): MediaItem[] {
  if (!hasCuratedOrder(list)) return items;

  const rankByItemId = new Map(
    (list as CuratedList).entries.map((entry, index) => [entry.itemId, index]),
  );
  const uncurated = rankByItemId.size;

  // A stable sort on (rank, original index): an uncurated title keeps its place
  // relative to the other uncurated ones instead of being reshuffled.
  return items
    .map((item, index) => ({
      item,
      index,
      rank: rankByItemId.get(item.Id) ?? uncurated,
    }))
    .sort((left, right) => left.rank - right.rank || left.index - right.index)
    .map(({ item }) => item);
}

/** Ids the ordering marks as hidden, for the home shelves that honour hiding. */
export function curatedHiddenIds(list: CuratedList | null): Set<string> {
  return new Set(
    (list?.entries ?? [])
      .filter((entry) => entry.hidden)
      .map((entry) => entry.itemId),
  );
}

/** Order and hiding together: what a home shelf actually renders. */
export function applyCuration(
  items: MediaItem[],
  list: CuratedList | null,
): MediaItem[] {
  const hiddenIds = curatedHiddenIds(list);
  return orderItemsByCuration(items, list).filter(
    (item) => !hiddenIds.has(item.Id),
  );
}

/** Turns the editor's working state back into entries the server can store. */
export function curatedEntriesFrom(
  orderedItems: MediaItem[],
  hiddenIds: ReadonlySet<string>,
): CuratedEntry[] {
  return orderedItems.map((item) => ({
    itemId: item.Id,
    hidden: hiddenIds.has(item.Id),
  }));
}

function hasBackdrop(item: MediaItem): boolean {
  return Boolean(
    item.BackdropImageTags?.[0] ||
    (item.ParentBackdropItemId && item.ParentBackdropImageTags?.[0]),
  );
}

function isHomeCarouselItem(item: MediaItem): boolean {
  return item.Type === "Movie" || item.Type === "Series";
}

/**
 * The carousel's default order, used wherever no hand-placed order exists.
 *
 * It ranks by how well a title will *present* rather than by what it is: the
 * hero is a full-bleed backdrop with a logo over it, and a title missing both
 * looks broken there however good it is.
 */
function scoreHomeCarouselItem(item: MediaItem): number {
  let score = 0;

  if (hasBackdrop(item)) {
    score += 100;
  } else if (item.ImageTags?.Primary) {
    score += 50;
  }

  if (item.ImageTags?.Logo) score += 20;
  if (item.Overview?.trim()) score += 15;
  if (item.Type === "Movie" || item.Type === "Series") score += 10;

  return score;
}

export function buildHomeCarouselPool(items: MediaItem[]): MediaItem[] {
  const seenItemIds = new Set<string>();

  return items
    .filter((item) => {
      if (!isHomeCarouselItem(item) || seenItemIds.has(item.Id)) return false;
      seenItemIds.add(item.Id);
      return true;
    })
    .map((item, index) => ({ item, index, score: scoreHomeCarouselItem(item) }))
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map(({ item }) => item);
}

/**
 * A partial Latest page may omit the saved opener. Keep the loading state
 * until that title arrives, or the full catalogue proves it is unavailable.
 */
export function canOpenHomeCarousel(
  items: MediaItem[],
  list: CuratedList | null,
  catalogueLoaded: boolean,
): boolean {
  const firstVisibleId = list?.entries.find((entry) => !entry.hidden)?.itemId;
  return (
    catalogueLoaded ||
    !firstVisibleId ||
    items.some((item) => item.Id === firstVisibleId)
  );
}
