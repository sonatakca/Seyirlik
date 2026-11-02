import type {
  CatalogueItemRow,
  CatalogueRepository,
  ItemKind,
  ListItemsOptions,
} from "./catalogueRepository";
import type { HomeRepository } from "./homeRepository";
import type { ImageRepository } from "../images/imageRepository";
import type { UserStateRepository } from "../progress/userStateRepository";
import type { FileEpisodeRepository } from "./fileEpisodes";
import { groupImages, itemCursorKey, toItemDto, type ItemDto } from "./itemDto";
import { rankSearchCandidates } from "./searchRanking";

/**
 * Ceiling on the titles pulled in for the fuzzy pass. Large enough to cover a
 * personal library whole, small enough that a pathological one cannot turn a
 * keystroke into an unbounded scan.
 */
const SEARCH_CANDIDATE_LIMIT = 20_000;

export interface CatalogueServiceOptions {
  catalogue: CatalogueRepository;
  home: HomeRepository;
  images: ImageRepository;
  userState: UserStateRepository;
  /** Episodes held inside another item's file; absent, every item plays its own. */
  fileEpisodes?: Pick<FileEpisodeRepository, "listForItems">;
}

export interface PagedItems {
  items: ItemDto[];
  nextCursorKey: string | null;
  nextCursorId: string | null;
}

export interface HomeSection {
  id: string;
  title: string;
  items: ItemDto[];
}

export interface HomeDto {
  libraries: Array<{
    id: string;
    name: string;
    kind: string;
    itemCount: number;
  }>;
  continueWatching: ItemDto[];
  nextUp: ItemDto[];
  latestByLibrary: HomeSection[];
}

/**
 * Composes catalogue rows with artwork and per-user state into the native item
 * DTO.
 *
 * The enrichment is always batched: one query for images, one for inherited
 * artwork, one for user state and two for shared files, no matter how many items are in the page.
 * Doing it per item is the classic way a media home screen becomes unusable.
 */
