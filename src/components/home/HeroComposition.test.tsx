import { render } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { HeroComposition, createCompositionMotion } from "./HeroComposition";
import type { MediaItem } from "../../lib/types";

vi.mock("../../i18n/LanguageContext", () => ({
  useLanguage: () => ({ language: "tr" }),
}));
vi.mock("../../hooks/useCroppedTransparentImage", () => ({
  useCroppedTransparentImage: () => "/logo.png",
}));
vi.mock("./logoShadowStyle", async (importOriginal) => {
  const original = await importOriginal<typeof import("./logoShadowStyle")>();
  return { ...original, useLogoShadow: () => ({ strength: 0.7 }) };
});
vi.mock("./useBakedLogoShadows", () => ({
  useBakedLogoShadows: () => ({
    aspect: 3,
    base: null,
    halo: null,
    queue: null,
  }),
}));

it.each([0.2, 0.55, 1])(
  "keeps travelling logo shadows out of live filters at scale %s",
  (scale) => {
    const { container } = render(
      <HeroComposition
        item={
          {
            Id: "film",
            Name: "Film",
            Type: "Movie",
            ImageTags: { Logo: "logo" },
          } as MediaItem
        }
        stage={{ width: 1440, height: 810 }}
        titleBox={{ left: 50, bottom: 70, width: 400, height: 150 }}
        logoMaxHeight={250}
        motion={createCompositionMotion({ x: 0, y: 0, scale })}
        slotScale={0.2}
        zIndex={1}
        isStage={scale === 1}
      />,
    );
    const filters = Array.from(
      container.querySelectorAll<HTMLElement>("*"),
    ).filter((el) => el.style.filter && el.style.filter !== "none");
    expect(filters).toEqual([]);
  },
);
