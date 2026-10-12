import { describe, expect, it, beforeEach, vi } from "vitest";
import { selectModeRungs } from "../components/player/qualityPreference";
import {
  attachSourceToVideo,
  isBandwidthFalling,
  shouldUseManagedHdrFallback,
  shouldUseNativeHls,
} from "./videoSource";

const hlsMock = vi.hoisted(() => ({
  instances: [] as Array<{
    attachMedia: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>;
    loadSource: ReturnType<typeof vi.fn>;
    on: ReturnType<typeof vi.fn>;
    autoLevelCapping: number;
    currentLevel: number;
    loadLevel: number;
    nextLevel: number;
    audioTrack: number;
    audioTracks: Array<{ name: string; url?: string }>;
    levels: Array<{ width: number; height: number; bitrate: number }>;
    bandwidthEstimate: number;
    bufferingEnabled: boolean;
    resumeBuffering: ReturnType<typeof vi.fn>;
    config: {
      xhrSetup?: (xhr: XMLHttpRequest, url: string) => void;
      fetchSetup?: (
        context: { url: string },
        initParams: RequestInit,
      ) => Request;
    };
    trigger: (event: string, data?: unknown) => void;
  }>,
  isSupported: vi.fn(() => true),
}));

vi.mock("hls.js", () => {
  class HlsMock {
    static Events = {
      ERROR: "error",
      BUFFER_APPENDED: "hlsBufferAppended",
      FRAG_BUFFERED: "hlsFragBuffered",
      LEVEL_SWITCHED: "levelSwitched",
      LEVELS_UPDATED: "levelsUpdated",
      MANIFEST_PARSED: "manifestParsed",
    };

    static ErrorDetails = {
      BUFFER_STALLED_ERROR: "bufferStalledError",
    };

    static isSupported = hlsMock.isSupported;

    autoLevelCapping = -1;
    currentLevel = -1;
    loadLevel = -1;
    levels: Array<{ width: number; height: number; bitrate: number }> = [];
    nextLevel = -1;
    startLevel = -1;
    audioTrack = -1;
    audioTracks: Array<{ name: string; url?: string }> = [];
    bandwidthEstimate = 0;
    bufferingEnabled = true;
    resumeBuffering = vi.fn(() => {
      this.bufferingEnabled = true;
    });
    handlers = new Map<
      string,
      Array<(event: string, data?: unknown) => void>
    >();

    attachMedia = vi.fn();
    destroy = vi.fn();
    loadSource = vi.fn();
    on = vi.fn(
      (event: string, handler: (event: string, data?: unknown) => void) => {
        const handlers = this.handlers.get(event) ?? [];
        handlers.push(handler);
        this.handlers.set(event, handlers);
      },
    );

    trigger(event: string, data?: unknown) {
      this.handlers.get(event)?.forEach((handler) => handler(event, data));
    }

    config: Record<string, unknown>;

    constructor(config: Record<string, unknown> = {}) {
      this.config = config;
      hlsMock.instances.push(this);
    }
  }

  return { default: HlsMock };
});

function setUserAgent(userAgent: string) {
  Object.defineProperty(window.navigator, "userAgent", {
    configurable: true,
    value: userAgent,
  });
}

function createVideo(nativeHlsSupport: CanPlayTypeResult): HTMLVideoElement {
  const video = document.createElement("video");

  vi.spyOn(video, "canPlayType").mockImplementation((mimeType) =>
    mimeType.toLowerCase().includes("mpegurl") ? nativeHlsSupport : "",
  );

  return video;
}

