import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createCsrfToken } from "../auth/csrf";
import { createOwnApiRouter, type RouteContext } from "../api/router";
import { sendOwnApiJson, type OwnApiError } from "../ownApiHandler";
import {
  buildAdaptiveRenditionPlan,
  createPlaybackRoutes,
  toNativeMode,
  toReasonCodes,
} from "./playbackRoutes";
import type { PlaybackPlan } from "../../../lib/playback-planner/types";
import type { MediaQualityManifest } from "../../../renditions/contracts";
import { ADAPTIVE_PROFILE_VERSION } from "../../../renditions/adaptive/profile";

function plan(overrides: Partial<PlaybackPlan> = {}): PlaybackPlan {
  return {
    mode: "DirectPlay",
    requiresFfmpeg: false,
    preservesOriginalVideoQuality: true,
    expectedStartup: "instant",
    mediaId: "file-1",
    selected: { videoStreamIndex: 0 },
    container: { input: "mp4", output: "original", action: "direct" },
    video: { inputCodec: "h264", action: "copy" },
    audio: { inputCodec: "aac", action: "copy" },
    subtitles: { action: "none" },
    reasons: [],
    delivery: { type: "file" },
    ...overrides,
  } as PlaybackPlan;
}

describe("native playback mode mapping", () => {
  it("maps a plan needing no FFmpeg to DIRECT_PLAY", () => {
    expect(toNativeMode(plan())).toBe("DIRECT_PLAY");
  });

  it("maps a container-only change to REMUX", () => {
    expect(
      toNativeMode(
        plan({
          requiresFfmpeg: true,
          container: { input: "mkv", output: "hls-fmp4", action: "hls" },
          video: { inputCodec: "h264", action: "copy" },
          audio: { inputCodec: "aac", action: "copy" },
        }),
      ),
    ).toBe("REMUX");
  });

  it("maps an audio-only transcode to DIRECT_STREAM", () => {
    expect(
      toNativeMode(
        plan({
          requiresFfmpeg: true,
          video: { inputCodec: "h264", action: "copy" },
          audio: {
            inputCodec: "eac3",
            outputCodec: "aac",
            action: "transcode",
          },
        }),
      ),
    ).toBe("DIRECT_STREAM");
  });

  it("maps a video transcode or a burned-in subtitle to TRANSCODE", () => {
    expect(
      toNativeMode(
        plan({
          requiresFfmpeg: true,
          video: {
            inputCodec: "hevc",
            outputCodec: "h264",
            action: "transcode",
          },
        }),
      ),
    ).toBe("TRANSCODE");

    expect(
      toNativeMode(
        plan({
          requiresFfmpeg: true,
          video: { inputCodec: "h264", action: "copy" },
          subtitles: { inputCodec: "hdmv_pgs_subtitle", action: "burn" },
        }),
      ),
    ).toBe("TRANSCODE");
  });

  it("emits a stable reason code for every reason the plan needed FFmpeg", () => {
    expect(
      toReasonCodes(
        plan({
          requiresFfmpeg: true,
          container: { input: "mkv", output: "hls-fmp4", action: "hls" },
          video: {
            inputCodec: "hevc",
            outputCodec: "h264",
            action: "transcode",
          },
          audio: {
            inputCodec: "eac3",
            outputCodec: "aac",
            action: "transcode",
          },
          subtitles: { inputCodec: "hdmv_pgs_subtitle", action: "burn" },
        }),
      ),
    ).toEqual([
      "CONTAINER_NOT_SUPPORTED",
      "VIDEO_CODEC_NOT_SUPPORTED",
      "AUDIO_CODEC_NOT_SUPPORTED",
      "SUBTITLE_BURN_IN_REQUIRED",
    ]);
  });

  it("emits no reason codes for a direct play", () => {
    expect(toReasonCodes(plan())).toEqual([]);
  });
});

