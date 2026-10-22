// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { IndexerRelease } from "../indexers/indexerTypes";
import { compareCandidates, selectRelease, type MediaTarget } from "./decide";
import { HEVC_PREFERENCE } from "./preferences";
import { profileFromIds } from "./qualityProfile";
import { qualityOf } from "./quality";
import { parseRelease } from "./parseRelease";

let counter = 0;
function release(
  title: string,
  extra: Partial<IndexerRelease> = {},
): IndexerRelease {
  counter += 1;
  return {
    indexerId: "ix",
    indexerName: "Indexer",
    protocol: "usenet",
    guid: `guid-${String(counter).padStart(4, "0")}`,
    title,
    downloadUrl: "https://x.invalid/get?apikey=SECRET",
    categoryIds: [2000],
    attributes: {},
    ...extra,
  };
}

const profile = profileFromIds(
  "hd",
  "HD-1080p",
  ["hdtv-1080p", "webrip-1080p", "webdl-1080p", "bluray-1080p", "remux-1080p"],
  { cutoffQualityId: "bluray-1080p" },
);

const wide = profileFromIds(
  "wide",
  "Wide",
  [
    ["webrip-1080p", "webdl-1080p", "bluray-1080p"],
    ["webrip-2160p", "webdl-2160p", "bluray-2160p"],
  ],
  { cutoffQualityId: "webrip-2160p" },
);

const movie: MediaTarget = {
  kind: "movie",
  title: "blade runner 2049",
  year: 2017,
};
const policy = { profile, preferences: [HEVC_PREFERENCE], current: null };

describe("choosing a release for a movie", () => {
  it("picks the best allowed candidate and explains the rest", () => {
    const result = selectRelease(
      movie,
      [
        release("Blade.Runner.2049.2017.1080p.WEB-DL.x264-A"),
        release("Blade.Runner.2049.2017.1080p.BluRay.x264-B"),
        release("Blade.Runner.2049.2017.720p.HDTV.x264-C"),
      ],
      policy,
    );
    expect(result.winner?.release.title).toContain("BluRay");
    expect(result.candidates).toHaveLength(3);
    const rejected = result.candidates.find((c) => !c.accepted);
    expect(rejected?.rejection).toBe("quality-not-allowed");
  });

  it("returns no winner rather than a bad one when nothing is acceptable", () => {
    const result = selectRelease(
      movie,
      [
        release("Blade.Runner.2049.2017.720p.HDTV-C"),
        release("Some.Other.Film.2019.1080p.BluRay-D"),
      ],
      policy,
    );
    expect(result.winner).toBeUndefined();
    expect(result.candidates.every((c) => !c.accepted)).toBe(true);
  });

  it("keeps every candidate, including the rejected ones", () => {
    // Nothing is silently dropped: a rejected candidate is the answer to
    // "why not that one", which is the question an operator actually asks.
    const result = selectRelease(
      movie,
      [
        release("Blade.Runner.2049.2017.1080p.BluRay-A"),
        release("Completely.Different.2020.1080p.BluRay-B"),
        release("Blade.Runner.2049.2019.1080p.BluRay-C"),
      ],
      policy,
    );
    expect(result.candidates).toHaveLength(3);
    expect(
      result.candidates
        .map((c) => c.rejection)
        .filter(Boolean)
        .sort(),
    ).toEqual(["title-mismatch", "wrong-year"]);
  });

  it.each([
    ["Completely.Different.Film.2017.1080p.BluRay-X", "title-mismatch"],
    ["Blade.Runner.2049.2011.1080p.BluRay-X", "wrong-year"],
    ["Blade.Runner.2049.2017.720p.HDTV-X", "quality-not-allowed"],
    ["Blade.Runner.2049.S01E01.1080p.BluRay-X", "wrong-kind"],
  ])("rejects %s as %s", (title, code) => {
    const result = selectRelease(movie, [release(title)], policy);
    expect(result.candidates[0]!.rejection).toBe(code);
    expect(result.winner).toBeUndefined();
  });

  it("tolerates a year that drifts by one but not by more", () => {
    // A December release is routinely tagged with the following year.
    expect(
      selectRelease(
        movie,
        [release("Blade.Runner.2049.2018.1080p.BluRay-X")],
        policy,
      ).winner,
    ).toBeDefined();
    expect(
      selectRelease(
        movie,
        [release("Blade.Runner.2049.2015.1080p.BluRay-X")],
        policy,
      ).winner,
    ).toBeUndefined();
  });

  it("does not require a year the release never stated", () => {
    expect(
      selectRelease(
        movie,
        [release("Blade.Runner.2049.1080p.BluRay-X")],
        policy,
      ).winner,
    ).toBeDefined();
  });
});

