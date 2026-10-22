import { ownApiClient } from "../api/ownApi/client";
import type {
  HighlightColor,
  ReaderBookmark,
} from "../pages/reader/readerModel";

/** A mark as this device last left it: its content, or null once removed. */
export interface BookMarkChange {
  id: string;
  /** When it changed, in ms since the epoch. */
  changedAt: number;
  mark: ReaderBookmark | null;
}

interface BookMarkDto {
  id: string;
  cfi: string;
  label: string;
  excerpt: string;
  progress: number | null;
  color: HighlightColor | null;
  createdAt: number;
  changedAt: number;
}

/** The server's limits; a change past them could never be stored. */
export const MAX_MARK_CHANGES = 20;
const MAX_LABEL_LENGTH = 500;
const MAX_EXCERPT_LENGTH = 10_000;

function fromDto(dto: BookMarkDto): ReaderBookmark {
  return {
    id: dto.id,
    cfi: dto.cfi,
    label: dto.label,
    excerpt: dto.excerpt,
    progress: dto.progress,
    createdAt: dto.createdAt,
    changedAt: dto.changedAt,
    ...(dto.color ? { color: dto.color } : {}),
  };
}

/** Every bookmark and highlight the account keeps in a book. */
export async function getBookMarks(
  itemId: string,
  options: { signal?: AbortSignal } = {},
): Promise<ReaderBookmark[]> {
  const marks = await ownApiClient.request<BookMarkDto[]>(
    `/books/${encodeURIComponent(itemId)}/marks`,
    { signal: options.signal, background: true },
  );
  return marks.map(fromDto);
}

/**
 * Sends changes (at most MAX_MARK_CHANGES). A later change to the same mark
 * from another device wins; the reply is every mark now on record.
 */
export async function sendBookMarkChanges(
  itemId: string,
  changes: readonly BookMarkChange[],
  options: { keepalive?: boolean } = {},
): Promise<ReaderBookmark[]> {
  const marks = await ownApiClient.request<BookMarkDto[]>(
    `/books/${encodeURIComponent(itemId)}/marks`,
    {
      method: "POST",
      background: true,
      keepalive: options.keepalive,
      body: {
        changes: changes.map(({ id, changedAt, mark }) => ({
          id,
          changedAt: Math.round(changedAt),
          mark: mark && {
            cfi: mark.cfi,
            label: mark.label.slice(0, MAX_LABEL_LENGTH),
            excerpt: mark.excerpt.slice(0, MAX_EXCERPT_LENGTH),
            progress:
              mark.progress === null || !Number.isFinite(mark.progress)
                ? null
                : Math.min(1, Math.max(0, mark.progress)),
            color: mark.color ?? null,
            createdAt: Math.round(mark.createdAt),
          },
        })),
      },
    },
  );
  return marks.map(fromDto);
}
