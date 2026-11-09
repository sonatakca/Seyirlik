import { describe, expect, it } from "vitest";
import { followPresentedFrames, onScreenFrameTime } from "./useFrameCapture";

/**
 * A video element whose playback state and presented frames the test drives
 * itself. Like the real one, a frame callback is used up when it fires.
 */
function fakeVideo(currentTime: number, { paused = true } = {}) {
  let pending: VideoFrameRequestCallback | null = null;
  const events = new EventTarget();
  const video = Object.assign(events, {
    currentTime,
    paused,
    seeking: false,
    requestVideoFrameCallback(callback: VideoFrameRequestCallback) {
      pending = callback;
      return 1;
    },
  }) as unknown as HTMLVideoElement & {
    paused: boolean;
    seeking: boolean;
  };
  const present = (mediaTime: number) => {
    const callback = pending;
    pending = null;
    callback?.(0, { mediaTime } as VideoFrameCallbackMetadata);
  };
  const play = () => {
    video.paused = false;
    video.dispatchEvent(new Event("play"));
  };
  const pause = () => {
    video.paused = true;
    video.dispatchEvent(new Event("pause"));
  };
  const seek = () => {
    video.seeking = true;
    video.dispatchEvent(new Event("seeking"));
  };
  const isArmed = () => pending !== null;
  return { video, present, play, pause, seek, isArmed };
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

describe("following frames", () => {
  it("asks for no frames while playing", () => {
    const { video, isArmed } = fakeVideo(30, { paused: false });
    followPresentedFrames(video);

    expect(isArmed()).toBe(false);
  });

  it("stops at the first frame presented once playback resumes", () => {
    const { video, present, play, isArmed } = fakeVideo(30);
    followPresentedFrames(video);
    present(30.02);
    expect(isArmed()).toBe(true);

    play();
    present(30.06);

    expect(isArmed()).toBe(false);
  });

  it("forgets a paused frame once playback resumes", () => {
    // Paused at 100, played a second, paused again before any new callback.
    const { video, present, play, pause } = fakeVideo(100);
    followPresentedFrames(video);
    present(100.02);

    play();
    video.currentTime = 101;
    pause();

    expect(onScreenFrameTime(video)).toBe(101);
  });

  it("follows again from a pause", () => {
    const { video, present, play, pause } = fakeVideo(30, { paused: false });
    followPresentedFrames(video);

    pause();
    present(30.04);

    expect(onScreenFrameTime(video)).toBe(30.04);
    play();
    present(30.08);
    pause();
    present(30.5);
    expect(onScreenFrameTime(video)).toBe(30.5);
  });

  it("follows the frame a seek lands on", () => {
    const { video, present, seek, isArmed } = fakeVideo(30, {
      paused: false,
    });
    followPresentedFrames(video);

    video.currentTime = 2109.95;
    seek();
    expect(isArmed()).toBe(true);

    present(2110.024583);
    expect(onScreenFrameTime(video)).toBe(2110.024583);
  });

  it("asks for one frame at a time however often it is told to follow", () => {
    let requests = 0;
    const { video, pause, seek } = fakeVideo(30);
    const request = video.requestVideoFrameCallback.bind(video);
    video.requestVideoFrameCallback = (callback) => {
      requests += 1;
      return request(callback);
    };
    followPresentedFrames(video);
    followPresentedFrames(video);
    pause();
    seek();

    expect(requests).toBe(1);
  });
});
