/**
 * Television, end to end through the routes.
 *
 * The claim being tested is not that shows appear on a page. It is that they
 * appear *through the same machinery films do*: one job per episode, created
 * by the one path that creates every job, refused by the same duplicate rules,
 * and carrying the same queue payload — with the one addition an episode needs,
 * which is where its package goes.
 */

import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import type { RouteContext, RoutePrincipal } from "../api/router";
import { OwnApiError } from "../ownApiHandler";
import { ADAPTIVE_PROFILE_VERSION } from "../../../renditions/adaptive/profile";
import type {
  CatalogueRepository,
  ListProcessableTitlesOptions,
  MediaFileRow,
  ProcessableTitleRow,
} from "../catalogue/catalogueRepository";
import type { JobQueue } from "../tasks/jobQueue";
import {
  DuplicateProcessingJobError,
  type ProcessingJobRecord,
  type ProcessingJobStore,
} from "./jobStore";
import * as processingDecision from "../../../renditions/processing/decide";
import { createProcessingRoutes } from "./processingRoutes";

vi.mock("../../../renditions/probe", () => ({
  probeMediaFile: vi.fn(async () => ({
    /*
     * Short on purpose. The disk preflight in `decideProcessing` is real here,
     * and a real fifty-minute ladder needs tens of gigabytes free on whatever
     * volume the temporary directory happens to live on.
     */
    durationSeconds: 30,
    video: {
      width: 1920,
      height: 1080,
      rotation: 0,
      codec: "h264",
      isHdr: false,
    },
    audioTracks: [],
    subtitleTracks: [],
    chapters: [],
  })),
  isHdrTransfer: () => false,
  isTextSubtitleCodec: () => true,
}));
vi.mock("../../../renditions/hardware/detect", () => ({
  detectHardware: vi.fn(async () => ({
    platform: "test",
    probedAt: new Date().toISOString(),
    adapters: [],
    selected: { h264: "h264_test", hevc: "hevc_test", hevcTenBit: "hevc_test" },
    selectedAdapter: { h264: "test", hevc: "test", hevcTenBit: "test" },
  })),
}));
vi.mock("../../../renditions/registry", () => ({
  computeSourceFingerprint: vi.fn(async (filePath: string) => `fp:${filePath}`),
}));

const SERIES_ID = "aaaaaaaa-1111-4111-8111-111111111111";
const SEASON_1 = "aaaaaaaa-2222-4111-8111-111111111111";
const SEASON_2 = "aaaaaaaa-3333-4111-8111-111111111111";
const MOVIE_ID = "bbbbbbbb-1111-4111-8111-111111111111";

function uuid(seed: number): string {
  const hex = seed.toString(16).padStart(12, "0");
  return `cccccccc-0000-4000-8000-${hex}`;
}

interface EpisodeSpec {
  seasonId: string;
  seasonNumber: number;
  number: number;
  title: string;
  /** Extra containers of the same episode, which must never become episodes. */
  alternates?: number;
  missing?: boolean;
}

interface Library {
  root: string;
  rows: ProcessableTitleRow[];
  filesByItem: Map<string, MediaFileRow[]>;
  kindByItem: Map<string, string>;
}

let counter = 0;

