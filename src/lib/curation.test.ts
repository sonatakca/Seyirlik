import { describe, expect, it } from "vitest";
import {
  applyCuration,
  canOpenHomeCarousel,
  buildHomeCarouselPool,
  curatedEntriesFrom,
  emptyCuratedList,
  hasCuratedOrder,
  orderItemsByCuration,
  type CuratedList,
} from "./curation";
import type { MediaItem } from "./types";

function item(id: string, overrides: Partial<MediaItem> = {}): MediaItem {
  return {
    Id: id,
    Name: id,
    Type: "Movie",
    ...overrides,
  } as MediaItem;
}

function listOf(
  entries: Array<[string, boolean?]>,
  surface: CuratedList["surface"] = "home-hero",
): CuratedList {
  return {
    ...emptyCuratedList(surface),
    entries: entries.map(([itemId, hidden]) => ({
      itemId,
      hidden: hidden ?? false,
    })),
  };
}

describe("orderItemsByCuration", () => {
  it("returns the items untouched when nothing is curated", () => {
    const items = [item("a"), item("b")];
    expect(orderItemsByCuration(items, null)).toBe(items);
    expect(orderItemsByCuration(items, emptyCuratedList("home-hero"))).toBe(
      items,
    );
  });

  it("places curated titles first, in their saved order", () => {
    const ordered = orderItemsByCuration(
      [item("a"), item("b"), item("c")],
      listOf([["c"], ["a"]]),
    );

    expect(ordered.map((entry) => entry.Id)).toEqual(["c", "a", "b"]);
  });

  it("keeps uncurated titles in their original relative order", () => {
    const ordered = orderItemsByCuration(
      [item("a"), item("b"), item("c"), item("d")],
      listOf([["d"]]),
    );

    expect(ordered.map((entry) => entry.Id)).toEqual(["d", "a", "b", "c"]);
  });

  it("ignores entries for titles that are not in the pool", () => {
    const ordered = orderItemsByCuration(
      [item("a"), item("b")],
      listOf([["gone"], ["b"]]),
    );

    expect(ordered.map((entry) => entry.Id)).toEqual(["b", "a"]);
  });
});

describe("applyCuration", () => {
  it("drops hidden titles and keeps the rest in order", () => {
    const shown = applyCuration(
      [item("a"), item("b"), item("c")],
      listOf([["c"], ["b", true]]),
    );

    expect(shown.map((entry) => entry.Id)).toEqual(["c", "a"]);
  });

  it("hides a title even when the ordering is otherwise unused", () => {
    const shown = applyCuration([item("a"), item("b")], listOf([["a", true]]));

    expect(shown.map((entry) => entry.Id)).toEqual(["b"]);
  });
});

describe("hasCuratedOrder", () => {
  it("is false for a missing or empty list", () => {
    expect(hasCuratedOrder(null)).toBe(false);
    expect(hasCuratedOrder(emptyCuratedList("library"))).toBe(false);
    expect(hasCuratedOrder(listOf([["a"]]))).toBe(true);
  });
});

describe("curatedEntriesFrom", () => {
  it("numbers the items by position and marks the hidden ones", () => {
    expect(curatedEntriesFrom([item("a"), item("b")], new Set(["b"]))).toEqual([
      { itemId: "a", hidden: false },
      { itemId: "b", hidden: true },
    ]);
  });
});

describe("buildHomeCarouselPool", () => {
  it("ranks titles by how well they will present, keeping ties stable", () => {
    const pool = buildHomeCarouselPool([
      item("plain"),
      item("poster", { ImageTags: { Primary: "p" } }),
      item("backdrop", { BackdropImageTags: ["b"] }),
      item("plain-two"),
    ]);

    expect(pool.map((entry) => entry.Id)).toEqual([
      "backdrop",
      "poster",
      "plain",
      "plain-two",
    ]);
  });

  it("drops episodes, books and duplicates", () => {
    const pool = buildHomeCarouselPool([
      item("movie"),
      item("episode", { Type: "Episode" }),
      item("book", { Type: "Book" }),
      item("movie"),
    ]);

    expect(pool.map((entry) => entry.Id)).toEqual(["movie"]);
  });
});

describe("home carousel opening", () => {
  it("waits for a saved opener absent from the partial catalogue", () => {
    expect(
      canOpenHomeCarousel(
        [item("ford")],
        listOf([["sopranos"], ["ford"]]),
        false,
      ),
    ).toBe(false);
  });
  it("opens as soon as the saved opener is available", () => {
    expect(
      canOpenHomeCarousel([item("sopranos")], listOf([["sopranos"]]), false),
    ).toBe(true);
  });
  it("ignores hidden entries when choosing the opener", () => {
    expect(
      canOpenHomeCarousel(
        [item("ford")],
        listOf([["hidden", true], ["ford"]]),
        false,
      ),
    ).toBe(true);
  });
  it("allows fallback when the full catalogue cannot supply the opener", () => {
    expect(
      canOpenHomeCarousel([item("ford")], listOf([["missing"]]), true),
    ).toBe(true);
  });
  it("allows an empty or failed saved ordering", () => {
    expect(canOpenHomeCarousel([item("ford")], null, false)).toBe(true);
    expect(
      canOpenHomeCarousel([item("ford")], emptyCuratedList("home-hero"), false),
    ).toBe(true);
  });
});
