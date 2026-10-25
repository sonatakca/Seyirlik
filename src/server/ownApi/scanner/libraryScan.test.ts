import { describe, expect, it } from "vitest";
import {
  scanLibraryTree,
  type ScannedItem,
  type ScannerFileSystem,
} from "./libraryScan";

/**
 * Tree fixture: keys are directory paths relative to the media root, values are
 * their entries. A trailing "/" marks a directory entry.
 */
function createFileSystem(
  tree: Record<string, string[]>,
  sizes: Record<string, number> = {},
  contents: Record<string, string> = {},
): ScannerFileSystem {
  const knownFiles = new Set<string>([
    ...Object.keys(sizes),
    ...Object.keys(contents),
  ]);
  for (const [directory, entries] of Object.entries(tree)) {
    for (const entry of entries) {
      if (!entry.endsWith("/")) knownFiles.add(`${directory}/${entry}`);
    }
  }

  return {
    readDirectory: async (relativePath) => {
      const entries = tree[relativePath];
      if (!entries) throw new Error(`missing directory ${relativePath}`);
      return entries.map((entry) => ({
        name: entry.replace(/\/$/, ""),
        isDirectory: entry.endsWith("/"),
      }));
    },
    readTextFile: async (relativePath) => {
      const content = contents[relativePath];
      if (content === undefined)
        throw new Error(`missing file ${relativePath}`);
      return content;
    },
    statFile: async (relativePath) => {
      if (!knownFiles.has(relativePath)) {
        throw new Error(`missing file ${relativePath}`);
      }
      return {
        size:
          sizes[relativePath] ??
          (contents[relativePath] === undefined
            ? 1_000
            : Buffer.byteLength(contents[relativePath])),
        mtimeMs: 1_700_000_000_000,
      };
    },
  };
}

function titlePackageFixture(titleDirectory: string): {
  tree: Record<string, string[]>;
  sizes: Record<string, number>;
  contents: Record<string, string>;
} {
  const manifestPath = `${titleDirectory}/.seyirlik/package.json`;
  const buildRecordPath = `${titleDirectory}/.seyirlik/build.json`;
  const video = [
    {
      id: "1080p",
      mediaPath: "video/1080p.mp4",
      playlistPath: ".seyirlik/video/1080p.m3u8",
      fileSizeBytes: 20_000,
    },
  ];
  const audio = [
    {
      id: "audio-0",
      mediaPath: "audio/English.m4a",
      playlistPath: ".seyirlik/audio/English.m3u8",
      fileSizeBytes: 2_000,
    },
  ];
  const manifest = JSON.stringify({
    schemaVersion: 1,
    profileVersion: "test",
    sourceFingerprint: "source-fingerprint",
    createdAt: "2026-08-31T00:00:00.000Z",
    sourceDurationSeconds: 9_000,
    masterPlaylistPath: ".seyirlik/master.m3u8",
    video,
    audio,
    subtitle: [],
    storage: { totalBytes: 22_000 },
  });
  const buildRecord = JSON.stringify({
    profileVersion: "test",
    sourceFingerprint: "source-fingerprint",
    createdAt: "2026-08-31T00:00:00.000Z",
    sourceDurationSeconds: 9_000,
    masterPlaylistPath: ".seyirlik/master.m3u8",
    videoRenditions: video,
    audioRenditions: audio,
    subtitleRenditions: [],
  });
  return {
    tree: {
      Movies: [`${titleDirectory.split("/").pop()}/`],
      [titleDirectory]: ["video/", "audio/", ".seyirlik/"],
    },
    sizes: {
      [`${titleDirectory}/.seyirlik/master.m3u8`]: 200,
      [`${titleDirectory}/.seyirlik/video/1080p.m3u8`]: 100,
      [`${titleDirectory}/.seyirlik/audio/English.m3u8`]: 100,
      [`${titleDirectory}/video/1080p.mp4`]: 20_000,
      [`${titleDirectory}/audio/English.m4a`]: 2_000,
    },
    contents: {
      [manifestPath]: manifest,
      [buildRecordPath]: buildRecord,
    },
  };
}

