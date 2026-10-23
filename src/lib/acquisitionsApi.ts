/**
 * The acquisition endpoints, as the operations pages use them.
 *
 * The server decides what these carry; nothing here reconstructs a field it
 * chose not to send. In particular there is no download URL, no SABnzbd job
 * identifier and no filesystem path, and none of them should be added: the
 * first is credential-bearing and the others exist to be kept server-side.
 */
import { ownApiClient } from "../api/ownApi/client";
import type {
  AcquisitionFailureClass,
  AcquisitionState,
} from "./acquisitionPresentation";

/** What a download is for, in the catalogue's terms. */
export interface AcquisitionTarget {
  readonly kind: string;
  readonly title: string;
  /** The catalogue item, where there is one: for its artwork. */
  readonly itemId?: string;
  readonly year?: number;
  readonly season?: number;
  readonly episode?: number;
}

export interface Acquisition {
  readonly id: string;
  readonly state: AcquisitionState;
  readonly origin: string;
  readonly target: AcquisitionTarget;
  readonly indexerId: string;
  readonly releaseTitle: string;
  readonly attempt: number;
  readonly failureClass?: AcquisitionFailureClass;
  readonly failureDetail?: string;
  readonly sizeBytes?: number;
  /** The release is on the blocklist, whichever row put it there. */
  readonly releaseBlocklisted?: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface AcquisitionReason {
  readonly code?: string;
  readonly detail?: string;
}

export interface RejectedRelease {
  readonly title?: string;
  readonly reason?: string;
}

export interface AcquisitionDecision {
  readonly profileName: string;
  readonly score: number;
  readonly reasons: AcquisitionReason[];
  readonly rejected: RejectedRelease[];
  readonly decidedAt: string;
}

export interface AcquisitionEvent {
  readonly fromState: string | null;
  readonly toState: string;
  readonly failureClass?: string;
  readonly detail?: string;
  readonly at: string;
}

export interface AcquisitionDetail {
  readonly acquisition: Acquisition;
  readonly decision: AcquisitionDecision | null;
  readonly events: AcquisitionEvent[];
}

/** The two shapes the decision's JSON columns can legitimately arrive in. */
function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

export async function listAcquisitions(limit = 100): Promise<Acquisition[]> {
  const { acquisitions } = await ownApiClient.request<{
    acquisitions: Acquisition[];
  }>(`/acquisitions?limit=${limit}`);
  return acquisitions;
}

export async function getAcquisition(id: string): Promise<AcquisitionDetail> {
  const data = await ownApiClient.request<{
    acquisition: Acquisition;
    decision:
      | (Omit<AcquisitionDecision, "reasons" | "rejected"> & {
          reasons: unknown;
          rejected: unknown;
        })
      | null;
    events: AcquisitionEvent[];
  }>(`/acquisitions/${encodeURIComponent(id)}`);

  return {
    acquisition: data.acquisition,
    decision: data.decision
      ? {
          profileName: data.decision.profileName,
          score: data.decision.score,
          // The columns are `jsonb`, so their contents are whatever was
          // recorded; anything that is not a list is treated as none.
          reasons: asArray<AcquisitionReason>(data.decision.reasons),
          rejected: asArray<RejectedRelease>(data.decision.rejected),
          decidedAt: data.decision.decidedAt,
        }
      : null,
    events: data.events,
  };
}

export function retryAcquisition(id: string): Promise<unknown> {
  return ownApiClient.request(`/acquisitions/${encodeURIComponent(id)}/retry`, {
    method: "POST",
    body: {},
  });
}

export function cancelAcquisition(id: string): Promise<unknown> {
  return ownApiClient.request(
    `/acquisitions/${encodeURIComponent(id)}/cancel`,
    { method: "POST", body: {} },
  );
}

export interface BlocklistOutcome {
  /** Whether a search was actually run. */
  readonly searched: boolean;
  /** The acquisition that replaced this one, when the search found one. */
  readonly replacement: Acquisition | null;
  /** Why no search ran, when one was asked for and none did. */
  readonly reason?: "no-profile";
}

/** Never this release again, and — if asked — the next best one instead. */
export function blocklistAcquisition(
  id: string,
  searchAgain: boolean,
): Promise<BlocklistOutcome> {
  return ownApiClient.request<BlocklistOutcome>(
    `/acquisitions/${encodeURIComponent(id)}/blocklist`,
    { method: "POST", body: { searchAgain } },
  );
}

export interface BlocklistEntry {
  readonly id: string;
  readonly indexerId: string;
  readonly releaseTitle: string;
  readonly targetTitle?: string;
  readonly reason?: string;
  readonly createdAt: string;
}

export async function listBlocklist(): Promise<BlocklistEntry[]> {
  const { entries } = await ownApiClient.request<{
    entries: BlocklistEntry[];
  }>("/releases/blocklist");
  return entries;
}

export function removeBlocklistEntry(id: string): Promise<unknown> {
  return ownApiClient.request(`/releases/blocklist/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

/** One running download, as the download client sees it right now. */
export interface AcquisitionProgress {
  readonly acquisitionId: string;
  readonly stage:
    | "queued"
    | "paused"
    /** In the queue, but no news server the client can use will send it. */
    | "stalled"
    | "downloading"
    | "processing"
    | "done"
    | "failed";
  /** The download client's own word: "Downloading", "Repairing"… */
  readonly statusText?: string;
  readonly percent?: number;
  readonly totalBytes?: number;
  readonly downloadedBytes?: number;
  readonly speedBytesPerSecond?: number;
  /**
   * When SABnzbd expects this job to be done. For a waiting job that
   * includes everything ahead of it.
   */
  readonly etaSeconds?: number;
  /** Place in the download client's queue; 1 is first. */
  readonly queuePosition?: number;
  /** The post-processing step, in the download client's words. */
  readonly detail?: string;
}

export interface DownloadProgress {
  /** False when the download client did not answer. */
  readonly reachable: boolean;
  readonly paused: boolean;
  /**
   * Present when work is waiting and no news server will serve it. The
   * client's own job statuses still say "Downloading" then.
   */
  readonly stalled?: {
    readonly servers: ReadonlyArray<{
      readonly name: string;
      /** The client's own words, such as a refused connection. */
      readonly error?: string;
    }>;
  };
  readonly speedBytesPerSecond?: number;
  /** Still to come down, across the whole queue. */
  readonly remainingBytes?: number;
  /** Free space where the download client writes. */
  readonly freeBytes?: number;
  readonly progress: AcquisitionProgress[];
}

export function getDownloadProgress(): Promise<DownloadProgress> {
  return ownApiClient.request<DownloadProgress>("/acquisitions/progress");
}

/** Holds one download in the download client's queue. */
export function pauseAcquisition(id: string): Promise<unknown> {
  return ownApiClient.request(`/acquisitions/${encodeURIComponent(id)}/pause`, {
    method: "POST",
    body: {},
  });
}

export function resumeAcquisition(id: string): Promise<unknown> {
  return ownApiClient.request(
    `/acquisitions/${encodeURIComponent(id)}/resume`,
    { method: "POST", body: {} },
  );
}

/**
 * Moves one download to a place in the download client's queue, counted from
 * 1 as `queuePosition` is, and returns the place it was given.
 */
export async function moveAcquisition(
  id: string,
  position: number,
): Promise<number> {
  const result = await ownApiClient.request<{ position: number }>(
    `/acquisitions/${encodeURIComponent(id)}/move`,
    { method: "POST", body: { position } },
  );
  return result.position;
}

/** Stops or starts the whole download client. */
export function setDownloadClientPaused(paused: boolean): Promise<unknown> {
  return ownApiClient.request(
    `/acquisitions/client/${paused ? "pause" : "resume"}`,
    { method: "POST", body: {} },
  );
}