describe("releases that are never chosen", () => {
  const GB = 1_000_000_000;
  const capped = { ...profile, maxSizeBytes: 30 * GB };

  it("refuses a release larger than the profile's limit", () => {
    const result = selectRelease(
      movie,
      [
        release("Blade.Runner.2049.2017.1080p.Remux-A", {
          sizeBytes: 45 * GB,
        }),
        release("Blade.Runner.2049.2017.1080p.BluRay.x265-B", {
          sizeBytes: 12 * GB,
        }),
      ],
      { ...policy, profile: capped },
    );
    expect(result.winner?.release.title).toBe(
      "Blade.Runner.2049.2017.1080p.BluRay.x265-B",
    );
    const remux = result.candidates.find((c) => c.release.title.endsWith("-A"));
    expect(remux).toMatchObject({ accepted: false, rejection: "too-large" });
    expect(remux!.reasons[0]!.detail).toContain("45.0 GB");
    expect(remux!.reasons[0]!.detail).toContain("30.0 GB");
  });

  it("accepts exactly the limit, and a release that states no size", () => {
    const result = selectRelease(
      movie,
      [
        release("Blade.Runner.2049.2017.1080p.BluRay-A", {
          sizeBytes: 30 * GB,
        }),
        release("Blade.Runner.2049.2017.1080p.WEB-DL-B"),
      ],
      { ...policy, profile: capped },
    );
    expect(result.candidates.every((c) => c.accepted)).toBe(true);
  });

  it("has no limit when the profile sets none", () => {
    const result = selectRelease(
      movie,
      [
        release("Blade.Runner.2049.2017.1080p.BluRay-A", {
          sizeBytes: 90 * GB,
        }),
      ],
      policy,
    );
    expect(result.winner).toBeDefined();
  });

  it("never chooses a blocklisted release, and falls to the next best", () => {
    const broken = release("Blade.Runner.2049.2017.1080p.BluRay.x265-A");
    const next = release("Blade.Runner.2049.2017.1080p.WEB-DL.x265-B");
    const result = selectRelease(movie, [broken, next], {
      ...policy,
      isBlocklisted: (candidate) => candidate.guid === broken.guid,
    });
    expect(result.winner?.release.guid).toBe(next.guid);
    expect(
      result.candidates.find((c) => c.release.guid === broken.guid),
    ).toMatchObject({ accepted: false, rejection: "blocklisted" });
  });
});

describe("choosing a release for television", () => {
  const episode: MediaTarget = {
    kind: "episode",
    title: "the expanse",
    season: 5,
    episode: 3,
  };
  const season: MediaTarget = {
    kind: "season",
    title: "the expanse",
    season: 5,
  };

  it("accepts the exact episode", () => {
    const result = selectRelease(
      episode,
      [release("The.Expanse.S05E03.1080p.WEB-DL.x264-NTb")],
      policy,
    );
    expect(result.winner).toBeDefined();
  });

  it("rejects the wrong episode and the wrong season, distinctly", () => {
    expect(
      selectRelease(
        episode,
        [release("The.Expanse.S05E04.1080p.WEB-DL-X")],
        policy,
      ).candidates[0]!.rejection,
    ).toBe("wrong-episode");
    expect(
      selectRelease(
        episode,
        [release("The.Expanse.S04E03.1080p.WEB-DL-X")],
        policy,
      ).candidates[0]!.rejection,
    ).toBe("wrong-season");
  });

  it("accepts a season pack as containing the episode", () => {
    const result = selectRelease(
      episode,
      [release("The.Expanse.S05.1080p.WEB-DL.x264-NTb")],
      policy,
    );
    expect(result.winner).toBeDefined();
    expect(result.winner?.facts.isSeasonPack).toBe(true);
  });

  it("accepts a pack for a season, and refuses a single episode for one", () => {
    expect(
      selectRelease(season, [release("The.Expanse.S05.1080p.WEB-DL-X")], policy)
        .winner,
    ).toBeDefined();
    expect(
      selectRelease(
        season,
        [release("The.Expanse.S05E03.1080p.WEB-DL-X")],
        policy,
      ).candidates[0]!.rejection,
    ).toBe("wrong-kind");
  });

  it("matches a series title with an article in only one of the two", () => {
    const result = selectRelease(
      { kind: "episode", title: "expanse", season: 5, episode: 3 },
      [release("The.Expanse.S05E03.1080p.WEB-DL-X")],
      policy,
    );
    expect(result.winner).toBeDefined();
  });
});

