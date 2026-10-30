// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import {
  createAcquisitionFallback,
  MAX_AUTOMATIC_REPLACEMENTS,
  type MissingEpisodePlan,
  type SeasonEpisode,
} from "./acquisitionFallback";
import {
  ACQUISITION_JOB_TYPES,
  createAcquisitionJobHandlers,
} from "./acquisitionJobs";
import type {
  AcquisitionRepository,
  AcquisitionSummary,
  AcquisitionTarget,
  CreateAcquisitionInput,
} from "./acquisitionRepository";
import type { AcquisitionService } from "./acquisitionService";
import type { IndexerSearchService } from "../indexers/searchService";
import type { IndexerRelease } from "../indexers/indexerTypes";
import { IndexerError } from "../indexers/indexerTypes";
import type { PolicyRepository } from "../releases/policyRepository";
import type {
  AddBlocklistEntry,
  BlocklistRepository,
} from "../releases/blocklistRepository";
import { profileFromIds } from "../releases/qualityProfile";
import type { JobQueue, JobRecord } from "../tasks/jobQueue";
import type { JobContext } from "../tasks/worker";
import {
  createMissingSearchJobHandler,
  MISSING_SEARCH_JOB_TYPE,
} from "./missingEpisodes";

const SERIES = "00000000-0000-4000-8000-000000000001";
const episodeId = (n: number) =>
  `00000000-0000-4000-8000-0000000001${String(n).padStart(2, "0")}`;

function release(title: string, guid: string): IndexerRelease {
  return {
    indexerId: "nzbgeek",
    indexerName: "NZBgeek",
    protocol: "usenet",
    guid,
    title,
    downloadUrl: "https://example.invalid/nzb",
    categoryIds: [5000],
    attributes: {},
  };
}

function summary(over: Partial<AcquisitionSummary> = {}): AcquisitionSummary {
  return {
    id: "a1",
    state: "failed",
    failureClass: "missing-articles",
    indexerId: "nzbgeek",
    releaseGuid: "pack-guid",
    releaseTitle: "Show.S01.1080p.BluRay.x265-BROKEN",
    idempotencyKey: "seyirlik-a1",
    attempt: 1,
    targetTitle: "Show",
    targetKind: "season",
    origin: "manual",
    createdAtMs: 0,
    updatedAtMs: 0,
    ...over,
  };
}

interface World {
  /**
   * Releases the indexer returns, by the episode searched: 0 for a season
   * pack, -1 for the whole series.
   */
  releases: Map<number, IndexerRelease[]>;
  episodes: SeasonEpisode[];
  live: Set<number>;
  replacements: number;
  searchFails: boolean;
  target: AcquisitionTarget;
  record: AcquisitionSummary;
  /** What the series is missing, when the fallback can read it. */
  missingPlan?: MissingEpisodePlan;
}

function world(over: Partial<World> = {}): World {
  return {
    releases: new Map(),
    episodes: [1, 2, 3].map((n) => ({ itemId: episodeId(n), episode: n })),
    live: new Set(),
    replacements: 0,
    searchFails: false,
    target: { kind: "season", itemId: SERIES, title: "Show", season: 1 },
    record: summary(),
    ...over,
  };
}

