import { describe, expect, it } from "vitest";
import type {
  ProcessingEpisode,
  ProcessingSeason,
  ProcessingSeries,
  ProcessingStateCounts,
} from "../../lib/processingApi";
import {
  autoExpandedIds,
  describeBulkOutcome,
  episodeAction,
  filterSeries,
  jobLabel,
  rungBreakdown,
  summariseCounts,
} from "./processingSeriesModel";

/*
 * Stands in for the translation layer: every one of these strings is a
 * template with a `{count}` in it, so the assertions below are about which
 * numbers appear and in what order, not about the wording.
 */
const t = (key: string) => `${key}:{count}`;
const format = (template: string, values: Record<string, string>) =>
  template.replace(/\{(\w+)\}/g, (_, name: string) => values[name] ?? "");

function counts(o: Partial<ProcessingStateCounts> = {}): ProcessingStateCounts {
  return {
    total: 0,
    complete: 0,
    partial: 0,
    unprocessed: 0,
    unknown: 0,
    active: 0,
    unavailable: 0,
    eligible: 0,
    ...o,
  };
}

function episode(
  code: string,
  title: string,
  o: Partial<ProcessingEpisode> = {},
): ProcessingEpisode {
  return {
    itemId: `${code}-item`,
    mediaFileId: `${code}-file`,
    title,
    sortTitle: code,
    sourceAvailable: true,
    fileCount: 1,
    probed: true,
    source: null,
    plan: {
      action: "package-adaptive",
      summary: "",
      videoCodec: "h264",
      videoEncoder: "h264_videotoolbox",
      hardwareAdapter: "videotoolbox",
      preservesHdr: false,
      ladder: [1080, 720],
      missingRungs: [1080, 720],
      estimatedOutputBytes: 1,
      audioTracksKept: 1,
      subtitleTracksKept: 0,
    },
    package: null,
    packageState: "none",
    activeJobId: null,
    activeJobState: null,
    processable: true,
    seasonNumber: Number(code.slice(1, 3)),
    episodeNumber: Number(code.slice(4)),
    code,
    ...o,
  };
}

function season(
  number: number,
  episodes: ProcessingEpisode[],
): ProcessingSeason {
  return {
    seasonId: `season-${number}`,
    seasonNumber: number,
    title: `Season ${number}`,
    episodes,
    counts: counts({ total: episodes.length }),
  };
}

function series(title: string, seasons: ProcessingSeason[]): ProcessingSeries {
  return {
    seriesId: `series-${title}`,
    title,
    sortTitle: title.toLowerCase(),
    productionYear: null,
    seasonCount: seasons.length,
    episodeCount: seasons.reduce((n, s) => n + s.episodes.length, 0),
    seasons,
    counts: counts(),
  };
}

const LIBRARY = [
  series("Andor", [
    season(1, [episode("S01E01", "Kassa"), episode("S01E02", "Reckoning")]),
    season(2, [episode("S02E01", "One Year Later")]),
  ]),
  series("The Sopranos", [season(1, [episode("S01E01", "Pilot")])]),
];

describe("filtering the tree", () => {
  it("returns everything for an empty query", () => {
    expect(filterSeries(LIBRARY, "  ")).toHaveLength(2);
  });

  it("finds a show by its original and added names", () => {
    const library = [
      {
        ...series("Ejderha Hanedanı", [
          season(1, [episode("S01E01", "Ejderhanın Mirasçıları")]),
        ]),
        searchNames: ["House of the Dragon"],
      },
      ...LIBRARY,
    ];
    const [show, ...rest] = filterSeries(library, "house dragon");
    expect(show!.title).toBe("Ejderha Hanedanı");
    expect(show!.seasons[0]!.episodes).toHaveLength(1);
    expect(rest).toEqual([]);
    expect(filterSeries(library, "hanedani")).toHaveLength(1);
  });

  it("keeps every episode of a show whose own name matches", () => {
    const [show] = filterSeries(LIBRARY, "andor");
    expect(show!.title).toBe("Andor");
    expect(show!.seasons).toHaveLength(2);
    expect(show!.seasons[0]!.episodes).toHaveLength(2);
  });

  it("narrows to the matching episode when the show does not match", () => {
    const filtered = filterSeries(LIBRARY, "kassa");
    expect(filtered).toHaveLength(1);
    expect(filtered[0]!.seasons).toHaveLength(1);
    expect(filtered[0]!.seasons[0]!.episodes.map((e) => e.code)).toEqual([
      "S01E01",
    ]);
  });

  it("matches an episode by its code", () => {
    const filtered = filterSeries(LIBRARY, "s02e01");
    expect(filtered[0]!.seasons[0]!.episodes[0]!.code).toBe("S02E01");
  });

  it("drops a show entirely when nothing in it matches", () => {
    expect(filterSeries(LIBRARY, "zzz")).toEqual([]);
  });

  /*
   * Two shows both have an "S01E01 Pilot"-shaped episode. A search for "pilot"
   * must not collapse them into one, or attach one show's episode to another.
   */
  it("keeps two shows apart when both contain a match", () => {
    const library = [
      ...LIBRARY,
      series("Arcane", [season(1, [episode("S01E01", "Pilot")])]),
    ];
    const filtered = filterSeries(library, "pilot");
    expect(filtered.map((show) => show.title)).toEqual([
      "The Sopranos",
      "Arcane",
    ]);
  });
});

