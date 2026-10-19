import { createHmac } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { createOwnApiRouter, type RoutePrincipal } from "../api/router";
import { createCsrfToken } from "../auth/csrf";
import { OwnApiError } from "../ownApiHandler";
import { createArtworkRoutes } from "./artworkRoutes";
import type { MetadataRepository, MetadataTarget } from "./metadataRepository";
import type { TmdbArtworkCandidate, TmdbClient } from "./tmdbClient";
import type { ImageRepository } from "../images/imageRepository";
import type { ImageStorage } from "../images/imageStorage";
import type { JobQueue } from "../tasks/jobQueue";

const CSRF_SECRET = "s".repeat(32);
const SESSION_HASH = createHmac("sha256", "k").update("session").digest();
const MOVIE = "aaaaaaaa-1111-4111-8111-111111111111";
const UNIDENTIFIED = "bbbbbbbb-2222-4222-8222-222222222222";
const EPISODE = "cccccccc-3333-4333-8333-333333333333";
const BOOK = "ffffffff-6666-4666-8666-666666666666";

function target(overrides: Partial<MetadataTarget> = {}): MetadataTarget {
  return {
    id: MOVIE,
    kind: "movie",
    title: "Dune",
    productionYear: 2021,
    providerIds: { tmdb: "438631" },
    lockedFields: [],
    seriesId: null,
    indexNumber: null,
    parentIndexNumber: null,
    ...overrides,
  };
}

const TARGETS: Record<string, MetadataTarget> = {
  [MOVIE]: target({ titleRoot: "Movies/Dune (2021)" }),
  [UNIDENTIFIED]: target({ id: UNIDENTIFIED, providerIds: {} }),
  [EPISODE]: target({ id: EPISODE, kind: "episode" }),
  [BOOK]: target({
    id: BOOK,
    kind: "book",
    title: "The Left Hand of Darkness",
    productionYear: 1969,
    providerIds: {},
  }),
};

function candidate(
  overrides: Partial<TmdbArtworkCandidate> = {},
): TmdbArtworkCandidate {
  return {
    kind: "poster",
    filePath: "/poster.jpg",
    language: "en",
    width: 2000,
    height: 3000,
    aspectRatio: 0.667,
    voteAverage: 8,
    voteCount: 40,
    ...overrides,
  };
}

function fakeMetadata(): MetadataRepository {
  return {
    listPendingItems: async () => [],
    getTarget: async (itemId) => TARGETS[itemId] ?? null,
    listSeasonsForSeries: async () => [],
    listEpisodesForSeries: async () => [],
    applyTitleMetadata: async () => undefined,
    replaceGenres: async () => undefined,
    replacePeople: async () => undefined,
    markFailed: async () => undefined,
    lockFields: async () => undefined,
    setLogoLayout: async () => true,
  };
}

function fakeImages(overrides: Partial<ImageRepository> = {}): ImageRepository {
  return {
    listForItems: async () => [],
    listInheritedForItems: async () => new Map(),
    getById: async () => null,
    getOwningItemId: async () => null,
    findByItemAndType: async () => null,
    upsert: async () => "image-1",
    replaceLocked: async () => "locked-image",
    clear: async () => true,
    listLockedTypes: async () => [],
    deleteForItem: async () => undefined,
    ...overrides,
  };
}

function fakeStorage(overrides: Partial<ImageStorage> = {}): ImageStorage {
  const stored = {
    contentHash: "hash",
    contentType: "image/jpeg",
    sizeBytes: 10,
    storageKey: "aa/bb/hash.jpg",
  };
  return {
    resolve: (key) => `/generated/${key}`,
    store: async () => stored,
    fetchAndStore: async () => stored,
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
    ...overrides,
  };
}

function fakeTmdb(overrides: Partial<TmdbClient> = {}): TmdbClient {
  return {
    searchMovies: async () => [],
    searchSeries: async () => [],
    getMovie: async () => ({
      providerId: "438631",
      title: "Dune",
      genres: [],
      people: [],
      backdropPaths: [],
    }),
    getSeries: async () => ({
      providerId: "438631",
      title: "Dune",
      genres: [],
      people: [],
      backdropPaths: [],
    }),
    getSeasonEpisodes: async () => [],
    listArtwork: async () => [candidate()],
    buildImageUrl: (path, size) => `https://image.tmdb.org/t/p/${size}${path}`,
    ...overrides,
  };
}