function byKind(items: ScannedItem[], kind: string): ScannedItem[] {
  return items.filter((item) => item.kind === kind);
}

describe("scanLibraryTree — movies", () => {
  it("recognizes a complete rendition package after its source is removed", async () => {
    const fixture = titlePackageFixture("Movies/Ford v Ferrari (2019)");
    const result = await scanLibraryTree({
      fileSystem: createFileSystem(
        fixture.tree,
        fixture.sizes,
        fixture.contents,
      ),
      rootPath: "Movies",
      kind: "movies",
    });

    expect(byKind(result.items, "movie")).toEqual([
      expect.objectContaining({
        sourceKey: "movie:movies/ford v ferrari (2019)",
        title: "Ford v Ferrari",
        year: 2019,
        files: [],
        renditionBacked: true,
        packageDirectory: "Movies/Ford v Ferrari (2019)",
      }),
    ]);
  });

  it("does not recognize a rendition package with a missing published asset", async () => {
    const fixture = titlePackageFixture("Movies/Ford v Ferrari (2019)");
    delete fixture.sizes["Movies/Ford v Ferrari (2019)/audio/English.m4a"];

    const result = await scanLibraryTree({
      fileSystem: createFileSystem(
        fixture.tree,
        fixture.sizes,
        fixture.contents,
      ),
      rootPath: "Movies",
      kind: "movies",
    });

    expect(byKind(result.items, "movie")).toHaveLength(0);
  });

  it("treats a title folder as one movie and picks the largest file first", async () => {
    const fileSystem = createFileSystem(
      {
        Movies: ["The Matrix (1999)/"],
        "Movies/The Matrix (1999)": [
          "The Matrix (1999) - 2160p.mkv",
          "The Matrix (1999) - 1080p.mkv",
          "The Matrix (1999).en.srt",
        ],
      },
      {
        "Movies/The Matrix (1999)/The Matrix (1999) - 2160p.mkv": 60_000,
        "Movies/The Matrix (1999)/The Matrix (1999) - 1080p.mkv": 10_000,
      },
    );

    const result = await scanLibraryTree({
      fileSystem,
      rootPath: "Movies",
      kind: "movies",
    });

    const movies = byKind(result.items, "movie");
    expect(movies).toHaveLength(1);
    expect(movies[0]).toMatchObject({ title: "The Matrix", year: 1999 });
    expect(movies[0]?.files.map((file) => file.relativePath)).toEqual([
      "Movies/The Matrix (1999)/The Matrix (1999) - 2160p.mkv",
      "Movies/The Matrix (1999)/The Matrix (1999) - 1080p.mkv",
    ]);
  });

  it("describes a matching Turkish SRT as an external text stream", async () => {
    const result = await scanLibraryTree({
      fileSystem: createFileSystem({
        Movies: ["Ford v Ferrari (2019)/"],
        "Movies/Ford v Ferrari (2019)": [
          "Ford v Ferrari (2019) [359724].mp4",
          "Ford v Ferrari (2019) [359724].tr.srt",
        ],
      }),
      rootPath: "Movies",
      kind: "movies",
    });

    expect(byKind(result.items, "movie")[0]?.subtitles).toEqual([
      {
        relativePath:
          "Movies/Ford v Ferrari (2019)/Ford v Ferrari (2019) [359724].tr.srt",
        codec: "subrip",
        isText: true,
        language: "tr",
        isForced: false,
        isDefault: false,
      },
    ]);
  });

  it("matches a sidecar whose release name ends in words that look like languages", async () => {
    // `…HDR-Ben.The.Men.tur.vtt`: peeling suffixes off the end took `The`
    // and `Men` for language codes too, so the installed Turkish subtitle
    // seemed to belong to no video and never reached a picker.
    const video = "Obsession.2025.2026.2160p.UHD.BluRay.DV.HDR-Ben.The.Men";
    const result = await scanLibraryTree({
      fileSystem: createFileSystem({
        Movies: ["Obsession (2025)/"],
        "Movies/Obsession (2025)": [`${video}.mp4`, `${video}.tur.vtt`],
      }),
      rootPath: "Movies",
      kind: "movies",
    });

    expect(byKind(result.items, "movie")[0]?.subtitles).toEqual([
      {
        relativePath: `Movies/Obsession (2025)/${video}.tur.vtt`,
        codec: "webvtt",
        isText: true,
        language: "tur",
        isForced: false,
        isDefault: false,
      },
    ]);
  });

  it("does not merge different titles that share a folder", async () => {
    const fileSystem = createFileSystem({
      Movies: ["Boxset/"],
      "Movies/Boxset": ["Alien (1979).mkv", "Aliens (1986).mkv"],
    });

    const result = await scanLibraryTree({
      fileSystem,
      rootPath: "Movies",
      kind: "movies",
    });

    expect(
      byKind(result.items, "movie")
        .map((item) => item.title)
        .sort(),
    ).toEqual(["Alien", "Aliens"]);
  });

  it("treats each loose file at the library root as its own movie", async () => {
    const fileSystem = createFileSystem({
      Movies: ["Arrival (2016).mkv", "Sicario (2015).mkv"],
    });

    const result = await scanLibraryTree({
      fileSystem,
      rootPath: "Movies",
      kind: "movies",
    });

    expect(byKind(result.items, "movie")).toHaveLength(2);
  });

  it("attaches trailers to their movie and skips extras and samples", async () => {
    const fileSystem = createFileSystem({
      Movies: ["Dune (2021)/"],
      "Movies/Dune (2021)": [
        "Dune (2021).mkv",
        "Dune-trailer.mkv",
        "sample.mkv",
        "Extras/",
      ],
      "Movies/Dune (2021)/Extras": ["Behind the scenes.mkv"],
    });

    const result = await scanLibraryTree({
      fileSystem,
      rootPath: "Movies",
      kind: "movies",
    });

    expect(byKind(result.items, "movie")).toHaveLength(1);
    const trailers = byKind(result.items, "trailer");
    expect(trailers).toHaveLength(1);
    expect(trailers[0]?.parentSourceKey).toBe(
      byKind(result.items, "movie")[0]?.sourceKey,
    );
    expect(result.skipped.some((skip) => skip.reason === "sample")).toBe(true);
  });

  it("attaches every video in content/trailers without scanning content as titles", async () => {
    const fileSystem = createFileSystem({
      Movies: ["Dune (2021)/"],
      "Movies/Dune (2021)": ["Dune (2021).mkv", "content/"],
      "Movies/Dune (2021)/content/trailers": [
        "official-teaser.mp4",
        "sample.mkv",
      ],
    });

    const result = await scanLibraryTree({
      fileSystem,
      rootPath: "Movies",
      kind: "movies",
    });

    expect(byKind(result.items, "movie")).toHaveLength(1);
    expect(byKind(result.items, "trailer")).toEqual([
      expect.objectContaining({
        files: [
          expect.objectContaining({
            relativePath:
              "Movies/Dune (2021)/content/trailers/official-teaser.mp4",
          }),
        ],
      }),
    ]);
    expect(result.items.some((item) => item.title === "official teaser")).toBe(
      false,
    );
  });

  it("keeps identifiers stable when a file is re-encoded into another container", async () => {
    const before = await scanLibraryTree({
      fileSystem: createFileSystem({
        Movies: ["Heat (1995)/"],
        "Movies/Heat (1995)": ["Heat (1995).avi"],
      }),
      rootPath: "Movies",
      kind: "movies",
    });
    const after = await scanLibraryTree({
      fileSystem: createFileSystem({
        Movies: ["Heat (1995)/"],
        "Movies/Heat (1995)": ["Heat (1995).mkv"],
      }),
      rootPath: "Movies",
      kind: "movies",
    });

    expect(before.items[0]?.sourceKey).toBe(after.items[0]?.sourceKey);
  });
});

