import { describe, expect, it } from "vitest";
import {
  allowedEditDistance,
  boundedEditDistance,
  normalizeSearchText,
  rankSearchCandidates,
  scoreSearchField,
  type SearchCandidate,
} from "./searchRanking";

function candidate(
  id: string,
  title: string,
  overrides: Partial<SearchCandidate> = {},
): SearchCandidate {
  return {
    id,
    kind: "movie",
    title,
    originalTitle: null,
    seriesTitle: null,
    ...overrides,
  };
}

const CATALOGUE = [
  candidate("oppenheimer", "Oppenheimer"),
  candidate("interstellar", "Interstellar"),
  candidate("knight", "The Dark Knight"),
  candidate("isik", "Işıklar Sönerken"),
  candidate("amelie", "Amélie"),
  candidate("severance", "Severance", { kind: "series" }),
  candidate("severance-s1e1", "Good News About Hell", {
    kind: "episode",
    seriesTitle: "Severance",
  }),
];

function search(query: string, limit = 10): string[] {
  return rankSearchCandidates(query, CATALOGUE, limit).map((entry) => entry.id);
}

describe("normalizeSearchText", () => {
  it("folds accents to bare ASCII", () => {
    expect(normalizeSearchText("Amélie")).toBe("amelie");
    expect(normalizeSearchText("Zoë")).toBe("zoe");
  });

  it("folds Turkish letters, including dotless i", () => {
    // NFD does not decompose ı, so without explicit handling "isik" would miss.
    expect(normalizeSearchText("Işıklar")).toBe("isiklar");
    expect(normalizeSearchText("İSTANBUL")).toBe("istanbul");
    expect(normalizeSearchText("Güneş Çağrı Öz")).toBe("gunes cagri oz");
  });

  it("collapses punctuation and whitespace", () => {
    expect(normalizeSearchText("  Spider-Man:  No Way Home! ")).toBe(
      "spider man no way home",
    );
  });
});

describe("boundedEditDistance", () => {
  it("counts a transposition as one edit", () => {
    expect(boundedEditDistance("teh", "the", 2)).toBe(1);
  });

  it("measures insertions, deletions, and substitutions", () => {
    expect(boundedEditDistance("oppenhimer", "oppenheimer", 2)).toBe(1);
    expect(boundedEditDistance("night", "knight", 2)).toBe(1);
    expect(boundedEditDistance("cat", "cat", 2)).toBe(0);
  });

  it("gives up once the budget is spent", () => {
    expect(boundedEditDistance("abc", "xyzxyz", 1)).toBeGreaterThan(1);
  });

  it("treats a zero budget as no tolerance", () => {
    expect(boundedEditDistance("cat", "car", 0)).toBeGreaterThan(0);
  });
});

describe("allowedEditDistance", () => {
  it("gives short tokens no slack", () => {
    // At three letters nearly every word is one edit from another.
    expect(allowedEditDistance("the")).toBe(0);
    expect(allowedEditDistance("dark")).toBe(1);
    expect(allowedEditDistance("oppenheimer")).toBe(3);
  });
});

describe("scoreSearchField", () => {
  it("ranks exact over prefix over substring", () => {
    const exact = scoreSearchField("severance", ["severance"], "Severance");
    const prefix = scoreSearchField("sever", ["sever"], "Severance");
    const substring = scoreSearchField("ranc", ["ranc"], "Severance");

    expect(exact).toBeGreaterThan(prefix!);
    expect(prefix).toBeGreaterThan(substring!);
  });

  it("ranks any real substring above a fuzzy guess", () => {
    const substring = scoreSearchField("heimer", ["heimer"], "Oppenheimer");
    const fuzzy = scoreSearchField("oppenhimer", ["oppenhimer"], "Oppenheimer");

    expect(substring).toBeGreaterThan(fuzzy!);
  });

  it("returns null when nothing matches", () => {
    expect(scoreSearchField("zzzzzz", ["zzzzzz"], "Oppenheimer")).toBeNull();
    expect(scoreSearchField("thing", ["thing"], null)).toBeNull();
  });
});

describe("rankSearchCandidates", () => {
  it("finds a title despite a missing letter", () => {
    expect(search("oppenhimer")[0]).toBe("oppenheimer");
  });

  it("finds a title despite transposed letters", () => {
    expect(search("intersetllar")[0]).toBe("interstellar");
  });

  it("matches across words with a typo in one of them", () => {
    expect(search("dark night")[0]).toBe("knight");
  });

  it("finds Turkish titles typed without Turkish letters", () => {
    expect(search("isiklar")[0]).toBe("isik");
  });

  it("finds accented titles typed without accents", () => {
    expect(search("amelie")[0]).toBe("amelie");
  });

  it("ranks an exact title above an episode of a same-named series", () => {
    const results = search("severance");

    expect(results[0]).toBe("severance");
    expect(results).toContain("severance-s1e1");
  });

  it("returns nothing for an empty or punctuation-only query", () => {
    expect(search("")).toEqual([]);
    expect(search("   ---  ")).toEqual([]);
  });

  it("finds a renamed title by its names in other languages, typos included", () => {
    const renamed = [
      candidate("wolf", "Kurt", {
        originalTitle: "The Wolf of Wall Street",
        alternateTitles: ["Para Avcısı", "The Wolf of Wall Street"],
      }),
      ...CATALOGUE,
    ];
    const find = (query: string) =>
      rankSearchCandidates(query, renamed, 10).map((entry) => entry.id);
    expect(find("para avcisi")[0]).toBe("wolf");
    expect(find("para avcsi")[0]).toBe("wolf");
    expect(find("kurt")[0]).toBe("wolf");
    expect(find("wolf of wall")[0]).toBe("wolf");
  });

  it("does not match unrelated titles", () => {
    expect(search("zzzzzzzz")).toEqual([]);
  });

  it("respects the limit", () => {
    expect(search("e", 2).length).toBeLessThanOrEqual(2);
  });
});
