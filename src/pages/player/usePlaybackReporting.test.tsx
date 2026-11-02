import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MediaItem, PlaybackSourceCandidate } from "../../lib/types";
import { usePlaybackReporting } from "./usePlaybackReporting";

const {
  markItemPlayed,
  reportPlaybackProgress,
  reportPlaybackStart,
  reportPlaybackStopped,
  reportPlaybackStoppedBeforeUnload,
} = vi.hoisted(() => ({
  markItemPlayed: vi.fn(),
  reportPlaybackProgress: vi.fn(),
  reportPlaybackStart: vi.fn(),
  reportPlaybackStopped: vi.fn(),
  reportPlaybackStoppedBeforeUnload: vi.fn(),
}));

vi.mock("../../lib/mediaApi", () => ({
  markItemPlayed,
  reportPlaybackProgress,
  reportPlaybackStart,
  reportPlaybackStopped,
  reportPlaybackStoppedBeforeUnload,
  ticksFromSeconds: (seconds: number) => seconds * 10_000_000,
}));

const source = {
  id: "source-1",
  itemId: "item-1",
  mode: "DirectPlay",
  url: "https://media.example/item-1",
  isHls: false,
  label: "Direct play",
  mediaSource: {},
  reason: "test",
  priority: 0,
} as PlaybackSourceCandidate;

describe("usePlaybackReporting", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    reportPlaybackProgress.mockResolvedValue(undefined);
    reportPlaybackStart.mockResolvedValue(undefined);
    reportPlaybackStopped.mockResolvedValue(undefined);
    markItemPlayed.mockResolvedValue(undefined);
  });

  describe("in a file that holds several episodes", () => {
    const halfHour = {
      Id: "item-1",
      Name: "Help Wanted",
      Type: "Episode",
      FileParts: [
        { Id: "item-1", Name: "Help Wanted", StartSeconds: 0 },
        { Id: "reef", Name: "Reef Blower", StartSeconds: 549 },
        { Id: "tea", Name: "Tea at the Treedome", StartSeconds: 720 },
      ],
    } as MediaItem;

    it("reports the playing episode on its own clock", () => {
      const { result } = renderHook(() =>
        usePlaybackReporting(source, halfHour),
      );
      act(() => {
        result.current.handlePlaybackProgress(600, false);
      });
      expect(reportPlaybackProgress).toHaveBeenCalledWith(
        { ...source, itemId: "reef" },
        510_000_000,
        false,
      );
    });

    it("marks an episode watched when play runs on into the next", () => {
      const { result } = renderHook(() =>
        usePlaybackReporting(source, halfHour),
      );
      act(() => {
        result.current.handlePlaybackStarted(500);
        result.current.handlePlaybackProgress(560, false);
      });
      expect(markItemPlayed).toHaveBeenCalledWith("item-1");
      expect(markItemPlayed).toHaveBeenCalledTimes(1);
    });

    it("does not count a seek past an episode as watching it", () => {
      const { result } = renderHook(() =>
        usePlaybackReporting(source, halfHour),
      );
      act(() => {
        result.current.handlePlaybackStarted(10);
        result.current.handlePlaybackProgress(800, false);
      });
      expect(markItemPlayed).not.toHaveBeenCalled();
    });
  });

  it("reports start, progress, stop, and before-unload with tick positions", () => {
    const { result } = renderHook(() => usePlaybackReporting(source));

    act(() => {
      result.current.handlePlaybackStarted(12.5);
      result.current.handlePlaybackProgress(21, true);
      result.current.handlePlaybackStopped(33.25);
      result.current.handlePlaybackBeforeUnload(44);
    });

    expect(reportPlaybackStart).toHaveBeenCalledWith(source, 125_000_000);
    expect(reportPlaybackProgress).toHaveBeenCalledWith(
      source,
      210_000_000,
      true,
    );
    expect(reportPlaybackStopped).toHaveBeenCalledWith(source, 332_500_000);
    expect(reportPlaybackStoppedBeforeUnload).toHaveBeenCalledWith(
      source,
      440_000_000,
    );
  });

  it("does not report without an active playback source", () => {
    const { result } = renderHook(() => usePlaybackReporting(null));

    act(() => {
      result.current.handlePlaybackStarted(1);
      result.current.handlePlaybackProgress(2, false);
      result.current.handlePlaybackStopped(3);
      result.current.handlePlaybackBeforeUnload(4);
    });

    expect(reportPlaybackStart).not.toHaveBeenCalled();
    expect(reportPlaybackProgress).not.toHaveBeenCalled();
    expect(reportPlaybackStopped).not.toHaveBeenCalled();
    expect(reportPlaybackStoppedBeforeUnload).not.toHaveBeenCalled();
  });
});
