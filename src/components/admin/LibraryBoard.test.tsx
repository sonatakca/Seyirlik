import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, expect, it, vi } from "vitest";
import type { LibraryTitle } from "../../lib/libraryAdminApi";
import {
  getNotifications,
  resetNotificationsForTests,
} from "../../lib/notifications/notificationStore";
import { LibraryBoard } from "./LibraryBoard";

const api = vi.hoisted(() => ({
  listLibraryTitles: vi.fn(),
  getLibraryTitle: vi.fn(),
  removeLibraryTitle: vi.fn(),
  requestTitleSubtitles: vi.fn(),
  generateTrickplay: vi.fn(),
  importMissingArtwork: vi.fn(async () => ({ queued: 0 })),
  uploadTitleSubtitle: vi.fn(),
  getSubtitleSyncTracks: vi.fn(),
}));
vi.mock("../../lib/libraryAdminApi", async (importActual) => ({
  ...(await importActual<typeof import("../../lib/libraryAdminApi")>()),
  ...api,
}));
vi.mock("../../lib/inventoryExport", () => ({ downloadInventory: vi.fn() }));
vi.mock("../../lib/wantedApi", () => ({
  setWanted: vi.fn(),
  releaseSearchUrl: () => "/admin/decisions",
}));
vi.mock("../../i18n/LanguageContext", () => ({
  useLanguage: () => ({ t: (key: string) => key }),
}));

const facts = {
  status: "downloaded",
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
};
const title = (over: Partial<LibraryTitle>): LibraryTitle => ({
  ...facts,
  id: "id",
  kind: "movie",
  title: "Title",
  year: 2000,
  desired: false,
  tmdbId: null,
  imdbId: null,
  episodeCount: 0,
  availableEpisodeCount: 0,
  artwork: { coverTag: "c1", logoTag: null, logoLayout: null, missing: false },
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  resetNotificationsForTests();
  api.listLibraryTitles.mockImplementation(async (kind: string) =>
    kind === "book"
      ? []
      : kind === "movie"
        ? [
            title({
              id: "held",
              title: "Held",
              hasMedia: true,
              sizeBytes: 5 * 1024 ** 3,
              resolution: 1080,
              audioLanguages: ["tur", "eng"],
              subtitleLanguages: ["tur"],
              files: 1,
            }),
            title({
              id: "coming",
              title: "Coming",
              downloading: 1,
              status: "downloading",
            }),
            title({
              id: "wanted",
              title: "Wanted",
              desired: true,
              status: "wanted",
            }),
          ]
        : [
            title({
              id: "show",
              kind: "series",
              title: "Show",
              hasMedia: true,
              episodeCount: 2,
              availableEpisodeCount: 1,
            }),
          ],
  );
});

function renderBoard() {
  return render(
    <MemoryRouter>
      <LibraryBoard />
    </MemoryRouter>,
  );
}

it("colours each title by what it holds and says what is on disk", async () => {
  renderBoard();
  const held = (await screen.findByText("Held")).closest("li")!;
  expect(held.className).toContain("border-emerald-400/30");
  expect(
    within(held).getByText(/1080p · 5\.0 GB · library\.audio TUR, ENG/),
  ).toBeTruthy();
  expect(screen.getByText("Coming").closest("li")!.className).toContain(
    "border-violet-400/30",
  );
  expect(screen.getByText("Wanted").closest("li")!.className).toContain(
    "border-red-400/30",
  );
});

it("switches to shows and lists a show's seasons and episodes", async () => {
  api.getLibraryTitle.mockResolvedValue({
    ...title({ id: "show", kind: "series", title: "Show", hasMedia: true }),
    mediaFileId: null,
    fileName: null,
    catalogueComplete: true,
    seasons: [
      {
        id: "s1",
        seasonNumber: 1,
        episodes: [
          {
            ...facts,
            hasMedia: true,
            files: 1,
            id: "e1",
            seasonNumber: 1,
            episodeNumber: 1,
            title: "Pilot",
            airDate: null,
            mediaFileId: "f1",
            fileName: "Show.S01E01.mkv",
            monitored: true,
          },
          {
            ...facts,
            status: "wanted",
            id: null,
            seasonNumber: 1,
            episodeNumber: 2,
            title: "Second",
            airDate: "2020-01-01",
            mediaFileId: null,
            fileName: null,
            monitored: true,
          },
        ],
      },
    ],
  });
  renderBoard();
  fireEvent.click(await screen.findByRole("tab", { name: /library\.shows/ }));
  fireEvent.click(
    await screen.findByRole("button", { name: /library\.seasons/ }),
  );
  expect(await screen.findByText("Pilot")).toBeTruthy();
  expect(screen.getByText("Second")).toBeTruthy();
  // Only the episode with a file can be searched for.
  expect(
    screen.getAllByRole("button", { name: /library\.findTurkish · E0/ }),
  ).toHaveLength(1);
});

