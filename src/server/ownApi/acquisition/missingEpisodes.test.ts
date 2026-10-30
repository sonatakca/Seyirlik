// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { LibraryTitleDetail } from "../catalogue/libraryAdmin";
import { countMissing, missingEpisodePlan } from "./missingEpisodes";

type Episode = LibraryTitleDetail["seasons"][number]["episodes"][number];

function episode(
  season: number,
  number: number,
  over: Partial<Episode> = {},
): Episode {
  return {
    id: `s${season}e${number}`,
    seasonNumber: season,
    episodeNumber: number,
    title: null,
    airDate: "2006-03-12",
    mediaFileId: null,
    fileName: null,
    monitored: true,
    hasThumb: false,
    stillUrl: null,
    status: "wanted",
    hasMedia: false,
    downloading: 0,
    importing: 0,
    processing: 0,
    sizeBytes: 0,
    resolution: null,
    audioLanguages: [],
    subtitleLanguages: [],
    pendingSubtitles: [],
    files: 0,
    trickplayFiles: 0,
    pendingTrickplay: 0,
    ...over,
  };
}

const held = { hasMedia: true, status: "downloaded" };

function show(seasons: Array<[number, Episode[]]>) {
  return {
    id: "series",
    title: "The Sopranos",
    year: 1999,
    seasons: seasons.map(([seasonNumber, episodes]) => ({
      id: null,
      seasonNumber,
      episodes,
    })),
  };
}

describe("missingEpisodePlan", () => {
  it("names the episodes the strip draws red, and nothing else", () => {
    const plan = missingEpisodePlan(
      show([
        [
          5,
          [
            episode(5, 1),
            episode(5, 2, held),
            episode(5, 3, { downloading: 1 }),
            episode(5, 4, { importing: 1 }),
            episode(5, 5, { status: "unaired", airDate: "2099-01-01" }),
          ],
        ],
      ]),
    );
    expect(plan).toEqual({
      seriesItemId: "series",
      title: "The Sopranos",
      year: 1999,
      complete: false,
      seasons: [
        { season: 5, whole: false, episodes: [{ episode: 1, itemId: "s5e1" }] },
      ],
    });
  });

  it("asks for the whole series only when nothing of any season is held", () => {
    const nothingHeld = show([
      [1, [episode(1, 1), episode(1, 2)]],
      [2, [episode(2, 1), episode(2, 2, { status: "unaired" })]],
      // A season with nothing aired yet does not stop it.
      [3, [episode(3, 1, { status: "unaired" })]],
    ]);
    expect(missingEpisodePlan(nothingHeld).complete).toBe(true);
    // One season's search never asks for more than the season.
    expect(missingEpisodePlan(nothingHeld, 1).complete).toBe(false);

    const oneHeld = show([
      [1, [episode(1, 1, held), episode(1, 2)]],
      [2, [episode(2, 1)]],
    ]);
    expect(missingEpisodePlan(oneHeld).complete).toBe(false);
    // A season fully held and one wholly missing: not the whole series.
    const seasonHeld = show([
      [1, [episode(1, 1, held)]],
      [2, [episode(2, 1)]],
    ]);
    expect(missingEpisodePlan(seasonHeld).complete).toBe(false);
  });

  it("searches an episode the catalogue has no row for under its series", () => {
    const plan = missingEpisodePlan(
      show([[6, [episode(6, 1, held), episode(6, 2, { id: null })]]]),
    );
    expect(plan.seasons[0]!.episodes).toEqual([
      { episode: 2, itemId: "series" },
    ]);
  });

  it("calls a season whole when every aired episode is missing", () => {
    const plan = missingEpisodePlan(
      show([
        [
          6,
          [
            episode(6, 1),
            episode(6, 2),
            episode(6, 3, { status: "unaired", airDate: "2099-01-01" }),
          ],
        ],
      ]),
    );
    expect(plan.seasons[0]).toMatchObject({ season: 6, whole: true });
    expect(countMissing(plan)).toBe(2);
  });

  it("keeps to one season when asked, and leaves specials out", () => {
    const detail = show([
      [0, [episode(0, 1)]],
      [5, [episode(5, 1)]],
      [6, [episode(6, 1)]],
    ]);
    expect(missingEpisodePlan(detail).seasons.map((s) => s.season)).toEqual([
      5, 6,
    ]);
    expect(missingEpisodePlan(detail, 6).seasons.map((s) => s.season)).toEqual([
      6,
    ]);
  });

  it("is empty when nothing is missing", () => {
    const plan = missingEpisodePlan(show([[1, [episode(1, 1, held)]]]));
    expect(plan.seasons).toEqual([]);
    expect(countMissing(plan)).toBe(0);
  });
});