describe("scanLibraryTree — series", () => {
  it("builds series, seasons and episodes from season folders", async () => {
    const fileSystem = createFileSystem({
      Shows: ["Breaking Bad (2008)/"],
      "Shows/Breaking Bad (2008)": ["Season 01/", "Season 02/", "Extras/"],
      "Shows/Breaking Bad (2008)/Season 01": [
        "Breaking Bad - S01E01 - Pilot.mkv",
        "Breaking Bad - S01E02 - Cat's in the Bag.mkv",
      ],
      "Shows/Breaking Bad (2008)/Season 02": [
        "Breaking Bad - S02E01 - Seven Thirty-Seven.mkv",
      ],
      "Shows/Breaking Bad (2008)/Extras": ["Blooper.mkv"],
    });

    const result = await scanLibraryTree({
      fileSystem,
      rootPath: "Shows",
      kind: "series",
    });

    const series = byKind(result.items, "series");
    expect(series).toHaveLength(1);
    expect(series[0]).toMatchObject({ title: "Breaking Bad", year: 2008 });

    const seasons = byKind(result.items, "season");
    expect(seasons.map((season) => season.indexNumber).sort()).toEqual([1, 2]);

    const episodes = byKind(result.items, "episode");
    expect(episodes).toHaveLength(3);
    expect(episodes[0]).toMatchObject({
      title: "Pilot",
      indexNumber: 1,
      parentIndexNumber: 1,
      seriesSourceKey: series[0]?.sourceKey,
    });
  });

  /*
   * Imported files are named by number alone. The scan still has to name the
   * episode, but it must say the name is a stand-in, so it never replaces the
   * provider's title on an episode the catalogue already knows.
   */
  it("marks a title it had to invent, and only that one", async () => {
    const fileSystem = createFileSystem({
      Series: ["The Sopranos/"],
      "Series/The Sopranos": ["Season 1/"],
      "Series/The Sopranos/Season 1": [
        "src/",
        "The Sopranos - S01E02/",
        "The Sopranos - S01E04 - Meadowlands.mkv",
      ],
      "Series/The Sopranos/Season 1/src": ["The Sopranos - S01E01.mkv"],
      "Series/The Sopranos/Season 1/The Sopranos - S01E02": [".seyirlik/"],
      "Series/The Sopranos/Season 1/The Sopranos - S01E02/.seyirlik": [
        "package.json",
      ],
    });

    const result = await scanLibraryTree({
      fileSystem,
      rootPath: "Series",
      kind: "series",
    });

    const episodes = byKind(result.items, "episode");
    const byNumber = (n: number) =>
      episodes.find((episode) => episode.indexNumber === n);
    expect(byNumber(1)).toMatchObject({
      title: "Episode 1",
      titleIsPlaceholder: true,
    });
    expect(byNumber(4)?.title).toBe("Meadowlands");
    expect(byNumber(4)?.titleIsPlaceholder).toBeUndefined();
  });

  /*
   * Everything in a real show folder that is not an episode.
   *
   * `trailers/` and `Backdrops/` are extra directories, a `*-thumb.jpg` and a
   * `.nfo` are not video, and a `*.trickplay/` folder holds only tiles. None
   * of them may become a processing candidate, and the place that has to be
   * true is here — before the catalogue, not in a filter over it.
   */
  it("catalogues no episode for trailers, themes, trickplay or artwork", async () => {
    const fileSystem = createFileSystem({
      Shows: ["Andor/"],
      "Shows/Andor": ["tvshow.nfo", "Season 1/", "trailers/", "Backdrops/"],
      "Shows/Andor/Season 1": [
        "Andor - S01E01 - Kassa.mp4",
        "Andor - S01E01 - Kassa.nfo",
        "Andor - S01E01 - Kassa.tr.srt",
        "Andor - S01E01 - Kassa-thumb.jpg",
        "Andor - S01E01 - Kassa.trickplay/",
        "season.nfo",
      ],
      "Shows/Andor/Season 1/Andor - S01E01 - Kassa.trickplay": [
        "320.jpg",
        "320.bif",
      ],
      "Shows/Andor/trailers": ["Andor - Trailer.mp4"],
      "Shows/Andor/Backdrops": ["theme.mp4"],
    });

    const result = await scanLibraryTree({
      fileSystem,
      rootPath: "Shows",
      kind: "series",
    });

    const episodes = byKind(result.items, "episode");
    expect(episodes).toHaveLength(1);
    expect(episodes[0]).toMatchObject({ indexNumber: 1, parentIndexNumber: 1 });

    const everyPath = result.items.flatMap((item) =>
      item.files.map((file) => file.relativePath),
    );
    expect(everyPath).not.toContain("Shows/Andor/trailers/Andor - Trailer.mp4");
    expect(everyPath).not.toContain("Shows/Andor/Backdrops/theme.mp4");
    expect(everyPath.some((entry) => entry.includes(".trickplay"))).toBe(false);
  });

  /*
   * The managed trickplay directory is title-owned generated content, like
   * `video/` and `audio/` beside it. Its sheets are JPEGs rather than video, so
   * nothing here would have become an item — but the point is that the scanner
   * does not walk into it at all, for the same reason and through the same
   * exclusion list as every other generated directory.
   */
  it("never walks into a title's managed trickplay directory", async () => {
    const fileSystem = createFileSystem({
      Shows: ["Andor/"],
      "Shows/Andor": ["Season 1/"],
      "Shows/Andor/Season 1": ["src/", "Andor - S01E01 - Kassa/"],
      "Shows/Andor/Season 1/src": ["Andor - S01E01 - Kassa.mp4"],
      "Shows/Andor/Season 1/Andor - S01E01 - Kassa": [
        "trickplay/",
        // A staging directory left by an interrupted generation. Hidden, so it
        // is ignored before the exclusion list is even consulted.
        ".trickplay-publish-abc/",
      ],
      "Shows/Andor/Season 1/Andor - S01E01 - Kassa/trickplay": [
        "sprite_0.jpg",
        "sprite_1.jpg",
      ],
      "Shows/Andor/Season 1/Andor - S01E01 - Kassa/.trickplay-publish-abc": [
        "sprite_0.jpg",
      ],
    });

    const result = await scanLibraryTree({
      fileSystem,
      rootPath: "Shows",
      kind: "series",
    });

    const everyPath = result.items.flatMap((item) =>
      item.files.map((file) => file.relativePath),
    );
    expect(everyPath.some((entry) => entry.includes("sprite_"))).toBe(false);
    expect(everyPath.some((entry) => entry.includes("/trickplay/"))).toBe(
      false,
    );
    expect(
      everyPath.some((entry) => entry.includes(".trickplay-publish")),
    ).toBe(false);
    // The episode itself is still catalogued, from its source in `src/`.
    expect(byKind(result.items, "episode")).toHaveLength(1);
  });

  it("keeps two containers of one episode as one episode's alternates", async () => {
    const fileSystem = createFileSystem({
      Shows: ["House of the Dragon/"],
      "Shows/House of the Dragon": ["Season 3/"],
      "Shows/House of the Dragon/Season 3": [
        "House of the Dragon - S03E05 - Unbowed and Unbent.mkv",
        "House of the Dragon - S03E05 - Unbowed and Unbent.mp4",
      ],
    });

    const result = await scanLibraryTree({
      fileSystem,
      rootPath: "Shows",
      kind: "series",
    });

    const episodes = byKind(result.items, "episode");
    expect(episodes).toHaveLength(1);
    expect(episodes[0]!.files).toHaveLength(2);
  });

  /*
   * The television half of what the movie suite already proves: a processed
   * title whose source has been removed must not disappear from the catalogue,
   * because the catalogue row is the package's only playback identity.
   */
  it("recognises an episode package whose source has been removed", async () => {
    const packageDirectory = "Shows/Andor/Season 1/Andor - S01E01 - Kassa";
    const fixture = titlePackageFixture(packageDirectory);
    const fileSystem = createFileSystem(
      {
        ...fixture.tree,
        Shows: ["Andor/"],
        "Shows/Andor": ["Season 1/"],
        "Shows/Andor/Season 1": [
          "Andor - S01E01 - Kassa/",
          "Andor - S01E01 - Kassa.tr.srt",
          "Andor - S01E02 - That Would Be Me.mp4",
        ],
        [packageDirectory]: ["video/", "audio/", ".seyirlik/"],
      },
      fixture.sizes,
      fixture.contents,
    );

    const result = await scanLibraryTree({
      fileSystem,
      rootPath: "Shows",
      kind: "series",
    });

    const episodes = byKind(result.items, "episode");
    expect(episodes).toHaveLength(2);

    const orphan = episodes.find((episode) => episode.indexNumber === 1);
    expect(orphan).toMatchObject({
      renditionBacked: true,
      parentIndexNumber: 1,
      files: [],
    });
    /*
     * An episode's source key is series:season:episode and names no path, so
     * the directory the manifest lives in has to be reported rather than
     * reconstructed. Anything that opens the package depends on this.
     */
    expect(orphan?.packageDirectory).toBe(
      "Shows/Andor/Season 1/Andor - S01E01 - Kassa",
    );
    expect(orphan?.subtitles).toEqual([
      expect.objectContaining({
        relativePath: "Shows/Andor/Season 1/Andor - S01E01 - Kassa.tr.srt",
        language: "tr",
      }),
    ]);
    // The one that still has its source is an ordinary episode.
    expect(
      episodes.find((episode) => episode.indexNumber === 2)?.renditionBacked,
    ).toBeUndefined();
  });

  it("prefers the real source when both the file and its package exist", async () => {
    const packageDirectory = "Shows/Andor/Season 1/Andor - S01E01 - Kassa";
    const fixture = titlePackageFixture(packageDirectory);
    const fileSystem = createFileSystem(
      {
        ...fixture.tree,
        Shows: ["Andor/"],
        "Shows/Andor": ["Season 1/"],
        "Shows/Andor/Season 1": [
          "Andor - S01E01 - Kassa/",
          "Andor - S01E01 - Kassa.mp4",
        ],
        [packageDirectory]: ["video/", "audio/", ".seyirlik/"],
      },
      fixture.sizes,
      fixture.contents,
    );

    const result = await scanLibraryTree({
      fileSystem,
      rootPath: "Shows",
      kind: "series",
    });

    const episodes = byKind(result.items, "episode");
    expect(episodes).toHaveLength(1);
    expect(episodes[0]!.renditionBacked).toBeUndefined();
    expect(episodes[0]!.files).toHaveLength(1);
  });

  it("infers the season from the folder when the filename omits it", async () => {
    const fileSystem = createFileSystem({
      Shows: ["Babylon 5/"],
      "Shows/Babylon 5": ["Season 3/"],
      "Shows/Babylon 5/Season 3": ["Episode 04 - Passing Through.mkv"],
    });

    const result = await scanLibraryTree({
      fileSystem,
      rootPath: "Shows",
      kind: "series",
    });

    expect(byKind(result.items, "episode")[0]).toMatchObject({
      parentIndexNumber: 3,
      indexNumber: 4,
    });
  });

  it("handles a flat series folder with no season directories", async () => {
    const fileSystem = createFileSystem({
      Shows: ["Firefly/"],
      "Shows/Firefly": [
        "Firefly 1x01 Serenity.mkv",
        "Firefly 1x02 The Train Job.mkv",
      ],
    });

    const result = await scanLibraryTree({
      fileSystem,
      rootPath: "Shows",
      kind: "series",
    });

    expect(byKind(result.items, "season")).toHaveLength(1);
    expect(byKind(result.items, "episode")).toHaveLength(2);
  });

  it("attaches a content/trailers video to its series", async () => {
    const fileSystem = createFileSystem({
      Shows: ["Firefly/"],
      "Shows/Firefly": ["Season 1/", "content/"],
      "Shows/Firefly/Season 1": ["Firefly S01E01.mkv"],
      "Shows/Firefly/content/trailers": ["trailer.mp4"],
    });

    const result = await scanLibraryTree({
      fileSystem,
      rootPath: "Shows",
      kind: "series",
    });

    const series = byKind(result.items, "series")[0];
    expect(byKind(result.items, "trailer")).toEqual([
      expect.objectContaining({
        parentSourceKey: series?.sourceKey,
        seriesSourceKey: series?.sourceKey,
      }),
    ]);
  });

  it("files specials as season zero", async () => {
    const fileSystem = createFileSystem({
      Shows: ["Show/"],
      "Shows/Show": ["Specials/"],
      "Shows/Show/Specials": ["Show - S00E01 - Christmas.mkv"],
    });

    const result = await scanLibraryTree({
      fileSystem,
      rootPath: "Shows",
      kind: "series",
    });

    expect(byKind(result.items, "season")[0]).toMatchObject({
      indexNumber: 0,
      title: "Specials",
    });
  });

  it("drops a folder that contains no playable episodes", async () => {
    const fileSystem = createFileSystem({
      Shows: ["Empty Show/"],
      "Shows/Empty Show": ["readme.txt"],
    });

    const result = await scanLibraryTree({
      fileSystem,
      rootPath: "Shows",
      kind: "series",
    });

    expect(result.items).toHaveLength(0);
  });

  it("keeps a second file for the same episode as an alternate cut", async () => {
    const fileSystem = createFileSystem({
      Shows: ["Show/"],
      "Shows/Show": ["Season 01/"],
      "Shows/Show/Season 01": [
        "Show - S01E01 - Pilot - 1080p.mkv",
        "Show - S01E01 - Pilot - 2160p.mkv",
      ],
    });

    const result = await scanLibraryTree({
      fileSystem,
      rootPath: "Shows",
      kind: "series",
    });

    const episodes = byKind(result.items, "episode");
    expect(episodes).toHaveLength(1);
    expect(episodes[0]?.files).toHaveLength(2);
  });
});