async function buildLibrary(
  episodes: EpisodeSpec[],
  options: { withMovie?: boolean } = {},
): Promise<Library> {
  const root = await mkdtemp(path.join(tmpdir(), "seyirlik-tv-"));
  const rows: ProcessableTitleRow[] = [];
  const filesByItem = new Map<string, MediaFileRow[]>();
  const kindByItem = new Map<string, string>();

  async function writeSource(relativePath: string): Promise<void> {
    const absolute = path.join(root, ...relativePath.split("/"));
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, "pretend source");
  }

  function file(
    itemId: string,
    relativePath: string,
    overrides: Partial<MediaFileRow> = {},
  ): MediaFileRow {
    counter += 1;
    return {
      id: uuid(counter),
      itemId,
      relativePath,
      container: path.extname(relativePath).replace(".", ""),
      sizeBytes: "1000",
      mtimeMs: "1",
      fingerprint: `fp:${path.join(root, ...relativePath.split("/"))}`,
      durationMs: "3000000",
      bitrateBps: "1000",
      isPrimary: true,
      probeState: "probed",
      missingSince: null,
      ...overrides,
    };
  }

  if (options.withMovie !== false) {
    const relativePath = "Movies/Dune (2021)/Dune (2021).mp4";
    await writeSource(relativePath);
    const primary = file(MOVIE_ID, relativePath);
    filesByItem.set(MOVIE_ID, [primary]);
    kindByItem.set(MOVIE_ID, "movie");
    rows.push(baseRow(MOVIE_ID, "Dune", primary, { kind: "movie" }));
  }

  for (const spec of episodes) {
    counter += 1;
    const itemId = uuid(1000 + counter);
    const code = `S${String(spec.seasonNumber).padStart(2, "0")}E${String(
      spec.number,
    ).padStart(2, "0")}`;
    const stem = `Series/Show/Season ${spec.seasonNumber}/Show - ${code} - ${spec.title}`;
    const primary = file(itemId, `${stem}.mp4`, {
      ...(spec.missing ? { missingSince: new Date() } : {}),
    });
    if (!spec.missing) await writeSource(`${stem}.mp4`);

    const alternates: MediaFileRow[] = [];
    for (let index = 0; index < (spec.alternates ?? 0); index += 1) {
      const alternate = file(itemId, `${stem}.mkv`, { isPrimary: false });
      await writeSource(`${stem}.mkv`);
      alternates.push(alternate);
    }
    /*
     * Primary first, largest first — the order the repository returns and the
     * order that decides which file a job reads.
     */
    filesByItem.set(itemId, [primary, ...alternates]);
    kindByItem.set(itemId, "episode");

    rows.push({
      ...baseRow(itemId, spec.title, primary, { kind: "episode" }),
      indexNumber: spec.number,
      seriesId: SERIES_ID,
      seriesTitle: "Show",
      seriesSortTitle: "show",
      seriesYear: 2022,
      seasonId: spec.seasonId,
      seasonTitle: `Season ${spec.seasonNumber}`,
      seasonNumber: spec.seasonNumber,
      fileCount: 1 + (spec.alternates ?? 0),
      ...(spec.missing ? { fileMissingSince: primary.missingSince } : {}),
    });
  }

  return { root, rows, filesByItem, kindByItem };
}

function baseRow(
  itemId: string,
  title: string,
  file: MediaFileRow,
  overrides: Partial<ProcessableTitleRow>,
): ProcessableTitleRow {
  return {
    itemId,
    libraryId: "library",
    kind: "movie",
    title,
    sortTitle: title.toLowerCase(),
    productionYear: null,
    runtimeMs: "3000000",
    indexNumber: null,
    itemMissingSince: null,
    seriesId: null,
    seriesTitle: null,
    seriesSortTitle: null,
    seriesYear: null,
    seasonId: null,
    seasonTitle: null,
    seasonNumber: null,
    mediaFileId: file.id,
    relativePath: file.relativePath,
    container: file.container,
    sizeBytes: file.sizeBytes,
    mtimeMs: file.mtimeMs,
    fingerprint: file.fingerprint,
    durationMs: file.durationMs,
    bitrateBps: file.bitrateBps,
    probeState: "probed",
    fileMissingSince: null,
    fileCount: 1,
    videoCodec: "h264",
    videoProfile: "High",
    width: 1920,
    height: 1080,
    frameRate: 24,
    pixelFormat: "yuv420p",
    bitDepth: 8,
    videoRange: "SDR",
    colorTransfer: "bt709",
    colorPrimaries: "bt709",
    colorSpace: "bt709",
    audioTrackCount: 1,
    subtitleTrackCount: 0,
    externalSubtitleCount: 0,
    ...overrides,
  };
}

