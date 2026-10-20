// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createAcquisitionRoutes } from "./acquisitionRoutes";
import { ACQUISITION_JOB_TYPES } from "./acquisitionJobs";
import { SabError } from "./sabnzbd";
import type { SabJob, SabnzbdClient } from "./sabnzbd";
import type {
  AcquisitionRepository,
  AcquisitionSummary,
  CreateAcquisitionInput,
} from "./acquisitionRepository";
import {
  AcquisitionControlError,
  type AcquisitionService,
} from "./acquisitionService";
import type { IndexerRegistry } from "../indexers/indexerRegistry";
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
import type { MissingEpisodePlan } from "./acquisitionFallback";
import { MISSING_SEARCH_JOB_TYPE } from "./missingEpisodes";
import type { RouteContext, RouteDefinition } from "../api/router";
import { OwnApiError } from "../ownApiHandler";

const SECRET = "0123456789abcdef0123456789abcdef";
const DOWNLOAD_URL = `https://api.invalid/api?t=get&id=1&apikey=${SECRET}`;

function summary(over: Partial<AcquisitionSummary> = {}): AcquisitionSummary {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    state: "queued",
    indexerId: "nzbgeek",
    releaseGuid: DOWNLOAD_URL,
    releaseTitle: "Big.Buck.Bunny.2008.1080p.WEB-DL",
    idempotencyKey: "seyirlik-11111111-1111-4111-8111-111111111111",
    externalId: "SABnzbd_nzo_secret",
    attempt: 1,
    targetTitle: "Big Buck Bunny",
    targetKind: "movie",
    origin: "manual",
    createdAtMs: 1_700_000_000_000,
    updatedAtMs: 1_700_000_001_000,
    ...over,
  };
}

function found(title: string, guid: string): IndexerRelease {
  return {
    indexerId: "nzbgeek",
    indexerName: "NZBgeek",
    protocol: "usenet",
    guid,
    title,
    downloadUrl: DOWNLOAD_URL,
    categoryIds: [2000],
    attributes: {},
  };
}

interface Harness {
  routes: RouteDefinition[];
  created: CreateAcquisitionInput[];
  enqueued: Array<Record<string, unknown>>;
  service: AcquisitionService;
  updates: Array<{ id: string; from: string; patch: Record<string, unknown> }>;
  blocklisted: AddBlocklistEntry[];
  search: IndexerSearchService;
  repository: AcquisitionRepository;
}

function harness(
  records: AcquisitionSummary[] = [summary()],
  over: {
    service?: Partial<AcquisitionService>;
    sab?: Partial<SabnzbdClient>;
    indexerIds?: string[];
    releases?: IndexerRelease[];
    searchFails?: boolean;
    profileId?: string | null;
    updateSucceeds?: (patch: Record<string, unknown>) => boolean;
    preBlocklisted?: AddBlocklistEntry[];
    profiles?: Array<{ id: string; name: string }>;
    missingEpisodes?: (
      itemId: string,
      season?: number,
    ) => Promise<MissingEpisodePlan | null>;
    profileOf?: (itemId: string) => Promise<string | undefined>;
    jobs?: Record<string, Partial<JobRecord>>;
  } = {},
): Harness {
  const created: CreateAcquisitionInput[] = [];
  const blocklisted: AddBlocklistEntry[] = [...(over.preBlocklisted ?? [])];
  const enqueued: Array<Record<string, unknown>> = [];
  const updates: Harness["updates"] = [];

  const repository = {
    create: async (input: CreateAcquisitionInput) => {
      created.push(input);
      return summary({ state: "planned" });
    },
    get: async (id: string) => records.find((r) => r.id === id) ?? null,
    list: async () => records,
    listReadyForImport: async () =>
      records.filter((r) => r.state === "downloaded"),
    detail: async (id: string) => {
      const found = records.find((r) => r.id === id);
      return found
        ? {
            acquisition: found,
            decision: {
              profileName: "HD-1080p",
              score: 120,
              reasons: [{ code: "codec", detail: "Preferred codec" }],
              rejected: [
                { title: "Other.720p", reason: "quality-not-allowed" },
              ],
              decidedAtMs: 1_700_000_000_000,
            },
            events: [
              {
                fromState: null,
                toState: "planned",
                detail: "Chosen by manual decision.",
                atMs: 1_700_000_000_000,
              },
              {
                fromState: "submitting",
                toState: "queued",
                atMs: 1_700_000_001_000,
              },
            ],
          }
        : null;
    },
    update: async (
      id: string,
      from: string,
      patch: Record<string, unknown>,
    ) => {
      updates.push({ id, from, patch });
      return over.updateSucceeds ? over.updateSucceeds(patch) : true;
    },
    listActive: async () =>
      records.filter((r) =>
        [
          "planned",
          "resolving",
          "submitting",
          "queued",
          "downloading",
          "processing",
          "awaiting_retry",
        ].includes(r.state),
      ),
    supersedeFailedFor: vi.fn(async () => 0),
    searchContext: async (id: string) => {
      const found = records.find((r) => r.id === id);
      if (!found) return null;
      const profileId = over.profileId === undefined ? "p1" : over.profileId;
      return {
        target: { kind: "movie", title: "Big Buck Bunny", year: 2008 },
        ...(profileId ? { profileId } : {}),
      };
    },
  } as unknown as AcquisitionRepository;

  const service: AcquisitionService = {
    submit: vi.fn(async () => undefined),
    reconcile: vi.fn(async () => ({ examined: 0, changed: 0 })),
    cancel: vi.fn(async () => undefined),
    blocklist: vi.fn(async () => true),
    setPaused: vi.fn(async () => undefined),
    move: vi.fn(async () => 0),
    ...over.service,
  };

  const search: IndexerSearchService = {
    search: vi.fn(async () => {
      if (over.searchFails) {
        throw new IndexerError("unavailable", "The indexer timed out.");
      }
      return { releases: over.releases ?? [], outcomes: [], partial: false };
    }),
  };

  const policies = {
    listProfiles: async () =>
      (over.profiles ?? []).map((p) => ({ ...p, maxSizeBytes: null })),
    setMaxSize: async () => true,
    load: async (id: string) =>
      id === "p1"
        ? {
            profile: profileFromIds("p1", "HD-1080p", [
              "webdl-1080p",
              "bluray-1080p",
            ]),
            preferences: [],
          }
        : null,
  } as PolicyRepository;

  const blocklist = {
    add: async (entry: AddBlocklistEntry) => {
      blocklisted.push(entry);
    },
    list: async () => [],
    remove: async () => false,
    matcherFor: async () => (release: { guid: string; title: string }) =>
      blocklisted.some(
        (entry) =>
          entry.releaseGuid === release.guid ||
          entry.releaseTitle === release.title,
      ),
  } as BlocklistRepository;

  const ids = over.indexerIds ?? ["nzbgeek"];
  const indexers = {
    get: (id: string) => (ids.includes(id) ? ({ id } as never) : undefined),
  } as unknown as IndexerRegistry;

  const queue = {
    enqueue: vi.fn(async (options: Record<string, unknown>) => {
      enqueued.push(options);
      return "job-1";
    }),
    get: async (id: string) => over.jobs?.[id] ?? null,
  } as unknown as JobQueue;

  const sab = {
    version: vi.fn(async () => "4.3.3"),
    ...over.sab,
  } as unknown as SabnzbdClient;

  return {
    routes: createAcquisitionRoutes({
      repository,
      service,
      indexers,
      queue,
      sab,
      search,
      policies,
      blocklist,
      ...(over.missingEpisodes
        ? { missingEpisodes: over.missingEpisodes }
        : {}),
      ...(over.profileOf ? { profileOf: over.profileOf } : {}),
    }),
    created,
    enqueued,
    service,
    updates,
    blocklisted,
    search,
    repository,
  };
}

