import { ownApiClient } from "../api/ownApi/client";

export interface WantedTitle {
  providerId: string;
  kind: "movie" | "series";
  title: string;
  year?: number;
  overview?: string;
  posterUrl?: string;
}
export interface WantedItem extends WantedTitle {
  id: string;
  hasMedia: boolean;
  desired: boolean;
  status:
    | "ready"
    | "downloaded"
    | "downloading"
    | "processing"
    | "paused"
    | "wanted"
    | "missing"
    | "awaiting-import";
}
export interface WantedLibrary {
  id: string;
  name: string;
  kind: "movies" | "series";
}
export function listWanted({ background = false } = {}) {
  return ownApiClient.request<{
    items: WantedItem[];
    libraries: WantedLibrary[];
  }>("/wanted", background ? { background } : undefined);
}
export function searchWanted(
  kind: "movie" | "tv",
  query: string,
  page: number,
) {
  const params = new URLSearchParams({ kind, query, page: String(page) });
  return ownApiClient.request<{ items: WantedTitle[]; totalPages: number }>(
    `/wanted/catalogue?${params}`,
  );
}
export function addWanted(title: WantedTitle, libraryId: string) {
  return ownApiClient.request<{ item: WantedItem }>("/wanted", {
    method: "POST",
    body: { kind: title.kind, providerId: title.providerId, libraryId },
  });
}
export function releaseSearchUrl(
  title: Pick<WantedTitle, "title" | "kind" | "year"> & {
    id?: string;
    /** A TMDB id, under either name the callers hold it by. */
    tmdbId?: string | null;
    providerId?: string;
  },
) {
  const tmdbId = title.tmdbId ?? title.providerId;
  return `/admin/decisions?${new URLSearchParams({ title: title.title, kind: title.kind, ...(title.id ? { itemId: title.id } : {}), ...(title.year ? { year: String(title.year) } : {}), ...(tmdbId ? { tmdbId } : {}) })}`;
}

export function setWanted(id: string, desired: boolean) {
  return ownApiClient.request(`/wanted/${encodeURIComponent(id)}`, {
    method: "PUT",
    body: { desired },
  });
}
