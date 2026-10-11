// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createReleaseRoutes } from "./releaseRoutes";
import { profileFromIds } from "./qualityProfile";
import { HEVC_PREFERENCE } from "./preferences";
import type { PolicyRepository } from "./policyRepository";
import type { BlocklistRepository } from "./blocklistRepository";
import type { RouteContext, RouteDefinition } from "../api/router";
import type {
  IndexerRelease,
  IndexerSearchQuery,
} from "../indexers/indexerTypes";
import type { TmdbClient } from "../metadata/tmdbClient";
import type { IndexerSearchService } from "../indexers/searchService";

const SECRET = "0123456789abcdef0123456789abcdef";

let counter = 0;
function release(
  title: string,
  extra: Partial<IndexerRelease> = {},
): IndexerRelease {
  counter += 1;
  return {
    indexerId: "nzbgeek",
    indexerName: "NZBgeek",
    protocol: "usenet",
    guid: `g-${counter}`,
    title,
    downloadUrl: `https://api.invalid/api?t=get&id=1&apikey=${SECRET}`,
    categoryIds: [2000],
    attributes: {},
    ...extra,
  };
}

const policies: PolicyRepository = {
  listProfiles: async () => [
    { id: "p1", name: "HD-1080p", maxSizeBytes: 30_000_000_000 },
  ],
  load: async (id) =>
    id === "p1"
      ? {
          profile: profileFromIds(
            "p1",
            "HD-1080p",
            ["hdtv-1080p", "webdl-1080p", "bluray-1080p"],
            { cutoffQualityId: "bluray-1080p" },
          ),
          preferences: [{ ...HEVC_PREFERENCE, id: "r1" }],
        }
      : null,
  setMaxSize: async (id) => id === "11111111-1111-4111-8111-111111111111",
};

function routes(
  releases: readonly IndexerRelease[],
  blockedTitles: readonly string[] = [],
): RouteDefinition[] {
  const search: IndexerSearchService = {
    search: vi.fn(async () => ({
      releases,
      outcomes: [
        {
          indexerId: "nzbgeek",
          indexerName: "NZBgeek",
          ok: true,
          returned: releases.length,
        },
      ],
      partial: false,
    })),
  };
  const blocklist = {
    matcherFor: async () => (candidate: { title: string }) =>
      blockedTitles.includes(candidate.title),
    list: async () => [],
    remove: async () => false,
    add: async () => undefined,
  } as BlocklistRepository;
  return createReleaseRoutes({ search, policies, blocklist });
}

function invoke(
  route: RouteDefinition,
  body?: unknown,
): Promise<{ status: number; payload: unknown }> {
  const captured = { status: 0, payload: undefined as unknown };
  const context = {
    request: { once: () => undefined, off: () => undefined },
    response: {
      setHeader: () => undefined,
      end: (chunk?: string) => {
        captured.payload = chunk ? JSON.parse(chunk) : undefined;
      },
      get headersSent() {
        return false;
      },
      writeHead: (status: number) => {
        captured.status = status;
      },
    },
    requestId: "req",
    url: new URL("http://localhost/ownAPI/v1/releases/evaluate"),
    params: {},
    method: "POST",
    principal: { userId: "u", isAdministrator: true },
    requirePrincipal: () => ({ userId: "u", isAdministrator: true }),
    readJson: async () => body,
  } as unknown as RouteContext;
  return route.handle(context).then(() => captured);
}

const evaluate = (
  releases: readonly IndexerRelease[],
  blockedTitles: readonly string[] = [],
) =>
  routes(releases, blockedTitles).find(
    (route) => route.path === "/releases/evaluate",
  )!;

interface EvaluateBody {
  data: {
    winner: { title: string; quality: string; score: number } | null;
    candidates: Array<{
      title: string;
      accepted: boolean;
      rejection?: string;
      reasons: Array<{ code: string; detail: string }>;
    }>;
    profile: { id: string; name: string };
  };
}

