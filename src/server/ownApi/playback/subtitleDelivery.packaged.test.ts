import { describe, expect, it } from "vitest";
import type { MediaStreamRow } from "../catalogue/catalogueRepository";
import type { PackagedSubtitle } from "../../renditionService";
import { packagedSubtitleFor, withPackagedSubtitles } from "./subtitleDelivery";

const row = (
  streamIndex: number,
  kind: MediaStreamRow["kind"],
  language: string | null = null,
) => ({ streamIndex, kind, language }) as MediaStreamRow;

const packaged = (
  streamIndex: number,
  language?: string,
): PackagedSubtitle => ({
  streamIndex,
  ...(language ? { language } : {}),
  isDefault: false,
  isForced: false,
  fromSidecar: false,
  path: `/media/Film/subtitle/${streamIndex}.vtt`,
});

describe("subtitles a package carries", () => {
  it("lists every package track for a title whose source is gone", () => {
    const streams = withPackagedSubtitles(
      [],
      [packaged(3, "eng"), packaged(6, "tur")],
    );
    expect(
      streams.map((stream) => [
        stream.streamIndex,
        stream.kind,
        stream.language,
        stream.isTextSubtitle,
      ]),
    ).toEqual([
      [3, "subtitle", "eng", true],
      [6, "subtitle", "tur", true],
    ]);
  });

  it("adds a packaged sidecar the catalogue never recorded, and renames nothing", () => {
    const streams = withPackagedSubtitles(
      [row(0, "video"), row(1, "audio"), row(2, "subtitle", "eng")],
      [packaged(2, "eng"), packaged(1, "tur"), packaged(4, "tur")],
    );
    expect(streams.map((stream) => stream.streamIndex)).toEqual([0, 1, 2, 4]);
    expect(streams.find((s) => s.streamIndex === 1)?.kind).toBe("audio");
  });

  it("serves the package copy only when it is that track", () => {
    const streams = [row(1, "audio"), row(2, "subtitle", "eng")];
    const all = [packaged(1), packaged(2, "eng"), packaged(4, "tur")];
    expect(packagedSubtitleFor(streams, all, 2)?.path).toMatch(/2\.vtt$/);
    expect(packagedSubtitleFor(streams, all, 4)?.path).toMatch(/4\.vtt$/);
    // The index now belongs to an audio stream.
    expect(packagedSubtitleFor(streams, all, 1)).toBeNull();
    // A later sidecar in another language took the index.
    expect(packagedSubtitleFor([row(2, "subtitle", "tur")], all, 2)).toBeNull();
    expect(packagedSubtitleFor(streams, all, 9)).toBeNull();
  });
});
