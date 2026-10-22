import { render } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { TitlePoster } from "./TitlePoster";
import { getLogoShadowFilter } from "../../lib/logoLayout";

vi.mock("../../lib/mediaApi", () => ({
  getLogoImageUrl: () => "/logo",
  getPrimaryImageUrl: () => "/cover",
}));

const artwork = {
  coverTag: "c",
  logoTag: "l",
  logoLayout: { x: 0.5, y: 0.5, width: 0.6, shadow: 1 },
};

it("keeps the logo's shadow in proportion to a small poster", () => {
  const { container } = render(
    <TitlePoster itemId="a" title="A" artwork={artwork} width={48} />,
  );
  const logo = container.querySelector(
    '[data-logo-layout="true"] [data-logo-shadow="true"]',
  ) as HTMLElement;
  const backdrop = container.querySelector(
    "[data-logo-shadow-backdrop]",
  ) as HTMLElement;
  // A card-sized shadow reaches 34px; on a 48px poster it is a quarter of that.
  expect(getLogoShadowFilter(1)).toContain("34px");
  expect(logo.style.filter).toContain("8px");
  expect(logo.style.filter).not.toContain("34px");
  expect(backdrop.style.inset).toBe("calc(6% - 8px) calc(6% - 4px)");
});

it("draws a card-sized poster with the card's own shadow", () => {
  const { container } = render(
    <TitlePoster itemId="a" title="A" artwork={artwork} width={200} />,
  );
  const logo = container.querySelector(
    '[data-logo-layout="true"] [data-logo-shadow="true"]',
  ) as HTMLElement;
  expect(logo.style.filter.replace(/\s+/g, "")).toBe(
    getLogoShadowFilter(1)!.replace(/\s+/g, ""),
  );
});
