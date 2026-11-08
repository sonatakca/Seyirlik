import { describe, expect, it } from "vitest";
import type {
  ProcessingEpisode,
  ProcessingSeason,
  ProcessingSeries,
} from "../../lib/processingApi";
import {
  countStatuses,
  filterByStatus,
  filterSeriesByStatus,
  matchesStatus,
  seriesEpisodes,
  type StatusFacts,
} from "./processingStatusFilter";

function facts(o: Partial<StatusFacts> = {}): StatusFacts {
  return {
    activeJobId: null,
    activeJobState: null,
    packageState: "none",
    sourceAvailable: true,
    ...o,
  };
}

const queued = facts({ activeJobId: "j1", activeJobState: "queued" });
const pending = facts({ activeJobId: "j2", activeJobState: "pending" });
const running = facts({ activeJobId: "j3", activeJobState: "running" });
const paused = facts({ activeJobId: "j4", activeJobState: "paused" });
const unprocessed = facts();
const partial = facts({ packageState: "partial" });
const stale = facts({ packageState: "stale" });
const complete = facts({ packageState: "complete" });
const orphanComplete = facts({
  packageState: "complete",
  sourceAvailable: false,
});
const unknown = facts({ packageState: "unknown" });

describe("matchesStatus", () => {
  it("files pending and queued jobs together as queued", () => {
    expect(matchesStatus(queued, "queued")).toBe(true);
    expect(matchesStatus(pending, "queued")).toBe(true);
    expect(matchesStatus(running, "queued")).toBe(false);
  });

  it("keeps a title with a job out of the package chips", () => {
    // A queued title has no package yet, but it is not "not processed".
    expect(matchesStatus(queued, "unprocessed")).toBe(false);
    const rerun = facts({
      activeJobId: "j5",
      activeJobState: "running",
      packageState: "complete",
    });
    expect(matchesStatus(rerun, "complete")).toBe(false);
    expect(matchesStatus(rerun, "running")).toBe(true);
  });

  it("reads stale packages as partial", () => {
    expect(matchesStatus(partial, "partial")).toBe(true);
    expect(matchesStatus(stale, "partial")).toBe(true);
    expect(matchesStatus(complete, "partial")).toBe(false);
  });

  it("lets a finished title with a deleted source match both chips", () => {
    expect(matchesStatus(orphanComplete, "complete")).toBe(true);
    expect(matchesStatus(orphanComplete, "sourceMissing")).toBe(true);
    expect(matchesStatus(complete, "sourceMissing")).toBe(false);
  });

  it("puts a title the index has not read under no package chip", () => {
    for (const filter of [
      "unprocessed",
      "partial",
      "complete",
      "queued",
    ] as const) {
      expect(matchesStatus(unknown, filter)).toBe(false);
    }
    expect(matchesStatus(unknown, "all")).toBe(true);
  });
});

describe("countStatuses", () => {
  it("counts every chip, with undescribed titles only under all", () => {
    const counts = countStatuses([
      queued,
      pending,
      running,
      paused,
      unprocessed,
      partial,
      stale,
      complete,
      orphanComplete,
      unknown,
      undefined,
    ]);
    expect(counts).toEqual({
      all: 11,
      queued: 2,
      running: 1,
      paused: 1,
      unprocessed: 1,
      partial: 2,
      complete: 2,
      sourceMissing: 1,
    });
  });
});

describe("filterByStatus", () => {
  const films = [
    { id: "a", facts: queued },
    { id: "b", facts: complete },
    { id: "c", facts: undefined },
  ];
  const factsOf = (film: (typeof films)[number]) => film.facts;

  it("returns everything, in order, under all", () => {
    expect(filterByStatus(films, factsOf, "all").map((f) => f.id)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("drops films the overview does not describe from narrowed chips", () => {
    expect(
      filterByStatus(films, factsOf, "complete").map((f) => f.id),
    ).toEqual(["b"]);
    expect(filterByStatus(films, factsOf, "queued").map((f) => f.id)).toEqual(
      ["a"],
    );
  });
});

function episode(id: string, o: Partial<StatusFacts> = {}): ProcessingEpisode {
  return {
    itemId: id,
    mediaFileId: `${id}-file`,
    title: id,
    sortTitle: id,
    fileCount: 1,
    probed: true,
    source: null,
    plan: null,
    package: null,
    processable: false,
    seasonNumber: 1,
    episodeNumber: 1,
    code: "S01E01",
    ...facts(o),
  };
}

function season(id: string, episodes: ProcessingEpisode[]): ProcessingSeason {
  return {
    seasonId: id,
    seasonNumber: 1,
    title: id,
    episodes,
    counts: {
      total: 0,
      complete: 0,
      partial: 0,
      unprocessed: 0,
      unknown: 0,
      active: 0,
      unavailable: 0,
      eligible: 0,
    },
  };
}

function show(id: string, seasons: ProcessingSeason[]): ProcessingSeries {
  return {
    seriesId: id,
    title: id,
    sortTitle: id,
    productionYear: null,
    seasonCount: seasons.length,
    episodeCount: seasons.reduce((n, s) => n + s.episodes.length, 0),
    seasons,
    counts: season("x", []).counts,
  };
}

describe("filterSeriesByStatus", () => {
  const doneSeason = season("done", [
    episode("d1", { packageState: "complete" }),
    episode("d2", { packageState: "complete" }),
  ]);
  const mixedSeason = season("mixed", [
    episode("m1", { packageState: "complete" }),
    episode("m2", { activeJobId: "j", activeJobState: "queued" }),
  ]);
  const doneShow = show("done-show", [doneSeason]);
  const mixedShow = show("mixed-show", [doneSeason, mixedSeason]);
  const tree = [doneShow, mixedShow];

  it("narrows to matching episodes and drops emptied seasons and shows", () => {
    const result = filterSeriesByStatus(tree, "queued");
    expect(result).toHaveLength(1);
    expect(result[0].seriesId).toBe("mixed-show");
    expect(result[0].seasons.map((s) => s.seasonId)).toEqual(["mixed"]);
    expect(result[0].seasons[0].episodes.map((e) => e.itemId)).toEqual(["m2"]);
  });

  it("keeps untouched branches by identity", () => {
    const result = filterSeriesByStatus(tree, "complete");
    expect(result[0]).toBe(doneShow);
    expect(result[1].seasons[0]).toBe(doneSeason);
    expect(result[1].seasons[1]).not.toBe(mixedSeason);
  });

  it("counts episodes across the tree", () => {
    expect(countStatuses(seriesEpisodes(tree))).toMatchObject({
      all: 6,
      complete: 5,
      queued: 1,
    });
  });
});
