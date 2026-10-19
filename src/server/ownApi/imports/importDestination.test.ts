// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  canonicalStem,
  destinationKey,
  fileTargetsFor,
  isRefusal,
  planMediaDestination,
  planSubtitleDestination,
  safeSegment,
  subtitleSuffix,
  titleDirectory,
  withKey,
  type DestinationTarget,
} from "./importDestination";

const DUNE: DestinationTarget = { kind: "movie", title: "Dune", year: 2021 };
const EPISODE: DestinationTarget = {
  kind: "episode",
  title: "House of the Dragon",
  season: 1,
  episode: 1,
  episodeTitle: "The Heirs of the Dragon",
};

function relativeOf(outcome: ReturnType<typeof planMediaDestination>): string {
  if (isRefusal(outcome)) throw new Error(`Refused: ${outcome.detail}`);
  return outcome.relative;
}

describe("the layout the library already uses", () => {
  it("puts a film in its own folder, in the source bucket", () => {
    expect(relativeOf(planMediaDestination(DUNE, "Dune.2021.1080p.mkv"))).toBe(
      "Dune (2021)/src/Dune (2021).mkv",
    );
  });

  it("puts an episode under its series and season", () => {
    expect(
      relativeOf(planMediaDestination(EPISODE, "hotd.s01e01.1080p.mp4")),
    ).toBe(
      "House of the Dragon/Season 1/src/House of the Dragon - S01E01 - The Heirs of the Dragon.mp4",
    );
  });

  it("names an episode by its numbers when there is no episode title", () => {
    const target: DestinationTarget = {
      kind: "episode",
      title: "Ezel",
      season: 1,
      episode: 4,
    };
    expect(relativeOf(planMediaDestination(target, "ezel.mkv"))).toBe(
      "Ezel/Season 1/src/Ezel - S01E04.mkv",
    );
  });

  it("takes the extension from the source and everything else from the target", () => {
    // A badly named download must not get to name a library file.
    expect(
      relativeOf(planMediaDestination(DUNE, "wHaTeVeR--RELEASE-group.XXX.MKV")),
    ).toBe("Dune (2021)/src/Dune (2021).mkv");
  });

  it("keeps a film with no year in a folder of its own", () => {
    const target: DestinationTarget = { kind: "movie", title: "Koyaanisqatsi" };
    expect(titleDirectory(target)).toBe("Koyaanisqatsi");
    expect(canonicalStem(target)).toBe("Koyaanisqatsi");
  });
});

describe("names Windows will actually accept", () => {
  it.each([
    ["a colon", "Alien: Romulus", "Alien Romulus"],
    ["a question mark", "Who Framed Roger Rabbit?", "Who Framed Roger Rabbit"],
    ["a slash", "Face/Off", "FaceOff"],
    ["a backslash", "Either\\Or", "EitherOr"],
    ["an asterisk", "M*A*S*H", "MASH"],
    ["a pipe", "This|That", "ThisThat"],
    ["angle brackets", "<Untitled>", "Untitled"],
    ["a quote", 'The "Burbs', "The Burbs"],
  ])("removes %s", (_name, input, expected) => {
    expect(safeSegment(input)).toBe(expected);
  });

  it("keeps the punctuation a title is allowed to have", () => {
    /*
     * The removal list is exactly what Windows refuses. A character class that
     * swept up apostrophes, commas and brackets would quietly rename half the
     * library.
     */
    expect(safeSegment("Amélie's Café (2001) - Part #1, 100%!")).toBe(
      "Amélie's Café (2001) - Part #1, 100%!",
    );
  });

  it("drops trailing dots and spaces, because Windows drops them silently", () => {
    /*
     * The dangerous part is the silence: `Dune ` and `Dune` become one file, so
     * two plans that look different resolve to the same destination.
     */
    expect(safeSegment("Dune ")).toBe("Dune");
    expect(safeSegment("Dune.")).toBe("Dune");
    expect(safeSegment("Dune . . ")).toBe("Dune");
  });

  it.each(["CON", "con", "PRN", "AUX", "NUL", "COM1", "COM9", "LPT1", "lpt9"])(
    "escapes the reserved device name %s",
    (name) => {
      // `CON.mkv` is not a file on Windows, it is the console.
      expect(safeSegment(name)).toBe(`_${name}`);
      expect(safeSegment(`${name}.mkv`)).toBe(`_${name}.mkv`);
    },
  );

  it("leaves a name that merely starts like a device alone", () => {
    expect(safeSegment("Contact")).toBe("Contact");
    expect(safeSegment("Nullify")).toBe("Nullify");
    expect(safeSegment("Communion")).toBe("Communion");
  });

  it("composes Unicode so one name cannot be written two ways", () => {
    const decomposed = "Ame\u0301lie";
    const composed = "Am\u00e9lie";
    expect(safeSegment(decomposed)).toBe(safeSegment(composed));
    expect(safeSegment(decomposed).length).toBe(composed.length);
  });

  it("keeps non-Latin titles intact", () => {
    expect(safeSegment("千と千尋の神隠し")).toBe("千と千尋の神隠し");
    expect(safeSegment("Ölüm ve Bahar")).toBe("Ölüm ve Bahar");
  });

  it("collapses runs of whitespace rather than preserving them", () => {
    expect(safeSegment("Dune    Part   Two")).toBe("Dune Part Two");
  });

  it("refuses a name that sanitises away to nothing", () => {
    const target: DestinationTarget = { kind: "movie", title: "??:*" };
    const outcome = planMediaDestination(target, "x.mkv");
    expect(isRefusal(outcome)).toBe(true);
  });

  it("refuses a source with no usable extension", () => {
    expect(isRefusal(planMediaDestination(DUNE, "no-extension"))).toBe(true);
  });
});

