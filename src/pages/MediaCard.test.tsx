import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { MediaCard } from "../components/MediaCard";
import { clearContinueWatchingHistory } from "../lib/continueWatchingActions";
import type { MediaItem } from "../lib/types";

// 1. Mock the media API URL builders
vi.mock("../lib/mediaApi", () => ({
  getPrimaryImageUrl: vi.fn((id) => `/mock-primary-${id}.jpg`),
  getLogoImageUrl: vi.fn((id) => `/mock-logo-${id}.png`),
}));

vi.mock("../lib/continueWatchingActions", () => ({
  clearContinueWatchingHistory: vi.fn(),
}));

// 2. Mock the Language Context
vi.mock("../i18n/LanguageContext", () => ({
  useLanguage: () => ({
    t: (key: string) => key,
    language: "en",
  }),
}));

// 3. Mock Framer Motion to prevent animation delays in tests
vi.mock("framer-motion", () => ({
  motion: {
    // The My List toggle morphs its strokes as motion paths.
    path: ({
      initial: _initial,
      animate,
      transition: _transition,
      ...props
    }: React.SVGProps<SVGPathElement> & {
      initial?: unknown;
      animate?: { d?: string };
      transition?: unknown;
    }) => <path {...props} d={animate?.d} />,
    div: ({
      children,
      whileTap,
      initial,
      whileInView,
      viewport,
      transition,
      ...props
    }: any) => <div {...props}>{children}</div>,
    img: ({
      whileTap,
      initial,
      whileInView,
      viewport,
      transition,
      ...props
    }: any) => <img {...props} />,
    span: ({ children, initial, animate, transition, ...props }: any) => (
      <span {...props}>{children}</span>
    ),
  },
  useReducedMotion: () => true,
}));

const mockMovie: MediaItem = {
  Id: "movie-123",
  Name: "The Matrix",
  Type: "Movie",
  MediaType: "Video",
  ProductionYear: 1999,
  ImageTags: {
    Primary: "primary-tag-abc",
  },
};