describe("preferring one acceptable release over another", () => {
  it("prefers the better profile rank before anything else", () => {
    const result = selectRelease(
      movie,
      [
        release("Blade.Runner.2049.2017.1080p.WEB-DL.x265-A"),
        release("Blade.Runner.2049.2017.1080p.BluRay.x264-B"),
      ],
      policy,
    );
    // BluRay outranks WEB-DL even though the WEB-DL scores 100 for HEVC.
    expect(result.winner?.release.title).toContain("BluRay");
  });

  it("prefers the higher score when the rank is equal", () => {
    const result = selectRelease(
      movie,
      [
        release("Blade.Runner.2049.2017.2160p.WEB-DL.x264-A"),
        release("Blade.Runner.2049.2017.2160p.WEB-DL.x265-B"),
      ],
      { ...policy, profile: wide },
    );
    expect(result.winner?.score).toBe(100);
    expect(result.winner?.release.title).toContain("x265");
  });

  it("prefers a PROPER over the release it replaces", () => {
    const result = selectRelease(
      movie,
      [
        release("Blade.Runner.2049.2017.1080p.BluRay.x264-A"),
        release("Blade.Runner.2049.2017.PROPER.1080p.BluRay.x264-A"),
      ],
      policy,
    );
    expect(result.winner?.facts.proper).toBe(true);
  });

  it("separates qualities the profile grouped together", () => {
    const result = selectRelease(
      movie,
      [
        release("Blade.Runner.2049.2017.2160p.WEBRip.x264-A"),
        release("Blade.Runner.2049.2017.2160p.BluRay.x264-B"),
      ],
      { ...policy, profile: wide },
    );
    expect(result.winner?.release.title).toContain("BluRay");
  });

  it("prefers the larger file when everything else is identical", () => {
    const result = selectRelease(
      movie,
      [
        release("Blade.Runner.2049.2017.1080p.BluRay.x264-A", {
          sizeBytes: 1_000,
        }),
        release("Blade.Runner.2049.2017.1080p.BluRay.x264-A", {
          sizeBytes: 9_000,
        }),
      ],
      policy,
    );
    expect(result.winner?.release.sizeBytes).toBe(9_000);
  });
});