describe("videoSource", () => {
  beforeEach(() => {
    hlsMock.instances.length = 0;
    hlsMock.isSupported.mockReturnValue(true);
  });

  it("uses hls.js when Chromium only reports maybe native HLS support", () => {
    setUserAgent(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
    );
    const video = createVideo("maybe");
    const url = "http://example.test/play/master.m3u8";

    const attachment = attachSourceToVideo(
      video,
      url,
      "application/vnd.apple.mpegurl",
    );

    expect(attachment.usingHlsJs).toBe(true);
    expect(video.getAttribute("src")).toBeNull();
    expect(hlsMock.instances).toHaveLength(1);
    expect(hlsMock.instances[0]?.loadSource).toHaveBeenCalledWith(url);
    expect(hlsMock.instances[0]?.attachMedia).toHaveBeenCalledWith(video);
  });

  it("sends the session cookie with every hls.js request", () => {
    setUserAgent(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
    );
    const video = createVideo("maybe");

    attachSourceToVideo(
      video,
      "http://media.example.test/ownAPI/v1/playback/renditions/abc/adaptive/def/.seyirlik/master.m3u8",
      "application/vnd.apple.mpegurl",
    );

    const config = hlsMock.instances[0]?.config;
    const xhr = { withCredentials: false } as XMLHttpRequest;

    config?.xhrSetup?.(xhr, "http://media.example.test/master.m3u8");
    expect(xhr.withCredentials).toBe(true);

    const request = config?.fetchSetup?.(
      { url: "http://media.example.test/master.m3u8" },
      { method: "GET" },
    );
    expect(request?.credentials).toBe("include");
  });

  it("forwards HLS buffered and fatal events to attempt-aware callbacks", () => {
    setUserAgent(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
    );
    const video = createVideo("");
    const onHlsEvent = vi.fn();
    const onHlsFatalError = vi.fn();

    attachSourceToVideo(
      video,
      "http://example.test/play/master.m3u8",
      undefined,
      {
        onHlsEvent,
        onHlsFatalError,
      },
    );

    const hls = hlsMock.instances[0];

    hls?.trigger("hlsFragBuffered", { frag: "one" });
    hls?.trigger("error", {
      fatal: true,
      type: "networkError",
      details: "manifestLoadError",
    });

    expect(onHlsEvent).toHaveBeenCalledWith({
      name: "hlsFragBuffered",
      data: { frag: "one" },
    });
    expect(onHlsFatalError).toHaveBeenCalledWith({
      fatal: true,
      type: "networkError",
      details: "manifestLoadError",
    });
  });

  it("keeps native HLS for Safari maybe support", () => {
    setUserAgent(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15",
    );
    const video = createVideo("maybe");

    expect(shouldUseNativeHls(video)).toBe(true);
  });

  it("keeps native HLS for a strong probably signal", () => {
    setUserAgent(
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Custom/1.0",
    );
    const video = createVideo("probably");

    expect(shouldUseNativeHls(video)).toBe(true);
  });

  it("locks a letterboxed ladder by rung class, not frame height", () => {
    // A 2.39:1 film's "1440p" rung is 2560x1066. Compared by frame height it
    // fits under a 1080p lock, so the lock played the 1440p rung.
    setUserAgent("Mozilla/5.0 Chrome/149.0.0.0 Safari/537.36");
    const attachment = attachSourceToVideo(
      createVideo(""),
      "http://example.test/play/master.m3u8",
      "application/vnd.apple.mpegurl",
    );
    const hls = hlsMock.instances[0];
    if (!hls) throw new Error("hls.js was not attached");
    hls.levels = [
      { width: 1280, height: 534, bitrate: 4_500_000 },
      { width: 1920, height: 800, bitrate: 8_400_000 },
      { width: 2560, height: 1066, bitrate: 12_000_000 },
      { width: 3840, height: 1600, bitrate: 15_800_000 },
    ];
    hls.trigger("manifestParsed", {});

    attachment.adaptiveController?.setQualityHeight(1080, 1080);
    expect(hls.loadLevel).toBe(1);
    expect(hls.autoLevelCapping).toBe(1);

    // A mode ceiling is a class too.
    attachment.adaptiveController?.setQualityHeight(
      null,
      1440,
      "higher-resolution",
    );
    expect(hls.autoLevelCapping).toBe(2);
  });

  it("applies a manual rung ahead of the play head and returns to automatic without flushing", () => {
    setUserAgent("Mozilla/5.0 Chrome/149.0.0.0 Safari/537.36");
    const onAdaptiveLevelChanged = vi.fn();
    const attachment = attachSourceToVideo(
      createVideo(""),
      "http://example.test/play/master.m3u8",
      "application/vnd.apple.mpegurl",
      { onAdaptiveLevelChanged },
    );
    const hls = hlsMock.instances[0];
    if (!hls) throw new Error("hls.js was not attached");
    hls.levels = [
      { width: 854, height: 480, bitrate: 1_500_000 },
      { width: 1280, height: 720, bitrate: 3_000_000 },
      { width: 1920, height: 1080, bitrate: 6_000_000 },
    ];
    hls.trigger("manifestParsed", {});

    attachment.adaptiveController?.setQualityHeight(720, 720);
    expect(hls.loadLevel).toBe(1);
    expect(hls.autoLevelCapping).toBe(1);
    // `nextLevel` replaces what is buffered ahead, so a title whose whole
    // timeline is already downloaded still changes rung within a second or two
    // instead of waiting minutes for the old one to play out.
    expect(hls.nextLevel).toBe(1);
    // The fragment on screen is left alone: flushing everything is what puts a
    // black frame in front of the viewer.
    expect(hls.currentLevel).toBe(-1);

    hls.trigger("levelSwitched", { level: 1 });
    // Width travels with height: a rung is named by its class while the frame
    // it emits follows the source's shape, so the caller matches on width.
    expect(onAdaptiveLevelChanged).toHaveBeenCalledWith({
      height: 720,
      width: 1280,
    });

    attachment.adaptiveController?.setQualityHeight(null, null);
    expect(hls.autoLevelCapping).toBe(-1);
    /*
     * Automatic no longer means `-1`. hls.js's own ABR answered the bottom
     * rung on a link measured at 16.8 Mbps, so Seyirlik resolves the rung and
     * drives it; `-1` here would hand the ladder straight back to the
     * behaviour this replaced.
     */
    expect(hls.loadLevel).not.toBe(-1);
    expect(hls.nextLevel).toBe(hls.loadLevel);
    // Still no flush: the fragment on screen is left alone.
    expect(hls.currentLevel).toBe(-1);
  });

  describe("hls.js audio rendition switching", () => {
    function attachWithTracks(tracks: Array<{ name: string; url?: string }>) {
      setUserAgent("Mozilla/5.0 Chrome/149.0.0.0 Safari/537.36");
      const attachment = attachSourceToVideo(
        createVideo(""),
        "http://example.test/play/master.m3u8",
        "application/vnd.apple.mpegurl",
      );
      const hls = hlsMock.instances[0];
      if (!hls) throw new Error("hls.js was not attached");
      hls.audioTracks = tracks;
      return { attachment, hls };
    }

    /**
     * Audio renditions are addressed by their source stream index, which is
     * what the package's directory names carry, so a regenerated package that
     * drops a track cannot silently re-point a saved choice at another
     * language.
     */
    it("selects a rendition by its source stream index", () => {
      const { attachment, hls } = attachWithTracks([
        {
          name: "English",
          url: "https://media.test/audio/track-1/playlist.m3u8",
        },
        {
          name: "Turkish",
          url: "https://media.test/audio/track-2/playlist.m3u8",
        },
        {
          name: "French",
          url: "https://media.test/audio/track-3/playlist.m3u8",
        },
      ]);

      expect(attachment.adaptiveController?.setAudioStream(2)).toBe(true);
      expect(hls.audioTrack).toBe(1);

      expect(attachment.adaptiveController?.setAudioStream(3)).toBe(true);
      expect(hls.audioTrack).toBe(2);

      expect(attachment.adaptiveController?.setAudioStream(1)).toBe(true);
      expect(hls.audioTrack).toBe(0);
    });

    it("reports a rendition the package does not carry rather than silently keeping the old one", () => {
      const { attachment, hls } = attachWithTracks([
        {
          name: "English",
          url: "https://media.test/audio/track-1/playlist.m3u8",
        },
      ]);
      hls.audioTrack = 0;

      expect(attachment.adaptiveController?.setAudioStream(7)).toBe(false);
      expect(hls.audioTrack).toBe(0);
    });

    it("falls back to the rendition name when the track carries no url", () => {
      const { attachment, hls } = attachWithTracks([
        { name: "audio/track-1" },
        { name: "audio/track-2" },
      ]);

      expect(attachment.adaptiveController?.setAudioStream(2)).toBe(true);
      expect(hls.audioTrack).toBe(1);
    });

    it("has no controller at all on a native HLS engine", () => {
      // Safari plays the package itself, so there is nothing to call. The
      // player must recognise this and re-plan rather than treat the missing
      // controller as a completed switch.
      setUserAgent(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15",
      );
      const attachment = attachSourceToVideo(
        createVideo("maybe"),
        "http://example.test/play/master.m3u8",
        "application/vnd.apple.mpegurl",
      );

      expect(attachment.usingHlsJs).toBe(false);
      expect(attachment.adaptiveController).toBeUndefined();
    });
  });

  it("bounds automatic switching by the ceiling it is given", () => {
    setUserAgent("Mozilla/5.0 Chrome/149.0.0.0 Safari/537.36");
    const attachment = attachSourceToVideo(
      createVideo(""),
      "http://example.test/play/master.m3u8",
      "application/vnd.apple.mpegurl",
    );
    const hls = hlsMock.instances[0];
    if (!hls) throw new Error("hls.js was not attached");
    hls.levels = [
      { width: 854, height: 480, bitrate: 1_500_000 },
      { width: 1280, height: 720, bitrate: 3_000_000 },
      { width: 1920, height: 1080, bitrate: 6_000_000 },
    ];
    hls.trigger("manifestParsed", {});

    // A ceiling bounds the choice; Seyirlik still resolves a concrete rung
    // within it rather than delegating the decision to hls.js.
    attachment.adaptiveController?.setQualityHeight(null, 720);

    expect(hls.autoLevelCapping).toBe(1);
    expect(hls.loadLevel).toBeLessThanOrEqual(1);
    expect(hls.loadLevel).not.toBe(-1);
    expect(hls.nextLevel).toBe(hls.loadLevel);
  });

  it("drives the canonical Higher Quality target rather than only capping", () => {
    setUserAgent("Mozilla/5.0 Chrome/149.0.0.0 Safari/537.36");
    const video = createVideo("");
    vi.spyOn(video, "getBoundingClientRect").mockReturnValue({
      height: 144,
    } as DOMRect);
    const attachment = attachSourceToVideo(
      video,
      "http://example.test/play/master.m3u8",
      "application/vnd.apple.mpegurl",
    );
    const hls = hlsMock.instances[0];
    if (!hls) throw new Error("hls.js was not attached");
    hls.levels = [
      { width: 256, height: 144, bitrate: 180_000 },
      { width: 426, height: 240, bitrate: 350_000 },
      { width: 640, height: 360, bitrate: 700_000 },
      { width: 854, height: 480, bitrate: 1_400_000 },
      { width: 1280, height: 720, bitrate: 3_000_000 },
      { width: 1920, height: 1080, bitrate: 5_500_000 },
    ];
    hls.trigger("manifestParsed", {});

    const rungs = hls.levels.map((level) => ({
      height: level.height,
      bitrate: level.bitrate,
    }));
    const { anchor, higher } = selectModeRungs(rungs, { saveData: true });
    expect(anchor?.height).toBe(144);
    expect(higher?.height).toBe(720);

    attachment.adaptiveController?.setQualityHeight(
      null,
      higher?.height ?? null,
      "higher-resolution",
    );
    expect(hls.autoLevelCapping).toBe(4);
    /*
     * Higher Quality has to reach the rung above the anchor. Expressed only as
     * a cap it never did: on the iPad the cap sat five rungs up while hls.js
     * kept choosing the bottom one, so the mode did nothing at all.
     */
    expect(hls.loadLevel).toBe(4);
    expect(hls.nextLevel).toBe(4);
  });
});

