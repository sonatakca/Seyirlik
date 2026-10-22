import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import type { MediaItem } from "../lib/types";
import { MediaCard } from "./MediaCard";

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
    div: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
      <div {...props}>{children}</div>
    ),
  },
  useReducedMotion: () => false,
}));

vi.mock("../i18n/LanguageContext", () => ({
  useLanguage: () => ({ language: "en", t: (key: string) => key }),
}));

vi.mock("../lib/mediaApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/mediaApi")>()),
  getLogoImageUrl: (itemId: string) =>
    `https://media.test/ownAPI/v1/items/${itemId}/images/logo`,
  getPrimaryImageUrl: (itemId: string) =>
    `https://media.test/${itemId}/poster.jpg`,
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

function renderCard(item: MediaItem) {
  return render(
    <MemoryRouter>
      <MediaCard item={item} to="/movies/item-1" />
    </MemoryRouter>,
  );
}

/**
 * The card's logo, whichever layer it ended up in. Selected by source because
 * the poster underneath carries the same alt text.
 */
function logos(): HTMLImageElement[] {
  return screen
    .getAllByAltText("Dune")
    .filter(
      (element): element is HTMLImageElement =>
        element.getAttribute("src")?.includes("/images/logo") ?? false,
    );
}

function logo(): HTMLImageElement {
  const found = logos();
  expect(found).toHaveLength(1);
  return found[0] as HTMLImageElement;
}

/** The element the shadow is drawn on: around the logo, never the image. */
function logoShadow(): HTMLElement {
  const frame = logo().closest('[data-logo-shadow="true"]');
  expect(frame).not.toBeNull();
  return frame as HTMLElement;
}

describe("media card logo layout", () => {
  it("centres an unadjusted logo near the foot of the card", () => {
    renderCard(movie());

    expect(logoShadow().className).toContain("bottom-4");
    // Nothing else is drawn on the card: no gradient, no year, no rating.
    expect(screen.queryByText("2021")).toBeNull();
  });

  it("encodes an adjusted logo's placement in its raster overlay URL", () => {
    renderCard(movie({ x: 0.25, y: 0.4, width: 0.6, shadow: 1 }));

    const overlay = logo();
    expect(overlay.dataset.logoOverlay).toBe("true");
    const url = new URL(overlay.src);
    expect(url.searchParams.get("variant")).toBe("card-logo-overlay-v1");
    expect(url.searchParams.get("maxWidth")).toBe("600");
    expect(url.searchParams.get("layoutItemId")).toBe("item-1");
    expect(url.searchParams.get("layout")).toBe(
      "0.250000,0.400000,0.600000,1.000000",
    );
  });

  it("draws the logo once", () => {
    renderCard(movie({ x: 0.5, y: 0.2, width: 0.5, shadow: 1 }));
    expect(logos()).toHaveLength(1);
  });

  it("draws no live filter for a placed, shadowed logo", () => {
    renderCard(movie({ x: 0.5, y: 0.2, width: 0.5, shadow: 1 }));
    expect(logo().dataset.logoOverlay).toBe("true");
    expect(logo().style.filter).toBe("");
    expect(document.querySelector('[data-logo-shadow="true"]')).toBeNull();
    expect(document.querySelector('[data-logo-layout="true"]')).toBeNull();
  });

  it("draws no shadow at all when it is turned off", () => {
    renderCard(movie({ x: 0.5, y: 0.2, width: 0.5, shadow: 0 }));
    expect(logoShadow().style.filter).toBe("");
  });

  it("cache-busts the raster layer when the shadow strength rises", () => {
    renderCard(movie({ x: 0.5, y: 0.2, width: 0.5, shadow: 2 }));
    expect(new URL(logo().src).searchParams.get("layout")).toBe(
      "0.500000,0.200000,0.500000,2.000000",
    );
  });

  it("falls back to the title when a card has no logo", () => {
    // A card with neither logo nor title would be unidentifiable.
    render(
      <MemoryRouter>
        <MediaCard
          item={
            {
              Id: "item-2",
              Name: "Arrival",
              Type: "Movie",
              ImageTags: { Primary: "p" },
            } as MediaItem
          }
          to="/movies/item-2"
        />
      </MemoryRouter>,
    );

    expect(screen.getByText("Arrival")).toBeInTheDocument();
  });
});
