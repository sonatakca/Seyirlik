// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import {
  createAcquisitionFallback,
  MAX_AUTOMATIC_REPLACEMENTS,
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
  /** Releases the indexer returns, by the episode searched (0 for a pack). */
  releases: Map<number, IndexerRelease[]>;
  episodes: SeasonEpisode[];
  live: Set<number>;
  replacements: number;
  searchFails: boolean;
  target: AcquisitionTarget;
  record: AcquisitionSummary;
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
    search: vi.fn(async (query: { episode?: number }) => {
      if (w.searchFails) throw new IndexerError("unavailable", "Timed out.");
      return {
        releases: w.releases.get(query.episode ?? 0) ?? [],
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
  };

  const fallback = createAcquisitionFallback({
    repository,
    search,
    policies,
    blocklist,
    queue,
    episodesOf: async () => w.episodes,
    submitJobType: ACQUISITION_JOB_TYPES.submit,
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

  return { created, updates, enqueued, blocklisted, service, search, run };
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

  it(`gives up after ${MAX_AUTOMATIC_REPLACEMENTS} replacements for a title`, async () => {
    const w = world({ replacements: MAX_AUTOMATIC_REPLACEMENTS });
    w.releases.set(0, [
      release("Show.S01.1080p.WEB-DL.x264-GOOD", "good-pack"),
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
