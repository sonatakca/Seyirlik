import { describe, expect, it } from "vitest";
import type { ArtworkCandidate } from "../../lib/artworkApi";
import type { MediaItem } from "../../lib/types";
import {
  ARTWORK_PAGE_SIZE,
  artworkQuality,
  countCandidates,
  filterTitles,
  formatDimensions,
  getArtworkErrorKey,
  getCustomUploadLabelKey,
  getLanguageLabelKey,
  getStoredArtworkTag,
  hasStoredArtwork,
  isArtworkEligible,
  isKindLocked,
  nextVisibleCount,
  selectCandidates,
  supportsTmdbArtwork,
  filterByKind,
  languageName,
  languageOptions,
  titleArtworkOf,
  titleSearchNameChoices,
} from "./tmdbArtworkModel";

function candidate(
  overrides: Partial<ArtworkCandidate> = {},
): ArtworkCandidate {
  return {
    kind: "poster",
    imageType: "cover",
    filePath: "/a.jpg",
    language: "en",
    width: 2000,
    height: 3000,
    aspectRatio: 0.667,
    voteAverage: 8,
    voteCount: 40,
    previewUrl: "https://image.tmdb.org/t/p/w342/a.jpg",
    ...overrides,
  };
}

function item(overrides: Partial<MediaItem> = {}): MediaItem {
  return {
    Id: "item-1",
    Name: "Dune",
    Type: "Movie",
    ProductionYear: 2021,
    ...overrides,
  } as MediaItem;
}

describe("title selection", () => {
  it("offers only titles that can carry their own artwork", () => {
    // A season or an episode inherits the series' artwork, so listing one here
    // would promise a choice the server refuses to make.
    expect(isArtworkEligible(item())).toBe(true);
    expect(isArtworkEligible(item({ Type: "Series" }))).toBe(true);
    expect(isArtworkEligible(item({ Type: "Book" }))).toBe(true);
    expect(isArtworkEligible(item({ Type: "Season" }))).toBe(false);
    expect(isArtworkEligible(item({ Type: "Episode" }))).toBe(false);
    expect(supportsTmdbArtwork(item({ Type: "Book" }))).toBe(false);
    expect(supportsTmdbArtwork(item({ Type: "Movie" }))).toBe(true);
  });

  it("searches title, original title, year and id together", () => {
    const titles = [
      item({ Id: "a", Name: "Dune", ProductionYear: 2021 }),
      item({ Id: "b", Name: "Ezel", OriginalTitle: "Ezel" }),
      item({ Id: "c-8bb2", Name: "Arrival", ProductionYear: 2016 }),
    ];

    expect(filterTitles(titles, "dune").map((entry) => entry.Id)).toEqual([
      "a",
    ]);
    expect(filterTitles(titles, "2016").map((entry) => entry.Id)).toEqual([
      "c-8bb2",
    ]);
    expect(filterTitles(titles, "c-8bb").map((entry) => entry.Id)).toEqual([
      "c-8bb2",
    ]);
    expect(filterTitles(titles, "   ")).toHaveLength(3);
  });

  it("finds a renamed title by TMDB's names, typed without Turkish letters", () => {
    const titles = [
      item({
        Id: "wolf",
        Name: "Kurt",
        OriginalTitle: "The Wolf of Wall Street",
        LocalizedTitles: { tr: "Para Avcısı", en: "The Wolf of Wall Street" },
        ProductionYear: 2013,
      }),
      item({ Id: "dune", Name: "Dune" }),
    ];
    for (const typed of ["kurt", "para avcisi", "PARA AVCISI", "wolf of"]) {
      expect(filterTitles(titles, typed).map((entry) => entry.Id)).toEqual([
        "wolf",
      ]);
    }
  });

  it("lists the names search also finds, without repeating one", () => {
    const wolf = item({
      Name: "Kurt",
      OriginalTitle: "The Wolf of Wall Street",
      LocalizedTitles: { en: "The Wolf of Wall Street", tr: "Para Avcısı" },
    });
    expect(titleSearchNameChoices(wolf)).toEqual([
      { source: "original", value: "The Wolf of Wall Street" },
      { source: "tr", value: "Para Avcısı" },
    ]);
    // The shown title needs no reminder that it is searchable.
    expect(
      titleSearchNameChoices({ ...wolf, Name: "Para Avcısı" }).map(
        (name) => name.source,
      ),
    ).toEqual(["original"]);
    expect(titleSearchNameChoices(item({ Name: "Dune" }))).toEqual([]);
  });
});

