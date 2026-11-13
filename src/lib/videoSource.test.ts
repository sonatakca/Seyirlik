import { afterEach, describe, expect, it, beforeEach, vi } from "vitest";
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
    stopLoad: ReturnType<typeof vi.fn>;
    startLoad: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>;
    loadSource: ReturnType<typeof vi.fn>;
    on: ReturnType<typeof vi.fn>;
    autoLevelCapping: number;
    currentLevel: number;
    loadLevel: number;
    nextLevel: number;
    nextAutoLevel: number;
    startLevel: number;
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
      FRAG_LOADING: "hlsFragLoading",
      FRAG_LOADED: "hlsFragLoaded",
      FRAG_LOAD_EMERGENCY_ABORTED: "hlsFragLoadEmergencyAborted",
      BUFFER_FLUSHING: "hlsBufferFlushing",
      BUFFER_FLUSHED: "hlsBufferFlushed",
      LEVEL_SWITCHED: "levelSwitched",
      LEVELS_UPDATED: "levelsUpdated",
      MANIFEST_PARSED: "manifestParsed",
    };

    static ErrorDetails = {
      BUFFER_STALLED_ERROR: "bufferStalledError",
    };

    static isSupported = hlsMock.isSupported;

    /*
     * Stands in for hls.js's AbrController: what the engine reads when it is
     * in automatic mode and picks the next fragment's rung. `forced` is what
     * the engine itself last set (abandonment, error fallback).
     */
    static DefaultConfig = {
      abrController: class {
        hls: unknown;
        forced = -1;
        /** Stands in for the engine's bandwidth estimator and its resets. */
        bwEstimator = {};
        resets: Array<number | undefined> = [];
        /** Stands in for the engine's emergency-abandonment check. */
        abandonChecks = 0;
        _abandonRulesCheck = () => {
          this.abandonChecks += 1;
        };
        constructor(hls: unknown) {
          this.hls = hls;
        }
        resetEstimator(value?: number) {
          this.resets.push(value);
        }
        get nextAutoLevel() {
          return this.forced;
        }
        set nextAutoLevel(level: number) {
          this.forced = level;
        }
      },
    };

    abr: { nextAutoLevel: number };

    /** The engine's automatic choice, through the configured controller. */
    get nextAutoLevel() {
      return this.abr.nextAutoLevel;
    }

    set nextAutoLevel(level: number) {
      this.abr.nextAutoLevel = level;
    }

    get autoLevelEnabled() {
      return this.loadLevel === -1;
    }

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
    stopLoad = vi.fn();
    startLoad = vi.fn();
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
      const Abr = (config.abrController ??
        HlsMock.DefaultConfig.abrController) as new (hls: unknown) => {
        nextAutoLevel: number;
      };
      this.abr = new Abr(this);
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

/**
 * The rung the engine will fetch next: the viewer's lock in manual mode,
 * otherwise what the ABR controller (Seyirlik's policy) answers.
 */
