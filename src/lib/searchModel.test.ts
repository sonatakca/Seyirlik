import { describe, expect, it } from "vitest";
import {
  flattenSearchGroups,
  getSearchGroupId,
  groupSearchResults,
  isSearchShortcut,
  isSearchableQuery,
  isTypingTarget,
  matchesTitleQuery,
} from "./searchModel";
import type { MediaItem } from "./types";

function item(id: string, type: MediaItem["Type"]): MediaItem {
  return { Id: id, Name: id, Type: type };
}

describe("searchModel", () => {
  it("maps item types onto search groups", () => {
    expect(getSearchGroupId(item("a", "Movie"))).toBe("movies");
    expect(getSearchGroupId(item("b", "Series"))).toBe("shows");
    expect(getSearchGroupId(item("c", "Episode"))).toBe("episodes");
    expect(getSearchGroupId(item("d", "Book"))).toBe("books");
    expect(getSearchGroupId(item("e", "BoxSet"))).toBe("other");
  });

  it("groups results in display order and drops empty groups", () => {
    const groups = groupSearchResults([
      item("book-1", "Book"),
      item("movie-1", "Movie"),
      item("episode-1", "Episode"),
      item("movie-2", "Movie"),
    ]);

    expect(groups.map((group) => group.id)).toEqual([
      "movies",
      "episodes",
      "books",
    ]);
    expect(groups[0].items.map((entry) => entry.Id)).toEqual([
      "movie-1",
      "movie-2",
    ]);
  });

  it("flattens groups into the order they are rendered in", () => {
    const groups = groupSearchResults([
      item("episode-1", "Episode"),
      item("movie-1", "Movie"),
    ]);

    expect(flattenSearchGroups(groups).map((entry) => entry.Id)).toEqual([
      "movie-1",
      "episode-1",
    ]);
  });

  it("requires at least two characters before searching", () => {
    expect(isSearchableQuery("")).toBe(false);
    expect(isSearchableQuery(" a ")).toBe(false);
    expect(isSearchableQuery("ab")).toBe(true);
  });

  it("recognises the Cmd/Ctrl+K shortcut", () => {
    expect(
      isSearchShortcut(
        new KeyboardEvent("keydown", { key: "k", metaKey: true }),
      ),
    ).toBe(true);
    expect(
      isSearchShortcut(
        new KeyboardEvent("keydown", { key: "K", ctrlKey: true }),
      ),
    ).toBe(true);
    expect(isSearchShortcut(new KeyboardEvent("keydown", { key: "k" }))).toBe(
      false,
    );
    expect(
      isSearchShortcut(
        new KeyboardEvent("keydown", { key: "j", metaKey: true }),
      ),
    ).toBe(false);
  });

  it("detects text entry targets", () => {
    expect(isTypingTarget(document.createElement("input"))).toBe(true);
    expect(isTypingTarget(document.createElement("textarea"))).toBe(true);
    expect(isTypingTarget(document.createElement("div"))).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
});

describe("matchesTitleQuery", () => {
  const wolf: MediaItem = {
    Id: "wolf",
    Name: "Kurt",
    OriginalTitle: "The Wolf of Wall Street",
    LocalizedTitles: { tr: "Para Avcısı", en: "The Wolf of Wall Street" },
  };

  it("matches the shown, original and translated names", () => {
    expect(matchesTitleQuery(wolf, "kurt")).toBe(true);
    expect(matchesTitleQuery(wolf, "Wall Street")).toBe(true);
    expect(matchesTitleQuery(wolf, "para avcısı")).toBe(true);
  });

  it("folds Turkish letters and accents both ways", () => {
    expect(matchesTitleQuery(wolf, "AVCISI")).toBe(true);
    expect(matchesTitleQuery({ Id: "a", Name: "Amélie" }, "amelie")).toBe(true);
    expect(
      matchesTitleQuery(
        { Id: "i", Name: "İstanbul Hatırası" },
        "istanbul hatirasi",
      ),
    ).toBe(true);
  });

  it("does not match a name the title does not have", () => {
    expect(matchesTitleQuery(wolf, "dune")).toBe(false);
  });
});
