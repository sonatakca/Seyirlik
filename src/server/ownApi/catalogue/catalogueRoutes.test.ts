import { createHmac } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createOwnApiRouter, type RoutePrincipal } from "../api/router";
import { createCsrfToken } from "../auth/csrf";
import { OwnApiError } from "../ownApiHandler";
import { createCatalogueRoutes } from "./catalogueRoutes";
import { createProgressRoutes } from "../progress/progressRoutes";
import { createCatalogueService } from "./catalogueService";
import type {
  CatalogueItemRow,
  CatalogueRepository,
} from "./catalogueRepository";
import type { HomeRepository } from "./homeRepository";
import type { ImageRepository } from "../images/imageRepository";
import type { UserStateRepository } from "../progress/userStateRepository";
import type { UserStateRecord } from "./itemDto";

const CSRF_SECRET = "s".repeat(32);
const SESSION_HASH = createHmac("sha256", "k").update("session").digest();
const VIEWER = "11111111-1111-4111-8111-111111111111";
const VISIBLE_ITEM = "aaaaaaaa-1111-4111-8111-111111111111";
const HIDDEN_ITEM = "bbbbbbbb-2222-4222-8222-222222222222";
const PARENT_ITEM = "aaaaaaaa-2222-4222-8222-222222222222";
const BOOK_ITEM = "aaaaaaaa-4444-4444-8444-444444444444";

function itemRow(
  id: string,
  title: string,
  overrides: Partial<CatalogueItemRow> = {},
): CatalogueItemRow {
  return {
    id,
    libraryId: "cccccccc-3333-4333-8333-333333333333",
    parentId: null,
    seriesId: null,
    kind: "movie",
    title,
    sortTitle: title.toLowerCase(),
    originalTitle: null,
    overview: null,
    tagline: null,
    productionYear: 2020,
    premiereDate: null,
    officialRating: null,
    communityRating: null,
    runtimeMs: "6000000",
    indexNumber: null,
    parentIndexNumber: null,
    providerIds: {},
    childCount: 0,
    recursiveItemCount: 0,
    dateCreated: new Date("2026-01-01T00:00:00Z"),
    missingSince: null,
    logoLayout: null,
    seriesTitle: null,
    seasonTitle: null,
    genres: [],
    ...overrides,
  };
}

const VISIBLE_ROWS = [
  itemRow(VISIBLE_ITEM, "Alpha"),
  itemRow(PARENT_ITEM, "Beta"),
  itemRow("aaaaaaaa-3333-4333-8333-333333333333", "Gamma"),
  itemRow(BOOK_ITEM, "The Dispossessed", { kind: "book" }),
];

/** Only reachable through their parent, the way an episode or a season is. */
const CHILD_ROWS = [
  itemRow("dddddddd-1111-4111-8111-111111111111", "Beta Part One", {
    parentId: PARENT_ITEM,
    kind: "episode",
  }),
];

const ALL_ROWS = [...VISIBLE_ROWS, ...CHILD_ROWS];

