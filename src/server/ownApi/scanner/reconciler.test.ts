import { describe, expect, it } from "vitest";
import {
  reconcileLibraryScan,
  type CatalogueScanStore,
  type ExistingFileRow,
  type ExistingItemRow,
} from "./reconciler";
import type { ScanResult, ScannedItem } from "./libraryScan";

interface StoredFile extends ExistingFileRow {
  isPrimary: boolean;
}

function createStore(): CatalogueScanStore & {
  items: Map<string, ExistingItemRow & { title: string; libraryId: string }>;
  files: Map<string, StoredFile>;
  probeQueue: string[];
  packaged: string[];
} {
  const items = new Map<
    string,
    ExistingItemRow & { title: string; libraryId: string }
  >();
  const files = new Map<string, StoredFile>();
  const probeQueue: string[] = [];
  const packaged: string[] = [];
  let nextId = 1;

  return {
    items,
    files,
    probeQueue,
    packaged,
    listItems: async (libraryId) =>
      [...items.values()].filter((item) => item.libraryId === libraryId),
    listFiles: async (libraryId) =>
      [...files.values()].filter((file) =>
        [...items.values()].some(
          (item) => item.id === file.itemId && item.libraryId === libraryId,
        ),
      ),
    upsertItem: async (input) => {
      const existing = [...items.values()].find(
        (item) =>
          item.sourceKey === input.sourceKey &&
          item.libraryId === input.libraryId,
      );
      if (existing) {
        if (!input.lockedFields.includes("title")) existing.title = input.title;
        return existing.id;
      }
      const id = `item-${nextId++}`;
      items.set(id, {
        id,
        libraryId: input.libraryId,
        sourceKey: input.sourceKey,
        kind: input.kind,
        title: input.title,
        lockedFields: input.lockedFields,
        missingSince: null,
      });
      return id;
    },
    setItemRelations: async () => undefined,
    upsertFile: async (input) => {
      const existing = [...files.values()].find(
        (file) => file.relativePath === input.relativePath,
      );
      if (existing) {
        const changed = existing.fingerprint !== input.fingerprint;
        existing.fingerprint = input.fingerprint;
        existing.itemId = input.itemId;
        existing.isPrimary = input.isPrimary;
        return { id: existing.id, changed };
      }
      const id = `file-${nextId++}`;
      files.set(id, {
        id,
        itemId: input.itemId,
        relativePath: input.relativePath,
        fingerprint: input.fingerprint,
        isPrimary: input.isPrimary,
        missingSince: null,
      });
      return { id, changed: true };
    },
    replaceExternalSubtitles: async () => undefined,
    markItemsSeen: async (ids) => {
      for (const id of ids) {
        const item = items.get(id);
        if (item) item.missingSince = null;
      }
    },
    markFilesSeen: async (ids) => {
      for (const id of ids) {
        const file = files.get(id);
        if (file) file.missingSince = null;
      }
    },
    markItemsMissing: async (ids, at) => {
      for (const id of ids) {
        const item = items.get(id);
        if (item) item.missingSince = at;
      }
    },
    markFilesMissing: async (ids, at) => {
      for (const id of ids) {
        const file = files.get(id);
        if (file) file.missingSince = at;
      }
    },
    deleteItems: async (ids) => {
      for (const id of ids) items.delete(id);
    },
    deleteFiles: async (ids) => {
      for (const id of ids) files.delete(id);
    },
    queueProbe: async (ids) => {
      probeQueue.push(...ids);
    },
    markPackaged: async (ids) => {
      packaged.push(...ids);
    },
    refreshItemCounts: async () => undefined,
  };
}

function movie(
  sourceKey: string,
  title: string,
  relativePath: string,
  fingerprint = "fp-1",
): ScannedItem {
  return {
    sourceKey,
    kind: "movie",
    title,
    sortTitle: title.toLowerCase(),
    files: [
      {
        relativePath,
        container: "mkv",
        size: 1_000,
        mtimeMs: 1,
        fingerprint,
      },
    ],
    subtitles: [],
  };
}

