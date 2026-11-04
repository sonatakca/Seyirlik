import { fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";
import { PlayerControls } from "./PlayerControls";

/**
 * Two full screens, never one standing in for the other: the page's own player
 * stretched over the screen, and Apple's player. iPhone has only the second.
 */

vi.mock("../../i18n/LanguageContext", () => ({
  useLanguage: () => ({ t: (key: string) => key, language: "en" }),
}));

function renderControls(
  props: Partial<ComponentProps<typeof PlayerControls>> = {},
) {
  const noop = () => {};
  return render(
    <PlayerControls
      visible
      isPlaying
      playWaiting={false}
      currentTime={10}
      duration={100}
      bufferedEnd={20}
      volume={1}
      muted={false}
      source={{ id: "s", itemId: "i", url: "/x", mode: "DirectPlay" } as never}
      qualityOptions={[]}
      selectedQualityId="auto"
      selectedAudioStreamIndex={1}
      selectedSubtitleStreamIndex={-1}
      subtitleDelaySeconds={0}
      canSwitchAudio
      canSwitchSubtitles={false}
      settingsOpen={false}
      itemId="item-1"
      onTogglePlay={noop}
      onSeek={noop}
      onSeekBy={noop}
      onToggleMute={noop}
      onVolumeChange={noop}
      onToggleFullscreen={noop}
      onOpenSettings={noop}
      onSelectAutoQuality={noop}
      onSelectQuality={noop}
      onSelectAudioStream={noop}
      onSelectSubtitleStream={noop}
      onSubtitleDelayChange={noop}
      {...props}
    />,
  );
}

describe("full screen buttons", () => {
  it("offers only the page's full screen where there is no system player", () => {
    renderControls();

    expect(screen.getByRole("button", { name: "player.fullscreen" })).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "player.nativeFullscreen" }),
    ).toBeNull();
  });

  it("offers both, each calling its own handler, on Safari", () => {
    const onToggleFullscreen = vi.fn();
    const onEnterNativeFullscreen = vi.fn();
    renderControls({
      onToggleFullscreen,
      canNativeFullscreen: true,
      onEnterNativeFullscreen,
    });

    fireEvent.click(
      screen.getByRole("button", { name: "player.nativeFullscreen" }),
    );
    expect(onEnterNativeFullscreen).toHaveBeenCalledTimes(1);
    expect(onToggleFullscreen).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "player.fullscreen" }));
    expect(onToggleFullscreen).toHaveBeenCalledTimes(1);
    expect(onEnterNativeFullscreen).toHaveBeenCalledTimes(1);
  });

  it("offers only Apple's player on iPhone", () => {
    renderControls({
      canFullscreen: false,
      canNativeFullscreen: true,
      onEnterNativeFullscreen: () => {},
    });

    expect(
      screen.queryByRole("button", { name: "player.fullscreen" }),
    ).toBeNull();
    expect(
      screen.getByRole("button", { name: "player.nativeFullscreen" }),
    ).toBeTruthy();
  });

  it("names the way out while the page is full screen", () => {
    renderControls({ isFullscreen: true });

    const button = screen.getByRole("button", {
      name: "player.exitFullscreen",
    });
    expect(button.getAttribute("aria-pressed")).toBe("true");
  });
});
