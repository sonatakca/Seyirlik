/**
 * The subtitle endpoints, as the operations page uses them.
 *
 * An attempt is identified by its own id and nothing else. No provider
 * session, no cookie and no candidate URL crosses this boundary — the provider
 * abstraction holds those on the server, and an interactive sign-in is
 * resumed by naming the attempt, never by handing a browser a credential.
 */
import { ownApiClient } from "../api/ownApi/client";

/** The states an attempt passes through, as the server names them. */
export type SubtitleAttemptState =
  | "wanted"
  | "searching"
  | "selected"
  | "downloading"
  | "validating"
  | "installed"
  | "needs-authentication"
  | "failed"
  | "superseded";

export interface SubtitleAttempt {
  readonly attemptId: string;
  readonly mediaFileId: string;
  readonly language: string;
  readonly forced: boolean;
  readonly hearingImpaired: string;
  readonly state: SubtitleAttemptState;
  readonly attempt: number;
  readonly providerId: string | null;
  readonly score: number | null;
  readonly failureClass: string | null;
  /** Which provider is waiting to be signed in to, when one is. */
  readonly awaitingProviderId: string | null;
  /** The film, or the show the episode belongs to. */
  readonly title?: string | null;
  readonly seasonNumber?: number | null;
  readonly episodeNumber?: number | null;
}

export type ProviderSessionState =
  | "anonymous"
  | "active"
  | "rejected"
  | "signed-out";

export interface SubtitleProviderStatus {
  readonly id: string;
  readonly label: string;
  readonly languages: string[] | null;
  readonly requiresSession: boolean;
  /** Whether the provider can be asked now. Never the session itself. */
  readonly session: {
    readonly state: ProviderSessionState;
    readonly updatedAt: string | null;
    readonly reason: string | null;
  } | null;
}

export async function listSubtitleProviders(): Promise<
  SubtitleProviderStatus[]
> {
  const { providers } = await ownApiClient.request<{
    providers: SubtitleProviderStatus[];
  }>("/subtitles/providers");
  return providers;
}

/**
 * Hands the server the session a browser earned by passing the provider's
 * check and signing in. Write-only: the server seals it and never returns it.
 */
export function saveProviderSession(
  providerId: string,
  material: { cookie: string; userAgent: string },
): Promise<{ resumed: number }> {
  return ownApiClient.request(
    `/subtitles/providers/${encodeURIComponent(providerId)}/session`,
    { method: "PUT", body: material },
  );
}

export function clearProviderSession(providerId: string): Promise<unknown> {
  return ownApiClient.request(
    `/subtitles/providers/${encodeURIComponent(providerId)}/session`,
    { method: "DELETE" },
  );
}

/** OpenSubtitles' API key and accounts. Says which account, never a password. */
export interface OpenSubtitlesStatus {
  readonly apiKey: {
    readonly state: "active" | "signed-out";
    readonly updatedAt: string | null;
  };
  readonly accounts: readonly {
    readonly slot: number;
    readonly state: "active" | "rejected" | "signed-out";
    readonly username: string | null;
    /** Why it was refused, or that today's downloads are used up. */
    readonly reason: string | null;
    readonly updatedAt: string | null;
  }[];
}

export function getOpenSubtitlesStatus(): Promise<OpenSubtitlesStatus> {
  return ownApiClient.request("/subtitles/providers/opensubtitles/accounts");
}

/** Write-only, like a session: the server seals the key and never returns it. */
export function saveOpenSubtitlesApiKey(
  apiKey: string,
): Promise<OpenSubtitlesStatus & { resumed: number }> {
  return ownApiClient.request("/subtitles/providers/opensubtitles/api-key", {
    method: "PUT",
    body: { apiKey },
  });
}

export function clearOpenSubtitlesApiKey(): Promise<OpenSubtitlesStatus> {
  return ownApiClient.request("/subtitles/providers/opensubtitles/api-key", {
    method: "DELETE",
  });
}

/** The server signs the account in first and saves it only if that worked. */
export function saveOpenSubtitlesAccount(
  slot: number,
  account: { username: string; password: string },
): Promise<
  OpenSubtitlesStatus & { allowedDownloads: number | null; resumed: number }
> {
  return ownApiClient.request(
    `/subtitles/providers/opensubtitles/accounts/${slot}`,
    { method: "PUT", body: account },
  );
}

export function clearOpenSubtitlesAccount(
  slot: number,
): Promise<OpenSubtitlesStatus> {
  return ownApiClient.request(
    `/subtitles/providers/opensubtitles/accounts/${slot}`,
    { method: "DELETE" },
  );
}

export async function listSubtitleAttempts(): Promise<SubtitleAttempt[]> {
  const { attempts } = await ownApiClient.request<{
    attempts: SubtitleAttempt[];
  }>("/subtitles");
  return attempts;
}

/**
 * Resumes an attempt that was waiting for a sign-in.
 *
 * The server refuses this unless the attempt is genuinely in
 * `needs-authentication`, so pressing it without having signed in produces a
 * refusal rather than a false success.
 */
export function resumeSubtitleAttempt(attemptId: string): Promise<unknown> {
  return ownApiClient.request(
    `/subtitles/${encodeURIComponent(attemptId)}/resume`,
    { method: "POST", body: {} },
  );
}
