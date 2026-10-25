// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { RouteContext, RouteDefinition } from "../api/router";
import type { JobQueue } from "../tasks/jobQueue";
import { SUBTITLE_JOB_TYPES } from "./subtitleJobs";
import type {
  SubtitleAttemptRow,
  SubtitleRepository,
  SubtitleWantRow,
} from "./subtitleRepository";
import { createSubtitleRoutes } from "./subtitleRoutes";
import type { SubtitleUploader } from "./subtitleUpload";
import type { SubtitleSyncService } from "./subtitleSync";
import type { JobRecord } from "../tasks/jobQueue";
import type { SubtitleWant } from "./subtitleState";
import type { OpenSubtitlesLogin } from "./openSubtitlesProvider";

/**
 * The only surface a client can reach.
 *
 * Two things are being checked here rather than in the service: that a request
 * cannot name anything but a catalogue id and a policy — no path, no provider
 * URL, no destination — and that what comes back out carries an operator's
 * summary rather than the attempt's whole interior.
 */

const MEDIA = "22222222-3333-4444-8555-666666666666";
const ATTEMPT = "11111111-2222-4333-8444-555555555555";

function attemptRow(
  over: Partial<SubtitleAttemptRow> = {},
): SubtitleAttemptRow {
  return {
    id: ATTEMPT,
    wantId: "want-1",
    state: "wanted",
    attempt: 1,
    providerId: "synthetic",
    candidateId: "c1",
    score: 150,
    failureClass: null,
    failureDetail: null,
    awaitingProviderId: null,
    runAfter: null,
    ...over,
  };
}

function harness(
  over: {
    attempt?: SubtitleAttemptRow | null;
    uploader?: SubtitleUploader;
  } = {},
) {
  const wants: SubtitleWant[] = [];
  const enqueued: Record<string, unknown>[] = [];
  const repository = {
    ensureWant: vi.fn(async (mediaFileId: string, want: SubtitleWant) => {
      wants.push(want);
      return {
        id: "want-1",
        mediaFileId,
        language: want.language,
        forced: want.forced,
        hearingImpaired: want.hearingImpaired,
        active: true,
      } satisfies SubtitleWantRow;
    }),
    beginAttempt: vi.fn(async () => attemptRow()),
    getAttempt: vi.fn(async () =>
      over.attempt === undefined ? attemptRow() : over.attempt,
    ),
  } as unknown as SubtitleRepository;
  const queue = {
    enqueue: vi.fn(async (options: Record<string, unknown>) => {
      enqueued.push(options);
      return "job-1";
    }),
  } as unknown as JobQueue;
  return {
    routes: createSubtitleRoutes(repository, queue, undefined, over.uploader),
    wants,
    enqueued,
    repository,
  };
}

function route(
  routes: RouteDefinition[],
  method: string,
  path: string,
): RouteDefinition {
  const found = routes.find((r) => r.method === method && r.path === path);
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
    /** Query the upload route reads its policy from. */
    search?: string;
    /** Raw request bytes, for the routes that take a file rather than JSON. */
    bytes?: Uint8Array;
  } = {},
): Promise<Captured> {
  const captured: Captured = { status: 0, payload: undefined };
  const bytes = options.bytes;
  const context = {
    request: {
      once: () => undefined,
      off: () => undefined,
      headers: bytes ? { "content-length": String(bytes.length) } : {},
      async *[Symbol.asyncIterator]() {
        if (bytes) yield Buffer.from(bytes);
      },
    },
    response: {
      setHeader: () => undefined,
      end: (chunk?: string) => {
        captured.payload = chunk ? JSON.parse(chunk) : undefined;
      },
      get headersSent() {
        return false;
      },
      set statusCode(status: number) {
        captured.status = status;
      },
      get statusCode() {
        return captured.status;
      },
    },
    requestId: "req",
    url: new URL(`http://localhost/ownAPI/v1/subtitles${options.search ?? ""}`),
    params: options.params ?? {},
    method: definition.method,
    principal: { userId: "u", isAdministrator: true },
    requirePrincipal: () => ({ userId: "u", isAdministrator: true }),
    readJson: async () => options.body,
  } as unknown as RouteContext;
  return definition.handle(context).then(() => captured);
}