describe("paths a filesystem will accept as a whole", () => {
  it("refuses a destination longer than it will write", () => {
    /*
     * Windows' classic limit is 260 characters for the absolute path, and long
     * path support is neither universal nor something an import should rely on.
     */
    const target: DestinationTarget = {
      kind: "movie",
      title: "A".repeat(179),
      year: 2021,
    };
    const outcome = planMediaDestination(target, "x.mkv");
    expect(isRefusal(outcome)).toBe(true);
    if (isRefusal(outcome)) {
      expect(outcome.problem).toBe("name-unrepresentable");
      expect(outcome.detail).toMatch(/characters/);
    }
  });

  it("caps a single segment rather than producing an unwritable name", () => {
    expect(safeSegment("B".repeat(400)).length).toBeLessThanOrEqual(180);
  });

  it("never emits a backslash, whatever the platform", () => {
    // Destinations are stored `/`-separated so one string means the same thing
    // on either host.
    const relative = relativeOf(planMediaDestination(EPISODE, "x.mkv"));
    expect(relative).not.toContain("\\");
  });
});

describe("a subtitle beside its media", () => {
  it("shares the media's stem so a player finds it", () => {
    expect(relativeOf(planSubtitleDestination(DUNE, "Dune.2021.en.srt"))).toBe(
      "Dune (2021)/src/Dune (2021).en.srt",
    );
  });

  it("keeps a forced or hearing-impaired marker", () => {
    expect(subtitleSuffix("Movie.tr.forced.srt")).toBe("tr.forced");
    expect(subtitleSuffix("Movie.en.sdh.srt")).toBe("en.sdh");
  });

  it("reads the language out of a release's numbered subtitle folder", () => {
    // `2_English.srt` is what sits inside a release's `Subs` folder; the
    // ordinal is the release's own and is not a fact worth carrying.
    expect(subtitleSuffix("2_English.srt")).toBe("english");
    expect(subtitleSuffix("3_Turkish.srt")).toBe("turkish");
    expect(relativeOf(planSubtitleDestination(DUNE, "2_English.srt"))).toBe(
      "Dune (2021)/src/Dune (2021).english.srt",
    );
  });

  it("invents nothing when the name says nothing", () => {
    expect(subtitleSuffix("subtitle.srt")).toBe("");
    expect(relativeOf(planSubtitleDestination(DUNE, "subtitle.srt"))).toBe(
      "Dune (2021)/src/Dune (2021).srt",
    );
  });

  it("gives two languages two destinations", () => {
    const english = relativeOf(planSubtitleDestination(DUNE, "2_English.srt"));
    const turkish = relativeOf(planSubtitleDestination(DUNE, "3_Turkish.srt"));
    expect(english).not.toBe(turkish);
  });
});

describe("the identity a destination is held by", () => {
  it("folds case, because the library filesystem does", () => {
    expect(
      destinationKey("C:\\Library", "Dune (2021)/src/Dune (2021).mkv"),
    ).toBe(destinationKey("C:\\Library", "DUNE (2021)/SRC/DUNE (2021).MKV"));
  });

  it("normalises separators so either host plans the same key", () => {
    expect(destinationKey("C:\\Library", "Dune/src/a.mkv")).toBe(
      destinationKey("C:/Library/", "Dune/src/a.mkv"),
    );
  });

  it("includes the library root, because two libraries may share a path", () => {
    expect(destinationKey("C:\\LibraryA", "Dune/src/a.mkv")).not.toBe(
      destinationKey("C:\\LibraryB", "Dune/src/a.mkv"),
    );
  });

  it("composes Unicode so one destination has one key", () => {
    expect(destinationKey("C:\\L", "Ame\u0301lie/src/a.mkv")).toBe(
      destinationKey("C:\\L", "Am\u00e9lie/src/a.mkv"),
    );
  });

  it("attaches the key to a planned destination", () => {
    const outcome = withKey(
      "C:\\Library",
      planMediaDestination(DUNE, "Dune.mkv"),
    );
    expect(isRefusal(outcome)).toBe(false);
    if (!isRefusal(outcome)) {
      expect(outcome.key).toBe("c:/library/dune (2021)/src/dune (2021).mkv");
    }
  });

  it("passes a refusal through untouched", () => {
    const outcome = withKey(
      "C:\\Library",
      planMediaDestination({ kind: "movie", title: "***" }, "x.mkv"),
    );
    expect(isRefusal(outcome)).toBe(true);
  });
});

