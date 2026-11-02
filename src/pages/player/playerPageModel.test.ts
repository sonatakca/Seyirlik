import { describe, expect, it, vi } from "vitest";
import type { MediaItem } from "../../lib/types";
import {
  getInitialPlaybackSeconds,
  getPlayerLoadingBackdropUrl,
} from "./playerPageModel";

vi.mock("../../lib/mediaApi", () => ({
  getBackdropImageUrl: vi.fn(
    (itemId: string, tag: string | undefined, width: number) =>
      `${itemId}:${tag ?? ""}:${width}`,
  ),
}));

describe("playerPageModel", () => {
  it("preserves loading-backdrop owner and tag precedence", () => {
    expect(
      getPlayerLoadingBackdropUrl({
        Id: "episode",
        Name: "Episode",
        SeriesId: "series",
        ParentBackdropItemId: "parent",
        ParentBackdropImageTags: ["parent-tag"],
        BackdropImageTags: ["item-tag"],
      } as MediaItem),
    ).toBe("parent:parent-tag:1920");

    expect(
      getPlayerLoadingBackdropUrl({
        Id: "movie",
        Name: "Movie",
        BackdropImageTags: ["movie-tag"],
      } as MediaItem),
    ).toBe("movie:movie-tag:1920");
    expect(getPlayerLoadingBackdropUrl(null)).toBe("");
  });

  it("preserves resume ticks and explicit restart behavior", () => {
    const item = {
      Id: "movie",
      Name: "Movie",
      UserData: { PlaybackPositionTicks: 125_000_000 },
    } as MediaItem;

    expect(getInitialPlaybackSeconds(item, false)).toBe(12.5);
    expect(getInitialPlaybackSeconds(item, true)).toBe(0);
    expect(
      getInitialPlaybackSeconds(
        { Id: "empty", Name: "Empty" } as MediaItem,
        false,
      ),
    ).toBe(0);
  });

  it("starts an episode inside a shared file at its own place", () => {
    const reef = {
      Id: "reef",
      Name: "Reef Blower",
      PlayAs: { MediaFileId: "file", StartSeconds: 549, EndSeconds: 720 },
      UserData: { PlaybackPositionTicks: 300_000_000 },
    } as MediaItem;

    expect(getInitialPlaybackSeconds(reef, false)).toBe(579);
    expect(getInitialPlaybackSeconds(reef, true)).toBe(549);
  });
});
