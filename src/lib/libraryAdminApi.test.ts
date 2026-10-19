import { describe, expect, it } from "vitest";
import { episodeStage, type HoldingFacts } from "./libraryAdminApi";

const facts = (extra: Partial<HoldingFacts> = {}) => ({
  status: "missing",
  hasMedia: false,
  downloading: 0,
  importing: 0,
  processing: 0,
  subtitleLanguages: [] as string[],
  pendingSubtitles: [] as string[],
  trickplayFiles: 0,
  ...extra,
});

describe("episodeStage", () => {
  it("reports only the file while there is none, whatever else is recorded", () => {
    expect(
      episodeStage(facts({ downloading: 1, pendingSubtitles: ["tur"] }), true),
    ).toEqual({
      file: { tone: "downloading" },
      turkish: "none",
      trickplay: false,
      complete: false,
    });
    expect(episodeStage(facts(), true).file).toEqual({ tone: "wanted" });
  });

  it("reads subtitles and trickplay apart, in either order", () => {
    const held = { hasMedia: true, status: "ready" };
    expect(episodeStage(facts({ ...held, trickplayFiles: 1 }), true)).toMatchObject({
      file: { held: "processed" },
      turkish: "none",
      trickplay: true,
      complete: false,
    });
    expect(
      episodeStage(facts({ ...held, subtitleLanguages: ["eng", "tur"] }), true),
    ).toMatchObject({ turkish: "found", trickplay: false, complete: false });
    expect(
      episodeStage(facts({ ...held, pendingSubtitles: ["tur"] }), true).turkish,
    ).toBe("searching");
  });

  it("is complete only once processed with Turkish subtitles and trickplay", () => {
    const all = { hasMedia: true, subtitleLanguages: ["tur"], trickplayFiles: 1 };
    expect(episodeStage(facts({ ...all, status: "ready" }), true).complete).toBe(true);
    expect(episodeStage(facts({ ...all, status: "downloaded" }), true)).toMatchObject({
      file: { held: "unprocessed" },
      complete: false,
    });
    expect(episodeStage(facts({ ...all, status: "processing" }), true).file).toEqual({
      held: "processing",
    });
  });
});
