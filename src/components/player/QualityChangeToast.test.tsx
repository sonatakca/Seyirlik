import { act, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { QualityChangeToast } from "./QualityChangeToast";
import { useQualityChangeToast } from "./useQualityChangeToast";
import { QUALITY_TOAST_TIMING, type PlayingQuality } from "./qualityToastModel";

const q720: PlayingQuality = { id: "720", height: 720, hdr: false };
const q1080: PlayingQuality = { id: "1080", height: 1080, hdr: true };

type Props = {
  itemId: string;
  playing: PlayingQuality | null;
  suppressed: boolean;
};

const mount = (initial: Props) =>
  renderHook(
    ({ itemId, playing, suppressed }: Props) =>
      useQualityChangeToast(itemId, playing, suppressed),
    { initialProps: initial },
  );

describe("useQualityChangeToast", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("announces the first quality of a title, then each change", () => {
    const hook = mount({ itemId: "film", playing: q720, suppressed: false });
    expect(hook.result.current?.change).toMatchObject({
      kind: "start",
      from: null,
      to: q720,
    });

    hook.rerender({ itemId: "film", playing: q1080, suppressed: false });
    expect(hook.result.current?.change).toMatchObject({
      kind: "up",
      from: q720,
      to: q1080,
      // The start toast was still up, so the pill stays and only the values move.
      continued: true,
    });
  });

  it("leaves after its hold and is gone once the exit has played", () => {
    const hook = mount({ itemId: "film", playing: q720, suppressed: false });
    act(() => vi.advanceTimersByTime(QUALITY_TOAST_TIMING.visibleMs));
    expect(hook.result.current?.leaving).toBe(true);
    act(() => vi.advanceTimersByTime(QUALITY_TOAST_TIMING.exitMs));
    expect(hook.result.current).toBeNull();
  });

  it("does not announce a re-attach that comes back on the same rung", () => {
    const hook = mount({ itemId: "film", playing: q720, suppressed: false });
    act(() => vi.advanceTimersByTime(QUALITY_TOAST_TIMING.visibleMs));
    act(() => vi.advanceTimersByTime(QUALITY_TOAST_TIMING.exitMs));
    expect(hook.result.current).toBeNull();
    hook.rerender({ itemId: "film", playing: null, suppressed: false });
    hook.rerender({ itemId: "film", playing: q720, suppressed: false });
    expect(hook.result.current).toBeNull();
  });

  it("starts over for a new title", () => {
    const hook = mount({ itemId: "film", playing: q1080, suppressed: false });
    hook.rerender({ itemId: "episode", playing: q1080, suppressed: false });
    expect(hook.result.current?.change).toMatchObject({
      kind: "start",
      continued: false,
    });
  });

  it("stays quiet while the bottom right is taken, but keeps following the quality", () => {
    const hook = mount({ itemId: "film", playing: q720, suppressed: true });
    expect(hook.result.current).toBeNull();
    hook.rerender({ itemId: "film", playing: q1080, suppressed: false });
    // Measured from 720p, which played while the skip button was up.
    expect(hook.result.current?.change).toMatchObject({
      kind: "up",
      from: q720,
    });
  });
});

describe("QualityChangeToast", () => {
  it("puts the higher quality on top and tells a screen reader what changed", () => {
    render(
      <QualityChangeToast
        change={{
          id: 1,
          kind: "down",
          from: q1080,
          to: q720,
          continued: false,
        }}
        leaving={false}
        reduceMotion
        label="Quality dropped to 720p"
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "Quality dropped to 720p",
    );
    const values = [...document.querySelectorAll("[data-quality-value]")].map(
      (node) => node.textContent,
    );
    expect(values).toEqual(["1080p", "720p"]);
    expect(document.querySelector("[data-quality-hdr]")?.textContent).toBe(
      "HDR",
    );
  });
});
