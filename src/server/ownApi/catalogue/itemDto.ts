import type { CatalogueItemRow, ItemKind } from "./catalogueRepository";

/**
 * The native item representation.
 *
 * Field names are Seyirlik's own: durations are integer milliseconds, dates are
 * RFC 3339 UTC, and identifiers are opaque. No inherited tick, PascalCase key or
 * filesystem path appears here or may be reintroduced — the browser adapts this
 * shape to its view models, never the other way around.
 */

export type ItemImageType = "cover" | "backdrop" | "logo" | "thumb" | "banner";

export interface ImageRefDto {
  /** Opaque id for `/images/:imageId`. */
  id: string;
  /** Content hash; changes whenever the artwork changes, so it is cache-safe. */
  tag: string;
  width?: number;
  height?: number;
}

export interface ItemImagesDto {
  cover?: ImageRefDto;
  logo?: ImageRefDto;
  thumb?: ImageRefDto;
  banner?: ImageRefDto;
  backdrops: ImageRefDto[];
  /** Artwork inherited from the parent series/season for episode cards. */
  parentCover?: ImageRefDto;
  parentBackdrops?: ImageRefDto[];
  parentLogo?: ImageRefDto;
}

export interface UserItemStateDto {
  positionMs: number;
  played: boolean;
  playCount: number;
  isFavourite: boolean;
  lastPlayedAt?: string;
  /** 0–100, present only when a runtime is known and progress exists. */
  playedPercentage?: number;
  audioStreamIndex?: number;
  subtitleStreamIndex?: number;
}

export interface ItemDto {
  id: string;
  kind: ItemKind;
  libraryId: string;
  title: string;
  sortTitle: string;
  originalTitle?: string;
  overview?: string;
  tagline?: string;
  productionYear?: number;
  premiereDate?: string;
  officialRating?: string;
  communityRating?: number;
  runtimeMs?: number;
  indexNumber?: number;
  parentIndexNumber?: number;
  endIndexNumber?: number;
  parentId?: string;
  seriesId?: string;
  seriesTitle?: string;
  seasonId?: string;
  seasonTitle?: string;
  genres: string[];
  providerIds: Record<string, string>;
  childCount?: number;
  recursiveItemCount?: number;
  dateCreated: string;
  /** True while the source files are absent but inside the retention window. */
  isMissing: boolean;
  /** Fine logo placement on the card, or null when never adjusted. */
  logoLayout: { x: number; y: number; width: number; shadow: number } | null;
  /** An episode's series placement, for cards that show the series poster. */
  seriesLogoLayout?: { x: number; y: number; width: number; shadow: number };
  images: ItemImagesDto;
  userState?: UserItemStateDto;
}

export interface ImageRecord {
  id: string;
  itemId: string;
  imageType: string;
  imageIndex: number;
  contentHash: string;
  width: number | null;
  height: number | null;
}

export interface UserStateRecord {
  itemId: string;
  positionMs: string | number;
  played: boolean;
  playCount: number;
  isFavourite: boolean;
  lastPlayedAt: Date | null;
  audioStreamIndex: number | null;
  subtitleStreamIndex: number | null;
}

function toImageRef(record: ImageRecord): ImageRefDto {
  return {
    id: record.id,
    tag: record.contentHash,
    ...(record.width === null ? {} : { width: record.width }),
    ...(record.height === null ? {} : { height: record.height }),
  };
}

export function groupImages(
  records: ImageRecord[],
): Map<string, ImageRecord[]> {
  const byItem = new Map<string, ImageRecord[]>();
  for (const record of records) {
    const existing = byItem.get(record.itemId);
    if (existing) existing.push(record);
    else byItem.set(record.itemId, [record]);
  }
  return byItem;
}

function buildImages(
  own: ImageRecord[] | undefined,
  inherited: ImageRecord[] | undefined,
): ItemImagesDto {
  const sorted = [...(own ?? [])].sort(
    (left, right) => left.imageIndex - right.imageIndex,
  );
  const pick = (type: string): ImageRefDto | undefined => {
    const record = sorted.find((entry) => entry.imageType === type);
    return record ? toImageRef(record) : undefined;
  };

  const backdrops = sorted
    .filter((record) => record.imageType === "backdrop")
    .map(toImageRef);

  const inheritedSorted = [...(inherited ?? [])].sort(
    (left, right) => left.imageIndex - right.imageIndex,
  );
  const inheritedCover = inheritedSorted.find(
    (record) => record.imageType === "cover",
  );
  const inheritedLogo = inheritedSorted.find(
    (record) => record.imageType === "logo",
  );
  const inheritedBackdrops = inheritedSorted
    .filter((record) => record.imageType === "backdrop")
    .map(toImageRef);

  const cover = pick("cover");
  const logo = pick("logo");
  const thumb = pick("thumb");
  const banner = pick("banner");

  return {
    ...(cover ? { cover } : {}),
    ...(logo ? { logo } : {}),
    ...(thumb ? { thumb } : {}),
    ...(banner ? { banner } : {}),
    backdrops,
    ...(inheritedCover ? { parentCover: toImageRef(inheritedCover) } : {}),
    ...(inheritedLogo ? { parentLogo: toImageRef(inheritedLogo) } : {}),
    ...(inheritedBackdrops.length > 0
      ? { parentBackdrops: inheritedBackdrops }
      : {}),
  };
}

