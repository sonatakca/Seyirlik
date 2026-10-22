// @vitest-environment node
import { describe, expect, it } from "vitest";
import { ownedFolder } from "./importFolder";

const SERIES_ROOT = "\\\\seyirlik\\drive\\media\\Series";

describe("the folder an import's title already owns", () => {
  it("files a wanted series where its want keyed it, year and all", () => {
    expect(
      ownedFolder({
        kind: "series",
        sourceKey: "series:series/lilyhammer (2012)",
        title: "Lilyhammer",
        year: 2012,
        libraryRoot: SERIES_ROOT,
      }),
    ).toBe("Lilyhammer (2012)");
  });

  it("keeps a series in the folder it already has, spelled as on disk", () => {
    expect(
      ownedFolder({
        kind: "series",
        sourceKey: "series:series/the sopranos",
        title: "The Sopranos",
        year: 1999,
        existingPath:
          "Series/The Sopranos/Season 5/src/The Sopranos - S05E13.mkv",
        libraryRoot: SERIES_ROOT,
      }),
    ).toBe("The Sopranos");
  });

  it("follows a film whose title changed since it was wanted", () => {
    expect(
      ownedFolder({
        kind: "movie",
        sourceKey: "movie:movies/joker folie à deux (2024)",
        title: "Joker: İkili Delilik",
        year: 2024,
        existingPath:
          "Movies/Joker Folie à Deux (2024)/src/Joker Folie à Deux (2024).mkv",
        libraryRoot: "D:\\media\\Movies",
      }),
    ).toBe("Joker Folie à Deux (2024)");
  });

  it("names nothing when the letter case cannot be recovered", () => {
    expect(
      ownedFolder({
        kind: "movie",
        sourceKey: "movie:movies/joker folie à deux (2024)",
        title: "Joker: İkili Delilik",
        year: 2024,
        libraryRoot: "D:\\media\\Movies",
      }),
    ).toBeUndefined();
  });

  it("names nothing outside this import's library root", () => {
    expect(
      ownedFolder({
        kind: "series",
        sourceKey: "series:tv/lilyhammer (2012)",
        title: "Lilyhammer",
        year: 2012,
        libraryRoot: SERIES_ROOT,
      }),
    ).toBeUndefined();
  });

  it("names nothing for a key that is not a title folder", () => {
    expect(
      ownedFolder({
        kind: "episode",
        sourceKey: "episode:series/lilyhammer:1:1",
        title: "Lilyhammer",
        libraryRoot: SERIES_ROOT,
      }),
    ).toBeUndefined();
  });
});