function build(w: World) {
  const created: CreateAcquisitionInput[] = [];
  const updates: Array<{
    id: string;
    from: string;
    patch: Record<string, unknown>;
  }> = [];
  const enqueued: Array<{
    jobType: string;
    payload?: Record<string, unknown>;
  }> = [];
  const blocklisted: AddBlocklistEntry[] = [];

  const repository = {
    get: async (id: string) => (id === w.record.id ? w.record : null),
    list: async () => [w.record],
    listActive: async () => [],
    create: async (input: CreateAcquisitionInput) => {
      created.push(input);
      return summary({ id: `new-${created.length}`, state: "planned" });
    },
    update: async (
      id: string,
      from: string,
      patch: Record<string, unknown>,
    ) => {
      updates.push({ id, from, patch });
      return true;
    },
    supersedeFailedFor: vi.fn(async () => 0),
    searchContext: async () => ({ target: w.target, profileId: "p1" }),
    hasLiveAcquisitionFor: async (target: AcquisitionTarget) =>
      w.live.has(target.episode ?? 0),
    replacementsFor: async () => w.replacements,
  } as unknown as AcquisitionRepository;

  const search: IndexerSearchService = {
    search: vi.fn(async (query: { season?: number; episode?: number }) => {
      if (w.searchFails) throw new IndexerError("unavailable", "Timed out.");
      return {
        releases:
          w.releases.get(
            query.season === undefined ? -1 : (query.episode ?? 0),
          ) ?? [],
        outcomes: [],
        partial: false,
      };
    }),
  } as unknown as IndexerSearchService;

  const policies = {
    load: async () => ({
      profile: profileFromIds("p1", "HD-1080p", [
        "bluray-1080p",
        "webdl-1080p",
      ]),
      preferences: [],
    }),
  } as unknown as PolicyRepository;

  const blocklist = {
    add: async (entry: AddBlocklistEntry) => {
      blocklisted.push(entry);
    },
    matcherFor: async () => (candidate: { guid: string }) =>
      blocklisted.some((entry) => entry.releaseGuid === candidate.guid),
  } as unknown as BlocklistRepository;

  let jobs = 0;
  const queue = {
    enqueue: async (input: {
      jobType: string;
      payload?: Record<string, unknown>;
    }) => {
      enqueued.push(input);
      jobs += 1;
      return `job-${jobs}`;
    },
  } as unknown as JobQueue;

  const service: AcquisitionService = {
    submit: vi.fn(async () => undefined),
    reconcile: vi.fn(async () => ({ examined: 1, changed: 0 })),
    cancel: vi.fn(async () => undefined),
    blocklist: vi.fn(async () => true),
    setPaused: vi.fn(async () => undefined),
    move: vi.fn(async () => 0),
  };

  const fallback = createAcquisitionFallback({
    repository,
    search,
    policies,
    blocklist,
    queue,
    episodesOf: async () => w.episodes,
    submitJobType: ACQUISITION_JOB_TYPES.submit,
    ...(w.missingPlan
      ? { missingPlanOf: async () => w.missingPlan ?? null }
      : {}),
  });
  const handlers = createAcquisitionJobHandlers(service, repository, {
    fallback,
    blocklist,
    queue,
  });
  const run = (jobType: string, payload: Record<string, unknown> = {}) =>
    handlers[jobType]!({
      job: { payload } as JobRecord,
      reportProgress: vi.fn(async () => undefined),
      isCancelled: async () => false,
    } as JobContext);

  return {
    created,
    updates,
    enqueued,
    blocklisted,
    service,
    search,
    run,
    fallback,
    repository,
  };
}

