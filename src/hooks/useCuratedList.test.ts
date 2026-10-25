import { act, renderHook, waitFor, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useHomeCuratedLists } from "./useCuratedList";
import { getCuratedList } from "../lib/mediaApi";
import { refreshLibraryRoutes } from "../lib/libraryRoutes";
import { emptyCuratedList } from "../lib/curation";

vi.mock("../lib/mediaApi");
vi.mock("../lib/libraryRoutes");
afterEach(cleanup);
beforeEach(() => vi.resetAllMocks());

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("home ordering readiness", () => {
  it("publishes hero ordering while library discovery is still pending", async () => {
    vi.mocked(refreshLibraryRoutes).mockReturnValue(new Promise(() => {}));
    const hero = emptyCuratedList("home-hero");
    vi.mocked(getCuratedList).mockResolvedValue(hero);
    const { result } = renderHook(useHomeCuratedLists);
    expect(result.current.heroLoaded).toBe(false);
    await waitFor(() => expect(result.current.heroLoaded).toBe(true));
    expect(result.current.hero).toEqual(hero);
  });

  it("keeps hero readiness when slower shelf ordering arrives", async () => {
    const shelf = deferred<ReturnType<typeof emptyCuratedList>>();
    vi.mocked(refreshLibraryRoutes).mockResolvedValue({
      movies: {
        id: "movies",
        name: "Movies",
        path: "/movies",
        collectionType: null,
      },
    });
    const hero = emptyCuratedList("home-hero");
    vi.mocked(getCuratedList).mockImplementation((surface) =>
      surface === "home-hero" ? Promise.resolve(hero) : shelf.promise,
    );
    const { result } = renderHook(useHomeCuratedLists);
    await waitFor(() => expect(result.current.heroLoaded).toBe(true));
    expect(result.current.movies).toBeNull();
    await act(async () => shelf.resolve(emptyCuratedList("library", "movies")));
    expect(result.current.movies?.libraryId).toBe("movies");
    expect(result.current.hero).toEqual(hero);
    expect(result.current.heroLoaded).toBe(true);
  });

  it("uses the default order after a failed hero request", async () => {
    vi.mocked(refreshLibraryRoutes).mockResolvedValue({});
    vi.mocked(getCuratedList).mockRejectedValue(new Error("offline"));
    const { result } = renderHook(useHomeCuratedLists);
    await waitFor(() => expect(result.current.heroLoaded).toBe(true));
    expect(result.current.hero).toBeNull();
  });

  it("keeps shelf ordering when hero ordering settles last", async () => {
    const hero = deferred<ReturnType<typeof emptyCuratedList>>();
    vi.mocked(refreshLibraryRoutes).mockResolvedValue({
      movies: {
        id: "movies",
        name: "Movies",
        path: "/movies",
        collectionType: null,
      },
    });
    vi.mocked(getCuratedList).mockImplementation((surface) =>
      surface === "home-hero"
        ? hero.promise
        : Promise.resolve(emptyCuratedList("library", "movies")),
    );
    const { result } = renderHook(useHomeCuratedLists);
    await waitFor(() =>
      expect(result.current.movies?.libraryId).toBe("movies"),
    );
    expect(result.current.heroLoaded).toBe(false);
    await act(async () => hero.resolve(emptyCuratedList("home-hero")));
    expect(result.current.heroLoaded).toBe(true);
    expect(result.current.movies?.libraryId).toBe("movies");
  });

  it("does not publish a hero response after unmount", async () => {
    const hero = deferred<ReturnType<typeof emptyCuratedList>>();
    vi.mocked(refreshLibraryRoutes).mockReturnValue(new Promise(() => {}));
    vi.mocked(getCuratedList).mockReturnValue(hero.promise);
    const { result, unmount } = renderHook(useHomeCuratedLists);
    unmount();
    await act(async () => hero.resolve(emptyCuratedList("home-hero")));
    expect(result.current.heroLoaded).toBe(false);
  });
});
