import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getLatestMediaItems, searchItems } from "../../lib/mediaApi";
import type { MediaItem } from "../../lib/types";
import { SearchOverlay } from "./SearchOverlay";

const navigate = vi.fn();

vi.mock("../../lib/mediaApi", () => ({
  searchItems: vi.fn(),
  getLatestMediaItems: vi.fn(),
  getPrimaryImageUrl: (id: string) => `primary:${id}`,
  getThumbImageUrl: (id: string) => `thumb:${id}`,
  getLogoImageUrl: (id: string) => `logo:${id}`,
}));

vi.mock("react-router-dom", async () => {
  const actual =
    await vi.importActual<typeof import("react-router-dom")>(
      "react-router-dom",
    );

  return { ...actual, useNavigate: () => navigate };
});

vi.mock("../../i18n/LanguageContext", () => ({
  useLanguage: () => ({
    t: (key: string) =>
      ({
        "search.title": "Search",
        "search.placeholder": "Search media",
        "search.close": "Close search",
        "search.hint": "Start typing",
        "search.noResults": "No results for “{query}”.",
        "search.failed": "Search failed",
        "search.groupMovies": "Movies",
        "search.groupShows": "Shows",
        "search.groupEpisodes": "Episodes",
        "search.suggestions": "Suggestions",
        "search.searching": "Searching…",
      })[key] ?? key,
  }),
}));

const mockedSearchItems = vi.mocked(searchItems);
const mockedGetLatestMediaItems = vi.mocked(getLatestMediaItems);

function item(id: string, name: string, type: MediaItem["Type"]): MediaItem {
  return { Id: id, Name: name, Type: type };
}

function renderOverlay(onClose = vi.fn()) {
  render(
    <MemoryRouter>
      <SearchOverlay isOpen onClose={onClose} />
    </MemoryRouter>,
  );

  return onClose;
}

