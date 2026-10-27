import { describe, expect, it, vi } from "vitest";
import { createMetadataService } from "./metadataService";
import {
  TmdbError,
  type TmdbClient,
  type TmdbTitleDetails,
} from "./tmdbClient";
import type {
  MetadataRepository,
  MetadataTarget,
  TitleMetadataUpdate,
} from "./metadataRepository";
import type { ImageRepository } from "../images/imageRepository";
import type { ImageStorage } from "../images/imageStorage";

function target(overrides: Partial<MetadataTarget> = {}): MetadataTarget {
  return {
    id: "item-1",
    kind: "movie",
    title: "The Matrix",
    productionYear: 1999,
    providerIds: {},
    lockedFields: [],
    seriesId: null,
    indexNumber: null,
    parentIndexNumber: null,
    ...overrides,
  };
}

function details(overrides: Partial<TmdbTitleDetails> = {}): TmdbTitleDetails {
  return {
    providerId: "603",
    title: "The Matrix",
    overview: "A hacker learns the truth.",
    releaseDate: "1999-03-31",
    genres: ["Science Fiction"],
    people: [],
    backdropPaths: [],
    ...overrides,
  };
}

function fakeMetadata(initial: MetadataTarget) {
  const updates: Array<{ itemId: string; update: TitleMetadataUpdate }> = [];
  const genres: Array<{ itemId: string; genres: string[] }> = [];
  let failed = false;

  const repository: MetadataRepository = {
    listPendingItems: async () => [initial],
    getTarget: async () => initial,
    listSeasonsForSeries: async () => [],
    listEpisodesForSeries: async () => [],
    applyTitleMetadata: async (itemId, update) => {
      updates.push({ itemId, update });
    },
    replaceGenres: async (itemId, list) => {
      genres.push({ itemId, genres: list });
    },
    replacePeople: async () => undefined,
    markFailed: async () => {
      failed = true;
    },
    lockFields: async () => undefined,
    setLogoLayout: async () => true,
  };

  return {
    repository,
    updates,
    genres,
    get failed() {
      return failed;
    },
  };
}

function fakeImages(): ImageRepository & { upserts: unknown[] } {
  const upserts: unknown[] = [];
  return {
    upserts,
    listForItems: async () => [],
    listInheritedForItems: async () => new Map(),
    getById: async () => null,
    getOwningItemId: async () => null,
    findByItemAndType: async () => null,
    upsert: async (input) => {
      upserts.push(input);
      return "image-1";
    },
    replaceLocked: async () => "locked-image",
    clear: async () => true,
    listLockedTypes: async () => [],
    deleteForItem: async () => undefined,
  };
}

function fakeStorage(): ImageStorage {
  const stored = {
    contentHash: "hash",
    contentType: "image/jpeg",
    sizeBytes: 100,
    storageKey: "aa/bb/hash.jpg",
  };
  return {
    resolve: (key) => `/generated/${key}`,
    store: async () => ({
      contentHash: "hash",
      contentType: "image/jpeg",
      sizeBytes: 10,
      storageKey: "aa/bb/hash.jpg",
    }),
    fetchAndStore: async () => ({
      contentHash: "hash",
      contentType: "image/jpeg",
      sizeBytes: 10,
      storageKey: "aa/bb/hash.jpg",
    }),
    storeTitleArtwork: async () => stored,
    fetchAndStoreTitleArtwork: async () => stored,
    getVariant: async (image) => ({
      ...image,
      contentType: "image/webp",
      sizeBytes: 10,
    }),
    getCardLogoOverlay: async (image) => ({
      ...image,
      contentType: "image/webp",
      sizeBytes: 10,
    }),
    readSource: async () => Buffer.alloc(0),
    hasSource: async () => true,
    remove: async () => undefined,
  };
}

function fakeTmdb(overrides: Partial<TmdbClient> = {}): TmdbClient {
  return {
    searchMovies: async () => [
      { providerId: "603", title: "The Matrix", year: 1999 },
    ],
    searchSeries: async () => [],
    getMovie: async () => details(),
    getSeries: async () => details(),
    getSeasonEpisodes: async () => [],
    listArtwork: async () => [],
    buildImageUrl: (path, size) => `https://image.tmdb.org/t/p/${size}${path}`,
    ...overrides,
  };
}

