import { describe, expect, it } from "vitest";
import {
  discoverSidecarSubtitles,
  parseSidecarSubtitleTags,
  SIDECAR_STREAM_INDEX_BASE,
} from "./sidecarSubtitles";

/**
 * Every filename here is one that actually appears in the library this was
 * written for, because the parsing only has to survive the shapes real
 * subtitles arrive in.
 */
describe("reading a sidecar subtitle's filename", () => {
  it.each([
    "The.Wolf.of.Wall.Street.2013.LAMA-tr-synced.srt",
    "The.Wolf.of.Wall.Street.2013.LAMA_tr_synced.srt",
    "The.Wolf.of.Wall.Street.2013.LAMA.tr-TR.synced.srt",
  ])("recognises Turkish in release-style tags: %s", (fileName) => {
    expect(
      parseSidecarSubtitleTags(
        fileName,
        "The.Wolf.of.Wall.Street.2013.2160p.UHD.BluRay.x265.10bit.HDR.DDP5.1-LAMA",
      ),
    ).toEqual({ language: "tur", isForced: false, isHearingImpaired: false });
  });

  it("does not mistake a release token for a language", () => {
    expect(parseSidecarSubtitleTags("Film.HDR.srt", "Film").language).toBe(
      "und",
    );
  });

  it("reads the language from the tag after the title", () => {
    expect(
      parseSidecarSubtitleTags(
        "Gladiator (2000) [98].tr.srt",
        "Gladiator (2000) [98]",
      ),
    ).toEqual({ language: "tur", isForced: false, isHearingImpaired: false });
  });

  it("reads a hearing-impaired tag alongside the language", () => {
    expect(
      parseSidecarSubtitleTags(
        "Dune (2021) [438631].tr.hi.srt",
        "Dune (2021) [438631]",
      ),
    ).toEqual({ language: "tur", isForced: false, isHearingImpaired: true });
  });

  it("accepts the three-letter language code too", () => {
    expect(
      parseSidecarSubtitleTags(
        "Star.Wars.Episode.IX.2019.2160p-[YTS.MX].tur.srt",
        "Star Wars - The Rise of Skywalker (2019) [181812]",
      ).language,
    ).toBe("tur");
  });

  /**
   * The title is not a description of the subtitle. A year in parentheses and a
   * bracketed provider id would both be read as tags if the stem were not
   * removed first.
   */
  it("does not read tags out of the title itself", () => {
    expect(
      parseSidecarSubtitleTags(
        "A Fistful of Dollars (1964) [391].tr.srt",
        "A Fistful of Dollars (1964) [391]",
      ),
    ).toEqual({ language: "tur", isForced: false, isHearingImpaired: false });
  });

  it("marks a forced track", () => {
    expect(
      parseSidecarSubtitleTags("Film.en.forced.srt", "Film").isForced,
    ).toBe(true);
  });

  it("reports no language rather than guessing one", () => {
    expect(parseSidecarSubtitleTags("Film.srt", "Film").language).toBe("und");
  });

  /** A disambiguating number is not a language. */
  it("ignores a numeric tag", () => {
    expect(
      parseSidecarSubtitleTags("Film [1895].en.2.srt", "Film [1895]"),
    ).toEqual({ language: "eng", isForced: false, isHearingImpaired: false });
  });
});

