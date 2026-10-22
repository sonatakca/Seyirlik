import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  defaultSubtitleStreamIndexes,
  planRetainedSidecarSubtitles,
  planRetainedStreams,
} from "./processor";

function audioTrack(
  overrides: Partial<{
    streamIndex: number;
    codec: string;
    channels: number;
    language: string;
    isDefault: boolean;
    isOriginal: boolean;
    isCommentary: boolean;
    isVisualImpaired: boolean;
  }> = {},
) {
  return {
    streamIndex: 1,
    codec: "aac",
    channels: 2,
    isDefault: false,
    isCommentary: false,
    isVisualImpaired: false,
    isOriginal: false,
    ...overrides,
  } as never;
}

function subtitleTrack(
  overrides: Partial<{
    streamIndex: number;
    codec: string;
    language: string;
    isTextBased: boolean;
    isDefault: boolean;
    isForced: boolean;
    isHearingImpaired: boolean;
    isCommentary: boolean;
  }> = {},
) {
  return {
    streamIndex: 2,
    codec: "subrip",
    isTextBased: true,
    isDefault: false,
    isForced: false,
    isHearingImpaired: false,
    isCommentary: false,
    ...overrides,
  } as never;
}

describe("offline adaptive subtitle selection", () => {
  it("keeps analysis usable when a sidecar is unreadable", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "seyirlik-sidecar-read-"));
    try {
      const source = path.join(root, "Film.mkv");
      await writeFile(source, "source");
      await mkdir(path.join(root, "Film.tur.srt"));
      const [sidecar] = await planRetainedSidecarSubtitles(source);
      expect(sidecar).toMatchObject({ language: "tur" });
      expect(sidecar?.sidecarFingerprint).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps every text subtitle and excludes bitmap streams", () => {
    expect(
      defaultSubtitleStreamIndexes({
        subtitleTracks: [
          {
            streamIndex: 2,
            codec: "subrip",
            isTextBased: true,
            isDefault: true,
            isForced: false,
            isHearingImpaired: false,
            isCommentary: false,
          },
          {
            streamIndex: 4,
            codec: "hdmv_pgs_subtitle",
            isTextBased: false,
            isDefault: false,
            isForced: false,
            isHearingImpaired: false,
            isCommentary: false,
          },
          {
            streamIndex: 6,
            codec: "ass",
            isTextBased: true,
            isDefault: false,
            isForced: true,
            isHearingImpaired: false,
            isCommentary: false,
          },
        ],
      }),
    ).toEqual([2, 6]);
  });
});

/**
 * What an offline library build keeps. These are the real shapes from the
 * library this policy was written against, so each case names the title it came
 * from rather than an invented one.
 */
describe("offline retention policy", () => {
  /** Dune ships two English tracks, 7.1 AAC and 5.1 E-AC3, both flagged default. */
  it("keeps one best track when a title has several in one language", () => {
    const plan = planRetainedStreams({
      audioTracks: [
        audioTrack({
          streamIndex: 1,
          codec: "aac",
          channels: 8,
          language: "eng",
          isDefault: true,
        }),
        audioTrack({
          streamIndex: 2,
          codec: "eac3",
          channels: 6,
          language: "eng",
          isDefault: true,
        }),
      ],
      subtitleTracks: [],
    });

    expect(plan.audioStreamIndexes).toEqual([1]);
  });

  /** Michael carries seventeen subtitle languages; two are worth keeping. */
  it("keeps only English and Turkish subtitles", () => {
    const plan = planRetainedStreams({
      audioTracks: [audioTrack({ language: "eng", isDefault: true })],
      subtitleTracks: [
        subtitleTrack({ streamIndex: 2, language: "dan" }),
        subtitleTrack({ streamIndex: 3, language: "eng" }),
        subtitleTrack({ streamIndex: 4, language: "spa" }),
        subtitleTrack({ streamIndex: 5, language: "tur" }),
        subtitleTrack({ streamIndex: 6, language: "chi" }),
      ],
    });

    expect(plan.subtitleStreamIndexes).toEqual([3, 5]);
  });

  /** Star Wars Episode III carries English, French, German and Italian dubs. */
  it("drops dubs that are not a retained language", () => {
    const plan = planRetainedStreams({
      audioTracks: [
        audioTrack({ streamIndex: 1, language: "eng", isDefault: true }),
        audioTrack({ streamIndex: 2, language: "fra" }),
        audioTrack({ streamIndex: 3, language: "deu" }),
        audioTrack({ streamIndex: 4, language: "ita" }),
      ],
      subtitleTracks: [],
    });

    expect(plan.audioStreamIndexes).toEqual([1]);
  });

  /**
   * The Star Wars remuxes tag their only audio `und`. Dropping it for failing
   * the language list would leave the film silent, which is worse than keeping
   * a track whose language nobody wrote down.
   */
  it("keeps an untagged sole track rather than leaving a title silent", () => {
    const plan = planRetainedStreams({
      audioTracks: [audioTrack({ streamIndex: 1, isDefault: true })],
      subtitleTracks: [],
    });

    expect(plan.audioStreamIndexes).toEqual([1]);
  });

  /** A bitmap track has no WebVTT to extract, so it cannot join the package. */
  it("leaves a kept bitmap subtitle out of the package", () => {
    const plan = planRetainedStreams({
      audioTracks: [audioTrack({ language: "eng", isDefault: true })],
      subtitleTracks: [
        subtitleTrack({
          streamIndex: 3,
          language: "eng",
          codec: "hdmv_pgs_subtitle",
          isTextBased: false,
        }),
        subtitleTrack({ streamIndex: 4, language: "tur" }),
      ],
    });

    expect(plan.subtitleStreamIndexes).toEqual([4]);
  });
});