describe("automatic replacement of a release that cannot complete", () => {
  it("is asked for by the reconciler, once per failed acquisition", async () => {
    const w = world();
    const h = build(w);
    await h.run(ACQUISITION_JOB_TYPES.reconcile);
    expect(h.enqueued).toEqual([
      {
        jobType: ACQUISITION_JOB_TYPES.replace,
        payload: { acquisitionId: "a1" },
        dedupeKey: `${ACQUISITION_JOB_TYPES.replace}:a1`,
      },
    ]);
  });

  it("is not asked for when nothing automatic will help", async () => {
    const w = world({ record: summary({ failureClass: "sab-auth" }) });
    const h = build(w);
    await h.run(ACQUISITION_JOB_TYPES.reconcile);
    expect(h.enqueued).toHaveLength(0);
  });

  it("replaces a broken pack with the next acceptable pack", async () => {
    const w = world();
    w.releases.set(0, [
      release("Show.S01.1080p.BluRay.x265-BROKEN", "pack-guid"),
      release("Show.S01.1080p.WEB-DL.x264-GOOD", "good-pack"),
    ]);
    const h = build(w);
    const result = await h.run(ACQUISITION_JOB_TYPES.replace, {
      acquisitionId: "a1",
    });
    expect(result).toMatchObject({ replaced: true, created: 1 });
    expect(h.created[0]).toMatchObject({
      releaseGuid: "good-pack",
      origin: "fallback",
      target: { kind: "season", season: 1 },
    });
    expect(h.blocklisted[0]).toMatchObject({
      releaseGuid: "pack-guid",
      reason: "missing-articles",
    });
    // Its SABnzbd job and partial files go.
    expect(h.service.blocklist).toHaveBeenCalledWith("a1");
    expect(h.updates).toContainEqual(
      expect.objectContaining({
        from: "failed",
        patch: { state: "superseded" },
      }),
    );
  });

  it("replaces a season with its episodes when no other pack is acceptable", async () => {
    const w = world({ live: new Set([2]) });
    w.releases.set(0, [
      release("Show.S01.1080p.BluRay.x265-BROKEN", "pack-guid"),
    ]);
    w.releases.set(1, [release("Show.S01E01.1080p.BluRay.x265-d3g", "e1")]);
    w.releases.set(3, []);
    const h = build(w);
    const result = await h.run(ACQUISITION_JOB_TYPES.replace, {
      acquisitionId: "a1",
    });
    expect(result).toMatchObject({
      replaced: true,
      episodes: 1,
      missingEpisodes: [3],
    });
    // Episode 2 already has a download; episode 3 has nothing acceptable.
    expect(h.created).toHaveLength(1);
    expect(h.created[0]).toMatchObject({
      releaseGuid: "e1",
      target: {
        kind: "episode",
        itemId: episodeId(1),
        title: "Show",
        season: 1,
        episode: 1,
      },
    });
    expect(
      h.enqueued.filter((job) => job.jobType === ACQUISITION_JOB_TYPES.submit),
    ).toHaveLength(1);
  });

  it("leaves the acquisition untouched when the search fails, for the queue to retry", async () => {
    const w = world({ searchFails: true });
    const h = build(w);
    await expect(
      h.run(ACQUISITION_JOB_TYPES.replace, { acquisitionId: "a1" }),
    ).rejects.toBeInstanceOf(IndexerError);
    expect(h.blocklisted).toHaveLength(0);
    expect(h.updates).toHaveLength(0);
    expect(h.service.blocklist).not.toHaveBeenCalled();
  });

  it(`gives up after ${MAX_AUTOMATIC_REPLACEMENTS} replacements for an episode`, async () => {
    const w = world({
      replacements: MAX_AUTOMATIC_REPLACEMENTS,
      target: { kind: "episode", title: "Show", season: 1, episode: 1 },
      record: summary({ targetKind: "episode" }),
    });
    w.releases.set(1, [
      release("Show.S01E01.1080p.WEB-DL.x264-GOOD", "good-episode"),
    ]);
    const h = build(w);
    const result = await h.run(ACQUISITION_JOB_TYPES.replace, {
      acquisitionId: "a1",
    });
    expect(result).toMatchObject({ replaced: false });
    expect(h.search.search).not.toHaveBeenCalled();
    expect(h.created).toHaveLength(0);
    expect(h.updates.at(-1)).toMatchObject({
      from: "failed",
      patch: { failureClass: "blocklisted" },
    });
  });

  it("stops, blocklisted, when nothing at all is acceptable", async () => {
    const w = world({ episodes: [] });
    const h = build(w);
    const result = await h.run(ACQUISITION_JOB_TYPES.replace, {
      acquisitionId: "a1",
    });
    expect(result).toMatchObject({ replaced: false });
    expect(h.updates.at(-1)).toMatchObject({
      patch: { failureClass: "blocklisted" },
    });
  });

  it("does nothing for an acquisition somebody already dealt with", async () => {
    const w = world({ record: summary({ state: "superseded" }) });
    const h = build(w);
    expect(
      await h.run(ACQUISITION_JOB_TYPES.replace, { acquisitionId: "a1" }),
    ).toEqual({ skipped: true });
    expect(h.search.search).not.toHaveBeenCalled();
  });
});

