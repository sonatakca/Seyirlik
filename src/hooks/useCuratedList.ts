import { useEffect, useState } from "react";
import type { CuratedList, CuratedSurface } from "../lib/curation";
import {
  refreshLibraryRoutes,
  type LibraryRouteRegistry,
} from "../lib/libraryRoutes";
import { getCuratedList } from "../lib/mediaApi";

export interface HomeCuratedLists {
  hero: CuratedList | null;
  /** Settled even when the request fails, allowing the default order. */
  heroLoaded: boolean;
  /** The film library's order, shared with the film grid. */
  movies: CuratedList | null;
  shows: CuratedList | null;
  books: CuratedList | null;
}

const NO_HOME_CURATION: HomeCuratedLists = {
  hero: null,
  heroLoaded: false,
  movies: null,
  shows: null,
  books: null,
};

function loadForLibrary(libraryId?: string): Promise<CuratedList | null> {
  return libraryId
    ? getCuratedList("library", libraryId).catch(() => null)
    : Promise.resolve(null);
}

/**
 * The orderings the home page reads: the carousel's, and one per library.
 *
 * A Latest row is ordered by its library's list rather than by one of its own,
 * so the row and the grid can never disagree — and so nobody has to arrange
 * the same films twice.
 *
 * A failure resolves to `null` rather than propagating: an ordering is a
 * refinement of a shelf, and a shelf rendering in its default order is a far
 * better outcome than a home page rendering an error.
 */
export function useHomeCuratedLists(): HomeCuratedLists {
  const [lists, setLists] = useState<HomeCuratedLists>(NO_HOME_CURATION);

  useEffect(() => {
    let isMounted = true;

    // Hero ordering has no library dependency. Publish it as soon as it
    // settles, without waiting for discovery or any shelf ordering.
    void getCuratedList("home-hero")
      .catch(() => null)
      .then((hero) => {
        if (isMounted) {
          setLists((current) => ({ ...current, hero, heroLoaded: true }));
        }
      });

    async function load(): Promise<void> {
      const libraries: LibraryRouteRegistry =
        await refreshLibraryRoutes().catch(() => ({}));

      const [movies, shows, books] = await Promise.all([
        loadForLibrary(libraries.movies?.id),
        loadForLibrary(libraries.shows?.id),
        loadForLibrary(libraries.books?.id),
      ]);

      if (!isMounted) return;
      setLists((current) => ({ ...current, movies, shows, books }));
    }

    void load();

    return () => {
      isMounted = false;
    };
  }, []);

  return lists;
}

/** The saved order for one library, or `null` while it is unknown. */
export function useCuratedList(
  surface: CuratedSurface,
  libraryId: string | undefined,
): CuratedList | null {
  const [list, setList] = useState<CuratedList | null>(null);

  useEffect(() => {
    let isMounted = true;
    setList(null);

    if (!libraryId) return;

    void getCuratedList(surface, libraryId)
      .then((loaded) => {
        if (isMounted) setList(loaded);
      })
      .catch(() => undefined);

    return () => {
      isMounted = false;
    };
  }, [surface, libraryId]);

  return list;
}
