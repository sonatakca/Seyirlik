import { describe, expect, it, vi } from "vitest";
import { cacheSeriesCatalogue, type SeriesCatalogue } from "./libraryAdmin";

function tmdb() {
  return {
    getSeries: vi.fn(async (id: string) => ({ id }) as never),
    getSeasonEpisodes: vi.fn(async () => []),
    buildImageUrl: (path: string, size: string) => `${size}${path}`,
  } satisfies SeriesCatalogue;
}

describe("cacheSeriesCatalogue", () => {
  it("asks TMDB once per show and season until the answer is old", async () => {
    let clock = 0;
    const source = tmdb();
    const cached = cacheSeriesCatalogue(source, 1_000, () => clock);
    await cached.getSeries("1398");
    await cached.getSeries("1398");
    await cached.getSeasonEpisodes("1398", 1);
    await cached.getSeasonEpisodes("1398", 1);
    await cached.getSeasonEpisodes("1398", 2);
    expect(source.getSeries).toHaveBeenCalledTimes(1);
    expect(source.getSeasonEpisodes).toHaveBeenCalledTimes(2);
    clock = 1_000;
    await cached.getSeries("1398");
    expect(source.getSeries).toHaveBeenCalledTimes(2);
  });

  it("does not keep a failed answer", async () => {
    const source = tmdb();
    source.getSeries.mockRejectedValueOnce(new Error("TMDB is down"));
    const cached = cacheSeriesCatalogue(source, 60_000, () => 0);
    await expect(cached.getSeries("1398")).rejects.toThrow("TMDB is down");
    await expect(cached.getSeries("1398")).resolves.toEqual({ id: "1398" });
    expect(source.getSeries).toHaveBeenCalledTimes(2);
  });
});
