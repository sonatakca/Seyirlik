import { describe, expect, it } from "vitest";
import { epubBlockText } from "../../lib/epubBlocks";
import {
  lastAtOrBefore,
  sentenceAt,
  voiceIndexAt,
  voiceRange,
  voiceSentences,
  voiceText,
} from "./readAlongText";

const SHY = "­";

function block(html: string) {
  const element = document.createElement("p");
  element.innerHTML = html;
  document.body.append(element);
  return element;
}

describe("voiceText", () => {
  // The narrator's offsets count epubBlockText; the page has soft hyphens,
  // elements and the book's own whitespace.
  it("is the narrator's text, whatever the markup around it", () => {
    const element = block(
      `\n  Pansi${SHY}yon${SHY}daki <i>Hollandalı</i>\n\n dul   Frau <b>Tie${SHY}de</b>mann  `,
    );
    const voice = voiceText(element);

    expect(voice.text).toBe(epubBlockText(element.textContent ?? ""));
    expect(voice.text).toBe("Pansiyondaki Hollandalı dul Frau Tiedemann");
  });

  it("maps a word back onto the page, soft hyphens and elements included", () => {
    const element = block(
      `Pansi${SHY}yon${SHY}daki <i>Hol${SHY}landalı</i> dul Frau <b>Tie</b>demann`,
    );
    const voice = voiceText(element);
    const word = (text: string) => {
      const start = voice.text.indexOf(text);
      return voiceRange(voice, start, start + text.length)!.toString();
    };

    expect(word("Pansiyondaki")).toBe(`Pansi${SHY}yon${SHY}daki`);
    expect(word("Hollandalı")).toBe(`Hol${SHY}landalı`);
    expect(word("Tiedemann")).toBe("Tiedemann");
    expect(word("dul Frau")).toBe("dul Frau");
  });

  it("finds the narrator's character at a point of the page", () => {
    const element = block(`Bir  <i>ara${SHY}lık</i> bütün`);
    const voice = voiceText(element);
    const italic = element.querySelector("i")!.firstChild!;

    expect(voiceIndexAt(voice, italic, 0)).toBe(voice.text.indexOf("aralık"));
    // Past the soft hyphen: the "l", one character on in the narrator's text.
    expect(voiceIndexAt(voice, italic, 4)).toBe(voice.text.indexOf("lık"));
    expect(voiceIndexAt(voice, document.body, 0)).toBe(-1);
  });
});

describe("voiceSentences", () => {
  it("ends a sentence only where the next one visibly begins", () => {
    const text =
      "Ben hakikati söyleyince, “Seni gidi çapkın seni!” manasına gelen bir gülümseme ile bakardı. Bir gün öğleden sonra çıktık... Hemen eve dönelim, dedim.";
    const sentences = voiceSentences(text).map(([start, end]) =>
      text.slice(start, end),
    );

    expect(sentences).toEqual([
      "Ben hakikati söyleyince, “Seni gidi çapkın seni!” manasına gelen bir gülümseme ile bakardı.",
      "Bir gün öğleden sonra çıktık...",
      "Hemen eve dönelim, dedim.",
    ]);
  });

  it("covers a text with no stop at all as one sentence", () => {
    expect(voiceSentences("bir başlık")).toEqual([[0, 10]]);
  });

  it("names the sentence a character is in", () => {
    const sentences = voiceSentences("Bir. İki. Üç.");

    expect(sentenceAt(sentences, 0)).toBe(0);
    expect(sentenceAt(sentences, 5)).toBe(1);
    expect(sentenceAt(sentences, 12)).toBe(2);
  });
});

describe("lastAtOrBefore", () => {
  const words = [
    [0, 0, 3, 120, 800],
    [0, 4, 9, 920, 1480],
    [0, 10, 12, 1580, 1740],
  ];

  it("finds the word being said at a time", () => {
    const at = (ms: number) => lastAtOrBefore(words, ms, (word) => word[3]!);

    expect(at(0)).toBe(-1);
    expect(at(120)).toBe(0);
    expect(at(900)).toBe(0);
    expect(at(1500)).toBe(1);
    expect(at(99_999)).toBe(2);
  });
});
