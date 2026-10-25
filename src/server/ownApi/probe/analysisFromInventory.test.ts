import { expect, it } from "vitest";
import { buildAnalysisFromInventory } from "./analysisFromInventory";
import type {
  MediaFileRow,
  MediaStreamRow,
} from "../catalogue/catalogueRepository";
it("keeps the mutable-sidecar flag through playback analysis", () => {
  const analysis = buildAnalysisFromInventory({
    file: {
      id: "file",
      container: "mp4",
      durationMs: "1000",
      bitrateBps: null,
    } as MediaFileRow,
    filePath: "/media/Film.mp4",
    streams: [
      {
        streamIndex: 10000,
        kind: "subtitle",
        codec: "subrip",
        language: "tur",
        title: null,
        isExternal: true,
        isTextSubtitle: true,
        isDefault: false,
        isForced: false,
      } as MediaStreamRow,
    ],
  });
  expect(analysis.subtitleStreams[0]).toMatchObject({
    index: 10000,
    isExternal: true,
    language: "tur",
    isImageBased: false,
  });
});
