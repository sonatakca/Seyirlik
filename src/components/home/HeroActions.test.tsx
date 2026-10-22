import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { HeroActions } from "./HeroActions";
import type { MediaItem } from "../../lib/types";

vi.mock("../../i18n/LanguageContext", () => ({
  useLanguage: () => ({
    t: (key: string) =>
      ({
        "common.details": "Details",
        "myList.title": "My List",
        "details.overview": "Overview",
        "details.playFromBeginning": "Play from beginning",
        "details.restartWatching": "Watch from the Beginning",
      })[key] ?? key,
  }),
}));
vi.mock("../FavouriteButton", () => ({
  FavouriteButton: ({ className }: { className: string }) => (
    <button className={className}>My List</button>
  ),
}));
vi.mock("../../lib/offline/offlineLibrary", () => ({
  isOfflineSupported: () => false,
}));

const fade = {
  initial: { opacity: 0 },
  animate: { opacity: 1 },
  exit: { opacity: 0 },
};
function dock(startOverTo: string | null = "/watch/film?start=0") {
  return render(
    <MemoryRouter>
      <HeroActions
        item={{ Id: "film", Name: "Film", Type: "Movie" } as MediaItem}
        playTo="/watch/film"
        playLabel="Continue"
        onPlay={() => {}}
        startOverTo={startOverTo}
        detailsTo="/movies/film"
        progress={null}
        overviewId="overview"
        hasOverview
        isOverviewOpen={false}
        onToggleOverview={() => {}}
        fade={fade}
      />
    </MemoryRouter>,
  );
}

describe("hero dock", () => {
  it("fades the glass and all controls through one opacity boundary", () => {
    const { container } = dock();
    const surface = container.querySelector<HTMLElement>(".hero-dock")!;
    expect(surface.style.opacity).toBe("0");
    expect(
      [...surface.querySelectorAll<HTMLElement>("*")].filter(
        (e) => e.style.opacity,
      ),
    ).toEqual([]);
  });
  it("places restart directly below play and above the other actions", () => {
    const { container } = dock();
    const surface = container.querySelector(".hero-dock")!;
    expect(surface.children[1]).toContainElement(
      screen.getByRole("link", { name: "Play from beginning" }),
    );
    expect(surface.children[2]).toContainElement(
      screen.getByRole("link", { name: "Details" }),
    );
  });
  it("keeps two levels when restart is unavailable", () => {
    const { container } = dock(null);
    expect(container.querySelector(".hero-dock")!.children).toHaveLength(2);
    expect(
      screen.queryByRole("link", { name: "Play from beginning" }),
    ).toBeNull();
  });
  it("labels restart while keeping the explicit start=0 destination", () => {
    dock();
    const restart = screen.getByRole("link", { name: "Play from beginning" });
    expect(restart).toHaveTextContent("Watch from the Beginning");
    expect(restart).toHaveAttribute("href", "/watch/film?start=0");
  });
});