describe("shouldUseManagedHdrFallback", () => {
  const withWindow = (
    overrides: { managed?: boolean; hdrDisplay?: boolean },
    run: () => void,
  ) => {
    const managedDescriptor = Object.getOwnPropertyDescriptor(
      window,
      "ManagedMediaSource",
    );
    const originalMatchMedia = window.matchMedia;
    if (overrides.managed) {
      Object.defineProperty(window, "ManagedMediaSource", {
        value: class {},
        configurable: true,
      });
    } else {
      Reflect.deleteProperty(window as object, "ManagedMediaSource");
    }
    window.matchMedia = ((query: string) =>
      ({
        matches:
          query.includes("dynamic-range: high") &&
          overrides.hdrDisplay === true,
      }) as MediaQueryList) as typeof window.matchMedia;
    try {
      run();
    } finally {
      Reflect.deleteProperty(window as object, "ManagedMediaSource");
      if (managedDescriptor) {
        Object.defineProperty(window, "ManagedMediaSource", managedDescriptor);
      }
      window.matchMedia = originalMatchMedia;
    }
  };

  it("diverts an HDR-only package on a display that cannot present HDR", () => {
    withWindow({ managed: true, hdrDisplay: false }, () => {
      expect(shouldUseManagedHdrFallback({ hdrOnlyPackage: true })).toBe(true);
    });
  });

  it("leaves a package that has an SDR rung on the native path", () => {
    withWindow({ managed: true, hdrDisplay: false }, () => {
      expect(shouldUseManagedHdrFallback({ hdrOnlyPackage: false })).toBe(
        false,
      );
    });
  });

  it("leaves an HDR display on the native path so AirPlay survives", () => {
    withWindow({ managed: true, hdrDisplay: true }, () => {
      expect(shouldUseManagedHdrFallback({ hdrOnlyPackage: true })).toBe(false);
    });
  });

  it("does not divert when ManagedMediaSource is unavailable", () => {
    withWindow({ managed: false, hdrDisplay: false }, () => {
      expect(shouldUseManagedHdrFallback({ hdrOnlyPackage: true })).toBe(false);
    });
  });

  it("re-reads the display each time rather than caching a verdict", () => {
    withWindow({ managed: true, hdrDisplay: false }, () => {
      expect(shouldUseManagedHdrFallback({ hdrOnlyPackage: true })).toBe(true);
    });
    // Same package, HDR display attached: the answer has to change.
    withWindow({ managed: true, hdrDisplay: true }, () => {
      expect(shouldUseManagedHdrFallback({ hdrOnlyPackage: true })).toBe(false);
    });
  });
});