export function createCatalogueService({
  catalogue,
  home,
  images,
  userState,
  fileEpisodes,
}: CatalogueServiceOptions) {
  async function enrich(
    userId: string,
    rows: CatalogueItemRow[],
  ): Promise<ItemDto[]> {
    if (rows.length === 0) return [];

    const itemIds = rows.map((row) => row.id);
    const [imageRecords, inheritedImages, states, held] = await Promise.all([
      images.listForItems(itemIds),
      images.listInheritedForItems(itemIds),
      userState.getMany(userId, itemIds),
      fileEpisodes?.listForItems(itemIds) ?? new Map(),
    ]);
    const imagesByItem = groupImages(imageRecords);

    return rows.map((row) => {
      const ownImages = imagesByItem.get(row.id);
      const parentImages = inheritedImages.get(row.id);
      const state = states.get(row.id);
      const fileEpisodeView = held.get(row.id);

      return toItemDto(row, {
        ...(ownImages ? { images: ownImages } : {}),
        ...(parentImages ? { inheritedImages: parentImages } : {}),
        ...(state ? { userState: state } : {}),
        ...(fileEpisodeView ? { fileEpisodes: fileEpisodeView } : {}),
      });
    });
  }

  async function loadByIds(
    userId: string,
    itemIds: string[],
  ): Promise<ItemDto[]> {
    if (itemIds.length === 0) return [];

    const rows = await catalogue.getItemsByIds(userId, itemIds);
    const byId = new Map(rows.map((row) => [row.id, row]));

    // Preserve the caller's ordering: continue-watching and next-up are ranked
    // by recency, which the catalogue query does not know about. Ids the viewer
    // may not see simply drop out.
    const ordered = itemIds
      .map((itemId) => byId.get(itemId))
      .filter((row): row is CatalogueItemRow => row !== undefined);

    return enrich(userId, ordered);
  }

  return {
    enrich,
    loadByIds,

    listLibraries: (userId: string) => catalogue.listLibraries(userId),

    getItem: async (
      userId: string,
      itemId: string,
    ): Promise<ItemDto | null> => {
      // The batch read carries the availability rule browse pages use, so a
      // wanted title with nothing to play is as absent here as in a list.
      const [row] = await catalogue.getItemsByIds(userId, [itemId]);
      if (!row) return null;
      const [dto] = await enrich(userId, [row]);
      return dto ?? null;
    },

    listItems: async (options: ListItemsOptions): Promise<PagedItems> => {
      // One extra row tells us whether another page exists without a count(*).
      const rows = await catalogue.listItems({
        ...options,
        limit: options.limit + 1,
      });
      const hasMore = rows.length > options.limit;
      const page = hasMore ? rows.slice(0, options.limit) : rows;
      const last = hasMore ? page[page.length - 1] : undefined;

      return {
        items: await enrich(options.userId, page),
        nextCursorKey: last
          ? itemCursorKey(last, options.sort ?? "title")
          : null,
        nextCursorId: last ? last.id : null,
      };
    },

    listChildren: async (
      userId: string,
      parentId: string,
      kind: ItemKind,
    ): Promise<ItemDto[]> =>
      enrich(userId, await catalogue.listChildren(userId, parentId, kind)),

    listSeriesEpisodes: async (
      userId: string,
      seriesId: string,
    ): Promise<ItemDto[]> =>
      enrich(userId, await catalogue.listSeriesEpisodes(userId, seriesId)),

    /**
     * Substring first, then typo tolerance.
     *
     * The SQL pass is exact and cheap and answers most queries on its own. The
     * fuzzy pass only runs when that came back short — which is precisely the
     * case where the user mistyped — so the common path costs nothing extra.
     * Exact hits keep their place at the top; fuzzy results fill in behind.
     */
    search: async (
      userId: string,
      query: string,
      limit: number,
    ): Promise<ItemDto[]> => {
      const direct = await catalogue.searchItems(userId, query, limit);

      if (direct.length >= limit) return enrich(userId, direct);

      const candidates = await catalogue.listSearchCandidates(
        userId,
        SEARCH_CANDIDATE_LIMIT,
      );
      const ranked = rankSearchCandidates(query, candidates, limit);

      const orderedIds: string[] = [];
      const seen = new Set<string>();

      for (const id of [
        ...direct.map((row) => row.id),
        ...ranked.map((entry) => entry.id),
      ]) {
        if (seen.has(id)) continue;
        seen.add(id);
        orderedIds.push(id);
      }

      return loadByIds(userId, orderedIds.slice(0, limit));
    },

    continueWatching: async (
      userId: string,
      limit: number,
    ): Promise<ItemDto[]> => {
      const resumable = await userState.listResumable(userId, limit);
      return loadByIds(
        userId,
        resumable.map((entry) => entry.itemId),
      );
    },

    nextUp: async (userId: string, limit: number): Promise<ItemDto[]> =>
      loadByIds(userId, await home.listNextUpEpisodeIds(userId, limit)),

    favourites: async (userId: string, limit: number): Promise<ItemDto[]> =>
      loadByIds(userId, await userState.listFavourites(userId, limit)),

    latest: async (
      userId: string,
      limit: number,
      libraryId?: string,
    ): Promise<ItemDto[]> =>
      loadByIds(userId, await home.listLatestItemIds(userId, limit, libraryId)),

    nextEpisode: async (
      userId: string,
      episodeId: string,
    ): Promise<ItemDto | null> => {
      const nextId = await home.findNextEpisodeId(userId, episodeId);
      if (!nextId) return null;
      const [dto] = await loadByIds(userId, [nextId]);
      return dto ?? null;
    },

    firstUnwatchedEpisode: async (
      userId: string,
      seriesId: string,
    ): Promise<ItemDto | null> => {
      const episodeId = await home.findFirstUnwatchedEpisodeId(
        userId,
        seriesId,
      );
      if (!episodeId) return null;
      const [dto] = await loadByIds(userId, [episodeId]);
      return dto ?? null;
    },

    /** Single aggregate the home screen can render from one request. */
    home: async (
      userId: string,
      { rowSize = 20 }: { rowSize?: number } = {},
    ): Promise<HomeDto> => {
      const libraries = await catalogue.listLibraries(userId);
      const [continueWatching, nextUp, latestByLibraryIds] = await Promise.all([
        userState.listResumable(userId, rowSize).then((entries) =>
          loadByIds(
            userId,
            entries.map((e) => e.itemId),
          ),
        ),
        home
          .listNextUpEpisodeIds(userId, rowSize)
          .then((ids) => loadByIds(userId, ids)),
        home.listLatestPerLibrary(userId, rowSize),
      ]);

      const latestByLibrary: HomeSection[] = [];
      for (const library of libraries) {
        const ids = latestByLibraryIds.get(library.id) ?? [];
        if (ids.length === 0) continue;
        latestByLibrary.push({
          id: library.id,
          title: library.name,
          items: await loadByIds(userId, ids),
        });
      }

      return {
        libraries: libraries.map((library) => ({
          id: library.id,
          name: library.name,
          kind: library.kind,
          itemCount: library.itemCount,
        })),
        continueWatching,
        nextUp,
        latestByLibrary,
      };
    },
  };
}

export type CatalogueService = ReturnType<typeof createCatalogueService>;