describe("candidate filtering", () => {
  const candidates = [
    candidate({ filePath: "/en.jpg", language: "en" }),
    candidate({ filePath: "/tr.jpg", language: "tr" }),
    candidate({ filePath: "/neutral.jpg", language: null }),
    candidate({ filePath: "/wide.jpg", kind: "backdrop", language: null }),
  ];

  it("keeps each provider set separate", () => {
    expect(
      selectCandidates(candidates, "poster", "all").map(
        (entry) => entry.filePath,
      ),
    ).toEqual(["/en.jpg", "/tr.jpg", "/neutral.jpg"]);
    expect(
      selectCandidates(candidates, "backdrop", "all").map(
        (entry) => entry.filePath,
      ),
    ).toEqual(["/wide.jpg"]);
    expect(selectCandidates(candidates, "logo", "all")).toEqual([]);
  });

  it("shows the sharpest images first, whatever their vote", () => {
    const mixed = [
      candidate({ filePath: "/small.jpg", width: 500, height: 750 }),
      candidate({ filePath: "/unknown.jpg", width: null, height: null }),
      candidate({ filePath: "/large.jpg", width: 2000, height: 3000 }),
      candidate({ filePath: "/medium.jpg", width: 1000, height: 1500 }),
    ];
    expect(
      selectCandidates(mixed, "poster", "all").map((entry) => entry.filePath),
    ).toEqual(["/large.jpg", "/medium.jpg", "/small.jpg", "/unknown.jpg"]);
  });

  it("keeps the next page's images smaller than the first page's", () => {
    // Sorting after the page limit would hide a 4K backdrop behind "load more".
    const many = Array.from({ length: 30 }, (_, index) =>
      candidate({
        filePath: `/b${index}.jpg`,
        kind: "backdrop",
        width: index === 29 ? 3840 : 1280,
        height: index === 29 ? 2160 : 720,
      }),
    );
    expect(selectCandidates(many, "backdrop", "all")[0]?.filePath).toBe(
      "/b29.jpg",
    );
  });

  it("among images of one size, shows the best rated first and reveals the rest a page at a time", () => {
    // Dune has 453 posters on TMDB, so drawing them all at once is megabytes of
    // thumbnails nobody asked for — but the rest must stay reachable.
    const many = Array.from({ length: 40 }, (_, index) =>
      candidate({ filePath: `/p${index}.jpg`, voteAverage: 40 - index }),
    );

    expect(selectCandidates(many, "poster", "all")).toHaveLength(
      ARTWORK_PAGE_SIZE,
    );
    expect(selectCandidates(many, "poster", "all")[0]?.filePath).toBe(
      "/p0.jpg",
    );
    expect(countCandidates(many, "poster", "all")).toBe(40);

    const second = nextVisibleCount(ARTWORK_PAGE_SIZE, 40);
    expect(second).toBe(40);
    expect(selectCandidates(many, "poster", "all", second)).toHaveLength(40);
  });

  it("never pages past the end of a set", () => {
    // Otherwise "load more" would offer to load images that do not exist.
    expect(nextVisibleCount(ARTWORK_PAGE_SIZE, 30)).toBe(30);
    expect(nextVisibleCount(30, 30)).toBe(30);
    expect(nextVisibleCount(ARTWORK_PAGE_SIZE, 453)).toBe(
      ARTWORK_PAGE_SIZE * 2,
    );
  });

  it("treats artwork with no text as its own filter rather than a missing value", () => {
    expect(
      selectCandidates(candidates, "poster", "none").map(
        (entry) => entry.filePath,
      ),
    ).toEqual(["/neutral.jpg"]);
    expect(
      selectCandidates(candidates, "poster", "tr").map(
        (entry) => entry.filePath,
      ),
    ).toEqual(["/tr.jpg"]);
    expect(getLanguageLabelKey(null)).toBe("tmdbArtwork.language.none");
    expect(getLanguageLabelKey("tr")).toBe("tmdbArtwork.language.turkish");
  });
});

describe("stored artwork state", () => {
  it("maps a provider set onto the stored image type it replaces", () => {
    expect(isKindLocked(["cover"], "poster")).toBe(true);
    expect(isKindLocked(["cover"], "backdrop")).toBe(false);
    expect(isKindLocked(["logo", "backdrop"], "logo")).toBe(true);
  });

  it("only counts the first image of a type as the one on display", () => {
    const current = [
      { imageType: "cover", imageIndex: 0 },
      { imageType: "backdrop", imageIndex: 1 },
    ];

    expect(hasStoredArtwork(current, "poster")).toBe(true);
    // A backdrop at index 1 is an extra, not the one the detail page shows.
    expect(hasStoredArtwork(current, "backdrop")).toBe(false);
    expect(hasStoredArtwork(current, "logo")).toBe(false);
  });

  it("reads the current content hash used by card previews", () => {
    const current = [
      { imageType: "cover", imageIndex: 0, contentHash: "cover-hash" },
      { imageType: "logo", imageIndex: 0, contentHash: "logo-hash" },
      { imageType: "logo", imageIndex: 1, contentHash: "extra-logo" },
    ];

    expect(getStoredArtworkTag(current, "poster")).toBe("cover-hash");
    expect(getStoredArtworkTag(current, "logo")).toBe("logo-hash");
    expect(getStoredArtworkTag(current, "backdrop")).toBeUndefined();
  });

  it("uses a distinct upload label for every artwork slot", () => {
    expect(getCustomUploadLabelKey("poster")).toBe(
      "tmdbArtwork.uploadCustom.poster",
    );
    expect(getCustomUploadLabelKey("backdrop")).toBe(
      "tmdbArtwork.uploadCustom.backdrop",
    );
    expect(getCustomUploadLabelKey("logo")).toBe(
      "tmdbArtwork.uploadCustom.logo",
    );
  });

  it("reads unknown dimensions as a dash rather than an empty product", () => {
    expect(formatDimensions(2000, 3000)).toBe("2000 × 3000");
    expect(formatDimensions(null, 3000)).toBe("—");
    expect(formatDimensions(null, null)).toBe("—");
  });
});

