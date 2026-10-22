import { describe, expect, it } from "vitest";
import type {
  RenditionAudioTrackProbe,
  RenditionSubtitleTrackProbe,
} from "../probe";
import { normalizeLanguage, languageDisplayName } from "./languages";
import {
  applyStreamPolicy,
  decideAudioStreams,
  decideSubtitleStreams,
} from "./streamPolicy";

function audio(
  overrides: Partial<RenditionAudioTrackProbe> & { streamIndex: number },
): RenditionAudioTrackProbe {
  return {
    codec: "aac",
    channels: 2,
    isDefault: false,
    isCommentary: false,
    isVisualImpaired: false,
    isOriginal: false,
    ...overrides,
  };
}

function subtitle(
  overrides: Partial<RenditionSubtitleTrackProbe> & { streamIndex: number },
): RenditionSubtitleTrackProbe {
  return {
    codec: "subrip",
    isDefault: false,
    isForced: false,
    isHearingImpaired: false,
    isCommentary: false,
    isTextBased: true,
    ...overrides,
  };
}

const kept = (decisions: Array<{ keep: boolean; streamIndex: number }>) =>
  decisions.filter((entry) => entry.keep).map((entry) => entry.streamIndex);

describe("normalizeLanguage", () => {
  it("folds two- and three-letter codes onto one canonical tag", () => {
    expect(normalizeLanguage("en")).toBe("eng");
    expect(normalizeLanguage("eng")).toBe("eng");
    expect(normalizeLanguage("tr")).toBe("tur");
    expect(normalizeLanguage("tur")).toBe("tur");
    expect(normalizeLanguage("fre")).toBe("fra");
    expect(normalizeLanguage("fra")).toBe("fra");
  });

  it("ignores a region suffix, which never changes which track to keep", () => {
    expect(normalizeLanguage("en-GB")).toBe("eng");
    expect(normalizeLanguage("pt_BR")).toBe("por");
  });

  it("treats a missing or unusable tag as unknown rather than guessing", () => {
    expect(normalizeLanguage(undefined)).toBe("und");
    expect(normalizeLanguage("")).toBe("und");
    expect(normalizeLanguage("  ")).toBe("und");
    expect(normalizeLanguage("qq")).toBe("und");
  });

  it("accepts a display name where a code belongs", () => {
    expect(normalizeLanguage("English")).toBe("eng");
    expect(normalizeLanguage("Turkish")).toBe("tur");
  });

  it("names languages for an operator", () => {
    expect(languageDisplayName("tur")).toBe("Turkish");
    expect(languageDisplayName(undefined)).toBe("Unknown");
  });
});

describe("audio retention policy", () => {
  it("keeps the source default even when its language is not retained", () => {
    const decisions = decideAudioStreams([
      audio({ streamIndex: 1, language: "jpn", isDefault: true }),
      audio({ streamIndex: 2, language: "eng" }),
    ]);

    expect(kept(decisions)).toEqual([1, 2]);
    expect(decisions[0]!.reason).toBe("source-default");
  });

  it("keeps one best English and one best Turkish track", () => {
    const decisions = decideAudioStreams([
      audio({ streamIndex: 1, language: "jpn", isDefault: true }),
      audio({ streamIndex: 2, language: "eng", channels: 2 }),
      audio({ streamIndex: 3, language: "eng", channels: 6 }),
      audio({ streamIndex: 4, language: "tur", channels: 6 }),
      audio({ streamIndex: 5, language: "tur", channels: 2 }),
    ]);

    expect(kept(decisions)).toEqual([1, 3, 4]);
  });

  /**
   * The case that produces a duplicate rendition if it is missed: the source
   * default already *is* the English track, so English must not be kept twice.
   */
  it("does not keep a language twice when the default already covers it", () => {
    const decisions = decideAudioStreams([
      audio({ streamIndex: 1, language: "eng", isDefault: true, channels: 8 }),
      audio({ streamIndex: 2, language: "eng", codec: "eac3", channels: 6 }),
    ]);

    expect(kept(decisions)).toEqual([1]);
    expect(decisions[1]!.reason).toBe("duplicate-language");
  });

  it("leaves commentary out unless it is asked for", () => {
    const tracks = [
      audio({ streamIndex: 1, language: "eng", isDefault: true }),
      audio({ streamIndex: 2, language: "eng", isCommentary: true }),
    ];

    expect(kept(decideAudioStreams(tracks))).toEqual([1]);
    expect(
      kept(decideAudioStreams(tracks, { includeCommentary: true })),
    ).toEqual([1, 2]);
  });

  it("never lets commentary become the source default", () => {
    const decisions = decideAudioStreams([
      audio({
        streamIndex: 1,
        language: "eng",
        isDefault: true,
        isCommentary: true,
      }),
      audio({ streamIndex: 2, language: "eng" }),
    ]);

    expect(kept(decisions)).toEqual([2]);
  });

  it("keeps a lone untagged track rather than dropping every language", () => {
    const decisions = decideAudioStreams([audio({ streamIndex: 1 })]);

    expect(kept(decisions)).toEqual([1]);
    expect(decisions[0]!.reason).toBe("only-track");
  });

  it("explains every decision in a sentence an operator can read", () => {
    const decisions = decideAudioStreams([
      audio({ streamIndex: 1, language: "eng", isDefault: true }),
      audio({ streamIndex: 2, language: "fra" }),
    ]);

    expect(decisions[0]!.explanation).toContain("Keeping English");
    expect(decisions[1]!.explanation).toContain("Dropping French");
  });
});

