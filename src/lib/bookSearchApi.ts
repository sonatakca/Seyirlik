import { ownApiClient } from "../api/ownApi/client";

/** A passage that answers the search, and where it starts. */
export interface BookSearchHit {
  /** The spine position, as epub.js numbers sections. */
  section: number;
  /** The block it starts in, as `getEpubBlocks` numbers them. */
  block: number;
  /** The start of the passage's text in that block, to check the block by. */
  anchor: string;
  text: string;
  /**
   * Where in its section the passage starts, 0 to 1; missing from a server
   * older than it.
   */
  place?: number;
  score: number;
}

/** What a search found in the words of its hits, to mark (`markText`). */
export interface BookSearchFound {
  terms: string[];
  phrase: string[];
  /** A quoted search: words marked only as written. */
  exact?: boolean;
}

export type BookSearchOutcome =
  /** `terms` and `phrase` are missing from a server older than marking. */
  | ({ state: "ready"; hits: BookSearchHit[] } & Partial<BookSearchFound>)
  /** The book is being read for the first time; ask again shortly. */
  | { state: "preparing"; progress: number | null }
  | { state: "unavailable"; reason: string };

/**
 * Searches a book by meaning and by its words. An empty query only asks the server to prepare
 * the book, which it does once, in the background, in a few minutes.
 */
export function searchBook(
  itemId: string,
  query: string,
  options: { signal?: AbortSignal } = {},
): Promise<BookSearchOutcome> {
  return ownApiClient.request<BookSearchOutcome>(
    `/books/${encodeURIComponent(itemId)}/search`,
    {
      method: "POST",
      background: true,
      signal: options.signal,
      body: { query },
    },
  );
}
