import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { beginLoadingActivity } from "../lib/loadingActivity";
import {
  NavbarWordmark,
  WORDMARK_ACCENT_HOLD_MS,
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

  it("rests on white when nothing is loading", () => {
    const { container } = render(<NavbarWordmark />);

    expect(shownAccent(container)).toBe("White");
    advanceFrames(12);
    expect(shownAccent(container)).toBe("White");
  });

  it("cycles in palette order while loading, then 2.5s more, lands on the accent, holds it, then turns white", () => {
    const { container } = render(<NavbarWordmark />);
    let end = () => {};
    act(() => {
      end = beginLoadingActivity();
    });

    advanceFrames(1);
    expect(shownAccent(container)).toBe("Olive");
    advanceFrames(1);
    expect(shownAccent(container)).toBe("Green");
    advanceFrames(2);
    expect(shownAccent(container)).toBe("Warm Red");

    act(() => end());
    // The tail: five full laps after loading ends, still cycling.
    advanceFrames(30);
    expect(shownAccent(container)).toBe("Warm Red");
    advanceFrames(1);
    expect(shownAccent(container)).toBe("Amber");
    // Past the tail it comes round to the accent and holds it a second
    // (from the frame where the cycle sees it has landed), then turns white.
    advanceFrames(1);
    expect(shownAccent(container)).toBe("Gold");
    act(() => {
      vi.advanceTimersByTime(WORDMARK_ACCENT_HOLD_MS - 10);
    });
    expect(shownAccent(container)).toBe("Gold");
    act(() => {
      vi.advanceTimersByTime(WORDMARK_FRAME_MS + 10);
    });
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

    // 28 frames in, well inside the tail, it is still off the accent.
    advanceFrames(28);
    expect(shownAccent(container)).toBe("Warm Red");
    // To the end of the tail, plus at most one lap to come round.
    act(() => {
      vi.advanceTimersByTime(
        WORDMARK_LOADING_TAIL_MS - 28 * WORDMARK_FRAME_MS + 500,
      );
    });
    expect(shownAccent(container)).toBe("Gold");
    act(() => {
      vi.advanceTimersByTime(WORDMARK_FRAME_MS + WORDMARK_ACCENT_HOLD_MS);
    });
    expect(shownAccent(container)).toBe("White");
  });

  it("goes back to the colours at once when a load starts during the hold", () => {
    const { container } = render(<NavbarWordmark />);
    let end = () => {};
    act(() => {
      end = beginLoadingActivity();
    });
    act(() => end());
    act(() => {
      vi.advanceTimersByTime(WORDMARK_LOADING_TAIL_MS + 500);
    });
    expect(shownAccent(container)).toBe("Gold");
    act(() => {
      end = beginLoadingActivity();
    });
    advanceFrames(1);
    expect(shownAccent(container)).toBe("Olive");
    act(() => {
      vi.advanceTimersByTime(WORDMARK_ACCENT_HOLD_MS);
    });
    expect(shownAccent(container)).not.toBe("White");
    act(() => end());
  });

  it("keeps cycling after even a very short load", () => {
    const { container } = render(<NavbarWordmark />);

    let end = () => {};
    act(() => {
      end = beginLoadingActivity();
    });
    act(() => end());
    advanceFrames(1);
    expect(shownAccent(container)).toBe("Olive");
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
    expect(images).toHaveLength(18);
    for (const image of images) expect(image.style.filter).toBe("");
    // The shadows overhang the box by their reach, under the letters.
    const shadows = Array.from(images).slice(0, 6);
    for (const shadow of shadows) {
      expect(shadow.getAttribute("src")).toMatch(/shadow/);
      expect(shadow.style.left).toMatch(/^-/);
      expect(shadow.style.top).toMatch(/^-/);
    }
    // Off artwork the shadow is whole.
    expect(wordmark.dataset.shadowStrength).toBe("1.00");
  });

  it("lands on a changed accent", async () => {
    const { container } = render(<NavbarWordmark />);

    await act(async () => {
      document.documentElement.dataset.accentTheme = "Teal";
      await Promise.resolve();
    });
    expect(shownAccent(container)).toBe("White");
    let end = () => {};
    act(() => {
      end = beginLoadingActivity();
    });
    act(() => end());
    act(() => {
      vi.advanceTimersByTime(WORDMARK_LOADING_TAIL_MS + 500);
    });
    expect(shownAccent(container)).toBe("Teal");
  });
});
