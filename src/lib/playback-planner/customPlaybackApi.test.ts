import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientCapabilities, PlaybackPlan } from "./types";

const { buildClientCapabilitiesMock } = vi.hoisted(() => ({
  buildClientCapabilitiesMock: vi.fn(),
}));

vi.mock("./clientCapabilities", () => ({
  buildClientCapabilities: buildClientCapabilitiesMock,
}));

function clientCapabilities(): ClientCapabilities {
  return {
    supportsHlsNative: true,
    supportsMediaSource: true,
    directFileContainers: ["mp4"],
    mseContainers: ["mp4"],
    video: {
      h264: { supported: true },
    },
    audio: {
      aac: { supported: true, maxChannels: 2 },
    },
    subtitles: {
      srtExternal: false,
      webvttExternal: true,
      assExternal: false,
      imageBasedExternal: false,
    },
    testedAt: "2026-01-01T00:00:00.000Z",
  };
}

function playbackPlan(sessionId: string): PlaybackPlan {
  return {
    mode: "audio-transcode",
    requiresFfmpeg: true,
    preservesOriginalVideoQuality: true,
    expectedStartup: "fast",
    mediaId: "movie-1",
    selected: {
      videoStreamIndex: 0,
      audioStreamIndex: 1,
    },
    container: {
      input: "mp4",
      output: "hls-fmp4",
      action: "hls",
    },
    video: {
      inputCodec: "h264",
      action: "copy",
    },
    audio: {
      inputCodec: "aac",
      outputCodec: "aac",
      action: "transcode",
    },
    subtitles: {
      action: "none",
    },
    reasons: [],
    delivery: {
      type: "hls",
      sessionId,
      url: `/api/playback/sessions/${sessionId}/master.m3u8`,
    },
  };
}