/** A store with the real duplicate rule: one unfinished job per media file. */
function createStore(seed: ProcessingJobRecord[] = []) {
  const jobs = new Map<string, ProcessingJobRecord>();
  for (const job of seed) jobs.set(job.id, job);
  const ACTIVE = new Set(["pending", "queued", "running", "paused"]);
  let next = 0;

  const store = {
    created: [] as Array<{ itemId: string; mediaFileId: string }>,
    jobs,
    async create(input: { itemId: string; mediaFileId: string }) {
      for (const job of jobs.values()) {
        if (job.mediaFileId === input.mediaFileId && ACTIVE.has(job.state)) {
          throw new DuplicateProcessingJobError("already active");
        }
      }
      next += 1;
      const job = {
        ...input,
        id: `job-${next}`,
        state: "pending",
        createdAt: new Date(),
        updatedAt: new Date(),
      } as unknown as ProcessingJobRecord;
      jobs.set(job.id, job);
      store.created.push({
        itemId: input.itemId,
        mediaFileId: input.mediaFileId,
      });
      return job;
    },
    async get(id: string) {
      return jobs.get(id) ?? null;
    },
    async attachQueueJob() {},
    async appendEvent() {},
    async listActive() {
      return [...jobs.values()].filter((job) => ACTIVE.has(job.state));
    },
    async findActiveForFile(mediaFileId: string) {
      return (
        [...jobs.values()].find(
          (job) => job.mediaFileId === mediaFileId && ACTIVE.has(job.state),
        ) ?? null
      );
    },
    async counts() {
      return {} as never;
    },
    async list() {
      return [...jobs.values()];
    },
    async reconcileTerminalQueueJobs() {
      return 0;
    },
    reordered: [] as string[][],
    async nextQueuePriority() {
      return 100;
    },
    async reorderQueue(orderedIds: readonly string[]) {
      store.reordered.push([...orderedIds]);
      // The real store moves only what is still waiting; so does this.
      return orderedIds.filter((id) => {
        const job = jobs.get(id);
        return job ? ["pending", "queued"].includes(job.state) : false;
      });
    },
  };
  return store as typeof store & ProcessingJobStore;
}

function createQueue() {
  const enqueued: Array<{
    jobType: string;
    dedupeKey: string;
    payload: Record<string, unknown>;
  }> = [];
  const queue = {
    async enqueue(input: {
      jobType: string;
      dedupeKey: string;
      payload: Record<string, unknown>;
    }) {
      enqueued.push(input);
      return `queue-${enqueued.length}`;
    },
    enqueued,
  };
  return queue as typeof queue & JobQueue;
}

function createCatalogue(library: Library): CatalogueRepository {
  return {
    listProcessableTitles: async (
      options: ListProcessableTitlesOptions = {},
    ) => {
      const kinds = options.kinds ?? ["movie", "episode"];
      return library.rows.filter(
        (row) =>
          kinds.includes(row.kind) &&
          (options.seriesId === undefined ||
            row.seriesId === options.seriesId) &&
          (options.seasonId === undefined || row.seasonId === options.seasonId),
      );
    },
    listStreamsForFiles: async () => new Map(),
    listFilesForItem: async (itemId: string) =>
      library.filesByItem.get(itemId) ?? [],
    getItemKind: async (itemId: string) =>
      (library.kindByItem.get(itemId) ?? null) as never,
  } as unknown as CatalogueRepository;
}

async function call(
  routes: ReturnType<typeof createProcessingRoutes>,
  method: string,
  routePath: string,
  options: { params?: Record<string, string>; body?: unknown } = {},
) {
  const route = routes.find(
    (candidate) => candidate.path === routePath && candidate.method === method,
  );
  expect(route, `${method} ${routePath}`).toBeDefined();

  const sent = { statusCode: 200, body: "" };
  const response = {
    get statusCode() {
      return sent.statusCode;
    },
    set statusCode(value: number) {
      sent.statusCode = value;
    },
    setHeader() {},
    end(chunk?: string) {
      sent.body = chunk ?? "";
    },
  } as unknown as ServerResponse;

  const principal: RoutePrincipal = {
    userId: SERIES_ID,
    username: "admin",
    displayName: "Admin",
    isAdministrator: true,
    sessionId: SEASON_1,
    sessionTokenHash: Buffer.alloc(32),
  };
  const context: RouteContext = {
    request: {} as IncomingMessage,
    response,
    requestId: "req",
    url: new URL(`https://seyirlik.test${routePath}`),
    params: options.params ?? {},
    method,
    principal,
    requirePrincipal: () => principal,
    readJson: async () => options.body ?? {},
  };

  let error: OwnApiError | undefined;
  try {
    await route!.handle(context);
  } catch (thrown) {
    error = thrown as OwnApiError;
  }
  return {
    error,
    statusCode: sent.statusCode,
    data: sent.body ? (JSON.parse(sent.body) as { data: unknown }).data : null,
  };
}

