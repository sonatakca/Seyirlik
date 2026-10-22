import { ownApiClient } from "../api/ownApi/client";
import type { ReaderPlace } from "../pages/reader/readerModel";

/** Where a reader stands in a book, as the server keeps it for every device. */
export interface BookPosition {
  cfi: string | null;
  place: ReaderPlace | null;
  fraction: number;
  /** When the reader was there, in ms since the epoch. */
  readAt: number;
}

/** The kinds of device a reading session can say it is. */
export type ReaderDevice =
  | "iphone"
  | "ipad"
  | "android"
  | "mac"
  | "windows"
  | "linux";

/**
 * One opening of a book in a page. The copy opened last keeps the reader's
 * place; a save from any other is refused, and says which copy has it.
 */
export interface ReadingSession {
  id: string;
  /** When this copy was opened, in ms since the epoch. */
  openedAt: number;
  device: ReaderDevice | null;
}

interface ReadingSessionDto {
  id: string;
  openedAt: string;
  device: ReaderDevice | null;
}

function sessionFromDto(dto: ReadingSessionDto | null): ReadingSession | null {
  if (!dto) return null;
  const openedAt = Date.parse(dto.openedAt);
  return Number.isFinite(openedAt) ? { ...dto, openedAt } : null;
}

function sessionBody(session: ReadingSession) {
  return {
    id: session.id,
    openedAt: Math.round(session.openedAt),
    ...(session.device ? { device: session.device } : {}),
  };
}

/** What kind of device this is, as far as the browser lets on. */
export function readerDevice(): ReaderDevice | null {
  if (typeof navigator === "undefined") return null;
  const ua = navigator.userAgent;
  if (/iPhone|iPod/.test(ua)) return "iphone";
  // iPadOS asks for the desktop site and says Macintosh; it has touch.
  if (
    /iPad/.test(ua) ||
    (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)
  ) {
    return "ipad";
  }
  if (/Android/.test(ua)) return "android";
  if (/Macintosh|Mac OS X/.test(ua)) return "mac";
  if (/Windows/.test(ua)) return "windows";
  if (/Linux|X11|CrOS/.test(ua)) return "linux";
  return null;
}

interface BookPositionDto {
  cfi: string | null;
  place: ReaderPlace | null;
  fraction: number;
  readAt: string;
}

function fromDto(dto: BookPositionDto | null): BookPosition | null {
  if (!dto) return null;
  const readAt = Date.parse(dto.readAt);
  return Number.isFinite(readAt) ? { ...dto, readAt } : null;
}

export async function getBookPosition(
  itemId: string,
  options: { signal?: AbortSignal } = {},
): Promise<BookPosition | null> {
  return fromDto(
    await ownApiClient.request<BookPositionDto | null>(
      `/books/${encodeURIComponent(itemId)}/position`,
      { signal: options.signal, background: true },
    ),
  );
}

/**
 * Says this copy of the book is open. It keeps the place unless a copy
 * opened later does; the reply says which copy keeps it.
 */
export async function claimBookSession(
  itemId: string,
  session: ReadingSession,
): Promise<{ owner: boolean; session: ReadingSession | null }> {
  const result = await ownApiClient.request<{
    owner: boolean;
    session: ReadingSessionDto | null;
  }>(`/books/${encodeURIComponent(itemId)}/session`, {
    method: "PUT",
    background: true,
    body: sessionBody(session),
  });
  return { owner: result.owner, session: sessionFromDto(result.session) };
}

/**
 * Saves the place for this copy of the book. Refused when another copy,
 * opened later, keeps it (`superseded` says which); otherwise a later place
 * already saved wins. The reply carries whichever place is now on record.
 */
export async function saveBookPosition(
  itemId: string,
  position: BookPosition,
  options: { keepalive?: boolean; session?: ReadingSession } = {},
): Promise<{
  accepted: boolean;
  position: BookPosition | null;
  superseded: ReadingSession | null;
}> {
  const result = await ownApiClient.request<{
    accepted: boolean;
    position: BookPositionDto | null;
    superseded?: ReadingSessionDto | null;
  }>(`/books/${encodeURIComponent(itemId)}/position`, {
    method: "PUT",
    background: true,
    keepalive: options.keepalive,
    body: {
      ...(position.cfi ? { cfi: position.cfi } : {}),
      ...(position.place ? { place: position.place } : {}),
      fraction: position.fraction,
      readAt: Math.round(position.readAt),
      ...(options.session ? { session: sessionBody(options.session) } : {}),
    },
  });
  return {
    accepted: result.accepted,
    position: fromDto(result.position),
    superseded: sessionFromDto(result.superseded ?? null),
  };
}