function route(h: Harness, method: string, path: string): RouteDefinition {
  const found = h.routes.find((r) => r.method === method && r.path === path);
  if (!found) throw new Error(`No route for ${method} ${path}`);
  return found;
}

interface Captured {
  status: number;
  payload: { data?: Record<string, unknown> } | undefined;
}

function invoke(
  definition: RouteDefinition,
  options: {
    body?: unknown;
    params?: Record<string, string>;
    query?: string;
  } = {},
): Promise<Captured> {
  const captured: Captured = { status: 0, payload: undefined };
  const context = {
    request: { once: () => undefined, off: () => undefined },
    response: {
      setHeader: () => undefined,
      end: (chunk?: string) => {
        captured.payload = chunk ? JSON.parse(chunk) : undefined;
      },
      get headersSent() {
        return false;
      },
      // The envelope assigns `statusCode` rather than calling `writeHead`.
      set statusCode(status: number) {
        captured.status = status;
      },
      get statusCode() {
        return captured.status;
      },
    },
    requestId: "req",
    url: new URL(
      `http://localhost/ownAPI/v1/acquisitions${options.query ?? ""}`,
    ),
    params: options.params ?? {},
    method: definition.method,
    principal: { userId: "u", isAdministrator: true },
    requirePrincipal: () => ({ userId: "u", isAdministrator: true }),
    readJson: async () => options.body,
  } as unknown as RouteContext;
  return definition.handle(context).then(() => captured);
}

const VALID_BODY = {
  kind: "movie",
  title: "Big Buck Bunny",
  year: 2008,
  indexerId: "nzbgeek",
  releaseGuid: "abc123",
  releaseTitle: "Big.Buck.Bunny.2008.1080p.WEB-DL",
};

describe("every acquisition endpoint is administrative", () => {
  it("exposes nothing to an ordinary viewer", () => {
    // Acquisition is operations, not playback. A viewer has no business here.
    for (const definition of harness().routes) {
      expect(definition.access).toBe("admin");
    }
  });
});

