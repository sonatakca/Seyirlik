// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { MatchCandidate } from "../metadata/matcher";
import type { TmdbClient, TmdbTitleDetails } from "../metadata/tmdbClient";
import { foldLatin, indexerTerm, resolveTitleIdentity } from "./titleIdentity";

/** What TMDB answered for these words on 2026-10-11, trimmed. */
const SEARCHES: Record<string, Record<string, MatchCandidate[]>> = {
  "tr-TR": {
    "kara sovalye": [
      {
        providerId: "155",
        title: "Kara Şövalye",
        originalTitle: "The Dark Knight",
        year: 2008,
        popularity: 57,
      },
      {
        providerId: "49026",
        title: "Kara Şövalye Yükseliyor",
        originalTitle: "The Dark Knight Rises",
        year: 2012,
        popularity: 45,
      },
      {
        providerId: "11469",
        title: "Kara Şövalye",
        originalTitle: "Black Knight",
        year: 2001,
        popularity: 12,
      },
    ],
  },
  "en-US": {
    "kara sovalye": [
      { providerId: "272", title: "Batman Begins", year: 2005, popularity: 34 },
    ],
  },
};

const DETAILS: Record<string, Partial<TmdbTitleDetails>> = {
  "155": {
    title: "The Dark Knight",
    releaseDate: "2008-07-16",
    imdbId: "tt0468569",
  },
  "889737": {
    title: "Joker: Folie à Deux",
    releaseDate: "2024-10-01",
    imdbId: "tt11315808",
  },
};

function fakeTmdb(): TmdbClient {
  const search = async (title: string, _year?: number, language?: string) =>
    SEARCHES[language ?? "en-US"]?.[title] ?? [];
  const details = async (id: string) =>
    ({
      providerId: id,
      genres: [],
      people: [],
      backdropPaths: [],
      ...DETAILS[id],
    }) as TmdbTitleDetails;
  return {
    searchMovies: vi.fn(search),
    searchSeries: vi.fn(search),
    getMovie: vi.fn(details),
    getSeries: vi.fn(details),
    listArtwork: async () => [],
    getSeasonEpisodes: async () => [],
    buildImageUrl: (path) => path,
  };
}

describe("folding a title into words an indexer matches", () => {
  it.each([
    ["Joker: Folie à Deux", "Joker Folie a Deux"],
    ["Kara Şövalye", "Kara Sovalye"],
    ["Kılıç Günü", "Kilic Gunu"],
    ["Ocean's Eleven", "Oceans Eleven"],
    ["Lock, Stock & Two Smoking Barrels", "Lock Stock Two Smoking Barrels"],
  ])("%s → %s", (title, term) => {
    expect(indexerTerm(title)).toBe(term);
  });

  it("leaves nothing for a title with no Latin letters", () => {
    expect(indexerTerm("千と千尋の神隠し")).toBe("");
  });

  it("spells out the letters NFKD cannot decompose", () => {
    expect(foldLatin("ıßæøł")).toBe("issaeol");
  });
});

describe("resolving typed words to a title", () => {
  it("finds a Turkish title typed without its marks", async () => {
    const { identity, alternatives } = await resolveTitleIdentity(fakeTmdb(), {
      kind: "movie",
      title: "kara sovalye",
    });
    expect(identity).toEqual({
      tmdbId: "155",
      title: "Kara Şövalye",
      englishTitle: "The Dark Knight",
      year: 2008,
      imdbId: "tt0468569",
    });
    // Near enough to be meant, so offered — never chosen in its place.
    expect(alternatives.map((choice) => choice.tmdbId)).toEqual([
      "49026",
      "11469",
    ]);
    expect(alternatives[1]).toMatchObject({
      title: "Kara Şövalye",
      originalTitle: "Black Knight",
      year: 2001,
    });
  });

  it("leaves words alone that name nothing close", async () => {
    const { identity } = await resolveTitleIdentity(fakeTmdb(), {
      kind: "movie",
      title: "joker",
    });
    expect(identity).toBeNull();
  });

  it("describes a title it was handed without searching", async () => {
    const tmdb = fakeTmdb();
    const { identity } = await resolveTitleIdentity(tmdb, {
      kind: "movie",
      title: "Joker: İkili Delilik",
      tmdbId: "889737",
    });
    expect(identity?.imdbId).toBe("tt11315808");
    expect(identity?.englishTitle).toBe("Joker: Folie à Deux");
    expect(tmdb.searchMovies).not.toHaveBeenCalled();
  });
});