describe("searching and judging in one request", () => {
  const candidates = [
    release("Blade.Runner.2049.2017.1080p.WEB-DL.x265-A"),
    release("Blade.Runner.2049.2017.1080p.BluRay.x264-B"),
    release("Blade.Runner.2049.2017.720p.HDTV-C"),
    release("Some.Other.Film.2020.1080p.BluRay-D"),
  ];

  it("returns a winner and a verdict for every candidate", async () => {
    const { payload } = await invoke(evaluate(candidates), {
      kind: "movie",
      title: "Blade Runner 2049",
      year: 2017,
      profileId: "p1",
    });
    const data = (payload as EvaluateBody).data;
    expect(data.winner?.title).toContain("BluRay");
    expect(data.winner?.quality).toBe("BluRay 1080p");
    expect(data.candidates).toHaveLength(4);
    expect(data.profile).toEqual({ id: "p1", name: "HD-1080p" });
  });

  it("explains each rejection", async () => {
    const { payload } = await invoke(evaluate(candidates), {
      kind: "movie",
      title: "Blade Runner 2049",
      year: 2017,
      profileId: "p1",
    });
    const rejections = (payload as EvaluateBody).data.candidates
      .filter((c) => !c.accepted)
      .map((c) => c.rejection);
    expect(rejections).toContain("quality-not-allowed");
    expect(rejections).toContain("title-mismatch");
    for (const candidate of (payload as EvaluateBody).data.candidates) {
      expect(candidate.reasons.length).toBeGreaterThan(0);
    }
  });

  it("reports no winner rather than inventing one", async () => {
    const { payload } = await invoke(
      evaluate([release("Nothing.Relevant.2020.720p.HDTV-X")]),
      {
        kind: "movie",
        title: "Blade Runner 2049",
        profileId: "p1",
      },
    );
    expect((payload as EvaluateBody).data.winner).toBeNull();
  });

  it("judges an episode target", async () => {
    const { payload } = await invoke(
      evaluate([release("The.Expanse.S05E03.1080p.WEB-DL.x265-NTb")]),
      {
        kind: "episode",
        title: "The Expanse",
        season: 5,
        episode: 3,
        profileId: "p1",
      },
    );
    const data = (payload as EvaluateBody).data;
    expect(data.winner?.title).toContain("S05E03");
    expect(data.winner?.score).toBe(100);
  });

  it("takes what is already held into account", async () => {
    const { payload } = await invoke(evaluate(candidates), {
      kind: "movie",
      title: "Blade Runner 2049",
      year: 2017,
      profileId: "p1",
      currentQualityId: "webdl-1080p",
    });
    // The profile does not upgrade, so nothing can replace what is held.
    const data = (payload as EvaluateBody).data;
    expect(data.winner).toBeNull();
    expect(
      data.candidates.some((c) => c.rejection === "upgrade-not-wanted"),
    ).toBe(true);
  });
});

describe("what the route will not do", () => {
  it("offers no route that fetches or grabs anything", () => {
    const paths = routes([]).map((route) => `${route.method} ${route.path}`);
    expect(paths).toEqual([
      "GET /releases/profiles",
      "PATCH /releases/profiles/:profileId",
      "GET /releases/blocklist",
      "DELETE /releases/blocklist/:entryId",
      "POST /releases/evaluate",
    ]);
    expect(paths.join(" ")).not.toMatch(/grab|download|nzb|queue/i);
  });

  it("requires an administrator", () => {
    for (const route of routes([])) expect(route.access).toBe("admin");
  });

  it("never returns the credential-bearing download URL", async () => {
    const { payload } = await invoke(
      evaluate([release("Blade.Runner.2049.2017.1080p.BluRay-A")]),
      {
        kind: "movie",
        title: "Blade Runner 2049",
        profileId: "p1",
      },
    );
    const serialised = JSON.stringify(payload);
    expect(serialised).not.toContain(SECRET);
    expect(serialised).not.toContain("apikey");
    expect(serialised).not.toContain("downloadUrl");
  });

  it.each([
    ["no title", { profileId: "p1" }],
    ["an unknown kind", { kind: "boxset", title: "X", profileId: "p1" }],
    [
      "an episode with no season",
      { kind: "episode", title: "X", episode: 1, profileId: "p1" },
    ],
    [
      "an episode with no episode number",
      { kind: "episode", title: "X", season: 1, profileId: "p1" },
    ],
    ["no profile", { kind: "movie", title: "X" }],
    [
      "an unexpected field",
      { kind: "movie", title: "X", profileId: "p1", grab: true },
    ],
    [
      "a current quality that is not one",
      { kind: "movie", title: "X", profileId: "p1", currentQualityId: "nope" },
    ],
  ])("refuses %s", async (_label, body) => {
    await expect(invoke(evaluate([]), body)).rejects.toMatchObject({
      statusCode: 422,
    });
  });

  it("answers 404 for a profile that does not exist", async () => {
    await expect(
      invoke(evaluate([]), { kind: "movie", title: "X", profileId: "missing" }),
    ).rejects.toMatchObject({ code: "PROFILE_NOT_FOUND", statusCode: 404 });
  });
});