function fakeCatalogue(): CatalogueRepository {
  const visible = (itemId: string) => ALL_ROWS.some((row) => row.id === itemId);

  return {
    listLibraries: async () => [],
    getLibrary: async () => null,
    listProcessableTitles: async () => [],
    listEnrichableTitles: async () => [],
    listStreamsForFiles: async () => new Map(),
    getItemKind: async () => null,
    getItem: async (_userId, itemId) =>
      ALL_ROWS.find((row) => row.id === itemId) ?? null,
    getItemsByIds: async (_userId, itemIds) =>
      ALL_ROWS.filter((row) => itemIds.includes(row.id)),
    listItems: async ({ limit, cursor, parentId, kinds }) => {
      const scoped = parentId
        ? ALL_ROWS.filter((row) => row.parentId === parentId)
        : VISIBLE_ROWS;
      const requestedKinds = kinds ?? [];
      const rows =
        requestedKinds.length === 0
          ? scoped
          : scoped.filter((row) => requestedKinds.includes(row.kind));
      const start = cursor
        ? rows.findIndex((row) => row.id === cursor.id) + 1
        : 0;
      return rows.slice(start, start + limit);
    },
    listChildren: async () => [],
    listSeriesEpisodes: async () => [],
    searchItems: async () => [],
    listSearchCandidates: async () =>
      ALL_ROWS.map((row) => ({
        id: row.id,
        kind: row.kind,
        title: row.title,
        originalTitle: row.originalTitle,
        seriesTitle: null,
      })),
    listFilesForItem: async () => [],
    getPrimaryFile: async () => null,
    getPlayableFile: async () => null,
    fileHoldsItem: async () => false,
    getFileById: async () => null,
    listStreams: async () => [],
    listChapters: async () => [],
    listSegments: async () => [],
    listPeople: async (itemId) =>
      itemId === VISIBLE_ITEM
        ? [
            {
              personId: "dddddddd-1111-4111-8111-111111111111",
              name: "Ada Actor",
              role: "actor",
              characterName: "The Lead",
              tmdbProfilePath: "/ada.jpg",
            },
            {
              personId: "dddddddd-2222-4222-8222-222222222222",
              name: "Dee Director",
              role: "director",
              characterName: null,
              // Never a URL of its own, whatever ended up stored.
              tmdbProfilePath: "https://elsewhere.test/x.jpg",
            },
          ]
        : [],
    listGenres: async () => [],
    listPendingProbeFiles: async () => [],
    listBookFiles: async () => [],
    canUserAccessItem: async (_userId, itemId) => visible(itemId),
  };
}

function fakeHome(): HomeRepository {
  return {
    listNextUpEpisodeIds: async () => [],
    listLatestItemIds: async () => [VISIBLE_ITEM],
    listLatestPerLibrary: async () => new Map(),
    findFirstUnwatchedEpisodeId: async () => null,
    findNextEpisodeId: async () => null,
  };
}

function fakeImages(): ImageRepository {
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
    setFocus: async () => true,
  };
}

function fakeUserState(): UserStateRepository & {
  records: Map<string, UserStateRecord>;
} {
  const records = new Map<string, UserStateRecord>();
  let sequence = 0;

  return {
    records,
    getMany: async () => new Map(records),
    get: async (_userId, itemId) => records.get(itemId) ?? null,
    updateProgress: async (update) => {
      if (update.sequence <= sequence) return false;
      sequence = update.sequence;
      records.set(update.itemId, {
        itemId: update.itemId,
        positionMs: update.positionMs,
        played: false,
        playCount: 0,
        isFavourite: false,
        lastPlayedAt: new Date("2026-03-03T00:00:00Z"),
        audioStreamIndex: update.audioStreamIndex ?? null,
        subtitleStreamIndex: update.subtitleStreamIndex ?? null,
      });
      return true;
    },
    setPlayed: async () => undefined,
    setFavourite: async () => undefined,
    incrementPlayCount: async () => undefined,
    resetWatchedRecursively: async () => 7,
    markWatchedRecursively: async () => 7,
    listResumable: async () => [],
    listFavourites: async () => [],
  };
}

function buildRouter(
  over: Partial<CatalogueRepository> = {},
  { administrator = false }: { administrator?: boolean } = {},
) {
  const catalogue = { ...fakeCatalogue(), ...over };
  const userState = fakeUserState();
  const service = createCatalogueService({
    catalogue,
    home: fakeHome(),
    images: fakeImages(),
    userState,
  });

  const router = createOwnApiRouter({
    csrfSecret: CSRF_SECRET,
    csrfCookieName: "seyirlik_csrf",
    publicOrigin: "https://seyirlik.test",
    resolveSession: async (): Promise<RoutePrincipal> => ({
      userId: VIEWER,
      username: "viewer",
      displayName: "Viewer",
      isAdministrator: administrator,
      sessionId: "dddddddd-4444-4444-8444-444444444444",
      sessionTokenHash: SESSION_HASH,
    }),
    routes: [
      ...createCatalogueRoutes({ service, catalogue }),
      ...createProgressRoutes({ userState, catalogue }),
    ],
  });

  return { router, userState };
}

interface Sent {
  statusCode: number;
  headers: Record<string, string | string[]>;
  body: string;
}

