import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, expect, it, vi } from "vitest";
import type { LibraryTitleDetail } from "../../lib/libraryAdminApi";
import { TitlePage } from "./TitlePage";

const api = vi.hoisted(() => ({
  getLibraryTitle: vi.fn(),
  generateTrickplay: vi.fn(),
  requestTitleSubtitles: vi.fn(),
  removeLibraryTitle: vi.fn(),
  uploadTitleSubtitle: vi.fn(),
  searchMissingEpisodes: vi.fn(),
  getMissingSearch: vi.fn(),
}));
vi.mock("../../lib/libraryAdminApi", async (importActual) => ({
  ...(await importActual<typeof import("../../lib/libraryAdminApi")>()),
  ...api,
}));
vi.mock("../../lib/wantedApi", () => ({
  setWanted: vi.fn(),
  releaseSearchUrl: () => "/admin/decisions",
}));
vi.mock("../../lib/mediaApi", () => ({
  getPrimaryImageUrl: () => "",
  getLogoImageUrl: () => "",
  refreshItemMetadata: vi.fn(async () => undefined),
}));
vi.mock("../../lib/pageTitle", () => ({ setPageTitle: vi.fn() }));
vi.mock("../../i18n/LanguageContext", () => ({
  useLanguage: () => ({ t: (key: string) => key }),
}));
vi.mock("../../components/admin/SeriesMonitoringPanel", () => ({
  SeriesMonitoringPanel: () => <p>monitoring panel</p>,
}));
vi.mock("../TmdbArtworkPage", () => ({
  default: ({ itemId }: { itemId: string }) => <p>artwork for {itemId}</p>,
}));

const ID = "11111111-1111-4111-8111-111111111111";
const detail = (
  over: Partial<LibraryTitleDetail> = {},
): LibraryTitleDetail => ({
  id: ID,
  kind: "movie",
  title: "Dune",
  year: 2021,
  desired: false,
  tmdbId: null,
  imdbId: null,
  episodeCount: 0,
  availableEpisodeCount: 0,
  status: "downloaded",
  hasMedia: true,
  downloading: 0,
  importing: 0,
  processing: 0,
  sizeBytes: 1,
  resolution: 2160,
  audioLanguages: ["eng"],
  subtitleLanguages: ["tur"],
  pendingSubtitles: [],
  files: 1,
  trickplayFiles: 0,
  pendingTrickplay: 0,
  artwork: { coverTag: null, logoTag: null, logoLayout: null, missing: true },
  mediaFileId: "f",
  fileName: "Dune.2021.mkv",
  seasons: [],
  catalogueComplete: true,
  ...over,
});

function renderAt(path = `/admin/library/${ID}`) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/admin/library/:itemId" element={<TitlePage />} />
        <Route path="/admin/library" element={<p>library list</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  api.getLibraryTitle.mockResolvedValue(detail());
  api.generateTrickplay.mockResolvedValue({
    queued: 1,
    alreadyGenerated: 0,
    notReady: 0,
  });
});

it("generates missing trickplay, or rebuilds it, for this one film", async () => {
  renderAt();
  fireEvent.click(await screen.findByText("library.generateMissing"));
  await waitFor(() =>
    expect(api.generateTrickplay).toHaveBeenCalledWith(ID, false),
  );
  fireEvent.click(screen.getByText("library.rebuildAll"));
  await waitFor(() =>
    expect(api.generateTrickplay).toHaveBeenCalledWith(ID, true),
  );
});

it("edits the film's artwork and metadata in place", async () => {
  renderAt(`/admin/library/${ID}?tab=artwork`);
  expect(await screen.findByText(`artwork for ${ID}`)).toBeTruthy();
});

it("gives a show its episodes and monitoring, and a film neither", async () => {
  renderAt();
  await screen.findByText("Dune");
  expect(
    screen.queryByRole("tab", { name: "library.tab.episodes" }),
  ).toBeNull();

  api.getLibraryTitle.mockResolvedValue(
    detail({ kind: "series", title: "Andor", files: 2 }),
  );
  renderAt(`/admin/library/${ID}?tab=monitoring`);
  expect(await screen.findByText("monitoring panel")).toBeTruthy();
  expect(
    screen.getByRole("tab", { name: "library.tab.episodes" }),
  ).toBeTruthy();
});

it("says so when the title is gone", async () => {
  api.getLibraryTitle.mockRejectedValue({ status: 404 });
  renderAt();
  expect(await screen.findByText("library.titleMissing")).toBeTruthy();
});

