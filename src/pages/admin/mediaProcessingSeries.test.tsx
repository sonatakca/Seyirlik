/**
 * The television view, rendered through the real page.
 *
 * The assertions are about structure and behaviour rather than wording: which
 * rows exist, in what order, what a press sends, and — the one that matters
 * most on a page polling once a second — what survives a refresh.
 */

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import type {
  ProcessingEpisode,
  ProcessingOverview,
  ProcessingSeason,
  ProcessingSeries,
  ProcessingStateCounts,
} from "../../lib/processingApi";

vi.mock("../../i18n/LanguageContext", () => ({
  useLanguage: () => ({ t: (key: string) => key, language: "en" }),
}));

const MOVIE_ITEMS = [
  { Id: "movie-1", Name: "Dune", Type: "Movie", ImageTags: {} },
];

/*
 * Only the calls this suite answers are replaced. The rest of the module is
 * kept: the episode rows ask it for a thumbnail too, and a mock that dropped
 * an export would fail them on the missing name rather than on anything the
 * tests below are about.
 */
vi.mock("../../lib/mediaApi", async () => ({
  ...(await vi.importActual<typeof import("../../lib/mediaApi")>(
    "../../lib/mediaApi",
  )),
  getUserViews: async () => [
    { Id: "lib-movies", Name: "Movies", CollectionType: "movies" },
  ],
  getVideoItemsForLibrary: async () => MOVIE_ITEMS,
  getPrimaryImageUrl: () => "",
}));

const enqueueProcessing = vi.fn(async () => ({ job: { id: "job-new" } }));
const processSeason = vi.fn(async () => ({
  queued: 2,
  alreadyQueued: 1,
  alreadyComplete: 0,
  unavailable: 0,
  failed: 0,
  jobIds: [],
  skipped: [],
}));
const processSeries = vi.fn(async () => ({
  queued: 5,
  alreadyQueued: 0,
  alreadyComplete: 3,
  unavailable: 1,
  failed: 0,
  jobIds: [],
  skipped: [],
}));

let overview: ProcessingOverview;

vi.mock("../../lib/processingApi", async () => {
  const actual = await vi.importActual<
    typeof import("../../lib/processingApi")
  >("../../lib/processingApi");
  return {
    ...actual,
    getProcessingOverview: async () => overview,
    previewProcessing: async () => {
      throw new Error("no preview in this suite");
    },
    enqueueProcessing: (...args: unknown[]) =>
      enqueueProcessing(...(args as [])),
    processSeason: (...args: unknown[]) => processSeason(...(args as [])),
    processSeries: (...args: unknown[]) => processSeries(...(args as [])),
    getProcessingJob: async () => null,
  };
});

vi.mock("../../lib/notifications/notificationStore", () => ({
  notify: vi.fn(),
}));

// ------------------------------------------------------------- fixtures

function counts(
  overrides: Partial<ProcessingStateCounts> = {},
): ProcessingStateCounts {
  return {
    total: 0,
    complete: 0,
    partial: 0,
    unprocessed: 0,
    unknown: 0,
    active: 0,
    unavailable: 0,
    eligible: 0,
    ...overrides,
  };
}

function episode(
  seasonNumber: number,
  episodeNumber: number,
  title: string,
  overrides: Partial<ProcessingEpisode> = {},
): ProcessingEpisode {
  const code = `S${String(seasonNumber).padStart(2, "0")}E${String(
    episodeNumber,
  ).padStart(2, "0")}`;
  return {
    itemId: `${code}-item`,
    mediaFileId: `${code}-file`,
    title,
    sortTitle: code.toLowerCase(),
    sourceAvailable: true,
    fileCount: 1,
    probed: true,
    seasonNumber,
    episodeNumber,
    code,
    source: {
      width: 1920,
      height: 1080,
      qualityHeight: 1080,
      videoCodec: "h264",
      frameRate: 24,
      bitDepth: 8,
      isHdr: false,
      dynamicRange: "SDR",
      durationSeconds: 3000,
      sizeBytes: 5_000_000_000,
      container: "mp4",
      audioTracks: 1,
      subtitleTracks: 1,
      externalSubtitles: 1,
    },
    plan: {
      action: "package-adaptive",
      summary: "",
      videoCodec: "h264",
      videoEncoder: "h264_videotoolbox",
      hardwareAdapter: "videotoolbox",
      preservesHdr: false,
      ladder: [1080, 720, 480],
      missingRungs: [1080, 720, 480],
      estimatedOutputBytes: 3_000_000_000,
      audioTracksKept: 1,
      subtitleTracksKept: 1,
    },
    package: null,
    packageState: "none",
    activeJobId: null,
    activeJobState: null,
    processable: true,
    ...overrides,
  };
}

