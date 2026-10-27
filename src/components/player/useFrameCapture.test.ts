import { describe, expect, it } from "vitest";
import { followPresentedFrames, onScreenFrameTime } from "./useFrameCapture";

/** A video element whose presented frames the test announces itself. */
function fakeVideo(currentTime: number) {
  let pending: VideoFrameRequestCallback | null = null;
  const video = {
    currentTime,
    requestVideoFrameCallback(callback: VideoFrameRequestCallback) {
      pending = callback;
      return 1;
    },
  } as unknown as HTMLVideoElement;
  const present = (mediaTime: number) =>
    pending?.(0, { mediaTime } as VideoFrameCallbackMetadata);
  return { video, present };
}

describe("the frame on screen", () => {
  it("is the presented frame's own time, not the element's", () => {
    // Safari paused at 35:09 showing a frame that began after currentTime.
    const { video, present } = fakeVideo(2109.95);
    followPresentedFrames(video);
    present(2109.982875);

    expect(onScreenFrameTime(video)).toBe(2109.982875);

    present(2110.024583);
    expect(onScreenFrameTime(video)).toBe(2110.024583);
  });

  it("is the element's time before any frame has been presented", () => {
    const { video } = fakeVideo(12.3);
    followPresentedFrames(video);

    expect(onScreenFrameTime(video)).toBe(12.3);
  });

  it("is the element's time where the browser cannot report frames", () => {
    const video = { currentTime: 40 } as HTMLVideoElement;
    followPresentedFrames(video);

    expect(onScreenFrameTime(video)).toBe(40);
  });

  it("ignores a presented time from some other moment", () => {
    const { video, present } = fakeVideo(600);
    followPresentedFrames(video);
    present(12);

    expect(onScreenFrameTime(video)).toBe(600);
  });
});