describe("pre-generated adaptive planning", () => {
  const manifest: MediaQualityManifest = {
    mediaId: "file-1",
    qualities: [],
    adaptive: {
      profileVersion: ADAPTIVE_PROFILE_VERSION,
      playbackUrl: "/renditions/file/adaptive/abcdef123456/master.m3u8",
      mimeType: "application/vnd.apple.mpegurl",
      segmentTargetSeconds: 2,
      switching: "aligned-cmaf-hls",
      qualities: [
        {
          id: "720p",
          label: "720p",
          width: 1280,
          height: 720,
          bitrate: 3_000_000,
          videoCodec: "h264",
          hdr: false,
        },
      ],
      audioTracks: [
        {
          id: "track-1",
          sourceStreamIndex: 1,
          label: "English",
          channels: 2,
          isDefault: true,
        },
      ],
    },
    limitations: {
      generatedAudio: "default-track-only",
      generatedSubtitles: "external-or-original-only",
      switching: "complete-file-rebuffer",
    },
  };

  it("replaces a live-transcode plan before ffmpeg and preserves a quality ceiling", () => {
    const selected = buildAdaptiveRenditionPlan(
      plan({
        requiresFfmpeg: true,
        mode: "video-transcode",
        container: { input: "mkv", output: "hls-fmp4", action: "hls" },
        video: {
          inputCodec: "hevc",
          outputCodec: "h264",
          action: "transcode",
        },
      }),
      manifest,
      { selectedAudioStreamIndex: 1, maxHeight: 720 },
    );

    expect(selected).toMatchObject({
      mode: "direct-play",
      requiresFfmpeg: false,
      delivery: { type: "hls" },
      video: { action: "copy" },
    });
    expect(selected?.delivery.url).toContain("maxHeight=720");
  });

  /**
   * The retention policy deliberately leaves unrelated languages out of a
   * generated package, while the player still lists every track the *source*
   * carries. Asking for one of the left-out tracks therefore has to fall back
   * to the normal planner, which remuxes the original with only that stream
   * mapped. Without this the click is a silent no-op.
   */
  it("falls back to the normal planner for a track the package does not carry", () => {
    const packaged = manifest.adaptive!.audioTracks.map(
      (track) => track.sourceStreamIndex,
    );
    const notPackaged = Math.max(...packaged) + 1;

    expect(
      buildAdaptiveRenditionPlan(plan(), manifest, {
        selectedAudioStreamIndex: notPackaged,
      }),
    ).toBeNull();
    expect(
      buildAdaptiveRenditionPlan(plan(), manifest, {
        selectedAudioStreamIndex: packaged[0],
      }),
    ).not.toBeNull();
  });

  it("keeps the normal planner for unavailable audio or burned subtitles", () => {
    expect(
      buildAdaptiveRenditionPlan(plan(), manifest, {
        selectedAudioStreamIndex: 7,
      }),
    ).toBeNull();
    expect(
      buildAdaptiveRenditionPlan(
        plan({ subtitles: { inputCodec: "pgs", action: "burn" } }),
        manifest,
      ),
    ).toBeNull();
  });
});

describe("route precedence for session delivery", () => {
  /**
   * The HLS playlist references segments by bare filename, so they arrive at
   * `/sessions/:id/<name>`. That must not shadow `/sessions/:id/file` or
   * `/sessions/:id/master.m3u8`.
   */
  it("prefers a literal segment over a parameter regardless of registration order", async () => {
    const hits: string[] = [];
    const route = (path: string, label: string) => ({
      method: "GET" as const,
      path,
      access: "public" as const,
      handle: async ({ response, requestId }: RouteContext) => {
        hits.push(label);
        sendOwnApiJson(response, 200, { data: { label }, requestId });
      },
    });

    const router = createOwnApiRouter({
      csrfSecret: "x".repeat(32),
      csrfCookieName: "csrf",
      resolveSession: async () => null,
      routes: [
        // Deliberately registered before the literal routes.
        route("/playback/sessions/:sessionId/:segmentName", "segment"),
        route("/playback/sessions/:sessionId/file", "file"),
        route("/playback/sessions/:sessionId/master.m3u8", "playlist"),
      ],
    });

    const call = async (path: string) => {
      const response = {
        statusCode: 200,
        setHeader: () => undefined,
        getHeader: () => undefined,
        end: () => undefined,
      } as unknown as ServerResponse;
      await router.handler(
        {
          method: "GET",
          url: path,
          headers: { host: "seyirlik.test" },
          socket: { remoteAddress: "127.0.0.1" },
        } as unknown as IncomingMessage,
        response,
        { requestId: "req-1", url: new URL(path, "https://seyirlik.test") },
      );
    };

    const sessionId = "11111111-1111-4111-8111-111111111111";
    await call(`/ownAPI/v1/playback/sessions/${sessionId}/file`);
    await call(`/ownAPI/v1/playback/sessions/${sessionId}/master.m3u8`);
    await call(`/ownAPI/v1/playback/sessions/${sessionId}/segment_00003.ts`);

    expect(hits).toEqual(["file", "playlist", "segment"]);
  });

  it("reports the matched template, not the caller's path, for logging", () => {
    const router = createOwnApiRouter({
      csrfSecret: "x".repeat(32),
      csrfCookieName: "csrf",
      resolveSession: async () => null,
      routes: [
        {
          method: "GET",
          path: "/playback/sessions/:sessionId/:segmentName",
          access: "public",
          handle: async () => undefined,
        },
      ],
    });

    expect(
      router.resolveTemplate("/ownAPI/v1/playback/sessions/abc/segment_1.ts"),
    ).toBe("/ownAPI/v1/playback/sessions/:sessionId/:segmentName");
  });
});