function season(
  seasonNumber: number,
  episodes: ProcessingEpisode[],
): ProcessingSeason {
  return {
    seasonId: `season-${seasonNumber}`,
    seasonNumber,
    title: `Season ${seasonNumber}`,
    episodes,
    counts: counts({
      total: episodes.length,
      eligible: episodes.filter((entry) => entry.processable).length,
      unprocessed: episodes.length,
    }),
  };
}

function series(
  title: string,
  seasons: ProcessingSeason[],
  overrides: Partial<ProcessingSeries> = {},
): ProcessingSeries {
  const episodeCount = seasons.reduce(
    (total, entry) => total + entry.episodes.length,
    0,
  );
  return {
    seriesId: `series-${title.toLowerCase().replace(/\s+/g, "-")}`,
    title,
    sortTitle: title.toLowerCase(),
    productionYear: 2022,
    seasonCount: seasons.length,
    episodeCount,
    seasons,
    counts: counts({
      total: episodeCount,
      eligible: seasons.reduce(
        (total, entry) => total + entry.counts.eligible,
        0,
      ),
      unprocessed: episodeCount,
    }),
    ...overrides,
  };
}

function baseOverview(
  seriesList: ProcessingSeries[],
  extra: Partial<ProcessingOverview> = {},
): ProcessingOverview {
  return {
    counts: {
      pending: 0,
      queued: 0,
      running: 0,
      paused: 0,
      succeeded: 0,
      failed: 0,
      cancelled: 0,
    },
    hardware: {
      platform: "darwin",
      probedAt: new Date().toISOString(),
      adapters: [],
      selected: { h264: "", hevc: "", hevcTenBit: "" },
      selectedAdapter: { h264: "", hevc: "", hevcTenBit: "" },
    },
    jobs: [],
    stages: [],
    profile: "cmaf-hls-aligned-v2",
    storage: {
      root: "/media",
      state: "healthy",
      summary: "",
      reason: "",
      faultCount: 0,
      missingRoots: [],
      firstFaultAt: null,
      lastFaultAt: null,
      changedAt: new Date().toISOString(),
      verifiedAt: null,
      mayStartWork: true,
      automaticResumeBlocked: false,
      awaitingVerification: false,
      awaitingResume: false,
    },
    movies: [],
    series: seriesList,
    jobTitles: [],
    ...extra,
  } as ProcessingOverview;
}

const ANDOR = series("Andor", [
  season(1, [
    episode(1, 1, "Kassa"),
    episode(1, 2, "That Would Be Me"),
    episode(1, 10, "Announcement"),
  ]),
  season(2, [episode(2, 1, "One Year Later")]),
]);

async function renderPage() {
  const { MediaProcessingPage } = await import("./MediaProcessingPage");
  const view = render(
    <MemoryRouter>
      <MediaProcessingPage />
    </MemoryRouter>,
  );
  await screen.findByText("processing.title");
  return view;
}

async function openSeriesTab(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("tab", { name: /kind.series/ }));
}