async function call(
  router: ReturnType<typeof buildRouter>["router"],
  method: string,
  path: string,
  options: { body?: unknown; headers?: Record<string, string> } = {},
) {
  const payload =
    options.body === undefined ? undefined : JSON.stringify(options.body);
  const csrfToken = createCsrfToken(SESSION_HASH, CSRF_SECRET);
  const headers: Record<string, string> = {
    host: "seyirlik.test",
    ...(payload === undefined
      ? {}
      : {
          "content-type": "application/json",
          origin: "https://seyirlik.test",
          cookie: `seyirlik_csrf=${csrfToken}`,
          "x-csrf-token": csrfToken,
        }),
    ...options.headers,
  };

  const request = Object.assign(
    Readable.from(payload === undefined ? [] : [Buffer.from(payload)]),
    {
      method,
      url: path,
      headers,
      socket: { remoteAddress: "127.0.0.1" },
    },
  ) as unknown as IncomingMessage;

  const sent: Sent = { statusCode: 200, headers: {}, body: "" };
  const response = {
    get statusCode() {
      return sent.statusCode;
    },
    set statusCode(value: number) {
      sent.statusCode = value;
    },
    setHeader(name: string, value: string | string[]) {
      sent.headers[name] = value;
    },
    getHeader(name: string) {
      return sent.headers[name];
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

describe("catalogue routes", () => {
  it("returns an item the viewer can see, in the native envelope", async () => {
    const { router } = buildRouter();
    const result = await call(
      router,
      "GET",
      `/ownAPI/v1/items/${VISIBLE_ITEM}`,
    );

    expect(result.sent.statusCode).toBe(200);
    expect(result.json).toMatchObject({
      requestId: "req-1",
      data: { id: VISIBLE_ITEM, title: "Alpha", runtimeMs: 6_000_000 },
    });
  });

  it("reports an item outside the viewer's libraries as not found", async () => {
    const { router } = buildRouter();
    const result = await call(router, "GET", `/ownAPI/v1/items/${HIDDEN_ITEM}`);

    expect((result.error as OwnApiError).statusCode).toBe(404);
    expect((result.error as OwnApiError).code).toBe("ITEM_NOT_FOUND");
  });

  it("rejects an item id that is not a UUID before touching the repository", async () => {
    const { router } = buildRouter();
    const result = await call(router, "GET", "/ownAPI/v1/items/not-a-uuid");
    expect((result.error as OwnApiError).statusCode).toBe(422);
  });

  it("paginates with an opaque cursor and stops at the last page", async () => {
    const { router } = buildRouter();

    const first = await call(router, "GET", "/ownAPI/v1/movies?limit=2");
    const firstPage = first.json as {
      data: Array<{ title: string }>;
      pagination: { nextCursor: string | null };
    };
    expect(firstPage.data.map((item) => item.title)).toEqual(["Alpha", "Beta"]);
    expect(firstPage.pagination.nextCursor).not.toBeNull();

    const second = await call(
      router,
      "GET",
      `/ownAPI/v1/movies?limit=2&cursor=${encodeURIComponent(
        firstPage.pagination.nextCursor as string,
      )}`,
    );
    const secondPage = second.json as {
      data: Array<{ title: string }>;
      pagination: { nextCursor: string | null };
    };
    expect(secondPage.data.map((item) => item.title)).toEqual(["Gamma"]);
    expect(secondPage.pagination.nextCursor).toBeNull();
  });

  it("exposes books as their own catalogue for the artwork manager", async () => {
    const { router } = buildRouter();
    const result = await call(router, "GET", "/ownAPI/v1/books");

    expect(result.sent.statusCode).toBe(200);
    expect(
      (result.json as { data: Array<{ id: string; kind: string }> }).data,
    ).toEqual([expect.objectContaining({ id: BOOK_ITEM, kind: "book" })]);
  });

  it("lists the children of an item and reports a leaf as childless", async () => {
    // A detail page shares its route with a shelf, so it asks for children
    // without knowing whether the id it was given has any. Having none is an
    // ordinary empty page, not the not-found that asking a library would give.
    const { router } = buildRouter();

    const parent = await call(
      router,
      "GET",
      `/ownAPI/v1/items/${PARENT_ITEM}/children`,
    );
    expect(parent.sent.statusCode).toBe(200);
    expect(
      (parent.json as { data: Array<{ title: string }> }).data.map(
        (child) => child.title,
      ),
    ).toEqual(["Beta Part One"]);

    const leaf = await call(
      router,
      "GET",
      `/ownAPI/v1/items/${VISIBLE_ITEM}/children`,
    );
    expect(leaf.sent.statusCode).toBe(200);
    expect((leaf.json as { data: unknown[] }).data).toEqual([]);
  });

  it("refuses to list the children of an item the viewer cannot see", async () => {
    const { router } = buildRouter();
    const result = await call(
      router,
      "GET",
      `/ownAPI/v1/items/${HIDDEN_ITEM}/children`,
    );
    expect((result.error as OwnApiError).statusCode).toBe(404);
  });

  it("credits an item's people with TMDB headshots, and only TMDB's", async () => {
    const { router } = buildRouter();
    const result = await call(
      router,
      "GET",
      `/ownAPI/v1/items/${VISIBLE_ITEM}/people`,
    );

    expect(result.sent.statusCode).toBe(200);
    expect((result.json as { data: unknown[] }).data).toEqual([
      {
        id: "dddddddd-1111-4111-8111-111111111111",
        name: "Ada Actor",
        role: "actor",
        character: "The Lead",
        imageUrl: "https://image.tmdb.org/t/p/h632/ada.jpg",
      },
      {
        id: "dddddddd-2222-4222-8222-222222222222",
        name: "Dee Director",
        role: "director",
      },
    ]);
  });

  it("refuses to credit the people of an item the viewer cannot see", async () => {
    const { router } = buildRouter();
    const result = await call(
      router,
      "GET",
      `/ownAPI/v1/items/${HIDDEN_ITEM}/people`,
    );
    expect((result.error as OwnApiError).statusCode).toBe(404);
  });

  it("rejects a malformed cursor", async () => {
    const { router } = buildRouter();
    const result = await call(router, "GET", "/ownAPI/v1/movies?cursor=%%%bad");
    expect((result.error as OwnApiError).statusCode).toBe(422);
  });

  it("rejects an empty search query", async () => {
    const { router } = buildRouter();
    const result = await call(router, "GET", "/ownAPI/v1/search?q=%20%20");
    expect((result.error as OwnApiError).statusCode).toBe(422);
  });

  it("still finds a title when the query is misspelled", async () => {
    // The substring pass returns nothing for a typo, so this only passes if the
    // fuzzy fallback ran.
    const { router } = buildRouter();
    const result = await call(router, "GET", "/ownAPI/v1/search?q=dispossesed");

    expect(result.sent.statusCode).toBe(200);
    expect(
      (result.json?.data as Array<{ title: string }>).map((item) => item.title),
    ).toContain("The Dispossessed");
  });

  it("does not invent matches for a query nothing resembles", async () => {
    const { router } = buildRouter();
    const result = await call(router, "GET", "/ownAPI/v1/search?q=zzzzzzzz");

    expect(result.sent.statusCode).toBe(200);
    expect(result.json?.data).toEqual([]);
  });
});

describe("what a library's shelf holds", () => {
  const LIBRARY = "cccccccc-1111-4111-8111-111111111111";

  function withLibrary(kind: string) {
    const asked: Array<{ kinds?: string[]; libraryId?: string }> = [];
    const base = fakeCatalogue();
    const { router } = buildRouter({
      getLibrary: async () => ({
        id: LIBRARY,
        slug: kind,
        name: kind,
        kind,
        sortOrder: 0,
        itemCount: 0,
      }),
      listItems: async (options) => {
        asked.push({
          ...(options.kinds ? { kinds: [...options.kinds] } : {}),
          ...(options.libraryId ? { libraryId: options.libraryId } : {}),
        });
        return base.listItems(options);
      },
    });
    return { router, asked };
  }

  it.each(["movies", "series", "mixed"])(
    "lists no box sets on a %s shelf",
    async (kind) => {
      // A box set is made in its films' library; it is not one of the films.
      const { router, asked } = withLibrary(kind);
      await call(router, "GET", `/ownAPI/v1/libraries/${LIBRARY}/items`);
      expect(asked).toEqual([
        { kinds: ["movie", "series", "book"], libraryId: LIBRARY },
      ]);
    },
  );

  it("lists every box set the viewer may see on the collections shelf", async () => {
    const { router, asked } = withLibrary("collections");
    await call(router, "GET", `/ownAPI/v1/libraries/${LIBRARY}/items`);
    // No library filter: box sets live in their films' libraries.
    expect(asked).toEqual([{ kinds: ["collection"] }]);
  });
});

describe("titles with nothing to play", () => {
  function asking(administrator: boolean) {
    const asked: boolean[] = [];
    const base = fakeCatalogue();
    const { router } = buildRouter(
      {
        listItems: async (options) => {
          asked.push(options.includeMissing ?? false);
          return base.listItems(options);
        },
      },
      { administrator },
    );
    return { router, asked };
  }

  it("lists wanted titles for an administrator who asks", async () => {
    // The artwork manager dresses a film before it arrives.
    const { router, asked } = asking(true);
    await call(router, "GET", "/ownAPI/v1/movies?includeMissing=true");
    await call(router, "GET", "/ownAPI/v1/movies");
    expect(asked).toEqual([true, false]);
  });

  it("keeps a viewer's list to what can be played, whatever they ask", async () => {
    const { router, asked } = asking(false);
    await call(router, "GET", "/ownAPI/v1/movies?includeMissing=true");
    expect(asked).toEqual([false]);
  });
});

describe("progress routes", () => {
  it("accepts an advancing progress write and echoes the new state", async () => {
    const { router } = buildRouter();
    const result = await call(
      router,
      "PUT",
      `/ownAPI/v1/progress/${VISIBLE_ITEM}`,
      { body: { positionMs: 3_000_000, sequence: 1 } },
    );

    expect(result.sent.statusCode).toBe(200);
    expect(result.json?.data).toMatchObject({
      positionMs: 3_000_000,
      playedPercentage: 50,
    });
  });

  it("rejects a stale progress write with 409 instead of rewinding", async () => {
    const { router, userState } = buildRouter();
    await call(router, "PUT", `/ownAPI/v1/progress/${VISIBLE_ITEM}`, {
      body: { positionMs: 3_000_000, sequence: 5 },
    });

    const stale = await call(
      router,
      "PUT",
      `/ownAPI/v1/progress/${VISIBLE_ITEM}`,
      { body: { positionMs: 10_000, sequence: 2 } },
    );

    expect((stale.error as OwnApiError).statusCode).toBe(409);
    expect((stale.error as OwnApiError).code).toBe("PROGRESS_STALE");
    expect(Number(userState.records.get(VISIBLE_ITEM)?.positionMs)).toBe(
      3_000_000,
    );
  });

  it("rejects a progress body with unknown fields", async () => {
    const { router } = buildRouter();
    const result = await call(
      router,
      "PUT",
      `/ownAPI/v1/progress/${VISIBLE_ITEM}`,
      { body: { positionMs: 1, sequence: 1, isAdmin: true } },
    );
    expect((result.error as OwnApiError).statusCode).toBe(422);
  });

  it("refuses to write progress for an item the viewer cannot see", async () => {
    const { router } = buildRouter();
    const result = await call(
      router,
      "PUT",
      `/ownAPI/v1/progress/${HIDDEN_ITEM}`,
      { body: { positionMs: 1, sequence: 1 } },
    );
    expect((result.error as OwnApiError).statusCode).toBe(404);
  });

  it("requires CSRF evidence on a state change", async () => {
    const { router } = buildRouter();
    const result = await call(
      router,
      "POST",
      `/ownAPI/v1/items/${VISIBLE_ITEM}/played`,
      { headers: { origin: "https://seyirlik.test" } },
    );
    expect((result.error as OwnApiError).code).toBe("CSRF_REJECTED");
  });

  it("resets watched state recursively and reports how many rows changed", async () => {
    const { router } = buildRouter();
    const result = await call(
      router,
      "POST",
      `/ownAPI/v1/items/${VISIBLE_ITEM}/watched/reset`,
      { body: {} },
    );

    expect(result.sent.statusCode).toBe(200);
    expect(result.json?.data).toEqual({ affected: 7 });
  });
});