describe("searching for a series' missing episodes", () => {
  const search = (
    h: ReturnType<typeof build>,
    seasons: Array<{ season: number; whole: boolean; episodes: number[] }>,
  ) =>
    createMissingSearchJobHandler(h.fallback)({
      job: {
        jobType: MISSING_SEARCH_JOB_TYPE,
        payload: {
          profileId: "p1",
          plan: {
            seriesItemId: SERIES,
            title: "Show",
            seasons: seasons.map(({ season, whole, episodes }) => ({
              season,
              whole,
              episodes: episodes.map((episode) => ({
                episode,
                itemId: episode === 2 ? SERIES : episodeId(episode),
              })),
            })),
          },
        },
      } as unknown as JobRecord,
      reportProgress: vi.fn(async () => undefined),
      isCancelled: async () => false,
    } as JobContext);

  it("searches only the missing episodes of a season it partly holds", async () => {
    const w = world();
    w.releases.set(0, [release("Show.S01.1080p.BluRay.x265-PACK", "pack")]);
    w.releases.set(1, [release("Show.S01E01.1080p.BluRay.x265-d3g", "e1")]);
    w.releases.set(3, [release("Show.S01E03.1080p.WEB-DL.x264-NTb", "e3")]);
    const h = build(w);
    const result = await search(h, [
      { season: 1, whole: false, episodes: [1, 3] },
    ]);
    // The pack would fetch episode 2 again, so it is never asked for.
    expect(
      vi.mocked(h.search.search).mock.calls.map(([query]) => query.episode),
    ).toEqual([1, 3]);
    expect(h.created.map((input) => input.releaseGuid)).toEqual(["e1", "e3"]);
    expect(h.created[0]).toMatchObject({
      origin: "automatic",
      target: { kind: "episode", itemId: episodeId(1), season: 1, episode: 1 },
    });
    expect(h.enqueued.map((job) => job.jobType)).toEqual([
      ACQUISITION_JOB_TYPES.submit,
      ACQUISITION_JOB_TYPES.submit,
    ]);
    expect(h.repository.supersedeFailedFor).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ started: 2, nothingAcceptable: 0 });
  });

  it("files an episode the catalogue has no row for under its series", async () => {
    const w = world();
    w.releases.set(2, [release("Show.S01E02.1080p.BluRay.x265-d3g", "e2")]);
    const h = build(w);
    await search(h, [{ season: 1, whole: false, episodes: [2] }]);
    expect(h.created[0]!.target).toMatchObject({
      kind: "episode",
      itemId: SERIES,
      season: 1,
      episode: 2,
    });
  });

  it("asks for a pack first when nothing of the season is held", async () => {
    const w = world();
    w.releases.set(0, [release("Show.S01.1080p.BluRay.x265-PACK", "pack")]);
    const h = build(w);
    const result = await search(h, [
      { season: 1, whole: true, episodes: [1, 2, 3] },
    ]);
    expect(h.created).toHaveLength(1);
    expect(h.created[0]).toMatchObject({
      releaseGuid: "pack",
      target: { kind: "season", itemId: SERIES, season: 1 },
    });
    expect(result).toMatchObject({
      started: 1,
      startedReleases: [
        {
          season: 1,
          episode: null,
          release: "Show.S01.1080p.BluRay.x265-PACK",
        },
      ],
    });
  });

  it("goes episode by episode when a whole season has no pack", async () => {
    const w = world();
    w.releases.set(1, [release("Show.S01E01.1080p.BluRay.x265-d3g", "e1")]);
    const h = build(w);
    const result = await search(h, [
      { season: 1, whole: true, episodes: [1, 2, 3] },
    ]);
    expect(h.created.map((input) => input.releaseGuid)).toEqual(["e1"]);
    expect(result).toMatchObject({
      started: 1,
      nothingAcceptable: 2,
      nothingFor: [
        { season: 1, episode: 2 },
        { season: 1, episode: 3 },
      ],
    });
  });

  it("leaves a season alone while a pack for it is downloading", async () => {
    const w = world({ live: new Set([0]) });
    w.releases.set(1, [release("Show.S01E01.1080p.BluRay.x265-d3g", "e1")]);
    const h = build(w);
    const result = await search(h, [
      { season: 1, whole: false, episodes: [1] },
    ]);
    expect(h.search.search).not.toHaveBeenCalled();
    // Said, rather than reported as nothing at all.
    expect(result).toMatchObject({
      started: 0,
      nothingAcceptable: 0,
      alreadyComing: 1,
      coveredBy: [{ season: 1, episode: null }],
    });
  });

  it("skips an episode that started downloading since the plan was made", async () => {
    const w = world({ live: new Set([1]) });
    w.releases.set(3, [release("Show.S01E03.1080p.WEB-DL.x264-NTb", "e3")]);
    const h = build(w);
    const result = await search(h, [
      { season: 1, whole: false, episodes: [1, 3] },
    ]);
    expect(h.created.map((input) => input.releaseGuid)).toEqual(["e3"]);
    expect(result).toMatchObject({ coveredBy: [{ season: 1, episode: 1 }] });
  });
});