beforeEach(() => {
  overview = baseOverview([ANDOR]);
  enqueueProcessing.mockClear();
  processSeason.mockClear();
  processSeries.mockClear();
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ------------------------------------------------------------------ tests

describe("the content-kind switch", () => {
  it("offers films and shows, and starts on films", async () => {
    const user = userEvent.setup();
    await renderPage();

    const movies = await screen.findByRole("tab", { name: /kind.movies/ });
    const shows = await screen.findByRole("tab", { name: /kind.series/ });
    expect(movies).toHaveAttribute("aria-selected", "true");
    expect(shows).toHaveAttribute("aria-selected", "false");

    await user.click(shows);
    expect(shows).toHaveAttribute("aria-selected", "true");
  });

  it("keeps the film list working", async () => {
    await renderPage();
    // The poster placeholder and the heading both carry the title.
    expect(await screen.findAllByText("Dune")).not.toHaveLength(0);
    expect(
      await screen.findByRole("heading", { name: "Dune" }),
    ).toBeInTheDocument();
  });
});

/**
 * The text a reader would actually be given, ignoring the decoration.
 *
 * A show's poster and an episode's still both fall back to drawing the name
 * they belong to, and both are marked `aria-hidden` because the row already
 * says it in words. Queries that did not know that found the same show twice
 * and could not tell which one was the row's title.
 */
const DECORATION = 'script, style, [aria-hidden="true"]';

describe("the series tree", () => {
  it("renders each show once, collapsed", async () => {
    const user = userEvent.setup();
    await renderPage();
    await openSeriesTab(user);

    const shows = await screen.findAllByTestId("processing-series");
    expect(shows).toHaveLength(1);
    expect(
      within(shows[0]!).getByText("Andor", { ignore: DECORATION }),
    ).toBeInTheDocument();
    // Collapsed: no seasons drawn yet.
    expect(screen.queryAllByTestId("processing-season")).toHaveLength(0);
  });

  it("expands to seasons in numeric order", async () => {
    const user = userEvent.setup();
    await renderPage();
    await openSeriesTab(user);

    await user.click(screen.getByRole("button", { name: /expandSeries/ }));
    const seasons = await screen.findAllByTestId("processing-season");
    expect(
      seasons.map((node) => node.getAttribute("data-season-number")),
    ).toEqual(["1", "2"]);
  });

  it("expands a season to episodes in numeric order, not alphabetical", async () => {
    const user = userEvent.setup();
    await renderPage();
    await openSeriesTab(user);

    await user.click(screen.getByRole("button", { name: /expandSeries/ }));
    const [firstSeason] = await screen.findAllByTestId("processing-season");
    await user.click(
      within(firstSeason!).getByRole("button", { name: /expandSeason/ }),
    );

    const episodes = await screen.findAllByTestId("processing-episode");
    expect(
      episodes.map((node) => node.getAttribute("data-episode-code")),
    ).toEqual(["S01E01", "S01E02", "S01E10"]);
  });

  it("shows each episode as its code and title", async () => {
    const user = userEvent.setup();
    await renderPage();
    await openSeriesTab(user);
    await user.click(screen.getByRole("button", { name: /expandSeries/ }));
    const [firstSeason] = await screen.findAllByTestId("processing-season");
    await user.click(
      within(firstSeason!).getByRole("button", { name: /expandSeason/ }),
    );

    const [first] = await screen.findAllByTestId("processing-episode");
    expect(
      within(first!).getByText("S01E01", { ignore: DECORATION }),
    ).toBeInTheDocument();
    expect(within(first!).getByText("Kassa")).toBeInTheDocument();
    expect(within(first!).getByText("1920×1080")).toBeInTheDocument();
    expect(within(first!).getByText("SDR")).toBeInTheDocument();
    expect(within(first!).getByText("h264_videotoolbox")).toBeInTheDocument();
  });
});

describe("starting work", () => {
  async function openFirstSeason(
    user: ReturnType<typeof userEvent.setup>,
  ): Promise<HTMLElement> {
    await renderPage();
    await openSeriesTab(user);
    await user.click(screen.getByRole("button", { name: /expandSeries/ }));
    const [firstSeason] = await screen.findAllByTestId("processing-season");
    await user.click(
      within(firstSeason!).getByRole("button", { name: /expandSeason/ }),
    );
    return firstSeason!;
  }

  it("an episode press sends the canonical single-title request", async () => {
    const user = userEvent.setup();
    await openFirstSeason(user);

    const [first] = await screen.findAllByTestId("processing-episode");
    await user.click(
      within(first!).getByRole("button", { name: /processing.start S01E01/ }),
    );

    await waitFor(() =>
      expect(enqueueProcessing).toHaveBeenCalledWith(
        "S01E01-item",
        "S01E01-file",
      ),
    );
  });

  it("a season press sends one season request, not one per episode", async () => {
    const user = userEvent.setup();
    const firstSeason = await openFirstSeason(user);

    await user.click(
      within(firstSeason).getByRole("button", {
        name: "processing.tv.processSeason",
      }),
    );

    await waitFor(() => expect(processSeason).toHaveBeenCalledWith("season-1"));
    expect(processSeason).toHaveBeenCalledTimes(1);
    expect(enqueueProcessing).not.toHaveBeenCalled();
  });

  it("a series press sends one series request", async () => {
    const user = userEvent.setup();
    await renderPage();
    await openSeriesTab(user);

    await user.click(
      screen.getByRole("button", { name: "processing.tv.processSeries" }),
    );

    await waitFor(() =>
      expect(processSeries).toHaveBeenCalledWith("series-andor"),
    );
    expect(processSeries).toHaveBeenCalledTimes(1);
  });

  it("offers no run for a show with nothing left to do", async () => {
    overview = baseOverview([
      series("Finished", [season(1, [])], {
        counts: counts({ total: 13, complete: 13, eligible: 0 }),
        seasonCount: 1,
        episodeCount: 13,
      }),
    ]);
    const user = userEvent.setup();
    await renderPage();
    await openSeriesTab(user);

    expect(
      screen.getByRole("button", { name: "processing.tv.nothingToDo" }),
    ).toBeDisabled();
  });
});

describe("episode states", () => {
  async function renderEpisodes(episodes: ProcessingEpisode[]) {
    overview = baseOverview([series("States", [season(1, episodes)])]);
    const user = userEvent.setup();
    await renderPage();
    await openSeriesTab(user);
    await user.click(screen.getByRole("button", { name: /expandSeries/ }));
    const [firstSeason] = await screen.findAllByTestId("processing-season");
    await user.click(
      within(firstSeason!).getByRole("button", { name: /expandSeason/ }),
    );
    return screen.findAllByTestId("processing-episode");
  }

  it("does not offer a rerun of a fully processed episode", async () => {
    const nodes = await renderEpisodes([
      episode(1, 1, "Done", {
        packageState: "complete",
        processable: false,
        package: {
          present: true,
          current: true,
          sourceMatches: true,
          profileMatches: true,
          rungs: [1080, 720, 480],
          complete: true,
          hdr: "sdr",
          audioTracks: 1,
          subtitleTracks: 1,
          totalBytes: 1,
        },
        plan: {
          action: "skip-already-current",
          summary: "",
          videoCodec: "h264",
          videoEncoder: "h264_videotoolbox",
          hardwareAdapter: "videotoolbox",
          preservesHdr: false,
          ladder: [1080, 720, 480],
          missingRungs: [],
          estimatedOutputBytes: 0,
          audioTracksKept: 1,
          subtitleTracksKept: 1,
        },
      }),
    ]);
    /*
     * Nothing to run, so nothing offers to run it. What the row offers instead
     * is to reclaim the space: the package is complete and current, which is
     * the one condition under which the original file is safe to delete.
     */
    expect(
      within(nodes[0]!).queryByRole("button", { name: /processing.start/ }),
    ).toBeNull();
    expect(
      within(nodes[0]!).getByRole("button", {
        name: /processing.deleteSource/,
      }),
    ).toBeEnabled();
  });

  it("shows a source-missing episode, but does not let it be started", async () => {
    const nodes = await renderEpisodes([
      episode(1, 1, "Orphan", {
        sourceAvailable: false,
        processable: false,
        packageState: "complete",
        package: {
          present: true,
          current: false,
          sourceMatches: false,
          profileMatches: true,
          rungs: [1080, 720],
          complete: true,
          hdr: "sdr",
          audioTracks: 1,
          subtitleTracks: 0,
          totalBytes: 1,
        },
      }),
    ]);
    expect(within(nodes[0]!).getByText("Orphan")).toBeInTheDocument();
    // The rungs it still holds are shown; the ladder it can never gain is not.
    expect(within(nodes[0]!).getByText("1080p")).toBeInTheDocument();
    expect(within(nodes[0]!).queryByText("480p")).not.toBeInTheDocument();
    expect(within(nodes[0]!).getByRole("button")).toBeDisabled();
  });

  it("shows a queued episode as already in the queue", async () => {
    const nodes = await renderEpisodes([
      episode(1, 1, "Running", {
        activeJobId: "job-7",
        activeJobState: "running",
        processable: false,
      }),
    ]);
    const button = within(nodes[0]!).getByRole("button");
    expect(button).toBeDisabled();
    expect(button).toHaveTextContent("processing.activeJob");
  });

  it("says when an episode has an alternate container", async () => {
    const nodes = await renderEpisodes([
      episode(3, 5, "Unbowed and Unbent", { fileCount: 2 }),
    ]);
    expect(within(nodes[0]!).getByText(/alternateSource/)).toBeInTheDocument();
  });
});

describe("search", () => {
  const LIBRARY = [
    ANDOR,
    series("The Sopranos", [season(1, [episode(1, 1, "Pilot")])]),
  ];

  async function searchFor(term: string) {
    overview = baseOverview(LIBRARY);
    const user = userEvent.setup();
    await renderPage();
    await openSeriesTab(user);
    await user.type(screen.getByLabelText("processing.tv.searchSeries"), term);
    return user;
  }

  it("finds a show by its own name, and keeps all of its episodes", async () => {
    await searchFor("sopranos");
    const shows = await screen.findAllByTestId("processing-series");
    expect(shows).toHaveLength(1);
    expect(
      within(shows[0]!).getByText("The Sopranos", { ignore: DECORATION }),
    ).toBeInTheDocument();
    // Matching a show opens it, so the match is visible without another click.
    expect(await screen.findByText("Pilot")).toBeInTheDocument();
  });

  it("finds an episode by its title, and shows only that episode", async () => {
    await searchFor("Kassa");
    const shows = await screen.findAllByTestId("processing-series");
    expect(shows).toHaveLength(1);
    const episodes = await screen.findAllByTestId("processing-episode");
    expect(
      episodes.map((node) => node.getAttribute("data-episode-code")),
    ).toEqual(["S01E01"]);
  });

  it("names an episode in the site's language, and finds it by any name", async () => {
    overview = baseOverview([
      series("Berlin", [
        season(1, [
          {
            ...episode(1, 1, "TBA"),
            localizedTitles: { en: "The Collection", tr: "Koleksiyon" },
          },
        ]),
      ]),
    ]);
    const user = userEvent.setup();
    await renderPage();
    await openSeriesTab(user);
    await user.type(screen.getByLabelText("processing.tv.searchSeries"), "Koleksiyon");

    const [only] = await screen.findAllByTestId("processing-episode");
    expect(within(only!).getByText("The Collection")).toBeInTheDocument();
    expect(within(only!).queryByText("TBA")).toBeNull();
  });

  it("finds an episode by its SxxExx code", async () => {
    await searchFor("s01e10");
    const episodes = await screen.findAllByTestId("processing-episode");
    expect(
      episodes.map((node) => node.getAttribute("data-episode-code")),
    ).toEqual(["S01E10"]);
  });

  it("says so when nothing matches", async () => {
    await searchFor("nothing at all");
    expect(
      await screen.findByText("processing.tv.noSearchResults"),
    ).toBeInTheDocument();
  });
});

describe("polling", () => {
  /*
   * The one this page has to get right. It refreshes once a second while
   * anything is running; if that closed the season being read, or wiped the
   * search, the view would be unusable exactly when it is needed.
   */
  it("keeps expansion and search across a refresh that changes job state", async () => {
    const user = userEvent.setup();
    await renderPage();
    await openSeriesTab(user);
    await user.click(screen.getByRole("button", { name: /expandSeries/ }));
    const [firstSeason] = await screen.findAllByTestId("processing-season");
    await user.click(
      within(firstSeason!).getByRole("button", { name: /expandSeason/ }),
    );
    await user.type(
      screen.getByLabelText("processing.tv.searchSeries"),
      "Kassa",
    );
    expect(await screen.findAllByTestId("processing-episode")).toHaveLength(1);

    // A new poll arrives carrying a running job for that episode.
    const running = episode(1, 1, "Kassa", {
      activeJobId: "job-9",
      activeJobState: "running",
      processable: false,
    });
    overview = baseOverview([
      series("Andor", [
        season(1, [running, episode(1, 2, "That Would Be Me")]),
        season(2, [episode(2, 1, "One Year Later")]),
      ]),
    ]);
    await vi.advanceTimersByTimeAsync(1_200);

    await waitFor(() => {
      const nodes = screen.getAllByTestId("processing-episode");
      expect(nodes).toHaveLength(1);
      expect(within(nodes[0]!).getByRole("button")).toBeDisabled();
    });
    expect(
      (screen.getByLabelText("processing.tv.searchSeries") as HTMLInputElement)
        .value,
    ).toBe("Kassa");
    // The season the operator opened is still open.
    expect(screen.getAllByTestId("processing-season").length).toBeGreaterThan(
      0,
    );
  });
});

describe("the queue tab", () => {
  it("names an episode job by its show and code", async () => {
    overview = baseOverview([ANDOR], {
      jobs: [
        {
          id: "job-1",
          itemId: "S01E01-item",
          mediaFileId: "S01E01-file",
          state: "running",
          stage: "video",
          warnings: [],
          pausedReason: null,
          stageProgress: 0,
          overallProgress: 0,
          bytesProcessed: 0,
          actualOutputBytes: 0,
          outputBytes: null,
          estimatedOutputBytes: null,
          estimatedStagingBytes: null,
          speed: null,
          fps: null,
          etaSeconds: null,
          hardwareAdapter: null,
          videoEncoder: null,
          decision: null,
          validation: null,
          sourceDamage: null,
          errorCode: null,
          errorMessage: null,
          publishedVersion: null,
          attempts: 1,
          cancellationRequested: false,
          pauseRequested: false,
          epochCount: null,
          epochIndex: null,
          completedEpochs: 0,
          protectedSeconds: 0,
          encodedSeconds: 0,
          sourceDurationSeconds: null,
          epochStartSeconds: null,
          epochEndSeconds: null,
          checkpointBytes: 0,
          freeBytes: null,
          profile: "cmaf-hls-aligned-v2",
          createdAt: new Date().toISOString(),
          startedAt: null,
          finishedAt: null,
          updatedAt: new Date().toISOString(),
        },
      ],
      jobTitles: [
        {
          jobId: "job-1",
          kind: "episode",
          seriesTitle: "Andor",
          code: "S01E01",
          title: "Kassa",
        },
      ],
    } as Partial<ProcessingOverview>);

    const user = userEvent.setup();
    await renderPage();
    await user.click(
      await screen.findByRole("tab", { name: /tabs.processes/ }),
    );

    expect(await screen.findByText("Andor")).toBeInTheDocument();
    expect(await screen.findByText("S01E01 · Kassa")).toBeInTheDocument();
  });
});
