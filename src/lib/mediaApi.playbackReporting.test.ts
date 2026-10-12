import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PlaybackSourceCandidate } from "./types";

const { request } = vi.hoisted(() => ({ request: vi.fn() }));

class OwnApiClientError extends Error {
  status: number;
  code: string;
  constructor(options: { status: number; code: string; message: string }) {
    super(options.message);
    this.name = "OwnApiClientError";
    this.status = options.status;
    this.code = options.code;
  }
}

vi.mock("../api/ownApi/client", () => ({
  ownApiClient: { request, requestCollection: vi.fn() },
  ownApiUrl: (path: string) => `https://media.example${path}`,
  OwnApiClientError,
}));

const {
  reportPlaybackStopped,
  reportPlaybackStoppedBeforeUnload,
  reportPlaybackProgress,
  stopActiveTranscodeSession,
  getActiveTranscodingReasons,
} = await import("./mediaApi");

const source = {
  id: "source-1",
  itemId: "11111111-1111-4111-8111-111111111111",
  playSessionId: "22222222-2222-4222-8222-222222222222",
  mode: "DirectPlay",
  url: "https://media.example/file",
  isHls: false,
  label: "Direct play",
  mediaSource: {},
  reason: "test",
  priority: 0,
} as unknown as PlaybackSourceCandidate;

function methodsFor(path: string): string[] {
  return request.mock.calls
    .filter(([calledPath]) => String(calledPath).includes(path))
    .map(
      ([, options]) =>
        (options as { method?: string } | undefined)?.method ?? "GET",
    );
}

describe("reportPlaybackStopped", () => {
  beforeEach(() => {
    request.mockReset();
    request.mockResolvedValue(undefined);
  });

  it("records the stop position", async () => {
    await reportPlaybackStopped(source, 125_000_000);

    expect(methodsFor("/progress").length).toBeGreaterThan(0);
  });

  /**
   * Reaching the end of a title is not the end of the session. The media
   * element stays attached and seekable, so a viewer scrubbing back into the
   * film must still get bytes. Ending the session here made the next range
   * request 404 and killed the element with a demuxer read error.
   */
  it("does not end the playback session", async () => {
    await reportPlaybackStopped(source, 125_000_000);

    expect(methodsFor("/playback/sessions")).not.toContain("DELETE");
  });

  it("still ends the session when the lease explicitly asks for it", async () => {
    await stopActiveTranscodeSession(source.playSessionId);

    expect(methodsFor("/playback/sessions")).toContain("DELETE");
  });

  it("leaves progress reporting free of session teardown too", async () => {
    await reportPlaybackProgress(source, 60_000_000, false);

    expect(methodsFor("/playback/sessions")).not.toContain("DELETE");
  });
});

describe("reportPlaybackStoppedBeforeUnload", () => {
  beforeEach(() => {
    request.mockReset();
  });

  /**
   * The progress route is PUT-only and needs the CSRF header. The beacon this
   * replaced could do neither, so every save made on leaving the page was
   * refused with 405 and the last minutes watched were lost.
   */
  it("saves the place with a keepalive PUT, which carries CSRF like any save", () => {
    request.mockResolvedValue(undefined);

    reportPlaybackStoppedBeforeUnload(source, 125_000_000);

    expect(request).toHaveBeenCalledTimes(1);
    const [path, options] = request.mock.calls[0] as [
      string,
      { method: string; keepalive?: boolean; csrf?: boolean; body: unknown },
    ];
    expect(path).toBe(`/progress/${source.itemId}`);
    expect(options.method).toBe("PUT");
    expect(options.keepalive).toBe(true);
    // Left to the client's default, which sends CSRF for every non-GET.
    expect(options.csrf).toBeUndefined();
    expect(options.body).toMatchObject({ positionMs: 12_500 });
  });

  it("swallows a failure, since the page is already going away", async () => {
    request.mockRejectedValue(new Error("offline"));
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);

    reportPlaybackStoppedBeforeUnload(source, 125_000_000);
    await new Promise((resolve) => setTimeout(resolve, 0));

    process.off("unhandledRejection", unhandled);
    expect(unhandled).not.toHaveBeenCalled();
  });
});

describe("getActiveTranscodingReasons", () => {
  beforeEach(() => {
    request.mockReset();
  });

  it("returns the reported reasons for a live session", async () => {
    request.mockResolvedValue({ reasonCodes: ["VIDEO_CODEC_NOT_SUPPORTED"] });

    await expect(
      getActiveTranscodingReasons(source.itemId, source.playSessionId),
    ).resolves.toEqual(["VIDEO_CODEC_NOT_SUPPORTED"]);
  });

  /**
   * A poller keyed to a retired session would otherwise ask for it every few
   * seconds forever, turning a normal source switch into a stream of 404s in
   * the console.
   */
  it("reports a retired session as gone rather than as no reasons", async () => {
    request.mockRejectedValue(
      new OwnApiClientError({
        status: 404,
        code: "SESSION_NOT_FOUND",
        message: "The playback session could not be found.",
      }),
    );

    await expect(
      getActiveTranscodingReasons(source.itemId, source.playSessionId),
    ).resolves.toBeNull();
  });

  it("treats a transient failure as no reasons, not as a retired session", async () => {
    request.mockRejectedValue(
      new OwnApiClientError({ status: 0, code: "NETWORK", message: "offline" }),
    );

    await expect(
      getActiveTranscodingReasons(source.itemId, source.playSessionId),
    ).resolves.toEqual([]);
  });

  it("asks for nothing when there is no session yet", async () => {
    await expect(
      getActiveTranscodingReasons(source.itemId, undefined),
    ).resolves.toEqual([]);
    expect(request).not.toHaveBeenCalled();
  });
});
