// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
  getEpisodeDisplayMetadata,
  getSeriesEpisodeThumbnailLanguage,
  saveEpisodeMetadataOverrides,
} from "./episodeMetadataPreferences";
import type { MediaItem } from "./types";

function createMemoryStorage(): Storage {
  const values = new Map<string, string>();

  return {
    get length() {
      return values.size;
    },
    clear() {
      values.clear();
    },
    getItem(key: string) {
      return values.get(key) ?? null;
    },
    key(index: number) {
      return Array.from(values.keys())[index] ?? null;
    },
    removeItem(key: string) {
      values.delete(key);
    },
    setItem(key: string, value: string) {
      values.set(key, value);
    },
  };
}

function createEpisode(overrides: Partial<MediaItem> = {}): MediaItem {
  return {
    Id: "episode-1",
    Name: "Server name",
    Type: "Episode",
    SeriesId: "series-1",
    ParentIndexNumber: 1,
    IndexNumber: 1,
    Overview: "Server overview",
    ...overrides,
  };
}

beforeEach(() => {
  Object.defineProperty(window, "localStorage", {
    value: createMemoryStorage(),
    configurable: true,
  });
  window.localStorage.clear();
});

describe("episode metadata preferences", () => {
  it("switches saved episode text by the current website language", () => {
    saveEpisodeMetadataOverrides(
      [
        {
          episodeId: "episode-1",
          seriesId: "series-1",
          seasonNumber: 1,
          episodeNumber: 1,
          titles: {
            en: "English episode title",
            tr: "Türkçe bölüm adı",
          },
          overviews: {
            en: "English episode description.",
            tr: "Türkçe bölüm açıklaması.",
          },
          thumbnail: {
            url: "https://image.tmdb.org/t/p/w780/still.jpg",
            filePath: "/still.jpg",
            language: "en",
          },
        },
      ],
      { seriesId: "series-1", thumbnailLanguage: "en" },
    );

    expect(getEpisodeDisplayMetadata(createEpisode(), "en")).toEqual({
      title: "English episode title",
      overview: "English episode description.",
      thumbnailUrl: "https://image.tmdb.org/t/p/w780/still.jpg",
    });
    expect(getEpisodeDisplayMetadata(createEpisode(), "tr")).toEqual({
      title: "Türkçe bölüm adı",
      overview: "Türkçe bölüm açıklaması.",
      thumbnailUrl: "https://image.tmdb.org/t/p/w780/still.jpg",
    });
    expect(getSeriesEpisodeThumbnailLanguage("series-1")).toBe("en");
  });

  it("can match a saved episode by series, season, and episode numbers", () => {
    saveEpisodeMetadataOverrides([
      {
        episodeId: "old-jellyfin-id",
        seriesId: "series-1",
        seasonNumber: 2,
        episodeNumber: 3,
        titles: {
          en: "Matched by order",
          tr: "Sıraya göre eşleşti",
        },
      },
    ]);

    expect(
      getEpisodeDisplayMetadata(
        createEpisode({
          Id: "new-jellyfin-id",
          ParentIndexNumber: 2,
          IndexNumber: 3,
        }),
        "tr",
      ).title,
    ).toBe("Sıraya göre eşleşti");
  });
});

describe("an episode's catalogue translations", () => {
  const episode = createEpisode({
    Name: "The Heirs of the Dragon",
    Overview: "Viserys hosts a tournament.",
    LocalizedTitles: {
      en: "The Heirs of the Dragon",
      tr: "Ejderha'nın Varisleri",
    },
    LocalizedOverviews: { tr: "Viserys bir turnuva düzenler." },
  });

  it("shows the name and overview in the site's language", () => {
    expect(getEpisodeDisplayMetadata(episode, "tr")).toMatchObject({
      title: "Ejderha'nın Varisleri",
      overview: "Viserys bir turnuva düzenler.",
    });
    expect(getEpisodeDisplayMetadata(episode, "en")).toMatchObject({
      title: "The Heirs of the Dragon",
      overview: "Viserys hosts a tournament.",
    });
  });

  it("falls back to the episode's own text when a language has none", () => {
    const untranslated = createEpisode({
      Name: "The Rogue Prince",
      LocalizedTitles: { en: "The Rogue Prince" },
    });
    expect(getEpisodeDisplayMetadata(untranslated, "tr")).toMatchObject({
      title: "The Rogue Prince",
      overview: "Server overview",
    });
  });

  it("lets a choice saved on this device win", () => {
    saveEpisodeMetadataOverrides([
      { episodeId: episode.Id, titles: { tr: "Kendi adım" } },
    ]);
    expect(getEpisodeDisplayMetadata(episode, "tr").title).toBe("Kendi adım");
  });
});