describe("asking for a subtitle", () => {
  it("is administrator-only, on every route", () => {
    for (const definition of harness().routes)
      expect(definition.access).toBe("admin");
  });

  it("queues the work and answers with the task, not the subtitle", async () => {
    const h = harness();
    const captured = await invoke(route(h.routes, "POST", "/subtitles"), {
      body: { mediaFileId: MEDIA, language: "tur" },
    });
    expect(captured.status).toBe(202);
    expect(h.enqueued).toEqual([
      {
        jobType: SUBTITLE_JOB_TYPES.run,
        payload: { attemptId: ATTEMPT, replace: false },
        dedupeKey: `subtitle:${ATTEMPT}`,
      },
    ]);
  });

  /*
   * The same request twice must not become two searches against a provider
   * that is already rate-limiting us.
   */
  it("keys the task on the attempt, so a repeat does not double the search", async () => {
    const h = harness();
    const post = route(h.routes, "POST", "/subtitles");
    await invoke(post, { body: { mediaFileId: MEDIA, language: "tur" } });
    await invoke(post, { body: { mediaFileId: MEDIA, language: "tur" } });
    expect(new Set(h.enqueued.map((e) => e.dedupeKey)).size).toBe(1);
  });

  it("normalises the language before anything downstream sees it", async () => {
    const h = harness();
    await invoke(route(h.routes, "POST", "/subtitles"), {
      body: {
        mediaFileId: MEDIA,
        language: "TR-tr",
        hearingImpaired: "prefer",
      },
    });
    expect(h.wants).toEqual([
      { language: "tur", forced: false, hearingImpaired: "prefer" },
    ]);
  });

  it("carries an explicit replacement request onto the task", async () => {
    const h = harness();
    await invoke(route(h.routes, "POST", "/subtitles"), {
      body: { mediaFileId: MEDIA, language: "tur", replace: true },
    });
    expect(h.enqueued[0]!.payload).toMatchObject({ replace: true });
  });

  it.each([
    ["no media file", { language: "tur" }],
    [
      "a media file that is not a catalogue id",
      { mediaFileId: "../../etc", language: "tur" },
    ],
    [
      "a path where a language belongs",
      { mediaFileId: MEDIA, language: "../../etc/passwd" },
    ],
    ["a language nothing speaks", { mediaFileId: MEDIA, language: "zz" }],
    ["no language at all", { mediaFileId: MEDIA }],
    [
      "a hearing-impaired policy of its own invention",
      { mediaFileId: MEDIA, language: "tur", hearingImpaired: "maybe" },
    ],
    [
      "a string where a flag belongs",
      { mediaFileId: MEDIA, language: "tur", forced: "yes" },
    ],
    [
      "a field this route does not have",
      { mediaFileId: MEDIA, language: "tur", destination: "/etc/passwd" },
    ],
  ])("refuses a request with %s", async (_label, body) => {
    const h = harness();
    await expect(
      invoke(route(h.routes, "POST", "/subtitles"), { body }),
    ).rejects.toThrow();
    expect(h.enqueued).toEqual([]);
  });
});