function build(
  library: Library,
  seed: ProcessingJobRecord[] = [],
  workRoot = library.root,
  processingElsewhere = false,
) {
  const store = createStore(seed);
  const queue = createQueue();
  const routes = createProcessingRoutes({
    catalogue: createCatalogue(library),
    store,
    queue,
    mediaRoot: library.root,
    workRoot,
    processingElsewhere,
  });
  return { routes, store, queue };
}

const SEASON_ONE: EpisodeSpec[] = [
  { seasonId: SEASON_1, seasonNumber: 1, number: 1, title: "Kassa" },
  { seasonId: SEASON_1, seasonNumber: 1, number: 2, title: "That Would Be Me" },
  { seasonId: SEASON_1, seasonNumber: 1, number: 10, title: "Announcement" },
];

// ---------------------------------------------------------------- overview

describe("GET /processing/overview", () => {
  it("still returns everything it always returned", async () => {
    const library = await buildLibrary(SEASON_ONE);
    const { routes } = build(library);
    const result = await call(routes, "GET", "/processing/overview");

    const data = result.data as Record<string, unknown>;
    expect(result.error).toBeUndefined();
    expect(data).toHaveProperty("counts");
    expect(data).toHaveProperty("hardware");
    expect(data).toHaveProperty("jobs");
    expect(data).toHaveProperty("stages");
    expect(data).toHaveProperty("storage");
    expect(data.profile).toBe(ADAPTIVE_PROFILE_VERSION);
  });

  it("returns films and shows in one coherent model", async () => {
    const library = await buildLibrary([
      ...SEASON_ONE,
      {
        seasonId: SEASON_2,
        seasonNumber: 2,
        number: 1,
        title: "One Year Later",
      },
    ]);
    const { routes } = build(library);
    const data = (await call(routes, "GET", "/processing/overview"))
      .data as Record<string, unknown>;

    const movies = data.movies as Array<{ title: string }>;
    const series = data.series as Array<{
      title: string;
      seasonCount: number;
      episodeCount: number;
      seasons: Array<{
        seasonNumber: number;
        episodes: Array<{ code: string; title: string }>;
      }>;
    }>;

    expect(movies.map((movie) => movie.title)).toEqual(["Dune"]);
    expect(series).toHaveLength(1);
    expect(series[0]!.seasonCount).toBe(2);
    expect(series[0]!.episodeCount).toBe(4);
    expect(series[0]!.seasons[0]!.episodes.map((entry) => entry.code)).toEqual([
      "S01E01",
      "S01E02",
      "S01E10",
    ]);
    expect(series[0]!.seasons[1]!.episodes[0]!.code).toBe("S02E01");
  });

  it("names each job by its show and code, so the queue can be read", async () => {
    const library = await buildLibrary(SEASON_ONE);
    const episode = library.rows.find((row) => row.kind === "episode")!;
    const { routes } = build(library, [
      {
        id: "job-live",
        itemId: episode.itemId,
        mediaFileId: episode.mediaFileId!,
        state: "running",
        createdAt: new Date(),
        updatedAt: new Date(),
      } as unknown as ProcessingJobRecord,
    ]);
    const data = (await call(routes, "GET", "/processing/overview"))
      .data as Record<string, unknown>;

    expect(data.jobTitles).toEqual([
      {
        jobId: "job-live",
        kind: "episode",
        seriesTitle: "Show",
        code: "S01E01",
        // The numbers as well as the label: the queue tab groups a show by
        // these, and a parsed code is only its fallback.
        seasonNumber: 1,
        episodeNumber: 1,
        title: "Kassa",
      },
    ]);
  });

  it("shows an episode with an alternate container exactly once", async () => {
    const library = await buildLibrary([
      {
        seasonId: SEASON_2,
        seasonNumber: 3,
        number: 5,
        title: "Unbowed and Unbent",
        alternates: 1,
      },
    ]);
    const { routes } = build(library);
    const data = (await call(routes, "GET", "/processing/overview")).data as {
      series: Array<{ seasons: Array<{ episodes: unknown[] }> }>;
    };

    expect(data.series[0]!.seasons[0]!.episodes).toHaveLength(1);
  });

  /*
   * Trailers, theme clips and trickplay assets are excluded before this layer
   * ever sees them: the scanner never catalogues them as episodes, and a
   * trailer that is catalogued gets `kind = 'trailer'`, which the query does
   * not select. This asserts the query's half of that contract.
   */
  it("asks the catalogue only for movies and episodes", async () => {
    const library = await buildLibrary(SEASON_ONE);
    const kindsAsked: unknown[] = [];
    const catalogue = {
      ...createCatalogue(library),
      listProcessableTitles: async (options: { kinds?: string[] } = {}) => {
        kindsAsked.push(options.kinds ?? ["movie", "episode"]);
        return library.rows;
      },
    } as unknown as CatalogueRepository;

    const routes = createProcessingRoutes({
      catalogue,
      store: createStore(),
      queue: createQueue(),
      mediaRoot: library.root,
      workRoot: library.root,
    });
    await call(routes, "GET", "/processing/overview");
    expect(kindsAsked[0]).toEqual(["movie", "episode"]);
  });
});

