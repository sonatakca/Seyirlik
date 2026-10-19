import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createOwnApiRouter } from "../api/router";
import type { OwnApiError } from "../ownApiHandler";
import { createDownloadRoutes } from "./downloadRoutes";

const VIEWER = "11111111-1111-4111-8111-111111111111";
const ITEM = "22222222-2222-4222-8222-222222222222";
const MEDIA_ROOT = mkdtempSync(path.join(tmpdir(), "seyirlik-downloads-"));
writeFileSync(
  path.join(MEDIA_ROOT, "Film.tr.srt"),
  "1\n00:00:01,000 --> 00:00:02,500\nMerhaba\n",
);
writeFileSync(
  path.join(MEDIA_ROOT, "packaged-turkish.vtt"),
  "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nPaketten\n",
);
afterAll(() => rmSync(MEDIA_ROOT, { recursive: true, force: true }));

const STREAMS = [
  { streamIndex: 1, kind: "audio", isTextSubtitle: false },
  { streamIndex: 2, kind: "subtitle", isTextSubtitle: false },
  {
    streamIndex: 3,
    kind: "subtitle",
    isTextSubtitle: true,
    isExternal: true,
    externalRelativePath: "Film.tr.srt",
  },
];

function build(options: {
  allowDownloads: boolean;
  packaged: boolean;
  isAdministrator?: boolean;
}) {
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
    routes: createDownloadRoutes({
      mediaRoot: MEDIA_ROOT,
      users: {
        findById: async () =>
          ({
            allowDownloads: options.allowDownloads,
            isAdministrator: options.isAdministrator ?? false,
          }) as never,
      },
      catalogue: {
        canUserAccessItem: async () => true,
        getPrimaryFile: async () =>
          ({
            id: "file-1",
            relativePath: "Film/Film.mkv",
            sizeBytes: "1",
            mtimeMs: "1",
            missingSince: null,
          }) as never,
        listStreams: async () => STREAMS as never,
      },
      renditions: {
        // Stream 7 exists only in the package: packaged from a sidecar the
        // catalogue never recorded.
        findPackagedSubtitles: async () => [
          {
            streamIndex: 7,
            language: "tur",
            isDefault: false,
            isForced: false,
            fromSidecar: true,
            path: path.join(MEDIA_ROOT, "packaged-turkish.vtt"),
          },
        ],
        createManifest: async () =>
          ({
            mediaId: "file-1",
            qualities: [],
            ...(options.packaged
              ? {
                  adaptive: {
                    playbackUrl:
                      "/ownAPI/v1/playback/renditions/file-1/adaptive/abc/master.m3u8",
                    segmentTargetSeconds: 6,
                    qualities: [
                      {
                        id: "v720",
                        label: "720p",
                        width: 1280,
                        height: 720,
                        bitrate: 3e6,
                        videoCodec: "h264",
                        hdr: false,
                      },
                    ],
                    // Stream 3 is in the package; 5 is a sidecar only the
                    // package converted, so it has no catalogue row here.
                    subtitleTracks: [
                      {
                        sourceStreamIndex: 3,
                        url: "/ownAPI/v1/playback/renditions/file-1/adaptive/abc/subtitle/s3/subtitles.vtt",
                      },
                      {
                        sourceStreamIndex: 5,
                        url: "/ownAPI/v1/playback/renditions/file-1/adaptive/abc/subtitle/s5/subtitles.vtt",
                      },
                    ],
                    audioTracks: [
                      {
                        id: "a1",
                        sourceStreamIndex: 1,
                        label: "Türkçe",
                        language: "tur",
                        channels: 2,
                        isDefault: true,
                      },
                    ],
                  },
                }
              : {}),
          }) as never,
      },
    }),
  });
}

async function call(
  router: ReturnType<typeof build>,
  pathname = `/ownAPI/v1/downloads/items/${ITEM}/plan`,
) {
  let body = "";
  const headers: Record<string, string> = {};
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
        setHeader(name: string, value: string) {
          headers[name.toLowerCase()] = value;
        },
        getHeader() {
          return undefined;
        },
        end(value?: string | Buffer) {
          body = value?.toString() ?? "";
        },
      } as unknown as ServerResponse,
      { requestId: "req", url: new URL(pathname, "https://seyirlik.test") },
    );
  } catch (caught) {
    return { error: (caught as OwnApiError).code };
  }
  return headers["content-type"]?.startsWith("text/vtt")
    ? { vtt: body }
    : (JSON.parse(body) as {
        data: { masterUrl: string; subtitles: unknown };
      });
}

describe("download plan", () => {
  it("refuses an account without the download permission", async () => {
    expect(
      await call(build({ allowDownloads: false, packaged: true })),
    ).toEqual({
      error: "DOWNLOADS_NOT_ALLOWED",
    });
  });

  it("lets an administrator download without the separate permission", async () => {
    expect(
      await call(
        build({ allowDownloads: false, packaged: true, isAdministrator: true }),
      ),
    ).toMatchObject({ data: { masterUrl: expect.any(String) } });
  });

  it("refuses a title with no package to store", async () => {
    expect(
      await call(build({ allowDownloads: true, packaged: false })),
    ).toEqual({
      error: "DOWNLOAD_UNAVAILABLE",
    });
  });

  it("hands over the package's master playlist and rungs", async () => {
    const result = await call(build({ allowDownloads: true, packaged: true }));
    expect(result).toMatchObject({
      data: {
        masterUrl:
          "/ownAPI/v1/playback/renditions/file-1/adaptive/abc/master.m3u8",
        // Only text tracks: an image subtitle cannot be served as WebVTT.
        // The package's own converted copy is named wherever it has one.
        subtitles: [
          {
            streamIndex: 3,
            url: "/ownAPI/v1/playback/renditions/file-1/adaptive/abc/subtitle/s3/subtitles.vtt",
          },
          {
            streamIndex: 5,
            url: "/ownAPI/v1/playback/renditions/file-1/adaptive/abc/subtitle/s5/subtitles.vtt",
          },
        ],
      },
    });
  });
});

describe("download subtitles", () => {
  const subtitle = (index: string) =>
    `/ownAPI/v1/downloads/items/${ITEM}/subtitles/${index}`;

  it("serves a text track as WebVTT, by item and with no session", async () => {
    const result = await call(
      build({ allowDownloads: true, packaged: true }),
      subtitle("3.vtt"),
    );
    expect(result).toMatchObject({ vtt: expect.stringContaining("Merhaba") });
    expect((result as { vtt: string }).vtt).toMatch(/^WEBVTT/);
  });

  it("serves a track only the package carries from its converted file", async () => {
    expect(
      await call(
        build({ allowDownloads: true, packaged: true }),
        subtitle("7.vtt"),
      ),
    ).toEqual({ vtt: expect.stringContaining("Paketten") });
  });

  it("refuses an account without the download permission", async () => {
    expect(
      await call(
        build({ allowDownloads: false, packaged: true }),
        subtitle("3.vtt"),
      ),
    ).toEqual({ error: "DOWNLOADS_NOT_ALLOWED" });
  });

  it("refuses a stream that is not a text subtitle", async () => {
    expect(
      await call(
        build({ allowDownloads: true, packaged: true }),
        subtitle("2.vtt"),
      ),
    ).toEqual({ error: "SUBTITLE_NOT_FOUND" });
  });

  it("refuses a malformed track name", async () => {
    expect(
      await call(
        build({ allowDownloads: true, packaged: true }),
        subtitle("x.vtt"),
      ),
    ).toEqual({ error: "VALIDATION_FAILED" });
  });
});