describe("rendition delivery", () => {
  const VIEWER = "11111111-1111-4111-8111-111111111111";
  const FILE = "22222222-2222-4222-8222-222222222222";
  const HIDDEN_FILE = "33333333-3333-4333-8333-333333333333";

  function buildRenditionRouter(options: { served: string[] }) {
    const catalogue = {
      getFileById: async (id: string) =>
        id === FILE
          ? { id: FILE, itemId: "item-visible", missingSince: null }
          : id === HIDDEN_FILE
            ? { id: HIDDEN_FILE, itemId: "item-hidden", missingSince: null }
            : null,
      canUserAccessItem: async (_userId: string, itemId: string) =>
        itemId === "item-visible",
    } as unknown as Parameters<typeof createPlaybackRoutes>[0]["catalogue"];

    const renditions = {
      createManifest: async () => ({ mediaId: FILE, qualities: [] }),
      resolveFile: async (token: string, fileId: string) => {
        options.served.push(`${token}/${fileId}`);
        // A path that does not exist: the route's job is to authorize and
        // resolve, and serving the bytes is covered where that code lives.
        return { absolutePath: "/generated/missing.mp4", sizeBytes: 10 };
      },
      resolveAdaptiveAsset: async (
        token: string,
        versionId: string,
        assetPath: string,
      ) => {
        options.served.push(`${token}/${versionId}/${assetPath}`);
        return { absolutePath: "/generated/missing.m4s", sizeBytes: 10 };
      },
    } as unknown as NonNullable<
      Parameters<typeof createPlaybackRoutes>[0]["renditions"]
    >;

    return createOwnApiRouter({
      csrfSecret: "s".repeat(32),
      csrfCookieName: "seyirlik_csrf",
      publicOrigin: "https://seyirlik.test",
      resolveSession: async () => ({
        userId: VIEWER,
        username: "viewer",
        displayName: "Viewer",
        isAdministrator: false,
        sessionId: "44444444-4444-4444-8444-444444444444",
        sessionTokenHash: Buffer.alloc(32),
      }),
      routes: createPlaybackRoutes({
        catalogue,
        sessions: {} as never,
        sessionManager: {} as never,
        mediaRoot: "/media",
        renditions,
      }),
    });
  }

  async function get(
    router: ReturnType<typeof buildRenditionRouter>,
    pathname: string,
  ) {
    const request = {
      method: "GET",
      url: pathname,
      headers: { host: "seyirlik.test" },
      socket: { remoteAddress: "127.0.0.1" },
    } as unknown as IncomingMessage;
    const response = {
      statusCode: 200,
      setHeader() {},
      getHeader() {
        return undefined;
      },
      end() {},
    } as unknown as ServerResponse;

    let error: unknown;
    let handled = false;
    try {
      handled = await router.handler(request, response, {
        requestId: "req-1",
        url: new URL(pathname, "https://seyirlik.test"),
      });
    } catch (caught) {
      error = caught;
    }
    return { error, handled };
  }

  it("serves a rendition for a file the viewer can see", async () => {
    const served: string[] = [];
    const router = buildRenditionRouter({ served });

    await get(
      router,
      `/ownAPI/v1/playback/renditions/${FILE}/720-abcdef123456.mp4`,
    );

    expect(served).toEqual([`${FILE}/720-abcdef123456.mp4`]);
  });

  it("authorizes nested adaptive byte-range assets before resolving them", async () => {
    const served: string[] = [];
    const router = buildRenditionRouter({ served });

    await get(
      router,
      `/ownAPI/v1/playback/renditions/${FILE}/adaptive/abcdef123456/video/720p/media.m4s`,
    );

    expect(served).toEqual([`${FILE}/abcdef123456/video/720p/media.m4s`]);
  });

  it("resolves title-layout masters, hidden playlists, and visible media paths", async () => {
    const served: string[] = [];
    const router = buildRenditionRouter({ served });
    const base = `/ownAPI/v1/playback/renditions/${FILE}/adaptive/abcdef123456`;

    await get(router, `${base}/.seyirlik/master.m3u8`);
    await get(router, `${base}/.seyirlik/video/1080p60%20HDR.m3u8`);
    await get(router, `${base}/video/1080p60%20HDR.mp4`);

    expect(served).toEqual([
      `${FILE}/abcdef123456/.seyirlik/master.m3u8`,
      `${FILE}/abcdef123456/.seyirlik/video/1080p60 HDR.m3u8`,
      `${FILE}/abcdef123456/video/1080p60 HDR.mp4`,
    ]);
  });

  it("refuses a rendition of a file in a library the viewer cannot see", async () => {
    // The token is minted from the media file id, so it is guessable. Access has
    // to be re-checked on every request rather than inferred from possession.
    const served: string[] = [];
    const router = buildRenditionRouter({ served });

    const { error } = await get(
      router,
      `/ownAPI/v1/playback/renditions/${HIDDEN_FILE}/720-abcdef123456.mp4`,
    );

    expect((error as { statusCode?: number }).statusCode).toBe(404);
    expect(served).toEqual([]);
  });

  it("rejects a token that is not a media file id before touching the service", async () => {
    const served: string[] = [];
    const router = buildRenditionRouter({ served });

    // An encoded separator never reaches a handler at all; a well-formed but
    // non-UUID token is refused by validation. Neither may reach the service.
    const traversal = await get(
      router,
      "/ownAPI/v1/playback/renditions/..%2F..%2Fsecret/720-abcdef123456.mp4",
    );
    expect(traversal.handled).toBe(false);

    const notAUuid = await get(
      router,
      "/ownAPI/v1/playback/renditions/not-a-uuid/720-abcdef123456.mp4",
    );
    expect((notAUuid.error as { statusCode?: number }).statusCode).toBe(422);

    expect(served).toEqual([]);
  });
});