// ----------------------------------------------------------- single title

describe("processing scratch capacity", () => {
  it("checks the scratch volume for preview and refuses enqueue when it is full", async () => {
    const library = await buildLibrary(SEASON_ONE);
    const workRoot = path.join(library.root, "scratch");
    const space = vi
      .spyOn(processingDecision, "freeBytesOn")
      .mockImplementation(async (directory) =>
        directory === workRoot ? 1_000_000 : 900_000_000_000,
      );
    try {
      const { routes, store, queue } = build(library, [], workRoot);
      const itemId = library.rows.find((row) => row.kind === "episode")!.itemId;
      const preview = await call(routes, "POST", "/processing/preview", {
        body: { itemId },
      });
      expect(preview.error).toBeUndefined();
      expect(preview.data).toMatchObject({
        decision: { estimate: { freeBytes: 1_000_000, sufficient: false } },
      });
      const queued = await call(routes, "POST", "/processing/jobs", {
        body: { itemId },
      });
      expect(queued.error?.statusCode).toBe(507);
      expect(store.created).toHaveLength(0);
      expect(queue.enqueued).toHaveLength(0);
    } finally {
      space.mockRestore();
    }
  });
});

describe("encodes that run on another machine", () => {
  /*
   * The server's worker is `light` and a laptop encodes. The server's own
   * scratch says nothing about that job, and refusing on it blocked every
   * title while the laptop had hundreds of gigabytes free.
   */
  it("queues the job without measuring this host's scratch", async () => {
    const library = await buildLibrary(SEASON_ONE);
    const workRoot = path.join(library.root, "scratch");
    const space = vi
      .spyOn(processingDecision, "freeBytesOn")
      .mockImplementation(async () => 1_000_000);
    try {
      const { routes, store, queue } = build(library, [], workRoot, true);
      const itemId = library.rows.find((row) => row.kind === "episode")!.itemId;
      const queued = await call(routes, "POST", "/processing/jobs", {
        body: { itemId },
      });
      expect(queued.error).toBeUndefined();
      expect(store.created).toHaveLength(1);
      expect(queue.enqueued).toHaveLength(1);
      expect(space).not.toHaveBeenCalledWith(workRoot);
    } finally {
      space.mockRestore();
    }
  });
});