/**
 * The file the operator already has.
 *
 * What is checked is the contract the control exists for: the file's own name
 * never leaves the page, the policy chosen beside the button is what is sent,
 * and the name the server gave the file is what comes back to the operator.
 */
it("uploads a subtitle for a film under the policy beside the button", async () => {
  api.uploadTitleSubtitle.mockResolvedValue({
    outcome: "installed",
    relativePath: "Movies/Dune (2021)/Dune (2021).tur.srt",
    fileName: "Dune (2021).tur.srt",
    language: "tur",
    cueCount: 812,
    attached: true,
  });
  renderAt();

  const picker = (await screen.findByLabelText(
    "library.uploadSubtitle",
  )) as HTMLElement;
  fireEvent.click(picker);
  const input = document.querySelector(
    'input[type="file"]',
  ) as HTMLInputElement;
  const file = new File(
    ["1\n00:00:01,000 --> 00:00:02,000\nHi\n\n"],
    "[YTS] dune.tr.srt",
    {
      type: "application/x-subrip",
    },
  );
  fireEvent.change(input, { target: { files: [file] } });

  await waitFor(() =>
    expect(api.uploadTitleSubtitle).toHaveBeenCalledWith(ID, file, {
      language: "tur",
      forced: false,
      replace: false,
    }),
  );
  // The renamed file is the answer worth showing.
  expect(await screen.findByText(/Dune \(2021\)\.tur\.srt/)).toBeTruthy();
});

it("sends the chosen language rather than the default", async () => {
  api.uploadTitleSubtitle.mockResolvedValue({
    outcome: "duplicate",
    relativePath: "x",
    fileName: "Dune (2021).eng.srt",
    language: "eng",
    cueCount: null,
    attached: false,
  });
  renderAt();

  fireEvent.change(await screen.findByLabelText("library.subtitleLanguage"), {
    target: { value: "eng" },
  });
  fireEvent.click(screen.getByLabelText("library.subtitleForced"));
  const input = document.querySelector(
    'input[type="file"]',
  ) as HTMLInputElement;
  fireEvent.change(input, {
    target: { files: [new File(["x"], "s.srt")] },
  });

  await waitFor(() =>
    expect(api.uploadTitleSubtitle).toHaveBeenCalledWith(
      ID,
      expect.anything(),
      { language: "eng", forced: true, replace: false },
    ),
  );
});

it("shows the server's own refusal, which is the only thing that says what to do", async () => {
  api.uploadTitleSubtitle.mockRejectedValue(
    Object.assign(
      new Error(
        "The destination holds a subtitle this system did not install.",
      ),
      { status: 409 },
    ),
  );
  renderAt();

  const input = (await screen
    .findByLabelText("library.uploadSubtitle")
    .then(() =>
      document.querySelector('input[type="file"]'),
    )) as HTMLInputElement;
  fireEvent.change(input, {
    target: { files: [new File(["x"], "s.srt")] },
  });

  expect(await screen.findByText(/did not install/)).toBeTruthy();
});

it("sends a show's operator to the episode the subtitle belongs to", async () => {
  api.getLibraryTitle.mockResolvedValue(
    detail({ kind: "series", title: "Andor", files: 2, episodeCount: 2 }),
  );
  renderAt();

  expect(await screen.findByText("library.uploadPerEpisode")).toBeTruthy();
  // No film-level picker on a show: it would file the file against one episode.
  expect(screen.queryByLabelText("library.subtitleLanguage")).toBeNull();
});