describe("what the wire shape carries", () => {
  it("never carries the credential-bearing download URL", async () => {
    /*
     * The guid is the provider's release identifier, and for some indexers
     * that is a details URL. Whatever it is, it is not client-facing: the URL
     * that fetches an NZB carries the API key.
     */
    const { payload } = await invoke(harness().routes[0]!);
    expect(JSON.stringify(payload)).not.toContain(SECRET);
    expect(JSON.stringify(payload)).not.toContain("apikey");
  });

  it("never carries SABnzbd's job identifier", async () => {
    // A client that cannot name an nzo id cannot quote one back at cancel.
    const { payload } = await invoke(harness().routes[0]!);
    expect(JSON.stringify(payload)).not.toContain("SABnzbd_nzo_secret");
  });

  it("lists acquisitions with their state and progress facts", async () => {
    const { status, payload } = await invoke(
      harness([summary({ state: "downloading", sizeBytes: 1024 })]).routes[0]!,
    );
    expect(status).toBe(200);
    expect(payload?.data?.acquisitions).toEqual([
      expect.objectContaining({
        state: "downloading",
        sizeBytes: 1024,
        target: { kind: "movie", title: "Big Buck Bunny" },
        releaseTitle: "Big.Buck.Bunny.2008.1080p.WEB-DL",
        createdAt: "2023-11-14T22:13:20.000Z",
      }),
    ]);
  });

  it("returns the audit trail with the detail", async () => {
    const h = harness();
    const { payload } = await invoke(
      route(h, "GET", "/acquisitions/:acquisitionId"),
      {
        params: { acquisitionId: summary().id },
      },
    );
    expect(payload?.data?.events).toEqual([
      expect.objectContaining({ toState: "planned" }),
      expect.objectContaining({ fromState: "submitting", toState: "queued" }),
    ]);
  });

  it("explains why this release was chosen", async () => {
    /*
     * The evidence was recorded from Phase 4 onward and never read, so an
     * operator could see that a download happened and not why it was this
     * release. Score alone would not answer it either — the reasons are the
     * answer, and the rejections are the other half of it.
     */
    const h = harness();
    const { payload } = await invoke(
      route(h, "GET", "/acquisitions/:acquisitionId"),
      { params: { acquisitionId: summary().id } },
    );
    expect(payload?.data?.decision).toMatchObject({
      profileName: "HD-1080p",
      score: 120,
      reasons: [{ code: "codec", detail: "Preferred codec" }],
      rejected: [{ title: "Other.720p", reason: "quality-not-allowed" }],
    });
  });

  it("never carries the download path in a list or a history", async () => {
    /*
     * It names a directory on the operator's disk. The import phase reads it
     * from the repository on the server, so carrying it here disclosed a
     * filesystem layout to nobody's benefit.
     */
    const h = harness([
      summary({ state: "downloaded", downloadPath: "C:/Downloads/Dune" }),
    ]);
    const listed = await invoke(h.routes[0]!);
    expect(JSON.stringify(listed.payload)).not.toContain("C:/Downloads");

    const detail = await invoke(
      route(h, "GET", "/acquisitions/:acquisitionId"),
      { params: { acquisitionId: summary().id } },
    );
    expect(JSON.stringify(detail.payload)).not.toContain("C:/Downloads");
  });

  it("publishes the path only where handing it over is the point", async () => {
    const h = harness([
      summary({ state: "downloaded", downloadPath: "C:/Downloads/Dune" }),
    ]);
    const { payload } = await invoke(
      route(h, "GET", "/acquisitions/ready-for-import"),
    );
    const ready = payload?.data?.ready as Array<Record<string, unknown>>;
    expect(ready[0]?.downloadPath).toBe("C:/Downloads/Dune");
  });

  it("answers 404 for an acquisition that does not exist", async () => {
    const h = harness([]);
    await expect(
      invoke(route(h, "GET", "/acquisitions/:acquisitionId"), {
        params: { acquisitionId: summary().id },
      }),
    ).rejects.toBeInstanceOf(OwnApiError);
  });

  it("refuses an identifier that is not one", async () => {
    const h = harness();
    await expect(
      invoke(route(h, "GET", "/acquisitions/:acquisitionId"), {
        params: { acquisitionId: "../../etc/passwd" },
      }),
    ).rejects.toThrow();
  });
});