export function toUserStateDto(
  record: UserStateRecord | undefined,
  runtimeMs: number | undefined,
): UserItemStateDto | undefined {
  if (!record) return undefined;

  const positionMs = Number(record.positionMs) || 0;
  const playedPercentage =
    runtimeMs && runtimeMs > 0
      ? Math.min(100, Math.max(0, (positionMs / runtimeMs) * 100))
      : undefined;

  return {
    positionMs,
    played: record.played,
    playCount: record.playCount,
    isFavourite: record.isFavourite,
    ...(record.lastPlayedAt
      ? { lastPlayedAt: record.lastPlayedAt.toISOString() }
      : {}),
    ...(playedPercentage === undefined ? {} : { playedPercentage }),
    ...(record.audioStreamIndex === null
      ? {}
      : { audioStreamIndex: record.audioStreamIndex }),
    ...(record.subtitleStreamIndex === null
      ? {}
      : { subtitleStreamIndex: record.subtitleStreamIndex }),
  };
}

export interface ToItemDtoContext {
  images?: ImageRecord[];
  /** Series or season artwork, used when the item has none of its own. */
  inheritedImages?: ImageRecord[];
  userState?: UserStateRecord;
}

export function toItemDto(
  row: CatalogueItemRow,
  { images, inheritedImages, userState }: ToItemDtoContext = {},
): ItemDto {
  const runtimeMs =
    row.runtimeMs === null ? undefined : Number(row.runtimeMs) || undefined;

  return {
    id: row.id,
    kind: row.kind,
    libraryId: row.libraryId,
    title: row.title,
    sortTitle: row.sortTitle,
    ...(row.originalTitle ? { originalTitle: row.originalTitle } : {}),
    ...(row.overview ? { overview: row.overview } : {}),
    ...(row.tagline ? { tagline: row.tagline } : {}),
    ...(row.productionYear === null
      ? {}
      : { productionYear: row.productionYear }),
    ...(row.premiereDate
      ? { premiereDate: row.premiereDate.toISOString() }
      : {}),
    ...(row.officialRating ? { officialRating: row.officialRating } : {}),
    ...(row.communityRating === null
      ? {}
      : { communityRating: row.communityRating }),
    ...(runtimeMs === undefined ? {} : { runtimeMs }),
    ...(row.indexNumber === null ? {} : { indexNumber: row.indexNumber }),
    ...(row.parentIndexNumber === null
      ? {}
      : { parentIndexNumber: row.parentIndexNumber }),
    ...(row.parentId ? { parentId: row.parentId } : {}),
    ...(row.seriesId ? { seriesId: row.seriesId } : {}),
    ...(row.seriesTitle ? { seriesTitle: row.seriesTitle } : {}),
    // For an episode the parent is its season.
    ...(row.kind === "episode" && row.parentId
      ? { seasonId: row.parentId }
      : {}),
    ...(row.seasonTitle ? { seasonTitle: row.seasonTitle } : {}),
    genres: row.genres,
    providerIds: row.providerIds,
    ...(row.kind === "series" ||
    row.kind === "season" ||
    row.kind === "collection"
      ? {
          childCount: row.childCount,
          recursiveItemCount: row.recursiveItemCount,
        }
      : {}),
    dateCreated: row.dateCreated.toISOString(),
    isMissing: row.missingSince !== null,
    logoLayout: row.logoLayout,
    ...(row.seriesLogoLayout
      ? { seriesLogoLayout: row.seriesLogoLayout }
      : {}),
    images: buildImages(images, inheritedImages),
    ...(userState === undefined
      ? {}
      : { userState: toUserStateDto(userState, runtimeMs) }),
  };
}

/** Cursor key for keyset pagination, matching the repository's sort column. */
export function itemCursorKey(
  row: CatalogueItemRow,
  sort: "title" | "dateCreated" | "premiereDate" | "communityRating" | "index",
): string {
  switch (sort) {
    case "dateCreated":
      return row.dateCreated.toISOString();
    case "premiereDate":
      return row.premiereDate ? row.premiereDate.toISOString() : "";
    case "communityRating":
      return row.communityRating === null ? "" : String(row.communityRating);
    default:
      return row.sortTitle;
  }
}
