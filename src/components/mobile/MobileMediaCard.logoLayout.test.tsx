import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import type { MediaItem } from "../../lib/types";
import { MobileMediaCard } from "./MobileMediaCard";

vi.mock("framer-motion", () => ({
  motion: {
    article: ({
      children,
      layout: _layout,
      exit: _exit,
      ...props
    }: React.HTMLAttributes<HTMLElement> & {
      layout?: unknown;
      exit?: unknown;
    }) => <article {...props}>{children}</article>,
  },
  useReducedMotion: () => false,
}));

vi.mock("../../i18n/LanguageContext", () => ({
  useLanguage: () => ({ language: "en", t: (key: string) => key }),
}));

vi.mock("../../lib/mediaApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/mediaApi")>()),
  getLogoImageUrl: (itemId: string) =>
    `https://media.test/ownAPI/v1/items/${itemId}/images/logo`,
  getPrimaryImageUrl: (itemId: string) =>
    `https://media.test/${itemId}/poster.jpg`,
  getThumbImageUrl: (itemId: string) =>
    `https://media.test/${itemId}/thumb.jpg`,
}));

function movie(layout?: MediaItem["LogoLayout"]): MediaItem {
  return {
    Id: "item-1",
    Name: "Dune",
    Type: "Movie",
    ProductionYear: 2021,
    ImageTags: { Primary: "p", Logo: "l" },
    ...(layout ? { LogoLayout: layout } : {}),
  } as MediaItem;
}

function logo(): HTMLImageElement {
  const found = screen
    .getAllByAltText("Dune")
    .filter((element) => element.getAttribute("src")?.includes("/images/logo"));
  expect(found).toHaveLength(1);
  return found[0] as HTMLImageElement;
}

function renderCard(item: MediaItem, variant?: "poster" | "landscape") {
  render(
    <MemoryRouter>
      <MobileMediaCard item={item} to="/movies/item-1" variant={variant} />
    </MemoryRouter>,
  );
}

describe("a phone poster card's logo", () => {
  it("uses one filter-free raster layer for a placed, shadowed logo", () => {
    renderCard(movie({ x: 0.5, y: 0.13, width: 0.86, shadow: 1.4 }));
    const overlay = logo();
    expect(overlay.dataset.logoOverlay).toBe("true");
    const url = new URL(overlay.src);
    expect(url.searchParams.get("variant")).toBe("card-logo-overlay-v1");
    expect(url.searchParams.get("maxWidth")).toBe("440");
    expect(url.searchParams.get("layoutItemId")).toBe("item-1");
    expect(url.searchParams.get("layout")).toBe(
      "0.500000,0.130000,0.860000,1.400000",
    );
    expect(document.querySelector('[data-logo-shadow="true"]')).toBeNull();
    expect(document.querySelector('[data-logo-layout="true"]')).toBeNull();
  });

  it("keeps its foot placement when it was never placed", () => {
    renderCard(movie());
    expect(logo().dataset.logoOverlay).toBeUndefined();
    expect(logo().closest('[data-logo-layout="true"]')).toBeNull();
  });

  it("keeps its foot placement on a landscape tile", () => {
    renderCard(movie({ x: 0.5, y: 0.13, width: 0.86, shadow: 1 }), "landscape");
    expect(logo().dataset.logoOverlay).toBeUndefined();
    expect(logo().closest('[data-logo-layout="true"]')).toBeNull();
  });
});
