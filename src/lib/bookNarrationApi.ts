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
}

/** A book's narration: the sections it has audio for, in reading order. */
export interface BookNarration {
  version: number;
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
    const narration = await ownApiClient.request<BookNarration>(
      narrationPath(itemId),
      { signal: options.signal, background: true },
    );
    return narration.sections.length > 0 ? narration : null;
  } catch (error) {
    if (error instanceof OwnApiClientError && error.status === 404) {
      return null;
    }
    throw error;
  }
}

export function getNarrationTimings(
  itemId: string,
  section: number,
  options: { signal?: AbortSignal } = {},
): Promise<NarrationTimings> {
  return ownApiClient.request<NarrationTimings>(
    `${narrationPath(itemId)}/sections/${section}/words`,
    { signal: options.signal, background: true },
  );
}

export function getNarrationAudioUrl(itemId: string, section: number): string {
  return ownApiUrl(
    `/ownAPI/v1${narrationPath(itemId)}/sections/${section}/audio`,
  );
}