describe("what a search opens", () => {
  it("opens nothing when there is no search", () => {
    expect(autoExpandedIds(LIBRARY, "")).toEqual({
      seriesIds: [],
      seasonIds: [],
    });
  });

  it("opens every show and season the search left standing", () => {
    const filtered = filterSeries(LIBRARY, "kassa");
    const expansion = autoExpandedIds(filtered, "kassa");
    expect(expansion.seriesIds).toEqual(["series-Andor"]);
    expect(expansion.seasonIds).toEqual(["season-1"]);
  });
});

describe("the single action an episode row offers", () => {
  it("starts a processable episode", () => {
    expect(episodeAction(episode("S01E01", "A"))).toBe("start");
  });

  it("reports a job before anything else", () => {
    expect(
      episodeAction(
        episode("S01E01", "A", {
          activeJobId: "job",
          sourceAvailable: false,
        }),
      ),
    ).toBe("active");
  });

  it("reports a missing source", () => {
    expect(
      episodeAction(episode("S01E01", "A", { sourceAvailable: false })),
    ).toBe("unavailable");
  });

  it("reports a file that has not been probed", () => {
    expect(episodeAction(episode("S01E01", "A", { probed: false }))).toBe(
      "unprobed",
    );
  });

  it("reports nothing left to do", () => {
    expect(
      episodeAction(
        episode("S01E01", "A", {
          processable: false,
          plan: {
            action: "skip-already-current",
            summary: "",
            videoCodec: "h264",
            videoEncoder: "x",
            hardwareAdapter: "x",
            preservesHdr: false,
            ladder: [1080],
            missingRungs: [],
            estimatedOutputBytes: 0,
            audioTracksKept: 0,
            subtitleTracksKept: 0,
          },
        }),
      ),
    ).toBe("complete");
  });
});

describe("rung breakdown", () => {
  it("shows the ladder against what is already there, largest first", () => {
    expect(
      rungBreakdown({
        package: { rungs: [720, 1080] },
        plan: { ladder: [480, 1080, 720], missingRungs: [480] },
      }),
    ).toEqual({ present: [1080, 720], planned: [1080, 720, 480] });
  });

  it("falls back to what exists when there is no plan", () => {
    expect(rungBreakdown({ package: { rungs: [1080] }, plan: null })).toEqual({
      present: [1080],
      planned: [1080],
    });
  });
});

describe("reporting a bulk press", () => {
  it("always says how many were queued", () => {
    expect(
      describeBulkOutcome(
        {
          queued: 8,
          alreadyQueued: 0,
          alreadyComplete: 0,
          unavailable: 0,
          failed: 0,
        },
        t,
        format,
      ),
    ).toBe("processing.tv.bulkQueued:8");
  });

  /*
   * A press that queued eight of eleven must account for the other three, or
   * the operator is left believing the whole show is under way.
   */
  it("accounts for every episode it did not queue", () => {
    const line = describeBulkOutcome(
      {
        queued: 8,
        alreadyQueued: 2,
        alreadyComplete: 3,
        unavailable: 1,
        failed: 1,
      },
      t,
      format,
    );
    expect(line.split(" · ")).toHaveLength(5);
  });
});

describe("naming a job in the queue", () => {
  it("names a film by itself", () => {
    expect(jobLabel({ kind: "movie", title: "Dune" }, "x")).toEqual({
      primary: "Dune",
      secondary: null,
    });
  });

  it("names an episode by its show and code", () => {
    expect(
      jobLabel(
        {
          kind: "episode",
          seriesTitle: "The Sopranos",
          code: "S01E01",
          title: "Pilot",
        },
        "x",
      ),
    ).toEqual({ primary: "The Sopranos", secondary: "S01E01 · Pilot" });
  });

  it("falls back when the overview has no label for the job", () => {
    expect(jobLabel(undefined, "fallback")).toEqual({
      primary: "fallback",
      secondary: null,
    });
  });
});

describe("count lines", () => {
  it("mentions only the states that are actually present", () => {
    expect(
      summariseCounts(counts({ total: 13, complete: 13 }), t, format),
    ).toBe("processing.tv.countProcessed:13");
    expect(summariseCounts(counts({ total: 0 }), t, format)).toBe("");
  });

  it("lists several states in a stable order", () => {
    const line = summariseCounts(
      counts({ complete: 7, partial: 2, unprocessed: 4, active: 1 }),
      t,
      format,
    );
    expect(line.split(" · ")).toEqual([
      "processing.tv.countProcessed:7",
      "processing.tv.countPartial:2",
      "processing.tv.countUnprocessed:4",
      "processing.tv.countActive:1",
    ]);
  });
});