describe("metadata identification", () => {
  it("applies a confident match and records the provider id", async () => {
    const metadata = fakeMetadata(target());
    const service = createMetadataService({
      metadata: metadata.repository,
      images: fakeImages(),
      imageStorage: fakeStorage(),
      tmdb: fakeTmdb(),
    });

    const result = await service.identify(target());

    expect(result).toMatchObject({ status: "matched", providerId: "603" });
    expect(metadata.updates[0]?.update).toMatchObject({
      title: "The Matrix",
      productionYear: 1999,
      metadataState: "matched",
      providerIds: { tmdb: "603" },
    });
    expect(metadata.genres[0]?.genres).toEqual(["Science Fiction"]);
  });

  it("does not apply an ambiguous match", async () => {
    const metadata = fakeMetadata(
      target({ title: "The Killer", productionYear: null }),
    );
    const service = createMetadataService({
      metadata: metadata.repository,
      images: fakeImages(),
      imageStorage: fakeStorage(),
      tmdb: fakeTmdb({
        searchMovies: async () => [
          { providerId: "1", title: "The Killer", year: 2023 },
          { providerId: "2", title: "The Killer", year: 1989 },
        ],
      }),
    });

    const result = await service.identify(
      target({ title: "The Killer", productionYear: null }),
    );

    expect(result.status).toBe("ambiguous");
    expect(metadata.updates).toHaveLength(1);
    expect(metadata.updates[0]?.update).toEqual({ metadataState: "unmatched" });
  });

  it("skips an item whose identity an administrator locked", async () => {
    const metadata = fakeMetadata(target({ lockedFields: ["identity"] }));
    const searchMovies = vi.fn(async () => []);
    const service = createMetadataService({
      metadata: metadata.repository,
      images: fakeImages(),
      imageStorage: fakeStorage(),
      tmdb: fakeTmdb({ searchMovies }),
    });

    const result = await service.identify(
      target({ lockedFields: ["identity"] }),
    );

    expect(result.status).toBe("skipped");
    expect(searchMovies).not.toHaveBeenCalled();
    // Nothing about the title is rewritten, but it must leave the pending set,
    // otherwise the batch scan would keep reselecting it and never terminate.
    expect(metadata.updates).toEqual([
      { itemId: "item-1", update: { metadataState: "locked" } },
    ]);
  });

  it("describes a title matched by hand from that match, without searching", async () => {
    const locked = target({
      id: "series-1",
      kind: "series",
      title: "Chernobyl",
      providerIds: { tmdb: "87108" },
      lockedFields: ["identity", "overview"],
      metadataState: "locked",
    });
    const metadata = fakeMetadata(locked);
    metadata.repository.listEpisodesForSeries = async () => [
      target({
        id: "e1",
        kind: "episode",
        title: "23-45",
        productionYear: null,
        seriesId: "series-1",
        parentIndexNumber: 1,
        indexNumber: 1,
        metadataState: "pending",
      }),
    ];
    const images = fakeImages();
    const searchSeries = vi.fn(async () => []);
    const getSeries = vi.fn(async () =>
      details({ providerId: "87108", title: "Chernobyl" }),
    );
    const service = createMetadataService({
      metadata: metadata.repository,
      images,
      imageStorage: fakeStorage(),
      tmdb: fakeTmdb({
        searchSeries,
        getSeries,
        getSeasonEpisodes: async () => [
          {
            seasonNumber: 1,
            episodeNumber: 1,
            title: "1:23:45",
            overview: "The reactor explodes.",
            airDate: "2019-05-06",
            stillPath: "/still1.jpg",
          },
        ],
      }),
    });

    const result = await service.identify(locked);

    expect(searchSeries).not.toHaveBeenCalled();
    expect(getSeries).toHaveBeenCalledWith("87108");
    expect(result).toMatchObject({ status: "matched", providerId: "87108" });
    expect(
      metadata.updates.filter((entry) => entry.itemId === "e1"),
    ).toContainEqual({
      itemId: "e1",
      update: expect.objectContaining({
        title: "1:23:45",
        overview: "The reactor explodes.",
        metadataState: "matched",
      }),
    });
    expect(images.upserts).toContainEqual(
      expect.objectContaining({ itemId: "e1", imageType: "thumb" }),
    );
  });

  it("keeps a match chosen by hand when the provider no longer knows it", async () => {
    const locked = target({
      providerIds: { tmdb: "999" },
      lockedFields: ["identity"],
    });
    const metadata = fakeMetadata(locked);
    const service = createMetadataService({
      metadata: metadata.repository,
      images: fakeImages(),
      imageStorage: fakeStorage(),
      tmdb: fakeTmdb({
        getMovie: async () => {
          throw new TmdbError("not-found", "No such movie.");
        },
      }),
    });

    const result = await service.identify(locked);

    expect(result.status).toBe("not-found");
    expect(metadata.updates).toEqual([
      { itemId: "item-1", update: { metadataState: "locked" } },
    ]);
  });

  it("reuses a provider id that is already recorded instead of searching again", async () => {
    const searchMovies = vi.fn(async () => []);
    const getMovie = vi.fn(async () => details({ providerId: "999" }));
    const metadata = fakeMetadata(target({ providerIds: { tmdb: "999" } }));
    const service = createMetadataService({
      metadata: metadata.repository,
      images: fakeImages(),
      imageStorage: fakeStorage(),
      tmdb: fakeTmdb({ searchMovies, getMovie }),
    });

    const result = await service.identify(
      target({ providerIds: { tmdb: "999" } }),
    );

    expect(searchMovies).not.toHaveBeenCalled();
    expect(getMovie).toHaveBeenCalledWith("999");
    expect(result).toMatchObject({ status: "matched", providerId: "999" });
  });

  it("marks an item unmatched when the provider has no record", async () => {
    const metadata = fakeMetadata(target());
    const service = createMetadataService({
      metadata: metadata.repository,
      images: fakeImages(),
      imageStorage: fakeStorage(),
      tmdb: fakeTmdb({ searchMovies: async () => [] }),
    });

    const result = await service.identify(target());

    expect(result.status).toBe("not-found");
    expect(metadata.updates[0]?.update).toEqual({ metadataState: "unmatched" });
  });

  it("lets a rate limit propagate so the job retries instead of failing the item", async () => {
    const metadata = fakeMetadata(target());
    const service = createMetadataService({
      metadata: metadata.repository,
      images: fakeImages(),
      imageStorage: fakeStorage(),
      tmdb: fakeTmdb({
        searchMovies: async () => {
          throw new TmdbError("rate-limited", "slow down");
        },
      }),
    });

    await expect(service.identify(target())).rejects.toThrow(TmdbError);
    expect(metadata.failed).toBe(false);
  });

  it("stores poster, logo and backdrop artwork", async () => {
    const images = fakeImages();
    const metadata = fakeMetadata(target());
    const service = createMetadataService({
      metadata: metadata.repository,
      images,
      imageStorage: fakeStorage(),
      tmdb: fakeTmdb({
        getMovie: async () =>
          details({
            posterPath: "/poster.jpg",
            logoPath: "/logo.png",
            backdropPaths: ["/back1.jpg", "/back2.jpg"],
          }),
      }),
    });

    await service.identify(target());

    expect(
      images.upserts.map((entry) => (entry as { imageType: string }).imageType),
    ).toEqual(["cover", "logo", "backdrop"]);
  });

  it("writes title artwork through the title-local storage path", async () => {
    const images = fakeImages();
    const imageStorage = fakeStorage();
    const fetchAndStoreTitleArtwork = vi.fn(
      imageStorage.fetchAndStoreTitleArtwork,
    );
    imageStorage.fetchAndStoreTitleArtwork = fetchAndStoreTitleArtwork;
    const item = target({ titleRoot: "Movies/The Matrix (1999)" });
    const service = createMetadataService({
      metadata: fakeMetadata(item).repository,
      images,
      imageStorage,
      tmdb: fakeTmdb({
        getMovie: async () =>
          details({
            posterPath: "/poster.jpg",
            logoPath: "/logo.png",
            backdropPaths: ["/backdrop.jpg"],
          }),
      }),
    });

    await service.identify(item);

    expect(fetchAndStoreTitleArtwork.mock.calls).toEqual([
      [
        "https://image.tmdb.org/t/p/original/poster.jpg",
        "Movies/The Matrix (1999)",
        "cover",
      ],
      [
        "https://image.tmdb.org/t/p/original/logo.png",
        "Movies/The Matrix (1999)",
        "logo",
      ],
      [
        "https://image.tmdb.org/t/p/original/backdrop.jpg",
        "Movies/The Matrix (1999)",
        "backdrop",
      ],
    ]);
  });

  it("does not rewrite artwork whose bytes are unchanged", async () => {
    const images = fakeImages();
    images.findByItemAndType = async () => ({
      id: "existing",
      itemId: "item-1",
      imageType: "cover",
      imageIndex: 0,
      contentHash: "hash",
      width: null,
      height: null,
      contentType: "image/jpeg",
      storageKey: "aa/bb/hash.jpg",
      sizeBytes: 10,
      isLocked: false,
    });

    const service = createMetadataService({
      metadata: fakeMetadata(target()).repository,
      images,
      imageStorage: fakeStorage(),
      tmdb: fakeTmdb({
        getMovie: async () => details({ posterPath: "/poster.jpg" }),
      }),
    });

    await service.identify(target());

    expect(images.upserts).toHaveLength(0);
  });

  it("does not overwrite a title-local file locked by an administrator", async () => {
    const images = fakeImages();
    images.findByItemAndType = async () => ({
      id: "locked-cover",
      itemId: "item-1",
      imageType: "cover",
      imageIndex: 0,
      contentHash: "chosen",
      width: null,
      height: null,
      contentType: "image/jpeg",
      storageKey: "media:Movies/The Matrix (1999)/content/cover.jpg",
      sizeBytes: 10,
      isLocked: true,
    });
    const imageStorage = fakeStorage();
    const fetchAndStoreTitleArtwork = vi.fn(
      imageStorage.fetchAndStoreTitleArtwork,
    );
    imageStorage.fetchAndStoreTitleArtwork = fetchAndStoreTitleArtwork;
    const item = target({ titleRoot: "Movies/The Matrix (1999)" });
    const service = createMetadataService({
      metadata: fakeMetadata(item).repository,
      images,
      imageStorage,
      tmdb: fakeTmdb({
        getMovie: async () => details({ posterPath: "/poster.jpg" }),
      }),
    });

    await service.identify(item);

    expect(fetchAndStoreTitleArtwork).not.toHaveBeenCalled();
    expect(images.upserts).toEqual([]);
  });

  it("still applies metadata when artwork cannot be downloaded", async () => {
    const metadata = fakeMetadata(target());
    const storage = fakeStorage();
    storage.fetchAndStore = async () => {
      throw new Error("network down");
    };

    const service = createMetadataService({
      metadata: metadata.repository,
      images: fakeImages(),
      imageStorage: storage,
      tmdb: fakeTmdb({
        getMovie: async () => details({ posterPath: "/poster.jpg" }),
      }),
    });

    const result = await service.identify(target());

    expect(result.status).toBe("matched");
    expect(metadata.updates[0]?.update.metadataState).toBe("matched");
  });
});

