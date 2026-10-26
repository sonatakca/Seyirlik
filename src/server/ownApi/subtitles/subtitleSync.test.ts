import { describe, expect, it, vi } from "vitest";
import type {
  MediaFileRow,
  MediaStreamRow,
} from "../catalogue/catalogueRepository";
import { compareCues, createSubtitleSyncService } from "./subtitleSync";
import {
  documentCues,
  parseSubtitleDocument,
  serialiseSubtitleDocument,
} from "./subtitleCues";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TitleReferences } from "./subtitleReferences";
import type { SubtitleStorage } from "./subtitleStorage";
import { subtitleDigest } from "./subtitleStorage";
import {
  ffmpegAvailable,
  writeSpacedAudioPackage,
} from "./packagedAudioTestFixture";
import { memoryRevisionStore } from "./revisionStoreFixture";

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
  references?: TitleReferences,
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
  const onFilesChanged = vi.fn(async () => {});
  const revisions = memoryRevisionStore();
  const service = createSubtitleSyncService({
    onFilesChanged,
    revisions,
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
    ...(references ? { references } : {}),
  });
  return {
    service,
    storage,
    written,
    recordRetiming,
    files,
    onFilesChanged,
    revisions,
  };
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

  it("requests a library refresh only after a successful correction", async () => {
    const { service, onFilesChanged } = harness();
    await service.sync({ ...request, dryRun: true });
    expect(onFilesChanged).not.toHaveBeenCalled();
    await service.sync({
      ...request,
      transform: { offsetSeconds: -5, rate: 1 },
    });
    expect(onFilesChanged).toHaveBeenCalledWith(TURKISH);
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

  it("times against the package's copy of a subtitle that was inside the removed source", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "seyirlik-sync-"));
    const packaged = path.join(dir, "subtitle-3.vtt");
    await writeFile(packaged, cues(400, 0, "vtt"));
    const references: TitleReferences = {
      audio: vi.fn(async () => null),
      embeddedSubtitles: vi.fn(async () => [
        { streamIndex: 3, language: "spa", path: packaged },
      ]),
    };
    const { service, written } = harness(undefined, references);
    const result = await service.sync({
      ...request,
      reference: { kind: "subtitle", streamIndex: 3 },
    });
    expect(result.outcome).toBe("applied");
    expect(written.get(TURKISH)).toContain("00:00:30,000 -->");
  });

  it("asks the package for the audio track it was asked to listen to", async () => {
    const references: TitleReferences = {
      audio: vi.fn(async () => null),
      embeddedSubtitles: vi.fn(async () => []),
    };
    const { service } = harness(undefined, references);
    expect(
      await service.sync({
        ...request,
        reference: { kind: "audio", streamIndex: 1 },
      }),
    ).toMatchObject({ outcome: "refused", failure: "source-removed" });
    expect(references.audio).toHaveBeenCalledWith({
      mediaFileId: MEDIA_FILE_ID,
      relativePath: RELATIVE_MEDIA,
      sourceStreamIndex: 1,
    });
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
      revisions: memoryRevisionStore(),
      storageFactory: () => ({}) as SubtitleStorage,
    });
    void service;
    expect((await gone.sync(request)).outcome).toBe("refused");
  });
});

/** A subtitle whose lines after `from` seconds run `by` seconds late. */
function lateAfter(text: string, from: number, by: number): string {
  const document = parseSubtitleDocument(text);
  return serialiseSubtitleDocument({
    ...document,
    blocks: document.blocks.map((block) =>
      block.kind === "cue" && block.startSeconds >= from
        ? {
            ...block,
            startSeconds: block.startSeconds + by,
            endSeconds: block.endSeconds + by,
          }
        : block,
    ),
  });
}

