import type { TranslationKey } from "../../i18n/translations";
import { formatTemplate } from "../../lib/format";
import type { MediaItem } from "../../lib/types";
import { isItemCompleted } from "../../lib/watchStatus";
import type { LibraryPageProps } from "../libraryPageTypes";

type LibraryMode = NonNullable<LibraryPageProps["mode"]>;

/**
 * `custom` is the hand-placed order saved on the server, and it is offered only
 * where one exists: a sort option that silently does nothing is worse than an
 * absent one.
 */
export type LibrarySortMode = "custom" | "name" | "year" | "latest";
type LibraryRouteKind = LibraryPageProps["libraryRouteKind"];

interface ResolveLibraryCanonicalPathOptions {
  activeId?: string;
  canonicalPathOverride?: string;
  libraryRouteKind?: LibraryRouteKind;
  mode: LibraryMode;
  seasonId?: string;
  seriesId?: string;
}

export function countLabel(
  count: number,
  singularKey: TranslationKey,
  pluralKey: TranslationKey,
  t: (key: TranslationKey) => string,
): string {
  return count === 1 ? t(singularKey) : formatTemplate(t(pluralKey), { count });
}

export function compareNames(left: MediaItem, right: MediaItem): number {
  return (left.SortName ?? left.Name).localeCompare(
    right.SortName ?? right.Name,
    undefined,
    { numeric: true },
  );
}

/** TMDB's animation genre, in either language the metadata may arrive in. */
const ANIMATION_GENRES = new Set(["animation", "animasyon"]);

export function isCartoonSeries(item: MediaItem): boolean {
  return (
    item.Type === "Series" &&
    (item.Genres ?? []).some((genre) =>
      ANIMATION_GENRES.has(genre.trim().toLocaleLowerCase("en")),
    )
  );
}

export type LibraryGroupId = "shows" | "cartoons";

/** The tabs a shelf of series splits into, live-action shows first. */
export const LIBRARY_GROUPS: ReadonlyArray<{
  id: LibraryGroupId;
  titleKey: TranslationKey;
}> = [
  { id: "shows", titleKey: "library.group.shows" },
  { id: "cartoons", titleKey: "library.group.cartoons" },
];

export function libraryGroupOf(item: MediaItem): LibraryGroupId {
  return isCartoonSeries(item) ? "cartoons" : "shows";
}

/**
 * Tabs only help a shelf that holds both kinds. Decided on the whole library,
 * not on a search, so the tabs stay put while someone types.
 */
export function hasLibraryGroups(items: MediaItem[]): boolean {
  return (
    items.some(isCartoonSeries) &&
    items.some((item) => !isCartoonSeries(item))
  );
}

/** An unknown or missing `?group=` value falls back to the first tab. */
export function parseLibraryGroup(value: string | null): LibraryGroupId {
  return value === "cartoons" ? "cartoons" : "shows";
}

export function resolveLibraryCanonicalPath({
  activeId,
  canonicalPathOverride,
  libraryRouteKind,
  mode,
  seasonId,
  seriesId,
}: ResolveLibraryCanonicalPathOptions): string {
  return (
    canonicalPathOverride ??
    (libraryRouteKind === "movie" && activeId
      ? `/movies/${activeId}`
      : libraryRouteKind === "collection" && activeId
        ? `/collections/${activeId}`
        : libraryRouteKind === "show" && mode === "series" && activeId
          ? `/shows/${activeId}`
          : libraryRouteKind === "show" &&
              mode === "season" &&
              seriesId &&
              seasonId
            ? `/shows/${seriesId}/season/${seasonId}`
            : libraryRouteKind === "show" && mode === "season" && seasonId
              ? `/shows/season/${seasonId}`
              : mode === "series" && seriesId
                ? `/series/${seriesId}`
                : mode === "season" && seriesId && seasonId
                  ? `/series/${seriesId}/season/${seasonId}`
                  : mode === "season" && seasonId
                    ? `/season/${seasonId}`
                    : activeId
                      ? `/library/${activeId}`
                      : "/home")
  );
}

export function isWatchableScopeItem(item: MediaItem): boolean {
  return (
    item.Type === "Episode" ||
    item.Type === "Season" ||
    item.Type === "Movie" ||
    item.MediaType === "Video"
  );
}

export function isWholeWatchedScope(
  library: MediaItem | undefined,
  items: MediaItem[],
): boolean {
  if (library && isItemCompleted(library)) {
    return true;
  }

  const watchableItems = items.filter(isWatchableScopeItem);

  return watchableItems.length > 0 && watchableItems.every(isItemCompleted);
}

export function withWatchedState(item: MediaItem, watched: boolean): MediaItem {
  return {
    ...item,
    UserData: {
      ...(item.UserData ?? {}),
      PlaybackPositionTicks: watched
        ? (item.RunTimeTicks ?? item.UserData?.PlaybackPositionTicks ?? 0)
        : 0,
      PlayedPercentage: watched ? 100 : 0,
      Played: watched,
      LastPlayedDate: watched ? new Date().toISOString() : null,
    },
  };
}
