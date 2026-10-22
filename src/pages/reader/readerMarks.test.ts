import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { OwnApiClientError } from "../../api/ownApi/client";
import type { BookMarkChange } from "../../lib/bookMarkApi";
import { setCachedSession } from "../../lib/authStorage";
import {
  READER_BOOKMARKS_KEY,
  isHighlight,
  type ReaderBookmark,
} from "./readerModel";
import {
  READER_MARKS_KEY,
  READER_SYNC_MS,
  diffMarks,
  useReaderMarks,
  viewMarks,
} from "./readerMarks";

const api = vi.hoisted(() => ({
  getBookMarks: vi.fn(),
  sendBookMarkChanges: vi.fn(),
}));
vi.mock("../../lib/bookMarkApi", async (importActual) => ({
  ...(await importActual<typeof import("../../lib/bookMarkApi")>()),
  ...api,
}));

const MADE = Date.UTC(2026, 9, 1);

function mark(id: string, patch: Partial<ReaderBookmark> = {}): ReaderBookmark {
  return {
    id,
    cfi: `epubcfi(/6/4!/4/2/1:${id.length})`,
    label: "Bir",
    excerpt: "Yer",
    progress: 0.1,
    createdAt: MADE,
    ...patch,
  };
}

/** A server that applies changes the way user_book_marks does. */
function fakeServer(initial: ReaderBookmark[] = []) {
  const rows = new Map<
    string,
    { changedAt: number; mark: ReaderBookmark | null }
  >(initial.map((entry) => [entry.id, { changedAt: MADE, mark: entry }]));
  const live = () =>
    [...rows.values()]
      .flatMap((row) => (row.mark ? [row.mark] : []))
      .sort((a, b) => (a.progress ?? 0) - (b.progress ?? 0));
  api.getBookMarks.mockImplementation(async () => live());
  api.sendBookMarkChanges.mockImplementation(
    async (_itemId: string, changes: BookMarkChange[]) => {
      for (const { id, changedAt, mark: next } of changes) {
        const row = rows.get(id);
        if (!row || changedAt >= row.changedAt) {
          rows.set(id, {
            changedAt,
            mark: next && { ...next, changedAt },
          });
        }
      }
      return live();
    },
  );
  return { rows, live };
}

/** The hook's sync interval, fired by hand: as if that much time had passed. */
function captureSyncInterval() {
  const ticks: Array<() => void> = [];
  const real = window.setInterval.bind(window);
  const spy = vi.spyOn(window, "setInterval").mockImplementation(((
    handler: () => void,
    ms?: number,
  ) => {
    if (ms === READER_SYNC_MS) ticks.push(handler);
    return real(handler, ms);
  }) as typeof window.setInterval);
  return {
    tick: () => act(() => ticks.forEach((handler) => handler())),
    restore: () => spy.mockRestore(),
  };
}