it("uploads to the episode a file belongs to, under the list's one policy", async () => {
  const episodeId = "22222222-2222-4222-8222-222222222222";
  api.getLibraryTitle.mockResolvedValue(
    detail({
      kind: "series",
      title: "Andor",
      files: 2,
      episodeCount: 1,
      seasons: [
        {
          id: "s1",
          seasonNumber: 1,
          episodes: [
            {
              id: episodeId,
              seasonNumber: 1,
              episodeNumber: 1,
              title: "Kassa",
              airDate: null,
              mediaFileId: "file-1",
              fileName: "Andor - S01E01.mkv",
              monitored: true,
              hasThumb: false,
              stillUrl: null,
              status: "downloaded",
              hasMedia: true,
              downloading: 0,
              importing: 0,
              processing: 0,
              sizeBytes: 1,
              resolution: 1080,
              audioLanguages: ["eng"],
              subtitleLanguages: [],
              pendingSubtitles: [],
              files: 1,
              trickplayFiles: 0,
              pendingTrickplay: 0,
            },
          ],
        },
      ],
    }),
  );
  api.uploadTitleSubtitle.mockResolvedValue({
    outcome: "installed",
    relativePath: "Series/Andor/Season 1/Andor - S01E01.eng.srt",
    fileName: "Andor - S01E01.eng.srt",
    language: "eng",
    cueCount: 400,
    attached: true,
  });
  renderAt(`/admin/library/${ID}?tab=episodes`);

  fireEvent.change(await screen.findByLabelText("library.subtitleLanguage"), {
    target: { value: "eng" },
  });
  const input = document.querySelector(
    'input[type="file"]',
  ) as HTMLInputElement;
  fireEvent.change(input, {
    target: { files: [new File(["x"], "whatever.srt")] },
  });

  await waitFor(() =>
    // The episode's own id, never the show's.
    expect(api.uploadTitleSubtitle).toHaveBeenCalledWith(
      episodeId,
      expect.anything(),
      { language: "eng", forced: false, replace: false },
    ),
  );
});

it("refreshes itself while open, so a change shows without a reload", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    renderAt();
    await screen.findByText("Dune");
    api.getLibraryTitle.mockResolvedValue(detail({ title: "Dune: Part Two" }));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(api.getLibraryTitle).toHaveBeenLastCalledWith(ID, {
      background: true,
    });
    expect(await screen.findByText("Dune: Part Two")).toBeTruthy();
  } finally {
    vi.useRealTimers();
  }
});

it("searches for a season's missing episodes and says what it started", async () => {
  const episode = (
    number: number,
    over: Partial<LibraryTitleDetail["seasons"][number]["episodes"][number]>,
  ) => ({
    id: null,
    seasonNumber: 6,
    episodeNumber: number,
    title: null,
    airDate: "2007-04-08",
    mediaFileId: null,
    fileName: null,
    monitored: true,
    hasThumb: false,
    stillUrl: null,
    status: "wanted",
    hasMedia: false,
    downloading: 0,
    importing: 0,
    processing: 0,
    sizeBytes: 0,
    resolution: null,
    audioLanguages: [],
    subtitleLanguages: [],
    pendingSubtitles: [],
    files: 0,
    trickplayFiles: 0,
    pendingTrickplay: 0,
    ...over,
  });
  api.getLibraryTitle.mockResolvedValue(
    detail({
      kind: "series",
      title: "The Sopranos",
      seasons: [
        {
          id: null,
          seasonNumber: 6,
          episodes: [
            episode(1, { hasMedia: true, status: "downloaded" }),
            episode(2, {}),
            episode(3, {}),
            episode(4, { downloading: 1 }),
          ],
        },
      ],
    }),
  );
  api.searchMissingEpisodes.mockResolvedValue({ taskId: "t1", episodes: 2 });
  api.getMissingSearch
    .mockResolvedValueOnce({ status: "running", message: null, result: null })
    .mockResolvedValue({
      status: "succeeded",
      message: null,
      result: {
        started: [{ season: 6, episode: 2, release: "Sopranos.S06E02" }],
        nothing: [{ season: 6, episode: 3 }],
        covered: [{ season: 6, episode: null }],
      },
    });
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    renderAt(`/admin/library/${ID}?tab=episodes`);
    // Two are missing; the one downloading is not.
    expect(await screen.findByText("library.searchMissing · 2")).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", {
        name: "library.searchMissingSeason · library.season 6",
      }),
    );
    await waitFor(() =>
      expect(api.searchMissingEpisodes).toHaveBeenCalledWith(ID, 6),
    );
    expect(await screen.findByText("library.missingSearching 2")).toBeTruthy();
    // Every search button waits for this one.
    expect(screen.getByText("library.searchingMissing")).toBeTruthy();

    await vi.advanceTimersByTimeAsync(6_000);
    expect(
      await screen.findByText(
        "library.missingStarted S06E02 · library.missingNothingFor S06E03 · library.missingAlreadyComing S06",
      ),
    ).toBeTruthy();
    expect(screen.getByText("library.searchMissing · 2")).toBeTruthy();
  } finally {
    vi.useRealTimers();
  }
});

it("does not offer a search when nothing is missing", async () => {
  renderAt();
  await screen.findByText("Dune");
  expect(screen.queryByText(/library.searchMissing/)).toBeNull();
});
