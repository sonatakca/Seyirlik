/**
 * Searching and judging releases, and asking for one.
 *
 * A release is named to the server by indexer and guid, never by URL. The
 * server resolves it and fetches the NZB with its own credentials — the whole
 * reason Phase 2 kept the download URL out of every DTO — so nothing here
 * accepts or forwards one.
 */
import { ownApiClient } from "../api/ownApi/client";
import type { JudgedRelease } from "./releaseDecisionPresentation";

export interface QualityProfile {
  readonly id: string;
  readonly name: string;
  /** The largest release it accepts, in bytes. Null means no limit. */
  readonly maxSizeBytes: number | null;
}

export interface EvaluateQuery {
  readonly kind: "movie" | "season";
  readonly season?: number;
  readonly title: string;
  readonly year?: number;
  readonly profileId?: string;
  /** Which title the words mean, when the page already knows. */
  readonly tmdbId?: string;
}

/** A title the words could mean, as TMDB names it. */
export interface TitleChoice {
  readonly tmdbId: string;
  readonly title: string;
  readonly originalTitle?: string;
  readonly year?: number;
}

export interface ResolvedTitle extends TitleChoice {
  readonly englishTitle: string;
  readonly imdbId?: string;
}

export interface EvaluateResult {
  readonly candidates: JudgedRelease[];
  readonly winner: JudgedRelease | null;
  readonly profile: { id: string; name: string };
  /** Null when TMDB had nothing close, and the words were searched as typed. */
  readonly resolved: ResolvedTitle | null;
  readonly alternatives: TitleChoice[];
  readonly searchedFor: { imdbId: string } | { term: string };
}

export async function listProfiles(): Promise<QualityProfile[]> {
  const { profiles } = await ownApiClient.request<{
    profiles: QualityProfile[];
  }>("/releases/profiles");
  return profiles;
}

export function setProfileMaxSize(
  profileId: string,
  maxSizeBytes: number | null,
): Promise<unknown> {
  return ownApiClient.request(
    `/releases/profiles/${encodeURIComponent(profileId)}`,
    { method: "PATCH", body: { maxSizeBytes } },
  );
}

export function evaluateReleases(
  query: EvaluateQuery,
): Promise<EvaluateResult> {
  return ownApiClient.request<EvaluateResult>("/releases/evaluate", {
    method: "POST",
    body: { ...query },
  });
}

export interface AcquireRequest {
  readonly itemId?: string;
  readonly kind: "movie" | "season" | "episode";
  readonly title: string;
  readonly year?: number;
  readonly season?: number;
  readonly indexerId: string;
  readonly releaseGuid: string;
  readonly releaseTitle: string;
  readonly profileId?: string;
  readonly score?: number;
  readonly reasons?: unknown;
}

export function acquireRelease(request: AcquireRequest): Promise<unknown> {
  return ownApiClient.request("/acquisitions", {
    method: "POST",
    body: { ...request },
  });
}
