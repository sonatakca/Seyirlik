import { describe, expect, it } from "vitest";
import {
  compareLine,
  formatAt,
  lineIssues,
  retakeStage,
  retakeStep,
  stableOrder,
} from "./narrationReviewModel";
import type { BookNarration } from "../../lib/bookNarrationApi";
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
  approved: false,
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

describe("following a line read again", () => {
  const NOW = Date.parse("2026-10-27T20:00:00Z");
  const asked = line("Nasıl?", "Nussel", { chunk: "1-804-0", asked: 1 });
  const narration = (
    overrides: Partial<BookNarration> = {},
    progress: Partial<NonNullable<BookNarration["progress"]>> | null = null,
  ): BookNarration => ({
    version: 1,
    state: "narrating",
    voice: "mk",
    requestedAt: "2026-10-27T19:58:00Z",
    finishedAt: null,
    progress: progress && {
      fraction: 0.99,
      sectionsDone: 1,
      sectionsTotal: 3,
      etaSeconds: null,
      activity: "reading",
      ...progress,
    },
    error: null,
    narratorSeenAt: "2026-10-27T19:59:30Z",
    sections: [],
    ...overrides,
  });
  const step = (n: BookNarration) => retakeStep(asked, 1, n, NOW);

  it("follows nothing for a line not asked for, or whose new reading came", () => {
    expect(retakeStep({ ...asked, asked: 0 }, 1, narration(), NOW)).toBeNull();
    expect(
      retakeStep({ ...asked, retakes: 1 }, 1, narration(), NOW),
    ).toBeNull();
  });

  it("waits for the narrator, and says when it has not been there for a while", () => {
    expect(step(narration({ state: "queued" }))).toEqual({
      step: "waiting",
      away: false,
    });
    expect(
      step(
        narration({ state: "queued", narratorSeenAt: "2026-10-27T19:40:00Z" }),
      ),
    ).toEqual({ step: "waiting", away: true });
    expect(step(narration({ state: "queued", narratorSeenAt: null }))).toEqual({
      step: "waiting",
      away: true,
    });
  });

  it("follows the narrator through the parts, the line, its part's audio and its upload", () => {
    expect(step(narration({}, { activity: "starting" }))).toEqual({
      step: "elsewhere",
      section: null,
    });
    // An older narrator says nothing of where it is.
    expect(step(narration({}, {}))).toEqual({
      step: "elsewhere",
      section: null,
    });
    expect(step(narration({}, { activity: "loading", section: 1 }))).toEqual({
      step: "loading",
    });
    expect(step(narration({}, { section: 0 }))).toEqual({
      step: "elsewhere",
      section: 0,
    });
    expect(
      step(
        narration(
          {},
          {
            section: 1,
            reading: [
              { chunk: "1-3-0", take: 1 },
              { chunk: "1-804-0", take: 2 },
            ],
          },
        ),
      ),
    ).toEqual({ step: "reading", take: 2 });
    expect(step(narration({}, { section: 1, reading: [] }))).toEqual({
      step: "section",
    });
    expect(step(narration({}, { section: 1, activity: "assembling" }))).toEqual(
      {
        step: "assembling",
      },
    );
    expect(
      step(narration({}, { section: 1, activity: "uploading", sent: 0.4 })),
    ).toEqual({ step: "sending", sent: 0.4 });
    expect(step(narration({}, { section: 2 }))).toEqual({ step: "checking" });
    expect(step(narration({ state: "ready" }))).toEqual({ step: "checking" });
    expect(
      step(narration({ state: "failed", error: "RuntimeError: no voice" })),
    ).toEqual({ step: "failed", error: "RuntimeError: no voice" });
  });

  it("draws the steps as four stages", () => {
    expect(
      [
        { step: "waiting", away: false },
        { step: "loading" },
        { step: "reading", take: 1 },
        { step: "assembling" },
        { step: "sending", sent: 0.5 },
        { step: "checking" },
      ].map((s) => retakeStage(s as Parameters<typeof retakeStage>[0])),
    ).toEqual([0, 0, 1, 2, 3, 3]);
  });
});

describe("keeping the lines in place", () => {
  it("keeps the order shown, keeps the lines in hand, and adds new ones after", () => {
    expect(
      stableOrder(["a", "b", "c"], ["c", "d", "a"], new Set(["b"])),
    ).toEqual(["a", "b", "c", "d"]);
    expect(stableOrder(["a", "b"], ["b"], new Set())).toEqual(["b"]);
    expect(stableOrder([], ["b", "a"], new Set(["z"]))).toEqual(["b", "a"]);
  });
});