describe("looking at an attempt", () => {
  it("says where it got to, and no more than that", async () => {
    const h = harness({
      attempt: attemptRow({
        state: "needs-authentication",
        awaitingProviderId: "synthetic",
        failureClass: "authentication-required",
        failureDetail: "The provider returned: cf_clearance=SECRET rejected.",
      }),
    });
    const captured = await invoke(
      route(h.routes, "GET", "/subtitles/:attemptId"),
      {
        params: { attemptId: ATTEMPT },
      },
    );
    expect(captured.payload?.data).toEqual({
      attemptId: ATTEMPT,
      state: "needs-authentication",
      awaitingProviderId: "synthetic",
      failureClass: "authentication-required",
    });
    // The detail can carry a provider's own words, so it does not leave here.
    expect(JSON.stringify(captured.payload)).not.toContain("SECRET");
  });

  it("refuses an attempt id that is not one", async () => {
    const h = harness();
    await expect(
      invoke(route(h.routes, "GET", "/subtitles/:attemptId"), {
        params: { attemptId: "..%2Fetc" },
      }),
    ).rejects.toThrow();
  });

  it("does not distinguish a missing attempt from a malformed one", async () => {
    const h = harness({ attempt: null });
    await expect(
      invoke(route(h.routes, "GET", "/subtitles/:attemptId"), {
        params: { attemptId: ATTEMPT },
      }),
    ).rejects.toThrow();
  });
});

describe("resuming after somebody has signed in", () => {
  it("queues the resume task when the attempt is actually waiting", async () => {
    const h = harness({
      attempt: attemptRow({ state: "needs-authentication" }),
    });
    const captured = await invoke(
      route(h.routes, "POST", "/subtitles/:attemptId/resume"),
      { params: { attemptId: ATTEMPT } },
    );
    expect(captured.status).toBe(202);
    expect(h.enqueued).toEqual([
      {
        jobType: SUBTITLE_JOB_TYPES.resume,
        payload: { attemptId: ATTEMPT },
        dedupeKey: `subtitle:${ATTEMPT}`,
      },
    ]);
  });

  /*
   * Resuming an attempt that is not paused would re-enter the pipeline from
   * whatever state it is really in, which is how a finished install gets
   * searched for again.
   */
  it.each([["wanted"], ["searching"], ["installed"], ["failed"]] as const)(
    "refuses to resume an attempt in %s",
    async (state) => {
      const h = harness({ attempt: attemptRow({ state }) });
      await expect(
        invoke(route(h.routes, "POST", "/subtitles/:attemptId/resume"), {
          params: { attemptId: ATTEMPT },
        }),
      ).rejects.toThrow();
      expect(h.enqueued).toEqual([]);
    },
  );
});

describe("subtitles for a whole title", () => {
  const ITEM = "33333333-4444-4555-8666-777777777777";

  it("asks once per episode file, skipping files already being searched", async () => {
    const h = harness();
    const repository = h.repository as unknown as Record<string, unknown>;
    repository.titleMediaFiles = vi.fn(async () => ["f1", "f2", "f3"]);
    repository.openAttempt = vi.fn(async () => null);
    (repository.openAttempt as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      "already-running",
    );
    const captured = await invoke(
      route(h.routes, "POST", "/subtitles/items/:itemId"),
      { params: { itemId: ITEM }, body: { language: "tr" } },
    );
    expect(captured.payload?.data).toEqual({ files: 3, queued: 2 });
    expect(h.wants.every((want) => want.language === "tur")).toBe(true);
    expect(h.enqueued).toHaveLength(2);
  });

  it("refuses a request that names no known language", async () => {
    const h = harness();
    await expect(
      invoke(route(h.routes, "POST", "/subtitles/items/:itemId"), {
        params: { itemId: ITEM },
        body: { language: "zz-nothing" },
      }),
    ).rejects.toThrow();
  });
});