describe("sync — regions, review and history", () => {
  it("corrects only the half that is late, and keeps the first half's bytes as they were", async () => {
    const english = cues(400);
    const turkish = lateAfter(english, 700, 8);
    const { service, files } = harness({
      [ENGLISH]: english,
      [TURKISH]: turkish,
    });

    const result = await service.sync(request);

    expect(result.outcome).toBe("applied");
    if (result.outcome !== "applied") return;
    expect(result.alignment?.verdict).toBe("correctable");
    const corrected = files[TURKISH] as string;
    // Every line now starts where the reference's does.
    const starts = (text: string) =>
      documentCues(parseSubtitleDocument(text)).map((cue) => cue.startSeconds);
    const want = starts(english);
    starts(corrected).forEach((start, index) =>
      expect(Math.abs(start - (want[index] as number))).toBeLessThan(0.01),
    );
    // And the early half is byte-for-byte what it was.
    const early = turkish.slice(0, turkish.indexOf("00:11:"));
    expect(corrected.startsWith(early)).toBe(true);
  });

  it("keeps the original in the history and points the new version at it", async () => {
    const { service, revisions } = harness();
    const result = await service.sync(request);
    expect(result.outcome).toBe("applied");
    const history = await revisions.list(MEDIA_FILE_ID, TURKISH);
    expect(
      history.map((revision) => [revision.origin, revision.state]),
    ).toEqual([
      ["sync", "committed"],
      ["original", "committed"],
    ]);
    expect(
      new TextDecoder().decode((await revisions.get(history[1]!.id))!.content),
    ).toBe(cues(400, 14.5));
  });

  it("writes nothing it cannot place and says what a person should look at", async () => {
    // The reference stops a third of the way in: the rest cannot be placed.
    const english = cues(400);
    const partial = english.slice(0, english.indexOf("\n\n131\n") + 1);
    const { service, written } = harness({
      [ENGLISH]: partial,
      [TURKISH]: lateAfter(english, 300, 6),
    });

    const result = await service.sync(request);

    expect(result.outcome).toBe("analysed");
    if (result.outcome !== "analysed") return;
    expect(result.needsReview).toBe(true);
    expect(result.reviewReasons.join(" ")).toMatch(/could not be placed/);
    expect(written.size).toBe(0);
  });

  it("applies a reviewed proposal exactly as it was reviewed", async () => {
    const english = cues(400);
    const { service, files } = harness({
      [ENGLISH]: english.slice(0, english.indexOf("\n\n131\n") + 1),
      [TURKISH]: lateAfter(english, 300, 6),
    });
    const preview = await service.sync({ ...request, dryRun: true });
    if (preview.outcome !== "analysed" || !preview.alignment)
      throw new Error("no preview");

    const applied = await service.sync({
      ...request,
      reviewed: {
        subtitleSha256: preview.subtitleSha256,
        placements: preview.alignment.cues,
        unmatched: "keep",
        previewTaskId: "11111111-0000-0000-0000-000000000000",
        verdict: preview.alignment.verdict,
      },
    });

    expect(applied.outcome).toBe("applied");
    const after = documentCues(parseSubtitleDocument(files[TURKISH] as string));
    preview.alignment.cues.forEach((cue) => {
      expect(after[cue.index]?.startSeconds).toBeCloseTo(cue.startSeconds, 3);
    });
  });

  it("refuses a reviewed proposal once the subtitle has changed underneath it", async () => {
    const { service, files, written } = harness();
    const preview = await service.sync({ ...request, dryRun: true });
    if (preview.outcome !== "analysed" || !preview.alignment)
      throw new Error("no preview");
    files[TURKISH] = cues(400, 3);

    const result = await service.sync({
      ...request,
      reviewed: {
        subtitleSha256: preview.subtitleSha256,
        placements: preview.alignment.cues,
        unmatched: "keep",
        previewTaskId: "11111111-0000-0000-0000-000000000000",
        verdict: preview.alignment.verdict,
      },
    });

    expect(result).toMatchObject({
      outcome: "refused",
      failure: "changed-since-analysis",
    });
    expect(written.size).toBe(0);
  });

  it("puts the original back as a new version, and the history shows both", async () => {
    const { service, files } = harness();
    await service.sync(request);
    const listing = await service.revisions(MEDIA_FILE_ID, 1001);
    const original = listing?.revisions.find(
      (revision) => revision.origin === "original",
    );
    if (!original) throw new Error("no original");

    const restored = await service.restore({
      mediaFileId: MEDIA_FILE_ID,
      targetStreamIndex: 1001,
      revisionId: original.id,
    });

    expect(restored.outcome).toBe("restored");
    expect(files[TURKISH]).toBe(cues(400, 14.5));
    expect(
      (await service.revisions(MEDIA_FILE_ID, 1001))?.revisions.map(
        (revision) => revision.origin,
      ),
    ).toEqual(["restore", "sync", "original"]);
  });

  it("will not restore a version that belongs to another subtitle", async () => {
    const { service, revisions } = harness();
    const stray = await revisions.record({
      mediaFileId: MEDIA_FILE_ID,
      relativePath: ENGLISH,
      origin: "original",
      bytes: new TextEncoder().encode(cues(10)),
    });
    expect(
      await service.restore({
        mediaFileId: MEDIA_FILE_ID,
        targetStreamIndex: 1001,
        revisionId: stray.id,
      }),
    ).toMatchObject({ outcome: "refused", failure: "revision-missing" });
  });
});

describe("compareCues", () => {
  const line = (text: string, startSeconds: number) => ({
    text,
    startSeconds,
    endSeconds: startSeconds + 1,
  });

  it("pairs lines by their words and lists only the ones that moved", () => {
    const result = compareCues(
      [line("a", 1), line("b", 2), line("c", 3)],
      [line("a", 1), line("b", 4), line("c", 5)],
    );
    expect(result.moved.map((cue) => cue.text)).toEqual(["b", "c"]);
    expect(result.removed).toEqual([]);
    expect(result.added).toEqual([]);
  });

  it("names a line left out without unpairing everything after it", () => {
    const result = compareCues(
      [line("a", 1), line("cut", 2), line("b", 3), line("c", 4)],
      [line("a", 1), line("b", 3), line("c", 4)],
    );
    expect(result.removed.map((cue) => cue.text)).toEqual(["cut"]);
    expect(result.moved).toEqual([]);
  });

  it("names a line put back", () => {
    const result = compareCues(
      [line("a", 1), line("b", 3)],
      [line("a", 1), line("back", 2), line("b", 3)],
    );
    expect(result.added.map((cue) => cue.text)).toEqual(["back"]);
  });
});

describe.skipIf(!ffmpegAvailable)(
  "timing against a packaged track whose name has a space in it",
  { timeout: 120_000 },
  () => {
    /*
     * The package's rendition of a kept original track is
     * `english (original)`, reached from its playlist as
     * `english%20(original).m4a`, which FFmpeg could not open.
     */
    it("listens through the package playlist once the source is removed", async () => {
      const pkg = await writeSpacedAudioPackage(cues(120));
      try {
        const { service } = harness(
          { [ENGLISH]: cues(120), [TURKISH]: cues(120, 14.5) },
          {
            audio: async () => ({
              path: pkg.playlistPath,
              streamIndex: 0,
              isPackagePlaylist: true,
            }),
            embeddedSubtitles: async () => [],
          },
        );
        const result = await service.sync({
          ...request,
          reference: { kind: "audio", streamIndex: 1 },
          dryRun: true,
        });
        expect(result.outcome).toBe("analysed");
        if (result.outcome !== "analysed") return;
        expect(result.offsetSeconds).toBeCloseTo(-14.5, 0);
      } finally {
        await rm(pkg.root, { recursive: true, force: true });
      }
    });
  },
);