describe("isBandwidthFalling", () => {
  const series = (values: number[], step = 2000) =>
    values.map((bps, index) => ({ at: index * step, bps }));
  const now = (values: number[], step = 2000) => (values.length - 1) * step;

  it("reads a healthy, stable link as not falling", () => {
    const samples = [5_000_000, 5_100_000, 4_900_000, 5_000_000];
    expect(isBandwidthFalling(series(samples), now(samples))).toBe(false);
  });

  it("reads a recovering link as not falling", () => {
    const samples = [1_000_000, 2_000_000, 4_000_000, 6_000_000];
    expect(isBandwidthFalling(series(samples), now(samples))).toBe(false);
  });

  it("reads a sharp collapse as falling", () => {
    const samples = [8_000_000, 6_000_000, 3_000_000, 1_000_000];
    expect(isBandwidthFalling(series(samples), now(samples))).toBe(true);
  });

  it("does not read the jitter of a low rung as a collapse", () => {
    // What a 144p rung actually measures on an idle LAN: ~120 kB fragments
    // that land in milliseconds, so the estimate is mostly overhead and wobbles
    // without the link changing at all. Calling this a collapse would re-trap
    // the session on the bottom rung, which is what the probe exists to undo.
    const samples = [950_000, 880_000, 800_000, 900_000];
    expect(isBandwidthFalling(series(samples), now(samples))).toBe(false);
  });

  it("does not read a mild decline as meaningful", () => {
    const samples = [4_000_000, 3_600_000, 3_200_000, 3_000_000];
    expect(isBandwidthFalling(series(samples), now(samples))).toBe(false);
  });

  it("needs more than a reading or two before it claims a direction", () => {
    expect(
      isBandwidthFalling(
        [
          { at: 0, bps: 8_000_000 },
          { at: 2000, bps: 500_000 },
        ],
        2000,
      ),
    ).toBe(false);
  });

  it("forgets a peak that has aged out of the window", () => {
    // A link that dropped a minute ago and has been steady since is not
    // falling now, and must not be held down by its own history.
    expect(
      isBandwidthFalling(
        [
          { at: 0, bps: 8_000_000 },
          { at: 60_000, bps: 1_000_000 },
          { at: 62_000, bps: 1_050_000 },
          { at: 64_000, bps: 1_000_000 },
        ],
        64_000,
      ),
    ).toBe(false);
  });
});

