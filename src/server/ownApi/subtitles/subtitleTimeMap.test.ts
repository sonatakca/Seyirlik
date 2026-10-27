import { describe, expect, it } from "vitest";
import type { CueDisposition } from "./piecewiseAlignment";
import {
  documentCues,
  parseSubtitleDocument,
  serialiseSubtitleDocument,
} from "./subtitleCues";
import { applyPlacements, canApplyUnreviewed } from "./subtitleTimeMap";

const VTT = [
  "WEBVTT",
  "",
  "STYLE",
  "::cue { color: yellow }",
  "",
  "NOTE çevirmen: Ayşe",
  "",
  "one",
  "00:00:01.000 --> 00:00:03.000 line:90%",
  "<i>Birinci</i>",
  "",
  "two",
  "00:00:10.000 --> 00:00:12.000",
  "İkinci",
  "",
  "three",
  "00:00:20.000 --> 00:00:22.500",
  "Üçüncü",
  "",
].join("\n");

const place = (
  disposition: CueDisposition[],
  shift: (index: number) => number,
) => {
  const cues = documentCues(parseSubtitleDocument(VTT));
  return cues.map((cue, index) => ({
    index,
    disposition: disposition[index] as CueDisposition,
    startSeconds: cue.startSeconds + shift(index),
    endSeconds: cue.endSeconds + shift(index),
  }));
};

describe("applyPlacements", () => {
  it("moves only the cues the alignment moved and keeps everything else byte for byte", () => {
    const document = parseSubtitleDocument(VTT);
    const report = applyPlacements(
      document,
      place(["aligned", "corrected", "corrected"], (index) =>
        index === 0 ? 0 : -2.5,
      ),
      { unmatched: "keep" },
    );
    const out = serialiseSubtitleDocument({
      ...document,
      blocks: report.blocks,
    });
    expect(out).toContain("STYLE\n::cue { color: yellow }");
    expect(out).toContain("NOTE çevirmen: Ayşe");
    expect(out).toContain(
      "00:00:01.000 --> 00:00:03.000 line:90%\n<i>Birinci</i>",
    );
    expect(out).toContain("00:00:07.500 --> 00:00:09.500\nİkinci");
    expect(out).toContain("00:00:17.500 --> 00:00:20.000\nÜçüncü");
    expect(report.moved).toBe(2);
  });

  it("leaves unresolved cues exactly where they were", () => {
    const document = parseSubtitleDocument(VTT);
    const report = applyPlacements(
      document,
      place(["corrected", "unresolved", "corrected"], () => 4),
      { unmatched: "keep" },
    );
    const cues = report.blocks.filter((block) => block.kind === "cue");
    expect(
      cues.map((cue) => (cue as { startSeconds: number }).startSeconds),
    ).toEqual([5, 10, 24]);
  });

  it("keeps an unmatched line unless asked to exclude it, and names it when excluded", () => {
    const document = parseSubtitleDocument(VTT);
    const placements = place(["aligned", "unmatched", "corrected"], (index) =>
      index === 2 ? -9 : 0,
    );
    const kept = applyPlacements(document, placements, { unmatched: "keep" });
    expect(kept.blocks.filter((block) => block.kind === "cue")).toHaveLength(3);
    expect(kept.excluded).toEqual([]);

    const excluded = applyPlacements(document, placements, {
      unmatched: "exclude",
    });
    expect(
      excluded.blocks.filter((block) => block.kind === "cue"),
    ).toHaveLength(2);
    expect(excluded.excluded).toEqual([1]);
    expect(canApplyUnreviewed({ autoApplicable: true }, excluded)).toBe(false);
  });

  it("ends a moved cue where the next begins rather than overlapping it", () => {
    const document = parseSubtitleDocument(VTT);
    // The second line moves late enough to run into the third, which stays.
    const report = applyPlacements(
      document,
      place(["aligned", "corrected", "aligned"], (index) =>
        index === 1 ? 9 : 0,
      ),
      { unmatched: "keep" },
    );
    const second = report.blocks.filter((block) => block.kind === "cue")[1] as {
      startSeconds: number;
      endSeconds: number;
    };
    expect(second.startSeconds).toBe(19);
    expect(second.endSeconds).toBe(20);
    expect(report.trimmed).toBe(1);
  });

  it("leaves out a line pushed entirely before the media and refuses to call that unreviewed-safe", () => {
    const document = parseSubtitleDocument(VTT);
    const report = applyPlacements(
      document,
      place(["corrected", "corrected", "corrected"], () => -5),
      { unmatched: "keep" },
    );
    expect(report.beforeMedia).toEqual([0]);
    expect(canApplyUnreviewed({ autoApplicable: true }, report)).toBe(false);
  });

  it("refuses an alignment computed for a different version of the file", () => {
    const document = parseSubtitleDocument(VTT);
    expect(() =>
      applyPlacements(
        document,
        place(["aligned", "aligned", "aligned"], () => 0).slice(0, 2),
        {
          unmatched: "keep",
        },
      ),
    ).toThrow(/different version/);
  });
});