describe("the blocklist and the size limit", () => {
  it("rejects a blocklisted release and recommends the next", async () => {
    const { payload } = await invoke(
      evaluate(
        [
          release("Blade.Runner.2049.2017.1080p.BluRay.x265-A"),
          release("Blade.Runner.2049.2017.1080p.WEB-DL.x265-B"),
        ],
        ["Blade.Runner.2049.2017.1080p.BluRay.x265-A"],
      ),
      { kind: "movie", title: "Blade Runner 2049", profileId: "p1" },
    );
    const data = (payload as EvaluateBody).data;
    expect(data.winner?.title).toBe(
      "Blade.Runner.2049.2017.1080p.WEB-DL.x265-B",
    );
    expect(data.candidates.find((c) => c.title.endsWith("-A"))).toMatchObject({
      accepted: false,
      rejection: "blocklisted",
    });
  });

  const patch = () =>
    routes([]).find(
      (route) =>
        route.method === "PATCH" &&
        route.path === "/releases/profiles/:profileId",
    )!;

  function invokePatch(profileId: string, body: unknown) {
    const captured = { status: 0, payload: undefined as unknown };
    const context = {
      request: { once: () => undefined, off: () => undefined },
      response: {
        setHeader: () => undefined,
        end: (chunk?: string) => {
          captured.payload = chunk ? JSON.parse(chunk) : undefined;
        },
        get headersSent() {
          return false;
        },
      },
      requestId: "req",
      url: new URL("http://localhost/ownAPI/v1/releases/profiles/x"),
      params: { profileId },
      method: "PATCH",
      requirePrincipal: () => ({ userId: "u", isAdministrator: true }),
      readJson: async () => body,
    } as unknown as RouteContext;
    return patch()
      .handle(context)
      .then(() => captured);
  }

  const ID = "11111111-1111-4111-8111-111111111111";

  it("sets a profile's limit, and clears it with null", async () => {
    const set = await invokePatch(ID, { maxSizeBytes: 50_000_000_000 });
    expect((set.payload as { data: unknown }).data).toEqual({
      profile: { id: ID, maxSizeBytes: 50_000_000_000 },
    });
    const cleared = await invokePatch(ID, { maxSizeBytes: null });
    expect((cleared.payload as { data: unknown }).data).toEqual({
      profile: { id: ID, maxSizeBytes: null },
    });
  });

  it.each([0, -1, 1.5, "30", 2_000_000_000_000])(
    "refuses a limit of %s",
    async (value) => {
      await expect(
        invokePatch(ID, { maxSizeBytes: value }),
      ).rejects.toMatchObject({ statusCode: 422 });
    },
  );

  it("answers 404 for a profile that does not exist", async () => {
    await expect(
      invokePatch("22222222-2222-4222-8222-222222222222", {
        maxSizeBytes: 1,
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe("searching for the title the words mean", () => {
  const darkKnight = [
    release("The.Dark.Knight.2008.1080p.BluRay.x264-Q"),
    release("The.Dark.Knight.Rises.2012.1080p.BluRay.x264-Q"),
  ];

  function routesWith(
    answer: (query: IndexerSearchQuery) => readonly IndexerRelease[],
    tmdb?: TmdbClient,
  ) {
    const search = vi.fn(async (query: IndexerSearchQuery) => {
      const releases = answer(query);
      return {
        releases,
        outcomes: [
          {
            indexerId: "nzbgeek",
            indexerName: "NZBgeek",
            ok: true,
            returned: releases.length,
          },
        ],
        partial: false,
      };
    });
    const blocklist = {
      matcherFor: async () => () => false,
    } as unknown as BlocklistRepository;
    const route = createReleaseRoutes({
      search: { search },
      policies,
      blocklist,
      ...(tmdb ? { tmdb } : {}),
    }).find((entry) => entry.path === "/releases/evaluate")!;
    return { route, search };
  }

  const tmdb = {
    searchMovies: vi.fn(
      async (_title: string, _year?: number, language?: string) =>
        language === "tr-TR"
          ? [
              {
                providerId: "155",
                title: "Kara Şövalye",
                originalTitle: "The Dark Knight",
                year: 2008,
                popularity: 57,
              },
            ]
          : [],
    ),
    getMovie: vi.fn(async () => ({
      providerId: "155",
      title: "The Dark Knight",
      releaseDate: "2008-07-16",
      imdbId: "tt0468569",
      genres: [],
      people: [],
      backdropPaths: [],
    })),
  } as unknown as TmdbClient;

  it("asks the indexer by IMDb id and accepts the English release name", async () => {
    const { route, search } = routesWith(
      (query) => (query.imdbId === "tt0468569" ? darkKnight : []),
      tmdb,
    );
    const { payload } = await invoke(route, {
      kind: "movie",
      title: "kara sovalye",
      profileId: "p1",
    });
    const data = (payload as { data: Record<string, unknown> }).data as {
      resolved: { title: string; imdbId: string };
      searchedFor: unknown;
      winner: { title: string } | null;
      candidates: Array<{ rejection?: string }>;
    };
    expect(search).toHaveBeenCalledTimes(1);
    expect(data.searchedFor).toEqual({ imdbId: "tt0468569" });
    expect(data.resolved).toMatchObject({
      title: "Kara Şövalye",
      imdbId: "tt0468569",
    });
    expect(data.winner?.title).toBe("The.Dark.Knight.2008.1080p.BluRay.x264-Q");
    expect(data.candidates.map((c) => c.rejection)).toContain("title-mismatch");
  });

  it("falls back to the English name when the id finds nothing", async () => {
    const { route, search } = routesWith(
      (query) => (query.term === "The Dark Knight" ? darkKnight : []),
      tmdb,
    );
    const { payload } = await invoke(route, {
      kind: "movie",
      title: "kara sovalye",
      profileId: "p1",
    });
    expect(
      search.mock.calls.map(([query]) => query.imdbId ?? query.term),
    ).toEqual(["tt0468569", "The Dark Knight"]);
    expect(
      (payload as { data: { searchedFor: unknown } }).data.searchedFor,
    ).toEqual({ term: "The Dark Knight" });
  });

  it("folds the typed words when there is no TMDB to ask", async () => {
    const { route, search } = routesWith(() => []);
    await invoke(route, {
      kind: "movie",
      title: "Joker: Folie à Deux",
      year: 2024,
      profileId: "p1",
    });
    expect(search.mock.calls[0]![0].term).toBe("Joker Folie a Deux");
  });

  it("still searches the typed words when TMDB is down", async () => {
    const down = {
      searchMovies: vi.fn(async () => {
        throw new Error("unavailable");
      }),
    } as unknown as TmdbClient;
    const { route, search } = routesWith(() => [], down);
    const { payload } = await invoke(route, {
      kind: "movie",
      title: "Kara Şövalye",
      profileId: "p1",
    });
    expect(search.mock.calls[0]![0].term).toBe("Kara Sovalye");
    expect(
      (payload as { data: { resolved: unknown } }).data.resolved,
    ).toBeNull();
  });
});