describe("the adaptive buffer probe", () => {
  beforeEach(() => {
    hlsMock.instances.length = 0;
    hlsMock.isSupported.mockReturnValue(true);
  });

  const LADDER = [
    { width: 256, height: 144, bitrate: 180_000 },
    { width: 426, height: 240, bitrate: 350_000 },
    { width: 640, height: 360, bitrate: 700_000 },
    { width: 854, height: 480, bitrate: 1_400_000 },
    { width: 1280, height: 720, bitrate: 3_000_000 },
    { width: 1920, height: 1080, bitrate: 5_500_000 },
  ];

  /**
   * A session already playing in Auto with a comfortable forward buffer and no
   * stalls — the state in which the probe is the only thing that can climb.
   */
  function playingInAuto(estimateBps: number) {
    setUserAgent("Mozilla/5.0 Chrome/149.0.0.0 Safari/537.36");
    const video = createVideo("");
    vi.spyOn(video, "getBoundingClientRect").mockReturnValue({
      height: 400,
    } as DOMRect);
    let bufferedAhead = 12;
    Object.defineProperty(video, "buffered", {
      configurable: true,
      get: () =>
        ({
          length: 1,
          start: () => 0,
          end: () => bufferedAhead,
        }) as unknown as TimeRanges,
    });

    let clock = 0;
    const dateNow = vi.spyOn(Date, "now").mockImplementation(() => clock);

    const attachment = attachSourceToVideo(
      video,
      "http://example.test/play/master.m3u8",
      "application/vnd.apple.mpegurl",
    );
    const hls = hlsMock.instances[0];
    if (!hls) throw new Error("hls.js was not attached");
    hls.levels = [...LADDER];
    hls.bandwidthEstimate = estimateBps;
    hls.trigger("manifestParsed", {});
    attachment.adaptiveController?.setQualityHeight(null, null, "auto");

    return {
      hls,
      dateNow,
      /** The forward buffer collapses to nothing worth arguing about. */
      starveBuffer() {
        bufferedAhead = 2;
      },
      /** The viewer (or a party catching up) moves the play head. */
      seek() {
        video.dispatchEvent(new Event("seeking"));
      },
      /** hls.js reports that the play head has nothing left to play. */
      stall() {
        hls.trigger("error", {
          fatal: false,
          details: "bufferStalledError",
        });
      },
      /** One fragment lands: the clock moves and the policy reconsiders. */
      tick(estimate: number) {
        clock += 2000;
        hls.bandwidthEstimate = estimate;
        hls.trigger("hlsFragBuffered", {});
      },
    };
  }

  it("still climbs out of a low rung whose estimate is only small fragments", () => {
    // The anti-trap case: 900 kbps is what the bottom of the ladder measures,
    // not what the link can do, and the full buffer is the evidence for that.
    const session = playingInAuto(900_000);
    expect(session.hls.loadLevel).toBe(1);

    // Six seconds of healthy buffer is enough to earn the climb. The pace is
    // the point: a viewer reads a rung that arrives a minute later as the
    // player being stuck, not as caution.
    for (const estimate of [880_000, 920_000, 900_000]) session.tick(estimate);

    // One rung above what the estimate alone would ever have justified.
    expect(session.hls.loadLevel).toBe(2);
    expect(session.hls.nextLevel).toBe(2);
    session.dateNow.mockRestore();
  });

  it("stands aside once the estimate is genuinely collapsing", () => {
    // Same buffer, same absence of stalls, same starting rung — only the
    // direction of the estimate differs. Seen on the iPad as a climb to
    // 1280 wide at 62 s during a 350 kbps throttle, corrected 12 s later.
    const session = playingInAuto(900_000);
    expect(session.hls.loadLevel).toBe(1);

    for (const estimate of [
      800_000, 500_000, 300_000, 250_000, 250_000, 240_000,
    ]) {
      session.tick(estimate);
    }

    // The rung the collapsing link justifies, and no exploratory climb above it.
    expect(session.hls.loadLevel).toBe(0);
    expect(session.hls.nextLevel).toBe(0);
    session.dateNow.mockRestore();
  });

  it("keeps a probed rung long enough for it to be measured", () => {
    // The probe is taken *because* the reading is wrong, so the same reading
    // cannot be what overturns it a second later. Without the grace the two
    // argue every tick and the picture flickers between two rungs.
    const session = playingInAuto(900_000);
    for (const estimate of [880_000, 920_000, 900_000]) session.tick(estimate);
    const probed = session.hls.loadLevel;
    expect(probed).toBe(2);

    // Same stale reading, healthy buffer, no stalls: the climb stands.
    for (let index = 0; index < 3; index += 1) session.tick(900_000);
    expect(session.hls.loadLevel).toBeGreaterThanOrEqual(probed);
    session.dateNow.mockRestore();
  });

  it("gives up a probed rung at once when the buffer stops backing it", () => {
    const session = playingInAuto(900_000);
    for (const estimate of [880_000, 920_000, 900_000]) session.tick(estimate);
    expect(session.hls.loadLevel).toBe(2);

    // The buffer was the whole case for the climb. Once it is gone the grace
    // is over, whatever the clock says.
    session.starveBuffer();
    session.tick(900_000);
    expect(session.hls.loadLevel).toBe(1);
    session.dateNow.mockRestore();
  });

  it("steps down on a starved stall instead of waiting for the estimate", () => {
    // A stall means the fragment in flight is not arriving, and the estimate
    // cannot say so — it only moves when a fragment finishes. Driving the
    // level explicitly also switches off hls.js's own abandon-and-retry, so
    // nothing else will give that fragment up either. Measured on the iPad,
    // a link that went away left the session on 1080p until the loader timed
    // out about a minute later.
    const session = playingInAuto(20_000_000);
    const started = session.hls.loadLevel;
    expect(started).toBeGreaterThan(0);

    session.starveBuffer();
    session.stall();
    expect(session.hls.loadLevel).toBe(started - 1);
    // `nextLevel` is what abandons the fragment that is not arriving.
    expect(session.hls.nextLevel).toBe(started - 1);

    // And the still-optimistic estimate must not climb straight back into it.
    session.tick(20_000_000);
    session.tick(20_000_000);
    expect(session.hls.loadLevel).toBe(started - 1);
    session.dateNow.mockRestore();
  });

  it("does not charge the link for the stall a seek causes", () => {
    // A seek empties the buffer by definition. Charging the stall that follows
    // cost a rung and the climb every time a party caught up, which held a
    // session at the bottom of the ladder for as long as the party lasted.
    const session = playingInAuto(20_000_000);
    const started = session.hls.loadLevel;
    expect(started).toBeGreaterThan(0);

    session.seek();
    session.starveBuffer();
    session.stall();
    expect(session.hls.loadLevel).toBe(started);

    // Once the seek is well behind it, a starved stall is the link's again.
    for (let index = 0; index < 3; index += 1) session.tick(20_000_000);
    session.stall();
    expect(session.hls.loadLevel).toBe(started - 1);
    session.dateNow.mockRestore();
  });

  it("carries the link's history across a manual rung and back", () => {
    // A collapse that happens while the viewer is on a manual rung is still a
    // collapse. Sampling only while Auto is in charge would hand the session an
    // empty history at the moment it resumes deciding, and an empty history
    // reads as steady — which is how a probe climbs straight into a dead link.
    setUserAgent("Mozilla/5.0 Chrome/149.0.0.0 Safari/537.36");
    const video = createVideo("");
    vi.spyOn(video, "getBoundingClientRect").mockReturnValue({
      height: 400,
    } as DOMRect);
    Object.defineProperty(video, "buffered", {
      configurable: true,
      get: () =>
        ({ length: 1, start: () => 0, end: () => 12 }) as unknown as TimeRanges,
    });
    let clock = 0;
    const dateNow = vi.spyOn(Date, "now").mockImplementation(() => clock);

    const attachment = attachSourceToVideo(
      video,
      "http://example.test/play/master.m3u8",
      "application/vnd.apple.mpegurl",
    );
    const hls = hlsMock.instances[0];
    if (!hls) throw new Error("hls.js was not attached");
    hls.levels = [...LADDER];
    hls.bandwidthEstimate = 8_000_000;
    hls.trigger("manifestParsed", {});

    const tick = (estimate: number) => {
      clock += 2000;
      hls.bandwidthEstimate = estimate;
      hls.trigger("hlsFragBuffered", {});
    };

    // Locked to the bottom rung while the link falls away underneath it.
    attachment.adaptiveController?.setQualityHeight(144, 144);
    expect(hls.loadLevel).toBe(0);
    for (const estimate of [8_000_000, 3_000_000, 1_000_000, 400_000]) {
      tick(estimate);
    }

    attachment.adaptiveController?.setQualityHeight(null, null, "auto");
    expect(hls.loadLevel).toBe(0);

    // Auto is back and the buffer is deep, but the link is visibly on its way
    // down, so the probe stays where it is.
    for (let index = 0; index < 3; index += 1) tick(400_000);
    expect(hls.loadLevel).toBe(0);

    // Once the collapse has aged out and the reading has held steady, the
    // ordinary anti-trap climb is available again.
    let highest = 0;
    for (let index = 0; index < 10; index += 1) {
      tick(400_000);
      highest = Math.max(highest, hls.loadLevel);
    }
    expect(highest).toBeGreaterThan(0);
    dateNow.mockRestore();
  });

  it("resumes climbing once a collapsed link has steadied again", () => {
    const session = playingInAuto(900_000);
    for (const estimate of [800_000, 500_000, 300_000, 250_000]) {
      session.tick(estimate);
    }
    expect(session.hls.loadLevel).toBe(0);

    // Steady again at the same low reading: the direction is what changed.
    // The reading never improves here because the test pins it, so the climb
    // is given up again and retried; what matters is that it is attempted at
    // all, which is what a falling reading forbids.
    let highest = 0;
    for (let index = 0; index < 8; index += 1) {
      session.tick(250_000 + (index % 2) * 10_000);
      highest = Math.max(highest, session.hls.loadLevel);
    }

    expect(highest).toBeGreaterThan(0);
    session.dateNow.mockRestore();
  });
});

