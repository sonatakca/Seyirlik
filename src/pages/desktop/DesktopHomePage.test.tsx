import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  consumeLoginConfettiPending,
  markDailyHomeConfettiShown,
  shouldShowDailyHomeConfetti,
} from "../../lib/homeConfetti";
import {
  getAllBookItems,
  getAllMovieItems,
  getAllSeriesItems,
  getCuratedList,
  getFavouriteItems,
  getLatestMediaItems,
  getUserViews,
} from "../../lib/mediaApi";
import type { MediaItem } from "../../lib/types";
import { emptyCuratedList } from "../../lib/curation";
import { getSmartContinueWatchingItems } from "../../lib/smartContinueWatching";
import { DesktopHomePage } from "./DesktopHomePage";

vi.mock("../../lib/mediaApi");
vi.mock("../../lib/smartContinueWatching");
vi.mock("../../lib/homeConfetti");
vi.mock("../../lib/seo");
vi.mock("framer-motion", () => ({
  AnimatePresence: ({ children }: { children: ReactNode }) => <>{children}</>,
  motion: {
    div: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    span: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  },
  useReducedMotion: () => true,
}));
vi.mock("../../hooks/useStandaloneWebApp", () => ({
  useStandaloneWebApp: () => false,
}));
vi.mock("../../i18n/LanguageContext", () => {
  const t = (key: string) => key;

  return {
    useLanguage: () => ({ t }),
  };
});
vi.mock("../../components/home/HomeHero", () => ({
  HomeHero: ({
    onReady,
    items,
  }: {
    onReady?: () => void;
    items: MediaItem[];
  }) => (
    <button type="button" onClick={onReady}>
      hero-ready<span data-testid="opening-title">{items[0]?.Name}</span>
    </button>
  ),
}));
vi.mock("../../components/MediaRow", () => ({
  MediaRow: () => <div />,
}));
vi.mock("../../components/AnimatedText", () => ({
  AnimatedText: ({ value }: { value: string }) => <>{value}</>,
}));
vi.mock("../../components/AnimatedWidth", () => ({
  AnimatedWidth: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock("../../components/LibraryTile", () => ({
  LibraryTile: () => <div />,
}));
vi.mock("../../components/MotionReveal", () => ({
  MotionReveal: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
}));
vi.mock("../../components/animations/ConfettiAnimation", () => ({
  ConfettiAnimation: () => <div data-testid="home-confetti" />,
}));

afterEach(cleanup);

describe("DesktopHomePage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getUserViews).mockResolvedValue([]);
    vi.mocked(getSmartContinueWatchingItems).mockResolvedValue([]);
    vi.mocked(getLatestMediaItems).mockResolvedValue([]);
    vi.mocked(getCuratedList).mockImplementation(async (surface) =>
      emptyCuratedList(surface),
    );
    vi.mocked(getFavouriteItems).mockResolvedValue([]);
    vi.mocked(getAllMovieItems).mockResolvedValue([]);
    vi.mocked(getAllSeriesItems).mockResolvedValue([]);
    vi.mocked(getAllBookItems).mockResolvedValue([]);
    vi.mocked(consumeLoginConfettiPending).mockReturnValue(false);
    vi.mocked(shouldShowDailyHomeConfetti).mockReturnValue(false);
  });

  it("does not block the first screen on the full catalog query", async () => {
    vi.mocked(getAllMovieItems).mockReturnValue(new Promise(() => undefined));

    render(<DesktopHomePage />);

    expect(
      await screen.findByRole("button", {
        name: /hero-ready/,
      }),
    ).toBeInTheDocument();
  });

  it("waits for saved ordering instead of mounting on Ford v Ferrari", async () => {
    const ford = {
      Id: "ford",
      Name: "Ford v Ferrari",
      Type: "Movie",
    } as MediaItem;
    const sopranos = {
      Id: "sopranos",
      Name: "The Sopranos",
      Type: "Series",
    } as MediaItem;
    let resolveHero!: (value: ReturnType<typeof emptyCuratedList>) => void;
    const pendingHero = new Promise<ReturnType<typeof emptyCuratedList>>(
      (resolve) => {
        resolveHero = resolve;
      },
    );
    vi.mocked(getLatestMediaItems).mockResolvedValue([ford, sopranos]);
    vi.mocked(getAllMovieItems).mockResolvedValue([ford]);
    vi.mocked(getAllSeriesItems).mockResolvedValue([sopranos]);
    vi.mocked(getCuratedList).mockReturnValue(pendingHero);
    render(<DesktopHomePage />);
    await waitFor(() =>
      expect(getCuratedList).toHaveBeenCalledWith("home-hero"),
    );
    expect(screen.queryByTestId("opening-title")).not.toBeInTheDocument();
    await act(async () =>
      resolveHero({
        ...emptyCuratedList("home-hero"),
        entries: [
          { itemId: "sopranos", hidden: false },
          { itemId: "ford", hidden: false },
        ],
      }),
    );
    expect(await screen.findByTestId("opening-title")).toHaveTextContent(
      "The Sopranos",
    );
  });

  it("waits for the saved opener if it is absent from Latest", async () => {
    const ford = {
      Id: "ford",
      Name: "Ford v Ferrari",
      Type: "Movie",
    } as MediaItem;
    const sopranos = {
      Id: "sopranos",
      Name: "The Sopranos",
      Type: "Series",
    } as MediaItem;
    let resolveSeries!: (items: MediaItem[]) => void;
    vi.mocked(getLatestMediaItems).mockResolvedValue([ford]);
    vi.mocked(getAllMovieItems).mockResolvedValue([ford]);
    vi.mocked(getAllSeriesItems).mockReturnValue(
      new Promise((resolve) => {
        resolveSeries = resolve;
      }),
    );
    vi.mocked(getCuratedList).mockResolvedValue({
      ...emptyCuratedList("home-hero"),
      entries: [
        { itemId: "sopranos", hidden: false },
        { itemId: "ford", hidden: false },
      ],
    });
    render(<DesktopHomePage />);
    await waitFor(() =>
      expect(getCuratedList).toHaveBeenCalledWith("home-hero"),
    );
    expect(screen.queryByTestId("opening-title")).not.toBeInTheDocument();
    await act(async () => resolveSeries([sopranos]));
    expect(await screen.findByTestId("opening-title")).toHaveTextContent(
      "The Sopranos",
    );
  });

  it("still opens when the saved ordering request fails", async () => {
    vi.mocked(getCuratedList).mockRejectedValue(new Error("offline"));
    render(<DesktopHomePage />);
    expect(
      await screen.findByRole("button", { name: /hero-ready/ }),
    ).toBeInTheDocument();
  });

  it("waits until the hero is ready before showing daily confetti", async () => {
    vi.mocked(shouldShowDailyHomeConfetti).mockReturnValue(true);

    render(<DesktopHomePage />);

    const heroReadyButton = await screen.findByRole("button", {
      name: /hero-ready/,
    });
    expect(screen.queryByTestId("home-confetti")).not.toBeInTheDocument();
    expect(shouldShowDailyHomeConfetti).not.toHaveBeenCalled();

    fireEvent.click(heroReadyButton);

    await waitFor(() => {
      expect(screen.getByTestId("home-confetti")).toBeInTheDocument();
    });
    expect(markDailyHomeConfettiShown).toHaveBeenCalledOnce();
  });

  it("shows login confetti even when daily confetti is already spent", async () => {
    vi.mocked(consumeLoginConfettiPending).mockReturnValue(true);

    render(<DesktopHomePage />);

    fireEvent.click(
      await screen.findByRole("button", {
        name: /hero-ready/,
      }),
    );

    await waitFor(() => {
      expect(screen.getByTestId("home-confetti")).toBeInTheDocument();
    });
    expect(shouldShowDailyHomeConfetti).not.toHaveBeenCalled();
    expect(markDailyHomeConfettiShown).toHaveBeenCalledOnce();
  });
});
