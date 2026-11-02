import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { beginLoadingActivity } from "../lib/loadingActivity";
import {
  NavbarWordmark,
  WORDMARK_FRAME_MS,
  WORDMARK_LOADING_TAIL_MS,
} from "./NavbarWordmark";

function shownAccent(container: HTMLElement): string | null {
  return container
    .querySelector("[data-wordmark-accent]")!
    .getAttribute("data-wordmark-accent");
}

function advanceFrames(count: number) {
  act(() => {
    vi.advanceTimersByTime(WORDMARK_FRAME_MS * count);
  });
}

describe("NavbarWordmark", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    document.documentElement.dataset.accentTheme = "Gold";
  });

  afterEach(() => {
    vi.useRealTimers();
    delete document.documentElement.dataset.accentTheme;
  });

  it("rests on white when nothing is loading, whatever the accent", () => {
    const { container } = render(<NavbarWordmark />);

    expect(shownAccent(container)).toBe("White");
    advanceFrames(12);
    expect(shownAccent(container)).toBe("White");
  });

  it("cycles in palette order while loading, then 2.5s more, then finishes its lap and turns white", () => {
    const { container } = render(<NavbarWordmark />);
    let end = () => {};
    act(() => {
      end = beginLoadingActivity();
    });

    advanceFrames(1);
    expect(shownAccent(container)).toBe("Warm Red");
    advanceFrames(1);
    expect(shownAccent(container)).toBe("Amber");
    advanceFrames(4);
    expect(shownAccent(container)).toBe("Teal");
    advanceFrames(1);
    expect(shownAccent(container)).toBe("Warm Red");

    act(() => end());
    // The tail: five full laps after loading ends, still cycling.
    advanceFrames(30);
    expect(shownAccent(container)).toBe("Warm Red");
    // Past the tail it finishes the lap, then rests on white.
    advanceFrames(5);
    expect(shownAccent(container)).toBe("Teal");
    advanceFrames(1);
    expect(shownAccent(container)).toBe("White");
    advanceFrames(12);
    expect(shownAccent(container)).toBe("White");
  });

  it("stops within half a second of the tail ending", () => {
    const { container } = render(<NavbarWordmark />);
    let end = () => {};
    act(() => {
      end = beginLoadingActivity();
    });
    act(() => end());

    // 28 frames in, well inside the tail, it is still cycling.
    advanceFrames(28);
    expect(shownAccent(container)).toBe("Olive");
    // To the end of the tail, plus at most one lap to finish.
    act(() => {
      vi.advanceTimersByTime(
        WORDMARK_LOADING_TAIL_MS - 28 * WORDMARK_FRAME_MS + 500,
      );
    });
    expect(shownAccent(container)).toBe("White");
    advanceFrames(12);
    expect(shownAccent(container)).toBe("White");
  });

  it("keeps cycling after even a very short load", () => {
    const { container } = render(<NavbarWordmark />);

    let end = () => {};
    act(() => {
      end = beginLoadingActivity();
    });
    act(() => end());
    advanceFrames(1);
    expect(shownAccent(container)).toBe("Warm Red");
  });

  it("draws its shadow from baked images, never a CSS filter", () => {
    const { container } = render(<NavbarWordmark />);
    const wordmark = container.querySelector<HTMLElement>(
      "[data-wordmark-accent]",
    )!;

    // On an iPad the loading cycle's repaints clipped a filter here to the
    // wordmark's own box, drawing a dark rectangle behind the letters.
    expect(wordmark.style.filter).toBe("");
    const images = wordmark.querySelectorAll("img");
    expect(images).toHaveLength(14);
    for (const image of images) expect(image.style.filter).toBe("");
    // The shadows overhang the box by their reach, under the letters.
    const shadows = Array.from(images).slice(0, 7);
    for (const shadow of shadows) {
      expect(shadow.getAttribute("src")).toMatch(/shadow/);
      expect(shadow.style.left).toMatch(/^-/);
      expect(shadow.style.top).toMatch(/^-/);
    }
    // Off artwork the shadow is whole.
    expect(wordmark.dataset.shadowStrength).toBe("1.00");
  });

  it("stays white through an accent change", async () => {
    const { container } = render(<NavbarWordmark />);

    await act(async () => {
      document.documentElement.dataset.accentTheme = "Teal";
      await Promise.resolve();
    });
    expect(shownAccent(container)).toBe("White");
  });
});