describe("film collections", () => {
  function fakeCollections() {
    const calls: string[] = [];
    return {
      calls,
      repository: {
        attach: async (itemId: string, collection: { providerId: string }) => {
          calls.push(`attach ${itemId} ${collection.providerId}`);
          return "collection-item";
        },
        detach: async (itemId: string) => {
          calls.push(`detach ${itemId}`);
        },
        refreshCounts: async () => undefined,
      },
    };
  }

  it("puts a matched film in its box set and describes the set once", async () => {
    const metadata = fakeMetadata(target({ providerIds: { tmdb: "603" } }));
    const collections = fakeCollections();
    const images = fakeImages();
    const getCollection = vi.fn(async () => ({
      providerId: "2344",
      name: "The Matrix Collection",
      overview: "The trilogy.",
      posterPath: "/poster.jpg",
    }));
    const service = createMetadataService({
      metadata: metadata.repository,
      images,
      imageStorage: fakeStorage(),
      tmdb: fakeTmdb({
        getMovie: async () =>
          details({
            collection: { providerId: "2344", name: "The Matrix Collection" },
          }),
        getCollection,
      }),
      collections: collections.repository,
    });

    await service.refreshItem("item-1");
    await service.refreshItem("item-1");

    expect(collections.calls).toEqual([
      "attach item-1 2344",
      "attach item-1 2344",
    ]);
    expect(getCollection).toHaveBeenCalledTimes(1);
    expect(metadata.updates).toContainEqual({
      itemId: "collection-item",
      update: { overview: "The trilogy." },
    });
    expect(images.upserts).toContainEqual(
      expect.objectContaining({
        itemId: "collection-item",
        imageType: "cover",
      }),
    );
  });

  it("takes a film out of a box set the provider no longer puts it in", async () => {
    const metadata = fakeMetadata(target({ providerIds: { tmdb: "603" } }));
    const collections = fakeCollections();
    const service = createMetadataService({
      metadata: metadata.repository,
      images: fakeImages(),
      imageStorage: fakeStorage(),
      tmdb: fakeTmdb(),
      collections: collections.repository,
    });

    expect(await service.enrich("item-1")).toEqual({
      rated: false,
      inCollection: false,
    });
    expect(collections.calls).toEqual(["detach item-1"]);
  });

  it("never gives a series a collection", async () => {
    const metadata = fakeMetadata(
      target({ kind: "series", providerIds: { tmdb: "1" } }),
    );
    const collections = fakeCollections();
    const service = createMetadataService({
      metadata: metadata.repository,
      images: fakeImages(),
      imageStorage: fakeStorage(),
      tmdb: fakeTmdb({
        getSeries: async () =>
          details({ collection: { providerId: "9", name: "Not a thing" } }),
      }),
      collections: collections.repository,
    });

    await service.refreshItem("item-1");
    expect(collections.calls).toEqual([]);
  });
});