describe("artwork quality", () => {
  it("names backdrops by the screen resolution they fill", () => {
    expect(artworkQuality("backdrop", 3840, 2160)).toEqual({
      tone: "high",
      resolution: "4K",
    });
    expect(artworkQuality("backdrop", 2560, 1440)?.resolution).toBe("2K");
    expect(artworkQuality("backdrop", 1920, 1080)).toEqual({
      tone: "good",
      resolution: "Full HD",
    });
    expect(artworkQuality("backdrop", 1280, 720)).toEqual({
      tone: "low",
      resolution: "HD",
    });
    expect(artworkQuality("backdrop", 780, 439)?.resolution).toBe("SD");
  });

  it("judges posters by height and logos by width", () => {
    expect(artworkQuality("poster", 2000, 3000)?.tone).toBe("high");
    expect(artworkQuality("poster", 1000, 1500)?.tone).toBe("good");
    expect(artworkQuality("poster", 500, 750)?.tone).toBe("low");
    expect(artworkQuality("logo", 1200, 300)?.tone).toBe("high");
    expect(artworkQuality("logo", 600, 150)?.tone).toBe("good");
    expect(artworkQuality("logo", 300, 80)?.tone).toBe("low");
    expect(artworkQuality("poster", 2000, 3000)?.resolution).toBeNull();
  });

  it("says nothing when the provider gave no size", () => {
    expect(artworkQuality("backdrop", null, 1080)).toBeNull();
    expect(artworkQuality("poster", 2000, null)).toBeNull();
  });
});

describe("artwork errors", () => {
  it("distinguishes never-identified from cannot-have-artwork", () => {
    // Both arrive as a failed load; telling the operator which one it is is the
    // difference between an actionable message and a shrug.
    expect(getArtworkErrorKey("PROVIDER_ID_MISSING")).toBe(
      "tmdbArtwork.itemMetadataRequiresMatch",
    );
    expect(getArtworkErrorKey("ARTWORK_NOT_APPLICABLE")).toBe(
      "tmdbArtwork.artworkNotApplicable",
    );
    expect(getArtworkErrorKey(undefined)).toBe(
      "tmdbArtwork.couldNotLoadImages",
    );
  });
});

describe("each section's own languages", () => {
  const candidate = (
    kind: "poster" | "logo",
    language: string | null,
  ): ArtworkCandidate =>
    ({
      kind,
      imageType: kind === "poster" ? "cover" : "logo",
      filePath: `/${kind}-${language}-${Math.random()}.png`,
      language,
      width: 500,
      height: 750,
      aspectRatio: 0.667,
      voteAverage: 5,
      voteCount: 1,
      previewUrl: "x",
    }) as ArtworkCandidate;

  it("offers only the languages a section has, Turkish and English first, with counts", () => {
    const pool = [
      candidate("logo", "ja"),
      candidate("logo", "ja"),
      candidate("logo", "en"),
      candidate("logo", null),
      candidate("logo", "tr"),
      candidate("poster", "de"),
    ];
    expect(languageOptions(pool, "logo")).toEqual([
      { value: "all", count: 5 },
      { value: "tr", count: 1 },
      { value: "en", count: 1 },
      { value: "none", count: 1 },
      { value: "ja", count: 2 },
    ]);
    expect(
      selectCandidates(pool, "logo", "ja").every((c) => c.language === "ja"),
    ).toBe(true);
  });

  it("names any language in the interface's language", () => {
    expect(languageName("ja", "en")).toBe("Japanese");
    expect(languageName("tr", "tr")).toBe("Türkçe");
    expect(languageName("zz-not-a-code!", "en")).toBe("ZZ-NOT-A-CODE!");
  });
});

describe("the title list", () => {
  it("draws a title from its own cover, logo and placement", () => {
    expect(
      titleArtworkOf({
        Id: "a",
        ImageTags: { Primary: "c", Logo: "l" },
        LogoLayout: { x: 0.5, y: 0.2, width: 0.6, shadow: 1 },
      } as MediaItem),
    ).toEqual({
      coverTag: "c",
      logoTag: "l",
      logoLayout: { x: 0.5, y: 0.2, width: 0.6, shadow: 1 },
    });
  });

  it("narrows to one kind of title", () => {
    const items = [
      { Id: "m", Type: "Movie" },
      { Id: "s", Type: "Series" },
      { Id: "b", Type: "Book" },
    ] as MediaItem[];
    expect(filterByKind(items, "Series").map((item) => item.Id)).toEqual(["s"]);
    expect(filterByKind(items, "all")).toHaveLength(3);
  });
});
