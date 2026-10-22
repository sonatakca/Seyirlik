import { useCallback, useEffect, useRef, useState } from "react";
import { OwnApiClientError } from "../../api/ownApi/client";
import {
  getBookMarks,
  MAX_MARK_CHANGES,
  sendBookMarkChanges,
  type BookMarkChange,
} from "../../lib/bookMarkApi";
import { getCachedSession } from "../../lib/authStorage";
import {
  HIGHLIGHT_COLORS,
  READER_BOOKMARKS_KEY,
  readJsonStorage,
  writeJsonStorage,
  type ReaderBookmark,
  type ReaderBookmarkMap,
} from "./readerModel";

/*
 * Bookmarks and highlights belong to the account and are kept by the server,
 * so every device signed in to it shows the same ones. This device holds the
 * last list the server sent and every change it has not yet confirmed, so a
 * mark made offline is there at once and reaches the server when it can.
 */

/**
 * While a book is open its marks and place are sent and fetched this often,
 * so every device of the account stays in step without the book being left.
 */
export const READER_SYNC_MS = 20_000;

/** Per account and book: `${userId}:${itemId}`. */
export const READER_MARKS_KEY = "seyirlik.reader.marks";

interface StoredMarks {
  /** The marks as the server last sent them. */
  marks: ReaderBookmark[];
  /** Changes made here the server has not confirmed, oldest first. */
  pending: BookMarkChange[];
}

type StoredMarksMap = Record<string, StoredMarks>;

/** Malformed, too large, invalid: a request refused for what it carries. */
const REFUSED_STATUSES = new Set([400, 413, 422]);

/** The earliest moment the server accepts; see bookMarkRoutes. */
const EARLIEST_MARK_AT = Date.UTC(2020, 0, 1);

function isMark(value: unknown): value is ReaderBookmark {
  const mark = value as ReaderBookmark | null;
  return (
    typeof mark?.id === "string" &&
    /^[A-Za-z0-9_-]{1,64}$/.test(mark.id) &&
    typeof mark.cfi === "string" &&
    (mark.color === undefined || HIGHLIGHT_COLORS.includes(mark.color))
  );
}

/** A mark kept before marks were synced, made whole enough to send. */
function legacyMark(mark: ReaderBookmark): ReaderBookmark {
  const createdAt =
    Number.isFinite(mark.createdAt) && mark.createdAt >= EARLIEST_MARK_AT
      ? Math.min(mark.createdAt, Date.now())
      : Date.now();
  return {
    ...mark,
    label: typeof mark.label === "string" ? mark.label : "",
    excerpt: typeof mark.excerpt === "string" ? mark.excerpt : "",
    progress: typeof mark.progress === "number" ? mark.progress : null,
    createdAt,
  };
}

function marksKey(itemId: string): string {
  return `${getCachedSession()?.userId ?? ""}:${itemId}`;
}

function readStored(itemId: string): StoredMarks {
  const map = readJsonStorage<StoredMarksMap>(READER_MARKS_KEY, {});
  const key = marksKey(itemId);
  const entry = map[key];
  const stored: StoredMarks = {
    marks: Array.isArray(entry?.marks) ? entry.marks.filter(isMark) : [],
    pending: Array.isArray(entry?.pending)
      ? entry.pending.filter(
          (change) =>
            typeof change?.id === "string" &&
            Number.isFinite(change.changedAt) &&
            (change.mark === null || isMark(change.mark)),
        )
      : [],
  };

  // Marks from before they were synced lived on this device alone, under the
  // book only. The first account to open the book here takes them to the
  // server, dated when they were made: a mark another device has since
  // removed stays removed.
  const legacy = readJsonStorage<ReaderBookmarkMap>(READER_BOOKMARKS_KEY, {});
  const old = legacy[itemId];
  if (old !== undefined) {
    if (Array.isArray(old)) {
      for (const mark of old.filter(isMark).map(legacyMark)) {
        if (!stored.pending.some((change) => change.id === mark.id)) {
          stored.pending.push({ id: mark.id, changedAt: mark.createdAt, mark });
        }
      }
    }
    delete legacy[itemId];
    writeJsonStorage(READER_BOOKMARKS_KEY, legacy);
    writeStored(itemId, stored);
  }

  return stored;
}

function writeStored(itemId: string, stored: StoredMarks): void {
  const map = readJsonStorage<StoredMarksMap>(READER_MARKS_KEY, {});
  const key = marksKey(itemId);
  if (stored.marks.length > 0 || stored.pending.length > 0) {
    map[key] = stored;
  } else {
    delete map[key];
  }
  writeJsonStorage(READER_MARKS_KEY, map);
}