describe("asking for an acquisition", () => {
  it("records the decision and queues the work", async () => {
    const h = harness();
    const { status, payload } = await invoke(
      route(h, "POST", "/acquisitions"),
      { body: VALID_BODY },
    );
    expect(status).toBe(202);
    expect(h.created[0]).toMatchObject({
      indexerId: "nzbgeek",
      releaseGuid: "abc123",
      origin: "manual",
      target: { kind: "movie", title: "Big Buck Bunny", year: 2008 },
    });
    expect(h.enqueued[0]).toMatchObject({
      jobType: ACQUISITION_JOB_TYPES.submit,
    });
    expect(payload?.data?.taskId).toBe("job-1");
  });

  it("does not submit inside the request", async () => {
    // The durable queue owns the work, so a restart mid-request loses nothing.
    const h = harness();
    await invoke(route(h, "POST", "/acquisitions"), { body: VALID_BODY });
    expect(h.service.submit).not.toHaveBeenCalled();
  });

  it("collapses a double-clicked button onto one submission", async () => {
    const h = harness();
    await invoke(route(h, "POST", "/acquisitions"), { body: VALID_BODY });
    expect(h.enqueued[0]!.dedupeKey).toBe(`acquisition.submit:${summary().id}`);
  });

  it("takes an indexer it knows, never a URL to fetch from", async () => {
    /*
     * The reason the body names an indexer id: an endpoint that accepted a URL
     * would fetch whatever a client asked for, from the server's network, with
     * the server's credentials.
     */
    const h = harness();
    await expect(
      invoke(route(h, "POST", "/acquisitions"), {
        body: { ...VALID_BODY, indexerId: "somewhere-else" },
      }),
    ).rejects.toThrow(/not configured/);
    expect(h.created).toHaveLength(0);
  });

  it.each([
    ["no title", { ...VALID_BODY, title: "   " }],
    ["no indexer", { ...VALID_BODY, indexerId: undefined }],
    ["no release", { ...VALID_BODY, releaseGuid: undefined }],
    ["an unknown kind", { ...VALID_BODY, kind: "boxset" }],
    ["an unknown field", { ...VALID_BODY, downloadUrl: DOWNLOAD_URL }],
    ["a season with no number", { ...VALID_BODY, kind: "season" }],
  ])("refuses a request with %s", async (_name, body) => {
    const h = harness();
    await expect(
      invoke(route(h, "POST", "/acquisitions"), { body }),
    ).rejects.toThrow();
    expect(h.created).toHaveLength(0);
  });

  it("accepts a television acquisition that names its season", async () => {
    const h = harness();
    const { status } = await invoke(route(h, "POST", "/acquisitions"), {
      body: { ...VALID_BODY, kind: "season", season: 2 },
    });
    expect(status).toBe(202);
    expect(h.created[0]!.target).toMatchObject({ kind: "season", season: 2 });
  });
});