it("filters by colour", async () => {
  renderBoard();
  await screen.findByText("Held");
  fireEvent.click(
    screen.getByRole("button", { name: /library\.tone\.wanted/ }),
  );
  expect(screen.queryByText("Held")).toBeNull();
  expect(screen.getByText("Wanted")).toBeTruthy();
});

it("removes a title only once its name is typed", async () => {
  api.removeLibraryTitle.mockResolvedValue({
    itemId: "held",
    title: "Held",
    folder: "Movies/Held (2000)",
    state: "done",
    filesRemoved: 1,
    downloadsCancelled: 0,
    leftovers: [],
  });
  renderBoard();
  const row = (await screen.findByText("Held")).closest("li")!;
  fireEvent.click(within(row).getByRole("button", { name: /library\.remove/ }));
  const dialog = screen.getByRole("alertdialog");
  const confirm = within(dialog).getByRole("button", {
    name: "library.removeConfirm",
  });
  expect((confirm as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(within(dialog).getByRole("textbox"), {
    target: { value: "Held" },
  });
  expect((confirm as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(confirm);
  await waitFor(() =>
    expect(api.removeLibraryTitle).toHaveBeenCalledWith("held", "Held"),
  );
  // The dialog closes, the row goes, and the corner card says so.
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(screen.queryByText("Held")).toBeNull();
  expect(getNotifications()[0]).toMatchObject({
    tone: "success",
    title: "library.removed Held",
  });
});

it("hands a slow removal to the corner card when the dialog is closed", async () => {
  let answer!: (value: unknown) => void;
  api.removeLibraryTitle.mockReturnValue(
    new Promise((resolve) => (answer = resolve)),
  );
  renderBoard();
  const row = (await screen.findByText("Held")).closest("li")!;
  fireEvent.click(within(row).getByRole("button", { name: /library\.remove/ }));
  const dialog = screen.getByRole("alertdialog");
  fireEvent.change(within(dialog).getByRole("textbox"), {
    target: { value: "Held" },
  });
  fireEvent.click(
    within(dialog).getByRole("button", { name: "library.removeConfirm" }),
  );
  fireEvent.click(
    await within(dialog).findByRole("button", { name: "library.removeHide" }),
  );
  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(getNotifications()[0]).toMatchObject({
    tone: "progress",
    title: "library.removalRunning Held",
  });
  answer({
    itemId: "held",
    title: "Held",
    folder: null,
    state: "done",
    filesRemoved: 1,
    downloadsCancelled: 0,
    leftovers: [],
  });
  await waitFor(() => expect(screen.queryByText("Held")).toBeNull());
  expect(getNotifications()).toHaveLength(1);
  expect(getNotifications()[0]).toMatchObject({ tone: "success" });
});

it("starts a subtitle search for a whole title", async () => {
  api.requestTitleSubtitles.mockResolvedValue({ files: 1, queued: 1 });
  renderBoard();
  const row = (await screen.findByText("Held")).closest("li")!;
  fireEvent.click(
    within(row).getByRole("button", { name: /library\.findTurkish/ }),
  );
  await waitFor(() =>
    expect(api.requestTitleSubtitles).toHaveBeenCalledWith("held", "tur"),
  );
  expect(await screen.findByText("library.subtitlesQueued 1/1")).toBeTruthy();
});

it("generates trickplay for one film from its row", async () => {
  api.generateTrickplay.mockResolvedValue({
    queued: 1,
    alreadyGenerated: 0,
    notReady: 0,
  });
  renderBoard();
  const row = (await screen.findByText("Held")).closest("li")!;
  fireEvent.click(
    within(row).getByRole("button", { name: /library\.generateTrickplay/ }),
  );
  await waitFor(() =>
    expect(api.generateTrickplay).toHaveBeenCalledWith("held", false),
  );
  expect(await screen.findByText("library.trickplayQueued 1")).toBeTruthy();
});

it("offers trickplay per season and per episode of a show", async () => {
  api.getLibraryTitle.mockResolvedValue({
    ...title({ id: "show", kind: "series", title: "Show", hasMedia: true }),
    mediaFileId: null,
    fileName: null,
    catalogueComplete: true,
    seasons: [
      {
        id: "season-1",
        seasonNumber: 1,
        episodes: [
          {
            ...facts,
            hasMedia: true,
            files: 1,
            id: "e1",
            seasonNumber: 1,
            episodeNumber: 1,
            title: "Pilot",
            airDate: null,
            mediaFileId: "f1",
            fileName: null,
            monitored: true,
          },
        ],
      },
    ],
  });
  api.generateTrickplay.mockResolvedValue({
    queued: 1,
    alreadyGenerated: 0,
    notReady: 0,
  });
  renderBoard();
  fireEvent.click(await screen.findByRole("tab", { name: /library\.shows/ }));
  fireEvent.click(
    await screen.findByRole("button", { name: /library\.seasons/ }),
  );
  fireEvent.click(
    await screen.findByRole("button", {
      name: "library.generateTrickplay · library.season 1",
    }),
  );
  await waitFor(() =>
    expect(api.generateTrickplay).toHaveBeenCalledWith("season-1", false),
  );
  fireEvent.click(
    await screen.findByRole("button", {
      name: "library.generateTrickplay · E01",
    }),
  );
  await waitFor(() =>
    expect(api.generateTrickplay).toHaveBeenCalledWith("e1", false),
  );
});

it("asks TMDB once for artwork when a matched title has no readable cover", async () => {
  api.importMissingArtwork.mockResolvedValue({ queued: 1 });
  api.listLibraryTitles.mockImplementation(async (kind: string) =>
    kind === "movie"
      ? [
          title({
            id: "gone",
            title: "Oppenheimer",
            desired: true,
            status: "wanted",
            tmdbId: "872585",
            artwork: {
              coverTag: null,
              logoTag: null,
              logoLayout: null,
              missing: true,
            },
          }),
        ]
      : [],
  );
  renderBoard();
  expect(await screen.findByText("library.artworkImporting 1")).toBeTruthy();
  expect(api.importMissingArtwork).toHaveBeenCalledTimes(1);
});

it("places a title's logo where it was adjusted to sit", async () => {
  api.listLibraryTitles.mockImplementation(async (kind: string) =>
    kind === "movie"
      ? [
          title({
            id: "logo",
            title: "Dune",
            hasMedia: true,
            artwork: {
              coverTag: "c",
              logoTag: "l",
              logoLayout: { x: 0.5, y: 0.25, width: 0.6, shadow: 1 },
              missing: false,
            },
          }),
        ]
      : [],
  );
  const { container } = renderBoard();
  await screen.findByText("Dune");
  const placed = container.querySelector('[style*="left: 50%"]') as HTMLElement;
  expect(placed?.style.top).toBe("25%");
  expect(placed?.style.width).toMatch(/^calc\(60% \+ \d+px\)$/);
  expect(placed?.querySelector("img")).toBeTruthy();
});

/**
 * The board is where an operator actually works, so the upload has to be here
 * and not only on a title's own page. Pinned because it was missing from this
 * screen once already.
 */
it("takes a subtitle for a film from the board itself", async () => {
  api.uploadTitleSubtitle.mockResolvedValue({
    outcome: "installed",
    relativePath: "Movies/Held/Held.tur.srt",
    fileName: "Held.tur.srt",
    language: "tur",
    cueCount: 12,
    attached: true,
  });
  renderBoard();

  const held = (await screen.findByText("Held")).closest("li")!;
  const input = within(held)
    .getByLabelText("library.uploadSubtitle · Held")
    .parentElement!.querySelector('input[type="file"]') as HTMLInputElement;
  const file = new File(["1\n00:00:01,000 --> 00:00:02,000\nHi\n\n"], "x.srt");
  fireEvent.change(input, { target: { files: [file] } });

  await waitFor(() =>
    expect(api.uploadTitleSubtitle).toHaveBeenCalledWith("held", file, {
      language: "tur",
      forced: false,
      replace: false,
    }),
  );
  expect(await screen.findByText(/Held\.tur\.srt/)).toBeTruthy();
});

it("offers no film-level upload on a show, whose episodes carry their own", async () => {
  renderBoard();
  fireEvent.click(await screen.findByText("library.shows"));

  const show = (await screen.findByText("Show")).closest("li")!;
  expect(
    within(show).queryByLabelText("library.uploadSubtitle · Show"),
  ).toBeNull();
});

it("uses the board's one language for whatever is uploaded next", async () => {
  api.uploadTitleSubtitle.mockResolvedValue({
    outcome: "duplicate",
    relativePath: "x",
    fileName: "Held.eng.srt",
    language: "eng",
    cueCount: null,
    attached: false,
  });
  renderBoard();
  await screen.findByText("Held");

  fireEvent.change(screen.getByLabelText("library.subtitleLanguage"), {
    target: { value: "eng" },
  });
  const held = screen.getByText("Held").closest("li")!;
  const input = within(held)
    .getByLabelText("library.uploadSubtitle · Held")
    .parentElement!.querySelector('input[type="file"]') as HTMLInputElement;
  fireEvent.change(input, { target: { files: [new File(["x"], "x.srt")] } });

  await waitFor(() =>
    expect(api.uploadTitleSubtitle).toHaveBeenCalledWith(
      "held",
      expect.anything(),
      { language: "eng", forced: false, replace: false },
    ),
  );
});

it("takes a subtitle for one episode from the expanded season", async () => {
  api.getLibraryTitle.mockResolvedValue({
    ...title({ id: "show", kind: "series", title: "Show", hasMedia: true }),
    mediaFileId: null,
    fileName: null,
    catalogueComplete: true,
    seasons: [
      {
        id: "s1",
        seasonNumber: 1,
        episodes: [
          {
            ...facts,
            hasMedia: true,
            files: 1,
            id: "e1",
            seasonNumber: 1,
            episodeNumber: 1,
            title: "Pilot",
            airDate: null,
            mediaFileId: "f1",
            fileName: "Show.S01E01.mkv",
            monitored: true,
          },
        ],
      },
    ],
  });
  api.uploadTitleSubtitle.mockResolvedValue({
    outcome: "installed",
    relativePath: "Series/Show/Season 1/Show.S01E01.tur.srt",
    fileName: "Show.S01E01.tur.srt",
    language: "tur",
    cueCount: 9,
    attached: true,
  });
  renderBoard();
  fireEvent.click(await screen.findByRole("tab", { name: /library\.shows/ }));
  fireEvent.click(
    await screen.findByRole("button", { name: /library\.seasons/ }),
  );

  const episode = (await screen.findByText("Pilot")).closest("li")!;
  const input = within(episode)
    .getByLabelText("library.uploadSubtitle · E01")
    .parentElement!.querySelector('input[type="file"]') as HTMLInputElement;
  fireEvent.change(input, { target: { files: [new File(["x"], "x.srt")] } });

  await waitFor(() =>
    // The episode's own id, never the show's.
    expect(api.uploadTitleSubtitle).toHaveBeenCalledWith(
      "e1",
      expect.anything(),
      { language: "tur", forced: false, replace: false },
    ),
  );
});

it("opens a film's subtitle sync under its own row, and not on a show", async () => {
  api.getSubtitleSyncTracks.mockResolvedValue({
    mediaFileId: "f",
    subtitles: [],
    audio: [],
  });
  render(
    <MemoryRouter>
      <LibraryBoard />
    </MemoryRouter>,
  );
  const open = await screen.findByRole("button", {
    name: "library.syncSubtitle · Held",
  });
  expect(open.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(open);
  expect(open.getAttribute("aria-expanded")).toBe("true");
  await waitFor(() =>
    expect(api.getSubtitleSyncTracks).toHaveBeenCalledWith("held"),
  );
  // Opened straight to the choice, not to a second button.
  expect(await screen.findByText("library.syncNoTarget")).toBeTruthy();
  fireEvent.click(open);
  expect(screen.queryByText("library.syncNoTarget")).toBeNull();

  fireEvent.click(screen.getByRole("tab", { name: /library\.shows/ }));
  await screen.findByText("Show");
  expect(
    screen.queryByRole("button", { name: /^library\.syncSubtitle · / }),
  ).toBeNull();
});
