import { describe, expect, it, vi } from "vitest";
import {
  cacheSeriesCatalogue,
  loadTitleDetail,
  packagedStatus,
  type LibraryAdminRepository,
  type SeriesCatalogue,
} from "./libraryAdmin";

function tmdb() {
  return {
    getSeries: vi.fn(async (id: string) => ({ id }) as never),
    getSeasonEpisodes: vi.fn(async () => []),
    buildImageUrl: (path: string, size: string) => `${size}${path}`,
  } satisfies SeriesCatalogue;
}

describe("cacheSeriesCatalogue", () => {
  it("asks TMDB once per show and season until the answer is old", async () => {
    let clock = 0;
    const source = tmdb();
    const cached = cacheSeriesCatalogue(source, 1_000, () => clock);
    await cached.getSeries("1398");
    await cached.getSeries("1398");
    await cached.getSeasonEpisodes("1398", 1);
    await cached.getSeasonEpisodes("1398", 1);
    await cached.getSeasonEpisodes("1398", 2);
    expect(source.getSeries).toHaveBeenCalledTimes(1);
    expect(source.getSeasonEpisodes).toHaveBeenCalledTimes(2);
    clock = 1_000;
    await cached.getSeries("1398");
    expect(source.getSeries).toHaveBeenCalledTimes(2);
  });

  it("does not keep a failed answer", async () => {
    const source = tmdb();
    source.getSeries.mockRejectedValueOnce(new Error("TMDB is down"));
    const cached = cacheSeriesCatalogue(source, 60_000, () => 0);
    await expect(cached.getSeries("1398")).rejects.toThrow("TMDB is down");
    await expect(cached.getSeries("1398")).resolves.toEqual({ id: "1398" });
    expect(source.getSeries).toHaveBeenCalledTimes(2);
  });
});

describe("packagedStatus", () => {
  it("calls a complete package processed with no job behind it", () => {
    // A finished job removed from history, or a title packaged before the
    // catalogue was rebuilt.
    expect(packagedStatus("downloaded", 0, "complete")).toBe("ready");
    expect(packagedStatus("processing", 1, "complete")).toBe("ready");
  });

  it("does not call a title processed once its package is not whole", () => {
    expect(packagedStatus("ready", 0, "none")).toBe("downloaded");
    expect(packagedStatus("ready", 0, "partial")).toBe("downloaded");
    expect(packagedStatus("ready", 0, "stale")).toBe("downloaded");
    expect(packagedStatus("ready", 1, "partial")).toBe("processing");
  });

  it("keeps the catalogue's answer until the package has been read", () => {
    expect(packagedStatus("ready", 0, "unknown")).toBe("ready");
    expect(packagedStatus("downloaded", 0, "unknown")).toBe("downloaded");
    expect(packagedStatus("processing", 1, "none")).toBe("processing");
  });
});

describe("loadTitleDetail", () => {
  const holding = (status: string) => ({
    status,
    hasMedia: true,
    downloading: 0,
    importing: 0,
    processing: 0,
    sizeBytes: 1,
    resolution: 1080,
    audioLanguages: ["eng"],
    subtitleLanguages: [],
    pendingSubtitles: [],
    files: 1,
    trickplayFiles: 0,
    pendingTrickplay: 0,
  });
  const episode = (n: number, status: string) => ({
    id: `e${n}`,
    title: `Episode ${n}`,
    season: 1,
    episode: n,
    airDate: null,
    seasonId: "s1",
    hasThumb: false,
    ...holding(status),
  });
  const repository = {
    getTitle: async () => ({
      id: "show",
      kind: "series",
      title: "Lilyhammer",
      ...holding("downloaded"),
    }),
    listEpisodes: async () => [
      episode(1, "downloaded"),
      episode(2, "ready"),
      episode(3, "downloaded"),
    ],
    monitoring: async () => ({
      series: { monitored: true },
      seasons: new Map(),
      episodes: new Map(),
    }),
    seriesWork: async () => [],
    primaryFiles: async (ids: readonly string[]) =>
      new Map(
        ids.map((id) => [
          id,
          {
            id: `f-${id}`,
            relativePath: `Series/x/${id}.mkv`,
            fingerprint: "fp",
          },
        ]),
      ),
  } as unknown as LibraryAdminRepository;

  it("reads each episode's processed state from its package", async () => {
    const packages = {
      "f-e1": "complete",
      "f-e2": "none",
      "f-e3": "unknown",
    } as const;
    const detail = await loadTitleDetail(repository, undefined, "show", {
      packageState: (file) => packages[file.id as keyof typeof packages],
    });
    expect(
      detail!.seasons[0]!.episodes.map((e) => [e.episodeNumber, e.status]),
    ).toEqual([
      [1, "ready"],
      [2, "downloaded"],
      [3, "downloaded"],
    ]);
  });

  it("shows work addressed to the series on the episodes it covers", async () => {
    const catalogue: SeriesCatalogue = {
      ...tmdb(),
      getSeries: async () =>
        ({
          seasons: [
            { seasonNumber: 1, episodeCount: 4 },
            { seasonNumber: 2, episodeCount: 2 },
          ],
        }) as never,
      getSeasonEpisodes: async (_id: string, season: number) =>
        (season === 1 ? [1, 2, 3, 4] : [1, 2]).map((episodeNumber) => ({
          seasonNumber: season,
          episodeNumber,
          airDate: "2012-01-25",
        })) as never,
    };
    const detail = await loadTitleDetail(
      {
        ...repository,
        getTitle: async () => ({
          id: "show",
          kind: "series",
          title: "Lilyhammer",
          tmdbId: "1",
          ...holding("downloaded"),
        }),
        seriesWork: async () => [
          // An episode the catalogue has no row for, downloading.
          { stage: "downloading", season: 1, episode: 4 },
          // A season pack, importing.
          { stage: "importing", season: 2, episode: null },
        ],
      } as unknown as LibraryAdminRepository,
      catalogue,
      "show",
      { now: new Date("2026-10-20") },
    );
    const facts = detail!.seasons.flatMap((season) =>
      season.episodes.map((e) => [
        `${e.seasonNumber}x${e.episodeNumber}`,
        e.downloading,
        e.importing,
      ]),
    );
    expect(facts).toEqual([
      // Held episodes are not touched.
      ["1x1", 0, 0],
      ["1x2", 0, 0],
      ["1x3", 0, 0],
      ["1x4", 1, 0],
      ["2x1", 0, 1],
      ["2x2", 0, 1],
    ]);
  });
});