describe("cancelling", () => {
  it("cancels through the service, which owns what may be removed", async () => {
    const h = harness();
    const { status } = await invoke(
      route(h, "POST", "/acquisitions/:acquisitionId/cancel"),
      { params: { acquisitionId: summary().id } },
    );
    expect(status).toBe(204);
    expect(h.service.cancel).toHaveBeenCalledWith(summary().id);
  });

  it("reports a refusal to cancel as a conflict, not a server fault", async () => {
    const h = harness([summary({ state: "downloaded" })], {
      service: {
        cancel: vi.fn(async () => {
          throw new Error("A finished download cannot be cancelled.");
        }),
      },
    });
    await expect(
      invoke(route(h, "POST", "/acquisitions/:acquisitionId/cancel"), {
        params: { acquisitionId: summary().id },
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("does not reach the client for an acquisition it has never heard of", async () => {
    const h = harness([]);
    await expect(
      invoke(route(h, "POST", "/acquisitions/:acquisitionId/cancel"), {
        params: { acquisitionId: summary().id },
      }),
    ).rejects.toBeInstanceOf(OwnApiError);
    expect(h.service.cancel).not.toHaveBeenCalled();
  });
});

describe("retrying by hand", () => {
  it("moves a failed acquisition back into the queue", async () => {
    const h = harness([summary({ state: "failed" })]);
    const { status, payload } = await invoke(
      route(h, "POST", "/acquisitions/:acquisitionId/retry"),
      { params: { acquisitionId: summary().id } },
    );
    expect(status).toBe(202);
    expect(payload?.data).toMatchObject({ taskId: "job-1", status: "queued" });
    expect(h.updates[0]).toMatchObject({
      from: "failed",
      patch: { state: "awaiting_retry", retryAfterMs: null },
    });
    expect(h.enqueued[0]).toMatchObject({
      jobType: ACQUISITION_JOB_TYPES.submit,
    });
  });

  it("clears the retry delay, because a person asked for it now", async () => {
    const h = harness([summary({ state: "failed" })]);
    await invoke(route(h, "POST", "/acquisitions/:acquisitionId/retry"), {
      params: { acquisitionId: summary().id },
    });
    expect(h.updates[0]!.patch.retryAfterMs).toBeNull();
  });

  it.each(["queued", "downloading", "downloaded", "cancelled"] as const)(
    "refuses to retry an acquisition that is %s",
    async (state) => {
      const h = harness([summary({ state })]);
      await expect(
        invoke(route(h, "POST", "/acquisitions/:acquisitionId/retry"), {
          params: { acquisitionId: summary().id },
        }),
      ).rejects.toMatchObject({ statusCode: 409 });
      expect(h.enqueued).toHaveLength(0);
    },
  );
});

describe("blocklisting, and searching again", () => {
  const path = "/acquisitions/:acquisitionId/blocklist";
  const failed = () =>
    summary({
      state: "failed",
      failureClass: "missing-articles",
      releaseGuid: "broken-guid",
      releaseTitle: "Big.Buck.Bunny.2008.1080p.BluRay.x265-BAD",
    });

  it("blocklists the release and stops the download", async () => {
    const h = harness([failed()]);
    const { status, payload } = await invoke(route(h, "POST", path), {
      params: { acquisitionId: summary().id },
      body: {},
    });
    expect(status).toBe(200);
    expect(payload?.data).toEqual({ searched: false, replacement: null });
    expect(h.blocklisted[0]).toMatchObject({
      indexerId: "nzbgeek",
      releaseGuid: "broken-guid",
      reason: "missing-articles",
    });
    expect(h.service.blocklist).toHaveBeenCalledWith(summary().id);
    expect(h.search.search).not.toHaveBeenCalled();
  });

  it("searches again and hands the next best release over", async () => {
    const h = harness([failed()], {
      releases: [
        found("Big.Buck.Bunny.2008.1080p.BluRay.x265-BAD", "broken-guid"),
        found("Big.Buck.Bunny.2008.1080p.WEB-DL.x265-GOOD", "good-guid"),
      ],
    });
    const { status, payload } = await invoke(route(h, "POST", path), {
      params: { acquisitionId: summary().id },
      body: { searchAgain: true },
    });
    expect(status).toBe(202);
    expect(payload?.data).toMatchObject({ searched: true, taskId: "job-1" });
    expect(h.updates).toContainEqual(
      expect.objectContaining({
        from: "failed",
        patch: { state: "superseded" },
      }),
    );
    expect(h.created[0]).toMatchObject({
      releaseGuid: "good-guid",
      origin: "fallback",
      target: { kind: "movie", title: "Big Buck Bunny", year: 2008 },
      evidence: { profileId: "p1" },
    });
    expect(h.created[0]!.evidence.rejected).toContainEqual({
      title: "Big.Buck.Bunny.2008.1080p.BluRay.x265-BAD",
      reason: "blocklisted",
    });
    expect(h.enqueued[0]).toMatchObject({
      jobType: ACQUISITION_JOB_TYPES.submit,
    });
    // The credential-bearing URL never reaches the reply.
    expect(JSON.stringify(payload)).not.toContain(SECRET);
  });

  it("leaves it failed when nothing else is acceptable", async () => {
    const h = harness([failed()], {
      releases: [
        found("Big.Buck.Bunny.2008.1080p.BluRay.x265-BAD", "broken-guid"),
      ],
    });
    const { payload } = await invoke(route(h, "POST", path), {
      params: { acquisitionId: summary().id },
      body: { searchAgain: true },
    });
    expect(payload?.data).toEqual({ searched: true, replacement: null });
    expect(h.created).toHaveLength(0);
    expect(h.updates.at(-1)).toMatchObject({
      from: "failed",
      patch: { failureClass: "blocklisted" },
    });
    expect(h.updates.at(-1)!.patch.state).toBeUndefined();
  });

  it("keeps the blocklisting when the search itself fails", async () => {
    const h = harness([failed()], { searchFails: true });
    await expect(
      invoke(route(h, "POST", path), {
        params: { acquisitionId: summary().id },
        body: { searchAgain: true },
      }),
    ).rejects.toMatchObject({ statusCode: 503 });
    expect(h.blocklisted).toHaveLength(1);
    expect(h.created).toHaveLength(0);
  });

  it("does not search without a recorded profile", async () => {
    const h = harness([failed()], { profileId: null });
    const { payload } = await invoke(route(h, "POST", path), {
      params: { acquisitionId: summary().id },
      body: { searchAgain: true },
    });
    expect(payload?.data).toMatchObject({ reason: "no-profile" });
    expect(h.search.search).not.toHaveBeenCalled();
  });

  it("creates nothing when another request already replaced it", async () => {
    // Losing the supersede means somebody else's search already won.
    const h = harness([failed()], {
      releases: [found("Big.Buck.Bunny.2008.1080p.WEB-DL-GOOD", "good")],
      updateSucceeds: (patch) => patch.state !== "superseded",
    });
    await expect(
      invoke(route(h, "POST", path), {
        params: { acquisitionId: summary().id },
        body: { searchAgain: true },
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(h.created).toHaveLength(0);
    expect(h.enqueued).toHaveLength(0);
  });

  it.each([
    "downloaded",
    "cancelled",
    "superseded",
    "resolving",
    "submitting",
  ] as const)(
    "refuses to blocklist an acquisition that is %s",
    async (state) => {
      const h = harness([summary({ state })]);
      await expect(
        invoke(route(h, "POST", path), {
          params: { acquisitionId: summary().id },
          body: {},
        }),
      ).rejects.toMatchObject({ statusCode: 409 });
      expect(h.service.blocklist).not.toHaveBeenCalled();
    },
  );

  it("refuses to retry a blocklisted release", async () => {
    const h = harness([
      summary({ state: "failed", failureClass: "blocklisted" }),
    ]);
    await expect(
      invoke(route(h, "POST", "/acquisitions/:acquisitionId/retry"), {
        params: { acquisitionId: summary().id },
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(h.enqueued).toHaveLength(0);
  });
});

describe("the handoff to import", () => {
  it("lists only what has finished downloading", async () => {
    const h = harness([
      summary({ state: "downloading" }),
      summary({
        id: "22222222-2222-4222-8222-222222222222",
        state: "downloaded",
        downloadPath: "C:/SeyirlikDownloads/complete/seyirlik/Big Buck Bunny",
      }),
    ]);
    const { payload } = await invoke(
      route(h, "GET", "/acquisitions/ready-for-import"),
    );
    const ready = payload?.data?.ready as Array<Record<string, unknown>>;
    expect(ready).toHaveLength(1);
    expect(ready[0]).toMatchObject({
      state: "downloaded",
      downloadPath: "C:/SeyirlikDownloads/complete/seyirlik/Big Buck Bunny",
    });
  });
});

describe("whether the download client is reachable", () => {
  it("reports the version when it answers", async () => {
    const h = harness();
    const { status, payload } = await invoke(
      route(h, "GET", "/acquisitions/client/status"),
    );
    expect(status).toBe(200);
    expect(payload?.data).toEqual({ reachable: true, version: "4.3.3" });
  });

  it("reports an unreachable client as a fact, not as a failed request", async () => {
    /*
     * A media server whose downloader is down still serves everything it has.
     * Answering 5xx here would make an operational detail look like an outage.
     */
    const h = harness([], {
      sab: {
        version: vi.fn(async () => {
          throw new SabError("unavailable", "connect ECONNREFUSED");
        }),
      },
    });
    const { status, payload } = await invoke(
      route(h, "GET", "/acquisitions/client/status"),
    );
    expect(status).toBe(200);
    expect(payload?.data).toMatchObject({
      reachable: false,
      reason: "unavailable",
    });
  });

  it("names an authentication failure as one", async () => {
    const h = harness([], {
      sab: {
        version: vi.fn(async () => {
          throw new SabError("auth", "API Key Incorrect");
        }),
      },
    });
    const { payload } = await invoke(
      route(h, "GET", "/acquisitions/client/status"),
    );
    expect(payload?.data).toMatchObject({ reachable: false, reason: "auth" });
  });
});

describe("live progress", () => {
  const path = "/acquisitions/progress";
  const downloading = summary({
    state: "downloading",
    externalId: "nzo-1",
  });
  const waiting = summary({
    id: "22222222-2222-4222-8222-222222222222",
    state: "queued",
    externalId: undefined,
    idempotencyKey: "seyirlik-22222222-2222-4222-8222-222222222222",
  });
  const unpacking = summary({
    id: "33333333-3333-4333-8333-333333333333",
    state: "processing",
    externalId: "nzo-3",
  });
  const GB = 1_000_000_000;

  function live(paused = false) {
    return {
      queueSnapshot: vi.fn(async () => ({
        paused,
        speedBytesPerSecond: 31_000_000,
        jobs: [
          {
            nzoId: "nzo-1",
            name: downloading.idempotencyKey,
            state: "downloading" as const,
            statusText: "Downloading",
            sizeBytes: 25 * GB,
            remainingBytes: 13 * GB,
            timeLeftSeconds: 425,
            queuePosition: 0,
            source: "queue" as const,
          },
          {
            nzoId: "nzo-2",
            name: waiting.idempotencyKey,
            state: "queued" as const,
            statusText: "Queued",
            sizeBytes: 8 * GB,
            remainingBytes: 8 * GB,
            queuePosition: 1,
            source: "queue" as const,
          },
        ],
      })),
      listHistory: vi.fn(
        async (): Promise<SabJob[]> => [
          {
            nzoId: "nzo-3",
            name: unpacking.idempotencyKey,
            state: "processing" as const,
            statusText: "Extracting",
            actionLine: "Unpacking: 3/7",
            sizeBytes: 20 * GB,
            source: "history" as const,
          },
        ],
      ),
    };
  }

  it("says how far each download has got, and how fast", async () => {
    const h = harness([downloading, waiting, unpacking], { sab: live() });
    const { payload } = await invoke(route(h, "GET", path));
    expect(payload?.data).toMatchObject({
      reachable: true,
      paused: false,
      speedBytesPerSecond: 31_000_000,
    });
    const progress = payload?.data?.progress as Array<Record<string, unknown>>;
    expect(progress).toEqual([
      {
        acquisitionId: downloading.id,
        stage: "downloading",
        statusText: "Downloading",
        percent: 48,
        totalBytes: 25 * GB,
        downloadedBytes: 12 * GB,
        speedBytesPerSecond: 31_000_000,
        etaSeconds: 425,
        queuePosition: 1,
      },
      {
        // Found by name, before its identifier was known.
        acquisitionId: waiting.id,
        stage: "queued",
        statusText: "Queued",
        percent: 0,
        totalBytes: 8 * GB,
        downloadedBytes: 0,
        queuePosition: 2,
      },
      {
        acquisitionId: unpacking.id,
        stage: "processing",
        statusText: "Extracting",
        totalBytes: 20 * GB,
        detail: "Unpacking: 3/7",
      },
    ]);
  });

  it("gives no speed or estimate while the queue is paused", async () => {
    const h = harness([downloading], { sab: live(true) });
    const { payload } = await invoke(route(h, "GET", path));
    expect(payload?.data).toMatchObject({ paused: true });
    expect(payload?.data?.speedBytesPerSecond).toBeUndefined();
    const [entry] = payload?.data?.progress as Array<Record<string, unknown>>;
    expect(entry!.speedBytesPerSecond).toBeUndefined();
    expect(entry!.etaSeconds).toBeUndefined();
    expect(entry!.stage).toBe("paused");
  });

  it("reports a failed zero-byte history job as failed, never successfully done", async () => {
    const sab = live();
    sab.listHistory.mockResolvedValue([
      {
        nzoId: "nzo-1",
        name: downloading.idempotencyKey,
        state: "failed",
        statusText: "Failed",
        sizeBytes: 0,
        source: "history",
      },
    ]);
    sab.queueSnapshot.mockResolvedValue({
      paused: false,
      speedBytesPerSecond: 0,
      jobs: [],
    });
    const h = harness([downloading], { sab });
    const { payload } = await invoke(route(h, "GET", path));
    expect(payload?.data?.progress).toEqual([
      {
        acquisitionId: downloading.id,
        stage: "failed",
        statusText: "Failed",
        totalBytes: 0,
      },
    ]);
  });

  it("reports queued downloads as paused without pausing history post-processing", async () => {
    const h = harness([waiting, unpacking], { sab: live(true) });
    const { payload } = await invoke(route(h, "GET", path));
    const entries = payload?.data?.progress as Array<Record<string, unknown>>;
    expect(entries[0]).toMatchObject({
      acquisitionId: waiting.id,
      stage: "paused",
      downloadedBytes: 0,
    });
    expect(entries[1]).toMatchObject({
      acquisitionId: unpacking.id,
      stage: "processing",
      detail: "Unpacking: 3/7",
    });
  });

  it("reports an unreachable SABnzbd as a fact, not an error", async () => {
    const h = harness([downloading], {
      sab: {
        queueSnapshot: vi.fn(async () => {
          throw new SabError("unavailable", "down");
        }),
        listHistory: vi.fn(async () => []),
      },
    });
    const { status, payload } = await invoke(route(h, "GET", path));
    expect(status).toBe(200);
    expect(payload?.data).toEqual({
      reachable: false,
      paused: false,
      progress: [],
    });
  });

  it("does not ask SABnzbd when nothing is running", async () => {
    const sab = live();
    const h = harness([summary({ state: "failed" })], { sab });
    await invoke(route(h, "GET", path));
    expect(sab.queueSnapshot).not.toHaveBeenCalled();
  });
});

describe("one blocklisting covers every row with that release", () => {
  const entry: AddBlocklistEntry = {
    indexerId: "nzbgeek",
    releaseGuid: "broken-guid",
    releaseTitle: "Big.Buck.Bunny.2008.1080p.BluRay.x265-BAD",
  };
  const another = () =>
    summary({
      state: "failed",
      failureClass: "missing-articles",
      releaseGuid: "broken-guid",
      releaseTitle: "Big.Buck.Bunny.2008.1080p.BluRay.x265-BAD",
    });

  it("marks the release as blocklisted in the list", async () => {
    const h = harness([another()], { preBlocklisted: [entry] });
    const { payload } = await invoke(route(h, "GET", "/acquisitions"));
    const [row] = payload?.data?.acquisitions as Array<Record<string, unknown>>;
    expect(row!.releaseBlocklisted).toBe(true);
  });

  it("refuses to retry it from a row that did not blocklist it", async () => {
    const h = harness([another()], { preBlocklisted: [entry] });
    await expect(
      invoke(route(h, "POST", "/acquisitions/:acquisitionId/retry"), {
        params: { acquisitionId: summary().id },
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe("a newer download retires older failures", () => {
  it("supersedes failures for the same title when one is asked for", async () => {
    const h = harness();
    await invoke(route(h, "POST", "/acquisitions"), { body: VALID_BODY });
    expect(h.repository.supersedeFailedFor).toHaveBeenCalledTimes(1);
  });
});

describe("steering the download queue", () => {
  const id = "11111111-1111-4111-8111-111111111111";

  it("holds and releases one download through the service", async () => {
    const h = harness();
    const paused = await invoke(
      route(h, "POST", "/acquisitions/:acquisitionId/pause"),
      {
        params: { acquisitionId: id },
      },
    );
    const resumed = await invoke(
      route(h, "POST", "/acquisitions/:acquisitionId/resume"),
      {
        params: { acquisitionId: id },
      },
    );
    expect([paused.status, resumed.status]).toEqual([204, 204]);
    expect(h.service.setPaused).toHaveBeenNthCalledWith(1, id, true);
    expect(h.service.setPaused).toHaveBeenNthCalledWith(2, id, false);
  });

  it("moves a download to a place counted from 1", async () => {
    const h = harness([summary()], {
      service: { move: vi.fn(async (_id: string, index: number) => index) },
    });
    const { status, payload } = await invoke(
      route(h, "POST", "/acquisitions/:acquisitionId/move"),
      { params: { acquisitionId: id }, body: { position: 3 } },
    );
    expect(status).toBe(200);
    expect(h.service.move).toHaveBeenCalledWith(id, 2);
    expect(payload?.data).toEqual({ position: 3 });
  });

  it("refuses a move without a place", async () => {
    const h = harness();
    await expect(
      invoke(route(h, "POST", "/acquisitions/:acquisitionId/move"), {
        params: { acquisitionId: id },
        body: { position: 0 },
      }),
    ).rejects.toMatchObject({ statusCode: 422 });
  });

  it("says when the download is no longer in the queue", async () => {
    const h = harness([summary()], {
      service: {
        setPaused: vi.fn(async () => {
          throw new AcquisitionControlError("not-in-queue", "Not queued.");
        }),
      },
    });
    await expect(
      invoke(route(h, "POST", "/acquisitions/:acquisitionId/pause"), {
        params: { acquisitionId: id },
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("reports an unreachable client without its message", async () => {
    const h = harness([summary()], {
      sab: {
        pauseQueue: vi.fn(async () => {
          throw new SabError("unavailable", "http://host/api?apikey=secret");
        }),
      },
    });
    const error = await invoke(
      route(h, "POST", "/acquisitions/client/pause"),
    ).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ statusCode: 503 });
    expect(String((error as Error).message)).not.toContain("secret");
  });

  it("pauses and resumes the whole client", async () => {
    const pauseQueue = vi.fn(async () => undefined);
    const resumeQueue = vi.fn(async () => undefined);
    const h = harness([summary()], { sab: { pauseQueue, resumeQueue } });
    await invoke(route(h, "POST", "/acquisitions/client/pause"));
    await invoke(route(h, "POST", "/acquisitions/client/resume"));
    expect(pauseQueue).toHaveBeenCalledOnce();
    expect(resumeQueue).toHaveBeenCalledOnce();
  });
});

describe("searching for missing episodes", () => {
  const SERIES = "22222222-2222-4222-8222-222222222222";
  const TASK = "33333333-3333-4333-8333-333333333333";
  const plan: MissingEpisodePlan = {
    seriesItemId: SERIES,
    title: "The Sopranos",
    year: 1999,
    seasons: [
      {
        season: 6,
        whole: false,
        episodes: [
          { episode: 2, itemId: SERIES },
          { episode: 3, itemId: SERIES },
        ],
      },
    ],
  };

  it("is not offered without a way to read what is missing", () => {
    expect(() => route(harness(), "POST", "/acquisitions/missing")).toThrow();
  });

  it("queues one search for the missing episodes, under the series' profile", async () => {
    const missingEpisodes = vi.fn(async () => plan);
    const h = harness([], {
      missingEpisodes,
      profileOf: async () => "p1",
      profiles: [{ id: "p0", name: "Any" }],
    });
    const answer = await invoke(route(h, "POST", "/acquisitions/missing"), {
      body: { itemId: SERIES, season: 6 },
    });
    expect(missingEpisodes).toHaveBeenCalledWith(SERIES, 6);
    expect(answer.payload?.data).toEqual({ taskId: "job-1", episodes: 2 });
    expect(h.enqueued).toEqual([
      {
        jobType: MISSING_SEARCH_JOB_TYPE,
        payload: { plan, profileId: "p1" },
        dedupeKey: `${MISSING_SEARCH_JOB_TYPE}:${SERIES}:6`,
      },
    ]);
  });

  it("falls back to the profile a search by hand starts on", async () => {
    const h = harness([], {
      missingEpisodes: async () => plan,
      profiles: [{ id: "p0", name: "Any" }],
    });
    await invoke(route(h, "POST", "/acquisitions/missing"), {
      body: { itemId: SERIES },
    });
    expect(h.enqueued[0]).toMatchObject({
      payload: { profileId: "p0" },
      dedupeKey: `${MISSING_SEARCH_JOB_TYPE}:${SERIES}:all`,
    });
  });

  it("queues nothing when nothing is missing", async () => {
    const h = harness([], {
      missingEpisodes: async () => ({ ...plan, seasons: [] }),
    });
    const answer = await invoke(route(h, "POST", "/acquisitions/missing"), {
      body: { itemId: SERIES },
    });
    expect(answer.payload?.data).toEqual({ taskId: null, episodes: 0 });
    expect(h.enqueued).toHaveLength(0);
  });

  it("refuses a title that is not a series", async () => {
    const h = harness([], { missingEpisodes: async () => null });
    await expect(
      invoke(route(h, "POST", "/acquisitions/missing"), {
        body: { itemId: SERIES },
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("reports what a finished search started and found nothing for", async () => {
    const h = harness([], {
      missingEpisodes: async () => plan,
      jobs: {
        [TASK]: {
          id: TASK,
          jobType: MISSING_SEARCH_JOB_TYPE,
          status: "succeeded",
          result: {
            started: 1,
            nothingAcceptable: 1,
            startedReleases: [
              { season: 6, episode: 2, release: "Sopranos.S06E02.1080p" },
            ],
            nothingFor: [{ season: 6, episode: 3 }],
            coveredBy: [{ season: 5, episode: null }],
          },
        },
      },
    });
    const answer = await invoke(
      route(h, "GET", "/acquisitions/missing/:taskId"),
      { params: { taskId: TASK } },
    );
    expect(answer.payload?.data).toEqual({
      taskId: TASK,
      status: "succeeded",
      message: null,
      result: {
        started: [{ season: 6, episode: 2, release: "Sopranos.S06E02.1080p" }],
        nothing: [{ season: 6, episode: 3 }],
        covered: [{ season: 5, episode: null }],
      },
    });
  });

  it("does not read another kind of task through this route", async () => {
    const h = harness([], {
      missingEpisodes: async () => plan,
      jobs: { [TASK]: { id: TASK, jobType: "library.scan" } },
    });
    await expect(
      invoke(route(h, "GET", "/acquisitions/missing/:taskId"), {
        params: { taskId: TASK },
      }),
    ).rejects.toBeInstanceOf(OwnApiError);
  });
});