describe("episodes that arrive after their series was identified", () => {
  function episode(
    id: string,
    episodeNumber: number,
    metadataState: string,
  ): MetadataTarget {
    return target({
      id,
      kind: "episode",
      title: `Episode ${episodeNumber}`,
      productionYear: null,
      seriesId: "series-1",
      parentIndexNumber: 1,
      indexNumber: episodeNumber,
      metadataState,
    });
  }

  it("describes the new ones and settles those the provider does not list", async () => {
    const series = target({
      id: "series-1",
      kind: "series",
      title: "Lilyhammer",
      providerIds: { tmdb: "42368" },
      metadataState: "matched",
    });
    const metadata = fakeMetadata(series);
    metadata.repository.listEpisodesForSeries = async () => [
      episode("e3", 3, "pending"),
      episode("e9", 9, "pending"),
      episode("e1", 1, "matched"),
    ];
    const service = createMetadataService({
      metadata: metadata.repository,
      images: fakeImages(),
      imageStorage: fakeStorage(),
      tmdb: fakeTmdb({
        getSeries: async () =>
          details({ providerId: "42368", title: "Lilyhammer" }),
        getSeasonEpisodes: async () => [
          {
            seasonNumber: 1,
            episodeNumber: 3,
            title: "Guantanamo Blues",
            overview: "Frank joins a real estate deal.",
            airDate: "2012-02-08",
            stillPath: "/still3.jpg",
          },
        ],
      }),
    });

    await service.identify(series);

    const byItem = (id: string) =>
      metadata.updates
        .filter((entry) => entry.itemId === id)
        .map((entry) => entry.update);
    expect(byItem("e3")).toContainEqual(
      expect.objectContaining({
        title: "Guantanamo Blues",
        metadataState: "matched",
      }),
    );
    // Not in the provider's season: settled, so the series is not picked again.
    expect(byItem("e9")).toEqual([{ metadataState: "unmatched" }]);
    // Already described before, and not touched.
    expect(byItem("e1")).toEqual([]);
  });
});
