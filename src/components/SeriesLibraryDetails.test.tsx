import { render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SeriesLibraryDetails } from "./SeriesLibraryDetails";
import { getAllSeriesEpisodes } from "../lib/mediaApi";
import type { MediaItem } from "../lib/types";

vi.mock("../lib/mediaApi", () => ({
  getAllSeriesEpisodes: vi.fn(() => Promise.resolve([])),
  getItem: vi.fn(),
  getItemPeople: vi.fn(() =>
    Promise.resolve([
      {
        id: "person-1",
        name: "Example Actor",
        role: "actor",
        character: "Lead",
        imageUrl: "https://image.tmdb.org/t/p/w185/actor.jpg",
      },
      { id: "person-2", name: "Example Director", role: "director" },
      { id: "person-1", name: "Example Actor", role: "writer" },
    ]),
  ),
  getLocalTrailers: vi.fn(() =>
    Promise.resolve([
      {
        Id: "trailer-1",
        Name: "Trailer",
        Type: "Video",
        MediaType: "Video",
      },
    ]),
  ),
  getLogoImageUrl: vi.fn(() => "/logo.png"),
  getPrimaryImageUrl: vi.fn(() => "/primary.jpg"),
  getSeasonEpisodes: vi.fn(() => Promise.resolve([])),
  getSeriesSeasons: vi.fn(() => Promise.resolve([])),
  getSimilarItems: vi.fn(() =>
    Promise.resolve([
      {
        Id: "similar-1",
        Name: "Similar Movie",
        Type: "Movie",
      },
    ]),
  ),
}));

vi.mock("../lib/pageTitle", () => ({
  setPageTitle: vi.fn(),
}));

vi.mock("../i18n/LanguageContext", () => {
  const messages: Record<string, string> = {
    "details.noOverview": "No overview.",
    "details.markWatchedStatus": "Mark as watched",
    "details.markWatchedStatusForShow": "Mark whole show as watched",
    "details.removeWatchedStatus": "Remove watched status",
    "details.removeWatchedStatusForShow":
      "Remove watched status for whole show",
    "format.hourShort": "h",
    "format.minuteShort": "m",
    "media.episodeCardTitle": "Episode {number}",
    "media.episodePlural": "{count} episodes",
    "media.episodeSingular": "1 episode",
    "media.seasonNumber": "Season {number}",
    "media.seasonPlural": "{count} seasons",
    "media.seasonSingular": "1 season",
  };

  return {
    useLanguage: () => ({
      language: "en",
      t: (key: string) => messages[key] ?? key,
    }),
  };
});

vi.mock("./MotionReveal", () => ({
  MotionReveal: ({
    children,
    className,
  }: {
    children: ReactNode;
    className?: string;
  }) => <div className={className}>{children}</div>,
}));

vi.mock("./MediaCard", () => ({
  MediaCard: ({ item }: { item: MediaItem }) => <div>{item.Name}</div>,
}));

vi.mock("./mobile/MobileMediaCard", () => ({
  MobileMediaCard: ({ item }: { item: MediaItem }) => <div>{item.Name}</div>,
}));

describe("SeriesLibraryDetails", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    class ResizeObserverMock {
      observe = vi.fn();
      disconnect = vi.fn();
    }

    vi.stubGlobal("ResizeObserver", ResizeObserverMock);
  });

  it("renders movie details without the series-only season and episode shelf", async () => {
    const onInitialReady = vi.fn();
    const movie: MediaItem = {
      Id: "movie-1",
      Name: "Example Movie",
      Type: "Movie",
      Overview: "Movie overview",
      Genres: ["Drama"],
      Studios: [{ Name: "Example Studio" }],
    } as MediaItem;

    const watchedSlot = document.body.appendChild(
      document.createElement("span"),
    );
    render(
      <MemoryRouter>
        <SeriesLibraryDetails
          initialItem={movie}
          variant="desktop"
          canonicalPath="/library/movie-1"
          onInitialReady={onInitialReady}
          watchedSlot={watchedSlot}
          watchedSlotLook="dock"
        />
      </MemoryRouter>,
    );

    expect(
      await screen.findByRole("button", { name: "Scroll Trailers left" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Scroll Similar left" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Cast and crew")).toBeInTheDocument();
    // Similar titles close the page, after the title's own cast and facts.
    expect(
      screen
        .getByRole("heading", { name: "Information" })
        .compareDocumentPosition(
          screen.getByRole("heading", { name: "Similar" }),
        ),
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(screen.getByText("About")).toBeInTheDocument();
    expect(screen.getByText("Movie overview")).toBeInTheDocument();
    // A person credited twice is one card with both credits.
    expect(screen.getAllByText("Example Actor")).toHaveLength(1);
    expect(screen.getByText("Lead · Writer")).toBeInTheDocument();
    expect(screen.getByAltText("Example Actor")).toHaveAttribute(
      "src",
      "https://image.tmdb.org/t/p/w185/actor.jpg",
    );
    expect(screen.getByText("Director")).toBeInTheDocument();
    // No headshot: the frame holds an icon rather than a broken image.
    expect(screen.queryByAltText("Example Director")).not.toBeInTheDocument();
    // In the hero's place for it, beside the dock.
    expect(
      within(watchedSlot).getByRole("button", { name: "Mark as watched" }),
    ).toHaveClass("hero-dock-action");

    expect(
      screen.queryByRole("button", { name: "Scroll Episodes left" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Select season")).not.toBeInTheDocument();
    expect(
      screen.queryByText("No episodes were found for this season."),
    ).not.toBeInTheDocument();
    await waitFor(() => expect(onInitialReady).toHaveBeenCalledTimes(1));
  });

  it("places the watched-status action on show details", async () => {
    vi.mocked(getAllSeriesEpisodes).mockResolvedValueOnce([
      {
        Id: "episode-1",
        Name: "Episode 1",
        Type: "Episode",
        SeriesId: "series-1",
        UserData: { Played: false },
      },
    ]);

    const series: MediaItem = {
      Id: "series-1",
      Name: "Example Show",
      Type: "Series",
      Overview: "Show overview",
    };

    const watchedSlot = document.body.appendChild(
      document.createElement("span"),
    );
    render(
      <MemoryRouter>
        <SeriesLibraryDetails
          initialItem={series}
          variant="desktop"
          canonicalPath="/shows/series-1"
          watchedSlot={watchedSlot}
          watchedSlotLook="dock"
        />
      </MemoryRouter>,
    );

    expect(
      await within(watchedSlot).findByRole("button", {
        name: "Mark whole show as watched",
      }),
    ).toBeInTheDocument();
  });
});