describe("POST /processing/jobs", () => {
  it("queues one episode through the same path a movie uses", async () => {
    const library = await buildLibrary(SEASON_ONE);
    const episode = library.rows.find((row) => row.kind === "episode")!;
    const { routes, store, queue } = build(library);

    const result = await call(routes, "POST", "/processing/jobs", {
      body: { itemId: episode.itemId },
    });

    expect(result.error).toBeUndefined();
    expect(result.statusCode).toBe(202);
    expect(store.created).toEqual([
      { itemId: episode.itemId, mediaFileId: episode.mediaFileId },
    ]);
    expect(queue.enqueued).toHaveLength(1);
    expect(queue.enqueued[0]!.jobType).toBe("media.process");
  });

  /*
   * The episode's package must not be published into the season folder, which
   * every other episode of that season also lives in. The payload is where
   * that decision reaches the worker.
   */
  it("tells the worker to publish the episode into its own folder", async () => {
    const library = await buildLibrary(SEASON_ONE);
    const episode = library.rows.find((row) => row.kind === "episode")!;
    const { routes, queue } = build(library);
    await call(routes, "POST", "/processing/jobs", {
      body: { itemId: episode.itemId },
    });

    const titleRoot = queue.enqueued[0]!.payload.titleRoot as string;
    expect(titleRoot).toBe(
      path.join(library.root, "Series/Show/Season 1/Show - S01E01 - Kassa"),
    );
    expect(path.dirname(titleRoot)).toBe(
      path.join(library.root, "Series/Show/Season 1"),
    );
  });

  it("leaves a movie's package beside the movie, exactly as before", async () => {
    const library = await buildLibrary(SEASON_ONE);
    const { routes, queue } = build(library);
    await call(routes, "POST", "/processing/jobs", {
      body: { itemId: MOVIE_ID },
    });
    expect(queue.enqueued[0]!.payload.titleRoot).toBe(
      path.join(library.root, "Movies/Dune (2021)"),
    );
  });

  it("processes the canonical file when an episode has an alternate", async () => {
    const library = await buildLibrary([
      {
        seasonId: SEASON_2,
        seasonNumber: 3,
        number: 5,
        title: "Unbowed and Unbent",
        alternates: 1,
      },
    ]);
    const episode = library.rows.find((row) => row.kind === "episode")!;
    const { routes, store } = build(library);

    await call(routes, "POST", "/processing/jobs", {
      body: { itemId: episode.itemId },
    });
    expect(store.created).toHaveLength(1);
    expect(store.created[0]!.mediaFileId).toBe(episode.mediaFileId);
  });
});

// ------------------------------------------------------------------- bulk

