import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { JUMP_PREVIEW_REVEAL_MS, useSeekPreview } from "./useSeekPreview";

/** A video element whose seek state the test sets by hand. */
function fakeVideo() {
  const video = document.createElement("video");
  const state = { currentTime: 30, seeking: false, readyState: 4 };
  Object.defineProperties(video, {
    currentTime: { get: () => state.currentTime, configurable: true },
    seeking: { get: () => state.seeking, configurable: true },
    readyState: { get: () => state.readyState, configurable: true },
    ended: { get: () => false, configurable: true },
  });
  return {
    video,
    startSeek(to: number) {
      state.currentTime = to;
      state.seeking = true;
      state.readyState = 1;
    },
    finishSeek() {
      state.seeking = false;
      state.readyState = 4;
      video.dispatchEvent(new Event("seeked"));
    },
  };
}

function setup() {
  const media = fakeVideo();
  const videoRef = { current: media.video };
  const hook = renderHook(() =>
    useSeekPreview({ videoRef, deckEpoch: 0, resetKey: "film" }),
  );
  return { media, hook };
}

describe("useSeekPreview", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("never shows a jump that lands before the reveal", () => {
    const { media, hook } = setup();

    act(() => {
      media.startSeek(35);
      hook.result.current.land(35);
    });
    expect(hook.result.current.seekPreview).toMatchObject({
      phase: "landing",
      shown: false,
    });

    act(() => {
      vi.advanceTimersByTime(JUMP_PREVIEW_REVEAL_MS / 2);
      media.finishSeek();
    });
    expect(hook.result.current.seekPreview).toBeNull();

    act(() => {
      vi.advanceTimersByTime(JUMP_PREVIEW_REVEAL_MS * 4);
    });
    expect(hook.result.current.seekPreview).toBeNull();
  });

  it("shows a slow jump, then lets it go once the frame is there", () => {
    const { media, hook } = setup();

    act(() => {
      media.startSeek(300);
      hook.result.current.land(300);
    });
    act(() => {
      vi.advanceTimersByTime(JUMP_PREVIEW_REVEAL_MS);
    });
    expect(hook.result.current.seekPreview).toEqual({
      seconds: 300,
      phase: "landing",
      shown: true,
    });

    act(() => {
      vi.advanceTimersByTime(3_000);
    });
    expect(hook.result.current.seekPreview?.shown).toBe(true);

    act(() => {
      media.finishSeek();
      vi.advanceTimersByTime(1_000);
    });
    expect(hook.result.current.seekPreview).toBeNull();
  });

  it("keeps the first press's deadline while a key repeats", () => {
    const { media, hook } = setup();
    const step = JUMP_PREVIEW_REVEAL_MS / 3;

    for (let press = 1; press <= 6; press += 1) {
      act(() => {
        media.startSeek(30 + press * 5);
        hook.result.current.land(30 + press * 5);
        vi.advanceTimersByTime(step);
      });
    }

    expect(hook.result.current.seekPreview).toEqual({
      seconds: 60,
      phase: "landing",
      shown: true,
    });
  });

  it("keeps a scrub's picture up through its landing", () => {
    const { media, hook } = setup();

    act(() => {
      hook.result.current.showScrub(400);
    });
    expect(hook.result.current.seekPreview?.shown).toBe(true);

    act(() => {
      media.startSeek(400);
      hook.result.current.land(400);
    });
    expect(hook.result.current.seekPreview).toEqual({
      seconds: 400,
      phase: "landing",
      shown: true,
    });
  });
});
