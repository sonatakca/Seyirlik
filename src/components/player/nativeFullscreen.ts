type WebKitFullscreenVideo = HTMLVideoElement & {
  webkitSupportsPresentationMode?: (mode: string) => boolean;
  webkitSetPresentationMode?: (mode: string) => void;
  webkitEnterFullscreen?: () => void;
};

/**
 * Whether the system's own player can take this element full screen: Safari
 * on Mac, iPhone and iPad. This is Apple's player, with its own controls, not
 * the page's player stretched over the screen; that one is element full
 * screen on the player container.
 *
 * Other browsers have no system player to hand the video to, so the answer
 * there is no, and only the page's full screen is offered.
 */
export function supportsNativeFullscreen(video: HTMLVideoElement): boolean {
  const webkitVideo = video as WebKitFullscreenVideo;
  if (typeof webkitVideo.webkitSupportsPresentationMode !== "function") {
    return false;
  }
  return webkitVideo.webkitSupportsPresentationMode("fullscreen");
}

/** Whether the page can put its own player full screen. iPhone cannot. */
export function supportsElementFullscreen(element: HTMLElement): boolean {
  return (
    document.fullscreenEnabled === true &&
    typeof element.requestFullscreen === "function"
  );
}

/**
 * Must run inside the tap that asked for it. From Picture in Picture this
 * moves the video straight into the full-screen player.
 */
export function enterNativeFullscreen(video: HTMLVideoElement): void {
  const webkitVideo = video as WebKitFullscreenVideo;

  if (typeof webkitVideo.webkitSetPresentationMode === "function") {
    webkitVideo.webkitSetPresentationMode("fullscreen");
    return;
  }

  webkitVideo.webkitEnterFullscreen?.();
}