function fakeQueue(overrides: Partial<JobQueue> = {}): JobQueue {
  return {
    enqueue: async () => "task-1",
    claim: async () => null,
    complete: async () => undefined,
    fail: async () => undefined,
    heartbeat: async () => true,
    get: async () => null,
    list: async () => [],
    cancel: async () => false,
    releaseExpiredLeases: async () => 0,
    ...overrides,
  } as JobQueue;
}

function buildRouter(
  parts: {
    images?: ImageRepository;
    imageStorage?: ImageStorage;
    tmdb?: TmdbClient;
    queue?: JobQueue;
  } = {},
) {
  return createOwnApiRouter({
    csrfSecret: CSRF_SECRET,
    csrfCookieName: "seyirlik_csrf",
    publicOrigin: "https://seyirlik.test",
    resolveSession: async (): Promise<RoutePrincipal> => ({
      userId: "dddddddd-4444-4444-8444-444444444444",
      username: "root",
      displayName: "Root",
      isAdministrator: true,
      sessionId: "eeeeeeee-5555-4555-8555-555555555555",
      sessionTokenHash: SESSION_HASH,
    }),
    routes: createArtworkRoutes({
      metadata: fakeMetadata(),
      images: parts.images ?? fakeImages(),
      imageStorage: parts.imageStorage ?? fakeStorage(),
      tmdb: parts.tmdb ?? fakeTmdb(),
      queue: parts.queue ?? fakeQueue(),
    }),
  });
}

function buildRouterWith(metadataOverrides: Partial<MetadataRepository>) {
  return createOwnApiRouter({
    csrfSecret: CSRF_SECRET,
    csrfCookieName: "seyirlik_csrf",
    publicOrigin: "https://seyirlik.test",
    resolveSession: async (): Promise<RoutePrincipal> => ({
      userId: "dddddddd-4444-4444-8444-444444444444",
      username: "root",
      displayName: "Root",
      isAdministrator: true,
      sessionId: "eeeeeeee-5555-4555-8555-555555555555",
      sessionTokenHash: SESSION_HASH,
    }),
    routes: createArtworkRoutes({
      metadata: { ...fakeMetadata(), ...metadataOverrides },
      images: fakeImages(),
      imageStorage: fakeStorage(),
      tmdb: fakeTmdb(),
      queue: fakeQueue(),
    }),
  });
}

async function call(
  router: ReturnType<typeof buildRouter>,
  method: string,
  path: string,
  body?: unknown,
  binary?: { bytes: Buffer; contentType: string },
) {
  const payload =
    binary?.bytes ??
    (body === undefined ? undefined : Buffer.from(JSON.stringify(body)));
  const csrfToken = createCsrfToken(SESSION_HASH, CSRF_SECRET);
  const request = Object.assign(
    Readable.from(payload === undefined ? [] : [payload]),
    {
      method,
      url: path,
      headers: {
        host: "seyirlik.test",
        origin: "https://seyirlik.test",
        cookie: `seyirlik_csrf=${csrfToken}`,
        "x-csrf-token": csrfToken,
        ...(payload === undefined
          ? {}
          : {
              "content-type": binary?.contentType ?? "application/json",
              "content-length": String(payload.length),
            }),
      },
      socket: { remoteAddress: "127.0.0.1" },
    },
  ) as unknown as IncomingMessage;

  const sent = { statusCode: 200, body: "" };
  const response = {
    get statusCode() {
      return sent.statusCode;
    },
    set statusCode(value: number) {
      sent.statusCode = value;
    },
    setHeader() {},
    getHeader() {
      return undefined;
    },
    end(chunk?: string) {
      sent.body = chunk ?? "";
    },
  } as unknown as ServerResponse;

  let error: unknown;
  try {
    await router.handler(request, response, {
      requestId: "req-1",
      url: new URL(path, "https://seyirlik.test"),
    });
  } catch (caught) {
    error = caught;
  }

  return {
    sent,
    error,
    json: sent.body ? (JSON.parse(sent.body) as Record<string, unknown>) : null,
  };
}