function drivenLevel(hls: { loadLevel: number; nextAutoLevel: number }) {
  return hls.loadLevel !== -1 ? hls.loadLevel : hls.nextAutoLevel;
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
    // A lock is the engine's manual mode: it changes what is fetched next.
    expect(hls.loadLevel).toBe(1);
    expect(hls.autoLevelCapping).toBe(1);
    // Neither of the engine's flushing switches is used: `nextLevel` also
    // discarded everything behind the play head and cut mid-fragment, and
    // `currentLevel` flushes everything, which puts a black frame on screen.
    // What is replaced ahead is decided by Seyirlik (see the replacement
    // tests below); with nothing buffered here there is nothing to replace.
    expect(hls.nextLevel).toBe(-1);
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
     * Back to the engine's automatic mode, which is the non-destructive one:
     * a new rung only changes the next fragment. The rung is still Seyirlik's
     * — hls.js's own ABR answered the bottom rung on a link measured at
     * 16.8 Mbps — so the controller answers with the policy's choice.
     */
    expect(hls.loadLevel).toBe(-1);
    expect(hls.nextAutoLevel).not.toBe(-1);
    // Still no flush of any kind.
    expect(hls.nextLevel).toBe(-1);
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
    expect(drivenLevel(hls)).toBeLessThanOrEqual(1);
    expect(drivenLevel(hls)).not.toBe(-1);
    // Decided, and nothing buffered was discarded to apply it.
    expect(hls.nextLevel).toBe(-1);
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
    expect(drivenLevel(hls)).toBe(4);
    expect(hls.nextLevel).toBe(-1);
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

    // The fragment that lands is from the rung the engine was fetching.
    let sn = 0;
    const nextFragment = () => {
      sn += 1;
      return {
        type: "main",
        sn,
        level: drivenLevel(hls),
        start: sn * 2,
        duration: 2,
      };
    };

    return {
      hls,
      attachment,
      dateNow,
      /** The forward buffer collapses to nothing worth arguing about. */
      starveBuffer() {
        bufferedAhead = 2;
      },
      /** The buffer is healthy again. */
      refillBuffer() {
        bufferedAhead = 12;
      },
      advance(ms: number) {
        clock += ms;
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
        hls.trigger("hlsFragBuffered", { frag: nextFragment() });
      },
    };
  }

  it("still climbs out of a low rung whose estimate is only small fragments", () => {
    // The anti-trap case: 900 kbps is what the bottom of the ladder measures,
    // not what the link can do, and the full buffer is the evidence for that.
    const session = playingInAuto(900_000);
    expect(drivenLevel(session.hls)).toBe(1);

    // Six seconds of healthy buffer is enough to earn the climb. The pace is
    // the point: a viewer reads a rung that arrives a minute later as the
    // player being stuck, not as caution.
    for (const estimate of [880_000, 920_000, 900_000]) session.tick(estimate);

    // One rung above what the estimate alone would ever have justified.
    expect(drivenLevel(session.hls)).toBe(2);
    expect(session.hls.nextLevel).toBe(-1);
    session.dateNow.mockRestore();
  });

  it("stands aside once the estimate is genuinely collapsing", () => {
    // Same buffer, same absence of stalls, same starting rung — only the
    // direction of the estimate differs. Seen on the iPad as a climb to
    // 1280 wide at 62 s during a 350 kbps throttle, corrected 12 s later.
    const session = playingInAuto(900_000);
    expect(drivenLevel(session.hls)).toBe(1);

    for (const estimate of [
      800_000, 500_000, 300_000, 250_000, 250_000, 240_000,
    ]) {
      session.tick(estimate);
    }

    // The rung the collapsing link justifies, and no exploratory climb above it.
    expect(drivenLevel(session.hls)).toBe(0);
    expect(session.hls.nextLevel).toBe(-1);
    session.dateNow.mockRestore();
  });

  it("keeps a probed rung long enough for it to be measured", () => {
    // The probe is taken *because* the reading is wrong, so the same reading
    // cannot be what overturns it a second later. Without the grace the two
    // argue every tick and the picture flickers between two rungs.
    const session = playingInAuto(900_000);
    for (const estimate of [880_000, 920_000, 900_000]) session.tick(estimate);
    const probed = drivenLevel(session.hls);
    expect(probed).toBe(2);

    // Same stale reading, healthy buffer, no stalls: the climb stands.
    for (let index = 0; index < 3; index += 1) session.tick(900_000);
    expect(drivenLevel(session.hls)).toBeGreaterThanOrEqual(probed);
    session.dateNow.mockRestore();
  });

  it("gives up a probed rung at once when the buffer stops backing it", () => {
    const session = playingInAuto(900_000);
    for (const estimate of [880_000, 920_000, 900_000]) session.tick(estimate);
    expect(drivenLevel(session.hls)).toBe(2);

    // The buffer was the whole case for the climb. Once it is gone the grace
    // is over, whatever the clock says.
    session.starveBuffer();
    session.tick(900_000);
    expect(drivenLevel(session.hls)).toBe(1);
    session.dateNow.mockRestore();
  });

  it("steps down on a starved stall instead of waiting for the estimate", () => {
    // A stall means the fragment in flight is not arriving, and the estimate
    // cannot say so — it only moves when a fragment finishes. Measured on the
    // iPad, a link that went away left the session on 1080p until the loader
    // timed out about a minute later.
    const session = playingInAuto(20_000_000);
    const started = drivenLevel(session.hls);
    expect(started).toBeGreaterThan(0);

    session.starveBuffer();
    session.stall();
    expect(drivenLevel(session.hls)).toBe(started - 1);
    // The engine's abandonment rules are told, so a fragment that is not
    // arriving can be given up for the cheaper rung's — and nothing already
    // buffered is flushed to get there.
    expect(
      (session.hls as unknown as { abr: { forced: number } }).abr.forced,
    ).toBe(started - 1);
    expect(session.hls.nextLevel).toBe(-1);

    // And the still-optimistic estimate must not climb straight back into it.
    session.tick(20_000_000);
    session.tick(20_000_000);
    expect(drivenLevel(session.hls)).toBe(started - 1);
    session.dateNow.mockRestore();
  });

  it("does not charge the link for the stall a seek causes", () => {
    // A seek empties the buffer by definition. Charging the stall that follows
    // cost a rung and the climb every time a party caught up, which held a
    // session at the bottom of the ladder for as long as the party lasted.
    const session = playingInAuto(20_000_000);
    const started = drivenLevel(session.hls);
    expect(started).toBeGreaterThan(0);

    session.seek();
    session.starveBuffer();
    session.stall();
    expect(drivenLevel(session.hls)).toBe(started);

    // Once the seek is well behind it, a starved stall is the link's again.
    for (let index = 0; index < 3; index += 1) session.tick(20_000_000);
    session.stall();
    expect(drivenLevel(session.hls)).toBe(started - 1);
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

    let sn = 0;
    const tick = (estimate: number) => {
      clock += 2000;
      hls.bandwidthEstimate = estimate;
      sn += 1;
      hls.trigger("hlsFragBuffered", {
        frag: {
          type: "main",
          sn,
          level: drivenLevel(hls),
          start: sn * 2,
          duration: 2,
        },
      });
    };

    // Locked to the bottom rung while the link falls away underneath it.
    attachment.adaptiveController?.setQualityHeight(144, 144);
    expect(hls.loadLevel).toBe(0);
    for (const estimate of [8_000_000, 3_000_000, 1_000_000, 400_000]) {
      tick(estimate);
    }

    attachment.adaptiveController?.setQualityHeight(null, null, "auto");
    expect(drivenLevel(hls)).toBe(0);

    // Auto is back and the buffer is deep, but the link is visibly on its way
    // down, so the probe stays where it is.
    for (let index = 0; index < 3; index += 1) tick(400_000);
    expect(drivenLevel(hls)).toBe(0);

    // Once the collapse has aged out and the reading has held steady, the
    // ordinary anti-trap climb is available again.
    let highest = 0;
    for (let index = 0; index < 10; index += 1) {
      tick(400_000);
      highest = Math.max(highest, drivenLevel(hls));
    }
    expect(highest).toBeGreaterThan(0);
    dateNow.mockRestore();
  });

  it("leaves a rung the probe climbed to and lost alone for a while", () => {
    // Production at 4 Mbps: probe up, drain, fall, probe up again, every
    // fourteen seconds. A rung that has just failed the probe is not retried
    // at once.
    const session = playingInAuto(900_000);
    for (const estimate of [880_000, 920_000, 900_000]) session.tick(estimate);
    expect(drivenLevel(session.hls)).toBe(2);

    session.starveBuffer();
    session.tick(900_000);
    expect(drivenLevel(session.hls)).toBe(1);

    session.refillBuffer();
    for (let index = 0; index < 6; index += 1) session.tick(900_000);
    expect(drivenLevel(session.hls)).toBe(1);

    // Thirty seconds on, the rung may be tried again.
    session.advance(30_000);
    let highest = 1;
    for (let index = 0; index < 4; index += 1) {
      session.tick(900_000);
      highest = Math.max(highest, drivenLevel(session.hls));
    }
    expect(highest).toBe(2);
    session.dateNow.mockRestore();
  });

  it("applies a mode the viewer picks even while a probe's grace is running", () => {
    // The grace protects the probe's guess, not a choice the viewer made.
    // Production: Data Saver picked during a probe's grace took over with the
    // probe's 1440p on a 12 Mbps link, which the engine abandoned to 144p.
    const session = playingInAuto(900_000);
    for (const estimate of [880_000, 920_000, 900_000]) session.tick(estimate);
    expect(drivenLevel(session.hls)).toBe(2);

    // 900 kbps: Auto's budget buys 240p, so Data Saver is the rung below it.
    session.attachment.adaptiveController?.setQualityHeight(
      null,
      null,
      "low-data",
      { immediate: true },
    );
    expect(drivenLevel(session.hls)).toBe(0);
    session.dateNow.mockRestore();
  });

  it("keeps a running probe when the player merely re-applies the mode", () => {
    // Resizes and the player's periodic review re-apply the same mode; that
    // is not the viewer asking for anything, and must not undo the probe.
    const session = playingInAuto(900_000);
    for (const estimate of [880_000, 920_000, 900_000]) session.tick(estimate);
    expect(drivenLevel(session.hls)).toBe(2);
    session.attachment.adaptiveController?.setQualityHeight(null, null, "auto");
    session.tick(900_000);
    expect(drivenLevel(session.hls)).toBe(2);
    session.dateNow.mockRestore();
  });

  it("resumes climbing once a collapsed link has steadied again", () => {
    const session = playingInAuto(900_000);
    for (const estimate of [800_000, 600_000, 450_000, 400_000]) {
      session.tick(estimate);
    }
    expect(drivenLevel(session.hls)).toBe(0);

    // Steady again at the same low reading: the direction is what changed.
    // 400 kbps carries 240p's 350 kbps but not inside Auto's margin, which is
    // the probe's case; what matters is that it is attempted at all, which is
    // what a falling reading forbids.
    let highest = 0;
    for (let index = 0; index < 8; index += 1) {
      session.tick(400_000 + (index % 2) * 10_000);
      highest = Math.max(highest, drivenLevel(session.hls));
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

describe("seamless rung switching", () => {
  beforeEach(() => {
    hlsMock.instances.length = 0;
    hlsMock.isSupported.mockReturnValue(true);
  });

  const LADDER = [
    { width: 640, height: 360, bitrate: 700_000 },
    { width: 1280, height: 720, bitrate: 3_000_000 },
    { width: 1920, height: 1080, bitrate: 6_000_000 },
  ];

  /**
   * A session with real-looking buffer state: two-second fragments from
   * `bufferStart` to `bufferEnd`, the play head at `currentTime`, alternate
   * audio, and every flush the player asks hls.js for recorded.
   */
  function session(options: {
    estimateBps: number;
    currentTime?: number;
    bufferEnd?: number;
    fragmentLevel?: number;
  }) {
    setUserAgent("Mozilla/5.0 Chrome/149.0.0.0 Safari/537.36");
    const video = createVideo("");
    vi.spyOn(video, "getBoundingClientRect").mockReturnValue({
      height: 1080,
    } as DOMRect);
    let currentTime = options.currentTime ?? 0;
    let bufferEnd = options.bufferEnd ?? 0;
    let paused = true;
    Object.defineProperty(video, "currentTime", {
      configurable: true,
      get: () => currentTime,
    });
    Object.defineProperty(video, "paused", {
      configurable: true,
      get: () => paused,
    });
    Object.defineProperty(video, "buffered", {
      configurable: true,
      get: () =>
        ({
          length: bufferEnd > 0 ? 1 : 0,
          start: () => 0,
          end: () => bufferEnd,
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
    hls.audioTracks = [{ name: "track-1", url: "audio/audio.m3u8" }];
    hls.bandwidthEstimate = options.estimateBps;
    const flushes: Array<{
      startOffset: number;
      endOffset: number;
      type: string | null;
    }> = [];
    const listen = hls.on as unknown as (
      event: string,
      handler: (event: string, data: unknown) => void,
    ) => void;
    listen("hlsBufferFlushing", (_event, data) => {
      flushes.push(data as (typeof flushes)[number]);
    });
    hls.trigger("manifestParsed", {});

    let sn = 0;
    const buffer = (level: number, from: number, to: number) => {
      for (let start = from; start < to; start += 2) {
        sn += 1;
        hls.trigger("hlsFragBuffered", {
          frag: { type: "main", sn, level, start, duration: 2 },
        });
      }
    };
    if (bufferEnd > 0) buffer(options.fragmentLevel ?? 0, 0, bufferEnd);

    return {
      hls,
      attachment,
      flushes,
      buffer,
      nextSn: () => (sn += 1),
      setTime(seconds: number) {
        currentTime = seconds;
      },
      /** The viewer moves the play head. */
      seek(seconds: number) {
        currentTime = seconds;
        video.dispatchEvent(new Event("seeking"));
      },
      setPlaying(playing: boolean) {
        paused = !playing;
      },
      setBufferEnd(seconds: number) {
        bufferEnd = seconds;
      },
      advance(ms: number) {
        clock += ms;
      },
      restore() {
        dateNow.mockRestore();
      },
    };
  }

  it("keeps the engine in automatic mode and never flushes on an automatic switch", () => {
    const s = session({ estimateBps: 20_000_000, bufferEnd: 30 });
    expect(s.hls.loadLevel).toBe(-1);
    const top = drivenLevel(s.hls);
    expect(top).toBe(2);

    // The link collapses: the policy steps down for what is fetched next…
    s.hls.bandwidthEstimate = 900_000;
    s.advance(2000);
    s.buffer(top, 30, 32);
    expect(drivenLevel(s.hls)).toBeLessThan(top);
    // …and the thirty seconds already buffered are kept and played.
    expect(s.flushes).toEqual([]);
    expect(s.hls.nextLevel).toBe(-1);
    expect(s.hls.currentLevel).toBe(-1);
    expect(s.hls.loadLevel).toBe(-1);
    s.restore();
  });

  it("does not climb again until the rung it chose has actually been fetched", () => {
    const s = session({ estimateBps: 900_000, bufferEnd: 12 });
    const start = drivenLevel(s.hls);
    expect(start).toBe(0);

    // A link that justifies 720p: one rung up after the hold.
    s.hls.bandwidthEstimate = 6_000_000;
    for (let index = 0; index < 3; index += 1) {
      s.advance(1000);
      s.buffer(0, 12 + index * 2, 14 + index * 2);
    }
    const climbed = drivenLevel(s.hls);
    expect(climbed).toBe(1);

    // The reading improves, but only fragments of the *old* rung keep landing
    // (they were already in flight, or loading is paused with a full buffer).
    // Nothing has measured 720p yet, so it has not earned 1080p.
    s.hls.bandwidthEstimate = 20_000_000;
    for (let index = 0; index < 4; index += 1) {
      s.advance(1000);
      s.buffer(0, 20 + index * 2, 22 + index * 2);
    }
    expect(drivenLevel(s.hls)).toBe(climbed);

    // A fragment of the new rung lands; the climb can continue.
    s.advance(1000);
    s.buffer(1, 28, 30);
    for (let index = 0; index < 3; index += 1) {
      s.advance(1000);
      s.buffer(1, 30 + index * 2, 32 + index * 2);
    }
    expect(drivenLevel(s.hls)).toBe(2);
    s.restore();
  });

  it("follows an engine emergency for one fragment, then decides again", () => {
    const s = session({ estimateBps: 20_000_000, bufferEnd: 12 });
    expect(drivenLevel(s.hls)).toBe(2);
    // Past the opening seconds, whose rescues are not counted (see the
    // region test below).
    s.advance(6000);

    // hls.js's abandonment rules give up a fragment that will not arrive in
    // time and pick a cheaper rung, writing it through the controller. That
    // fragment is fetched at the engine's rung. One abandonment writes it
    // twice — the rung it first chose, then the cheapest that can make it —
    // and that is one rescue, not two.
    s.hls.nextAutoLevel = 1;
    s.hls.nextAutoLevel = 0;
    expect(drivenLevel(s.hls)).toBe(0);

    // Once it has landed the policy decides again from the link. Production
    // adopted the engine's 144p as the rung after one slow first read of a
    // region, and took over a minute to climb back on a 40 Mbps link.
    s.advance(1000);
    s.buffer(0, 12, 14);
    expect(drivenLevel(s.hls)).toBe(2);
    expect(s.flushes).toEqual([]);

    // A second emergency inside the window is not a one-off: the policy comes
    // back one rung lower than the rung that needed rescuing.
    s.advance(1000);
    s.hls.nextAutoLevel = 0;
    expect(drivenLevel(s.hls)).toBe(0);
    s.advance(1000);
    s.buffer(0, 14, 16);
    expect(drivenLevel(s.hls)).toBe(1);

    // A third is a link that really cannot carry it: the engine's rung is
    // adopted, and the climb waits like it does after a stall.
    s.advance(1000);
    s.hls.nextAutoLevel = 0;
    for (let index = 0; index < 3; index += 1) {
      s.advance(1000);
      s.buffer(0, 16 + index * 2, 18 + index * 2);
    }
    expect(drivenLevel(s.hls)).toBe(0);
    s.restore();
  });

  it("does not let an emergency abandonment reset the estimate to the rung it fled to", () => {
    const s = session({ estimateBps: 20_000_000, bufferEnd: 12 });
    expect(drivenLevel(s.hls)).toBe(2);
    const abr = (
      s.hls as unknown as {
        abr: {
          resets: Array<number | undefined>;
          resetEstimator(value?: number): void;
        };
      }
    ).abr;

    // The abandonment's reset carries the price of the rung it switched to.
    // Production logged exactly that (561937 bps, the bottom rung) as the
    // estimate on a 40 Mbps link; every decision after it started from 144p.
    abr.resetEstimator(561_937);
    expect(abr.resets).toEqual([]);
    expect(
      (
        window as unknown as {
          __seyirlikAbr: () => { log: Array<{ event: string }> };
        }
      )
        .__seyirlikAbr()
        .log.some((entry) => entry.event === "estimate-reset-refused"),
    ).toBe(true);

    // A reset without a value is the engine starting over, and is kept.
    abr.resetEstimator();
    expect(abr.resets).toEqual([undefined]);
    s.restore();
  });

  it("puts a manual pick on screen within three seconds, on a fragment boundary, video only", () => {
    const s = session({
      estimateBps: 20_000_000,
      currentTime: 5,
      bufferEnd: 30,
      fragmentLevel: 0,
    });
    s.hls.bufferingEnabled = false;
    s.attachment.adaptiveController?.setQualityHeight(1080, 1080);

    expect(s.hls.loadLevel).toBe(2);
    expect(s.flushes).toHaveLength(1);
    const [flush] = s.flushes;
    // 1080p at 6 Mbps peak over a 20 Mbps link: ~1.8 s to fetch (three
    // first-byte waits, then the fragment), x1.5 + 0.5 = 3.2 s for a fully
    // seamless switch — whose first boundary (10 s) is five seconds away.
    // The three-second deadline wins: the last boundary inside it is 8 s,
    // cut 0.4 s into that fragment.
    expect(flush?.type).toBe("video");
    expect(flush?.startOffset).toBe(8.4);
    expect(flush?.endOffset).toBe(Number.POSITIVE_INFINITY);
    // Loading that ManagedMediaSource had paused is resumed for the refill.
    expect(s.hls.resumeBuffering).toHaveBeenCalled();
    // A repeated application of the same lock (a resize) does not cut again.
    s.attachment.adaptiveController?.setQualityHeight(1080, 1080);
    expect(s.flushes).toHaveLength(1);
    s.restore();
  });

  it("drops an old-rung fragment in flight for a pick instead of waiting for it", () => {
    const s = session({
      estimateBps: 20_000_000,
      currentTime: 5,
      bufferEnd: 30,
    });
    const inFlight = {
      type: "main",
      sn: s.nextSn(),
      level: 0,
      start: 30,
      duration: 2,
    };
    s.hls.trigger("hlsFragLoading", { frag: inFlight });

    s.attachment.adaptiveController?.setQualityHeight(720, 720);
    // Waiting for it could cost the pick its deadline on a slow link, and it
    // would land inside the new rung: loading restarts from the play head,
    // without a seek, and the cut is made at once.
    expect(s.hls.stopLoad).toHaveBeenCalledTimes(1);
    expect(s.hls.startLoad).toHaveBeenCalledWith(5, true);
    expect(s.flushes).toHaveLength(1);
    expect(s.flushes[0]?.type).toBe("video");
    s.restore();
  });

  it("lets an automatic upgrade wait for an old-rung fragment in flight", () => {
    const s = session({ estimateBps: 900_000, currentTime: 4, bufferEnd: 40 });
    s.hls.bandwidthEstimate = 6_000_000;
    for (let index = 0; index < 2; index += 1) {
      s.advance(1000);
      s.buffer(0, 40 + index * 2, 42 + index * 2);
    }
    const inFlight = {
      type: "main",
      sn: s.nextSn(),
      level: 0,
      start: 44,
      duration: 2,
    };
    s.hls.trigger("hlsFragLoading", { frag: inFlight });
    s.advance(1000);
    s.hls.trigger("hlsFragBuffered", {
      frag: { type: "main", sn: s.nextSn(), level: 0, start: 44, duration: 2 },
    });
    // The climb was decided while the old fragment was still in flight.
    expect(drivenLevel(s.hls)).toBe(1);
    expect(s.hls.stopLoad).not.toHaveBeenCalled();
    expect(s.flushes).toEqual([]);
    s.setBufferEnd(46);
    s.hls.trigger("hlsFragBuffered", { frag: inFlight });
    expect(s.flushes).toHaveLength(1);
    s.restore();
  });

  it("never makes a pick wait more than three seconds for its estimate", () => {
    // 1080p over what hls.js reads as 1 Mbps would need ~12 s per fragment.
    // That reading is what a 144p session reports for any link, and trusting
    // it kept every pick waiting for the whole buffer to play out. The pick
    // takes over at the last boundary within three seconds (8 s), pausing
    // there if the fragment is late.
    const s = session({
      estimateBps: 1_000_000,
      currentTime: 5,
      bufferEnd: 30,
    });
    s.attachment.adaptiveController?.setQualityHeight(1080, 1080);
    expect(s.hls.loadLevel).toBe(2);
    expect(s.flushes).toEqual([
      { type: "video", startOffset: 8.4, endOffset: Number.POSITIVE_INFINITY },
    ]);
    s.restore();
  });

  it("pauses sound with picture when a deadline takeover is late, instead of playing audio over a frozen frame", () => {
    const s = session({
      estimateBps: 1_000_000,
      currentTime: 5,
      bufferEnd: 30,
    });
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      s.attachment.adaptiveController?.setQualityHeight(1080, 1080);
      expect(s.flushes).toHaveLength(1); // video only, takeover at 8 s
      // The video ran out at the cut; Chromium keeps playing the audio.
      s.setPlaying(true);
      s.setBufferEnd(9);
      s.setTime(8.5);
      vi.advanceTimersByTime(100);
      expect(s.flushes).toHaveLength(1); // still inside the video: nothing
      s.setTime(9.2);
      vi.advanceTimersByTime(100);
      // Past the end of the video: the audio ahead goes too, so both stop.
      expect(s.flushes[1]).toEqual({
        type: "audio",
        startOffset: 9.2,
        endOffset: Number.POSITIVE_INFINITY,
      });
      vi.advanceTimersByTime(500);
      expect(s.flushes).toHaveLength(2); // once
    } finally {
      vi.useRealTimers();
      s.restore();
    }
  });

  it("never holds once the takeover fragment has landed", () => {
    const s = session({
      estimateBps: 1_000_000,
      currentTime: 5,
      bufferEnd: 30,
    });
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      s.attachment.adaptiveController?.setQualityHeight(1080, 1080);
      s.hls.trigger("hlsFragBuffered", {
        frag: { type: "main", sn: s.nextSn(), level: 2, start: 8, duration: 2 },
      });
      s.setPlaying(true);
      s.setBufferEnd(9);
      s.setTime(9.2);
      vi.advanceTimersByTime(200);
      expect(s.flushes).toHaveLength(1);
    } finally {
      vi.useRealTimers();
      s.restore();
    }
  });

  it("switches seamlessly, video only, when the link can fetch the pick inside the deadline", () => {
    const s = session({
      estimateBps: 40_000_000,
      currentTime: 5,
      bufferEnd: 30,
    });
    s.attachment.adaptiveController?.setQualityHeight(1080, 1080);
    // 3 x 0.4 s of latency + 12 Mb at 40 Mbps = 1.5 s; x1.5 + 0.5 = 2.75 s:
    // the first boundary past 7.75 s is 8, inside the deadline. Nothing can
    // run dry, so the audio is left alone.
    expect(s.flushes).toEqual([
      { startOffset: 8.4, endOffset: Number.POSITIVE_INFINITY, type: "video" },
    ]);
    s.restore();
  });

  it("replaces for a mode the viewer picks, in either direction, but not for the player's own re-application", () => {
    const s = session({
      estimateBps: 20_000_000,
      currentTime: 5,
      bufferEnd: 30,
      fragmentLevel: 2,
    });
    expect(drivenLevel(s.hls)).toBe(2);
    // The periodic bias review re-applies a ceiling by itself: nothing goes.
    s.attachment.adaptiveController?.setQualityHeight(null, 360, "low-data");
    expect(drivenLevel(s.hls)).toBe(0);
    expect(s.flushes).toEqual([]);
    // The viewer picks Data Saver: the 1080p ahead is replaced at once.
    s.attachment.adaptiveController?.setQualityHeight(null, 360, "low-data", {
      immediate: true,
    });
    expect(s.flushes).toHaveLength(1);
    expect(s.flushes[0]?.type).toBe("video");
    expect(s.flushes[0]?.startOffset).toBeLessThanOrEqual(11);
    s.restore();
  });

  it("never cuts a package whose audio is muxed into the video", () => {
    const s = session({
      estimateBps: 20_000_000,
      currentTime: 5,
      bufferEnd: 30,
    });
    s.hls.audioTracks = [];
    s.attachment.adaptiveController?.setQualityHeight(720, 720);
    expect(s.hls.loadLevel).toBe(1);
    expect(s.flushes).toEqual([]);
    s.restore();
  });

  it("lets an automatic climb with ample headroom replace lower-rung media beyond four seconds", () => {
    const s = session({ estimateBps: 900_000, currentTime: 4, bufferEnd: 40 });
    expect(drivenLevel(s.hls)).toBe(0);
    s.hls.bandwidthEstimate = 6_000_000; // 2x the 720p peak
    for (let index = 0; index < 3; index += 1) {
      s.advance(1000);
      s.buffer(0, 40 + index * 2, 42 + index * 2);
    }
    expect(drivenLevel(s.hls)).toBe(1);
    expect(s.flushes).toHaveLength(1);
    // Four seconds are retained, which the fetch margin (latency plus the
    // new rung's first fragment, doubled) already exceeds here: the new rung
    // takes over at the first boundary past that margin, cut 0.4 s in;
    // nothing nearer than that is touched, audio never.
    expect(s.flushes[0]?.type).toBe("video");
    expect(s.flushes[0]?.startOffset).toBe(10.4);
    s.restore();
  });

  it("keeps sixteen seconds on a climb the link has little room for", () => {
    const s = session({ estimateBps: 900_000, currentTime: 4, bufferEnd: 40 });
    s.hls.levels = [
      { width: 640, height: 360, bitrate: 700_000 },
      {
        width: 1280,
        height: 720,
        bitrate: 5_000_000,
        averageBitrate: 2_500_000,
      },
    ] as typeof s.hls.levels;
    s.hls.bandwidthEstimate = 5_000_000; // affordable on average, not 1.5x peak
    for (let index = 0; index < 3; index += 1) {
      s.advance(1000);
      s.buffer(0, 40 + index * 2, 42 + index * 2);
    }
    expect(drivenLevel(s.hls)).toBe(1);
    // Affordable on average but not with room on its peak: the climb is
    // partly a guess, so sixteen seconds of the old buffer stay.
    expect(s.flushes).toHaveLength(1);
    expect(s.flushes[0]?.startOffset).toBe(20.4);
    s.restore();
  });

  it("never replaces on a climb while the link is falling", () => {
    // Seconds ago the link carried 20 Mbps; it dipped, and now reads 6 Mbps:
    // enough for 720p, but a third of the link has just disappeared.
    const s = session({
      estimateBps: 20_000_000,
      currentTime: 4,
      bufferEnd: 40,
    });
    for (let index = 0; index < 2; index += 1) {
      s.advance(1000);
      s.buffer(2, 40 + index * 2, 42 + index * 2);
    }
    s.hls.bandwidthEstimate = 900_000;
    s.advance(1000);
    s.buffer(2, 44, 46);
    expect(drivenLevel(s.hls)).toBe(0);
    s.advance(1000);
    s.buffer(0, 46, 48);
    s.hls.bandwidthEstimate = 6_000_000;
    for (let index = 0; index < 3; index += 1) {
      s.advance(1000);
      s.buffer(0, 48 + index * 2, 50 + index * 2);
    }
    expect(drivenLevel(s.hls)).toBe(1);
    expect(s.flushes).toEqual([]);
    s.restore();
  });

  it("returns from a lock to automatic mode without flushing", () => {
    const s = session({
      estimateBps: 20_000_000,
      currentTime: 5,
      bufferEnd: 30,
    });
    s.attachment.adaptiveController?.setQualityHeight(360, 360);
    const flushesAfterLock = s.flushes.length;
    s.attachment.adaptiveController?.setQualityHeight(null, null, "auto");
    expect(s.hls.loadLevel).toBe(-1);
    expect(drivenLevel(s.hls)).toBe(2);
    expect(s.flushes).toHaveLength(flushesAfterLock);
    s.restore();
  });

  it("refetches a seek target buffered at a lower rung than the one now wanted", () => {
    // Production: 360p locked for half a minute, then Auto at 2160p, then a
    // seek back into that half minute played 360p for thirty seconds.
    const s = session({
      estimateBps: 20_000_000,
      currentTime: 30,
      bufferEnd: 40,
      fragmentLevel: 0,
    });
    expect(drivenLevel(s.hls)).toBe(2);
    s.flushes.length = 0;

    s.seek(11);
    // The lower-rung stretch from the fragment under the target onwards.
    expect(s.flushes).toEqual([
      { startOffset: 10, endOffset: 40, type: "video" },
    ]);
    s.restore();
  });

  it("keeps a seek back instant over media already at the wanted rung", () => {
    const s = session({
      estimateBps: 20_000_000,
      currentTime: 30,
      bufferEnd: 40,
      fragmentLevel: 2,
    });
    expect(drivenLevel(s.hls)).toBe(2);
    s.flushes.length = 0;
    s.seek(11);
    expect(s.flushes).toEqual([]);
    s.restore();
  });

  it("restores a forward-buffer cap the engine lowered and never raised again", () => {
    const s = session({ estimateBps: 20_000_000, bufferEnd: 12 });
    const config = s.hls.config as { maxMaxBufferLength: number };
    expect(config.maxMaxBufferLength).toBe(60);

    // hls.js halves it on a fragment still tracked as appending, which a
    // replacement cutting the buffer mid-flight produces.
    config.maxMaxBufferLength = 7.5;
    s.buffer(2, 12, 14);
    expect(config.maxMaxBufferLength).toBe(7.5);

    // A real quota problem lowers it again within a fragment; a spurious one
    // is not left to starve the session.
    s.advance(16_000);
    s.buffer(2, 14, 16);
    expect(config.maxMaxBufferLength).toBe(60);
    s.restore();
  });

  it("keeps at most thirty seconds behind the play head", () => {
    session({ estimateBps: 20_000_000 }).restore();
    expect(
      (hlsMock.instances[0]!.config as { backBufferLength?: number })
        .backBufferLength,
    ).toBe(30);
  });

  it("reports what Auto would choose, not what a mode or the screen shows", () => {
    const s = session({ estimateBps: 20_000_000, bufferEnd: 12 });
    s.attachment.adaptiveController?.setQualityHeight(null, 720, "low-data", {
      immediate: true,
    });
    expect(drivenLevel(s.hls)).toBeLessThan(2);
    expect(s.attachment.adaptiveController?.getAutoTargetHeight?.()).toBe(1080);
    s.restore();
  });

  it("lets the engine abandon a fragment only when the buffer is actually short", () => {
    // Harness, cold first reads: a 1080p fragment abandoned for 144p with
    // fifteen seconds buffered, two seconds of the bottom rung mid-playback.
    const s = session({
      estimateBps: 20_000_000,
      currentTime: 0,
      bufferEnd: 15,
    });
    const abr = (
      s.hls as unknown as {
        abr: { abandonChecks: number; _abandonRulesCheck: () => void };
      }
    ).abr;
    abr._abandonRulesCheck();
    expect(abr.abandonChecks).toBe(0);

    // Four seconds left: the engine's own rule decides.
    s.setTime(11);
    abr._abandonRulesCheck();
    expect(abr.abandonChecks).toBe(1);
    s.restore();
  });

  it("does not count rescues from before a seek against the region after it", () => {
    const s = session({
      estimateBps: 20_000_000,
      currentTime: 0,
      bufferEnd: 4,
    });
    expect(drivenLevel(s.hls)).toBe(2);
    s.advance(6000);
    // Two rescues while playing.
    for (const start of [4, 6]) {
      s.advance(1000);
      s.hls.nextAutoLevel = 0;
      s.buffer(0, start, start + 2);
    }
    expect(drivenLevel(s.hls)).toBe(1);
    // A seek to a cold region: its first rescue is a rescue, not an adoption.
    s.seek(200);
    s.advance(1000);
    s.hls.nextAutoLevel = 0;
    s.buffer(0, 200, 202);
    expect(drivenLevel(s.hls)).toBeGreaterThan(0);
    s.restore();
  });

  it("does not count the rescues of a region's first seconds", () => {
    // Harness, cold first reads: three rescues straight after a seek reached
    // the limit, and the engine filled a minute of 144p.
    const s = session({
      estimateBps: 20_000_000,
      currentTime: 0,
      bufferEnd: 4,
    });
    s.advance(6000);
    s.seek(200);
    for (const start of [200, 202, 204]) {
      s.advance(500);
      s.hls.nextAutoLevel = 0;
      s.buffer(0, start, start + 2);
    }
    expect(drivenLevel(s.hls)).toBeGreaterThan(0);
    s.restore();
  });

  it("treats a Data Saver ceiling as Data Saver's rung, not a place to step down from", () => {
    // Production: the menu passed 480p (one class under Auto's 720p) and the
    // policy stepped down again inside it, to 360p.
    const s = session({ estimateBps: 20_000_000, bufferEnd: 12 });
    expect(drivenLevel(s.hls)).toBe(2);
    s.attachment.adaptiveController?.setQualityHeight(null, 720, "low-data", {
      immediate: true,
    });
    expect(drivenLevel(s.hls)).toBe(1);
    s.restore();
  });
});

describe("the replacement cut", () => {
  beforeEach(() => {
    hlsMock.instances.length = 0;
    hlsMock.isSupported.mockReturnValue(true);
  });

  it("cuts into the takeover fragment, never on the playlist grid", () => {
    // B-frames delay every presentation timestamp by the reorder depth: the
    // fragment whose playlist slot starts at 10.010 shows its IDR at 10.093.
    // Cutting at 10.010 deleted the end of the previous GOP and every B-frame
    // depending on it, leaving a hole to be jumped (measured in Chromium and
    // WebKit). Cut inside the fragment, the new rung's IDR overwrites the
    // rest of it on append and the previous GOP is untouched.
    setUserAgent("Mozilla/5.0 Chrome/149.0.0.0 Safari/537.36");
    const video = createVideo("");
    Object.defineProperty(video, "currentTime", {
      configurable: true,
      get: () => 5,
    });
    Object.defineProperty(video, "buffered", {
      configurable: true,
      get: () =>
        ({ length: 1, start: () => 0, end: () => 30 }) as unknown as TimeRanges,
    });
    const attachment = attachSourceToVideo(
      video,
      "http://example.test/play/master.m3u8",
      "application/vnd.apple.mpegurl",
    );
    const hls = hlsMock.instances[0];
    if (!hls) throw new Error("hls.js was not attached");
    hls.levels = [
      { width: 640, height: 360, bitrate: 700_000 },
      { width: 1920, height: 1080, bitrate: 6_000_000 },
    ];
    hls.audioTracks = [{ name: "track-1", url: "audio/audio.m3u8" }];
    hls.bandwidthEstimate = 20_000_000;
    const flushes: Array<{ startOffset: number }> = [];
    (
      hls.on as unknown as (
        e: string,
        h: (e: string, d: unknown) => void,
      ) => void
    )("hlsBufferFlushing", (_event, data) =>
      flushes.push(data as { startOffset: number }),
    );
    hls.trigger("manifestParsed", {});
    for (let index = 0; index < 15; index += 1) {
      const start = index * 2.002;
      hls.trigger("hlsFragBuffered", {
        frag: {
          type: "main",
          sn: index,
          level: 0,
          start,
          duration: 2.002,
        },
      });
    }
    attachment.adaptiveController?.setQualityHeight(1080, 1080);
    expect(flushes.length).toBeGreaterThanOrEqual(1);
    // The deadline puts the takeover at the 6.006 boundary (8.008 is past
    // 5 + 3 s); the cut is 0.4 s into it, past any B-frame delay, off the grid.
    expect(flushes[0]?.startOffset).toBeCloseTo(3 * 2.002 + 0.4, 6);
  });
});

describe("the opening rung", () => {
  const LADDER = [
    { width: 256, height: 144, bitrate: 180_000 },
    { width: 426, height: 240, bitrate: 350_000 },
    { width: 640, height: 360, bitrate: 700_000 },
    { width: 854, height: 480, bitrate: 1_400_000 },
    { width: 1280, height: 720, bitrate: 3_000_000 },
    { width: 1920, height: 1080, bitrate: 5_500_000 },
    { width: 3840, height: 2160, bitrate: 20_000_000 },
  ];
  const URL_ = "http://example.test/play/master.m3u8";
  const STORE = "seyirlik:delivery-throughput:v1";

  let clock = 0;
  beforeEach(() => {
    hlsMock.instances.length = 0;
    hlsMock.isSupported.mockReturnValue(true);
    window.localStorage.clear();
    clock = 1_800_000_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    setUserAgent("Mozilla/5.0 Chrome/149.0.0.0 Safari/537.36");
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function remember(bps: number, ageMs = 0) {
    window.localStorage.setItem(
      STORE,
      JSON.stringify({ "http://example.test": { bps, at: clock - ageMs } }),
    );
  }

  /** A full-screen 1080p player, attached the way the player attaches. */
  function open(options: Parameters<typeof attachSourceToVideo>[3] = {}) {
    const video = createVideo("");
    vi.spyOn(video, "getBoundingClientRect").mockReturnValue({
      height: 1080,
    } as DOMRect);
    const attachment = attachSourceToVideo(
      video,
      URL_,
      "application/vnd.apple.mpegurl",
      { adaptiveRendition: true, ...options },
    );
    const hls = hlsMock.instances.at(-1);
    if (!hls) throw new Error("hls.js was not attached");
    hls.levels = [...LADDER];
    // What hls.js reports before its first sample: the configured default.
    hls.bandwidthEstimate = (
      hls.config as { abrEwmaDefaultEstimate: number }
    ).abrEwmaDefaultEstimate;
    hls.trigger("manifestParsed", {});
    let sn = 0;
    return {
      hls,
      attachment,
      /** A main fragment lands, measured by hls.js at `estimate`. */
      fragment(estimate: number, bytes = 1_500_000, totalMs = 400) {
        clock += 300;
        hls.bandwidthEstimate = estimate;
        sn += 1;
        hls.trigger("hlsFragBuffered", {
          frag: {
            type: "main",
            sn,
            level: drivenLevel(hls),
            start: sn * 2,
            duration: 2,
            stats: {
              loaded: bytes,
              loading: { start: 1000, first: 1100, end: 1000 + totalMs },
            },
          },
        });
      },
    };
  }

  it("opens a first-time viewer where it always did", () => {
    const { hls } = open();
    expect(hls.config).toMatchObject({ abrEwmaDefaultEstimate: 5_000_000 });
    expect(hls.levels[drivenLevel(hls)]?.height).toBe(720);
  });

  it("opens a returning viewer at the rung their link has been measured to carry", () => {
    remember(40_000_000, 5 * 60_000);
    const { hls } = open();
    expect(hls.config).toMatchObject({ abrEwmaDefaultEstimate: 40_000_000 });
    // 2160p averages 20 Mbps; two thirds of 40 affords it, and the
    // 1080-tall player at this pixel ratio covers 1080p only.
    expect(hls.levels[drivenLevel(hls)]?.height).toBe(1080);
    // And the very first fragment is fetched from it, not from a probe rung.
    expect(hls.startLevel).toBe(drivenLevel(hls));
  });

  it("opens a returning viewer on a slow link low, rather than at 720p", () => {
    remember(1_500_000);
    const { hls } = open();
    expect(hls.levels[drivenLevel(hls)]?.height).toBe(360);
  });

  it("lets the first two measured fragments correct a cautious opening at once", () => {
    const session = open();
    expect(session.hls.levels[drivenLevel(session.hls)]?.height).toBe(720);
    session.fragment(30_000_000);
    // One fragment is a sample, not evidence.
    expect(session.hls.levels[drivenLevel(session.hls)]?.height).toBe(720);
    session.fragment(30_000_000);
    // No two-second hold: the opening rung was a guess, this is a measurement.
    expect(session.hls.levels[drivenLevel(session.hls)]?.height).toBe(1080);
  });

  it("paces every later climb by the ordinary hold", () => {
    const session = open();
    session.fragment(6_000_000);
    session.fragment(6_000_000);
    // 720p is right for 6 Mbps: the one immediate correction is spent.
    expect(session.hls.levels[drivenLevel(session.hls)]?.height).toBe(720);
    clock += 1000;
    session.fragment(30_000_000);
    expect(session.hls.levels[drivenLevel(session.hls)]?.height).toBe(720);
  });

  it("drops an over-optimistic remembered rung on the first measurement", () => {
    remember(40_000_000);
    const session = open();
    expect(session.hls.levels[drivenLevel(session.hls)]?.height).toBe(1080);
    // Two thirds of 2 Mbps affords 360p; the fall is taken in one step.
    clock += 1000;
    session.fragment(2_000_000);
    expect(session.hls.levels[drivenLevel(session.hls)]?.height).toBe(360);
  });

  it("hands what one title measured to the next one", () => {
    const first = open();
    for (let index = 0; index < 4; index += 1) {
      // 1.5 MB in 400 ms: 30 Mbps delivered.
      first.fragment(30_000_000);
    }
    first.attachment.destroy();
    const stored = JSON.parse(window.localStorage.getItem(STORE)!);
    expect(stored["http://example.test"].bps).toBeCloseTo(30_000_000, -3);

    clock += 2 * 60_000;
    const next = open();
    expect(next.hls.config).toMatchObject({
      abrEwmaDefaultEstimate: stored["http://example.test"].bps,
    });
    expect(next.hls.levels[drivenLevel(next.hls)]?.height).toBe(1080);
  });

  it("never learns from, or is told about, a title played from a download", () => {
    remember(1_500_000);
    const offline = open({ forceMediaSource: true });
    expect(offline.hls.config).toMatchObject({
      abrEwmaDefaultEstimate: 5_000_000,
    });
    for (let index = 0; index < 6; index += 1) {
      offline.fragment(900_000_000, 1_500_000, 13);
    }
    offline.attachment.destroy();
    expect(
      JSON.parse(window.localStorage.getItem(STORE)!)["http://example.test"]
        .bps,
    ).toBe(1_500_000);
  });

  it("leaves a locked rung alone through the opening correction", () => {
    const session = open();
    session.attachment.adaptiveController?.setQualityHeight(480, 480);
    session.fragment(30_000_000);
    session.fragment(30_000_000);
    expect(session.hls.levels[drivenLevel(session.hls)]?.height).toBe(480);
  });
});
