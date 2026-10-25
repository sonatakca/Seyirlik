import { describe, expect, it } from "vitest";
import { streamLabels } from "./streamLabels";
import { translations } from "../../i18n/translations";
import type { MediaStream } from "../../lib/types";
const label = (
  streams: MediaStream[],
  type: "audio" | "subtitle" = "audio",
  language: "en" | "tr" = "en",
) =>
  streamLabels(streams, type, language, (key) => translations[language][key]);

describe("viewer track names", () => {
  it("names the screenshot's audio tracks without repeated source metadata", () => {
    expect(
      label([
        {
          Language: "eng",
          Title: "TrueHD 5.1 eng",
          DisplayTitle: "TrueHD 5.1",
          Codec: "truehd",
          Channels: 6,
        },
        { Language: "eng", Title: "AC-3 5.1 eng", Codec: "ac3", Channels: 6 },
        { Language: "por", Title: "Português por", Codec: "eac3" },
      ]),
    ).toEqual([
      "English · Surround 5.1",
      "English · Surround 5.1 (2)",
      "Portuguese",
    ]);
  });
  it("keeps subtitle purposes but hides file formats and storage details", () => {
    expect(
      label(
        [
          { Language: "eng", Title: "English", Codec: "hdmv_pgs_subtitle" },
          {
            Language: "eng",
            Title: "English (SDH)",
            Codec: "hdmv_pgs_subtitle",
          },
          { Language: "eng", Title: "English (SRT)", Codec: "subrip" },
          { Language: "eng", Title: "English (SRT) (SDH)", Codec: "subrip" },
          { Language: "tur", IsExternal: true, Codec: "subrip" },
          { Language: "tur", Codec: "webvtt", IsForced: true },
        ],
        "subtitle",
      ),
    ).toEqual([
      "English",
      "English · Hearing impaired",
      "English (2)",
      "English · Hearing impaired (2)",
      "Turkish",
      "Turkish · Foreign dialogue only",
    ]);
  });
  it("localizes language names and useful descriptions in Turkish", () => {
    expect(
      label(
        [
          { Language: "en-US", Channels: 2, Title: "Audio description" },
          { Language: "tur", Title: "Director commentary", Channels: 1 },
        ],
        "audio",
        "tr",
      ),
    ).toEqual([
      "İngilizce · Sesli betimleme · Stereo",
      "Türkçe · Yorum · Mono",
    ]);
  });
  it("uses numbered fallback names for absent or unusable language tags", () => {
    expect(
      label([{ Title: "AAC" }, { Language: "und" }, { Language: "???" }]),
    ).toEqual(["Audio track 1", "Audio track 2", "Audio track 3"]);
  });
  it("normalizes common three-letter aliases", () => {
    expect(
      label([{ Language: "fre" }, { Language: "ger" }, { Language: "pt_BR" }]),
    ).toEqual(["French", "German", "Portuguese"]);
  });
});