describe("artwork routes", () => {
  it("lists provider candidates alongside the types an operator has taken over", async () => {
    const router = buildRouter({
      images: fakeImages({ listLockedTypes: async () => ["cover"] }),
    });

    const result = await call(
      router,
      "GET",
      `/ownAPI/v1/admin/items/${MOVIE}/artwork`,
    );

    expect(result.sent.statusCode).toBe(200);
    expect(result.json?.data).toMatchObject({
      item: { id: MOVIE, providerId: "438631" },
      lockedTypes: ["cover"],
    });
    // The page groups by stored type, not by the provider's own vocabulary.
    expect(
      (result.json?.data as { candidates: Array<Record<string, unknown>> })
        .candidates[0],
    ).toMatchObject({
      kind: "poster",
      imageType: "cover",
      previewUrl: "https://image.tmdb.org/t/p/w342/poster.jpg",
    });
  });

  it("still loads custom artwork slots for a title that was never identified", async () => {
    const router = buildRouter();
    const result = await call(
      router,
      "GET",
      `/ownAPI/v1/admin/items/${UNIDENTIFIED}/artwork`,
    );

    expect(result.sent.statusCode).toBe(200);
    expect(result.json?.data).toMatchObject({
      item: { id: UNIDENTIFIED, providerId: null },
      candidates: [],
    });
  });

  it("shows books with their current artwork even though TMDB has no book provider", async () => {
    const listForItems = vi.fn(async () => [
      {
        id: "book-cover-image",
        itemId: BOOK,
        imageType: "cover",
        imageIndex: 0,
        contentHash: "book-cover",
        width: 780,
        height: 1200,
      },
    ]);
    const router = buildRouter({ images: fakeImages({ listForItems }) });

    const result = await call(
      router,
      "GET",
      `/ownAPI/v1/admin/items/${BOOK}/artwork`,
    );

    expect(result.sent.statusCode).toBe(200);
    expect(listForItems).toHaveBeenCalledWith([BOOK]);
    expect(result.json?.data).toMatchObject({
      item: { id: BOOK, kind: "book", providerId: null },
      candidates: [],
      current: [{ contentHash: "book-cover" }],
    });
  });

  it("reports an episode as out of scope rather than showing series artwork as its own", async () => {
    const router = buildRouter();
    const result = await call(
      router,
      "GET",
      `/ownAPI/v1/admin/items/${EPISODE}/artwork`,
    );

    expect((result.error as OwnApiError).code).toBe("ARTWORK_NOT_APPLICABLE");
  });

  it("downloads the chosen file at the same size as the automatic pass and locks it", async () => {
    const fetchAndStoreTitleArtwork = vi.fn(async () => ({
      contentHash: "hash",
      contentType: "image/jpeg",
      sizeBytes: 10,
      storageKey: "media:Movies/Dune (2021)/content/backdrop.jpg",
    }));
    const replaceLocked = vi.fn<ImageRepository["replaceLocked"]>(
      async () => "locked-image",
    );
    const router = buildRouter({
      images: fakeImages({ replaceLocked }),
      imageStorage: fakeStorage({ fetchAndStoreTitleArtwork }),
    });

    const result = await call(
      router,
      "POST",
      `/ownAPI/v1/admin/items/${MOVIE}/artwork`,
      { kind: "backdrop", filePath: "/wide.jpg" },
    );

    expect(result.sent.statusCode).toBe(200);
    expect(fetchAndStoreTitleArtwork).toHaveBeenCalledWith(
      "https://image.tmdb.org/t/p/original/wide.jpg",
      "Movies/Dune (2021)",
      "backdrop",
    );
    // The lock is the entire point: an ordinary upsert would be undone by the
    // next automatic refresh.
    expect(replaceLocked.mock.calls[0]?.[0]).toMatchObject({
      itemId: MOVIE,
      imageType: "backdrop",
      source: "tmdb",
    });
    expect(result.json?.data).toMatchObject({ isLocked: true });
  });

  it("stores an uploaded book cover and locks it against metadata refreshes", async () => {
    const store = vi.fn<ImageStorage["store"]>(async () => ({
      contentHash: "custom-cover-hash",
      contentType: "image/png",
      sizeBytes: 16,
      storageKey: "cu/st/custom-cover-hash.png",
    }));
    const replaceLocked = vi.fn<ImageRepository["replaceLocked"]>(
      async () => "book-cover-image",
    );
    const getVariant = vi.fn<ImageStorage["getVariant"]>(async (image) => ({
      ...image,
      contentType: "image/webp",
      sizeBytes: 8,
    }));
    const router = buildRouter({
      images: fakeImages({ replaceLocked }),
      imageStorage: fakeStorage({ store, getVariant }),
    });
    const bytes = Buffer.from("custom-book-cover");

    const result = await call(
      router,
      "POST",
      `/ownAPI/v1/admin/items/${BOOK}/artwork/upload`,
      {
        kind: "poster",
        contentType: "image/png",
        dataBase64: bytes.toString("base64"),
      },
    );

    expect(result.sent.statusCode).toBe(200);
    expect(store.mock.calls[0]?.[0]).toEqual(bytes);
    expect(store.mock.calls[0]?.[1]).toBe("image/png");
    expect(getVariant).toHaveBeenCalledWith(
      expect.objectContaining({ contentHash: "custom-cover-hash" }),
      440,
    );
    expect(replaceLocked.mock.calls[0]?.[0]).toMatchObject({
      itemId: BOOK,
      imageType: "cover",
      source: "upload",
      sourceUrl: null,
    });
    expect(result.json?.data).toMatchObject({
      contentHash: "custom-cover-hash",
      isLocked: true,
    });
  });

  it("accepts original image bytes without base64 JSON inflation", async () => {
    const store = vi.fn<ImageStorage["store"]>(async () => ({
      contentHash: "binary-cover-hash",
      contentType: "image/webp",
      sizeBytes: 16,
      storageKey: "bi/na/binary-cover-hash.webp",
    }));
    const replaceLocked = vi.fn<ImageRepository["replaceLocked"]>(
      async () => "binary-book-cover",
    );
    const router = buildRouter({
      images: fakeImages({ replaceLocked }),
      imageStorage: fakeStorage({ store }),
    });
    const bytes = Buffer.from("RIFF0000WEBPdata");

    const result = await call(
      router,
      "POST",
      `/ownAPI/v1/admin/items/${BOOK}/artwork/upload?kind=poster`,
      undefined,
      { bytes, contentType: "image/webp" },
    );

    expect(result.sent.statusCode).toBe(200);
    expect(store).toHaveBeenCalledWith(bytes, "image/webp");
    expect(replaceLocked.mock.calls[0]?.[0]).toMatchObject({
      itemId: BOOK,
      imageType: "cover",
      source: "upload",
    });
  });

  it("rejects malformed or unsupported custom artwork before storage", async () => {
    const store = vi.fn<ImageStorage["store"]>();
    const router = buildRouter({ imageStorage: fakeStorage({ store }) });

    for (const body of [
      { kind: "poster", contentType: "image/svg+xml", dataBase64: "YWJj" },
      { kind: "poster", contentType: "image/png", dataBase64: "not base64" },
    ]) {
      const result = await call(
        router,
        "POST",
        `/ownAPI/v1/admin/items/${BOOK}/artwork/upload`,
        body,
      );
      expect((result.error as OwnApiError).statusCode).toBe(422);
    }
    expect(store).not.toHaveBeenCalled();
  });

  it("rejects a file path that is not a provider image path", async () => {
    const fetchAndStore = vi.fn();
    const router = buildRouter({
      imageStorage: fakeStorage({ fetchAndStore }),
    });

    for (const filePath of [
      "https://evil.test/x.jpg",
      "/../secret.jpg",
      "/poster.svg",
    ]) {
      const result = await call(
        router,
        "POST",
        `/ownAPI/v1/admin/items/${MOVIE}/artwork`,
        { kind: "poster", filePath },
      );
      expect((result.error as OwnApiError).statusCode).toBe(422);
    }
    expect(fetchAndStore).not.toHaveBeenCalled();
  });

  it("does not leak the provider request URL when a download fails", async () => {
    // With a v3 credential the key rides in the query string, so the underlying
    // message is never the one that reaches the browser.
    const router = buildRouter({
      imageStorage: fakeStorage({
        fetchAndStoreTitleArtwork: async () => {
          throw new Error(
            "connect ETIMEDOUT https://api.themoviedb.org/?api_key=secret",
          );
        },
      }),
    });

    const result = await call(
      router,
      "POST",
      `/ownAPI/v1/admin/items/${MOVIE}/artwork`,
      { kind: "poster", filePath: "/poster.jpg" },
    );

    const error = result.error as OwnApiError;
    expect(error.statusCode).toBe(502);
    expect(error.message).not.toContain("api_key");
  });

  it("hands a type back to the automatic pass and refreshes so artwork returns", async () => {
    const clear = vi.fn(async () => true);
    const enqueue = vi.fn<JobQueue["enqueue"]>(async () => "task-9");
    const router = buildRouter({
      images: fakeImages({ clear }),
      queue: fakeQueue({ enqueue }),
    });

    const result = await call(
      router,
      "DELETE",
      `/ownAPI/v1/admin/items/${MOVIE}/artwork/logo`,
    );

    expect(clear).toHaveBeenCalledWith(MOVIE, "logo", 0);
    // Without the refresh the title would sit with no logo at all, which reads
    // as breakage rather than as a revert.
    expect(enqueue.mock.calls[0]?.[0]).toMatchObject({
      payload: { itemId: MOVIE },
    });
    expect(result.json?.data).toMatchObject({
      imageType: "logo",
      cleared: true,
      taskId: "task-9",
    });
  });

  it("does not queue a refresh when there was nothing stored to revert", async () => {
    const enqueue = vi.fn(async () => "task-9");
    const router = buildRouter({
      images: fakeImages({ clear: async () => false }),
      queue: fakeQueue({ enqueue }),
    });

    const result = await call(
      router,
      "DELETE",
      `/ownAPI/v1/admin/items/${MOVIE}/artwork/poster`,
    );

    expect(enqueue).not.toHaveBeenCalled();
    expect(result.json?.data).toMatchObject({ cleared: false, taskId: null });
  });

  it("removes a custom book image without queueing an unsupported TMDB refresh", async () => {
    const clear = vi.fn(async () => true);
    const enqueue = vi.fn<JobQueue["enqueue"]>(async () => "task-9");
    const router = buildRouter({
      images: fakeImages({ clear }),
      queue: fakeQueue({ enqueue }),
    });

    const result = await call(
      router,
      "DELETE",
      `/ownAPI/v1/admin/items/${BOOK}/artwork/logo`,
    );

    expect(clear).toHaveBeenCalledWith(BOOK, "logo", 0);
    expect(enqueue).not.toHaveBeenCalled();
    expect(result.json?.data).toMatchObject({ cleared: true, taskId: null });
  });

  it("previews a title in another language without writing anything", async () => {
    const applyTitleMetadata = vi.fn();
    const metadata = { ...fakeMetadata(), applyTitleMetadata };
    const getMovie = vi.fn(async () => ({
      providerId: "438631",
      title: "Çöl Gezegeni",
      overview: "Bir kehanet.",
      genres: [],
      people: [],
      backdropPaths: [],
    }));

    const router = createOwnApiRouter({
      csrfSecret: CSRF_SECRET,
      csrfCookieName: "seyirlik_csrf",
      publicOrigin: "https://seyirlik.test",
      resolveSession: async (): Promise<RoutePrincipal> => ({
        userId: "dddddddd-4444-4444-8444-444444444444",
        username: "root",
        displayName: "Root",
        isAdministrator: true,
        sessionId: "eeeeeeee-5555-4555-8555-555555555555",
        sessionTokenHash: SESSION_HASH,
      }),
      routes: createArtworkRoutes({
        metadata,
        images: fakeImages(),
        imageStorage: fakeStorage(),
        tmdb: fakeTmdb({ getMovie }),
        queue: fakeQueue(),
      }),
    });

    const result = await call(
      router,
      "GET",
      `/ownAPI/v1/admin/items/${MOVIE}/metadata/preview?language=tr-TR`,
    );

    expect(getMovie).toHaveBeenCalledWith("438631", "tr-TR");
    expect(result.json?.data).toMatchObject({
      language: "tr-TR",
      title: "Çöl Gezegeni",
      tagline: null,
    });
    expect(applyTitleMetadata).not.toHaveBeenCalled();
  });

  it("saves a book logo layout without needing a TMDB match", async () => {
    // Placement is a layout choice, not a provider one, so demanding an
    // identified title would block it for exactly the titles that need it most.
    const setLogoLayoutFake = vi.fn(async () => true);
    const router = buildRouterWith({ setLogoLayout: setLogoLayoutFake });

    const result = await call(
      router,
      "PUT",
      `/ownAPI/v1/admin/items/${BOOK}/logo-layout`,
      { layout: { x: 0.25, y: 0.75, width: 0.5, shadow: 1.4 } },
    );

    expect(setLogoLayoutFake).toHaveBeenCalledWith(BOOK, {
      x: 0.25,
      y: 0.75,
      width: 0.5,
      shadow: 1.4,
    });
    expect(result.json?.data).toMatchObject({
      layout: { x: 0.25, y: 0.75, width: 0.5, shadow: 1.4 },
    });
  });

  it("clears an adjustment with an explicit null", async () => {
    // Clearing and not sending one have to be told apart, or a card could never
    // be handed back to its untouched look.
    const setLogoLayoutFake = vi.fn(async () => true);
    const router = buildRouterWith({ setLogoLayout: setLogoLayoutFake });

    const result = await call(
      router,
      "PUT",
      `/ownAPI/v1/admin/items/${MOVIE}/logo-layout`,
      { layout: null },
    );

    expect(setLogoLayoutFake).toHaveBeenCalledWith(MOVIE, null);
    expect(result.json?.data).toMatchObject({ layout: null });
  });

  it("rejects a layout outside the card or below a legible size", async () => {
    const router = buildRouter();

    for (const layout of [
      { x: -0.1, y: 0.5, width: 0.5, shadow: 1 },
      { x: 1.2, y: 0.5, width: 0.5, shadow: 1 },
      { x: 0.5, y: 0.5, width: 0.05, shadow: 1 },
      { x: 0.5, y: 0.5, width: 1.5, shadow: 1 },
      { x: "0.5", y: 0.5, width: 0.5, shadow: 1 },
      { x: 0.5, y: 0.5, width: 0.5 },
      { x: 0.5, y: 0.5, width: 0.5, shadow: 3 },
      { x: 0.5, y: 0.5, width: 0.5, shadow: -1 },
      { x: 0.5, y: 0.5, width: 0.5, shadow: 1, scale: 2 },
    ]) {
      const result = await call(
        router,
        "PUT",
        `/ownAPI/v1/admin/items/${MOVIE}/logo-layout`,
        { layout },
      );
      expect((result.error as OwnApiError).statusCode).toBe(422);
    }
  });

  it("reports an unknown item rather than silently saving nothing", async () => {
    const router = buildRouterWith({ setLogoLayout: async () => false });

    const result = await call(
      router,
      "PUT",
      `/ownAPI/v1/admin/items/${MOVIE}/logo-layout`,
      { layout: { x: 0.5, y: 0.5, width: 0.5, shadow: 1 } },
    );

    expect((result.error as OwnApiError).code).toBe("ITEM_NOT_FOUND");
  });

  it("rejects a language that is not a tag", async () => {
    const router = buildRouter();
    const result = await call(
      router,
      "GET",
      `/ownAPI/v1/admin/items/${MOVIE}/metadata/preview?language=tr-TR%2Cen`,
    );
    expect((result.error as OwnApiError).statusCode).toBe(422);
  });
});