describe("scanLibraryTree — books and mixed roots", () => {
  it("catalogues book files recursively", async () => {
    const fileSystem = createFileSystem({
      Books: ["Fiction/", "Loose Book.epub"],
      "Books/Fiction": ["Dune (1965).epub", "cover.jpg"],
    });

    const result = await scanLibraryTree({
      fileSystem,
      rootPath: "Books",
      kind: "books",
    });

    expect(
      byKind(result.items, "book")
        .map((item) => item.title)
        .sort(),
    ).toEqual(["Dune", "Loose Book"]);
  });

  it("classifies a mixed root by the presence of season folders", async () => {
    const fileSystem = createFileSystem({
      Media: ["Some Show/", "Some Movie (2020)/", "Loose (2011).mkv"],
      "Media/Some Show": ["Season 01/"],
      "Media/Some Show/Season 01": ["Some Show - S01E01.mkv"],
      "Media/Some Movie (2020)": ["Some Movie (2020).mkv"],
    });

    const result = await scanLibraryTree({
      fileSystem,
      rootPath: "Media",
      kind: "mixed",
    });

    expect(byKind(result.items, "series")).toHaveLength(1);
    expect(byKind(result.items, "episode")).toHaveLength(1);
    expect(
      byKind(result.items, "movie")
        .map((item) => item.title)
        .sort(),
    ).toEqual(["Loose", "Some Movie"]);
  });

  it("records unreadable directories instead of failing the whole scan", async () => {
    const fileSystem = createFileSystem({
      Movies: ["Good (2020)/", "Broken/"],
      "Movies/Good (2020)": ["Good (2020).mkv"],
    });

    const result = await scanLibraryTree({
      fileSystem,
      rootPath: "Movies",
      kind: "movies",
    });

    expect(byKind(result.items, "movie")).toHaveLength(1);
    expect(result.skipped).toContainEqual({
      relativePath: "Movies/Broken",
      reason: "unreadable",
    });
  });
});

