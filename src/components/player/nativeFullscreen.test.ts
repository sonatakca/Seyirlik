import { describe, expect, it, vi } from "vitest";
import {
  enterNativeFullscreen,
  supportsNativeFullscreen,
} from "./nativeFullscreen";

describe("native full screen", () => {
  it("is unsupported without Safari's presentation modes", () => {
    const video = document.createElement("video");
    expect(supportsNativeFullscreen(video)).toBe(false);
  });

  it("asks Safari whether its player can take the element", () => {
    const video = document.createElement("video");
    const supports = vi.fn((mode: string) => mode === "fullscreen");
    Object.assign(video, { webkitSupportsPresentationMode: supports });

    expect(supportsNativeFullscreen(video)).toBe(true);
    expect(supports).toHaveBeenCalledWith("fullscreen");
  });

  it("hands the element to the full-screen presentation mode", () => {
    const video = document.createElement("video");
    const setMode = vi.fn();
    const enter = vi.fn();
    Object.assign(video, {
      webkitSetPresentationMode: setMode,
      webkitEnterFullscreen: enter,
    });

    enterNativeFullscreen(video);

    expect(setMode).toHaveBeenCalledWith("fullscreen");
    expect(enter).not.toHaveBeenCalled();
  });

  it("falls back to the older entry point", () => {
    const video = document.createElement("video");
    const enter = vi.fn();
    Object.assign(video, { webkitEnterFullscreen: enter });

    enterNativeFullscreen(video);

    expect(enter).toHaveBeenCalledTimes(1);
  });
});