describe("stepping a pack down instead of giving up", () => {
  const plan: MissingEpisodePlan = {
    seriesItemId: SERIES,
    title: "Show",
    complete: true,
    seasons: [1, 2].map((season) => ({
      season,
      whole: true,
      episodes: [1, 2].map((episode) => ({
        episode,
        itemId: episodeId(episode),
      })),
    })),
  };

  it(`searches a season episode by episode after ${MAX_AUTOMATIC_REPLACEMENTS} failed packs`, async () => {
    const w = world({ replacements: MAX_AUTOMATIC_REPLACEMENTS });
    w.releases.set(0, [
      release("Show.S01.1080p.WEB-DL.x264-GOOD", "good-pack"),
    ]);
    w.releases.set(1, [release("Show.S01E01.1080p.BluRay.x265-d3g", "e1")]);
    const h = build(w);
    const result = await h.run(ACQUISITION_JOB_TYPES.replace, {
      acquisitionId: "a1",
    });
    // Not the next pack: its episodes.
    expect(result).toMatchObject({ replaced: true, episodes: 1 });
    expect(h.created.map((input) => input.releaseGuid)).toEqual(["e1"]);
    expect(h.blocklisted[0]).toMatchObject({ releaseGuid: "pack-guid" });
  });

  it("hands a season with no other pack to the missing-episode search", async () => {
    const w = world({ missingPlan: { ...plan, seasons: [plan.seasons[0]!] } });
    const h = build(w);
    const result = await h.run(ACQUISITION_JOB_TYPES.replace, {
      acquisitionId: "a1",
    });
    expect(result).toMatchObject({ replaced: true, created: 0 });
    expect(h.blocklisted[0]).toMatchObject({ releaseGuid: "pack-guid" });
    expect(h.enqueued.at(-1)).toMatchObject({
      jobType: MISSING_SEARCH_JOB_TYPE,
      payload: { profileId: "p1" },
      dedupeKey: `${MISSING_SEARCH_JOB_TYPE}:${SERIES}:1:fallback`,
    });
    expect(h.updates).toContainEqual(
      expect.objectContaining({ patch: { state: "superseded" } }),
    );
  });

  it("replaces a failed whole-series pack with another one first", async () => {
    const w = world({
      missingPlan: plan,
      target: { kind: "series", itemId: SERIES, title: "Show" },
      record: summary({
        targetKind: "series",
        releaseTitle: "Show.Complete.Series.1080p.BluRay.x265-BROKEN",
      }),
    });
    w.releases.set(-1, [
      release("Show.Complete.Series.1080p.BluRay.x265-BROKEN", "pack-guid"),
      release("Show.S01-S02.1080p.WEB-DL.x264-GOOD", "good-series"),
    ]);
    const h = build(w);
    await h.run(ACQUISITION_JOB_TYPES.replace, { acquisitionId: "a1" });
    expect(h.created[0]).toMatchObject({
      releaseGuid: "good-series",
      target: { kind: "series", itemId: SERIES },
    });
  });

  it("searches a whole series season by season when no other release holds it all", async () => {
    const w = world({
      missingPlan: plan,
      target: { kind: "series", itemId: SERIES, title: "Show" },
      record: summary({ targetKind: "series" }),
    });
    // Season 1 alone is not the series.
    w.releases.set(-1, [release("Show.S01.1080p.WEB-DL.x264-GOOD", "s1")]);
    const h = build(w);
    await h.run(ACQUISITION_JOB_TYPES.replace, { acquisitionId: "a1" });
    expect(h.created).toHaveLength(0);
    expect(h.enqueued.at(-1)).toMatchObject({
      jobType: MISSING_SEARCH_JOB_TYPE,
      dedupeKey: `${MISSING_SEARCH_JOB_TYPE}:${SERIES}:all:fallback`,
    });
  });
});