function renditionBackedMovie(sourceKey: string, title: string): ScannedItem {
  return {
    sourceKey,
    kind: "movie",
    title,
    sortTitle: title.toLowerCase(),
    files: [],
    subtitles: [],
    renditionBacked: true,
  };
}

function scan(items: ScannedItem[]): ScanResult {
  return { items, skipped: [] };
}

const LIBRARY = "library-1";

describe("reconcileLibraryScan", () => {
  it("revives an existing movie and file identity from its complete rendition package", async () => {
    const store = createStore();
    const start = new Date("2026-08-31T00:00:00Z");
    await reconcileLibraryScan({
      store,
      libraryId: LIBRARY,
      scan: scan([
        movie(
          "movie:movies/ford v ferrari (2019)",
          "Ford v Ferrari",
          "Movies/Ford v Ferrari (2019)/Ford v Ferrari (2019).mkv",
        ),
        movie("movie:b", "Heat", "Movies/Heat (1995)/Heat (1995).mkv"),
      ]),
      now: () => start,
    });
    await reconcileLibraryScan({
      store,
      libraryId: LIBRARY,
      scan: scan([
        movie("movie:b", "Heat", "Movies/Heat (1995)/Heat (1995).mkv"),
      ]),
      now: () => start,
    });

    const summary = await reconcileLibraryScan({
      store,
      libraryId: LIBRARY,
      scan: scan([
        renditionBackedMovie(
          "movie:movies/ford v ferrari (2019)",
          "Ford v Ferrari",
        ),
        movie("movie:b", "Heat", "Movies/Heat (1995)/Heat (1995).mkv"),
      ]),
      now: () => start,
    });

    expect(summary.itemsUpdated).toBe(2);
    expect(summary.filesMarkedMissing).toBe(0);
    const ford = [...store.items.values()].find(
      (item) => item.title === "Ford v Ferrari",
    );
    expect(ford?.missingSince).toBeNull();
    const fordFile = [...store.files.values()].find(
      (file) => file.itemId === ford?.id,
    );
    expect(fordFile?.missingSince).toBeNull();
    // Recorded as packaged, so the prober does not mark the vanished source
    // failed and availability does not drop a playable film.
    expect(store.packaged).toEqual([fordFile?.id]);
  });

  it("does not create an unplayable item from a package with no catalogue identity", async () => {
    const store = createStore();
    const summary = await reconcileLibraryScan({
      store,
      libraryId: LIBRARY,
      scan: scan([
        renditionBackedMovie(
          "movie:movies/ford v ferrari (2019)",
          "Ford v Ferrari",
        ),
      ]),
    });

    expect(summary.itemsCreated).toBe(0);
    expect(store.items).toHaveLength(0);
  });

  it("creates items and queues probes on first scan", async () => {
    const store = createStore();
    const summary = await reconcileLibraryScan({
      store,
      libraryId: LIBRARY,
      scan: scan([movie("movie:a", "Alien", "Movies/Alien.mkv")]),
    });

    expect(summary.itemsCreated).toBe(1);
    expect(summary.filesCreated).toBe(1);
    expect(summary.probesQueued).toBe(1);
    expect(store.probeQueue).toHaveLength(1);
  });

  it("is idempotent: a rescan of unchanged content queues no probes", async () => {
    const store = createStore();
    const snapshot = scan([movie("movie:a", "Alien", "Movies/Alien.mkv")]);

    await reconcileLibraryScan({ store, libraryId: LIBRARY, scan: snapshot });
    store.probeQueue.length = 0;
    const second = await reconcileLibraryScan({
      store,
      libraryId: LIBRARY,
      scan: snapshot,
    });

    expect(second.itemsCreated).toBe(0);
    expect(second.itemsUpdated).toBe(1);
    expect(second.probesQueued).toBe(0);
    expect(store.probeQueue).toHaveLength(0);
  });

  it("re-probes a file whose content changed", async () => {
    const store = createStore();
    await reconcileLibraryScan({
      store,
      libraryId: LIBRARY,
      scan: scan([movie("movie:a", "Alien", "Movies/Alien.mkv", "fp-1")]),
    });
    store.probeQueue.length = 0;

    const summary = await reconcileLibraryScan({
      store,
      libraryId: LIBRARY,
      scan: scan([movie("movie:a", "Alien", "Movies/Alien.mkv", "fp-2")]),
    });

    expect(summary.filesChanged).toBe(1);
    expect(store.probeQueue).toHaveLength(1);
  });

  it("does not overwrite a locked field", async () => {
    const store = createStore();
    await reconcileLibraryScan({
      store,
      libraryId: LIBRARY,
      scan: scan([movie("movie:a", "Scanned Title", "Movies/a.mkv")]),
    });

    const stored = [...store.items.values()][0];
    if (!stored) throw new Error("item was not created");
    stored.lockedFields = ["title"];
    stored.title = "Curated Title";

    await reconcileLibraryScan({
      store,
      libraryId: LIBRARY,
      scan: scan([movie("movie:a", "Scanned Title Again", "Movies/a.mkv")]),
    });

    expect(stored.title).toBe("Curated Title");
  });

  it("marks a vanished item missing before deleting it", async () => {
    const store = createStore();
    const start = new Date("2026-01-01T00:00:00Z");

    await reconcileLibraryScan({
      store,
      libraryId: LIBRARY,
      scan: scan([
        movie("movie:a", "Alien", "Movies/a.mkv"),
        movie("movie:b", "Aliens", "Movies/b.mkv"),
      ]),
      now: () => start,
    });

    const afterFirstRemoval = await reconcileLibraryScan({
      store,
      libraryId: LIBRARY,
      scan: scan([movie("movie:a", "Alien", "Movies/a.mkv")]),
      now: () => start,
    });

    expect(afterFirstRemoval.itemsMarkedMissing).toBe(1);
    expect(afterFirstRemoval.itemsDeleted).toBe(0);
    expect(store.items.size).toBe(2);

    const afterGrace = new Date(start.getTime() + 8 * 24 * 60 * 60 * 1_000);
    const afterSecondRemoval = await reconcileLibraryScan({
      store,
      libraryId: LIBRARY,
      scan: scan([movie("movie:a", "Alien", "Movies/a.mkv")]),
      now: () => afterGrace,
    });

    expect(afterSecondRemoval.itemsDeleted).toBe(1);
    expect(store.items.size).toBe(1);
  });

  it("never removes a title that is wanted rather than found", async () => {
    /*
     * A desired item is absent from every scan by definition — nothing is on
     * disk yet. Without the exemption it would be marked missing on the first
     * pass and deleted on the second, taking the monitoring, the profile and
     * the intent with it, which is exactly what migrating away from Radarr
     * would otherwise have destroyed.
     */
    const store = createStore();
    const start = new Date("2026-01-01T00:00:00Z");
    store.items.set("wanted-1", {
      id: "wanted-1",
      libraryId: LIBRARY,
      sourceKey: "movie:movies/oppenheimer (2023)",
      kind: "movie",
      title: "Oppenheimer",
      lockedFields: [],
      missingSince: null,
      desired: true,
    });

    const first = await reconcileLibraryScan({
      store,
      libraryId: LIBRARY,
      scan: scan([movie("movie:a", "Alien", "Movies/a.mkv")]),
      now: () => start,
    });
    expect(first.itemsMarkedMissing).toBe(0);

    const wellAfterGrace = new Date(
      start.getTime() + 90 * 24 * 60 * 60 * 1_000,
    );
    const later = await reconcileLibraryScan({
      store,
      libraryId: LIBRARY,
      scan: scan([movie("movie:a", "Alien", "Movies/a.mkv")]),
      now: () => wellAfterGrace,
    });
    expect(later.itemsDeleted).toBe(0);
    expect(store.items.has("wanted-1")).toBe(true);
  });

  it("still removes an ordinary item whose files really went away", async () => {
    // The exemption must be about being wanted, not about being fileless.
    const store = createStore();
    const start = new Date("2026-01-01T00:00:00Z");
    await reconcileLibraryScan({
      store,
      libraryId: LIBRARY,
      scan: scan([
        movie("movie:a", "Alien", "Movies/a.mkv"),
        movie("movie:b", "Aliens", "Movies/b.mkv"),
      ]),
      now: () => start,
    });
    await reconcileLibraryScan({
      store,
      libraryId: LIBRARY,
      scan: scan([movie("movie:a", "Alien", "Movies/a.mkv")]),
      now: () => start,
    });
    const afterGrace = new Date(start.getTime() + 8 * 24 * 60 * 60 * 1_000);
    const result = await reconcileLibraryScan({
      store,
      libraryId: LIBRARY,
      scan: scan([movie("movie:a", "Alien", "Movies/a.mkv")]),
      now: () => afterGrace,
    });
    expect(result.itemsDeleted).toBe(1);
  });

  it("attaches media to the same row when a wanted title arrives", async () => {
    /*
     * The point of reserving the scanner's own key: the import is an update to
     * the existing row, not a second one to reconcile against it.
     */
    const store = createStore();
    store.items.set("wanted-2", {
      id: "wanted-2",
      libraryId: LIBRARY,
      sourceKey: "movie:movies/oppenheimer (2023)",
      kind: "movie",
      title: "Oppenheimer",
      lockedFields: [],
      missingSince: null,
      desired: true,
    });

    const result = await reconcileLibraryScan({
      store,
      libraryId: LIBRARY,
      scan: scan([
        movie(
          "movie:movies/oppenheimer (2023)",
          "Oppenheimer",
          "Movies/Oppenheimer (2023)/Oppenheimer (2023).mkv",
        ),
      ]),
      now: () => new Date("2026-01-02T00:00:00Z"),
    });

    expect(result.itemsCreated).toBe(0);
    expect(result.itemsUpdated).toBe(1);
    expect(store.items.size).toBe(1);
    const files = [...store.files.values()];
    expect(files).toHaveLength(1);
    expect(files[0]!.itemId).toBe("wanted-2");
  });

  it("suppresses removals when most of the library disappears at once", async () => {
    const store = createStore();
    await reconcileLibraryScan({
      store,
      libraryId: LIBRARY,
      scan: scan([
        movie("movie:a", "A", "Movies/a.mkv"),
        movie("movie:b", "B", "Movies/b.mkv"),
        movie("movie:c", "C", "Movies/c.mkv"),
        movie("movie:d", "D", "Movies/d.mkv"),
      ]),
    });

    const summary = await reconcileLibraryScan({
      store,
      libraryId: LIBRARY,
      scan: scan([movie("movie:a", "A", "Movies/a.mkv")]),
    });

    expect(summary.removalsSuppressed).toBe(true);
    expect(summary.itemsMarkedMissing).toBe(0);
    expect(store.items.size).toBe(4);
  });

  it("applies a large removal when an administrator forces it", async () => {
    const store = createStore();
    await reconcileLibraryScan({
      store,
      libraryId: LIBRARY,
      scan: scan([
        movie("movie:a", "A", "Movies/a.mkv"),
        movie("movie:b", "B", "Movies/b.mkv"),
        movie("movie:c", "C", "Movies/c.mkv"),
      ]),
    });

    const summary = await reconcileLibraryScan({
      store,
      libraryId: LIBRARY,
      scan: scan([movie("movie:a", "A", "Movies/a.mkv")]),
      allowMassRemoval: true,
    });

    expect(summary.removalsSuppressed).toBe(false);
    expect(summary.itemsMarkedMissing).toBe(2);
  });

  it("clears the missing marker when a file comes back", async () => {
    const store = createStore();
    const start = new Date("2026-01-01T00:00:00Z");
    const full = scan([
      movie("movie:a", "A", "Movies/a.mkv"),
      movie("movie:b", "B", "Movies/b.mkv"),
    ]);

    await reconcileLibraryScan({
      store,
      libraryId: LIBRARY,
      scan: full,
      now: () => start,
    });
    await reconcileLibraryScan({
      store,
      libraryId: LIBRARY,
      scan: scan([movie("movie:a", "A", "Movies/a.mkv")]),
      now: () => start,
    });
    expect(
      [...store.items.values()].some((item) => item.missingSince !== null),
    ).toBe(true);

    await reconcileLibraryScan({
      store,
      libraryId: LIBRARY,
      scan: full,
      now: () => start,
    });
    expect(
      [...store.items.values()].every((item) => item.missingSince === null),
    ).toBe(true);
  });

  it("only hides a vanished title when deletion is off, however long it stays gone", async () => {
    const store = createStore();
    const start = new Date("2026-01-01T00:00:00Z");
    const full = scan([
      movie("movie:a", "Alien", "Movies/a.mkv"),
      movie("movie:b", "Aliens", "Movies/b.mkv"),
    ]);
    const partial = scan([movie("movie:a", "Alien", "Movies/a.mkv")]);
    await reconcileLibraryScan({ store, libraryId: LIBRARY, scan: full });

    const marked = await reconcileLibraryScan({
      store,
      libraryId: LIBRARY,
      scan: partial,
      deleteMissing: false,
      now: () => start,
    });
    expect(marked.itemsMarkedMissing).toBe(1);
    expect(marked.filesMarkedMissing).toBe(1);

    const muchLater = new Date(start.getTime() + 90 * 24 * 60 * 60 * 1_000);
    const later = await reconcileLibraryScan({
      store,
      libraryId: LIBRARY,
      scan: partial,
      deleteMissing: false,
      now: () => muchLater,
    });
    expect(later.itemsDeleted).toBe(0);
    expect(later.filesDeleted).toBe(0);
    expect(store.items.size).toBe(2);
    expect(store.files.size).toBe(2);

    await reconcileLibraryScan({
      store,
      libraryId: LIBRARY,
      scan: full,
      deleteMissing: false,
      now: () => muchLater,
    });
    expect(
      [...store.files.values()].every((file) => file.missingSince === null),
    ).toBe(true);
  });

  it("measures mass disappearance against files that were still present", async () => {
    const store = createStore();
    await reconcileLibraryScan({
      store,
      libraryId: LIBRARY,
      scan: scan([
        movie("movie:a", "A", "Movies/a.mkv"),
        movie("movie:b", "B", "Movies/b.mkv"),
        movie("movie:c", "C", "Movies/c.mkv"),
        movie("movie:d", "D", "Movies/d.mkv"),
        movie("movie:e", "E", "Movies/e.mkv"),
      ]),
    });
    // Most of the library is already gone: b, c and d are missing.
    await reconcileLibraryScan({
      store,
      libraryId: LIBRARY,
      scan: scan([
        movie("movie:a", "A", "Movies/a.mkv"),
        movie("movie:e", "E", "Movies/e.mkv"),
      ]),
      allowMassRemoval: true,
    });

    // One of the two that remained goes too. Counting the three already
    // missing would read as 4 of 5 vanishing and suppress the marker.
    const summary = await reconcileLibraryScan({
      store,
      libraryId: LIBRARY,
      scan: scan([movie("movie:a", "A", "Movies/a.mkv")]),
    });
    expect(summary.removalsSuppressed).toBe(false);
    expect(summary.filesMarkedMissing).toBe(1);
  });
});