describe("reader marks", () => {
  beforeEach(() => {
    localStorage.clear();
    api.getBookMarks.mockReset();
    api.sendBookMarkChanges.mockReset();
    setCachedSession({
      userId: "reader",
      username: "reader",
      displayName: "Reader",
      isAdministrator: false,
    });
  });

  it("finds what changed between two lists, removals included", () => {
    const before = [mark("a"), mark("b"), mark("c")];
    const after = [mark("a"), mark("b", { color: "green" }), mark("d")];
    const changes = diffMarks(before, after, 5);

    expect(
      changes.map(({ id, mark: next }) => [
        id,
        next && (next.color ?? "plain"),
      ]),
    ).toEqual([
      ["b", "green"],
      ["d", "plain"],
      ["c", null],
    ]);
    expect(changes.every((change) => change.changedAt === 5)).toBe(true);
  });

  it("shows the server's marks with unsent changes on top", () => {
    expect(
      viewMarks({
        marks: [mark("a", { progress: 0.5 }), mark("b", { progress: 0.2 })],
        pending: [
          { id: "b", changedAt: 1, mark: null },
          { id: "c", changedAt: 1, mark: mark("c", { progress: 0.9 }) },
        ],
      }).map((entry) => entry.id),
    ).toEqual(["a", "c"]);
  });

  it("opens with the account's marks from the server and keeps them per account", async () => {
    fakeServer([mark("a"), mark("h", { color: "pink", progress: 0.3 })]);
    const { result } = renderHook(() => useReaderMarks("book"));

    await waitFor(() => expect(result.current.marks).toHaveLength(2));
    expect(result.current.marks.map(isHighlight)).toEqual([false, true]);
    expect(
      Object.keys(JSON.parse(localStorage.getItem(READER_MARKS_KEY)!)),
    ).toEqual(["reader:book"]);

    // Another account on this browser sees its own, not these.
    api.getBookMarks.mockResolvedValue([]);
    setCachedSession({
      userId: "other",
      username: "other",
      displayName: "Other",
      isAdministrator: false,
    });
    const other = renderHook(() => useReaderMarks("book"));
    expect(other.result.current.marks).toEqual([]);
  });

  it("sends a change at once, and the list is the server's afterwards", async () => {
    const server = fakeServer([mark("a")]);
    const { result } = renderHook(() => useReaderMarks("book"));
    await waitFor(() => expect(result.current.marks).toHaveLength(1));

    act(() =>
      result.current.commit((current) => [
        ...current,
        mark("h", { color: "yellow", excerpt: "Vurgulanan cümle." }),
      ]),
    );
    // Shown before the server answers.
    expect(result.current.marks.map((entry) => entry.id)).toEqual(["a", "h"]);

    await waitFor(() =>
      expect(server.rows.get("h")?.mark?.excerpt).toBe("Vurgulanan cümle."),
    );
    act(() =>
      result.current.commit((current) =>
        current.filter((entry) => entry.id !== "a"),
      ),
    );
    await waitFor(() => expect(server.rows.get("a")?.mark).toBeNull());
    expect(result.current.marks.map((entry) => entry.id)).toEqual(["h"]);
    expect(
      JSON.parse(localStorage.getItem(READER_MARKS_KEY)!)["reader:book"]
        .pending,
    ).toEqual([]);
  });

  it("keeps a change made offline until the server can take it", async () => {
    const server = fakeServer();
    api.sendBookMarkChanges.mockRejectedValueOnce(
      new OwnApiClientError({ status: 0, code: "NETWORK", message: "offline" }),
    );
    const { result } = renderHook(() => useReaderMarks("book"));
    await waitFor(() => expect(api.getBookMarks).toHaveBeenCalled());

    act(() => result.current.commit((current) => [...current, mark("a")]));
    await waitFor(() =>
      expect(api.sendBookMarkChanges).toHaveBeenCalledTimes(1),
    );
    expect(result.current.marks.map((entry) => entry.id)).toEqual(["a"]);
    expect(server.rows.size).toBe(0);

    act(() => window.dispatchEvent(new Event("online")));
    await waitFor(() => expect(server.rows.get("a")?.mark?.id).toBe("a"));
  });

  it("sends a change that failed again on its own while the book stays open", async () => {
    const interval = captureSyncInterval();
    try {
      const server = fakeServer();
      api.sendBookMarkChanges.mockRejectedValueOnce(
        new OwnApiClientError({ status: 0, code: "NETWORK", message: "down" }),
      );
      const { result } = renderHook(() => useReaderMarks("book"));
      await waitFor(() => expect(api.getBookMarks).toHaveBeenCalled());

      act(() => result.current.commit((current) => [...current, mark("a")]));
      await waitFor(() =>
        expect(api.sendBookMarkChanges).toHaveBeenCalledTimes(1),
      );
      expect(server.rows.size).toBe(0);

      // No tab switch, no "online" event: only time passing.
      interval.tick();
      await waitFor(() => expect(server.rows.get("a")?.mark?.id).toBe("a"));
    } finally {
      interval.restore();
    }
  });

  it("takes another device's marks while the book stays open, and keeps the list when nothing changed", async () => {
    const interval = captureSyncInterval();
    try {
      const server = fakeServer([mark("a")]);
      const { result } = renderHook(() => useReaderMarks("book"));
      await waitFor(() =>
        expect(result.current.marks.map((entry) => entry.id)).toEqual(["a"]),
      );

      server.rows.set("b", {
        changedAt: MADE,
        mark: mark("b", { progress: 0.5 }),
      });
      interval.tick();
      await waitFor(() =>
        expect(result.current.marks.map((entry) => entry.id)).toEqual([
          "a",
          "b",
        ]),
      );

      const shown = result.current.marks;
      const fetches = api.getBookMarks.mock.calls.length;
      interval.tick();
      await waitFor(() =>
        expect(api.getBookMarks.mock.calls.length).toBe(fetches + 1),
      );
      expect(result.current.marks).toBe(shown);
    } finally {
      interval.restore();
    }
  });

  it("drops a change the server refuses as invalid rather than stalling behind it", async () => {
    const server = fakeServer();
    api.sendBookMarkChanges.mockRejectedValueOnce(
      new OwnApiClientError({
        status: 422,
        code: "VALIDATION_FAILED",
        message: "bad",
      }),
    );
    const { result } = renderHook(() => useReaderMarks("book"));
    await waitFor(() => expect(api.getBookMarks).toHaveBeenCalled());

    act(() => result.current.commit((current) => [...current, mark("bad")]));
    await waitFor(() => expect(result.current.marks).toEqual([]));
    act(() => result.current.commit((current) => [...current, mark("good")]));
    await waitFor(() => expect(server.rows.get("good")?.mark?.id).toBe("good"));
  });

  it("takes marks kept on this device before sync to the account, once", async () => {
    localStorage.setItem(
      READER_BOOKMARKS_KEY,
      JSON.stringify({
        book: [
          mark("old"),
          mark("gone", { color: "blue" }),
          mark("teal", { color: "teal" as never }),
        ],
        another: [mark("x")],
      }),
    );
    // Removed on another device after it was made here: it stays removed.
    const server = fakeServer();
    server.rows.set("gone", { changedAt: MADE + 1, mark: null });

    const { result } = renderHook(() => useReaderMarks("book"));
    await waitFor(() => expect(server.rows.get("old")?.mark?.id).toBe("old"));
    await waitFor(() =>
      expect(result.current.marks.map((entry) => entry.id)).toEqual(["old"]),
    );
    expect(server.rows.has("teal")).toBe(false);
    expect(JSON.parse(localStorage.getItem(READER_BOOKMARKS_KEY)!)).toEqual({
      another: [mark("x")],
    });
  });
});