function directMovPlaybackPlan(): PlaybackPlan {
  return {
    mode: "direct-play",
    requiresFfmpeg: false,
    preservesOriginalVideoQuality: true,
    expectedStartup: "instant",
    mediaId: "movie-1",
    selected: {
      videoStreamIndex: 0,
      audioStreamIndex: 1,
    },
    container: {
      input: "mov",
      output: "original",
      action: "direct",
    },
    video: {
      inputCodec: "h264",
      action: "copy",
    },
    audio: {
      inputCodec: "aac",
      action: "copy",
    },
    subtitles: {
      action: "none",
    },
    reasons: [
      {
        code: "direct_play_supported",
        severity: "info",
        message: "Container and codecs are direct-play compatible.",
      },
    ],
    delivery: {
      type: "file",
      url: "/api/playback/direct/token-1",
    },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function loadApi() {
  vi.resetModules();
  return import("./customPlaybackApi");
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.stubEnv("VITE_SEYIRLIK_PLAYBACK_BACKEND_URL", "http://backend.test");
  buildClientCapabilitiesMock.mockResolvedValue(clientCapabilities());
});

describe("custom playback API request deduplication", () => {
  it("shares one pending request for simultaneous callers of the same item", async () => {
    const api = await loadApi();
    let resolveFetch: ((response: Response) => void) | undefined;
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );

    vi.stubGlobal("fetch", fetchMock);

    const firstRequest = api.requestCustomPlaybackCandidate("movie-1");
    const secondRequest = api.requestCustomPlaybackCandidate("movie-1");

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    resolveFetch?.(jsonResponse(playbackPlan("session-1")));
    const [firstCandidate, secondCandidate] = await Promise.all([
      firstRequest,
      secondRequest,
    ]);

    expect(firstCandidate).toBe(secondCandidate);
    expect(firstCandidate?.playSessionId).toBe("session-1");
  });

  it("performs a new request after a pending request completes", async () => {
    const api = await loadApi();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(playbackPlan("session-1")))
      .mockResolvedValueOnce(jsonResponse(playbackPlan("session-2")));

    vi.stubGlobal("fetch", fetchMock);

    await expect(
      api.requestCustomPlaybackCandidate("movie-1"),
    ).resolves.toMatchObject({
      playSessionId: "session-1",
    });
    await expect(
      api.requestCustomPlaybackCandidate("movie-1"),
    ).resolves.toMatchObject({
      playSessionId: "session-2",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("maps direct MOV backend responses to a native DirectPlay source", async () => {
    const api = await loadApi();
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(directMovPlaybackPlan()));

    vi.stubGlobal("fetch", fetchMock);

    await expect(
      api.requestCustomPlaybackCandidate("movie-1"),
    ).resolves.toMatchObject({
      mode: "DirectPlay",
      mimeType: "video/quicktime",
      isHls: false,
      hlsKind: "direct",
      url: "http://backend.test/api/playback/direct/token-1",
      mediaSource: {
        Container: "mov",
        SupportsDirectPlay: true,
        TranscodingReasons: [],
      },
      transcodeReasons: [],
    });
  });

  it("makes every generated rendition URL absolute against the playback backend", async () => {
    const api = await loadApi();
    const plan = directMovPlaybackPlan();
    plan.qualityManifest = {
      mediaId: "movie-1",
      qualities: [
        {
          id: "original",
          label: "Original (1080p)",
          kind: "original",
          height: 1080,
          width: 1920,
          videoCodec: "hevc",
          playbackUrl: "/api/playback/direct/original",
        },
        {
          id: "generated-720",
          label: "720p",
          kind: "generated",
          height: 720,
          width: 1280,
          bitrate: 4_000_000,
          videoCodec: "h264",
          audioCodec: "aac",
          container: "mp4",
          playbackUrl: "/api/playback/renditions/token/generated-720.mp4",
        },
      ],
      limitations: {
        generatedAudio: "default-track-only",
        generatedSubtitles: "external-or-original-only",
        switching: "complete-file-rebuffer",
      },
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(plan)));

    await expect(
      api.requestCustomPlaybackCandidate("movie-1"),
    ).resolves.toMatchObject({
      qualityManifest: {
        qualities: [
          {
            playbackUrl: "http://backend.test/api/playback/direct/original",
          },
          {
            playbackUrl:
              "http://backend.test/api/playback/renditions/token/generated-720.mp4",
          },
        ],
      },
    });
  });

  it("exposes every source track so subtitles survive a rendition switch", async () => {
    const api = await loadApi();
    const plan = directMovPlaybackPlan();
    // A generated rendition carries one audio track and no embedded subtitles,
    // so the picker has to offer the source's tracks from the probe instead.
    plan.diagnostics = {
      media: {
        mediaId: "movie-1",
        fileName: "Film.mp4",
        container: {
          formatName: "mov,mp4",
          extension: "mp4",
          isBrowserDirectPlayableContainer: true,
        },
        durationSeconds: 120,
        videoStreams: [
          { index: 0, codecName: "h264", width: 1920, height: 1080 },
        ],
        audioStreams: [
          {
            index: 1,
            codecName: "aac",
            channels: 6,
            language: "eng",
            isDefault: true,
          },
          { index: 2, codecName: "aac", channels: 2, language: "tur" },
        ],
        subtitleStreams: [
          {
            index: 3,
            codecName: "mov_text",
            language: "eng",
            isImageBased: false,
          },
          {
            index: 4,
            codecName: "mov_text",
            language: "tur",
            isExternal: true,
            isImageBased: false,
          },
          {
            index: 5,
            codecName: "hdmv_pgs_subtitle",
            language: "eng",
            isImageBased: true,
          },
        ],
        analysedAt: "2026-08-09T00:00:00.000Z",
      },
    } as unknown as PlaybackPlan["diagnostics"];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(plan)));

    const candidate = await api.requestCustomPlaybackCandidate("movie-1");
    const streams = candidate?.mediaSource.MediaStreams ?? [];

    expect(
      streams
        .filter((stream) => stream.Type === "Audio")
        .map((s) => s.Language),
    ).toEqual(["eng", "tur"]);
    // Both text subtitle tracks are offered; the image-based one is not, because
    // it cannot be delivered as WebVTT and would never load.
    expect(
      streams
        .filter((stream) => stream.Type === "Subtitle")
        .map((stream) => [stream.Index, stream.Language]),
    ).toEqual([
      [3, "eng"],
      [4, "tur"],
    ]);
    expect(streams.find((stream) => stream.Index === 4)?.IsExternal).toBe(true);
    expect(candidate?.mediaSource.DefaultAudioStreamIndex).toBe(1);
  });

  it("allows retry after a failed custom playback request", async () => {
    const api = await loadApi();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("failed", { status: 502 }))
      .mockResolvedValueOnce(jsonResponse(playbackPlan("session-2")));

    vi.stubGlobal("fetch", fetchMock);

    await expect(api.requestCustomPlaybackCandidate("movie-1")).rejects.toThrow(
      "Custom playback request failed with 502",
    );
    await expect(
      api.requestCustomPlaybackCandidate("movie-1"),
    ).resolves.toMatchObject({
      playSessionId: "session-2",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not share requests for different item ids", async () => {
    const api = await loadApi();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(playbackPlan("session-1")))
      .mockResolvedValueOnce(jsonResponse(playbackPlan("session-2")));

    vi.stubGlobal("fetch", fetchMock);

    await Promise.all([
      api.requestCustomPlaybackCandidate("movie-1"),
      api.requestCustomPlaybackCandidate("movie-2"),
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(
      fetchMock.mock.calls.map((call) => JSON.parse(String(call[1]?.body))),
    ).toEqual([
      expect.objectContaining({ mediaId: "movie-1" }),
      expect.objectContaining({ mediaId: "movie-2" }),
    ]);
  });
});
