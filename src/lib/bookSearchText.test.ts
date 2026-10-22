import { describe, expect, it } from "vitest";

import {
  focusMark,
  foldText,
  markText,
  queryTerm,
  queryWords,
  termMatch,
  textWords,
  wordMatch,
} from "./bookSearchText";

const marked = (text: string, terms: string[], phrase: string[] = []) =>
  markText(text, terms, phrase).map(({ start, end }) => text.slice(start, end));

describe("reading words as a book search does", () => {
  it("folds case, accents and Turkish letters, and keeps the original offsets", () => {
    const folded = foldText("Işık ÇİÇEK, şöyle");
    expect(folded.text).toBe("isik cicek, soyle");
    expect(folded.at[5]).toBe(5); // "c" of ÇİÇEK
    expect(folded.at[6]).toBe(6); // its "İ", one letter folded
    expect(folded.at.at(-1)).toBe("Işık ÇİÇEK, şöyle".length);
  });

  it("does not see the soft hyphens the reader sets inside words", () => {
    const text = "ev\u00adcil\u00adleş\u00adtir beni";
    const [word] = textWords(text);
    expect(word).toMatchObject({ word: "evcillestir", start: 0 });
    expect(textWords("Lenina\u00ad'nın")[0]!.end).toBe(6);
    expect(text.slice(word!.start, word!.end)).toBe(
      "ev\u00adcil\u00adleş\u00adtir",
    );
  });

  it("takes a query's words without the endings after an apostrophe or the quotes", () => {
    expect(queryWords("“Bernard'ın İzlanda’ya sürülmesi”")).toEqual([
      "bernard",
      "izlanda",
      "sürülmesi",
    ]);
  });

  it("finds a word with endings, and one or two letters only as a whole word", () => {
    expect(wordMatch("tilki", "tilkiyi")).toBe(1);
    expect(wordMatch("ve", "vefa")).toBe(0);
    expect(wordMatch("ve", "ve")).toBe(1);
    expect(wordMatch("evcillestirmenin", "evcillestirdi")).toBe(0.6);
    expect(wordMatch("kurku", "kurk")).toBe(0.6);
    expect(wordMatch("kedi", "kadın")).toBe(0);
  });

  it("finds a stem whose last consonant softened before an ending", () => {
    expect(wordMatch("kirbac", "kirbaci")).toBe(1);
    expect(wordMatch("kitap", "kitabi")).toBe(1);
    expect(wordMatch("renk", "rengi")).toBe(1);
    // Only before an ending: the bare word is another word.
    expect(wordMatch("kitap", "kitab")).toBe(0);
  });

  it("answers a word written with Turkish letters best with the same letters", () => {
    const dying = queryTerm("ölüyor");
    const [becoming] = textWords("oluyordu");
    const [died] = textWords("ölüyordu");
    expect(termMatch(dying, died!)).toBe(1);
    expect(termMatch(dying, becoming!)).toBeLessThan(0.5);
    // Typed without them, either spelling is fine.
    expect(termMatch(queryTerm("oluyor"), died!)).toBe(1);
    // Dotted and dotless i stay one.
    const [island] = textWords("IZLANDA");
    expect(termMatch(queryTerm("İzlanda"), island!)).toBe(1);
  });
});

describe("marking what a search found", () => {
  it("marks the words found, whole, with their endings", () => {
    expect(
      marked("Küçük Prens tilkiyi evcilleştirdi. Tilki ağladı.", ["tilki"]),
    ).toEqual(["tilkiyi", "Tilki"]);
  });

  it("marks a phrase as one, and its words elsewhere on their own", () => {
    const text = "Hey cesur yeni dünya! Cesur bir adam.";
    expect(marked(text, ["cesur"], ["cesur", "yeni", "dünya"])).toEqual([
      "cesur yeni dünya",
      "Cesur",
    ]);
  });

  it("marks a quoted search's words only as written", () => {
    const text = "Gül gülümsedi, gülü de güldü.";
    expect(
      markText(text, ["gül"], [], true).map(({ start, end }) =>
        text.slice(start, end),
      ),
    ).toEqual(["Gül"]);
  });

  it("joins marks only a space apart", () => {
    expect(marked("Mustafa Mond geldi", ["mustafa", "mond"])).toEqual([
      "Mustafa Mond",
    ]);
  });

  it("does not mark a word that only folds to the one searched for", () => {
    expect(marked("Linda deli oluyordu, sonra ölüyordu.", ["ölüyor"])).toEqual([
      "ölüyordu",
    ]);
  });

  it("focuses where the most different words gather", () => {
    const text =
      "Linda geldi. " + "Uzun bir aradan sonra ".repeat(20) + "Linda ölüyordu.";
    const marks = markText(text, ["linda", "ölüyor"]);
    const focus = focusMark(text, marks);
    expect(text.slice(focus!.start, focus!.end)).toBe("Linda ölüyordu");
  });

  it("has no focus when nothing was found by its words", () => {
    expect(focusMark("Bir şey.", markText("Bir şey.", []))).toBeNull();
  });
});
