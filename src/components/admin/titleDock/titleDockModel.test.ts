import { describe, expect, it } from "vitest";
import type { LibraryTitleDetail } from "../../../lib/libraryAdminApi";
import type {
  ProcessingJob,
  ProcessingMovieTitle,
  ProcessingOverview,
  ProcessingSeries,
  ProcessingStateCounts,
} from "../../../lib/processingApi";
import {
  hasActiveWork,
  metadataStatus,
  monitoringStatus,
  pickProcessing,
  processingStatus,
  subtitleStatus,
  trickplayStatus,
} from "./titleDockModel";

const FILM = "11111111-1111-4111-8111-111111111111";

function movie(over: Partial<ProcessingMovieTitle> = {}): ProcessingMovieTitle {
  return {
    itemId: FILM,
    mediaFileId: "file-1",
    title: "Film",
    sortTitle: "Film",
    productionYear: 2020,
    sourceAvailable: true,
    fileCount: 1,
    probed: true,
    source: null,
    plan: null,
    package: null,
    packageState: "none",
    activeJobId: null,
    activeJobState: null,
    processable: true,
    ...over,
  };
}

function job(over: Partial<ProcessingJob>): ProcessingJob {
  return {
    id: "job-1",
    itemId: FILM,
    state: "running",
    overallProgress: 0.42,
    createdAt: "2026-10-10T10:00:00.000Z",
    ...over,
  } as ProcessingJob;
}

function counts(over: Partial<ProcessingStateCounts>): ProcessingStateCounts {
  return {
    total: 10,
    complete: 0,
    partial: 0,
    unprocessed: 0,
    unknown: 0,
    active: 0,
    unavailable: 0,
    eligible: 0,
    ...over,
  };
}

function overview(over: Partial<ProcessingOverview>): ProcessingOverview {
  return { jobs: [], movies: [], series: [], ...over } as ProcessingOverview;
}

function detail(over: Partial<LibraryTitleDetail> = {}): LibraryTitleDetail {
  return {
    id: FILM,
    kind: "movie",
    title: "Film",
    year: 2020,
    desired: true,
    tmdbId: null,
    imdbId: null,
    episodeCount: 0,
    availableEpisodeCount: 0,
    artwork: { coverTag: "c", logoTag: "l", logoLayout: null, missing: false },
    status: "available",
    hasMedia: true,
    downloading: 0,
    importing: 0,
    processing: 0,
    sizeBytes: 0,
    resolution: 1080,
    audioLanguages: [],
    subtitleLanguages: [],
    pendingSubtitles: [],
    files: 1,
    trickplayFiles: 0,
    pendingTrickplay: 0,
    mediaFileId: "file-1",
    fileName: "Film.mkv",
    seasons: [],
    catalogueComplete: true,
    ...over,
  };
}

describe("the title dock's processing status", () => {
  it("finds the film's row and its running job in the whole library's overview", () => {
    const running = job({ id: "job-9" });
    const picked = pickProcessing(
      overview({
        movies: [movie({ itemId: "other" }), movie({ activeJobId: "job-9" })],
        jobs: [job({ id: "job-1", itemId: "other" }), running],
      }),
      { kind: "movie", itemId: FILM },
    );
    expect(picked.movie?.itemId).toBe(FILM);
    expect(picked.activeJob).toBe(running);
    expect(hasActiveWork(picked)).toBe(true);
  });

  it("reports an encode by how much of it is done", () => {
    const status = processingStatus(
      { movie: movie({ activeJobId: "job-1" }), activeJob: job({}) },
      { kind: "movie", itemId: FILM },
    );
    expect(status).toEqual({
      tone: "busy",
      key: "titleDock.processing.running",
      values: { percent: 42 },
    });
  });

  it("names the best rendition of a finished package", () => {
    const status = processingStatus(
      {
        movie: movie({
          packageState: "complete",
          package: {
            rungs: [480, 1080, 720],
          } as ProcessingMovieTitle["package"],
        }),
      },
      { kind: "movie", itemId: FILM },
    );
    expect(status).toMatchObject({ tone: "ok", values: { best: 1080 } });
  });

  it("says the last attempt failed rather than that the film was never processed", () => {
    const status = processingStatus(
      { movie: movie(), lastJob: job({ state: "failed" }) },
      { kind: "movie", itemId: FILM },
    );
    expect(status.key).toBe("titleDock.processing.failed");
  });

  it("is unknown, not 'not processed', while the overview has not answered", () => {
    expect(processingStatus(null, { kind: "movie", itemId: FILM }).tone).toBe(
      "unknown",
    );
  });

  it("counts a season's episodes, not the whole show's, on a season page", () => {
    const series = {
      seriesId: "show",
      counts: counts({ total: 30, complete: 10 }),
      seasons: [
        {
          seasonId: "s2",
          counts: counts({ total: 10, complete: 4, unavailable: 2 }),
        },
      ],
    } as unknown as ProcessingSeries;
    const scope = { kind: "series", seriesId: "show", seasonId: "s2" } as const;
    const picked = pickProcessing(overview({ series: [series] }), scope);
    expect(processingStatus(picked, scope)).toEqual({
      tone: "attention",
      key: "titleDock.processing.episodesPartial",
      values: { done: 4, total: 8 },
    });
  });
});

describe("the title dock's other statuses", () => {
  it("wants Turkish subtitles, and says so when only others are on disk", () => {
    expect(
      subtitleStatus(detail({ subtitleLanguages: ["eng"] })),
    ).toMatchObject({
      tone: "attention",
      key: "titleDock.subtitles.noTurkish",
    });
    expect(
      subtitleStatus(detail({ subtitleLanguages: ["eng", "tur"] })).tone,
    ).toBe("ok");
    expect(subtitleStatus(detail({ pendingSubtitles: ["tur"] })).tone).toBe(
      "busy",
    );
    expect(subtitleStatus(detail({ files: 0 })).tone).toBe("idle");
  });

  it("counts trickplay by file", () => {
    expect(trickplayStatus(detail({ files: 3, trickplayFiles: 1 }))).toEqual({
      tone: "attention",
      key: "titleDock.trickplay.partial",
      values: { done: 1, total: 3 },
    });
    expect(trickplayStatus(detail({ files: 1, trickplayFiles: 1 })).tone).toBe(
      "ok",
    );
  });

  it("flags missing artwork, cover before logo", () => {
    expect(
      metadataStatus(
        detail({
          artwork: {
            coverTag: null,
            logoTag: null,
            logoLayout: null,
            missing: true,
          },
        }),
      ).key,
    ).toBe("titleDock.metadata.noCover");
    expect(
      metadataStatus(
        detail({
          artwork: {
            coverTag: "c",
            logoTag: null,
            logoLayout: null,
            missing: false,
          },
        }),
      ).key,
    ).toBe("titleDock.metadata.noLogo");
  });

  it("puts a download in progress ahead of whether the title is monitored", () => {
    expect(monitoringStatus(detail({ downloading: 2 }))).toMatchObject({
      tone: "busy",
      values: { count: 2 },
    });
    expect(monitoringStatus(detail({ desired: false })).tone).toBe("idle");
  });
});
