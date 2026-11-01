import { afterEach, describe, expect, it, vi } from "vitest";
import type { MediaItem } from "../../lib/types";
import {
  compareNames,
  countLabel,
  hasLibraryGroups,
  isCartoonSeries,
  libraryGroupOf,
  parseLibraryGroup,
  isWatchableScopeItem,
  isWholeWatchedScope,
  resolveLibraryCanonicalPath,
  withWatchedState,
} from "./libraryModel";

describe("libraryModel", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    [
      "override",
      "/custom",
      "library",
      "movie",
      "item-1",
      undefined,
      undefined,
      "/custom",
    ],
    [
      "movie",
      undefined,
      "library",
      "movie",
      "movie-1",
      undefined,
      undefined,
      "/movies/movie-1",
    ],
    [
      "collection",
      undefined,
      "library",
      "collection",
      "set-1",
      undefined,
      undefined,
      "/collections/set-1",
    ],
    [
      "show",
      undefined,
      "series",
      "show",
      "show-1",
      "show-1",
      undefined,
      "/shows/show-1",
    ],
    [
      "show season",
      undefined,
      "season",
      "show",
      "season-1",
      "show-1",
      "season-1",
      "/shows/show-1/season/season-1",
    ],
    [
      "legacy series",
      undefined,
      "series",
      undefined,
      "show-1",
      "show-1",
      undefined,
      "/series/show-1",
    ],
    [
      "legacy season",
      undefined,
      "season",
      undefined,
      "season-1",
      "show-1",
      "season-1",
      "/series/show-1/season/season-1",
    ],
    [
      "library",
      undefined,
      "library",
      undefined,
      "library-1",
      undefined,
      undefined,
      "/library/library-1",
    ],
    [
      "missing id",
      undefined,
      "library",
      undefined,
      undefined,
      undefined,
      undefined,
      "/home",
    ],
  ] as const)(
    "resolves the %s canonical route",
    (
      _label,
      canonicalPathOverride,
      mode,
      libraryRouteKind,
      activeId,
      seriesId,
      seasonId,
      expected,
    ) => {
      expect(
        resolveLibraryCanonicalPath({
          activeId,
          canonicalPathOverride,
          libraryRouteKind,
          mode,
          seasonId,
          seriesId,
        }),
      ).toBe(expected);
    },
  );

  it("preserves watched scope and optimistic item state semantics", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-23T08:00:00.000Z"));

    const movie = {
      Id: "movie-1",
      Name: "Movie",
      Type: "Movie",
      RunTimeTicks: 7_200_000_000,
      UserData: { Played: false, PlaybackPositionTicks: 15 },
    } as MediaItem;
    const folder = {
      Id: "folder-1",
      Name: "Folder",
      Type: "Folder",
    } as MediaItem;

    expect(isWatchableScopeItem(movie)).toBe(true);
    expect(isWatchableScopeItem(folder)).toBe(false);
    // Preserve the existing callback behavior: Array#every passes index 0 as
    // isItemCompleted's completion threshold for the first watchable item.
    expect(isWholeWatchedScope(undefined, [movie, folder])).toBe(true);

    const watchedMovie = withWatchedState(movie, true);
    expect(watchedMovie.UserData).toMatchObject({
      LastPlayedDate: "2026-07-23T08:00:00.000Z",
      PlaybackPositionTicks: 7_200_000_000,
      Played: true,
      PlayedPercentage: 100,
    });
    expect(isWholeWatchedScope(undefined, [watchedMovie, folder])).toBe(true);

    expect(withWatchedState(watchedMovie, false).UserData).toMatchObject({
      LastPlayedDate: null,
      PlaybackPositionTicks: 0,
      Played: false,
      PlayedPercentage: 0,
    });
  });

  it("preserves shared name sorting and count-label formatting", () => {
    const first = {
      Id: "2",
      Name: "Movie 10",
      SortName: "Movie 2",
    } as MediaItem;
    const second = {
      Id: "1",
      Name: "Movie 1",
      SortName: "Movie 10",
    } as MediaItem;
    const translate = (key: string) =>
      ({ singular: "One item", plural: "{count} items" })[key] ?? key;

    expect(compareNames(first, second)).toBeLessThan(0);
    expect(
      countLabel(1, "singular" as never, "plural" as never, translate as never),
    ).toBe("One item");
    expect(
      countLabel(4, "singular" as never, "plural" as never, translate as never),
    ).toBe("4 items");
  });

  describe("library groups", () => {
    const series = (Id: string, Genres?: string[]): MediaItem => ({
      Id,
      Name: Id,
      Type: "Series",
      Genres,
    });

    it("recognises animation in either metadata language", () => {
      expect(isCartoonSeries(series("a", ["Comedy", "Animation"]))).toBe(true);
      expect(isCartoonSeries(series("b", ["Animasyon"]))).toBe(true);
      expect(isCartoonSeries(series("c", ["Drama"]))).toBe(false);
      expect(isCartoonSeries(series("d"))).toBe(false);
      expect(
        isCartoonSeries({
          Id: "e",
          Name: "e",
          Type: "Movie",
          Genres: ["Animation"],
        }),
      ).toBe(false);
    });

    it("files each series under its tab", () => {
      expect(libraryGroupOf(series("arcane", ["Animation"]))).toBe("cartoons");
      expect(libraryGroupOf(series("andor", ["Drama"]))).toBe("shows");
    });

    it("offers tabs only when both kinds are on the shelf", () => {
      const andor = series("andor", ["Drama"]);
      const arcane = series("arcane", ["Animation"]);

      expect(hasLibraryGroups([andor, arcane])).toBe(true);
      expect(hasLibraryGroups([andor])).toBe(false);
      expect(hasLibraryGroups([arcane])).toBe(false);
      expect(hasLibraryGroups([])).toBe(false);
    });

    it("reads the tab from the URL, defaulting to shows", () => {
      expect(parseLibraryGroup("cartoons")).toBe("cartoons");
      expect(parseLibraryGroup("shows")).toBe("shows");
      expect(parseLibraryGroup("other")).toBe("shows");
      expect(parseLibraryGroup(null)).toBe("shows");
    });
  });
});
