/**
 * What the processing card puts on screen for each phase.
 *
 * The rule under test is the same one the backend is built around: a figure
 * shown here must come from a measurement the worker actually reported. So the
 * tests render real snapshots and assert both what appears and — for the global
 * bar — what deliberately does not.
 */

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import type {
  AssemblyPhaseProgress,
  AudioPhaseProgress,
  ProcessingJob,
  ProcessingLiveProgress,
  PublishPhaseProgress,
  VerificationPhaseProgress,
} from "../../lib/processingApi";
import { en } from "../../i18n/translations/en";
import {
  describeAudioTrack,
  formatByteRate,
  globalProgressPercent,
  phasePercent,
} from "./processingModel";

const GIB = 1024 ** 3;

function job(overrides: Partial<ProcessingJob> = {}): ProcessingJob {
  return {
    id: "job-1",
    itemId: "item-1",
    mediaFileId: "file-1",
    profile: "cmaf-hls-aligned-v2",
    state: "running",
    stage: "packaging",
    stageProgress: 0.5,
    overallProgress: 0.5,
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
    warnings: [],
    sourceDamage: null,
    errorCode: null,
    errorMessage: null,
    publishedVersion: null,
    attempts: 1,
    cancellationRequested: false,
    pauseRequested: false,
    pausedReason: null,
    epochCount: 34,
    epochIndex: 33,
    completedEpochs: 34,
    protectedSeconds: 10_256,
    encodedSeconds: 10_256,
    sourceDurationSeconds: 10_256,
    epochStartSeconds: null,
    epochEndSeconds: null,
    checkpointBytes: 0,
    freeBytes: null,
    createdAt: "2026-09-02T00:00:00.000Z",
    startedAt: "2026-09-02T00:00:00.000Z",
    finishedAt: null,
    updatedAt: "2026-09-02T00:00:00.000Z",
    ...overrides,
  };
}

function live(
  overrides: Partial<ProcessingLiveProgress> = {},
): ProcessingLiveProgress {
  return {
    processingJobId: "job-1",
    revision: 1,
    timestampMs: Date.now(),
    stage: "packaging",
    phase: "assembling",
    epochIndex: null,
    epochCount: 34,
    epochStartSeconds: null,
    epochEndSeconds: null,
    epochFraction: null,
    completedEpochs: 34,
    protectedSeconds: 10_256,
    encodedSeconds: 10_256,
    sourceDurationSeconds: 10_256,
    ...overrides,
  };
}

const ASSEMBLY: AssemblyPhaseProgress = {
  totalBytes: 26.86 * GIB,
  completedBytes: 18.92 * GIB,
  fraction: 18.92 / 26.86,
  currentId: "1080p",
  bytesPerSecond: 15.3 * 1024 * 1024,
  etaSeconds: 531,
  renditions: [
    {
      id: "2160p",
      expectedBytes: 10.18 * GIB,
      writtenBytes: 10.18 * GIB,
      state: "complete",
    },
    {
      id: "1440p",
      expectedBytes: 7.31 * GIB,
      writtenBytes: 7.31 * GIB,
      state: "complete",
    },
    {
      id: "1080p",
      expectedBytes: 4.76 * GIB,
      writtenBytes: 1.43 * GIB,
      state: "running",
    },
    {
      id: "720p",
      expectedBytes: 2.48 * GIB,
      writtenBytes: 0,
      state: "waiting",
    },
  ],
};

const AUDIO: AudioPhaseProgress = {
  tracks: [
    {
      id: "track-1",
      language: "tur",
      codec: "aac",
      channels: 6,
      writtenBytes: 120 * 1024 * 1024,
    },
    {
      id: "track-2",
      language: "eng",
      codec: "aac",
      channels: 2,
      writtenBytes: 60 * 1024 * 1024,
    },
  ],
  processedSeconds: 7_398,
  durationSeconds: 10_256,
  fraction: 7_398 / 10_256,
  speed: 21.4,
  writtenBytes: 180 * 1024 * 1024,
  etaSeconds: 133,
};

