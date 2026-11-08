import { describe, expect, it } from "vitest";
import {
  describeMediaSessionMetadata,
  mediaSessionCardItemId,
} from "./useMediaSessionControls";

const card = {
  src: "https://playback.example/ownAPI/v1/share/items/series-9/image?v=abc",
  width: 2000,
  height: 3000,
};

const episode = {
  Id: "episode-1",
  Type: "Episode",
  SeriesId: "series-9",
  SeriesName: "House of the Dragon",
  ParentIndexNumber: 1,
  IndexNumber: 1,
  ImageTags: { Primary: "still" },
};

describe("describeMediaSessionMetadata", () => {
  it("leads an episode with its own name, under its series and place", () => {
    const metadata = describeMediaSessionMetadata({
      name: "The Heirs of the Dragon",
      item: episode,
      card,
    });
    expect(metadata.title).toBe("The Heirs of the Dragon");
    expect(metadata.artist).toBe("House of the Dragon · S1E1");
    expect(metadata.album).toBe("Seyirlik");
  });

  it("shows an episode with its series' card", () => {
    const metadata = describeMediaSessionMetadata({
      name: "The Heirs of the Dragon",
      item: episode,
      card,
    });
    expect(metadata.artwork).toEqual([
      { src: card.src, sizes: "2000x3000", type: "image/jpeg" },
    ]);
    expect(mediaSessionCardItemId(episode)).toBe("series-9");
  });

  it("names an unnamed episode by its series and place", () => {
    for (const name of ["", "Episode 4", "Bölüm 4"]) {
      const metadata = describeMediaSessionMetadata({
        name,
        item: { ...episode, IndexNumber: 4 },
        card,
      });
      expect(metadata.title).toBe("House of the Dragon");
      expect(metadata.artist).toBe("S1E4");
    }
  });

  it("follows the next episode", () => {
    const first = describeMediaSessionMetadata({
      name: "The Heirs of the Dragon",
      item: episode,
      card,
    });
    const second = describeMediaSessionMetadata({
      name: "The Rogue Prince",
      item: { ...episode, Id: "episode-2", IndexNumber: 2 },
      card,
    });
    expect(second.title).toBe("The Rogue Prince");
    expect(second.artist).toBe("House of the Dragon · S1E2");
    expect(second.artwork).toEqual(first.artwork);
  });

  it("shows a film with its year and first genre", () => {
    const metadata = describeMediaSessionMetadata({
      name: "Fight Club",
      item: {
        Id: "film-1",
        Type: "Movie",
        ProductionYear: 1999,
        Genres: ["Dram", "Gerilim"],
        ImageTags: { Primary: "tag-a" },
      },
      card: { ...card, src: "https://playback.example/film-1-card.jpg" },
    });
    expect(metadata.title).toBe("Fight Club");
    expect(metadata.artist).toBe("1999 · Dram");
    expect(metadata.artwork?.[0]?.src).toBe(
      "https://playback.example/film-1-card.jpg",
    );
  });

  it("gives a film what it has of year and genre", () => {
    const item = { Id: "film-2", Type: "Movie" };
    expect(
      describeMediaSessionMetadata({
        name: "A",
        item: { ...item, Genres: [" ", "Belgesel"] },
        card,
      }).artist,
    ).toBe("Belgesel");
    expect(
      describeMediaSessionMetadata({
        name: "A",
        item: { ...item, ProductionYear: 2021 },
        card,
      }).artist,
    ).toBe("2021");
    expect(describeMediaSessionMetadata({ name: "A", item, card }).artist).toBe(
      "Seyirlik",
    );
  });

  it("falls back to the plain cover when the title has no card", () => {
    const film = describeMediaSessionMetadata({
      name: "Fight Club",
      item: { Id: "film-1", Type: "Movie", ImageTags: { Primary: "tag-a" } },
      card: null,
    });
    expect(film.artwork?.[0]?.src).toContain("film-1");
    expect(film.artwork?.[0]?.src).toContain("tag-a");

    const unnamed = describeMediaSessionMetadata({
      name: "The Heirs of the Dragon",
      item: episode,
      card: null,
    });
    expect(unnamed.artwork?.[0]?.src).toContain("series-9");
    expect(unnamed.artwork?.[0]?.src).not.toContain("episode-1");
  });

  it("shows no picture while the card is still being asked for", () => {
    const metadata = describeMediaSessionMetadata({
      name: "Fight Club",
      item: { Id: "film-1", Type: "Movie" },
    });
    expect(metadata.artwork).toEqual([]);
  });
});
