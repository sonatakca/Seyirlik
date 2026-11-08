import { ownApiClient } from "../api/ownApi/client";

/**
 * Administrator artwork surface.
 *
 * The automatic metadata pass already stores a poster, a backdrop and a logo
 * for every identified title. This is the override: it shows what the provider
 * actually holds so a person can disagree, and marks whatever they pick as
 * theirs so a later refresh leaves it alone.
 */

export type ArtworkKind = "poster" | "backdrop" | "logo";

/** The stored image type each provider set is written to. */
export type StoredImageType = "cover" | "backdrop" | "logo";

export interface ArtworkCandidate {
  kind: ArtworkKind;
  imageType: StoredImageType;
  filePath: string;
  /** ISO 639-1, or null for artwork with no text and so no language. */
  language: string | null;
  width: number | null;
  height: number | null;
  aspectRatio: number | null;
  voteAverage: number;
  voteCount: number;
  previewUrl: string;
}

export interface StoredArtwork {
  id: string;
  itemId: string;
  imageType: string;
  imageIndex: number;
  contentHash: string;
  width: number | null;
  height: number | null;
  /** The point a crop keeps in view; null or absent means the centre. */
  focus?: { x: number; y: number } | null;
}

export interface ArtworkOverview {
  item: {
    id: string;
    title: string;
    kind: string;
    providerId: string | null;
  };
  /** Stored types an administrator has taken over from the automatic pass. */
  lockedTypes: string[];
  current: StoredArtwork[];
  candidates: ArtworkCandidate[];
}

export const MAX_CUSTOM_ARTWORK_BYTES = 8 * 1_024 * 1_024;

/** Uploads an administrator-owned image and locks it against metadata refresh. */
export async function uploadCustomArtwork(
  itemId: string,
  kind: ArtworkKind,
  file: File,
): Promise<{
  imageId: string;
  imageType: string;
  contentHash: string;
  isLocked: boolean;
}> {
  if (file.size === 0 || file.size > MAX_CUSTOM_ARTWORK_BYTES) {
    throw new Error("Upload an image no larger than 8 MiB.");
  }
  if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
    throw new Error("Upload a JPEG, PNG, or WebP image.");
  }

  return ownApiClient.request(
    `/admin/items/${encodeURIComponent(itemId)}/artwork/upload?kind=${kind}`,
    {
      method: "POST",
      binaryBody: file,
    },
  );
}

export interface LocalizedMetadataPreview {
  language: string;
  title: string;
  originalTitle: string | null;
  overview: string | null;
  tagline: string | null;
}

export async function getItemArtwork(itemId: string): Promise<ArtworkOverview> {
  return ownApiClient.request<ArtworkOverview>(
    `/admin/items/${encodeURIComponent(itemId)}/artwork`,
  );
}

export async function applyItemArtwork(
  itemId: string,
  choice: { kind: ArtworkKind; filePath: string },
): Promise<{ imageId: string; imageType: string; isLocked: boolean }> {
  return ownApiClient.request<{
    imageId: string;
    imageType: string;
    isLocked: boolean;
  }>(`/admin/items/${encodeURIComponent(itemId)}/artwork`, {
    method: "POST",
    body: choice,
  });
}

/** Hands one artwork type back to the automatic pass. */
export async function clearItemArtwork(
  itemId: string,
  kind: ArtworkKind,
): Promise<{ imageType: string; cleared: boolean }> {
  return ownApiClient.request<{ imageType: string; cleared: boolean }>(
    `/admin/items/${encodeURIComponent(itemId)}/artwork/${kind}`,
    { method: "DELETE" },
  );
}

export async function getLocalizedMetadataPreview(
  itemId: string,
  language: string,
): Promise<LocalizedMetadataPreview> {
  return ownApiClient.request<LocalizedMetadataPreview>(
    `/admin/items/${encodeURIComponent(itemId)}/metadata/preview?language=${encodeURIComponent(
      language,
    )}`,
  );
}

/**
 * Places and sizes the logo on this title's card, or clears the adjustment.
 *
 * Not a provider choice, so unlike the artwork endpoints this needs no TMDB
 * match and works for any title that has a logo to place.
 */
export async function setLogoLayout(
  itemId: string,
  layout: { x: number; y: number; width: number; shadow: number } | null,
): Promise<void> {
  await ownApiClient.request<{ layout: unknown }>(
    `/admin/items/${encodeURIComponent(itemId)}/logo-layout`,
    { method: "PUT", body: { layout } },
  );
}

/**
 * Replaces the names, besides the provider's, that search finds this title
 * by. The server tidies them and answers with the list it kept.
 */
export async function setSearchNames(
  itemId: string,
  names: readonly string[],
): Promise<string[]> {
  const result = await ownApiClient.request<{ names: string[] }>(
    `/admin/items/${encodeURIComponent(itemId)}/search-names`,
    { method: "PUT", body: { names } },
  );
  return result.names;
}

/**
 * Which part of the title's backdrop the heroes keep in view, or null for the
 * picture's centre.
 */
export async function setBackdropFocus(
  itemId: string,
  focus: { x: number; y: number } | null,
): Promise<void> {
  await ownApiClient.request<{ focus: unknown }>(
    `/admin/items/${encodeURIComponent(itemId)}/backdrop-focus`,
    { method: "PUT", body: { focus } },
  );
}

export interface MetadataCandidate {
  providerId: string;
  title: string;
  originalTitle?: string;
  year?: number;
  popularity?: number;
}

export interface MetadataCandidatesResult {
  candidates: MetadataCandidate[];
  suggested: { providerId: string; confidence: string } | null;
}

export async function searchMetadataCandidates(
  itemId: string,
  query?: string,
): Promise<MetadataCandidatesResult> {
  const search = query?.trim() ? `?q=${encodeURIComponent(query.trim())}` : "";
  return ownApiClient.request<MetadataCandidatesResult>(
    `/admin/items/${encodeURIComponent(itemId)}/metadata/candidates${search}`,
  );
}

/**
 * Records an operator's identity choice. The server locks the identity so a
 * later automatic pass cannot quietly re-match the title to something else.
 */
export async function identifyItem(
  itemId: string,
  providerId: string,
): Promise<void> {
  await ownApiClient.request<{ taskId: string }>(
    `/admin/items/${encodeURIComponent(itemId)}/identify`,
    { method: "POST", body: { providerId } },
  );
}

export async function saveItemDisplayMetadata(
  itemId: string,
  update: {
    title?: string;
    originalTitle?: string;
    overview?: string;
    tagline?: string;
    lockFields?: string[];
  },
): Promise<void> {
  await ownApiClient.request<unknown>(
    `/admin/items/${encodeURIComponent(itemId)}/metadata`,
    { method: "PATCH", body: update },
  );
}