describe("a season pack, explored file by file", () => {
  const SEASON: DestinationTarget = {
    kind: "season",
    title: "Lilyhammer",
    year: 2012,
    season: 1,
  };

  function file(relative: string) {
    return { relative, role: relative.endsWith(".srt") ? "subtitle" : "media" };
  }

  function explore(paths: string[]) {
    const files = paths.map(file);
    const outcome = fileTargetsFor(
      SEASON,
      files.filter((entry) => entry.role === "media"),
      files.filter((entry) => entry.role === "subtitle"),
    );
    if (isRefusal(outcome)) throw new Error(`Refused: ${outcome.detail}`);
    return {
      placed: outcome.files.map(({ file: entry, target }) => {
        const name = entry.relative.split("/").at(-1)!;
        return relativeOf(
          entry.role === "subtitle"
            ? planSubtitleDestination(target, name)
            : planMediaDestination(target, name),
        );
      }),
      leftBehind: outcome.leftBehind.map((entry) => entry.relative),
    };
  }

  it("names each episode of a flat pack by its own name", () => {
    expect(
      explore([
        "Lilyhammer.S01.WEBRip.EAC3.5.1.1080p.x265-iVy/Lilyhammer.S01E03.WEBRip.EAC3.5.1.1080p.x265-iVy.mkv",
      ]).placed,
    ).toEqual(["Lilyhammer/Season 1/src/Lilyhammer - S01E03.mkv"]);
  });

  it("reads the episode from the folder when the file is obfuscated", () => {
    expect(
      explore(["pack/Lilyhammer.S01E04.1080p/a8f3c1d9e2.mkv"]).placed,
    ).toEqual(["Lilyhammer/Season 1/src/Lilyhammer - S01E04.mkv"]);
  });

  it("takes a file named only by its number at its word", () => {
    expect(explore(["Lilyhammer Season 1/05 - Tommy.mkv"]).placed).toEqual([
      "Lilyhammer/Season 1/src/Lilyhammer - S01E05.mkv",
    ]);
  });

  it("never reads a subtitle's track number as its episode", () => {
    const explored = explore([
      "pack/Lilyhammer.S01E02.mkv",
      "pack/Subs/2_English.srt",
    ]);
    expect(explored.leftBehind).toEqual(["pack/Subs/2_English.srt"]);
  });

  it("files a subtitle with the episode its folder names", () => {
    expect(
      explore([
        "pack/Lilyhammer.S01E05.mkv",
        "pack/Subs/Lilyhammer.S01E05.WEBRip.x265-iVy/2_English.srt",
      ]).placed,
    ).toEqual([
      "Lilyhammer/Season 1/src/Lilyhammer - S01E05.mkv",
      "Lilyhammer/Season 1/src/Lilyhammer - S01E05.english.srt",
    ]);
  });

  it("keeps a two-episode file's whole run in its name", () => {
    expect(explore(["pack/Lilyhammer.S01E07E08.1080p.mkv"]).placed).toEqual([
      "Lilyhammer/Season 1/src/Lilyhammer - S01E07-E08.mkv",
    ]);
  });

  it("leaves behind extras, other seasons and orphaned subtitles", () => {
    const explored = explore([
      "pack/Lilyhammer.S01E01.mkv",
      "pack/Making of Lilyhammer.mkv",
      "pack/Lilyhammer.S02E01.mkv",
      "pack/Subs/Lilyhammer.S01E09/2_English.srt",
    ]);
    expect(explored.placed).toEqual([
      "Lilyhammer/Season 1/src/Lilyhammer - S01E01.mkv",
    ]);
    expect(explored.leftBehind).toEqual([
      "pack/Making of Lilyhammer.mkv",
      "pack/Lilyhammer.S02E01.mkv",
      "pack/Subs/Lilyhammer.S01E09/2_English.srt",
    ]);
  });

  it("refuses a pack with no episode of the season in it", () => {
    const outcome = fileTargetsFor(
      SEASON,
      [file("pack/Lilyhammer.S02E01.mkv"), file("pack/Making of.mkv")],
      [],
    );
    expect(isRefusal(outcome) && outcome.detail).toMatch(/season 1/);
  });

  it("leaves a film's or an episode's target as it is", () => {
    const outcome = fileTargetsFor(EPISODE, [file("x/at.all.S09E09.mkv")], []);
    expect(!isRefusal(outcome) && outcome.files[0]!.target).toBe(EPISODE);
  });
});