describe("SearchOverlay", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockedSearchItems.mockReset();
    mockedGetLatestMediaItems.mockReset();
    mockedGetLatestMediaItems.mockResolvedValue([]);
    navigate.mockReset();
  });

  it("waits for a searchable query before calling the API", async () => {
    renderOverlay();

    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "a" } });
    await vi.advanceTimersByTimeAsync(500);

    expect(mockedSearchItems).not.toHaveBeenCalled();
    expect(screen.getByText("Start typing")).toBeInTheDocument();
  });

  it("groups results by kind", async () => {
    mockedSearchItems.mockResolvedValue([
      item("episode-1", "Pilot", "Episode"),
      item("movie-1", "Arrival", "Movie"),
      item("series-1", "Severance", "Series"),
    ]);

    renderOverlay();

    fireEvent.change(screen.getByRole("searchbox"), {
      target: { value: "arr" },
    });
    await vi.advanceTimersByTimeAsync(400);

    await waitFor(() => {
      expect(screen.getByText("Movies")).toBeInTheDocument();
    });

    expect(mockedSearchItems).toHaveBeenCalledWith("arr");
    expect(screen.getByText("Shows")).toBeInTheDocument();
    expect(screen.getByText("Episodes")).toBeInTheDocument();

    // Movies group renders before shows, which renders before episodes.
    const headings = screen
      .getAllByText(/^(Movies|Shows|Episodes)$/)
      .map((node) => node.textContent);
    expect(headings).toEqual(["Movies", "Shows", "Episodes"]);
  });

  it("holds the panel's shape with skeleton rows until results arrive", async () => {
    let answer: (items: MediaItem[]) => void = () => undefined;
    mockedSearchItems.mockReturnValue(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );

    renderOverlay();
    fireEvent.change(screen.getByRole("searchbox"), {
      target: { value: "pirat" },
    });

    expect(
      await screen.findByRole("status", { name: "Searching…" }),
    ).toBeInTheDocument();

    await vi.advanceTimersByTimeAsync(400);
    answer([
      {
        ...item("movie-1", "Salazar's Revenge", "Movie"),
        ImageTags: { Primary: "poster-tag" },
      },
    ]);

    expect(
      await screen.findByRole("button", { name: "Salazar's Revenge" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("status", { name: "Searching…" })).toBeNull();
    // The poster shimmers where it will be until it has loaded, then fades in.
    const row = screen
      .getByRole("button", { name: "Salazar's Revenge" })
      .closest("button")!;
    const poster = row.querySelector("img")!;
    expect(row.querySelector(".shimmer")).not.toBeNull();
    expect(poster.className).toContain("opacity-0");
    fireEvent.load(poster);
    expect(row.querySelector(".shimmer")).toBeNull();
    expect(poster.className).toContain("opacity-100");
  });

  it("opens the highlighted result on Enter", async () => {
    mockedSearchItems.mockResolvedValue([
      item("movie-1", "Arrival", "Movie"),
      item("movie-2", "Annihilation", "Movie"),
    ]);

    const onClose = renderOverlay();
    const input = screen.getByRole("searchbox");

    fireEvent.change(input, { target: { value: "a".repeat(3) } });
    await vi.advanceTimersByTimeAsync(400);

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Arrival" }),
      ).toBeInTheDocument();
    });

    // Films share one shelf: Right at the end of the text steps along it.
    fireEvent.keyDown(input, { key: "ArrowRight" });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(navigate).toHaveBeenCalledWith("/movies/movie-2");
    expect(onClose).toHaveBeenCalled();
  });

  it("moves between a shelf and episode rows, returning to the shelf's place", async () => {
    mockedSearchItems.mockResolvedValue([
      item("movie-1", "Arrival", "Movie"),
      item("movie-2", "Annihilation", "Movie"),
      item("movie-3", "Alien", "Movie"),
      item("episode-1", "Pilot", "Episode"),
      item("episode-2", "Second", "Episode"),
    ]);

    renderOverlay();
    const input = screen.getByRole("searchbox");
    fireEvent.change(input, { target: { value: "aaa" } });
    await vi.advanceTimersByTimeAsync(400);
    await waitFor(() => {
      expect(screen.getByText("Pilot")).toBeInTheDocument();
    });

    const active = () =>
      document.querySelector('[data-search-active="true"]')?.textContent;

    // Before browsing, Left belongs to the caret.
    fireEvent.keyDown(input, { key: "ArrowLeft" });
    expect(active()).toContain("Arrival");

    fireEvent.keyDown(input, { key: "ArrowRight" });
    fireEvent.keyDown(input, { key: "ArrowRight" });
    expect(active()).toContain("Alien");

    // Down leaves the shelf for the first episode, not the next film.
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(active()).toContain("Pilot");
    // The shelf is not left blank: it still names, dimmed, where focus stood.
    const caption = document.querySelector("p.search-caption-in")!;
    expect(caption.textContent).toBe("Alien");
    expect(caption).toHaveAttribute("data-resting", "true");
    // Left and Right do nothing on a row of one.
    fireEvent.keyDown(input, { key: "ArrowRight" });
    expect(active()).toContain("Pilot");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(active()).toContain("Second");

    // Back up onto the shelf where focus last stood.
    fireEvent.keyDown(input, { key: "ArrowUp" });
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(active()).toContain("Alien");

    // Typing hands Left back to the caret.
    fireEvent.change(input, { target: { value: "aaab" } });
    fireEvent.keyDown(input, { key: "ArrowLeft" });
    expect(active()).toContain("Alien");
  });

  it("names only the focused title, in full, under its shelf", async () => {
    const long = "Star Wars: Episode VI - Return of the Jedi (1983)";
    mockedSearchItems.mockResolvedValue([
      item("movie-1", "Arrival", "Movie"),
      item("movie-2", long, "Movie"),
    ]);

    renderOverlay();
    const input = screen.getByRole("searchbox");
    fireEvent.change(input, { target: { value: "aaa" } });
    await vi.advanceTimersByTimeAsync(400);
    await screen.findByRole("button", { name: long });

    const caption = () =>
      Array.from(document.querySelectorAll("p.search-caption-in")).map(
        (node) => node.textContent,
      );
    expect(caption()).toEqual(["Arrival"]);

    fireEvent.keyDown(input, { key: "ArrowRight" });
    expect(caption()).toEqual([long]);
    // Never cut short: no truncation anywhere on the shelf.
    expect(document.querySelector("[data-search-shelf] .truncate")).toBeNull();
  });

  it("keeps focus where the keyboard put it when results scroll under a still pointer", async () => {
    mockedSearchItems.mockResolvedValue([
      item("episode-1", "Pilot", "Episode"),
      item("episode-2", "Second", "Episode"),
      item("episode-3", "Third", "Episode"),
    ]);

    renderOverlay();
    const input = screen.getByRole("searchbox");
    fireEvent.change(input, { target: { value: "aaa" } });
    await vi.advanceTimersByTimeAsync(400);
    await waitFor(() => {
      expect(screen.getByText("Third")).toBeInTheDocument();
    });

    const pilot = screen.getByText("Pilot").closest("button")!;
    const third = screen.getByText("Third").closest("button")!;
    fireEvent.pointerMove(pilot, { screenX: 300, screenY: 400 });
    fireEvent.pointerMove(pilot, { screenX: 300, screenY: 404 });
    expect(pilot).toHaveAttribute("data-search-active", "true");

    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(third).toHaveAttribute("data-search-active", "true");

    // The list scrolled; the browser reports the pointer over another row at
    // the very same place. That is not the person moving.
    const second = screen.getByText("Second").closest("button")!;
    fireEvent.pointerMove(second, { screenX: 300, screenY: 404 });
    expect(third).toHaveAttribute("data-search-active", "true");

    // A real movement takes focus again.
    fireEvent.pointerMove(second, { screenX: 301, screenY: 404 });
    expect(second).toHaveAttribute("data-search-active", "true");
  });

  it("lets the pointer take focus", async () => {
    mockedSearchItems.mockResolvedValue([
      item("movie-1", "Arrival", "Movie"),
      item("episode-1", "Pilot", "Episode"),
    ]);

    renderOverlay();
    fireEvent.change(screen.getByRole("searchbox"), {
      target: { value: "arr" },
    });
    await vi.advanceTimersByTimeAsync(400);
    await waitFor(() => {
      expect(screen.getByText("Pilot")).toBeInTheDocument();
    });

    const pilot = screen.getByText("Pilot").closest("button")!;
    // The first report only says where the pointer rests.
    fireEvent.pointerMove(pilot, { screenX: 300, screenY: 400 });
    expect(pilot).not.toHaveAttribute("data-search-active");
    fireEvent.pointerMove(pilot, { screenX: 304, screenY: 402 });
    expect(pilot).toHaveAttribute("data-search-active", "true");
    fireEvent.keyDown(screen.getByRole("searchbox"), { key: "Enter" });
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate).not.toHaveBeenCalledWith("/movies/movie-1");
  });

  it("closes on Escape", async () => {
    const onClose = renderOverlay();

    fireEvent.keyDown(screen.getByRole("searchbox"), { key: "Escape" });

    expect(onClose).toHaveBeenCalled();
  });

  it("reports a failed search without clearing the query", async () => {
    mockedSearchItems.mockRejectedValue(new Error("offline"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    renderOverlay();

    fireEvent.change(screen.getByRole("searchbox"), {
      target: { value: "arr" },
    });
    await vi.advanceTimersByTimeAsync(400);

    await waitFor(() => {
      expect(screen.getByText("Search failed")).toBeInTheDocument();
    });

    warn.mockRestore();
  });

  it("offers recently added titles before anything is typed", async () => {
    mockedGetLatestMediaItems.mockResolvedValue([
      item("movie-1", "Arrival", "Movie"),
      item("series-1", "Severance", "Series"),
    ]);

    renderOverlay();

    await waitFor(() => {
      expect(screen.getByText("Suggestions")).toBeInTheDocument();
    });

    expect(screen.getByRole("button", { name: "Arrival" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Severance" }),
    ).toBeInTheDocument();
    // Suggestions are one list, not split by kind.
    expect(screen.queryByText("Movies")).not.toBeInTheDocument();
    expect(mockedSearchItems).not.toHaveBeenCalled();
  });

  it("opens a suggestion with the keyboard", async () => {
    mockedGetLatestMediaItems.mockResolvedValue([
      item("movie-1", "Arrival", "Movie"),
    ]);

    renderOverlay();

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Arrival" }),
      ).toBeInTheDocument();
    });

    fireEvent.keyDown(screen.getByRole("searchbox"), { key: "Enter" });

    expect(navigate).toHaveBeenCalledWith("/movies/movie-1");
  });

  it("falls back to the hint when suggestions cannot be loaded", async () => {
    mockedGetLatestMediaItems.mockRejectedValue(new Error("offline"));

    renderOverlay();

    await waitFor(() => {
      expect(screen.getByText("Start typing")).toBeInTheDocument();
    });
  });

  it("gives an episode its own still, and a movie its poster", async () => {
    mockedSearchItems.mockResolvedValue([
      {
        ...item("movie-1", "Arrival", "Movie"),
        ImageTags: { Primary: "poster-tag" },
      },
      {
        ...item("episode-1", "Pilot", "Episode"),
        ImageTags: { Primary: "still-tag" },
      },
    ]);

    renderOverlay();

    fireEvent.change(screen.getByRole("searchbox"), {
      target: { value: "arr" },
    });
    await vi.advanceTimersByTimeAsync(400);

    await waitFor(() => {
      expect(screen.getByText("Pilot")).toBeInTheDocument();
    });

    const episodeArtwork = screen
      .getByText("Pilot")
      .closest("button")
      ?.querySelector("span > img");
    const movieArtwork = screen
      .getByRole("button", { name: "Arrival" })
      .closest("button")
      ?.querySelector("span > img");

    // The episode shows its own frame, not the series poster.
    expect(episodeArtwork).toHaveAttribute("src", "primary:episode-1");
    expect(episodeArtwork?.parentElement?.className).toContain("aspect-video");
    expect(movieArtwork?.parentElement?.className).toContain("aspect-[2/3]");
  });

  it("keeps logos off episodes", async () => {
    mockedSearchItems.mockResolvedValue([
      {
        ...item("episode-1", "Pilot", "Episode"),
        SeriesId: "series-1",
        ImageTags: { Primary: "still-tag", Logo: "logo-tag" },
      },
    ]);

    renderOverlay();

    fireEvent.change(screen.getByRole("searchbox"), {
      target: { value: "pil" },
    });
    await vi.advanceTimersByTimeAsync(400);

    await waitFor(() => {
      expect(screen.getByText("Pilot")).toBeInTheDocument();
    });

    // A series wordmark says nothing about which episode this is.
    const images = screen
      .getByText("Pilot")
      .closest("button")!
      .querySelectorAll("img");
    expect(images).toHaveLength(1);
    expect(images[0]).toHaveAttribute("src", "primary:episode-1");
  });

  it("places a logo where the artwork editor put it", async () => {
    mockedSearchItems.mockResolvedValue([
      {
        ...item("movie-1", "Arrival", "Movie"),
        ImageTags: { Primary: "poster-tag", Logo: "logo-tag" },
        LogoLayout: { x: 0.25, y: 0.4, width: 0.6, shadow: 1 },
      },
    ]);

    renderOverlay();

    fireEvent.change(screen.getByRole("searchbox"), {
      target: { value: "arr" },
    });
    await vi.advanceTimersByTimeAsync(400);

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Arrival" }),
      ).toBeInTheDocument();
    });

    const placement = screen
      .getByRole("button", { name: "Arrival" })
      .closest("button")!
      .querySelector('[data-logo-layout="true"]') as HTMLElement | null;

    expect(placement).not.toBeNull();
    expect(placement!.style.left).toBe("25%");
    expect(placement!.style.top).toBe("40%");
    expect(placement!.style.width).toMatch(/^calc\(60% \+ \d+px\)$/);
  });

  it("falls back to the default placement when a title was never adjusted", async () => {
    mockedSearchItems.mockResolvedValue([
      {
        ...item("movie-1", "Arrival", "Movie"),
        ImageTags: { Primary: "poster-tag", Logo: "logo-tag" },
      },
    ]);

    renderOverlay();

    fireEvent.change(screen.getByRole("searchbox"), {
      target: { value: "arr" },
    });
    await vi.advanceTimersByTimeAsync(400);

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Arrival" }),
      ).toBeInTheDocument();
    });

    const row = screen
      .getByRole("button", { name: "Arrival" })
      .closest("button")!;
    expect(row.querySelector('[data-logo-layout="true"]')).toBeNull();
    expect(row.querySelectorAll("img")).toHaveLength(2);
  });
});