const VERIFICATION: VerificationPhaseProgress = {
  totalChecks: 31,
  completedChecks: 23,
  totalWeight: 28.9 * GIB,
  completedWeight: 27.1 * GIB,
  fraction: 27.1 / 28.9,
  groups: [
    { kind: "video-probe", completed: 5, total: 8 },
    { kind: "audio", completed: 1, total: 3 },
  ],
  current: { kind: "video-probe", rendition: "1080p" },
  declared: { videoRenditions: 8, audioRenditions: 3, subtitleRenditions: 4 },
};

const PUBLISH: PublishPhaseProgress = {
  steps: [
    { id: "video", state: "complete", bytes: 26.86 * GIB },
    { id: "manifest", state: "complete" },
    { id: "swap", state: "running" },
    { id: "cleanup", state: "waiting" },
  ],
  totalBytes: 26.86 * GIB,
  completedBytes: 26.86 * GIB,
  fraction: 0.5,
  currentId: "swap",
};

describe("the global bar", () => {
  it("shows the live cumulative value while a job runs", () => {
    expect(
      globalProgressPercent(
        job({ overallProgress: 0.4 }),
        live({ globalProgress: 0.62 }),
      ),
    ).toBeCloseTo(62, 5);
  });

  /**
   * The row and the live file are written by different processes at different
   * rates, so either can be the fresher of the two. Taking the larger is what
   * stops the bar flickering backwards between them.
   */
  it("never steps back when the two lanes disagree", () => {
    expect(
      globalProgressPercent(
        job({ overallProgress: 0.7 }),
        live({ globalProgress: 0.62 }),
      ),
    ).toBeCloseTo(70, 5);
  });

  it("does not fill until the job row says it succeeded", () => {
    expect(
      globalProgressPercent(
        job({ overallProgress: 1 }),
        live({ globalProgress: 0.999 }),
      ),
    ).toBeLessThan(100);
    expect(globalProgressPercent(job({ state: "succeeded" }), null)).toBe(100);
  });

  it("keeps the last confirmed position for a failed or paused job", () => {
    expect(
      globalProgressPercent(
        job({ state: "failed", overallProgress: 0.43 }),
        null,
      ),
    ).toBeCloseTo(43, 5);
    expect(
      globalProgressPercent(
        job({ state: "paused", overallProgress: 0.28 }),
        null,
      ),
    ).toBeCloseTo(28, 5);
  });

  it("falls back to the row when there is no live sample at all", () => {
    expect(
      globalProgressPercent(job({ overallProgress: 0.33 }), null),
    ).toBeCloseTo(33, 5);
  });
});

describe("phase figures are formatted without nonsense", () => {
  it("never prints 0 B/s, Infinity or NaN as a rate", () => {
    expect(formatByteRate(undefined)).toBe("—");
    expect(formatByteRate(0)).toBe("—");
    expect(formatByteRate(Number.POSITIVE_INFINITY)).toBe("—");
    expect(formatByteRate(Number.NaN)).toBe("—");
    expect(formatByteRate(15.3 * 1024 * 1024)).toBe("15.3 MiB/s");
  });

  it("prints a phase percentage to one decimal", () => {
    expect(phasePercent(18.92 / 26.86)).toBe("70.4%");
    expect(phasePercent(0)).toBe("0.0%");
    expect(phasePercent(1)).toBe("100.0%");
    expect(phasePercent(undefined)).toBe("—");
  });

  it("describes a track from what the source declares, and no more", () => {
    const name = (code: string) => (code === "tur" ? "Turkish" : code);
    expect(
      describeAudioTrack(
        {
          id: "track-1",
          language: "tur",
          codec: "aac",
          channels: 6,
          writtenBytes: 0,
        },
        name,
      ),
    ).toBe("Turkish · AAC · 5.1");
    expect(
      describeAudioTrack(
        { id: "track-9", codec: "aac", channels: 0, writtenBytes: 0 },
        name,
      ),
    ).toBe("AAC");
  });
});

/*
 * The page itself. Rendered through the real component so the panels are
 * exercised the way an operator sees them, with the translation layer replaced
 * by one that returns its own keys — the assertions are about which figures
 * appear, not about the wording.
 */
