import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, expect, it, vi } from "vitest";
import type { ArtworkOverview } from "../lib/artworkApi";
import type { MediaItem } from "../lib/types";
import TmdbArtworkPage from "./TmdbArtworkPage";

const media = vi.hoisted(() => ({
  getAllArtworkItems: vi.fn(),
  getItem: vi.fn(),
  getLogoImageUrl: (id: string, tag?: string) => `/logo/${id}/${tag}`,
  getPrimaryImageUrl: (id: string, tag?: string) => `/cover/${id}/${tag}`,
}));
const artworkApi = vi.hoisted(() => ({
  applyItemArtwork: vi.fn(async () => ({})),
  clearItemArtwork: vi.fn(),
  getItemArtwork: vi.fn(),
  getLocalizedMetadataPreview: vi.fn(),
  identifyItem: vi.fn(),
  saveItemDisplayMetadata: vi.fn(),
  searchMetadataCandidates: vi.fn(),
  setLogoLayout: vi.fn(async () => undefined),
  uploadCustomArtwork: vi.fn(),
}));
vi.mock("../lib/mediaApi", () => media);
vi.mock("../lib/artworkApi", () => artworkApi);
vi.mock("../lib/pageTitle", () => ({ setPageTitle: vi.fn() }));
vi.mock("../lib/notifications/notificationStore", () => ({ notify: vi.fn() }));
vi.mock("../i18n/LanguageContext", () => ({
  useLanguage: () => ({ t: (key: string) => key, language: "en" }),
}));

const DUNE = {
  Id: "dune",
  Name: "Dune",
  Type: "Movie",
  ProductionYear: 2021,
  ImageTags: { Primary: "c1", Logo: "l1" },
  LogoLayout: { x: 0.5, y: 0.3, width: 0.6, shadow: 1 },
} as MediaItem;
const ARCANE = {
  Id: "arcane",
  Name: "Arcane",
  Type: "Series",
  ProductionYear: 2021,
  ImageTags: { Primary: "c2" },
} as MediaItem;

const candidate = (
  kind: "poster" | "backdrop" | "logo",
  language: string | null,
  n: number,
) => ({
  kind,
  imageType: kind === "poster" ? "cover" : kind,
  filePath: `/${kind}/${language}/${n}.png`,
  language,
  width: 500,
  height: 750,
  aspectRatio: 0.667,
  voteAverage: 7,
  voteCount: 3,
  previewUrl: `/preview/${kind}/${language}/${n}`,
});

/** What the server reports as already stored, which is what the editor reads. */
const stored = (imageType: string, contentHash: string) => ({
  id: `${imageType}-0`,
  itemId: "dune",
  imageType,
  imageIndex: 0,
  contentHash,
  width: 500,
  height: 750,
});

const overview: ArtworkOverview = {
  item: { id: "dune", title: "Dune", kind: "movie", providerId: "438631" },
  lockedTypes: [],
  current: [stored("cover", "c1"), stored("logo", "l1")],
  candidates: [
    candidate("poster", "en", 1),
    candidate("poster", "tr", 2),
    candidate("logo", "en", 3),
    candidate("logo", "tr", 4),
    candidate("logo", "tr", 5),
  ] as ArtworkOverview["candidates"],
};

beforeEach(() => {
  vi.clearAllMocks();
  media.getAllArtworkItems.mockResolvedValue([DUNE, ARCANE]);
  media.getItem.mockImplementation(async (id: string) =>
    id === "dune" ? DUNE : ARCANE,
  );
  artworkApi.getItemArtwork.mockResolvedValue(overview);
});

const renderPage = () =>
  render(
    <MemoryRouter>
      <TmdbArtworkPage />
    </MemoryRouter>,
  );

it("keeps the title list in view, scrolling on its own", async () => {
  renderPage();
  const list = await screen.findByRole("region", {
    name: "tmdbArtwork.libraryTitles",
  });
  expect(list.parentElement?.className).toContain("xl:sticky");
  expect(list.querySelector("ul")?.className).toContain("overscroll-contain");
});

it("draws each list thumbnail with its logo where it was placed", async () => {
  renderPage();
  const row = (await screen.findByText("Dune")).closest("button")!;
  const placed = row.querySelector('[data-logo-layout="true"]') as HTMLElement;
  expect(placed.style.left).toBe("50%");
  expect(placed.style.top).toBe("30%");
  expect(placed.style.width).toMatch(/^calc\(60% \+ \d+px\)$/);
});

it("reads only the chosen title again when it is opened, not the whole library", async () => {
  renderPage();
  fireEvent.click((await screen.findByText("Dune")).closest("button")!);
  await waitFor(() => expect(media.getItem).toHaveBeenCalledWith("dune"));
  expect(media.getItem).toHaveBeenCalledTimes(1);
  expect(media.getAllArtworkItems).toHaveBeenCalledTimes(1);
});

it("gives each artwork set its own language", async () => {
  renderPage();
  fireEvent.click((await screen.findByText("Dune")).closest("button")!);
  const logos = await screen.findByRole("radiogroup", {
    name: "tmdbArtwork.kind.logo · tmdbArtwork.sectionLanguage",
  });
  fireEvent.click(within(logos).getByRole("radio", { name: /Turkish/ }));

  const logoSection = document.getElementById("artwork-logo")!;
  const posterSection = document.getElementById("artwork-poster")!;
  expect(logoSection.querySelectorAll("li")).toHaveLength(2);
  // The posters are still every language.
  expect(posterSection.querySelectorAll("li")).toHaveLength(2);
});

it("redraws only that title's row after its artwork changes", async () => {
  const updated = { ...DUNE, ImageTags: { Primary: "c9", Logo: "l1" } };
  renderPage();
  fireEvent.click((await screen.findByText("Dune")).closest("button")!);
  await screen.findByRole("radiogroup", {
    name: "tmdbArtwork.kind.logo · tmdbArtwork.sectionLanguage",
  });
  media.getItem.mockResolvedValue(updated);
  fireEvent.click(
    document.getElementById("artwork-poster")!.querySelector("li button")!,
  );
  await waitFor(() =>
    expect(artworkApi.applyItemArtwork).toHaveBeenCalledWith("dune", {
      kind: "poster",
      filePath: "/poster/en/1.png",
    }),
  );
  await waitFor(() => {
    const row = screen
      .getByRole("region", { name: "tmdbArtwork.libraryTitles" })
      .querySelector('[aria-current="true"]')!;
    expect(row.querySelector("img")?.getAttribute("src")).toContain("c9");
  });
  expect(media.getAllArtworkItems).toHaveBeenCalledTimes(1);
});

it("carries a saved placement to the list thumbnail at once", async () => {
  renderPage();
  fireEvent.click((await screen.findByText("Dune")).closest("button")!);
  fireEvent.change(await screen.findByRole("slider"), {
    target: { value: "0" },
  });
  fireEvent.click(screen.getByText("logoLayout.save"));
  await waitFor(() =>
    expect(artworkApi.setLogoLayout).toHaveBeenCalledWith(
      "dune",
      expect.objectContaining({ shadow: 0 }),
    ),
  );
  const row = screen
    .getByRole("region", { name: "tmdbArtwork.libraryTitles" })
    .querySelector('[aria-current="true"]')!;
  // Shadow 0: the thumbnail's logo has no filter any more.
  await waitFor(() =>
    expect(
      (
        row.querySelector(
          '[data-logo-layout="true"] [data-logo-shadow="true"]',
        ) as HTMLElement
      )?.style.filter,
    ).toBe(""),
  );
});
