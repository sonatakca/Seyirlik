import { describe, expect, it, vi } from "vitest";
import { createTmdbClient, isV4ReadAccessToken, TmdbError } from "./tmdbClient";

const V3_KEY = "d0000000000000000000000000000000";
const V4_TOKEN = "eyJhbGciOiJIUzI1NiJ9.payload.signature";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Captures the request the client would send, without making one. */
function captureFetch(body: unknown = { results: [] }) {
  const calls: Array<{ url: URL; headers: Record<string, string> }> = [];
  const fetchImpl = vi.fn(async (input: unknown, init?: RequestInit) => {
    calls.push({
      url: new URL(String(input)),
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    return jsonResponse(body);
  });
  return { calls, fetchImpl: fetchImpl as unknown as typeof fetch };
}

describe("isV4ReadAccessToken", () => {
  it("recognizes a v4 read access token by its JWT prefix", () => {
    expect(isV4ReadAccessToken(V4_TOKEN)).toBe(true);
    expect(isV4ReadAccessToken(`  ${V4_TOKEN}`)).toBe(true);
  });

  it("treats a 32-character hex key as v3", () => {
    expect(isV4ReadAccessToken(V3_KEY)).toBe(false);
  });
});

describe("TMDB credential handling", () => {
  /**
   * TMDB rejects a v3 key sent as a bearer token with 401. This was a real
   * failure against the live API, so both schemes are pinned here.
   */
  it("sends a v3 key as the api_key query parameter and no Authorization header", async () => {
    const { calls, fetchImpl } = captureFetch();
    await createTmdbClient({ apiKey: V3_KEY, fetchImpl }).searchMovies(
      "Dune",
      2021,
    );

    const call = calls[0];
    expect(call?.url.searchParams.get("api_key")).toBe(V3_KEY);
    expect(call?.headers.Authorization).toBeUndefined();
  });

  it("sends a v4 token as a bearer header and keeps it out of the query", async () => {
    const { calls, fetchImpl } = captureFetch();
    await createTmdbClient({ apiKey: V4_TOKEN, fetchImpl }).searchMovies(
      "Dune",
    );

    const call = calls[0];
    expect(call?.headers.Authorization).toBe(`Bearer ${V4_TOKEN}`);
    expect(call?.url.searchParams.get("api_key")).toBeNull();
  });

  it("refuses to start without a key rather than failing at the first lookup", () => {
    expect(() => createTmdbClient({ apiKey: "   " })).toThrow(
      "SEYIRLIK_TMDB_API_KEY is required",
    );
  });

  it("passes the search query and year through", async () => {
    const { calls, fetchImpl } = captureFetch();
    await createTmdbClient({ apiKey: V3_KEY, fetchImpl }).searchMovies(
      "Dune Part Two",
      2024,
    );

    expect(calls[0]?.url.searchParams.get("query")).toBe("Dune Part Two");
    expect(calls[0]?.url.searchParams.get("year")).toBe("2024");
  });

  it("uses the series date parameter when searching shows", async () => {
    const { calls, fetchImpl } = captureFetch();
    await createTmdbClient({ apiKey: V3_KEY, fetchImpl }).searchSeries(
      "Andor",
      2022,
    );

    expect(calls[0]?.url.pathname).toContain("/search/tv");
    expect(calls[0]?.url.searchParams.get("first_air_date_year")).toBe("2022");
  });

  it("maps provider status codes to typed errors", async () => {
    const notFound = createTmdbClient({
      apiKey: V3_KEY,
      fetchImpl: (async () => jsonResponse({}, 404)) as unknown as typeof fetch,
    });
    await expect(notFound.getMovie("1")).rejects.toMatchObject({
      kind: "not-found",
    });

    const rateLimited = createTmdbClient({
      apiKey: V3_KEY,
      fetchImpl: (async () => jsonResponse({}, 429)) as unknown as typeof fetch,
    });
    await expect(rateLimited.getMovie("1")).rejects.toMatchObject({
      kind: "rate-limited",
    });
  });

  it("never puts the credential into an error message", async () => {
    const client = createTmdbClient({
      apiKey: V3_KEY,
      fetchImpl: (async () => {
        throw new Error("socket hang up");
      }) as unknown as typeof fetch,
    });

    const error = await client.getMovie("1").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TmdbError);
    expect((error as Error).message).not.toContain(V3_KEY);
  });
});

describe("artwork listing", () => {
  const IMAGES = {
    posters: [
      {
        file_path: "/low.jpg",
        iso_639_1: "tr",
        width: 600,
        height: 900,
        aspect_ratio: 0.667,
        vote_average: 5.2,
        vote_count: 3,
      },
      {
        file_path: "/best.jpg",
        iso_639_1: "en",
        width: 2000,
        height: 3000,
        aspect_ratio: 0.667,
        vote_average: 8.1,
        vote_count: 40,
      },
      { file_path: "/broken.jpg" },
    ],
    backdrops: [
      {
        file_path: "/wide.jpg",
        iso_639_1: "",
        width: 3840,
        height: 2160,
        aspect_ratio: 1.778,
        vote_average: 6,
        vote_count: 9,
      },
    ],
    logos: [{ file_path: "/logo.png", iso_639_1: "tr" }],
  };

  it("asks for every language rather than the configured one", async () => {
    // A picker that only ever showed the configured language would have no
    // reason to exist: choosing the Turkish poster over the English one is the
    // whole point.
    const { calls, fetchImpl } = captureFetch(IMAGES);
    await createTmdbClient({
      apiKey: V3_KEY,
      language: "tr-TR",
      fetchImpl,
    }).listArtwork("movie", "438631");

    const call = calls[0];
    expect(call?.url.pathname).toBe("/3/movie/438631/images");
    expect(call?.url.searchParams.get("language")).toBeNull();
  });

  it("ranks candidates by vote and reads a blank language as language-neutral", async () => {
    const { fetchImpl } = captureFetch(IMAGES);
    const artwork = await createTmdbClient({
      apiKey: V3_KEY,
      fetchImpl,
    }).listArtwork("movie", "438631");

    const posters = artwork.filter((image) => image.kind === "poster");
    expect(posters.map((image) => image.filePath)).toEqual([
      "/best.jpg",
      "/low.jpg",
      "/broken.jpg",
    ]);
    expect(posters[0]).toMatchObject({
      language: "en",
      width: 2000,
      voteCount: 40,
    });

    // TMDB writes "" for artwork with no text, which is a category of its own
    // and not a missing value.
    expect(
      artwork.find((image) => image.kind === "backdrop")?.language,
    ).toBeNull();
    expect(artwork.filter((image) => image.kind === "logo")).toHaveLength(1);
  });

  it("keeps a title lookup in the language it was asked for", async () => {
    const { calls, fetchImpl } = captureFetch({ title: "Düne" });
    await createTmdbClient({
      apiKey: V3_KEY,
      language: "en-US",
      fetchImpl,
    }).getMovie("438631", "tr-TR");

    expect(calls[0]?.url.searchParams.get("language")).toBe("tr-TR");
    expect(calls[0]?.url.searchParams.get("include_image_language")).toBe(
      "tr,en,null",
    );
  });
});

describe("IMDb identity", () => {
  /*
   * A movie's details carry `imdb_id`; a series' do not. Without asking for
   * external ids, every show ends up with a TMDB id and no IMDb one, which
   * stays invisible until something has to match a show against the identity
   * another application recorded against it.
   */
  it("asks TMDB for external ids so a series can carry an IMDb id", async () => {
    const { calls, fetchImpl } = captureFetch({
      id: 1398,
      name: "The Sopranos",
    });
    await createTmdbClient({ apiKey: V3_KEY, fetchImpl }).getSeries("1398");
    expect(calls[0]?.url.searchParams.get("append_to_response")).toContain(
      "external_ids",
    );
  });

  it("reads a series IMDb id from external ids", async () => {
    const { fetchImpl } = captureFetch({
      id: 1398,
      name: "The Sopranos",
      external_ids: { imdb_id: "tt0141842" },
    });
    const details = await createTmdbClient({
      apiKey: V3_KEY,
      fetchImpl,
    }).getSeries("1398");
    expect(details.imdbId).toBe("tt0141842");
  });

  it("still reads a movie IMDb id from the details themselves", async () => {
    const { fetchImpl } = captureFetch({
      id: 550,
      title: "Fight Club",
      imdb_id: "tt0137523",
    });
    const details = await createTmdbClient({
      apiKey: V3_KEY,
      fetchImpl,
    }).getMovie("550");
    expect(details.imdbId).toBe("tt0137523");
  });

  it("reads the box set a film belongs to", async () => {
    const { fetchImpl } = captureFetch({
      id: 603,
      title: "The Matrix",
      belongs_to_collection: { id: 2344, name: "The Matrix Collection" },
    });
    const details = await createTmdbClient({
      apiKey: V3_KEY,
      fetchImpl,
    }).getMovie("603");
    expect(details.collection).toEqual({
      providerId: "2344",
      name: "The Matrix Collection",
    });
  });

  it("records a film's Turkish age rating before its American one", async () => {
    const { fetchImpl } = captureFetch({
      id: 550,
      title: "Fight Club",
      release_dates: {
        results: [
          {
            iso_3166_1: "US",
            release_dates: [{ certification: "R", type: 3 }],
          },
          {
            iso_3166_1: "TR",
            release_dates: [
              { certification: "", type: 1 },
              { certification: "18+", type: 3 },
            ],
          },
        ],
      },
    });
    const details = await createTmdbClient({
      apiKey: V3_KEY,
      fetchImpl,
    }).getMovie("550");
    expect(details.officialRating).toBe("18+");
  });

  it("falls back to the American rating, and reads a series' content rating", async () => {
    const film = captureFetch({
      id: 603,
      title: "The Matrix",
      release_dates: {
        results: [
          {
            iso_3166_1: "US",
            release_dates: [{ certification: "R", type: 3 }],
          },
        ],
      },
    });
    expect(
      (
        await createTmdbClient({
          apiKey: V3_KEY,
          fetchImpl: film.fetchImpl,
        }).getMovie("603")
      ).officialRating,
    ).toBe("R");

    const series = captureFetch({
      id: 1398,
      name: "The Sopranos",
      content_ratings: { results: [{ iso_3166_1: "US", rating: "TV-MA" }] },
    });
    expect(
      (
        await createTmdbClient({
          apiKey: V3_KEY,
          fetchImpl: series.fetchImpl,
        }).getSeries("1398")
      ).officialRating,
    ).toBe("TV-MA");
  });

  it("records no rating when the provider has none", async () => {
    const { fetchImpl } = captureFetch({ id: 1, title: "Unrated" });
    const details = await createTmdbClient({
      apiKey: V3_KEY,
      fetchImpl,
    }).getMovie("1");
    expect(details.officialRating).toBeUndefined();
  });

  it("keeps each credited person's headshot, and none for those without", async () => {
    const { fetchImpl } = captureFetch({
      id: 359724,
      title: "Ford v Ferrari",
      credits: {
        cast: [
          {
            id: 1892,
            name: "Matt Damon",
            character: "Carroll Shelby",
            order: 0,
            profile_path: "/damon.jpg",
          },
          {
            id: 9,
            name: "No Picture",
            character: "Extra",
            order: 1,
            profile_path: null,
          },
        ],
        crew: [
          {
            id: 366,
            name: "James Mangold",
            job: "Director",
            profile_path: "/mangold.jpg",
          },
        ],
      },
    });
    const details = await createTmdbClient({
      apiKey: V3_KEY,
      fetchImpl,
    }).getMovie("359724");
    expect(details.people).toEqual([
      {
        providerId: "1892",
        name: "Matt Damon",
        role: "actor",
        character: "Carroll Shelby",
        order: 0,
        profilePath: "/damon.jpg",
      },
      {
        providerId: "9",
        name: "No Picture",
        role: "actor",
        character: "Extra",
        order: 1,
      },
      {
        providerId: "366",
        name: "James Mangold",
        role: "director",
        order: 100,
        profilePath: "/mangold.jpg",
      },
    ]);
  });

  it("reads a person's headshot from their own record", async () => {
    const { calls, fetchImpl } = captureFetch({
      id: 1892,
      profile_path: "/damon.jpg",
    });
    const client = createTmdbClient({ apiKey: V3_KEY, fetchImpl });
    expect(await client.getPersonProfilePath!("1892")).toBe("/damon.jpg");
    expect(calls[0]?.url.pathname).toBe("/3/person/1892");

    const { fetchImpl: bare } = captureFetch({ id: 9, profile_path: null });
    expect(
      await createTmdbClient({ apiKey: V3_KEY, fetchImpl: bare })
        .getPersonProfilePath!("9"),
    ).toBeNull();
  });

  it("describes a collection from its own record", async () => {
    const { calls, fetchImpl } = captureFetch({
      id: 2344,
      name: "The Matrix Collection",
      overview: "The trilogy.",
      poster_path: "/p.jpg",
      backdrop_path: "/b.jpg",
    });
    const collection = await createTmdbClient({
      apiKey: V3_KEY,
      fetchImpl,
    }).getCollection!("2344");
    expect(calls[0]?.url.pathname).toBe("/3/collection/2344");
    expect(collection).toEqual({
      providerId: "2344",
      name: "The Matrix Collection",
      overview: "The trilogy.",
      posterPath: "/p.jpg",
      backdropPath: "/b.jpg",
    });
  });
});

describe("a title's names in other languages", () => {
  function translation(
    language: string,
    region: string,
    data: Record<string, string>,
  ) {
    return { iso_639_1: language, iso_3166_1: region, data };
  }

  it("asks for translations in the same request as the details", async () => {
    const { calls, fetchImpl } = captureFetch({ id: 106646, title: "x" });
    await createTmdbClient({ apiKey: V3_KEY, fetchImpl }).getMovie("106646");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url.searchParams.get("append_to_response")).toContain(
      "translations",
    );
  });

  it("reads Turkish and English names, and the original stands in for its own language", async () => {
    // TMDB leaves the English translation's title empty for an English film.
    const { fetchImpl } = captureFetch({
      id: 106646,
      title: "The Wolf of Wall Street",
      original_title: "The Wolf of Wall Street",
      original_language: "en",
      translations: {
        translations: [
          translation("en", "US", { title: "" }),
          translation("tr", "TR", { title: "Para Avcısı" }),
          translation("fr", "FR", { title: "Le Loup de Wall Street" }),
        ],
      },
    });
    const details = await createTmdbClient({
      apiKey: V3_KEY,
      fetchImpl,
    }).getMovie("106646");
    expect(details.localizedTitles).toEqual({
      tr: "Para Avcısı",
      en: "The Wolf of Wall Street",
    });
  });

  it("prefers the home region's wording and reads a series' names", async () => {
    const { fetchImpl } = captureFetch({
      id: 1,
      name: "Dark",
      original_name: "Dark",
      original_language: "de",
      translations: {
        translations: [
          translation("en", "GB", { name: "Dark (UK)" }),
          translation("en", "US", { name: "Dark" }),
          translation("tr", "TR", { name: "Karanlık" }),
        ],
      },
    });
    const details = await createTmdbClient({
      apiKey: V3_KEY,
      fetchImpl,
    }).getSeries("1");
    expect(details.localizedTitles).toEqual({ tr: "Karanlık", en: "Dark" });
  });

  it("leaves out a language TMDB has no name in", async () => {
    const { fetchImpl } = captureFetch({
      id: 2,
      title: "Le Fabuleux Destin d'Amélie Poulain",
      original_title: "Le Fabuleux Destin d'Amélie Poulain",
      original_language: "fr",
      translations: { translations: [] },
    });
    const details = await createTmdbClient({
      apiKey: V3_KEY,
      language: "tr-TR",
      fetchImpl,
    }).getMovie("2");
    // Asked in Turkish, TMDB's answer is the title it shows Turkish viewers.
    expect(details.localizedTitles).toEqual({
      tr: "Le Fabuleux Destin d'Amélie Poulain",
    });
  });
});