vi.mock("../../i18n/LanguageContext", () => ({
  useLanguage: () => ({ t: (key: string) => key, language: "en" }),
}));
vi.mock("../../lib/mediaApi", () => ({
  getUserViews: async () => [],
  getVideoItemsForLibrary: async () => [],
  getPrimaryImageUrl: () => "",
}));
vi.mock("../../lib/processingApi", async () => {
  const actual = await vi.importActual<
    typeof import("../../lib/processingApi")
  >("../../lib/processingApi");
  return {
    ...actual,
    getProcessingOverview: async () => ({
      counts: {
        pending: 0,
        queued: 0,
        running: 1,
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
    }),
  };
});

describe("phase panels render the measurements they are given", () => {
  async function renderPanel(snapshot: ProcessingLiveProgress) {
    const { PhaseDetailForTest } = await import("./MediaProcessingPage");
    render(
      <MemoryRouter>
        <PhaseDetailForTest
          job={job()}
          live={snapshot}
          nowMs={Date.now()}
          t={((key: string) => key) as never}
        />
      </MemoryRouter>,
    );
  }

  /** The same, returning the container so a whole panel can be searched. */
  async function renderPanelInto(snapshot: ProcessingLiveProgress) {
    const { PhaseDetailForTest } = await import("./MediaProcessingPage");
    return render(
      <MemoryRouter>
        <PhaseDetailForTest
          job={job()}
          live={snapshot}
          nowMs={Date.now()}
          t={((key: string) => key) as never}
        />
      </MemoryRouter>,
    );
  }

  it("shows the assembly ladder in bytes, rung by rung", async () => {
    await renderPanel(live({ phase: "assembling", assembly: ASSEMBLY }));

    expect(screen.getByText("70.4%")).toBeTruthy();
    expect(screen.getByText("2160p")).toBeTruthy();
    expect(screen.getByText("720p")).toBeTruthy();
    // The waiting rung says so rather than showing a misleading 0 of 2.48 GB.
    expect(screen.getAllByText("processing.assembly.waiting").length).toBe(1);
    expect(screen.getByText("30.0%")).toBeTruthy();
  });

  /**
   * A paused job, or one whose volume went away, stops reporting. The position
   * it reached is still true and stays on screen; the rate and the remaining
   * time are claims about right now and go.
   */
  it("drops the rate and the estimate once the writer has stopped", async () => {
    const { PhaseDetailForTest } = await import("./MediaProcessingPage");
    render(
      <MemoryRouter>
        <PhaseDetailForTest
          job={job()}
          live={live({
            phase: "assembling",
            assembly: ASSEMBLY,
            timestampMs: Date.now() - 30_000,
          })}
          nowMs={Date.now()}
          t={((key: string) => key) as never}
        />
      </MemoryRouter>,
    );
    expect(screen.getByText("processing.phaseStalled")).toBeTruthy();
    expect(screen.getByText(/processing\.assembly\.writeRate: —/)).toBeTruthy();
    // The measured position is untouched: it is where the work actually got to.
    expect(screen.getByText("70.4%")).toBeTruthy();
  });

  it("omits the estimate when no throughput has been measured", async () => {
    const withoutRate: AssemblyPhaseProgress = { ...ASSEMBLY };
    delete withoutRate.bytesPerSecond;
    delete withoutRate.etaSeconds;
    await renderPanel(live({ phase: "assembling", assembly: withoutRate }));
    expect(screen.queryByText(/processing\.eta/)).toBeNull();
  });

  it("shows the audio timeline and every track it is writing", async () => {
    await renderPanel(live({ phase: "audio", audio: AUDIO }));
    expect(screen.getByText("72.1%")).toBeTruthy();
    expect(screen.getByText(/processing\.language\.tur/)).toBeTruthy();
    expect(screen.getByText(/processing\.language\.eng/)).toBeTruthy();
  });

  /**
   * The audit's rule: a weighted cost model must not be dressed as bytes read.
   * The panel prints counts, and labels the bar as weighted.
   */
  it("shows verification as counts, never as bytes", async () => {
    const { container } = await renderPanelInto(
      live({ phase: "validating", verification: VERIFICATION }),
    );
    expect(screen.getByText(/processing\.verification\.checks/)).toBeTruthy();
    expect(screen.getByText("5 / 8")).toBeTruthy();
    expect(screen.getByText("1 / 3")).toBeTruthy();
    expect(screen.getByText("processing.verification.weighted")).toBeTruthy();
    // No byte figure anywhere in the verification panel.
    expect(container.textContent).not.toMatch(/GiB|MiB|GB|MB/);
  });

  it("lists the publication steps and their states", async () => {
    await renderPanel(live({ phase: "publishing", publish: PUBLISH }));
    expect(screen.getByText("processing.publish.video")).toBeTruthy();
    expect(screen.getByText("processing.publish.swap")).toBeTruthy();
    expect(screen.getByText("processing.publish.cleanup")).toBeTruthy();
  });

  /**
   * A phase that has begun and not reported yet is named and timed. Showing
   * the video panel here is what made the audio stage read as video.
   */
  it("names a phase that has not reported yet instead of showing video", async () => {
    await renderPanel(
      live({ phase: "audio", phaseStartedAtMs: Date.now() - 65_000 }),
    );
    expect(screen.getByText("processing.phase.audio")).toBeTruthy();
    expect(screen.getByText("processing.phase.startedAgo")).toBeTruthy();
    expect(screen.queryAllByText(/processing\.epoch/)).toHaveLength(0);
  });

  /**
   * With no sample at all — a page opened after a worker restart — the row is
   * all there is, and the epoch panel is the one that can describe a build
   * from the row alone.
   */
  it("falls back to the epoch panel when there is no live sample", async () => {
    const { PhaseDetailForTest } = await import("./MediaProcessingPage");
    render(
      <MemoryRouter>
        <PhaseDetailForTest
          job={job()}
          live={null}
          nowMs={Date.now()}
          t={((key: string) => key) as never}
        />
      </MemoryRouter>,
    );
    expect(screen.getAllByText(/processing\.epoch/).length).toBeGreaterThan(0);
  });

  it("shows the planning steps and the rate probe's finished work", async () => {
    await renderPanel(
      live({
        phase: "planning",
        planning: {
          step: "rates",
          boundaryCount: 4,
          epochCount: 5,
          rateProbe: { encodes: 3, measurements: 7, qualityHeight: 1080 },
        },
      }),
    );
    expect(screen.getByText("processing.planning.timeline")).toBeTruthy();
    expect(screen.getByText("processing.planning.rates")).toBeTruthy();
    expect(screen.getByText("processing.planning.epochs")).toBeTruthy();
    expect(
      screen.getByText(
        /processing\.planning\.rateWork · processing\.planning\.rateRung/,
      ),
    ).toBeTruthy();
  });

  it("lists every subtitle track with its own state", async () => {
    await renderPanel(
      live({
        phase: "subtitles",
        subtitles: {
          tracks: [
            {
              id: "subtitle-3",
              origin: "embedded",
              language: "tur",
              state: "complete",
              bytes: 81_920,
            },
            {
              id: "subtitle-4",
              origin: "embedded",
              language: "eng",
              state: "running",
            },
            {
              id: "subtitle-900",
              origin: "sidecar",
              language: "eng",
              isForced: true,
              state: "waiting",
            },
          ],
          completedTracks: 1,
          fraction: 1 / 3,
          currentId: "subtitle-4",
          currentStartedAtMs: Date.now() - 42_000,
          writtenBytes: 81_920,
        },
      }),
    );
    expect(screen.getByText("1 / 3")).toBeTruthy();
    expect(screen.getByText("processing.language.tur")).toBeTruthy();
    expect(screen.getByText("processing.subtitles.running")).toBeTruthy();
    expect(screen.getByText(/processing\.subtitles\.forced/)).toBeTruthy();
    expect(screen.getByText("processing.subtitles.sidecar")).toBeTruthy();
  });

  /**
   * A finished build keeps its history on the row. The card used to show the
   * video panel's last state — "video encoding complete" — and nothing else.
   */
  it("describes a finished build phase by phase from the row", async () => {
    const { PhaseDetailForTest } = await import("./MediaProcessingPage");
    render(
      <MemoryRouter>
        <PhaseDetailForTest
          job={job({
            state: "succeeded",
            stage: "complete",
            phaseHistory: [
              { phase: "planning", elapsedSeconds: 95, count: 5 },
              { phase: "encoding", elapsedSeconds: 5400, count: 5, bytes: 9e9 },
              { phase: "audio", elapsedSeconds: 240, count: 2 },
              { phase: "publishing", elapsedSeconds: 300 },
            ],
          })}
          live={null}
          nowMs={Date.now()}
          t={((key: string) => key) as never}
        />
      </MemoryRouter>,
    );
    expect(screen.getByText("processing.phase.planning")).toBeTruthy();
    expect(screen.getByText("processing.phase.audio")).toBeTruthy();
    expect(screen.getByText("processing.history.total")).toBeTruthy();
    expect(screen.queryAllByText(/processing\.epoch/)).toHaveLength(0);
  });
});

describe("the upload to Google Drive after publication", () => {
  const t = ((key: string) => key) as never;

  it("shows bytes, files, rate and retries while uploading", async () => {
    const { DriveUploadPanelForTest } = await import("./MediaProcessingPage");
    const now = Date.now();
    render(
      <DriveUploadPanelForTest
        upload={{
          state: "uploading",
          totalBytes: 33.2e9,
          uploadedBytes: 16.6e9,
          filesPending: 2,
          filesUploading: 2,
          bytesPerSecond: 19.5e6,
          etaSeconds: 426,
          retries: 1,
          startedAtMs: now - 600_000,
          updatedAtMs: now - 1_000,
        }}
        nowMs={now}
        t={t}
      />,
    );
    expect(screen.getByText("50.0%")).toBeTruthy();
    expect(screen.getByText("processing.upload.files")).toBeTruthy();
    expect(screen.getByText("18.6 MiB/s")).toBeTruthy();
    expect(screen.getByText("processing.upload.retries")).toBeTruthy();
  });

  it("withdraws the rate and says so once nobody is reading the queue", async () => {
    const { DriveUploadPanelForTest } = await import("./MediaProcessingPage");
    const now = Date.now();
    render(
      <DriveUploadPanelForTest
        upload={{
          state: "uploading",
          totalBytes: 10e9,
          uploadedBytes: 4e9,
          filesPending: 1,
          filesUploading: 1,
          bytesPerSecond: 9e6,
          startedAtMs: now - 900_000,
          updatedAtMs: now - 300_000,
        }}
        nowMs={now}
        t={t}
      />,
    );
    expect(screen.getByText("processing.upload.notWatched")).toBeTruthy();
    expect(screen.queryByText(/MiB\/s/)).toBeNull();
  });

  it("says the title is on Drive once the queue is empty", async () => {
    const { DriveUploadPanelForTest } = await import("./MediaProcessingPage");
    const now = Date.now();
    render(
      <DriveUploadPanelForTest
        upload={{
          state: "uploaded",
          totalBytes: 10e9,
          uploadedBytes: 10e9,
          filesPending: 0,
          filesUploading: 0,
          startedAtMs: now - 900_000,
          updatedAtMs: now,
          finishedAtMs: now,
        }}
        nowMs={now}
        t={t}
      />,
    );
    expect(screen.getByText("processing.upload.done")).toBeTruthy();
  });
});

/**
 * What the page says while a disk is failing, and what it keeps saying
 * afterwards.
 *
 * Rendered with the real English strings rather than key echoes, because the
 * whole point of these two panels is the sentence they produce: an operator has
 * to be able to read the damaged interval off the screen and decide whether
 * that stretch of the film is worth re-ripping the disc for.
 */
describe("a source that cannot be read", () => {
  const translate = ((key: string) =>
    (en as Record<string, string>)[key] ?? key) as never;

  async function renderDetail(snapshot: ProcessingLiveProgress) {
    const { PhaseDetailForTest } = await import("./MediaProcessingPage");
    return render(
      <MemoryRouter>
        <PhaseDetailForTest
          job={job({ state: "running", stage: "video" })}
          live={snapshot}
          nowMs={Date.now()}
          t={translate}
        />
      </MemoryRouter>,
    );
  }

  function encoding(
    sourceIo: NonNullable<ProcessingLiveProgress["sourceIo"]>,
  ): ProcessingLiveProgress {
    return live({
      phase: "encoding",
      stage: "video",
      epochIndex: 10,
      epochCount: 30,
      epochStartSeconds: 3000.039,
      epochEndSeconds: 3300.005,
      epochFraction: 0.41,
      sourceIo,
    });
  }

  it("says only that it is waiting before anything is diagnosed", async () => {
    const { container } = await renderDetail(
      encoding({
        state: "waiting",
        epochIndex: 10,
        startSeconds: 3000.039,
        endSeconds: 3300.005,
      }),
    );
    expect(screen.getByText("Waiting for source data…")).toBeTruthy();
    // No accusation, and no invented rate for a process that is doing nothing.
    expect(container.textContent).not.toContain("Source read problem");
    expect(container.textContent).not.toMatch(/\d+\.\d+×/);
  });

  it("says the encoder is being stopped once the watchdog fires", async () => {
    /*
     * The step between waiting and any diagnosis. Terminating a process wedged
     * in an uninterruptible read can take tens of seconds, and a page that said
     * nothing through them would look like a page that had crashed.
     */
    const { container } = await renderDetail(
      encoding({
        state: "aborting",
        epochIndex: 10,
        startSeconds: 3000.039,
        endSeconds: 3300.005,
        lastMediaSeconds: 123.29,
      }),
    );
    expect(
      screen.getByText("Source read stalled — stopping encoder…"),
    ).toBeTruthy();
    // Still no invented rate: nothing is being produced.
    expect(container.textContent).not.toMatch(/\d+\.\d+×/);
  });

  it("says a read has failed once one actually has", async () => {
    await renderDetail(
      encoding({
        state: "suspected",
        epochIndex: 10,
        startSeconds: 3000.039,
        endSeconds: 3300.005,
        attempt: 2,
        maxAttempts: 4,
      }),
    );
    expect(
      screen.getByText("Source read problem detected (attempt 2 of 4)"),
    ).toBeTruthy();
  });

  it("names the interval once the diagnosis is made", async () => {
    await renderDetail(
      encoding({
        state: "confirmed",
        epochIndex: 10,
        startSeconds: 3000.039,
        endSeconds: 3300.005,
      }),
    );
    expect(
      screen.getByText(
        "The source cannot be read between 00:50:00 and 00:55:00",
      ),
    ).toBeTruthy();
  });

  it("says what it is doing about it, and where it carries on from", async () => {
    const replacing = await renderDetail(
      encoding({
        state: "replacing",
        epochIndex: 10,
        startSeconds: 3000.039,
        endSeconds: 3300.005,
      }),
    );
    expect(
      screen.getByText("Replacing damaged interval 00:50:00–00:55:00"),
    ).toBeTruthy();
    replacing.unmount();

    await renderDetail(
      encoding({
        state: "replaced",
        epochIndex: 10,
        startSeconds: 3000.039,
        endSeconds: 3300.005,
        resumeSeconds: 3300.005,
      }),
    );
    expect(screen.getByText("Continuing from 00:55:00")).toBeTruthy();
  });

  it("keeps a warning on a finished title that was salvaged", async () => {
    const { SourceDamagePanelForTest } = await import("./MediaProcessingPage");
    const { container } = render(
      <MemoryRouter>
        <SourceDamagePanelForTest
          job={job({
            state: "succeeded",
            sourceDamage: [
              {
                type: "source-damage",
                epochIndex: 10,
                sourceStartSeconds: 3000.039,
                sourceEndSeconds: 3300.005,
                expectedDurationSeconds: 299.966,
                lastConfirmedMediaSeconds: 123.29,
                ffmpegByteOffset: 10_074_169_063,
                sourceRetryCount: 4,
                evidence: ["Read error at pos. 10074169063"],
                audioReplaced: true,
                subtitlesAffected: true,
                detectedAt: "2026-09-02T00:00:00.000Z",
              },
            ],
          })}
          t={translate}
        />
      </MemoryRouter>,
    );

    expect(
      screen.getByText("Processing completed with source damage."),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "00:50:00–00:55:00 was replaced because the source file could not be read.",
      ),
    ).toBeTruthy();
    expect(screen.getByText("Sound for this interval is silent.")).toBeTruthy();
    expect(
      screen.getByText(
        "Subtitle cues inside this interval could not be recovered.",
      ),
    ).toBeTruthy();
    // Never a filesystem path, and never the raw byte offset dressed as a time.
    expect(container.textContent).not.toContain("/");
  });

  it("shows nothing at all for a clean encode", async () => {
    const { SourceDamagePanelForTest } = await import("./MediaProcessingPage");
    const { container } = render(
      <MemoryRouter>
        <SourceDamagePanelForTest
          job={job({ state: "succeeded" })}
          t={translate}
        />
      </MemoryRouter>,
    );
    expect(container.textContent).toBe("");
  });
});
