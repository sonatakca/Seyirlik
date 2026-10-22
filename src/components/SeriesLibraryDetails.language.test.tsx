import { act, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SeriesLibraryDetails } from "./SeriesLibraryDetails";
import { LanguageProvider, useLanguage } from "../i18n/LanguageContext";
import { LANGUAGE_STORAGE_KEY } from "../i18n/translations";
import { getItemPeople } from "../lib/mediaApi";
import type { MediaItem } from "../lib/types";

vi.mock("../lib/mediaApi", () => ({
  getAllSeriesEpisodes: vi.fn(() => Promise.resolve([])),
  getItem: vi.fn(),
  getItemPeople: vi.fn(() => Promise.resolve([])),
  getLocalTrailers: vi.fn(() => Promise.resolve([])),
  getLogoImageUrl: vi.fn(() => "/logo.png"),
  getPrimaryImageUrl: vi.fn(() => "/primary.jpg"),
  getSeasonEpisodes: vi.fn(() => Promise.resolve([])),
  getSeriesSeasons: vi.fn(() => Promise.resolve([])),
  getSimilarItems: vi.fn(() => Promise.resolve([])),
}));

vi.mock("../lib/pageTitle", () => ({
  setPageTitle: vi.fn(),
}));

vi.mock("./MotionReveal", () => ({
  MotionReveal: ({
    children,
    className,
  }: {
    children: ReactNode;
    className?: string;
  }) => <div className={className}>{children}</div>,
}));

function LanguageSwitch() {
  const { setLanguage } = useLanguage();

  return (
    <>
      <button type="button" onClick={() => setLanguage("en")}>
        to-en
      </button>
      <button type="button" onClick={() => setLanguage("tr")}>
        to-tr
      </button>
    </>
  );
}

describe("SeriesLibraryDetails language switch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.setItem(LANGUAGE_STORAGE_KEY, "tr");

    class ResizeObserverMock {
      observe = vi.fn();
      disconnect = vi.fn();
    }

    vi.stubGlobal("ResizeObserver", ResizeObserverMock);
  });

  afterEach(() => {
    localStorage.removeItem(LANGUAGE_STORAGE_KEY);
  });

  // A switch used to reload the details: the page fell back to its skeleton
  // and the hero dock's watched button vanished, to come back later as a new
  // button. In between the dock had no button, and the label never changed
  // in place.
  it("rewords the hero dock's watched button in place", async () => {
    const movie: MediaItem = {
      Id: "movie-1",
      Name: "Example Movie",
      Type: "Movie",
    } as MediaItem;
    const watchedSlot = document.body.appendChild(
      document.createElement("span"),
    );

    render(
      <LanguageProvider>
        <MemoryRouter>
          <LanguageSwitch />
          <SeriesLibraryDetails
            initialItem={movie}
            variant="desktop"
            canonicalPath="/library/movie-1"
            watchedSlot={watchedSlot}
            watchedSlotLook="dock"
          />
        </MemoryRouter>
      </LanguageProvider>,
    );

    const button = await within(watchedSlot).findByRole("button", {
      name: "İzlendi olarak işaretle",
    });
    expect(button).toHaveTextContent("İzlendi olarak işaretle");

    act(() => screen.getByRole("button", { name: "to-en" }).click());

    expect(
      within(watchedSlot).getByRole("button", { name: "Mark as watched" }),
    ).toBe(button);
    expect(button).toHaveTextContent("Mark as watched");

    act(() => screen.getByRole("button", { name: "to-tr" }).click());

    expect(
      within(watchedSlot).getByRole("button", {
        name: "İzlendi olarak işaretle",
      }),
    ).toBe(button);
    expect(getItemPeople).toHaveBeenCalledTimes(1);
  });
});