describe("a provider sign-in", () => {
  function sessionHarness() {
    const h = harness();
    const stored: unknown[] = [];
    const repository = h.repository as unknown as Record<string, unknown>;
    repository.attemptsAwaiting = vi.fn(async () => ["a1", "a2"]);
    const vault = {
      store: vi.fn(async (_id: string, material: unknown) => {
        stored.push(material);
      }),
      clear: vi.fn(async () => undefined),
      status: vi.fn(async (providerId: string) => ({
        providerId,
        state: "active",
        updatedAt: null,
        reason: null,
      })),
    };
    const routes = createSubtitleRoutes(
      h.repository,
      {
        enqueue: (options: Record<string, unknown>) => (
          h.enqueued.push(options),
          Promise.resolve("job")
        ),
      } as unknown as JobQueue,
      {
        providers: [
          {
            id: "turkcealtyazi",
            label: "TürkçeAltyazı",
            requiresSession: true,
            languages: ["tur"],
          },
        ],
        vault: vault as never,
      },
    );
    return { ...h, routes, stored, vault };
  }

  it("stores the pasted session, answers without it, and resumes what was waiting", async () => {
    const h = sessionHarness();
    const captured = await invoke(
      route(h.routes, "PUT", "/subtitles/providers/:providerId/session"),
      {
        params: { providerId: "turkcealtyazi" },
        body: { cookie: "cf_clearance=secret", userAgent: "Mozilla/5.0" },
      },
    );
    expect(h.stored).toEqual([
      { cookie: "cf_clearance=secret", userAgent: "Mozilla/5.0" },
    ]);
    expect(JSON.stringify(captured.payload)).not.toContain("secret");
    expect(captured.payload?.data).toMatchObject({ resumed: 2 });
    expect(h.enqueued.map((job) => job.jobType)).toEqual([
      SUBTITLE_JOB_TYPES.resume,
      SUBTITLE_JOB_TYPES.resume,
    ]);
  });

  it("refuses a paste that would inject a header, and stores nothing", async () => {
    const h = sessionHarness();
    await expect(
      invoke(
        route(h.routes, "PUT", "/subtitles/providers/:providerId/session"),
        {
          params: { providerId: "turkcealtyazi" },
          body: { cookie: "a=1\r\nX-Evil: 1", userAgent: "Mozilla/5.0" },
        },
      ),
    ).rejects.toThrow();
    expect(h.stored).toEqual([]);
  });

  it("does not accept a session for a provider it does not ask", async () => {
    const h = sessionHarness();
    await expect(
      invoke(
        route(h.routes, "PUT", "/subtitles/providers/:providerId/session"),
        {
          params: { providerId: "elsewhere" },
          body: { cookie: "a=1", userAgent: "UA" },
        },
      ),
    ).rejects.toThrow();
  });
});