/*
 * An organised library keeps its originals in a `src/` bucket. The scanner has
 * to read that bucket as if the files were still where they were: the source
 * keys below are byte-for-byte the ones the same library produced before it was
 * organised, which is what stops a reorganisation from re-creating every item
 * in the catalogue and losing its watch history.
 */
describe("scanLibraryTree — sources kept in src/", () => {
  it("gives an organised season exactly the keys it had before", async () => {
    const organised = createFileSystem({
      Series: ["House of the Dragon/"],
      "Series/House of the Dragon": ["Season 1/"],
      "Series/House of the Dragon/Season 1": [
        "src/",
        "House of the Dragon - S01E01 - The Heirs of the Dragon/",
        "season.nfo",
      ],
      "Series/House of the Dragon/Season 1/House of the Dragon - S01E01 - The Heirs of the Dragon":
        ["House of the Dragon - S01E01 - The Heirs of the Dragon.nfo"],
      "Series/House of the Dragon/Season 1/src": [
        "House of the Dragon - S01E01 - The Heirs of the Dragon.mp4",
        "House of the Dragon - S01E01 - The Heirs of the Dragon.tr.srt",
        "House of the Dragon - S01E02 - The Rogue Prince.mp4",
      ],
    });

    const flat = createFileSystem({
      Series: ["House of the Dragon/"],
      "Series/House of the Dragon": ["Season 1/"],
      "Series/House of the Dragon/Season 1": [
        "House of the Dragon - S01E01 - The Heirs of the Dragon.mp4",
        "House of the Dragon - S01E01 - The Heirs of the Dragon.tr.srt",
        "House of the Dragon - S01E02 - The Rogue Prince.mp4",
        "season.nfo",
      ],
    });

    const [organisedScan, flatScan] = await Promise.all([
      scanLibraryTree({
        fileSystem: organised,
        rootPath: "Series",
        kind: "series",
      }),
      scanLibraryTree({ fileSystem: flat, rootPath: "Series", kind: "series" }),
    ]);

    expect(organisedScan.items.map((item) => item.sourceKey)).toEqual(
      flatScan.items.map((item) => item.sourceKey),
    );
    expect(byKind(organisedScan.items, "episode")).toHaveLength(2);
  });

  it("reads an episode's source and subtitle from the bucket", async () => {
    const result = await scanLibraryTree({
      fileSystem: createFileSystem({
        Series: ["Andor/"],
        "Series/Andor": ["Season 1/"],
        "Series/Andor/Season 1": ["src/"],
        "Series/Andor/Season 1/src": [
          "Andor - S01E01 - Kassa.mp4",
          "Andor - S01E01 - Kassa.tr.srt",
        ],
      }),
      rootPath: "Series",
      kind: "series",
    });

    const [episode] = byKind(result.items, "episode");
    expect(episode?.files[0]?.relativePath).toBe(
      "Series/Andor/Season 1/src/Andor - S01E01 - Kassa.mp4",
    );
    expect(episode?.subtitles).toEqual([
      expect.objectContaining({
        relativePath: "Series/Andor/Season 1/src/Andor - S01E01 - Kassa.tr.srt",
        language: "tr",
      }),
    ]);
  });

  it("keeps an organised movie's key on its folder, not on the bucket", async () => {
    const result = await scanLibraryTree({
      fileSystem: createFileSystem({
        Movies: ["Dune (2021)/"],
        "Movies/Dune (2021)": ["src/", "Dune (2021).nfo", "video/"],
        "Movies/Dune (2021)/src": ["Dune (2021).mp4", "Dune (2021).en.srt"],
        "Movies/Dune (2021)/video": ["1080p.mp4"],
      }),
      rootPath: "Movies",
      kind: "movies",
    });

    expect(byKind(result.items, "movie")).toEqual([
      expect.objectContaining({
        sourceKey: "movie:movies/dune (2021)",
        title: "Dune",
        year: 2021,
        files: [
          expect.objectContaining({
            relativePath: "Movies/Dune (2021)/src/Dune (2021).mp4",
          }),
        ],
      }),
    ]);
  });

  /*
   * The bucket belongs to the folder above it and to nothing else. A `src`
   * inside `src` is an ordinary folder, and scanning it as another title would
   * be how one movie becomes two.
   */
  it("does not treat the bucket as a title of its own", async () => {
    const result = await scanLibraryTree({
      fileSystem: createFileSystem({
        Movies: ["Dune (2021)/"],
        "Movies/Dune (2021)": ["src/"],
        "Movies/Dune (2021)/src": ["Dune (2021).mp4"],
      }),
      rootPath: "Movies",
      kind: "movies",
    });

    expect(byKind(result.items, "movie")).toHaveLength(1);
  });
});