describe("invariants the engine must not break", () => {
  const candidates = [
    release("Blade.Runner.2049.2017.1080p.WEB-DL.x265-A", { sizeBytes: 5_000 }),
    release("Blade.Runner.2049.2017.1080p.BluRay.x264-B", { sizeBytes: 8_000 }),
    release("Blade.Runner.2049.2017.720p.HDTV-C", { sizeBytes: 2_000 }),
    release("Other.Film.2020.1080p.BluRay-D", { sizeBytes: 3_000 }),
    release("Blade.Runner.2049.2017.1080p.BluRay.x264-B", { sizeBytes: 8_000 }),
  ];

  it("picks the same winner whatever order the candidates arrive in", () => {
    /*
     * An indexer returns results in whatever order it likes. A comparison that
     * returned 0 for two different releases would quietly hand the choice to
     * that order, which is why the ladder ends in a stable identifier.
     */
    const forward = selectRelease(movie, candidates, policy).winner;
    const backward = selectRelease(
      movie,
      [...candidates].reverse(),
      policy,
    ).winner;
    const shuffled = selectRelease(
      movie,
      [
        candidates[2]!,
        candidates[4]!,
        candidates[0]!,
        candidates[3]!,
        candidates[1]!,
      ],
      policy,
    ).winner;
    expect(forward?.release.guid).toBe(backward?.release.guid);
    expect(forward?.release.guid).toBe(shuffled?.release.guid);
  });

  it("never returns zero for two different releases", () => {
    const decided = selectRelease(movie, candidates, policy).candidates;
    for (const left of decided) {
      for (const right of decided) {
        if (left.release.guid === right.release.guid) continue;
        expect(compareCandidates(left, right)).not.toBe(0);
      }
    }
  });

  it("orders antisymmetrically", () => {
    const decided = selectRelease(movie, candidates, policy).candidates;
    for (const left of decided) {
      for (const right of decided) {
        // `+ 0` normalises -0, which Object.is distinguishes from 0.
        expect(Math.sign(compareCandidates(left, right)) + 0).toBe(
          -Math.sign(compareCandidates(right, left)) + 0,
        );
      }
    }
  });

  it("never lets a rejected candidate win", () => {
    const result = selectRelease(movie, candidates, policy);
    expect(result.winner?.accepted).toBe(true);
    for (const candidate of result.candidates) {
      if (!candidate.accepted) {
        expect(candidate.release.guid).not.toBe(result.winner?.release.guid);
      }
    }
  });

  it("is deterministic", () => {
    const first = selectRelease(movie, candidates, policy);
    const second = selectRelease(movie, candidates, policy);
    expect(first.winner?.release.guid).toBe(second.winner?.release.guid);
    expect(first.candidates.map((c) => c.release.guid)).toEqual(
      second.candidates.map((c) => c.release.guid),
    );
  });

  it("cannot want an upgrade when the profile forbids one", () => {
    const held = {
      quality: qualityOf(parseRelease("M.2017.1080p.WEB-DL-X")),
      formatScore: 0,
    };
    const result = selectRelease(
      movie,
      [release("Blade.Runner.2049.2017.1080p.BluRay.x264-A")],
      { ...policy, current: held },
    );
    expect(result.winner).toBeUndefined();
    expect(result.candidates[0]!.rejection).toBe("upgrade-not-wanted");
  });

  it("survives candidates with no optional provider fields at all", () => {
    const bare: IndexerRelease = {
      indexerId: "ix",
      indexerName: "Indexer",
      protocol: "usenet",
      guid: "g",
      title: "Blade.Runner.2049.2017.1080p.BluRay.x264-A",
      downloadUrl: "https://x.invalid/get",
      categoryIds: [],
      attributes: {},
    };
    expect(() => selectRelease(movie, [bare], policy)).not.toThrow();
    expect(selectRelease(movie, [bare], policy).winner).toBeDefined();
  });

  it("decides nothing at all for an empty candidate list", () => {
    const result = selectRelease(movie, [], policy);
    expect(result.winner).toBeUndefined();
    expect(result.candidates).toEqual([]);
  });

  it("never carries the credential-bearing URL into a reason", () => {
    const result = selectRelease(movie, candidates, policy);
    const trail = JSON.stringify(result.candidates.map((c) => c.reasons));
    expect(trail).not.toContain("apikey");
    expect(trail).not.toContain("SECRET");
  });
});

/*
 * Title identity.
 *
 * The case that prompted these: a season search for `Chernobyl` accepted, and
 * then recommended, `Chernobyl.Inside.the.Meltdown.S01` — a different
 * programme sharing a first word. A film target had been surviving the same
 * flaw only because the year check caught the impostor a step later, which is
 * luck rather than a title test, and a season target has no year at all.
 */