describe("OpenSubtitles accounts", () => {
  function accountsHarness(
    options: {
      apiKey?: string | null;
      login?: OpenSubtitlesLogin;
    } = {},
  ) {
    const h = harness();
    const repository = h.repository as unknown as Record<string, unknown>;
    repository.attemptsAwaiting = vi.fn(async () => ["a1"]);
    const stored: { slot: number; account: unknown }[] = [];
    const accounts = {
      credentials: {
        apiKey: vi.fn(async () =>
          options.apiKey === undefined ? "key-123456" : options.apiKey,
        ),
      },
      storeApiKey: vi.fn(async () => undefined),
      storeAccount: vi.fn(async (slot: number, account: unknown) => {
        stored.push({ slot, account });
      }),
      clearAccount: vi.fn(async () => undefined),
      status: vi.fn(async () => ({
        apiKey: { state: "active", updatedAt: null },
        accounts: [],
      })),
    };
    const login = vi.fn(
      async () =>
        options.login ?? {
          outcome: "ok" as const,
          token: "token",
          baseUrl: "https://api.opensubtitles.com/api/v1",
          allowedDownloads: 20,
        },
    );
    const routes = createSubtitleRoutes(
      h.repository,
      {
        enqueue: (job: Record<string, unknown>) => (
          h.enqueued.push(job),
          Promise.resolve("job")
        ),
      } as unknown as JobQueue,
      {
        providers: [],
        vault: {} as never,
        openSubtitles: { accounts: accounts as never, login },
      },
    );
    const put = (slot: string, body: unknown) =>
      invoke(
        route(
          routes,
          "PUT",
          "/subtitles/providers/opensubtitles/accounts/:slot",
        ),
        { params: { slot }, body },
      );
    return { ...h, routes, stored, accounts, login, put };
  }

  it("signs the account in before saving it, answers without the password, and resumes what waited", async () => {
    const h = accountsHarness();
    const captured = await h.put("2", {
      username: "sonat",
      password: "hunter2",
    });
    expect(h.login).toHaveBeenCalledWith({
      apiKey: "key-123456",
      username: "sonat",
      password: "hunter2",
    });
    expect(h.stored).toEqual([
      { slot: 2, account: { username: "sonat", password: "hunter2" } },
    ]);
    expect(JSON.stringify(captured.payload)).not.toContain("hunter2");
    expect(captured.payload?.data).toMatchObject({
      allowedDownloads: 20,
      resumed: 1,
    });
    expect(h.enqueued.map((job) => job.jobType)).toEqual([
      SUBTITLE_JOB_TYPES.resume,
    ]);
  });

  it("saves nothing OpenSubtitles refused", async () => {
    const h = accountsHarness({
      login: { outcome: "refused", reason: "Refused." },
    });
    await expect(
      h.put("1", { username: "sonat", password: "wrong" }),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(h.stored).toEqual([]);
  });

  it("asks for the API key first", async () => {
    const h = accountsHarness({ apiKey: null });
    await expect(
      h.put("1", { username: "sonat", password: "pw" }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(h.login).not.toHaveBeenCalled();
  });

  it("has two account slots and no others", async () => {
    const h = accountsHarness();
    await expect(
      h.put("3", { username: "sonat", password: "pw" }),
    ).rejects.toMatchObject({ statusCode: 404 });
    await expect(
      h.put("../1", { username: "sonat", password: "pw" }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("refuses a username that would break a request", async () => {
    const h = accountsHarness();
    await expect(
      h.put("1", { username: "a\r\nb", password: "pw" }),
    ).rejects.toThrow();
    expect(h.login).not.toHaveBeenCalled();
  });
});

/**
 * A subtitle a person hands over.
 *
 * The route is checked for the two things it alone decides: that the policy is
 * read from the query and nothing in the request names a destination, and that
 * a refusal from the writer reaches the client as a refusal rather than as a
 * success with an error inside it.
 */
describe("uploading a subtitle", () => {
  const uploaderThat = (
    result: Awaited<ReturnType<SubtitleUploader["upload"]>>,
  ) => {
    const calls: Parameters<SubtitleUploader["upload"]>[0][] = [];
    return {
      calls,
      uploader: {
        upload: async (request: Parameters<SubtitleUploader["upload"]>[0]) => {
          calls.push(request);
          return result;
        },
      } satisfies SubtitleUploader,
    };
  };

  const ITEM = "44444444-5555-4666-8777-888888888888";
  const SRT = new TextEncoder().encode(
    "1\n00:00:01,000 --> 00:00:02,000\nHi\n\n",
  );

  it("is not mounted at all when no uploader is wired in", () => {
    expect(harness().routes.some((r) => r.path.endsWith("/upload"))).toBe(
      false,
    );
  });

  it("passes the bytes and the query's policy, and never a path", async () => {
    const spy = uploaderThat({
      outcome: "installed",
      relativePath: "Movies/Dune (2021)/Dune (2021).tur.srt",
      fileName: "Dune (2021).tur.srt",
      language: "tur",
      cueCount: 1,
      attached: true,
    });
    const h = harness({ uploader: spy.uploader });
    const captured = await invoke(
      route(h.routes, "POST", "/subtitles/items/:itemId/upload"),
      {
        params: { itemId: ITEM },
        search: "?language=tr&forced=true&replace=true",
        bytes: SRT,
      },
    );

    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0]).toMatchObject({
      itemId: ITEM,
      // Normalised to ISO 639-2 at the edge, as every other route does.
      language: "tur",
      forced: true,
      hearingImpaired: false,
      replace: true,
    });
    expect(Object.keys(spy.calls[0] as object)).not.toContain("path");
    expect(captured.payload?.data).toMatchObject({
      fileName: "Dune (2021).tur.srt",
      attached: true,
    });
  });

  it("refuses a language the player would never show", async () => {
    const spy = uploaderThat({
      outcome: "duplicate",
      relativePath: "x",
      fileName: "x",
      language: "fra",
      cueCount: null,
      attached: false,
    });
    const h = harness({ uploader: spy.uploader });

    await expect(
      invoke(route(h.routes, "POST", "/subtitles/items/:itemId/upload"), {
        params: { itemId: ITEM },
        search: "?language=fr",
        bytes: SRT,
      }),
    ).rejects.toThrow(/Turkish or English/);
    expect(spy.calls).toHaveLength(0);
  });

  it("turns a refusal from the writer into a refusal to the client", async () => {
    const spy = uploaderThat({
      outcome: "error",
      failure: "destination-occupied",
      reason: "The destination holds a subtitle this system did not install.",
    });
    const h = harness({ uploader: spy.uploader });

    await expect(
      invoke(route(h.routes, "POST", "/subtitles/items/:itemId/upload"), {
        params: { itemId: ITEM },
        search: "?language=tur",
        bytes: SRT,
      }),
    ).rejects.toMatchObject({
      code: "SUBTITLE_UPLOAD_REFUSED",
      statusCode: 409,
    });
  });
});

describe("re-timing a subtitle", () => {
  const SYNC_ITEM = "33333333-4444-4555-8666-777777777777";
  const TASK = "44444444-5555-4666-8777-888888888888";

  function syncHarness(job: Partial<JobRecord> | null = {}) {
    const enqueued: Record<string, unknown>[] = [];
    const repository = {
      titleMediaFiles: vi.fn(async () => [MEDIA]),
    } as unknown as SubtitleRepository;
    const queue = {
      enqueue: vi.fn(async (options: Record<string, unknown>) => {
        enqueued.push(options);
        return TASK;
      }),
      get: vi.fn(async () =>
        job === null
          ? null
          : ({
              id: TASK,
              jobType: SUBTITLE_JOB_TYPES.sync,
              payload: { mediaFileId: MEDIA },
              status: "succeeded",
              progressMessage: null,
              result: {
                outcome: "applied",
                relativePath: "movies/Film (2020)/Film (2020).tur.srt",
                fileName: "Film (2020).tur.srt",
                offsetSeconds: -14.56,
                rate: 1,
                confidence: 0.76,
              },
              ...job,
            } as JobRecord),
      ),
    } as unknown as JobQueue;
    const sync = {
      tracks: vi.fn(async (mediaFileId: string) => ({
        mediaFileId,
        subtitles: [],
        audio: [],
      })),
      sync: vi.fn(),
      revisions: vi.fn(async () => ({
        relativePath: "movies/Film (2020)/Film (2020).tur.srt",
        fileName: "Film (2020).tur.srt",
        revisions: [
          {
            id: "55555555-6666-4777-8888-999999999999",
            mediaFileId: MEDIA,
            relativePath: "movies/Film (2020)/Film (2020).tur.srt",
            revision: 1,
            origin: "original" as const,
            state: "committed" as const,
            sha256: "a".repeat(64),
            sizeBytes: 10,
            parentId: null,
            provenance: {},
            failure: null,
            createdAt: new Date(0),
            settledAt: new Date(0),
          },
        ],
      })),
      restore: vi.fn(),
      compare: vi.fn(async () => null),
      settlePending: vi.fn(async () => 0),
    } satisfies SubtitleSyncService;
    return {
      routes: createSubtitleRoutes(
        repository,
        queue,
        undefined,
        undefined,
        sync,
      ),
      enqueued,
      sync,
    };
  }

  it("is not mounted on a deployment that cannot sync", () => {
    const h = harness();
    expect(
      h.routes.some((r) => r.path.startsWith("/subtitles/items/:itemId/sync")),
    ).toBe(false);
  });

  it("lists the tracks of the title's one file", async () => {
    const h = syncHarness();
    const captured = await invoke(
      route(h.routes, "GET", "/subtitles/items/:itemId/sync"),
      { params: { itemId: SYNC_ITEM } },
    );
    expect(h.sync.tracks).toHaveBeenCalledWith(MEDIA);
    expect(captured.payload?.data).toEqual({
      mediaFileId: MEDIA,
      subtitles: [],
      audio: [],
    });
  });

  it("queues one correction per track and answers with the task", async () => {
    const h = syncHarness();
    const captured = await invoke(
      route(h.routes, "POST", "/subtitles/items/:itemId/sync"),
      {
        params: { itemId: SYNC_ITEM },
        body: {
          targetStreamIndex: 3,
          reference: { kind: "subtitle", streamIndex: 2 },
        },
      },
    );
    expect(captured.status).toBe(202);
    expect(captured.payload?.data).toMatchObject({ taskId: TASK });
    expect(h.enqueued).toEqual([
      {
        jobType: SUBTITLE_JOB_TYPES.sync,
        payload: {
          mediaFileId: MEDIA,
          targetStreamIndex: 3,
          reference: { kind: "subtitle", streamIndex: 2 },
          dryRun: false,
        },
        dedupeKey: `subtitle-sync:${MEDIA}:3`,
      },
    ]);
  });

  it("refuses a request that names a path or an unknown reference", async () => {
    const h = syncHarness();
    const post = route(h.routes, "POST", "/subtitles/items/:itemId/sync");
    await expect(
      invoke(post, {
        params: { itemId: SYNC_ITEM },
        body: {
          targetStreamIndex: 3,
          reference: { kind: "subtitle", streamIndex: 2 },
          relativePath: "../../elsewhere.srt",
        },
      }),
    ).rejects.toMatchObject({ statusCode: 422 });
    await expect(
      invoke(post, {
        params: { itemId: SYNC_ITEM },
        body: {
          targetStreamIndex: 3,
          reference: { kind: "video", streamIndex: 0 },
        },
      }),
    ).rejects.toMatchObject({ statusCode: 422 });
    expect(h.enqueued).toEqual([]);
  });

  it("reports what a finished sync did, without its library path", async () => {
    const h = syncHarness();
    const captured = await invoke(
      route(h.routes, "GET", "/subtitles/items/:itemId/sync/:taskId"),
      { params: { itemId: SYNC_ITEM, taskId: TASK } },
    );
    expect(captured.payload?.data).toEqual({
      taskId: TASK,
      status: "succeeded",
      message: null,
      result: {
        outcome: "applied",
        fileName: "Film (2020).tur.srt",
        offsetSeconds: -14.56,
        rate: 1,
        confidence: 0.76,
      },
    });
  });

  it("gives a running sync's sentence and no result yet", async () => {
    const h = syncHarness({
      status: "running",
      progressMessage: "Listening to the audio",
      result: null,
    });
    const captured = await invoke(
      route(h.routes, "GET", "/subtitles/items/:itemId/sync/:taskId"),
      { params: { itemId: SYNC_ITEM, taskId: TASK } },
    );
    expect(captured.payload?.data).toMatchObject({
      status: "running",
      message: "Listening to the audio",
      result: null,
    });
  });

  const PREVIEW = {
    status: "succeeded" as const,
    payload: {
      mediaFileId: MEDIA,
      targetStreamIndex: 3,
      reference: { kind: "audio", streamIndex: 1 },
      dryRun: true,
    },
    result: {
      outcome: "analysed",
      subtitleSha256: "b".repeat(64),
      alignment: {
        verdict: "partial",
        cues: [
          {
            index: 0,
            disposition: "corrected",
            sourceStartSeconds: 10,
            sourceEndSeconds: 12,
            startSeconds: 2,
            endSeconds: 4,
            text: "Merhaba",
          },
        ],
      },
    },
  };

  it("applies a reviewed proposal from the preview's own result, not the request's", async () => {
    const h = syncHarness(PREVIEW);
    await invoke(route(h.routes, "POST", "/subtitles/items/:itemId/sync"), {
      params: { itemId: SYNC_ITEM },
      body: { previewTaskId: TASK, unmatched: "exclude" },
    });
    expect(h.enqueued).toEqual([
      {
        jobType: SUBTITLE_JOB_TYPES.sync,
        payload: {
          mediaFileId: MEDIA,
          targetStreamIndex: 3,
          reference: { kind: "audio", streamIndex: 1 },
          reviewed: {
            subtitleSha256: "b".repeat(64),
            previewTaskId: TASK,
            unmatched: "exclude",
            verdict: "partial",
            placements: [
              {
                index: 0,
                disposition: "corrected",
                startSeconds: 2,
                endSeconds: 4,
              },
            ],
          },
        },
        dedupeKey: `subtitle-sync:${MEDIA}:3`,
      },
    ]);
  });

  it("refuses to apply a preview of another title, or one with nothing to apply", async () => {
    for (const job of [
      {
        ...PREVIEW,
        payload: {
          ...PREVIEW.payload,
          mediaFileId: "99999999-9999-4999-8999-999999999999",
        },
      },
      { ...PREVIEW, result: { ...PREVIEW.result, outcome: "applied" } },
      { ...PREVIEW, status: "running" as const },
    ]) {
      const h = syncHarness(job);
      await expect(
        invoke(route(h.routes, "POST", "/subtitles/items/:itemId/sync"), {
          params: { itemId: SYNC_ITEM },
          body: { previewTaskId: TASK },
        }),
      ).rejects.toMatchObject({ statusCode: 404 });
      expect(h.enqueued).toEqual([]);
    }
  });

  it("refuses a reviewed apply mixed with a typed correction", async () => {
    const h = syncHarness(PREVIEW);
    await expect(
      invoke(route(h.routes, "POST", "/subtitles/items/:itemId/sync"), {
        params: { itemId: SYNC_ITEM },
        body: { previewTaskId: TASK, offsetSeconds: 3 },
      }),
    ).rejects.toMatchObject({ statusCode: 422 });
  });

  it("lists a sidecar's versions without the library path", async () => {
    const h = syncHarness();
    const captured = await invoke(
      route(h.routes, "GET", "/subtitles/items/:itemId/revisions"),
      { params: { itemId: SYNC_ITEM }, search: "?streamIndex=1001" },
    );
    expect(h.sync.revisions).toHaveBeenCalledWith(MEDIA, 1001);
    const data = captured.payload?.data as {
      revisions: Record<string, unknown>[];
    };
    expect(data.revisions[0]).not.toHaveProperty("relativePath");
    expect(data.revisions[0]).toMatchObject({
      revision: 1,
      origin: "original",
    });
  });

  it("queues a restore under the same key as a correction of that track", async () => {
    const h = syncHarness();
    const revisionId = "55555555-6666-4777-8888-999999999999";
    await invoke(
      route(
        h.routes,
        "POST",
        "/subtitles/items/:itemId/revisions/:revisionId/restore",
      ),
      {
        params: { itemId: SYNC_ITEM, revisionId },
        body: { targetStreamIndex: 1001 },
      },
    );
    expect(h.enqueued).toEqual([
      {
        jobType: SUBTITLE_JOB_TYPES.sync,
        payload: {
          mediaFileId: MEDIA,
          targetStreamIndex: 1001,
          restoreRevisionId: revisionId,
        },
        dedupeKey: `subtitle-sync:${MEDIA}:1001`,
      },
    ]);
  });

  it("answers only for a sync task of this title", async () => {
    for (const job of [
      null,
      { payload: { mediaFileId: "99999999-9999-4999-8999-999999999999" } },
      { jobType: SUBTITLE_JOB_TYPES.run },
    ]) {
      const h = syncHarness(job);
      await expect(
        invoke(
          route(h.routes, "GET", "/subtitles/items/:itemId/sync/:taskId"),
          {
            params: { itemId: SYNC_ITEM, taskId: TASK },
          },
        ),
      ).rejects.toMatchObject({ statusCode: 404 });
    }
  });
});