describe("loading the browser paused under ManagedMediaSource", () => {
  beforeEach(() => {
    hlsMock.instances.length = 0;
    hlsMock.isSupported.mockReturnValue(true);
  });

  /**
   * hls.js obeys `endstreaming` by pausing its loaders, then waits for a
   * `startstreaming` that WebKit does not send after a seek out of the buffer.
   * Here hls.js has been paused that way, with media buffered from 0 to 40 s.
   */
  function pausedByTheBrowser() {
    setUserAgent("Mozilla/5.0 Chrome/149.0.0.0 Safari/537.36");
    const video = createVideo("");
    Object.defineProperty(video, "buffered", {
      configurable: true,
      get: () =>
        ({ length: 1, start: () => 0, end: () => 40 }) as unknown as TimeRanges,
    });
    const attachment = attachSourceToVideo(
      video,
      "http://example.test/play/master.m3u8",
      "application/vnd.apple.mpegurl",
      { adaptiveRendition: true },
    );
    const hls = hlsMock.instances[0];
    if (!hls) throw new Error("hls.js was not attached");
    hls.bufferingEnabled = false;
    const seekTo = (seconds: number) => {
      video.currentTime = seconds;
      video.dispatchEvent(new Event("seeking"));
    };
    return { video, hls, attachment, seekTo };
  }

  it("starts loading again when a seek leaves the buffer", () => {
    const { hls, attachment, seekTo } = pausedByTheBrowser();

    seekTo(200);

    expect(hls.resumeBuffering).toHaveBeenCalledTimes(1);
    attachment.destroy();
  });

  it("leaves the browser's pause alone for a seek it already has media for", () => {
    const { hls, attachment, seekTo } = pausedByTheBrowser();

    seekTo(10);

    expect(hls.resumeBuffering).not.toHaveBeenCalled();
    attachment.destroy();
  });

  it("starts loading again when the play head runs dry", () => {
    const { video, hls, attachment } = pausedByTheBrowser();

    video.currentTime = 39.5;
    video.dispatchEvent(new Event("waiting"));

    expect(hls.resumeBuffering).toHaveBeenCalledTimes(1);
    attachment.destroy();
  });

  it("does nothing while loading was never paused", () => {
    const { hls, attachment, seekTo } = pausedByTheBrowser();
    hls.bufferingEnabled = true;

    seekTo(200);

    expect(hls.resumeBuffering).not.toHaveBeenCalled();
    attachment.destroy();
  });
});