describe("POST /processing/seasons/:seasonId/jobs", () => {
  it("makes one independent job per episode, never one for the season", async () => {
    const library = await buildLibrary(SEASON_ONE);
    const { routes, store, queue } = build(library);

    const result = await call(
      routes,
      "POST",
      "/processing/seasons/:seasonId/jobs",
      { params: { seasonId: SEASON_1 } },
    );

    expect(result.error).toBeUndefined();
    expect(result.data).toMatchObject({
      queued: 3,
      alreadyQueued: 0,
      alreadyComplete: 0,
      unavailable: 0,
    });
    expect(store.created).toHaveLength(3);
    expect(new Set(store.created.map((entry) => entry.mediaFileId)).size).toBe(
      3,
    );
    expect(queue.enqueued).toHaveLength(3);
    expect(
      queue.enqueued.every((entry) => entry.jobType === "media.process"),
    ).toBe(true);
    // Three distinct dedupe keys: three files, three jobs.
    expect(new Set(queue.enqueued.map((entry) => entry.dedupeKey)).size).toBe(
      3,
    );
  });

  it("queues only the season it was asked for", async () => {
    const library = await buildLibrary([
      ...SEASON_ONE,
      { seasonId: SEASON_2, seasonNumber: 2, number: 1, title: "Later" },
    ]);
    const { routes, store } = build(library);
    await call(routes, "POST", "/processing/seasons/:seasonId/jobs", {
      params: { seasonId: SEASON_2 },
    });
    expect(store.created).toHaveLength(1);
  });

  it("does not queue an episode that already has a job", async () => {
    const library = await buildLibrary(SEASON_ONE);
    const first = library.rows.find((row) => row.kind === "episode")!;
    const { routes, store } = build(library, [
      {
        id: "job-existing",
        itemId: first.itemId,
        mediaFileId: first.mediaFileId!,
        state: "running",
        createdAt: new Date(),
        updatedAt: new Date(),
      } as unknown as ProcessingJobRecord,
    ]);

    const result = await call(
      routes,
      "POST",
      "/processing/seasons/:seasonId/jobs",
      { params: { seasonId: SEASON_1 } },
    );

    expect(result.data).toMatchObject({ queued: 2, alreadyQueued: 1 });
    expect(store.created).toHaveLength(2);
    expect(
      store.created.some((entry) => entry.mediaFileId === first.mediaFileId),
    ).toBe(false);
  });

  it("does not queue an episode whose source is gone", async () => {
    const library = await buildLibrary([
      ...SEASON_ONE,
      {
        seasonId: SEASON_1,
        seasonNumber: 1,
        number: 11,
        title: "Vanished",
        missing: true,
      },
    ]);
    const { routes, store } = build(library);
    const result = await call(
      routes,
      "POST",
      "/processing/seasons/:seasonId/jobs",
      { params: { seasonId: SEASON_1 } },
    );

    expect(result.data).toMatchObject({ queued: 3, unavailable: 1 });
    expect(store.created).toHaveLength(3);
  });

  /*
   * The property a bulk button lives or dies by. A double click, an impatient
   * operator, a retried request: all of them must converge on the same jobs.
   */
  it("is idempotent — a second press queues nothing new", async () => {
    const library = await buildLibrary(SEASON_ONE);
    const { routes, store, queue } = build(library);

    const first = await call(
      routes,
      "POST",
      "/processing/seasons/:seasonId/jobs",
      { params: { seasonId: SEASON_1 } },
    );
    const second = await call(
      routes,
      "POST",
      "/processing/seasons/:seasonId/jobs",
      { params: { seasonId: SEASON_1 } },
    );

    expect(first.data).toMatchObject({ queued: 3, alreadyQueued: 0 });
    expect(second.data).toMatchObject({ queued: 0, alreadyQueued: 3 });
    expect(store.created).toHaveLength(3);
    expect(queue.enqueued).toHaveLength(3);
  });

  it("survives two presses arriving at once", async () => {
    const library = await buildLibrary(SEASON_ONE);
    const { routes, store } = build(library);
    const press = () =>
      call(routes, "POST", "/processing/seasons/:seasonId/jobs", {
        params: { seasonId: SEASON_1 },
      });

    const [left, right] = await Promise.all([press(), press()]);
    const queued =
      ((left.data as { queued: number }).queued ?? 0) +
      ((right.data as { queued: number }).queued ?? 0);

    expect(queued).toBe(3);
    expect(store.created).toHaveLength(3);
  });

  it("refuses a season with nothing playable in it", async () => {
    const library = await buildLibrary(SEASON_ONE);
    const { routes } = build(library);
    const result = await call(
      routes,
      "POST",
      "/processing/seasons/:seasonId/jobs",
      { params: { seasonId: SEASON_2 } },
    );
    expect(result.error?.code).toBe("MEDIA_NOT_FOUND");
  });
});