describe("searching for a series of which nothing is held", () => {
  const plan: MissingEpisodePlan = {
    seriesItemId: SERIES,
    title: "Show",
    complete: true,
    seasons: [1, 2].map((season) => ({
      season,
      whole: true,
      episodes: [1, 2].map((episode) => ({
        episode,
        itemId: episodeId(episode),
      })),
    })),
  };
  const run = (h: ReturnType<typeof build>, missing = plan) =>
    createMissingSearchJobHandler(h.fallback)({
      job: {
        jobType: MISSING_SEARCH_JOB_TYPE,
        payload: { profileId: "p1", plan: missing },
      } as unknown as JobRecord,
      reportProgress: vi.fn(async () => undefined),
      isCancelled: async () => false,
    } as JobContext);

  it("asks for the whole series in one release first", async () => {
    const w = world();
    w.releases.set(-1, [
      release("Show.Complete.Series.1080p.BluRay.x265-ALL", "all"),
      release("Show.S01.1080p.BluRay.x265-ONE", "one"),
    ]);
    const h = build(w);
    const result = await run(h);
    expect(h.created).toHaveLength(1);
    expect(h.created[0]).toMatchObject({
      releaseGuid: "all",
      origin: "automatic",
      target: { kind: "series", itemId: SERIES, title: "Show" },
    });
    expect(h.created[0]!.target).not.toHaveProperty("season");
    expect(result).toMatchObject({
      started: 1,
      startedReleases: [
        {
          season: null,
          episode: null,
          release: "Show.Complete.Series.1080p.BluRay.x265-ALL",
        },
      ],
    });
  });

  it("takes a pack of named seasons only when it holds every one", async () => {
    const w = world();
    w.releases.set(-1, [release("Show.S01-S02.1080p.WEB-DL.x264-NTb", "both")]);
    const h = build(w);
    await run(h);
    expect(h.created[0]).toMatchObject({ releaseGuid: "both" });

    const partial = world();
    partial.releases.set(-1, [
      release("Show.S01-S02.1080p.WEB-DL.x264-NTb", "both"),
    ]);
    const three = build(partial);
    await run(three, {
      ...plan,
      seasons: [...plan.seasons, { ...plan.seasons[0]!, season: 3 }],
    });
    // Season 3 is not in it, so the seasons are searched one by one.
    expect(three.created.map((input) => input.releaseGuid)).not.toContain(
      "both",
    );
  });

  it("falls back to season packs, then episodes, when there is no series pack", async () => {
    const w = world();
    w.releases.set(0, [release("Show.S01.1080p.BluRay.x265-PACK", "pack")]);
    const h = build(w);
    // The season-pack search answers the same for both seasons here, so the
    // second season is read from its episode searches only by a world that
    // offers it no pack: one pack, then episodes.
    const result = await run(h, {
      ...plan,
      seasons: [plan.seasons[0]!],
      complete: true,
    });
    expect(h.created.map((input) => input.target.kind)).toEqual(["season"]);
    expect(result).toMatchObject({ started: 1 });

    const none = world();
    none.releases.set(1, [
      release("Show.S01E01.1080p.BluRay.x265-d3g", "s1e1"),
      release("Show.S02E01.1080p.BluRay.x265-d3g", "s2e1"),
    ]);
    const bare = build(none);
    const episodes = await run(bare);
    expect(bare.created.map((input) => input.target.kind)).toEqual([
      "episode",
      "episode",
    ]);
    expect(episodes).toMatchObject({ started: 2, nothingAcceptable: 2 });
  });

  it("leaves the series alone while a whole-series download is on its way", async () => {
    const w = world();
    const h = build(w);
    Object.assign(h.repository, {
      hasLiveAcquisitionFor: async (target: AcquisitionTarget) =>
        target.kind === "series",
    });
    const result = await run(h);
    expect(h.search.search).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      coveredBy: [{ season: null, episode: null }],
    });
  });
});
