import { describe, expect, it, vi } from "vitest";
import type {
  MediaFileRow,
  MediaStreamRow,
} from "../catalogue/catalogueRepository";
import { createSubtitleSyncService } from "./subtitleSync";
import type { SubtitleStorage } from "./subtitleStorage";
import { subtitleDigest } from "./subtitleStorage";

const MEDIA_FILE_ID = "11111111-2222-3333-4444-555555555555";
const RELATIVE_MEDIA = "Movies/Film (2024)/Film.mkv";
const TURKISH = "Movies/Film (2024)/Film.tur.srt";
const ENGLISH = "Movies/Film (2024)/Film.eng.srt";

/** The same generator the aligner's own tests use: dialogue with a rhythm. */
function cues(
  count: number,
  offsetSeconds = 0,
  format: "srt" | "vtt" = "srt",
  step = 2,
) {
  const blocks: string[] = [];
  let at = 30;
  for (let index = 0; index < count; index += 1) {
    const wobble = (index * Math.SQRT2) % 1;
    const duration = 1 + wobble * 2;
    const stamp = (seconds: number) => {
      const total = Math.round((seconds + offsetSeconds) * 1000);
      const ms = total % 1000;
      const whole = (total - ms) / 1000;
      const parts = [
        Math.floor(whole / 3600),
        Math.floor((whole % 3600) / 60),
        whole % 60,
      ].map((part) => String(part).padStart(2, "0"));
      return `${parts.join(":")}${format === "srt" ? "," : "."}${String(
        ms,
      ).padStart(3, "0")}`;
    };
    blocks.push(
      `${index + 1}\n${stamp(at)} --> ${stamp(at + duration)}\nLine ${index + 1}.`,
    );
    at += duration + step + wobble * 3;
  }
  return `${format === "vtt" ? "WEBVTT\n\n" : ""}${blocks.join("\n\n")}\n`;
}

const stream = (over: Partial<MediaStreamRow>): MediaStreamRow =>
  ({
    streamIndex: 0,
    kind: "subtitle",
    codec: "subrip",
    profile: null,
    level: null,
    language: null,
    title: null,
    isDefault: false,
    isForced: false,
    isExternal: false,
    isTextSubtitle: false,
    externalRelativePath: null,
    channels: null,
    sampleRate: null,
    bitrateBps: null,
    width: null,
    height: null,
    pixelFormat: null,
    frameRate: null,
    videoRange: null,
    colorTransfer: null,
    colorPrimaries: null,
    colorSpace: null,
    bitDepth: null,
    ...over,
  }) as MediaStreamRow;

const STREAMS: MediaStreamRow[] = [
  stream({ streamIndex: 0, kind: "video", codec: "hevc" }),
  stream({ streamIndex: 1, kind: "audio", codec: "eac3", language: "eng" }),
  stream({
    streamIndex: 1000,
    language: "eng",
    isExternal: true,
    isTextSubtitle: true,
    externalRelativePath: ENGLISH,
  }),
  stream({
    streamIndex: 1001,
    language: "tur",
    isExternal: true,
    isTextSubtitle: true,
    externalRelativePath: TURKISH,
  }),
  stream({
    streamIndex: 3,
    language: "spa",
    isTextSubtitle: true,
    codec: "mov_text",
  }),
];

function harness(
  files: Record<string, string> = {
    [ENGLISH]: cues(400),
    [TURKISH]: cues(400, 14.5),
  },
) {
  const written = new Map<string, string>();
  const recordRetiming = vi.fn(async () => {});
  const storage: SubtitleStorage = {
    inspect: async () => [],
    install: async () => ({ outcome: "cancelled" }),
    read: async (_id, relativePath) => {
      const text = files[relativePath];
      if (text === undefined) throw new Error("missing");
      return new TextEncoder().encode(text);
    },
    rewrite: async ({ relativePath, bytes, expectedSha256 }) => {
      const current = files[relativePath];
      if (
        current === undefined ||
        subtitleDigest(new TextEncoder().encode(current)) !== expectedSha256
      )
        return {
          outcome: "error",
          failure: "destination-occupied",
          reason: "changed",
        };
      const text = new TextDecoder().decode(bytes);
      files[relativePath] = text;
      written.set(relativePath, text);
      return {
        outcome: "installed",
        relativePath,
        sha256: subtitleDigest(bytes),
        cueCount: 400,
      };
    },
  };
  const service = createSubtitleSyncService({
    libraryRoot: "/library",
    ffmpegPath: "ffmpeg",
    catalogue: {
      getFileById: async () =>
        ({ id: MEDIA_FILE_ID, missingSince: null }) as MediaFileRow,
      listStreams: async () => STREAMS,
    },
    repository: {
      mediaFileRelativePath: async () => RELATIVE_MEDIA,
      recordRetiming,
    },
    storageFactory: () => storage,
  });
  return { service, storage, written, recordRetiming, files };
}

const request = {
  mediaFileId: MEDIA_FILE_ID,
  targetStreamIndex: 1001,
  reference: { kind: "subtitle" as const, streamIndex: 1000 },
};

describe("tracks", () => {
  it("offers every text subtitle but marks only the sidecars correctable", async () => {
    const { service } = harness();
    const tracks = await service.tracks(MEDIA_FILE_ID);
    expect(tracks.subtitles.map((t) => [t.streamIndex, t.retimable])).toEqual([
      [1000, true],
      [1001, true],
      [3, false],
    ]);
  });

  it("names the sidecar files, which is what a person recognises", async () => {
    const { service } = harness();
    const tracks = await service.tracks(MEDIA_FILE_ID);
    expect(tracks.subtitles[1]?.fileName).toBe("Film.tur.srt");
  });

  it("offers the audio tracks to time against", async () => {
    const { service } = harness();
    expect((await service.tracks(MEDIA_FILE_ID)).audio).toEqual([
      expect.objectContaining({ streamIndex: 1, language: "eng" }),
    ]);
  });
});

