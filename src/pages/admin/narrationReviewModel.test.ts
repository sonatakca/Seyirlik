import { describe, expect, it } from "vitest";
import { compareLine, formatAt, lineIssues } from "./narrationReviewModel";
import type { NarrationReviewLine } from "../../lib/narrationReviewApi";

const SERGI =
  "Bir gün, akşamüstü, istasyonla Sergievi arasındaki tenha yolda ağır ağır yürüyor.";

const line = (
  text: string,
  heard: string,
  extra: Partial<NarrationReviewLine> = {},
): NarrationReviewLine => ({
  chunk: "0-3-0",
  block: 3,
  start: 0,
  end: text.length,
  text,
  at: 0,
  duration: 1000,
  heard,
  spoken: null,
  match: 0.99,
  lift: null,
  reasons: [],
  unsure: [],
  takes: 1,
  retakes: 0,
  asked: 0,
  ...extra,
});

const marked = (text: string, comparison: ReturnType<typeof compareLine>) =>
  comparison.words
    .filter((word) => word.status !== "same")
    .map((word) => [text.slice(word.start, word.end), word.status, word.heard]);

describe("comparing a line with what was heard", () => {
  it("marks the word heard otherwise, as the narrator's own check did not", () => {
    const heard =
      "Bir gün akşamüstü istasyonla Serciyevi arasındaki tenha yolda ağır ağır yürüyor.";
    const comparison = compareLine(line(SERGI, heard));
    expect(marked(SERGI, comparison)).toEqual([
      ["Sergievi", "changed", "Serciyevi"],
    ]);
    expect(comparison.differs).toBe(true);
  });

  it("takes words joined or split another way, and case and punctuation, as the same", () => {
    const text = "Akşamüzeri eve dönerken gülümseme ile “Seni gidi!” dedi.";
    const heard = "akşam üzeri eve dönerken gülümsemeile seni gidi, dedi";
    expect(compareLine(line(text, heard)).differs).toBe(false);
  });

  it("hears past how Whisper writes: circumflexes, numbers, ile, and its phantom subtitle credit", () => {
    const text = "Hâlâ imkân yoktu; yirmi beş kâğıt gülümseme ile verdi.";
    const heard = "Hala imkan yoktu, 25 kağıt gülümsemeyle verdi. Altyazı M.K.";
    expect(compareLine(line(text, heard)).differs).toBe(false);
    expect(compareLine(line("Bin dokuz yüz otuz üç.", "1933.")).differs).toBe(
      false,
    );
  });

  it("takes a word said as the pronunciation list says as said right", () => {
    const heard =
      "Bir gün, akşamüstü, istasyonla sergi evi arasındaki tenha yolda ağır ağır yürüyor.";
    expect(compareLine(line(SERGI, heard)).differs).toBe(false);
    const listed = [{ word: "tiedemann", spoken: "Tiidemann", updatedAt: "" }];
    expect(
      compareLine(
        line("Frau Tiedemann’ın odası.", "Frau Tiidemann’ın odası."),
        listed,
      ).differs,
    ).toBe(false);
    expect(
      compareLine(line("Frau Tiedemann’ın odası.", "Frau Tiidemann’ın odası."))
        .differs,
    ).toBe(true);
  });

  it("tells a word not heard from words heard that the book does not have", () => {
    const text = "Yazıyı baştan itibaren şöyle bir süzdüm.";
    const skipped = compareLine(line(text, "Yazıyı baştan şöyle bir süzdüm."));
    expect(marked(text, skipped)).toEqual([["itibaren", "missing", undefined]]);
    const added = compareLine(
      line(text, "Yazıyı baştan itibaren şöyle bir bir süzdüm."),
    );
    expect(added.extra).toEqual(["bir"]);
  });

  it("marks the words the aligner doubted, where the line sits in its block", () => {
    const text = "Maria Puder...";
    const comparison = compareLine(
      line(text, "Maria Puder.", { start: 100, unsure: [[106, 111]] }),
    );
    expect(comparison.words.map((word) => word.unsure ?? false)).toEqual([
      false,
      true,
    ]);
  });

  it("lists the narrator's doubts first, then a difference it did not see", () => {
    const heard =
      "Bir gün akşamüstü istasyonla Serciyevi arasındaki tenha yolda ağır ağır yürüyor.";
    const quiet = line(SERGI, heard);
    expect(lineIssues(quiet, compareLine(quiet))).toEqual(["heard-otherwise"]);
    const toned = line(SERGI, heard, { reasons: ["tone"] });
    expect(lineIssues(toned, compareLine(toned))).toEqual([
      "tone",
      "heard-otherwise",
    ]);
  });

  it("says where a line is heard", () => {
    expect(formatAt(65_000)).toBe("1:05");
    expect(formatAt(3_909_000)).toBe("1:05:09");
  });
});
