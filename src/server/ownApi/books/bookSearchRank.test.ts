// @vitest-environment node
import { describe, expect, it } from "vitest";

import { rankPassages } from "./bookSearchRank";
import type { BookPassage } from "./bookText";

/** A small book: the passages, and filler enough that common words are common. */
function book(texts: string[]): BookPassage[] {
  const filler = Array.from(
    { length: 30 },
    (_, at) =>
      `Bir gün ve bir gece geçti, adam yine yola çıktı ${at}. Ona bir şey dedi.`,
  );
  return [...texts, ...filler].map((text, at) => ({
    section: at,
    block: 0,
    anchor: text.slice(0, 60),
    text,
  }));
}

/** Meaning scores for the passages: the given ones, the rest low and level. */
function meaning(passages: BookPassage[], scores: Record<number, number>) {
  return passages.map((_, at) => scores[at] ?? 0.3);
}

const sections = (ranking: ReturnType<typeof rankPassages>) =>
  ranking.ranked.map(({ at }) => at);

describe("ranking a book's passages for a search", () => {
  const passages = book([
    "Tilki sustu ve uzun bir süre Küçük Prens'i süzdü.", // 0
    "İnsan ancak yüreğiyle baktığı zaman doğruyu görebilir.", // 1
    "Çölde yalnız kalınca insan kendi yüreğine bakar.", // 2
    "Lenina gülümsedi ve Bernard'a baktı.", // 3
    "Lenina uçağa bindi.", // 4
    "Vahşi kırbacı kaldırdı ve kendine vurdu.", // 5
  ]);

  it("puts a line quoted as written before passages that only resemble it", () => {
    const ranking = rankPassages(
      passages,
      // The model prefers the passage that only resembles the line.
      meaning(passages, { 2: 0.62, 1: 0.55 }),
      "insan ancak yüreğiyle baktığı zaman",
    );
    expect(sections(ranking)[0]).toBe(1);
    expect(ranking.phrase).toEqual([
      "insan",
      "ancak",
      "yüreğiyle",
      "baktiği",
      "zaman",
    ]);
  });

  it("finds a name everywhere it stands before passages that only mean something like it", () => {
    const ranking = rankPassages(
      passages,
      meaning(passages, { 0: 0.7 }),
      "Lenina",
    );
    expect(sections(ranking).slice(0, 2).sort()).toEqual([3, 4]);
    expect(ranking.terms).toEqual(["lenina"]);
  });

  it("reads a slip in a short search as the book's own word", () => {
    const ranking = rankPassages(passages, meaning(passages, {}), "Lenia");
    expect(sections(ranking).slice(0, 2).sort()).toEqual([3, 4]);
    expect(ranking.terms).toEqual(["lenin"]);
  });

  it("leaves the words of a longer description as written", () => {
    const ranking = rankPassages(
      passages,
      meaning(passages, { 5: 0.7 }),
      "vahşi kendini kamçılıyor acıyla",
    );
    expect(sections(ranking)[0]).toBe(5);
    expect(ranking.terms).not.toContain("kaldirdi");
  });

  it("finds a softened stem, typed without Turkish letters", () => {
    const ranking = rankPassages(passages, meaning(passages, {}), "kirbac");
    expect(sections(ranking)[0]).toBe(5);
    expect(ranking.terms).toEqual(["kirbac"]);
  });

  it("lets the meaning decide, and marks nothing, when the words are not the book's", () => {
    const ranking = rankPassages(
      passages,
      meaning(passages, { 5: 0.66, 0: 0.5 }),
      "the savage whips himself",
    );
    expect(sections(ranking).slice(0, 2)).toEqual([5, 0]);
    expect(ranking.terms).toEqual([]);
    expect(ranking.phrase).toEqual([]);
  });

  it("does not mark words common in the book", () => {
    const ranking = rankPassages(
      passages,
      meaning(passages, {}),
      "tilki bir şey dedi",
    );
    expect(sections(ranking)[0]).toBe(0);
    expect(ranking.terms).toEqual(["tilki"]);
  });

  it("ranks and marks by the words with a subject, not the little ones", () => {
    const ranking = rankPassages(
      passages,
      meaning(passages, {}),
      "tilki ile prens ilk kez",
    );
    expect(sections(ranking)[0]).toBe(0);
    expect(ranking.terms).toEqual(["tilki", "prens"]);
  });

  it("answers a quoted search with its words exactly as written", () => {
    const rose = book([
      "Küçük Prens gülümsedi.", // 0
      "Benim gülüm başka.", // 1
      "Gül susuyordu.", // 2
    ]);
    const quoted = rankPassages(rose, meaning(rose, { 0: 0.7 }), "“gül”");
    expect(sections(quoted)).toEqual([2]);
    expect(quoted).toMatchObject({ terms: ["gül"], exact: true });
    // Unquoted, the endings count too.
    expect(
      sections(rankPassages(rose, meaning(rose, {}), "gül"))
        .slice(0, 3)
        .sort(),
    ).toEqual([0, 1, 2]);
    // Quoted words the book never has together: answered as if unquoted.
    const loose = rankPassages(rose, meaning(rose, {}), '"gül prens"');
    expect(loose.exact).toBe(false);
    expect(loose.ranked.length).toBeGreaterThan(0);
  });

  it("returns at most forty, and only those near the best once there are six", () => {
    const many = book(
      Array.from({ length: 60 }, (_, at) => `Soma aldı ${at}.`),
    );
    expect(rankPassages(many, meaning(many, {}), "soma").ranked).toHaveLength(
      40,
    );
    const few = rankPassages(passages, meaning(passages, {}), "tilki");
    expect(few.ranked.length).toBeGreaterThanOrEqual(6);
    expect(few.ranked.length).toBeLessThan(40);
  });
});