describe("deciding whether a release names the thing that was asked for", () => {
  const wide2160 = profileFromIds(
    "any",
    "Any",
    [
      ["hdtv-1080p", "webrip-1080p", "webdl-1080p", "bluray-1080p"],
      ["webrip-2160p", "webdl-2160p", "bluray-2160p"],
    ],
    { cutoffQualityId: "webrip-2160p" },
  );
  const open = { profile: wide2160, preferences: [], current: null };

  const season: MediaTarget = { kind: "season", title: "Chernobyl", season: 1 };
  const episode: MediaTarget = {
    kind: "episode",
    title: "Chernobyl",
    season: 1,
    episode: 1,
  };

  it("refuses a longer title that merely begins with the one asked for", () => {
    const result = selectRelease(
      season,
      [release("Chernobyl.Inside.the.Meltdown.S01.1080p.WEB-DL.H.264-playWEB")],
      open,
    );
    expect(result.candidates[0]!.rejection).toBe("title-mismatch");
    expect(result.winner).toBeUndefined();
  });

  it("refuses a shorter title that the one asked for begins with", () => {
    // The other direction of the same mistake: a franchise name is not one of
    // its films.
    const result = selectRelease(
      {
        kind: "movie",
        title: "Pirates of the Caribbean The Curse of the Black Pearl",
        year: 2003,
      },
      [release("Pirates.of.the.Caribbean.2003.1080p.BluRay.x264-X")],
      open,
    );
    expect(result.candidates[0]!.rejection).toBe("title-mismatch");
  });

  it("refuses a sequel on its title rather than relying on the year", () => {
    // No year on the target, so nothing downstream can catch this one.
    const result = selectRelease(
      { kind: "movie", title: "Gladiator" },
      [release("Gladiator.II.2024.1080p.WEB-DL.H.264-ViSTA")],
      open,
    );
    expect(result.candidates[0]!.rejection).toBe("title-mismatch");
  });

  it.each([
    "Chernobyl.2019.S01.COMPLETE.1080p.WEB-DL.H.264-X",
    "Chernobyl.S01.1080p.HMAX.WEB-DL.DDP5.1.H.264-FUZEER",
  ])("still accepts the season pack %s", (title) => {
    const result = selectRelease(season, [release(title)], open);
    expect(result.candidates[0]!.rejection).toBeUndefined();
    expect(result.winner).toBeDefined();
  });

  it.each([
    "Chernobyl.2019.S01E01.1.23.45.1080p.HMAX.WEB-DL.MULTi.DDP5.1.H.265-FUZEER",
    "Chernobyl.S01E01.2160p.UHD.BluRay.HDR.x265-Y",
    "Chernobyl.S01E01.1080p.WEB-DL.EXTENDED.PROPER.x264-Z",
  ])("still accepts the episode %s", (title) => {
    const result = selectRelease(episode, [release(title)], open);
    expect(result.candidates[0]!.rejection).toBeUndefined();
    expect(result.winner).toBeDefined();
  });

  it("still normalizes punctuation and articles rather than demanding them", () => {
    // Over-tightening would show up here first: none of these differences are
    // part of a title's identity.
    const result = selectRelease(
      { kind: "movie", title: "The Lock, Stock & Two Barrels", year: 1998 },
      [release("Lock.Stock.and.Two.Barrels.1998.1080p.BluRay.x264-Q")],
      open,
    );
    expect(result.candidates[0]!.rejection).toBeUndefined();
  });

  it.each([
    ["Joker: Folie à Deux", "Joker.Folie.a.Deux.2024.1080p.HMAX.WEB-DL-FUZEER"],
    ["Ocean's Eleven", "Oceans.Eleven.2001.1080p.BluRay.x264-Q"],
    ["Amélie", "Amelie.2001.1080p.BluRay.x264-Q"],
  ])("reads marks and apostrophes away: %s", (title, name) => {
    const result = selectRelease(
      { kind: "movie", title },
      [release(name)],
      open,
    );
    expect(result.candidates[0]!.rejection).toBeUndefined();
  });

  it("recognises a release by any name the title goes by", () => {
    const target: MediaTarget = {
      kind: "movie",
      title: "Kara Şövalye",
      aliases: ["The Dark Knight"],
      year: 2008,
    };
    const result = selectRelease(
      target,
      [
        release("The.Dark.Knight.2008.1080p.BluRay.x264-Q"),
        release("The.Dark.Knight.Rises.2012.1080p.BluRay.x264-Q"),
      ],
      open,
    );
    expect(result.candidates.map((c) => c.rejection)).toEqual([
      undefined,
      "title-mismatch",
    ]);
  });
});
