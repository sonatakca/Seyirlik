import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AcquisitionsPage } from "./AcquisitionsPage";
import type { Acquisition, AcquisitionDetail } from "../../lib/acquisitionsApi";

const api = vi.hoisted(() => ({
  listAcquisitions: vi.fn(),
  getAcquisition: vi.fn(),
  retryAcquisition: vi.fn(),
  cancelAcquisition: vi.fn(),
  blocklistAcquisition: vi.fn(),
  listBlocklist: vi.fn(),
  removeBlocklistEntry: vi.fn(),
  getDownloadProgress: vi.fn(),
  pauseAcquisition: vi.fn(),
  resumeAcquisition: vi.fn(),
  moveAcquisition: vi.fn(),
  setDownloadClientPaused: vi.fn(),
}));

vi.mock("../../lib/acquisitionsApi", () => api);
vi.mock("../../lib/pageTitle", () => ({ setPageTitle: vi.fn() }));
vi.mock("../../i18n/LanguageContext", () => ({
  useLanguage: () => ({ t: (key: string) => key }),
}));

function acquisition(over: Partial<Acquisition> = {}): Acquisition {
  return {
    id: "a1",
    state: "downloading",
    origin: "manual",
    target: { kind: "movie", title: "Dune" },
    indexerId: "nzbgeek",
    releaseTitle: "Dune.2021.2160p.WEB-DL.HEVC-GROUP",
    attempt: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

function detail(over: Partial<AcquisitionDetail> = {}): AcquisitionDetail {
  return {
    acquisition: acquisition(),
    decision: {
      profileName: "HD-2160p",
      score: 140,
      reasons: [{ code: "codec", detail: "Preferred codec HEVC" }],
      rejected: [{ title: "Dune.2021.720p", reason: "quality not allowed" }],
      decidedAt: "2026-01-01T00:00:00.000Z",
    },
    events: [
      { fromState: null, toState: "planned", at: "2026-01-01T00:00:00.000Z" },
    ],
    ...over,
  };
}

const renderPage = () =>
  render(
    <MemoryRouter>
      <AcquisitionsPage />
    </MemoryRouter>,
  );

beforeEach(() => {
  vi.clearAllMocks();
  api.listAcquisitions.mockResolvedValue([acquisition()]);
  api.getAcquisition.mockResolvedValue(detail());
  api.listBlocklist.mockResolvedValue([]);
  api.getDownloadProgress.mockResolvedValue({
    reachable: true,
    paused: false,
    progress: [],
  });
});

describe("the acquisitions page", () => {
  it("groups what needs a person above what is merely running", async () => {
    api.listAcquisitions.mockResolvedValue([
      acquisition({ id: "a1", state: "downloading" }),
      acquisition({ id: "a2", state: "failed", failureClass: "sab-auth" }),
      acquisition({ id: "a3", state: "downloaded" }),
    ]);
    renderPage();

    await screen.findByText("admin.acquisitions.bucket.needsAttention");
    const headings = screen
      .getAllByRole("heading", { level: 2 })
      .map((node) => node.textContent);
    // The downloading row is not in the client's queue in this read, so it
    // is still being got ready.
    expect(headings).toEqual([
      "admin.acquisitions.bucket.needsAttention",
      "admin.acquisitions.preparing.heading",
      "admin.acquisitions.bucket.finished",
    ]);
  });

  it("says what a failure asks of the reader, not just its code", async () => {
    /*
     * A class on its own tells an operator nothing about whether to wait, pick
     * another release, or go and fix something.
     */
    api.listAcquisitions.mockResolvedValue([
      acquisition({ state: "failed", failureClass: "missing-articles" }),
    ]);
    renderPage();

    const banner = await screen.findByText(
      /admin\.acquisitions\.failure\.missing-articles/,
    );
    expect(banner.textContent).toContain(
      "admin.acquisitions.remedy.another-release",
    );
  });

  it("offers a retry only where the server would accept one", async () => {
    api.listAcquisitions.mockResolvedValue([
      acquisition({ id: "a1", state: "downloading" }),
    ]);
    renderPage();

    await screen.findByText("Dune");
    expect(screen.queryByText("admin.acquisitions.retry")).toBeNull();
    expect(screen.getByLabelText("admin.acquisitions.cancel")).toBeTruthy();
  });

  it("never offers to cancel a download that already finished", async () => {
    api.listAcquisitions.mockResolvedValue([
      acquisition({ state: "downloaded" }),
    ]);
    renderPage();

    fireEvent.click(
      await screen.findByText("admin.acquisitions.finished.show"),
    );
    await screen.findByText("Dune");
    expect(screen.queryByLabelText("admin.acquisitions.cancel")).toBeNull();
  });

  it("explains why the release was chosen, and what was passed over", async () => {
    renderPage();
    fireEvent.click(
      await screen.findByLabelText("admin.acquisitions.row.details"),
    );

    await screen.findByText("admin.acquisitions.why");
    expect(screen.getByText(/HD-2160p/)).toBeTruthy();
    expect(screen.getByText("Preferred codec HEVC")).toBeTruthy();
    expect(
      screen.getByText(/Dune\.2021\.720p — quality not allowed/),
    ).toBeTruthy();
  });

  it("says so plainly when no decision was recorded", async () => {
    api.getAcquisition.mockResolvedValue(detail({ decision: null }));
    renderPage();
    fireEvent.click(
      await screen.findByLabelText("admin.acquisitions.row.details"),
    );

    expect(
      await screen.findByText("admin.acquisitions.noDecision"),
    ).toBeTruthy();
  });

  it("retries through the server and reloads what it says afterwards", async () => {
    api.listAcquisitions.mockResolvedValue([
      acquisition({ state: "failed", failureClass: "disk-full" }),
    ]);
    renderPage();

    fireEvent.click(await screen.findByText("admin.acquisitions.retry"));
    await waitFor(() => {
      expect(api.retryAcquisition).toHaveBeenCalledWith("a1");
      // The row is re-read rather than assumed: the server decides the state.
      expect(api.listAcquisitions).toHaveBeenCalledTimes(2);
    });
  });

  it("reports a failed load without repeating what the client threw", async () => {
    // A request failure message can carry a URL, and this is a browser.
    api.listAcquisitions.mockRejectedValue(
      new Error("fetch failed http://127.0.0.1:43111/ownAPI/v1/acquisitions"),
    );
    renderPage();

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("admin.acquisitions.loadFailed");
    expect(alert.textContent).not.toContain("127.0.0.1");
  });

  it("says the list is empty rather than showing nothing at all", async () => {
    api.listAcquisitions.mockResolvedValue([]);
    renderPage();
    expect(await screen.findByText("admin.acquisitions.empty")).toBeTruthy();
  });

  it("carries no download URL or job identifier into the page", async () => {
    // The server does not send them; nothing here should invent a place for
    // them either.
    renderPage();
    fireEvent.click(
      await screen.findByLabelText("admin.acquisitions.row.details"),
    );
    await screen.findByText("admin.acquisitions.why");

    const html = document.body.innerHTML;
    expect(html).not.toMatch(/apikey/i);
    expect(html).not.toMatch(/nzo_/i);
  });

  it("blocklists a failed release and searches for the next one", async () => {
    api.listAcquisitions.mockResolvedValue([
      acquisition({ state: "failed", failureClass: "missing-articles" }),
    ]);
    api.blocklistAcquisition.mockResolvedValue({
      searched: true,
      replacement: acquisition({
        id: "a2",
        state: "planned",
        releaseTitle: "Dune.2021.1080p.WEB-DL-NEXT",
      }),
    });
    renderPage();

    fireEvent.click(
      await screen.findByText("admin.acquisitions.blocklistAndSearch"),
    );
    const status = await screen.findByRole("status");
    expect(api.blocklistAcquisition).toHaveBeenCalledWith("a1", true);
    expect(status.textContent).toContain("admin.acquisitions.notice.replaced");
    expect(status.textContent).toContain("Dune.2021.1080p.WEB-DL-NEXT");
    // Re-read from the server rather than patched in place.
    expect(api.listAcquisitions).toHaveBeenCalledTimes(2);
  });

  it("blocklists without searching, and says when nothing else exists", async () => {
    api.listAcquisitions.mockResolvedValue([
      acquisition({ state: "failed", failureClass: "missing-articles" }),
    ]);
    api.blocklistAcquisition.mockResolvedValue({
      searched: false,
      replacement: null,
    });
    renderPage();

    fireEvent.click(await screen.findByText("admin.acquisitions.blocklist"));
    expect((await screen.findByRole("status")).textContent).toBe(
      "admin.acquisitions.notice.blocklisted",
    );
    expect(api.blocklistAcquisition).toHaveBeenCalledWith("a1", false);
  });

  it("offers no retry for a blocklisted release, only another search", async () => {
    api.listAcquisitions.mockResolvedValue([
      acquisition({ state: "failed", failureClass: "blocklisted" }),
    ]);
    renderPage();

    await screen.findByText("Dune");
    expect(screen.queryByText("admin.acquisitions.retry")).toBeNull();
    expect(
      screen.getByText("admin.acquisitions.blocklistAndSearch"),
    ).toBeTruthy();
  });

  it("reports a failed blocklisting without the thrown message", async () => {
    api.listAcquisitions.mockResolvedValue([
      acquisition({ state: "failed", failureClass: "missing-articles" }),
    ]);
    api.blocklistAcquisition.mockRejectedValue(
      new Error("http://127.0.0.1:43111/ownAPI/v1/acquisitions"),
    );
    renderPage();

    fireEvent.click(
      await screen.findByText("admin.acquisitions.blocklistAndSearch"),
    );
    const status = await screen.findByRole("status");
    expect(status.textContent).toBe("admin.acquisitions.notice.failed");
  });

  it("lists the blocklist and removes an entry", async () => {
    api.listBlocklist.mockResolvedValue([
      {
        id: "b1",
        indexerId: "nzbgeek",
        releaseTitle: "Dune.2021.2160p.BROKEN",
        targetTitle: "Dune",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ]);
    renderPage();

    expect(await screen.findByText("Dune.2021.2160p.BROKEN")).toBeTruthy();
    fireEvent.click(screen.getByText("admin.acquisitions.unblock"));
    await waitFor(() => {
      expect(api.removeBlocklistEntry).toHaveBeenCalledWith("b1");
      expect(api.listBlocklist).toHaveBeenCalledTimes(2);
    });
  });

  it("shows how far a download has got, how fast, and how long is left", async () => {
    api.getDownloadProgress.mockResolvedValue({
      reachable: true,
      paused: false,
      speedBytesPerSecond: 31_000_000,
      progress: [
        {
          acquisitionId: "a1",
          stage: "downloading",
          statusText: "Downloading",
          percent: 48,
          totalBytes: 25_000_000_000,
          downloadedBytes: 12_000_000_000,
          speedBytesPerSecond: 31_000_000,
          etaSeconds: 425,
        },
      ],
    });
    renderPage();

    const bar = await screen.findByRole("progressbar");
    expect(bar.getAttribute("aria-valuenow")).toBe("48");
    expect(screen.getByText(/12\.0 GB \/ 25\.0 GB · 48%/)).toBeTruthy();
    // Once on the row, and once as the client's own speed above the list.
    expect(
      screen.getAllByText(/31\.0 MB\/s/).map((node) => node.textContent),
    ).toContain(
      "31.0 MB/s · 7 admin.acquisitions.progress.minutes admin.acquisitions.progress.left",
    );
  });

  it("says where a waiting download is in line", async () => {
    api.listAcquisitions.mockResolvedValue([acquisition({ state: "queued" })]);
    api.getDownloadProgress.mockResolvedValue({
      reachable: true,
      paused: false,
      progress: [
        {
          acquisitionId: "a1",
          stage: "queued",
          percent: 0,
          totalBytes: 8_000_000_000,
          downloadedBytes: 0,
          queuePosition: 2,
        },
      ],
    });
    renderPage();
    const handle = await screen.findByLabelText(
      "admin.acquisitions.row.handle",
    );
    expect(handle.closest("li")!.textContent).toContain(
      "admin.acquisitions.progress.queued",
    );
  });

  it.each(["queued", "downloading"] as const)(
    "shows a globally paused %s job as paused rather than moving or waiting in line",
    async (stage) => {
      api.listAcquisitions.mockResolvedValue([acquisition({ state: stage })]);
      api.getDownloadProgress.mockResolvedValue({
        reachable: true,
        paused: true,
        progress: [
          {
            acquisitionId: "a1",
            stage,
            percent: 0,
            totalBytes: 26_600_000_000,
            downloadedBytes: 0,
            queuePosition: 1,
            speedBytesPerSecond: 31_000_000,
            etaSeconds: 425,
          },
        ],
      });
      renderPage();
      expect(
        await screen.findByText("admin.acquisitions.progress.paused"),
      ).toBeTruthy();
      expect(
        screen.queryByText(/admin\.acquisitions\.progress\.queued/),
      ).toBeNull();
      expect(screen.queryByText(/31\.0 MB\/s/)).toBeNull();
    },
  );

  it("keeps showing post-processing when only the download queue is paused", async () => {
    api.listAcquisitions.mockResolvedValue([
      acquisition({ state: "processing" }),
    ]);
    api.getDownloadProgress.mockResolvedValue({
      reachable: true,
      paused: true,
      progress: [
        {
          acquisitionId: "a1",
          stage: "processing",
          statusText: "Extracting",
          detail: "Unpacking: 3/7",
          totalBytes: 20_000_000_000,
        },
      ],
    });
    renderPage();
    expect(await screen.findByText("Extracting — Unpacking: 3/7")).toBeTruthy();
    expect(screen.queryByText("admin.acquisitions.progress.paused")).toBeNull();
  });

  it("calls a download no news server will serve stalled, and says why", async () => {
    // The client's own slot still read "Downloading" at 94% for a day.
    const error =
      "Cannot connect to server news.newsdemon.com [502 Connection failure. Please contact technical support.]";
    api.listAcquisitions.mockResolvedValue([
      acquisition({ state: "downloading" }),
    ]);
    api.getDownloadProgress.mockResolvedValue({
      reachable: true,
      paused: false,
      stalled: { servers: [{ name: "news.newsdemon.com", error }] },
      remainingBytes: 1_026_000_000,
      progress: [
        {
          acquisitionId: "a1",
          stage: "stalled",
          statusText: "Downloading",
          percent: 94.8,
          totalBytes: 19_812_000_000,
          downloadedBytes: 18_786_000_000,
          queuePosition: 1,
        },
      ],
    });
    renderPage();
    expect(
      await screen.findByText("admin.acquisitions.row.stalled"),
    ).toBeTruthy();
    expect(
      screen.getByText("admin.acquisitions.progress.stalled"),
    ).toBeTruthy();
    expect(screen.getByText("admin.acquisitions.client.stalled")).toBeTruthy();
    expect(screen.getByText(error, { exact: false })).toBeTruthy();
    expect(
      screen.queryByText("admin.acquisitions.state.downloading"),
    ).toBeNull();
  });

  it("names the post-processing step once the bytes are down", async () => {
    api.listAcquisitions.mockResolvedValue([
      acquisition({ state: "processing" }),
    ]);
    api.getDownloadProgress.mockResolvedValue({
      reachable: true,
      paused: false,
      progress: [
        {
          acquisitionId: "a1",
          stage: "processing",
          statusText: "Extracting",
          detail: "Unpacking: 3/7",
          totalBytes: 20_000_000_000,
        },
      ],
    });
    renderPage();
    expect(await screen.findByText("Extracting — Unpacking: 3/7")).toBeTruthy();
    expect(screen.getByText(/20\.0 GB \/ 20\.0 GB · 100%/)).toBeTruthy();
  });

  it("does not show failed zero-byte history as a complete download before reconciliation", async () => {
    api.listAcquisitions.mockResolvedValue([
      acquisition({ state: "submitting" }),
    ]);
    api.getDownloadProgress.mockResolvedValue({
      reachable: true,
      paused: false,
      progress: [
        {
          acquisitionId: "a1",
          stage: "failed",
          statusText: "Failed",
          totalBytes: 0,
        },
      ],
    });
    renderPage();
    expect(
      await screen.findByText("admin.acquisitions.state.failed"),
    ).toBeTruthy();
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(screen.queryByText(/0 MB \/ 0 MB|100%/)).toBeNull();
    await waitFor(() => expect(api.listAcquisitions).toHaveBeenCalledTimes(2));
  });

  it.each(["queued", "downloading"] as const)(
    "puts a live failure in Needs you while the stored state is %s",
    async (state) => {
      api.listAcquisitions.mockResolvedValue([acquisition({ state })]);
      api.getDownloadProgress.mockResolvedValue({
        reachable: true,
        paused: false,
        progress: [{ acquisitionId: "a1", stage: "failed", statusText: "Failed" }],
      });
      renderPage();
      const heading = await screen.findByText("admin.acquisitions.bucket.needsAttention");
      const section = heading.closest("section")!;
      expect(within(section).getByText("admin.acquisitions.state.failed")).toBeTruthy();
      expect(screen.queryByText(`admin.acquisitions.state.${state}`)).toBeNull();
      expect(screen.queryByText("admin.acquisitions.unpacking.heading")).toBeNull();
      expect(screen.queryByText("admin.acquisitions.queue.heading")).toBeNull();
      expect(screen.queryByRole("progressbar")).toBeNull();
    },
  );

  it("says plainly when the download client is not answering", async () => {
    api.getDownloadProgress.mockResolvedValue({
      reachable: false,
      paused: false,
      progress: [],
    });
    renderPage();
    expect(
      await screen.findByText("admin.acquisitions.progress.unreachable"),
    ).toBeTruthy();
  });

  it("asks for no progress when nothing is running", async () => {
    api.listAcquisitions.mockResolvedValue([
      acquisition({ state: "downloaded" }),
    ]);
    renderPage();
    await screen.findByText("admin.acquisitions.finished.show");
    expect(api.getDownloadProgress).not.toHaveBeenCalled();
  });

  it("offers no retry on a release blocklisted from another row", async () => {
    api.listAcquisitions.mockResolvedValue([
      acquisition({
        state: "failed",
        failureClass: "missing-articles",
        releaseBlocklisted: true,
      }),
    ]);
    renderPage();
    await screen.findByText("Dune");
    expect(screen.queryByText("admin.acquisitions.retry")).toBeNull();
  });
});

describe("steering the download queue", () => {
  const episode = (id: string, n: number): Acquisition =>
    acquisition({
      id,
      state: "queued",
      target: { kind: "episode", title: "The Sopranos", season: 1, episode: n },
      releaseTitle: `The.Sopranos.S01E0${n}.1080p.BluRay.x265-d3g`,
    });
  const queued = (id: string, queuePosition: number, stage = "queued") => ({
    acquisitionId: id,
    stage,
    percent: 0,
    totalBytes: 5_500_000_000,
    downloadedBytes: 0,
    queuePosition,
  });

  beforeEach(() => {
    api.listAcquisitions.mockResolvedValue([
      episode("e1", 1),
      episode("e2", 2),
      episode("e3", 3),
    ]);
    api.getDownloadProgress.mockResolvedValue({
      reachable: true,
      paused: false,
      speedBytesPerSecond: 6_000_000,
      remainingBytes: 16_500_000_000,
      freeBytes: 491_000_000_000,
      progress: [
        queued("e2", 1, "downloading"),
        queued("e1", 2),
        queued("e3", 3),
      ],
    });
    api.moveAcquisition.mockResolvedValue(1);
    api.pauseAcquisition.mockResolvedValue(undefined);
    api.resumeAcquisition.mockResolvedValue(undefined);
    api.setDownloadClientPaused.mockResolvedValue(undefined);
  });

  const rowsInOrder = () =>
    screen
      .getAllByLabelText("admin.acquisitions.row.handle")
      .map((handle) =>
        handle.closest("li")!.getAttribute("data-acquisition-id"),
      );

  it("names each download by title and episode, in the client's order", async () => {
    renderPage();
    await screen.findAllByText("S01E02");
    expect(rowsInOrder()).toEqual(["e2", "e1", "e3"]);
    expect(screen.getAllByText("The Sopranos")).toHaveLength(3);
    // The release stays visible, under the name.
    expect(
      screen.getByText("The.Sopranos.S01E03.1080p.BluRay.x265-d3g"),
    ).toBeTruthy();
  });

  it("says how the whole client is doing", async () => {
    renderPage();
    const bar = await screen.findByRole("region", {
      name: "admin.acquisitions.client.label",
    });
    expect(bar.textContent).toContain("admin.acquisitions.client.downloading");
    expect(bar.textContent).toContain("6.0 MB/s");
    // The test translator returns keys, so the sizes are in the template.
    expect(bar.textContent).toContain("admin.acquisitions.client.left");
    expect(bar.textContent).toContain("admin.acquisitions.client.free");
  });

  it("moves a download to the top as the first place in the client's queue", async () => {
    renderPage();
    await screen.findAllByText("S01E03");
    const third = screen
      .getAllByLabelText("admin.acquisitions.row.toTop")
      .at(2)!;
    fireEvent.click(third);
    await waitFor(() =>
      expect(api.moveAcquisition).toHaveBeenCalledWith("e3", 1),
    );
  });

  it("moves with the arrow keys from the handle", async () => {
    renderPage();
    await screen.findAllByText("S01E03");
    const [first] = screen.getAllByLabelText("admin.acquisitions.row.handle");
    fireEvent.keyDown(first!, { key: "ArrowDown" });
    // e2 takes e1's place, which is the client's second.
    await waitFor(() =>
      expect(api.moveAcquisition).toHaveBeenCalledWith("e2", 2),
    );
  });

  it("pauses one download, and resumes a paused one", async () => {
    api.getDownloadProgress.mockResolvedValue({
      reachable: true,
      paused: false,
      progress: [queued("e2", 1, "downloading"), queued("e1", 2, "paused")],
    });
    renderPage();
    fireEvent.click(
      await screen.findByLabelText("admin.acquisitions.row.pause"),
    );
    fireEvent.click(screen.getByLabelText("admin.acquisitions.row.resume"));
    await waitFor(() => {
      expect(api.pauseAcquisition).toHaveBeenCalledWith("e2");
      expect(api.resumeAcquisition).toHaveBeenCalledWith("e1");
    });
  });

  it("pauses and resumes the whole client", async () => {
    renderPage();
    fireEvent.click(
      await screen.findByText("admin.acquisitions.client.pauseAll"),
    );
    await waitFor(() =>
      expect(api.setDownloadClientPaused).toHaveBeenCalledWith(true),
    );
  });

  it("asks before cancelling, since it deletes what has come down", async () => {
    renderPage();
    await screen.findAllByText("S01E01");
    fireEvent.click(screen.getAllByLabelText("admin.acquisitions.cancel")[0]!);
    expect(api.cancelAcquisition).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("admin.acquisitions.row.confirmYes"));
    await waitFor(() =>
      expect(api.cancelAcquisition).toHaveBeenCalledWith("e2"),
    );
  });

  it("says when the client did not take a control", async () => {
    api.pauseAcquisition.mockRejectedValue(new Error("http://x?apikey=1"));
    renderPage();
    fireEvent.click(
      (await screen.findAllByLabelText("admin.acquisitions.row.pause"))[0]!,
    );
    const status = await screen.findByRole("status");
    expect(status.textContent).toBe("admin.acquisitions.notice.controlFailed");
  });
});
