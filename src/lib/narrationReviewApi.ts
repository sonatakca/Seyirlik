import { ownApiClient } from "../api/ownApi/client";
import type { BookNarration, NarrationState } from "./bookNarrationApi";

/** Why the narrator did not take a line as it should have been (verify.py, Verdict.reasons). */
export type NarrationLineReason =
  | "length"
  | "skipped-words"
  | "pronunciation"
  | "tone";

/** One line of a narration: the book's text beside what the narrator heard in it. */
export interface NarrationReviewLine {
  chunk: string;
  block: number;
  start: number;
  end: number;
  /** The book's text of the line. */
  text: string;
  /** Where it is heard in its section's audio, and for how long, in ms. */
  at: number;
  duration: number;
  /** What Whisper heard, knowing nothing of the text. */
  heard: string;
  /** What the voice was given, where a pronunciation changed the book's words. */
  spoken: string | null;
  match: number;
  /** How much louder its last words were than its middle one, in dB. */
  lift: number | null;
  reasons: NarrationLineReason[];
  /** Words the aligner was unsure were said as written, in the block's characters. */
  unsure: Array<[number, number]>;
  takes: number;
  /** The times it had been asked for again when this reading was made... */
  retakes: number;
  /** ...and the times it has been asked for now: more is a reading on its way. */
  asked: number;
  /** A person listened to this very reading and found it right. */
  approved: boolean;
}

export interface NarrationReviewSection {
  section: number;
  duration: number;
  version: string;
  /** Null when the narrator has not sent this upload's lines. */
  lines: NarrationReviewLine[] | null;
}

export interface NarrationPronunciation {
  /** The word as it is looked up: written, in lower case, without a suffix. */
  word: string;
  spoken: string;
  updatedAt: string;
}

export interface NarrationReview {
  narration: BookNarration;
  sections: NarrationReviewSection[];
  pronunciations: NarrationPronunciation[];
}

export interface NarratedBook {
  itemId: string;
  title: string;
  state: NarrationState;
  sections: number;
  /** Seconds of audio. */
  duration: number;
  requestedAt: string;
}

export function getNarratedBooks(): Promise<NarratedBook[]> {
  return ownApiClient.request<NarratedBook[]>("/admin/narrations");
}

export function getNarrationReview(
  itemId: string,
  options: { signal?: AbortSignal } = {},
): Promise<NarrationReview> {
  return ownApiClient.request<NarrationReview>(
    `/admin/books/${encodeURIComponent(itemId)}/narration/review`,
    { signal: options.signal },
  );
}

/** Asks for a line to be read again; the narrator reads it, and only it, next. */
export function requestNarrationRetake(
  itemId: string,
  chunk: string,
): Promise<{ chunk: string; count: number }> {
  return ownApiClient.request(
    `/admin/books/${encodeURIComponent(itemId)}/narration/retakes`,
    { method: "POST", body: { chunk } },
  );
}

/** Takes the line, as it is heard now, as right: it is no longer one to listen to. */
export function approveNarrationLine(
  itemId: string,
  chunk: string,
): Promise<{ chunk: string; approved: boolean }> {
  return ownApiClient.request(
    `/admin/books/${encodeURIComponent(itemId)}/narration/approvals/${encodeURIComponent(chunk)}`,
    { method: "PUT" },
  );
}

export function unapproveNarrationLine(
  itemId: string,
  chunk: string,
): Promise<{ chunk: string; approved: boolean }> {
  return ownApiClient.request(
    `/admin/books/${encodeURIComponent(itemId)}/narration/approvals/${encodeURIComponent(chunk)}`,
    { method: "DELETE" },
  );
}

/** Says the word this way in every book; returns how many books go back to be read where it is. */
export function setNarrationPronunciation(
  word: string,
  spoken: string,
): Promise<{ word: string; spoken: string; books: number }> {
  return ownApiClient.request(
    `/admin/narration/pronunciations/${encodeURIComponent(word)}`,
    { method: "PUT", body: { spoken } },
  );
}

export function removeNarrationPronunciation(
  word: string,
): Promise<{ word: string; books: number }> {
  return ownApiClient.request(
    `/admin/narration/pronunciations/${encodeURIComponent(word)}`,
    { method: "DELETE" },
  );
}
