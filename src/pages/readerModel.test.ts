import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MediaItem } from "../lib/types";
import {
  DEFAULT_READER_SETTINGS,
  EPUB_PREPARATION_TIMEOUT_MS,
  EPUB_REQUEST_CREDENTIALS,
  READER_PROGRESS_KEY,
  READER_SETTINGS_KEY,
  getReaderFormat,
  isReaderPlace,
  readReaderProgress,
  readStoredReaderSettings,
  writeReaderProgress,
} from "./reader/readerModel";

describe("readerModel", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useRealTimers();
  });

  it("preserves storage keys, defaults, and setting clamps", () => {
    expect(READER_SETTINGS_KEY).toBe("seyirlik.reader.settings");
    expect(READER_PROGRESS_KEY).toBe("seyirlik.reader.progress");
    expect(EPUB_PREPARATION_TIMEOUT_MS).toBe(15000);
    expect(EPUB_REQUEST_CREDENTIALS).toBe(true);
    expect(readStoredReaderSettings()).toEqual(DEFAULT_READER_SETTINGS);

    localStorage.setItem(
      READER_SETTINGS_KEY,
      JSON.stringify({
        theme: "invalid",
        face: "comic",
        fontScale: 999,
        lineHeight: 0,
        width: 1,
        spotlight: "blinding",
        lightShape: "band",
        paragraphReach: -1,
        lineReach: "wide",
        showRuler: "no",
        showTimeLeft: 0,
      }),
    );
    expect(readStoredReaderSettings()).toEqual({
      theme: "night",
      face: "serif",
      fontScale: 145,
      lineHeight: 1.25,
      width: 48,
      spotlight: "soft",
      lightShape: "line",
      paragraphReach: 0.3,
      lineReach: 0.85,
      showRuler: true,
      showTimeLeft: true,
    });

    // The light can fall on the line, and each shape keeps its own reach.
    localStorage.setItem(
      READER_SETTINGS_KEY,
      JSON.stringify({
        lightShape: "line",
        lineReach: 0.05,
        paragraphReach: 9,
      }),
    );
    expect(readStoredReaderSettings()).toMatchObject({
      lightShape: "line",
      lineReach: 0.05,
      paragraphReach: 1.5,
    });

    // Either margin item can be turned off on its own.
    localStorage.setItem(
      READER_SETTINGS_KEY,
      JSON.stringify({ showRuler: false, showTimeLeft: true }),
    );
    expect(readStoredReaderSettings()).toMatchObject({
      showRuler: false,
      showTimeLeft: true,
    });

    // Settings saved before the reading light and the two new themes existed
    // keep their values and gain the defaults.
    localStorage.setItem(
      READER_SETTINGS_KEY,
      JSON.stringify({
        theme: "sepia",
        fontScale: 110,
        lineHeight: 1.7,
        width: 74,
      }),
    );
    expect(readStoredReaderSettings()).toEqual({
      theme: "sepia",
      face: "serif",
      fontScale: 110,
      lineHeight: 1.7,
      width: 74,
      spotlight: "soft",
      lightShape: "line",
      paragraphReach: 0.3,
      lineReach: 0.85,
      showRuler: true,
      showTimeLeft: true,
    });
  });

  it("preserves format-detection candidate precedence", () => {
    expect(
      getReaderFormat({
        Id: "book",
        Name: "book.pdf",
        Path: "/books/book.txt",
        MediaSources: [{ Container: "epub", Path: "/books/book.html" }],
      } as MediaItem),
    ).toBe("epub");
    expect(
      getReaderFormat({ Id: "image", Name: "cover.JPG?x=1" } as MediaItem),
    ).toBe("image");
    expect(
      getReaderFormat({ Id: "unknown", Name: "README" } as MediaItem),
    ).toBe("fallback");
  });

  it("merges stored progress and updates its timestamp", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-23T09:00:00.000Z"));
    writeReaderProgress("book", { cfi: "epubcfi(/6/2)" });
    writeReaderProgress("book", { scrollRatio: 0.5 });

    expect(readReaderProgress("book")).toEqual({
      cfi: "epubcfi(/6/2)",
      scrollRatio: 0.5,
      updatedAt: 1784797200000,
    });
  });

  it("keeps the exact place, and drops it when a save has none", () => {
    const place = { section: 3, block: 0, offset: -184 };
    writeReaderProgress("book", { cfi: "epubcfi(/6/8)", place });
    expect(readReaderProgress("book")?.place).toEqual(place);
    expect(isReaderPlace(place)).toBe(true);

    // A save with nowhere to anchor must not leave the old place behind.
    writeReaderProgress("book", { cfi: "epubcfi(/6/10)", place: undefined });
    expect(readReaderProgress("book")?.place).toBeUndefined();

    for (const broken of [
      null,
      {},
      { section: -1, block: 0, offset: 0 },
      { section: 1, block: 0.5, offset: 0 },
      { section: 1, block: 2, offset: Number.NaN },
      { section: "1", block: 2, offset: 0 },
    ]) {
      expect(isReaderPlace(broken)).toBe(false);
    }
  });
});