describe("session reads after the session goes idle", () => {
  const VIEWER = "11111111-1111-4111-8111-111111111111";
  const OTHER_USER = "55555555-5555-4555-8555-555555555555";
  const FILE = "22222222-2222-4222-8222-222222222222";
  const SESSION = "66666666-6666-4666-8666-666666666666";

  function buildSubtitleRouter(
    session: {
      userId: string;
      status: "active" | "ended" | "failed";
      itemId?: string;
    },
    packagedSubtitles: Array<{
      streamIndex: number;
      language?: string;
      isDefault: boolean;
      isForced: boolean;
      path: string;
    }> = [],
  ) {
    const catalogue = {
      getFileById: async () => ({
        id: FILE,
        itemId: "item-visible",
        relativePath: "Film/Film.mp4",
        missingSince: null,
      }),
      listStreams: async () => [
        {
          kind: "subtitle",
          streamIndex: 2,
          isTextSubtitle: true,
          isExternal: true,
          externalRelativePath: "Film/Film.tr.srt",
        },
      ],
      canUserAccessItem: async (_userId: string, itemId: string) =>
        itemId === "item-visible",
    } as unknown as Parameters<typeof createPlaybackRoutes>[0]["catalogue"];

    const sessions = {
      get: async (id: string) =>
        id === SESSION
          ? {
              id: SESSION,
              itemId: "item-visible",
              mediaFileId: FILE,
              ...session,
            }
          : null,
      touch: async () => {},
    } as unknown as Parameters<typeof createPlaybackRoutes>[0]["sessions"];

    return createOwnApiRouter({
      csrfSecret: "s".repeat(32),
      csrfCookieName: "seyirlik_csrf",
      publicOrigin: "https://seyirlik.test",
      resolveSession: async () => ({
        userId: VIEWER,
        username: "viewer",
        displayName: "Viewer",
        isAdministrator: false,
        sessionId: "44444444-4444-4444-8444-444444444444",
        sessionTokenHash: Buffer.alloc(32),
      }),
      routes: createPlaybackRoutes({
        catalogue,
        sessions,
        sessionManager: {} as never,
        mediaRoot: "/media",
        renditions: {
          findPackagedSubtitles: async () => packagedSubtitles,
        } as never,
        // Extraction itself is covered where it lives. A binary that cannot
        // start turns a request that got past the session into a 422, which is
        // what separates "reached the track" from "refused at the door".
        ffmpegPath: "/nonexistent/ffmpeg",
      }),
    });
  }

  async function requestTrack(
    router: ReturnType<typeof buildSubtitleRouter>,
    pathname = `/ownAPI/v1/playback/sessions/${SESSION}/subtitles/2.vtt`,
  ) {
    try {
      await router.handler(
        {
          method: "GET",
          url: pathname,
          headers: { host: "seyirlik.test" },
          socket: { remoteAddress: "127.0.0.1" },
        } as unknown as IncomingMessage,
        {
          statusCode: 200,
          setHeader() {},
          getHeader() {
            return undefined;
          },
          end() {},
        } as unknown as ServerResponse,
        {
          requestId: "req-1",
          url: new URL(pathname, "https://seyirlik.test"),
        },
      );
    } catch (caught) {
      return (caught as OwnApiError).code;
    }
    return "served";
  }

  it("still serves a track once the idle reaper has ended the session", async () => {
    // HLS renditions never touch the session, so it ends mid-film. Picking a
    // track after that used to 404 and the overlay stayed empty.
    expect(
      await requestTrack(
        buildSubtitleRouter({ userId: VIEWER, status: "ended" }),
      ),
    ).toBe("SUBTITLE_UNAVAILABLE");
  });

  it("serves a track only the package carries from the package, with no extraction", async () => {
    // A subtitle packaged from a sidecar the catalogue never recorded, or one
    // of a title whose source is gone. ffmpeg cannot start here, so "served"
    // can only mean the converted file was read.
    const directory = mkdtempSync(path.join(tmpdir(), "seyirlik-packaged-"));
    const vtt = path.join(directory, "turkish.vtt");
    writeFileSync(vtt, "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nMerhaba\n");
    try {
      expect(
        await requestTrack(
          buildSubtitleRouter({ userId: VIEWER, status: "ended" }, [
            {
              streamIndex: 7,
              language: "tur",
              isDefault: false,
              isForced: false,
              path: vtt,
            },
          ]),
          `/ownAPI/v1/playback/sessions/${SESSION}/subtitles/7.vtt`,
        ),
      ).toBe("served");
      // An index the package does not carry and the catalogue does not know.
      expect(
        await requestTrack(
          buildSubtitleRouter({ userId: VIEWER, status: "ended" }),
          `/ownAPI/v1/playback/sessions/${SESSION}/subtitles/7.vtt`,
        ),
      ).toBe("SUBTITLE_NOT_FOUND");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("refuses another viewer's session, a failed one, and a revoked title", async () => {
    expect(
      await requestTrack(
        buildSubtitleRouter({ userId: OTHER_USER, status: "ended" }),
      ),
    ).toBe("SESSION_NOT_FOUND");
    expect(
      await requestTrack(
        buildSubtitleRouter({ userId: VIEWER, status: "failed" }),
      ),
    ).toBe("SESSION_NOT_FOUND");
    expect(
      await requestTrack(
        buildSubtitleRouter({
          userId: VIEWER,
          status: "ended",
          itemId: "item-hidden",
        }),
      ),
    ).toBe("SESSION_NOT_FOUND");
  });

  it("reaches the original file for a frame after the pause outlasted the session", async () => {
    // A frame can only be saved while paused, which is exactly when the idle
    // reaper ends the session.
    expect(
      await requestTrack(
        buildSubtitleRouter({ userId: VIEWER, status: "ended" }),
        `/ownAPI/v1/playback/sessions/${SESSION}/frame.png?at=284.5`,
      ),
    ).toBe("FRAME_UNAVAILABLE");
  });

  it("keeps serving a direct-play original after a pause outlasted the session", async () => {
    // Resuming an original after more than five idle minutes used to 404:
    // the reaper had ended the session the <video> element still pointed at.
    const outcome = await requestTrack(
      buildSubtitleRouter({ userId: VIEWER, status: "ended" }),
      `/ownAPI/v1/playback/sessions/${SESSION}/file`,
    );
    expect(outcome).not.toBe("SESSION_NOT_FOUND");
    expect(
      await requestTrack(
        buildSubtitleRouter({ userId: VIEWER, status: "failed" }),
        `/ownAPI/v1/playback/sessions/${SESSION}/file`,
      ),
    ).toBe("SESSION_NOT_FOUND");
    expect(
      await requestTrack(
        buildSubtitleRouter({
          userId: VIEWER,
          status: "ended",
          itemId: "item-hidden",
        }),
        `/ownAPI/v1/playback/sessions/${SESSION}/file`,
      ),
    ).toBe("SESSION_NOT_FOUND");
  });

  it("refuses a frame time that is missing, negative or not a number", async () => {
    const router = buildSubtitleRouter({ userId: VIEWER, status: "active" });

    for (const query of ["", "?at=", "?at=-1", "?at=abc", "?at=Infinity"]) {
      expect(
        await requestTrack(
          router,
          `/ownAPI/v1/playback/sessions/${SESSION}/frame.png${query}`,
        ),
      ).toBe("VALIDATION_FAILED");
    }
  });
});

describe("saving a frame of a title whose source is gone", () => {
  const VIEWER = "11111111-1111-4111-8111-111111111111";
  const FILE = "22222222-2222-4222-8222-222222222222";
  const SESSION = "66666666-6666-4666-8666-666666666666";

  /**
   * An FFmpeg stand-in that records the playlist it was handed and answers
   * with a few bytes, so the route's choice of input is what is under test.
   */
  function fakeFfmpeg(directory: string) {
    const record = path.join(directory, "input.m3u8");
    const script = path.join(directory, "ffmpeg");
    writeFileSync(
      script,
      [
        "#!/bin/sh",
        'while [ "$1" != "-i" ]; do shift; done',
        `cp "$2" "${record}"`,
        "printf PNG",
      ].join("\n"),
      { mode: 0o755 },
    );
    return { script, record };
  }

  function buildFrameRouter(options: {
    ffmpegPath: string;
    packaged: { playlistPath: string; colorTransfer: string | null } | null;
    asked: unknown[];
  }) {
    const catalogue = {
      getFileById: async () => ({
        id: FILE,
        itemId: "item-visible",
        relativePath: "Show/Season 01/Show S01E01.mkv",
        sizeBytes: "1000",
        mtimeMs: "2000",
        missingSince: null,
      }),
      listStreams: async () => {
        throw new Error("a source that is gone has no streams to read");
      },
      canUserAccessItem: async () => true,
    } as unknown as Parameters<typeof createPlaybackRoutes>[0]["catalogue"];

    const sessions = {
      get: async () => ({
        id: SESSION,
        userId: VIEWER,
        status: "ended",
        itemId: "item-visible",
        mediaFileId: FILE,
      }),
      touch: async () => {},
    } as unknown as Parameters<typeof createPlaybackRoutes>[0]["sessions"];

    return createOwnApiRouter({
      csrfSecret: "s".repeat(32),
      csrfCookieName: "seyirlik_csrf",
      publicOrigin: "https://seyirlik.test",
      resolveSession: async () => ({
        userId: VIEWER,
        username: "viewer",
        displayName: "Viewer",
        isAdministrator: false,
        sessionId: "44444444-4444-4444-8444-444444444444",
        sessionTokenHash: Buffer.alloc(32),
      }),
      routes: createPlaybackRoutes({
        catalogue,
        sessions,
        sessionManager: {} as never,
        mediaRoot: "/nonexistent-media-root",
        renditions: {
          findPackagedVideo: async (media: unknown) => {
            options.asked.push(media);
            return options.packaged
              ? {
                  path: "unused.mp4",
                  width: 1920,
                  height: 1080,
                  durationSeconds: 3600,
                  colorPrimaries: null,
                  ...options.packaged,
                }
              : null;
          },
        } as never,
        ffmpegPath: options.ffmpegPath,
      }),
    });
  }

  async function requestFrame(router: ReturnType<typeof buildFrameRouter>) {
    const pathname = `/ownAPI/v1/playback/sessions/${SESSION}/frame.png?at=1013.2`;
    let body: Buffer | undefined;
    try {
      await router.handler(
        {
          method: "GET",
          url: pathname,
          headers: { host: "seyirlik.test" },
          socket: { remoteAddress: "127.0.0.1" },
        } as unknown as IncomingMessage,
        {
          statusCode: 200,
          setHeader() {},
          getHeader() {
            return undefined;
          },
          end(chunk?: Buffer) {
            body = chunk;
          },
        } as unknown as ServerResponse,
        { requestId: "req-1", url: new URL(pathname, "https://seyirlik.test") },
      );
    } catch (caught) {
      return { code: (caught as OwnApiError).code };
    }
    return { code: "served", body: body?.toString() };
  }

  it("captures from the package's playlist, read from a local copy", async () => {
    // Sopranos S01E01: the source was deleted once Drive held its package,
    // and every save answered "the frame could not be saved".
    const directory = mkdtempSync(path.join(tmpdir(), "seyirlik-frame-"));
    try {
      const packageDirectory = path.join(directory, ".seyirlik", "video");
      mkdirSync(packageDirectory, { recursive: true });
      const playlistPath = path.join(packageDirectory, "1080p.m3u8");
      writeFileSync(
        playlistPath,
        [
          "#EXTM3U",
          '#EXT-X-MAP:URI="../../video/1080p.mp4",BYTERANGE="800@0"',
          "#EXTINF:2.0,",
          "#EXT-X-BYTERANGE:1000@800",
          "../../video/1080p.mp4",
          "",
        ].join("\n"),
      );
      const ffmpeg = fakeFfmpeg(directory);
      const asked: unknown[] = [];

      const outcome = await requestFrame(
        buildFrameRouter({
          ffmpegPath: ffmpeg.script,
          packaged: { playlistPath, colorTransfer: null },
          asked,
        }),
      );

      expect(outcome).toEqual({ code: "served", body: "PNG" });
      expect(asked).toEqual([
        expect.objectContaining({ mediaId: FILE, size: 1000, mtimeMs: 2000 }),
      ]);
      // The copy names the rendition by its absolute path, so FFmpeg can
      // open it from temp storage.
      const handed = readFileSync(ffmpeg.record, "utf8");
      expect(handed).toContain(`${path.join(directory, "video", "1080p.mp4")}`);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("says the frame is unavailable when there is neither a source nor a package", async () => {
    const asked: unknown[] = [];
    expect(
      await requestFrame(
        buildFrameRouter({
          ffmpegPath: "/nonexistent/ffmpeg",
          packaged: null,
          asked,
        }),
      ),
    ).toEqual({ code: "FRAME_UNAVAILABLE" });
    expect(asked).toHaveLength(1);
  });
});

describe("playback readiness", () => {
  const VIEWER = "11111111-1111-4111-8111-111111111111";
  const ITEM = "55555555-5555-4555-8555-555555555555";
  const FILE = "66666666-6666-4666-8666-666666666666";
  const CSRF_SECRET = "s".repeat(32);
  const SESSION_HASH = Buffer.alloc(32);

  function buildRouter(options: {
    probeState: "pending" | "probed" | "failed";
    packagedDurationSeconds?: number;
  }) {
    const catalogue = {
      canUserAccessItem: async () => true,
      getFileById: async () => ({
        id: FILE,
        itemId: ITEM,
        missingSince: null,
        probeState: options.probeState,
        relativePath: "Movies/Film (2000)/Film (2000).mp4",
        container: "mp4",
        sizeBytes: "1024",
        mtimeMs: "1700000000000",
        durationMs: null,
        bitrateBps: null,
      }),
      getPrimaryFile: async () => null,
      listStreams: async () => [],
      listChapters: async () => [],
    } as unknown as Parameters<typeof createPlaybackRoutes>[0]["catalogue"];

    const renditions = {
      createManifest: async () => ({ mediaId: FILE, qualities: [] }),
      resolveFile: async () => null,
      resolveAdaptiveAsset: async () => null,
      describePackagedSource: async () =>
        options.packagedDurationSeconds === undefined
          ? null
          : {
              durationSeconds: options.packagedDurationSeconds,
              video: {
                index: 0,
                codecName: "h264",
                width: 1920,
                height: 1080,
                isHdr: false,
                hasDolbyVision: false,
              },
              audio: [
                {
                  index: 1,
                  codecName: "aac",
                  channels: 2,
                  sampleRate: 48_000,
                  isDefault: true,
                },
              ],
              subtitles: [],
            },
    } as unknown as NonNullable<
      Parameters<typeof createPlaybackRoutes>[0]["renditions"]
    >;

    return createOwnApiRouter({
      csrfSecret: CSRF_SECRET,
      csrfCookieName: "seyirlik_csrf",
      publicOrigin: "https://seyirlik.test",
      resolveSession: async () => ({
        userId: VIEWER,
        username: "viewer",
        displayName: "Viewer",
        isAdministrator: false,
        sessionId: "44444444-4444-4444-8444-444444444444",
        sessionTokenHash: SESSION_HASH,
      }),
      routes: createPlaybackRoutes({
        catalogue,
        sessions: {} as never,
        sessionManager: {} as never,
        mediaRoot: "/media",
        renditions,
      }),
    });
  }

  async function requestPlan(router: ReturnType<typeof buildRouter>) {
    const payload = JSON.stringify({
      itemId: ITEM,
      mediaFileId: FILE,
      clientCapabilities: {
        supportsHlsNative: false,
        supportsMediaSource: true,
        directFileContainers: ["mp4"],
        mseContainers: ["mp4"],
        video: { h264: { supported: true } },
        audio: { aac: { supported: true } },
        subtitles: { webvtt: { supported: true } },
      },
    });
    const csrfToken = createCsrfToken(SESSION_HASH, CSRF_SECRET);
    const request = Object.assign(Readable.from([Buffer.from(payload)]), {
      method: "POST",
      url: "/ownAPI/v1/playback/plan",
      headers: {
        host: "seyirlik.test",
        "content-type": "application/json",
        origin: "https://seyirlik.test",
        cookie: `seyirlik_csrf=${csrfToken}`,
        "x-csrf-token": csrfToken,
      },
      socket: { remoteAddress: "127.0.0.1" },
    }) as unknown as IncomingMessage;

    let body = "";
    const response = {
      statusCode: 200,
      setHeader() {},
      getHeader() {
        return undefined;
      },
      end(chunk?: string) {
        body = chunk ?? "";
      },
    } as unknown as ServerResponse;

    let error: unknown;
    try {
      await router.handler(request, response, {
        requestId: "req-1",
        url: new URL("/ownAPI/v1/playback/plan", "https://seyirlik.test"),
      });
    } catch (caught) {
      error = caught;
    }
    return { error, json: body ? JSON.parse(body) : undefined };
  }

  it("plans playback for a title whose source was replaced by its package", async () => {
    const { error, json } = await requestPlan(
      buildRouter({ probeState: "failed", packagedDurationSeconds: 7200 }),
    );

    expect(error).toBeUndefined();
    expect(json?.data).toBeDefined();
  });

  it("says a file that failed analysis cannot be played, not that it is pending", async () => {
    const { error } = await requestPlan(buildRouter({ probeState: "failed" }));

    expect((error as OwnApiError).code).toBe("MEDIA_UNPLAYABLE");
    expect((error as OwnApiError).statusCode).toBe(422);
  });

  it("still reports an unprobed file as not ready yet", async () => {
    const { error } = await requestPlan(buildRouter({ probeState: "pending" }));

    expect((error as OwnApiError).code).toBe("MEDIA_NOT_READY");
    expect((error as OwnApiError).statusCode).toBe(409);
  });
});