describe("sync", () => {
  it("moves a late subtitle onto the reference's timeline", async () => {
    const { service, written } = harness();
    const result = await service.sync(request);
    expect(result.outcome).toBe("applied");
    if (result.outcome !== "applied") return;
    expect(result.offsetSeconds).toBeCloseTo(-14.5, 2);
    expect(result.rate).toBeCloseTo(1, 4);
    expect(written.get(TURKISH)).toContain("00:00:30,000 --> ");
  });

  it("records the new digest, so the file stays this system's to correct", async () => {
    const { service, recordRetiming } = harness();
    await service.sync(request);
    expect(recordRetiming).toHaveBeenCalledWith(
      expect.objectContaining({
        relativePath: TURKISH,
        language: "tur",
        format: "srt",
      }),
    );
  });

  it("writes nothing for a dry run", async () => {
    const { service, written, recordRetiming } = harness();
    const result = await service.sync({ ...request, dryRun: true });
    expect(result.outcome).toBe("analysed");
    expect(written.size).toBe(0);
    expect(recordRetiming).not.toHaveBeenCalled();
  });

  it("leaves a subtitle that is already right alone", async () => {
    const { service, written } = harness({
      [ENGLISH]: cues(400),
      [TURKISH]: cues(400),
    });
    expect((await service.sync(request)).outcome).toBe("unchanged");
    expect(written.size).toBe(0);
  });

  it("refuses two documents that are not the same film", async () => {
    const { service, written } = harness({
      [ENGLISH]: cues(400),
      // A different rhythm entirely: nothing about it lines up with anything.
      [TURKISH]: cues(400, 0, "srt", 3.5),
    });
    const result = await service.sync(request);
    expect(result.outcome).toBe("refused");
    expect(result.outcome === "refused" && result.failure).toBe("unconvincing");
    expect(written.size).toBe(0);
  });

  it("refuses to re-time a subtitle that lives inside the container", async () => {
    const { service } = harness();
    const result = await service.sync({ ...request, targetStreamIndex: 3 });
    expect(result.outcome === "refused" && result.failure).toBe(
      "target-embedded",
    );
  });

  it("refuses a track that is not there", async () => {
    const { service } = harness();
    const result = await service.sync({ ...request, targetStreamIndex: 99 });
    expect(result.outcome === "refused" && result.failure).toBe(
      "target-missing",
    );
  });

  it("refuses to time a subtitle against itself", async () => {
    const { service } = harness();
    const result = await service.sync({
      ...request,
      reference: { kind: "subtitle", streamIndex: 1001 },
    });
    expect(result.outcome === "refused" && result.failure).toBe(
      "reference-invalid",
    );
  });

  it("applies a correction given by hand without measuring anything", async () => {
    const { service, written } = harness({
      [ENGLISH]: cues(400),
      [TURKISH]: cues(400, 14.5),
    });
    const result = await service.sync({
      ...request,
      transform: { rate: 1, offsetSeconds: -2 },
    });
    expect(result.outcome).toBe("applied");
    if (result.outcome !== "applied") return;
    expect(result.offsetSeconds).toBe(-2);
    expect(written.get(TURKISH)).toContain("00:00:42,500 --> ");
  });

  it("carries a refusal from the writer back unchanged", async () => {
    const { service, storage } = harness();
    storage.rewrite = async () => ({
      outcome: "error",
      failure: "commit-ambiguous",
      reason: "Another writer holds this media file.",
    });
    const result = await service.sync(request);
    expect(result.outcome === "refused" && result.failure).toBe(
      "commit-ambiguous",
    );
  });

  it("refuses a file with no cues in it", async () => {
    const { service } = harness({
      [ENGLISH]: cues(400),
      [TURKISH]: "WEBVTT\n\nNOTE nothing here\n",
    });
    const result = await service.sync(request);
    expect(result.outcome === "refused" && result.failure).toBe("target-empty");
  });

  /*
   * The harness's library root does not exist, which is exactly a title whose
   * source has been removed: its sidecars are still readable through storage,
   * but nothing can be read out of the video.
   */
  it("still times against another sidecar once the source is removed", async () => {
    const { service } = harness();
    expect((await service.sync(request)).outcome).toBe("applied");
  });

  it("says why it cannot listen to a source that has been removed", async () => {
    const { service, written } = harness();
    expect(
      await service.sync({
        ...request,
        reference: { kind: "audio", streamIndex: 1 },
      }),
    ).toMatchObject({ outcome: "refused", failure: "source-removed" });
    expect(
      await service.sync({
        ...request,
        reference: { kind: "subtitle", streamIndex: 3 },
      }),
    ).toMatchObject({ outcome: "refused", failure: "source-removed" });
    expect(written.size).toBe(0);
  });

  it("refuses when the media file is gone", async () => {
    const { service } = harness();
    const gone = createSubtitleSyncService({
      libraryRoot: "/library",
      ffmpegPath: "ffmpeg",
      catalogue: {
        getFileById: async () =>
          ({ id: MEDIA_FILE_ID, missingSince: new Date() }) as MediaFileRow,
        listStreams: async () => STREAMS,
      },
      repository: {
        mediaFileRelativePath: async () => RELATIVE_MEDIA,
        recordRetiming: vi.fn(async () => {}),
      },
      storageFactory: () => ({}) as SubtitleStorage,
    });
    void service;
    expect((await gone.sync(request)).outcome).toBe("refused");
  });
});