function byPlace(a: ReaderBookmark, b: ReaderBookmark): number {
  return (
    (a.progress ?? 0) - (b.progress ?? 0) ||
    a.createdAt - b.createdAt ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

/** The marks to show: the server's, with this device's unsent changes on top. */
export function viewMarks(stored: StoredMarks): ReaderBookmark[] {
  const marks = new Map(stored.marks.map((mark) => [mark.id, mark]));
  for (const { id, mark } of stored.pending) {
    if (mark) {
      marks.set(id, mark);
    } else {
      marks.delete(id);
    }
  }
  return [...marks.values()].sort(byPlace);
}

function sameMark(a: ReaderBookmark, b: ReaderBookmark): boolean {
  return (
    a.cfi === b.cfi &&
    a.label === b.label &&
    a.excerpt === b.excerpt &&
    a.progress === b.progress &&
    a.color === b.color &&
    a.createdAt === b.createdAt
  );
}

/** The changes that turn one list of marks into another. */
export function diffMarks(
  before: readonly ReaderBookmark[],
  after: readonly ReaderBookmark[],
  changedAt: number,
): BookMarkChange[] {
  const old = new Map(before.map((mark) => [mark.id, mark]));
  const changes: BookMarkChange[] = [];
  for (const mark of after) {
    const previous = old.get(mark.id);
    old.delete(mark.id);
    if (!previous || !sameMark(previous, mark)) {
      changes.push({ id: mark.id, changedAt, mark: { ...mark, changedAt } });
    }
  }
  for (const id of old.keys()) {
    changes.push({ id, changedAt, mark: null });
  }
  return changes;
}

function isSent(change: BookMarkChange, sent: readonly BookMarkChange[]) {
  return sent.some(
    (entry) => entry.id === change.id && entry.changedAt === change.changedAt,
  );
}

/**
 * The account's bookmarks and highlights in a book. `commit` turns the list
 * into a new one and sends only what changed; `sync` sends what is unsent and takes
 * whatever other devices have changed since.
 */
export function useReaderMarks(itemId: string | undefined): {
  marks: ReaderBookmark[];
  commit: (change: (current: ReaderBookmark[]) => ReaderBookmark[]) => void;
  sync: (options?: { keepalive?: boolean }) => void;
} {
  const [marks, setMarks] = useState<ReaderBookmark[]>([]);
  const itemRef = useRef(itemId);
  // A sync that brings nothing new keeps the same list, so the highlights
  // are not painted again every time the marks are fetched.
  const showMarks = useCallback((next: ReaderBookmark[]) => {
    setMarks((current) =>
      current.length === next.length &&
      current.every((mark, index) => {
        const other = next[index];
        return mark.id === other.id && sameMark(mark, other);
      })
        ? current
        : next,
    );
  }, []);
  const flightRef = useRef<{ again: boolean } | null>(null);

  const sync = useCallback(
    (options: { keepalive?: boolean } = {}) => {
      const item = itemRef.current;
      if (!item) {
        return;
      }
      // One exchange at a time per page; a change made meanwhile goes next.
      if (flightRef.current) {
        flightRef.current.again = true;
        return;
      }
      const flight = { again: false };
      flightRef.current = flight;

      void (async () => {
        try {
          for (;;) {
            const sent = readStored(item).pending.slice(0, MAX_MARK_CHANGES);
            let server: ReaderBookmark[];
            try {
              server =
                sent.length > 0
                  ? await sendBookMarkChanges(item, sent, options)
                  : await getBookMarks(item);
            } catch (error) {
              // A change the server refuses as invalid can never be stored, and
              // would hold back every change after it. Anything else (offline,
              // signed out, the server down) is tried again later.
              if (
                !(error instanceof OwnApiClientError) ||
                !REFUSED_STATUSES.has(error.status) ||
                sent.length === 0
              ) {
                return;
              }
              const stored = readStored(item);
              stored.pending = stored.pending.filter(
                (change) => !isSent(change, sent),
              );
              writeStored(item, stored);
              continue;
            }

            // Read again: changes made while this was in flight stay unsent.
            const stored = readStored(item);
            stored.marks = server;
            stored.pending = stored.pending.filter(
              (change) => !isSent(change, sent),
            );
            writeStored(item, stored);
            if (itemRef.current === item) {
              showMarks(viewMarks(stored));
            }
            if (stored.pending.length === 0 || sent.length === 0) {
              return;
            }
          }
        } finally {
          flightRef.current = null;
          if (flight.again) {
            sync();
          }
        }
      })();
    },
    [showMarks],
  );

  const commit = useCallback(
    (change: (current: ReaderBookmark[]) => ReaderBookmark[]) => {
      const item = itemRef.current;
      if (!item) {
        return;
      }
      // From the list as stored now, never as last rendered: a mark another
      // device sent a moment ago must not read as one removed here.
      const stored = readStored(item);
      const current = viewMarks(stored);
      const changes = diffMarks(current, change(current), Date.now());
      if (changes.length === 0) {
        return;
      }
      stored.pending = [
        ...stored.pending.filter(
          (change) => !changes.some((entry) => entry.id === change.id),
        ),
        ...changes,
      ];
      writeStored(item, stored);
      setMarks(viewMarks(stored));
      sync();
    },
    [sync],
  );

  useEffect(() => {
    itemRef.current = itemId;
    setMarks(itemId ? viewMarks(readStored(itemId)) : []);
    if (!itemId) {
      return undefined;
    }
    sync();

    // Back on the page, or back online: take what other devices changed.
    // Leaving it: send what is unsent while the page can still send.
    const handleVisibility = () => {
      if (document.visibilityState === "hidden") {
        if (readStored(itemId).pending.length > 0) {
          sync({ keepalive: true });
        }
      } else {
        sync();
      }
    };
    const handleOnline = () => sync();
    // While the book is open: what failed to send goes again, and what other
    // devices changed arrives without the page having to be left first.
    const handleInterval = () => {
      if (document.visibilityState === "visible") {
        sync();
      }
    };
    const syncTimer = window.setInterval(handleInterval, READER_SYNC_MS);
    // Another tab of this browser changed them.
    const handleStorage = (event: StorageEvent) => {
      if (event.key === READER_MARKS_KEY) {
        setMarks(viewMarks(readStored(itemId)));
      }
    };
    document.addEventListener("visibilitychange", handleVisibility);
    window.addEventListener("online", handleOnline);
    window.addEventListener("focus", handleInterval);
    window.addEventListener("storage", handleStorage);
    return () => {
      window.clearInterval(syncTimer);
      window.removeEventListener("focus", handleInterval);
      document.removeEventListener("visibilitychange", handleVisibility);
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("storage", handleStorage);
    };
  }, [itemId, sync]);

  return { marks, commit, sync };
}