describe("POST /processing/series/:seriesId/jobs", () => {
  it("queues eligible episodes across every season", async () => {
    const library = await buildLibrary([
      ...SEASON_ONE,
      { seasonId: SEASON_2, seasonNumber: 2, number: 1, title: "Later" },
      { seasonId: SEASON_2, seasonNumber: 2, number: 2, title: "Even Later" },
    ]);
    const { routes, store } = build(library);

    const result = await call(
      routes,
      "POST",
      "/processing/series/:seriesId/jobs",
      { params: { seriesId: SERIES_ID } },
    );

    expect(result.data).toMatchObject({ queued: 5 });
    expect(store.created).toHaveLength(5);
  });

  it("never touches a film while processing a show", async () => {
    const library = await buildLibrary(SEASON_ONE);
    const { routes, store } = build(library);
    await call(routes, "POST", "/processing/series/:seriesId/jobs", {
      params: { seriesId: SERIES_ID },
    });
    expect(store.created.some((entry) => entry.itemId === MOVIE_ID)).toBe(
      false,
    );
  });

  it("is idempotent, and agrees with a season press already made", async () => {
    const library = await buildLibrary([
      ...SEASON_ONE,
      { seasonId: SEASON_2, seasonNumber: 2, number: 1, title: "Later" },
    ]);
    const { routes, store } = build(library);

    await call(routes, "POST", "/processing/seasons/:seasonId/jobs", {
      params: { seasonId: SEASON_1 },
    });
    const series = await call(
      routes,
      "POST",
      "/processing/series/:seriesId/jobs",
      { params: { seriesId: SERIES_ID } },
    );

    expect(series.data).toMatchObject({ queued: 1, alreadyQueued: 3 });
    expect(store.created).toHaveLength(4);
  });
});

// ------------------------------------------------------------- queue order

describe("POST /processing/queue/order", () => {
  it("hands the whole order to the store, in the order it was sent", async () => {
    const library = await buildLibrary(SEASON_ONE);
    const episodes = library.rows.filter((row) => row.kind === "episode");
    const seed = episodes.map(
      (row, index) =>
        ({
          id: `0000000${index + 1}-0000-4000-8000-000000000000`,
          itemId: row.itemId,
          mediaFileId: row.mediaFileId!,
          state: "queued",
          createdAt: new Date(),
        }) as unknown as ProcessingJobRecord,
    );
    const { routes, store } = build(library, seed);
    const wanted = [seed[2]!.id, seed[0]!.id, seed[1]!.id];

    const result = await call(routes, "POST", "/processing/queue/order", {
      body: { jobIds: wanted },
    });

    expect(result.error).toBeUndefined();
    expect(store.reordered).toEqual([wanted]);
    // The reply names the jobs that moved. It is a set: the order that matters
    // is the one that was sent, which the assertion above is about.
    expect(
      [...(result.data as { reordered: string[] }).reordered].sort(),
    ).toEqual([...wanted].sort());
  });

  it("reports only the jobs that actually moved", async () => {
    const library = await buildLibrary(SEASON_ONE);
    const episodes = library.rows.filter((row) => row.kind === "episode");
    // The first of them is already being encoded: it has been claimed, and a
    // reorder must not be allowed to claim it has been moved.
    const seed = episodes.map(
      (row, index) =>
        ({
          id: `0000000${index + 1}-0000-4000-8000-000000000000`,
          itemId: row.itemId,
          mediaFileId: row.mediaFileId!,
          state: index === 0 ? "running" : "queued",
          createdAt: new Date(),
        }) as unknown as ProcessingJobRecord,
    );
    const { routes } = build(library, seed);

    const result = await call(routes, "POST", "/processing/queue/order", {
      body: { jobIds: [seed[0]!.id, seed[1]!.id] },
    });

    expect(result.data).toEqual({ reordered: [seed[1]!.id] });
  });

  it("refuses a list that repeats a job, rather than guessing which one wins", async () => {
    const library = await buildLibrary(SEASON_ONE);
    const { routes, store } = build(library);
    const id = "00000001-0000-4000-8000-000000000000";

    const result = await call(routes, "POST", "/processing/queue/order", {
      body: { jobIds: [id, id] },
    });

    expect(result.error?.code).toBe("VALIDATION_FAILED");
    expect(store.reordered).toEqual([]);
  });

  it("refuses an empty list and anything that is not a job id", async () => {
    const library = await buildLibrary(SEASON_ONE);
    const { routes, store } = build(library);

    expect(
      (
        await call(routes, "POST", "/processing/queue/order", {
          body: { jobIds: [] },
        })
      ).error?.code,
    ).toBe("VALIDATION_FAILED");
    expect(
      (
        await call(routes, "POST", "/processing/queue/order", {
          body: { jobIds: ["not-a-uuid"] },
        })
      ).error?.code,
    ).toBe("VALIDATION_FAILED");
    expect(store.reordered).toEqual([]);
  });
});