describe("MediaCard Component", () => {
  it("renders the movie title and primary image", () => {
    render(
      <MemoryRouter>
        <MediaCard item={mockMovie} to={`/library/${mockMovie.Id}`} />
      </MemoryRouter>,
    );

    // Check title rendering
    expect(screen.getAllByText("The Matrix").length).toBeGreaterThan(0);

    // Check that the image source is built properly
    const image = screen.getByAltText("The Matrix");
    expect(image).toHaveAttribute("src", "/mock-primary-movie-123.jpg");
  });

  it("shows a clear watched indicator for completed items", () => {
    render(
      <MemoryRouter>
        <MediaCard
          item={{ ...mockMovie, UserData: { Played: true } }}
          to={`/library/${mockMovie.Id}`}
        />
      </MemoryRouter>,
    );

    expect(screen.getByText("details.watched")).toBeInTheDocument();
  });

  it("shows the seal instead of a progress bar once an item is played", () => {
    render(
      <MemoryRouter>
        <MediaCard
          item={{ ...mockMovie, UserData: { Played: true } }}
          to={`/library/${mockMovie.Id}`}
        />
      </MemoryRouter>,
    );

    expect(screen.getByText("details.watched")).toBeInTheDocument();
    expect(
      screen.queryByTestId("media-card-progress-fill"),
    ).not.toBeInTheDocument();
  });

  it("does not render watched-status actions on media cards", () => {
    render(
      <MemoryRouter>
        <MediaCard item={mockMovie} to={`/library/${mockMovie.Id}`} />
      </MemoryRouter>,
    );

    expect(
      screen.queryByRole("button", { name: "details.markWatchedStatus" }),
    ).not.toBeInTheDocument();
  });

  it("renders a collection mosaic when a BoxSet has no primary image", () => {
    const collection: MediaItem = {
      Id: "collection-1",
      Name: "Example Collection",
      Type: "BoxSet",
    };
    const collectionItems: MediaItem[] = [
      {
        Id: "movie-1",
        Name: "Example",
        Type: "Movie",
        ImageTags: { Primary: "poster-1" },
      },
      {
        Id: "movie-2",
        Name: "Example 2",
        Type: "Movie",
        ImageTags: { Primary: "poster-2" },
      },
    ];

    render(
      <MemoryRouter>
        <MediaCard
          item={collection}
          to={`/library/${collection.Id}`}
          collectionItems={collectionItems}
        />
      </MemoryRouter>,
    );

    expect(screen.getByAltText("Example")).toHaveAttribute(
      "src",
      "/mock-primary-movie-1.jpg",
    );
    expect(screen.getByAltText("Example 2")).toHaveAttribute(
      "src",
      "/mock-primary-movie-2.jpg",
    );
  });

  it("opens movie cards on the movie detail route", () => {
    render(
      <MemoryRouter>
        <MediaCard item={mockMovie} to={`/library/${mockMovie.Id}`} />
      </MemoryRouter>,
    );
    expect(screen.getByLabelText("common.details The Matrix")).toHaveAttribute(
      "href",
      "/library/movie-123",
    );
  });

  it("uses the series poster for continue-watching episodes", () => {
    const episode: MediaItem = {
      Id: "episode-123",
      Name: "Let Him Go",
      Type: "Episode",
      SeriesName: "Ezel",
      SeriesId: "series-123",
      SeriesPrimaryImageTag: "series-primary",
      IndexNumber: 18,
      ParentIndexNumber: 1,
      ImageTags: {
        Primary: "episode-frame",
      },
    };

    render(
      <MemoryRouter>
        <MediaCard
          item={episode}
          to="/library/series-123"
          showRestartWatching
          onClearContinueWatching={vi.fn()}
        />
      </MemoryRouter>,
    );

    expect(screen.getByAltText("Ezel S1E18")).toHaveAttribute(
      "src",
      "/mock-primary-series-123.jpg",
    );
  });

  it("does not duplicate poster metadata chips in continue-watching details", () => {
    render(
      <MemoryRouter>
        <MediaCard
          item={{
            ...mockMovie,
            OfficialRating: "R",
            RunTimeTicks: 8_160_000_000,
            CommunityRating: 8.7,
          }}
          to={`/library/${mockMovie.Id}`}
          showRestartWatching
          onClearContinueWatching={vi.fn()}
        />
      </MemoryRouter>,
    );

    expect(screen.getAllByText("1999")).toHaveLength(1);
    expect(screen.getAllByText("R")).toHaveLength(1);
    expect(screen.getByText("14format.minuteShort")).toBeInTheDocument();
    expect(screen.getByText("8.7/10")).toBeInTheDocument();
  });

  it("renders start over only when a continue-watching row opts in", () => {
    const { rerender } = render(
      <MemoryRouter>
        <MediaCard item={mockMovie} to={`/library/${mockMovie.Id}`} />
      </MemoryRouter>,
    );

    expect(
      screen.queryByRole("button", { name: "home.startOver The Matrix" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", {
        name: "home.clearHistory The Matrix",
      }),
    ).not.toBeInTheDocument();

    rerender(
      <MemoryRouter>
        <MediaCard
          item={mockMovie}
          to={`/library/${mockMovie.Id}`}
          showRestartWatching
          onClearContinueWatching={vi.fn()}
        />
      </MemoryRouter>,
    );

    expect(
      screen.getByRole("button", { name: "home.startOver The Matrix" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "home.clearHistory The Matrix" }),
    ).toBeInTheDocument();
  });

  it("uses the shared clear workflow for both continue-watching actions", async () => {
    const user = userEvent.setup();
    const onClearContinueWatching = vi.fn();

    vi.mocked(clearContinueWatchingHistory).mockResolvedValue(mockMovie);

    render(
      <MemoryRouter>
        <MediaCard
          item={mockMovie}
          to={`/library/${mockMovie.Id}`}
          showRestartWatching
          onClearContinueWatching={onClearContinueWatching}
        />
      </MemoryRouter>,
    );

    await user.click(
      screen.getByRole("button", { name: "home.clearHistory The Matrix" }),
    );
    await user.click(
      screen.getByRole("button", { name: "home.startOver The Matrix" }),
    );

    expect(clearContinueWatchingHistory).toHaveBeenCalledTimes(2);
    expect(clearContinueWatchingHistory).toHaveBeenNthCalledWith(1, mockMovie);
    expect(clearContinueWatchingHistory).toHaveBeenNthCalledWith(2, mockMovie);
    expect(onClearContinueWatching).toHaveBeenCalledWith(mockMovie);
  });
});