describe("subtitle retention policy", () => {
  it("keeps other languages when all languages are requested", () => {
    const result = decideSubtitleStreams(
      [
        subtitle({ streamIndex: 1, language: "fra" }),
        subtitle({ streamIndex: 2, language: "fra", isHearingImpaired: true }),
      ],
      { keepAllLanguages: true },
    );
    expect(result.map((track) => track.keep)).toEqual([true, false]);
  });
  it("keeps English, Turkish and their forced tracks", () => {
    const decisions = decideSubtitleStreams([
      subtitle({ streamIndex: 1, language: "eng" }),
      subtitle({ streamIndex: 2, language: "tur" }),
      subtitle({ streamIndex: 3, language: "eng", isForced: true }),
      subtitle({ streamIndex: 4, language: "fra" }),
    ]);

    expect(kept(decisions)).toEqual([1, 2, 3]);
    expect(decisions[2]!.reason).toBe("forced-preferred-language");
  });

  it("treats SDH as opt-in when the language also has a plain track", () => {
    const tracks = [
      subtitle({ streamIndex: 1, language: "tur", isHearingImpaired: true }),
      subtitle({ streamIndex: 2, language: "tur" }),
    ];

    expect(kept(decideSubtitleStreams(tracks))).toEqual([2]);
    expect(
      kept(decideSubtitleStreams(tracks, { includeHearingImpaired: true })),
    ).toEqual([1, 2]);
  });

  /**
   * Sidecar subtitles are routinely the SDH cut and nothing else — this library
   * holds a single `.tr.hi.srt` for Dune, Michael and Revenge of the Sith and
   * no plain Turkish at all. Dropping it as opt-in left those films with no
   * Turkish subtitles whatsoever, which is worse than subtitles that also
   * describe the sound.
   */
  it("keeps an SDH track that is the only one in its language", () => {
    const decisions = decideSubtitleStreams([
      subtitle({ streamIndex: 1, language: "tur", isHearingImpaired: true }),
    ]);

    expect(kept(decisions)).toEqual([1]);
    expect(decisions[0]!.reason).toBe("hearing-impaired-only-track");
  });

  /**
   * A bitmap subtitle cannot become WebVTT without OCR. Dropping it silently
   * would lose the only subtitles some discs carry, so it is kept and flagged.
   */
  it("retains image subtitles and flags them rather than discarding them", () => {
    const decisions = decideSubtitleStreams([
      subtitle({
        streamIndex: 1,
        language: "eng",
        codec: "hdmv_pgs_subtitle",
        isTextBased: false,
      }),
    ]);

    expect(decisions[0]!.keep).toBe(true);
    expect(decisions[0]!.requiresOcr).toBe(true);
  });

  it("does not offer an image subtitle for WebVTT conversion", () => {
    const result = applyStreamPolicy({
      audioTracks: [
        audio({ streamIndex: 1, language: "eng", isDefault: true }),
      ],
      subtitleTracks: [
        subtitle({ streamIndex: 2, language: "eng" }),
        subtitle({
          streamIndex: 3,
          language: "tur",
          codec: "hdmv_pgs_subtitle",
          isTextBased: false,
        }),
      ],
    });

    expect(result.keptSubtitleStreamIndexes).toEqual([2]);
    expect(result.warnings.join(" ")).toContain("OCR");
  });
});

describe("applyStreamPolicy", () => {
  it("reproduces the language fixture's expected decisions", () => {
    const result = applyStreamPolicy({
      audioTracks: [
        audio({
          streamIndex: 1,
          language: "eng",
          channels: 8,
          isDefault: true,
        }),
        audio({ streamIndex: 2, language: "tur", channels: 8 }),
        audio({ streamIndex: 3, language: "fra", codec: "eac3", channels: 6 }),
      ],
      subtitleTracks: [
        subtitle({ streamIndex: 4, language: "eng" }),
        subtitle({ streamIndex: 5, language: "tur", isHearingImpaired: true }),
        subtitle({ streamIndex: 6, language: "eng", isForced: true }),
      ],
    });

    expect(result.keptAudioStreamIndexes).toEqual([1, 2]);
    // 5 is Turkish SDH and the only Turkish subtitle here, so it is kept for
    // the same reason the audio policy never leaves a title silent.
    expect(result.keptSubtitleStreamIndexes).toEqual([4, 5, 6]);
  });

  it("warns when a source has no audio at all", () => {
    const result = applyStreamPolicy({ audioTracks: [], subtitleTracks: [] });

    expect(result.warnings.join(" ")).toContain("no audio stream");
  });
});
