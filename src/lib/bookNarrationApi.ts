import {
  OwnApiClientError,
  ownApiClient,
  ownApiUrl,
} from "../api/ownApi/client";

/**
 * A word the narrator said: its block in the section (as `getEpubBlocks`
 * counts them), its characters in that block's `epubBlockText`, and when it
 * is heard in the section's audio, in ms.
 */
export type NarrationWord = [
  block: number,
  start: number,
  end: number,
  t0: number,
  t1: number,
];

export interface NarrationSectionInfo {
  /** The section's position in the spine, as epub.js numbers it. */
  section: number;
  /** Seconds of audio. */
  duration: number;
  /** Names this upload of the section, in its files' URLs. */
  version: string;
}

/**
 * Queued until the narrator takes it, narrating while it reads (sections
 * can be played as they arrive), then ready or failed. Outdated: read from
 * another edition of the book, or a script the server no longer gives.
 */
export type NarrationState =
  | "queued"
  | "narrating"
  | "ready"
  | "failed"
  | "outdated";

export interface NarrationProgress {
  /** How much of the book is read, 0 to 1. */
  fraction: number;
  sectionsDone: number;
  sectionsTotal: number;
  etaSeconds: number | null;
  activity: string | null;
}

/** A book's narration: where it stands, and the sections there are to play, in reading order. */
export interface BookNarration {
  version: number;
  state: NarrationState;
  voice: string | null;
  /** ISO 8601. */
  requestedAt: string;
  finishedAt: string | null;
  progress: NarrationProgress | null;
  error: string | null;
  /** When the narrator last asked for work; told to an administrator only. */
  narratorSeenAt?: string | null;
  sections: NarrationSectionInfo[];
}

/** One section's word timings, as the narrator writes them (`<n>.words.json`). */
export interface NarrationTimings {
  version: number;
  section: number;
  duration: number;
  /** In the order they are heard. */
  words: NarrationWord[];
}

const narrationPath = (itemId: string) =>
  `/books/${encodeURIComponent(itemId)}/narration`;

/** The book's narration, or null when it has none. */
export async function getBookNarration(
  itemId: string,
  options: { signal?: AbortSignal } = {},
): Promise<BookNarration | null> {
  try {
    return await ownApiClient.request<BookNarration>(narrationPath(itemId), {
      signal: options.signal,
      background: true,
    });
  } catch (error) {
    if (error instanceof OwnApiClientError && error.status === 404) {
      return null;
    }
    throw error;
  }
}

/** When a narrator last asked for work, or null if none ever has (for an administrator). */
export async function getNarratorSeenAt(): Promise<string | null> {
  const presence = await ownApiClient.request<{ seenAt: string | null }>(
    "/admin/narrator",
    { background: true },
  );
  return presence.seenAt;
}

/** Asks the narrator to read the book (an administrator's request). */
export function requestBookNarration(itemId: string): Promise<BookNarration> {
  return ownApiClient.request<BookNarration>(narrationPath(itemId), {
    method: "POST",
  });
}

/** Takes the narration away with its audio (an administrator's request). */
export async function removeBookNarration(itemId: string): Promise<void> {
  await ownApiClient.request(narrationPath(itemId), { method: "DELETE" });
}

export function getNarrationTimings(
  itemId: string,
  section: NarrationSectionInfo,
  options: { signal?: AbortSignal } = {},
): Promise<NarrationTimings> {
  return ownApiClient.request<NarrationTimings>(
    `${narrationPath(itemId)}/sections/${section.section}/words?v=${encodeURIComponent(section.version)}`,
    { signal: options.signal, background: true },
  );
}

/** The section's audio; its URL names the upload, so a replaced section is fetched afresh. */
export function getNarrationAudioUrl(
  itemId: string,
  section: NarrationSectionInfo,
): string {
  return ownApiUrl(
    `/ownAPI/v1${narrationPath(itemId)}/sections/${section.section}/audio?v=${encodeURIComponent(section.version)}`,
  );
}