describe("finding the sidecars beside a source", () => {
  const listing = [
    "Dune (2021) [438631].mp4",
    "Dune (2021) [438631].tr.hi.srt",
    "Dune (2021) [438631].en.srt",
    "._Dune (2021) [438631].tr.hi.srt",
    "movie.nfo",
    "folder.jpg",
  ];

  it("keeps only subtitle files and skips AppleDouble companions", async () => {
    const found = await discoverSidecarSubtitles(
      "/media/Dune (2021)/Dune (2021) [438631].mp4",
      { readDirectory: (async () => listing) as never },
    );

    expect(found.map((entry) => entry.fileName)).toEqual([
      "Dune (2021) [438631].en.srt",
      "Dune (2021) [438631].tr.hi.srt",
    ]);
    expect(found.map((entry) => entry.language)).toEqual(["eng", "tur"]);
    expect(found[1]?.isHearingImpaired).toBe(true);
  });

  /**
   * A sidecar id has to be `subtitle-<index>` like any other, so the indexes
   * start above anything a container would plausibly contain.
   */
  it("gives each sidecar a synthetic index that cannot hit a real stream", async () => {
    const found = await discoverSidecarSubtitles(
      "/media/Dune (2021)/Dune (2021) [438631].mp4",
      { readDirectory: (async () => listing) as never },
    );

    expect(found.map((entry) => entry.streamIndex)).toEqual([
      SIDECAR_STREAM_INDEX_BASE,
      SIDECAR_STREAM_INDEX_BASE + 1,
    ]);
  });

  it("survives a directory it cannot read", async () => {
    await expect(
      discoverSidecarSubtitles("/media/Gone/Gone.mp4", {
        readDirectory: (async () => {
          throw new Error("ENOENT");
        }) as never,
      }),
    ).resolves.toEqual([]);
  });
});

/**
 * The folder that holds ten titles rather than one.
 *
 * The permissive rule — every subtitle in the folder belongs to the video in it
 * — is right for a movie folder and wrong for a season folder, where it gave
 * each episode all ten episodes' translations as if they were alternate tracks
 * of its own.
 */
describe("sidecars in a folder shared by several sources", () => {
  const season = [
    "House of the Dragon - S01E01 - The Heirs of the Dragon.mp4",
    "House of the Dragon - S01E01 - The Heirs of the Dragon.tr.srt",
    "House of the Dragon - S01E02 - The Rogue Prince.mp4",
    "House of the Dragon - S01E02 - The Rogue Prince.tr.srt",
    "House of the Dragon - S01E03 - Second of His Name.mp4",
    "House of the Dragon - S01E03 - Second of His Name.tr.srt",
    "season.nfo",
  ];

  it("takes only the subtitles named for the source", async () => {
    const found = await discoverSidecarSubtitles(
      "/media/Series/House of the Dragon/Season 1/House of the Dragon - S01E02 - The Rogue Prince.mp4",
      { readDirectory: (async () => season) as never },
    );

    expect(found.map((entry) => entry.fileName)).toEqual([
      "House of the Dragon - S01E02 - The Rogue Prince.tr.srt",
    ]);
  });

  it("gives an episode with no sidecar of its own none, rather than its neighbours'", async () => {
    const found = await discoverSidecarSubtitles(
      "/media/Series/House of the Dragon/Season 1/House of the Dragon - S01E04 - King of the Narrow Sea.mp4",
      {
        readDirectory: (async () => [
          ...season,
          "House of the Dragon - S01E04 - King of the Narrow Sea.mp4",
        ]) as never,
      },
    );

    expect(found).toEqual([]);
  });

  /*
   * The behaviour the permissive rule exists for, which the season case must not
   * cost: one film and a translation named after a different release.
   */
  it("still takes a differently named subtitle when the folder holds one video", async () => {
    const found = await discoverSidecarSubtitles(
      "/media/Movies/Dune (2021)/Dune (2021) [438631].mp4",
      {
        readDirectory: (async () => [
          "Dune (2021) [438631].mp4",
          "Dune.2021.2160p.WEB-DL.tr.srt",
        ]) as never,
      },
    );

    expect(found.map((entry) => entry.fileName)).toEqual([
      "Dune.2021.2160p.WEB-DL.tr.srt",
    ]);
  });

  /*
   * A season whose sources have all been removed once their packages were
   * whole: only the sidecars are left, so the folder looks like it holds no
   * title at all, and the one-video rule would give every episode all of them.
   */
  it("matches by name when the source itself has been removed", async () => {
    const found = await discoverSidecarSubtitles(
      "/media/Series/House of the Dragon/Season 1/src/House of the Dragon - S01E02 - The Rogue Prince.mp4",
      {
        readDirectory: (async () =>
          season.filter((name) => name.endsWith(".srt"))) as never,
      },
    );

    expect(found.map((entry) => entry.fileName)).toEqual([
      "House of the Dragon - S01E02 - The Rogue Prince.tr.srt",
    ]);
  });
});
