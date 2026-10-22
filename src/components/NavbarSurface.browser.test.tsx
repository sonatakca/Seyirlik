import { act, cleanup, render, waitFor } from "@testing-library/react";
import { page } from "vitest/browser";
import { afterEach, expect, it } from "vitest";
import { NavbarSurface } from "./NavbarSurface";
import { useNavbarScrolled } from "../hooks/useNavbarScrolled";

function ScrollingSurface({ variant }: { variant: "desktop" | "mobile" }) {
  const shown = useNavbarScrolled();
  return <NavbarSurface shown={shown} variant={variant} />;
}

afterEach(async () => {
  cleanup();
  await act(async () => window.scrollTo(0, 0));
});

async function scrollTo(top: number) {
  await act(async () => window.scrollTo(0, top));
  await waitFor(() => expect(window.scrollY).toBe(top));
}

it.each(["desktop", "mobile"] as const)(
  "finishes opening and closing when %s scrolling pauses between endpoints",
  async (variant) => {
    await page.viewport(variant === "desktop" ? 1280 : 390, 800);
    const { container } = render(
      <div style={{ height: 2000 }}>
        <header
          style={{ position: "fixed", top: 0, left: 0, right: 0, height: 80 }}
        >
          <ScrollingSurface variant={variant} />
        </header>
      </div>,
    );
    const layers = Array.from(
      container.querySelectorAll<HTMLElement>(".navbar-surface > span"),
    );
    const expectOpacity = async (opacity: number) => {
      await waitFor(() => {
        for (const layer of layers) {
          expect(Number(getComputedStyle(layer).opacity)).toBe(opacity);
        }
      });
    };

    await expectOpacity(0);
    await scrollTo(32);
    await expectOpacity(1);
    await scrollTo(16);
    await expectOpacity(1);
    await scrollTo(8);
    await expectOpacity(0);
    await scrollTo(16);
    await expectOpacity(0);
    await scrollTo(24);
    await expectOpacity(1);
  },
);

it("keeps the full 300ms duration when reversed during a fade", async () => {
  const { container, rerender } = render(
    <NavbarSurface shown={false} variant="desktop" />,
  );
  const shade = container.querySelector<HTMLElement>(".navbar-surface__shade")!;
  await act(async () => rerender(<NavbarSurface shown variant="desktop" />));
  const running = () =>
    shade
      .getAnimations()
      .find((animation) => animation.playState === "running");
  await waitFor(() =>
    expect(running()?.effect?.getTiming().duration).toBe(300),
  );
  await waitFor(() => {
    const opacity = Number(getComputedStyle(shade).opacity);
    expect(opacity).toBeGreaterThan(0);
    expect(opacity).toBeLessThan(1);
  });
  await act(async () =>
    rerender(<NavbarSurface shown={false} variant="desktop" />),
  );
  await waitFor(() =>
    expect(running()?.effect?.getTiming().duration).toBe(300),
  );
  await waitFor(() => expect(Number(getComputedStyle(shade).opacity)).toBe(0));
});

it("shows the surface immediately on pages that always need it", () => {
  const { container } = render(<NavbarSurface shown variant="mobile" />);
  for (const layer of container.querySelectorAll<HTMLElement>(
    ".navbar-surface > span",
  )) {
    expect(Number(getComputedStyle(layer).opacity)).toBe(1);
  }
});
