import { describe, expect, it } from "vitest";
import {
  buildWebVttExtractionArgs,
  buildWebVttMultiExtractionArgs,
  buildWebVttMediaPlaylist,
  formatWebVttTimestamp,
  mergeWebVttCues,
  parseWebVttCues,
  parseWebVttMediaPlaylist,
  parseWebVttTimestamp,
  serialiseWebVttCues,
  shiftWebVttCues,
} from "./subtitles";

describe("adaptive WebVTT packaging", () => {
  it("maps exactly the selected source stream", () => {
    expect(
      buildWebVttExtractionArgs("/source/movie.mkv", 7, "/stage/sub.vtt"),
    ).toEqual([
      "-v",
      "error",
      "-nostdin",
      "-progress",
      "pipe:1",
      "-stats_period",
      "1",
      "-nostats",
      "-y",
      "-i",
      "/source/movie.mkv",
      "-map",
      "0:7",
      "-c:s",
      "webvtt",
      "-f",
      "webvtt",
      "/stage/sub.vtt",
    ]);
  });

  it("builds a complete VOD playlist for arbitrary cue timing", () => {
    const playlist = buildWebVttMediaPlaylist(32.423, "subtitles.vtt");
    expect(parseWebVttMediaPlaylist(playlist)).toEqual({
      durationSeconds: 32.423,
      uri: "subtitles.vtt",
    });
    expect(playlist).toContain("#EXT-X-ENDLIST");
  });

  it("rejects an incomplete subtitle playlist", () => {
    expect(() => parseWebVttMediaPlaylist("#EXTM3U\n")).toThrow(/complete/);
  });
});

/**
 * Subtitles across a hole in the source.
 *
 * The rule is the one the whole salvage design turns on: nothing after a
 * damaged interval moves. Cues whose bytes were inside it are lost — that is
 * recorded in the job's warning — and every cue that survives keeps the
 * timestamp it has on the source's own timeline.
 */
describe("subtitles across an unreadable interval", () => {
  const before = [
    "WEBVTT",
    "",
    "00:49:58.000 --> 00:49:59.500",
    "Before the damage.",
    "",
  ].join("\n");
  const after = [
    "WEBVTT",
    "",
    "00:00:02.000 --> 00:00:04.000",
    "After the damage.",
    "",
  ].join("\n");

  it("reads only the stretch it is given", () => {
    expect(
      buildWebVttExtractionArgs("/source/movie.mkv", 7, "/stage/sub.vtt", {
        startSeconds: 3300.005,
        durationSeconds: 5739.195,
      }),
    ).toEqual([
      "-v",
      "error",
      "-nostdin",
      "-progress",
      "pipe:1",
      "-stats_period",
      "1",
      "-nostats",
      "-y",
      "-ss",
      "3300.005",
      "-t",
      "5739.195",
      "-i",
      "/source/movie.mkv",
      "-map",
      "0:7",
      "-c:s",
      "webvtt",
      "-f",
      "webvtt",
      "/stage/sub.vtt",
    ]);
  });

  it("puts a range's cues back where they belong on the source timeline", () => {
    const cues = shiftWebVttCues(parseWebVttCues(after), 3300.005);
    expect(cues[0]!.startSeconds).toBeCloseTo(3302.005, 3);
    expect(cues[0]!.text).toBe("After the damage.");
  });

  it("does not shift anything after the damaged range", () => {
    /*
     * The failure this guards against: subtracting the hole's length from
     * everything that follows, so a viewer seeking to 01:00:00 finds dialogue
     * from 00:55:00. The merged document must place the later cue at its own
     * time, five minutes of hole and all.
     */
    const merged = mergeWebVttCues([
      parseWebVttCues(before),
      shiftWebVttCues(parseWebVttCues(after), 3300.005),
    ]);
    expect(merged.map((cue) => Math.round(cue.startSeconds))).toEqual([
      2998, 3302,
    ]);
    const text = serialiseWebVttCues(merged);
    expect(text).toContain("00:49:58.000 --> 00:49:59.500");
    expect(text).toContain("00:55:02.005 --> 00:55:04.005");
  });

  it("omits cues whose bytes were inside the hole rather than inventing them", () => {
    const merged = mergeWebVttCues([
      parseWebVttCues(before),
      shiftWebVttCues(parseWebVttCues(after), 3300.005),
    ]);
    expect(merged).toHaveLength(2);
    expect(
      merged.some((cue) => cue.startSeconds > 3000 && cue.startSeconds < 3300),
    ).toBe(false);
  });

  it("keeps one copy of a cue a range boundary cut in two", () => {
    const clipped = mergeWebVttCues([
      parseWebVttCues(
        ["WEBVTT", "", "00:00:09.000 --> 00:00:10.000", "Straddling.", ""].join(
          "\n",
        ),
      ),
      parseWebVttCues(
        ["WEBVTT", "", "00:00:09.500 --> 00:00:12.000", "Straddling.", ""].join(
          "\n",
        ),
      ),
    ]);
    expect(clipped).toHaveLength(1);
    expect(clipped[0]!.startSeconds).toBe(9);
    expect(clipped[0]!.endSeconds).toBe(12);
  });

  it("keeps cue identifiers and positioning settings", () => {
    const cues = parseWebVttCues(
      [
        "WEBVTT",
        "",
        "42",
        "00:00:01.000 --> 00:00:02.000 line:90% align:middle",
        "Positioned.",
        "",
      ].join("\n"),
    );
    expect(cues[0]!.identifier).toBe("42");
    expect(cues[0]!.settings).toBe("line:90% align:middle");
    expect(serialiseWebVttCues(cues)).toContain("line:90% align:middle");
  });

  it("round-trips timestamps without drifting", () => {
    for (const seconds of [0, 1.001, 59.999, 3599.5, 3600, 9039.2]) {
      expect(parseWebVttTimestamp(formatWebVttTimestamp(seconds))).toBeCloseTo(
        seconds,
        3,
      );
    }
  });

  it("ignores anything that is not a cue", () => {
    expect(
      parseWebVttCues(
        [
          "WEBVTT",
          "",
          "NOTE this is a comment",
          "",
          "STYLE",
          "::cue {}",
          "",
        ].join("\n"),
      ),
    ).toEqual([]);
  });
});

describe("buildWebVttMultiExtractionArgs", () => {
  it("reads the input once and writes one WebVTT output per track", () => {
    const args = buildWebVttMultiExtractionArgs(
      "/copies/list.ffconcat",
      [
        { streamIndex: 2, outputPath: "/stage/subtitle-3/subtitles.vtt" },
        { streamIndex: 3, outputPath: "/stage/subtitle-4/subtitles.vtt" },
      ],
      { options: ["-safe", "0", "-itsoffset", "0.021000"], format: "concat" },
    );
    expect(args.filter((arg) => arg === "-i")).toHaveLength(1);
    const input = args.indexOf("-i");
    expect(args.slice(input - 6, input + 2)).toEqual([
      "-safe",
      "0",
      "-itsoffset",
      "0.021000",
      "-f",
      "concat",
      "-i",
      "/copies/list.ffconcat",
    ]);
    expect(args.slice(input + 2)).toEqual([
      "-map",
      "0:2",
      "-c:s",
      "webvtt",
      "-f",
      "webvtt",
      "/stage/subtitle-3/subtitles.vtt",
      "-map",
      "0:3",
      "-c:s",
      "webvtt",
      "-f",
      "webvtt",
      "/stage/subtitle-4/subtitles.vtt",
    ]);
  });
});
