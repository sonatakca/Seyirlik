// @vitest-environment node
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createBookSearch, type BookToSearch } from "./bookSearch";
import {
  BookUnreadableError,
  type BookSearchProcess,
} from "./bookSearchProcess";
import { EMBEDDING_MODEL } from "./bookSearchProtocol";
import type { BookPassage } from "./bookText";

const DIMENSIONS = EMBEDDING_MODEL.dimensions;

/** A unit vector pointing along one axis: passages and questions that share an axis match. */
function axis(index: number): Float32Array {
  const vector = new Float32Array(DIMENSIONS);
  vector[index] = 1;
  return vector;
}

const PASSAGES: BookPassage[] = [
  { section: 1, block: 0, anchor: "Kar", text: "Kar yağıyordu." },
  { section: 2, block: 4, anchor: "Raif", text: "Raif Efendi sustu." },
  { section: 3, block: 9, anchor: "Maria", text: "Maria Puder güldü." },
];

/** Questions are matched by their first word: "kar" → axis 0, "raif" → 1, "maria" → 2. */
const QUESTION_AXES: Record<string, number> = { kar: 0, raif: 1, maria: 2 };

function fakeEngine(
  overrides: Partial<BookSearchProcess> = {},
): BookSearchProcess & { indexed: string[] } {
  const indexed: string[] = [];
  return {
    indexed,
    index: async (filePath, onProgress) => {
      indexed.push(filePath);
      onProgress(1, 2);
      const vectors = new Float32Array(PASSAGES.length * DIMENSIONS);
      PASSAGES.forEach((_, at) => vectors.set(axis(at), at * DIMENSIONS));
      return { passages: PASSAGES, vectors };
    },
    embedQuery: async (text) =>
      axis(QUESTION_AXES[text.split(" ")[0]!.toLowerCase()] ?? 0),
    close: () => undefined,
    ...overrides,
  };
}

const BOOK: BookToSearch = {
  itemId: "22222222-2222-4222-8222-222222222222",
  filePath: "/media/Books/Madonna.epub",
  sourceKey: "file-1:abc",
};

const OTHER = {
  itemId: "33333333-3333-4333-8333-333333333333",
  filePath: "/media/Books/Prens.epub",
};

async function storage() {
  return mkdtemp(path.join(tmpdir(), "seyirlik-book-search-"));
}

/** Asks until the book is no longer preparing. */
async function settle(
  search: ReturnType<typeof createBookSearch>,
  book = BOOK,
) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const outcome = await search.search(book, "");
    if (outcome.state !== "preparing") return outcome;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("Still preparing.");
}

afterEach(() => {
  vi.useRealTimers();
});

describe("searching a book by meaning", () => {
  it("prepares the book on first ask, then ranks passages by meaning", async () => {
    const engine = fakeEngine();
    const search = createBookSearch({ storageDir: await storage(), engine });

    expect(await search.search(BOOK, "Maria")).toMatchObject({
      state: "preparing",
    });
    expect(await settle(search)).toEqual({
      state: "ready",
      hits: [],
      terms: [],
      phrase: [],
      exact: false,
    });

    const outcome = await search.search(BOOK, "Maria nasıl güldü");
    expect(outcome.state).toBe("ready");
    if (outcome.state !== "ready") return;
    expect(outcome.hits[0]).toMatchObject({
      section: 3,
      block: 9,
      anchor: "Maria",
      text: "Maria Puder güldü.",
    });
    expect(outcome.hits.map((hit) => hit.section)).toEqual([3, 1, 2]);
    // Each passage is the first of its section here, so it starts at 0.
    expect(outcome.hits.map((hit) => hit.place)).toEqual([0, 0, 0]);
    expect(outcome.hits[0]!.score).toBeGreaterThan(outcome.hits[1]!.score);
    // The words it holds, to be marked; "nasıl" is not in the book.
    expect(outcome.terms).toEqual(["maria", "güldü"]);
    expect(engine.indexed).toEqual([BOOK.filePath]);
  });

  it("keeps the index on disk, so a restarted server does not read the book again", async () => {
    const storageDir = await storage();
    await settle(createBookSearch({ storageDir, engine: fakeEngine() }));
    expect(await readdir(storageDir)).toEqual([`${BOOK.itemId}.json`]);

    const restarted = fakeEngine();
    const search = createBookSearch({ storageDir, engine: restarted });
    const outcome = await search.search(BOOK, "Raif");
    expect(outcome.state === "ready" && outcome.hits[0]?.block).toBe(4);
    expect(restarted.indexed).toEqual([]);
  });

  it("reads the book again when its file changes", async () => {
    const storageDir = await storage();
    await settle(createBookSearch({ storageDir, engine: fakeEngine() }));

    const engine = fakeEngine();
    const search = createBookSearch({ storageDir, engine });
    const replaced = { ...BOOK, sourceKey: "file-2:def" };
    expect((await search.search(replaced, "")).state).toBe("preparing");
    await settle(search, replaced);
    expect(engine.indexed).toEqual([BOOK.filePath]);
  });

  it("builds a damaged index again instead of failing", async () => {
    const storageDir = await storage();
    // What a crash before the write reached the disk leaves behind.
    await writeFile(
      path.join(storageDir, `${BOOK.itemId}.json`),
      Buffer.alloc(64),
    );
    const engine = fakeEngine();
    const search = createBookSearch({ storageDir, engine });
    expect((await settle(search)).state).toBe("ready");
    const stored = JSON.parse(
      await readFile(path.join(storageDir, `${BOOK.itemId}.json`), "utf8"),
    );
    expect(stored).toMatchObject({ format: 1, sourceKey: BOOK.sourceKey });
  });

  it("gives up on a book that cannot be read, without trying again", async () => {
    const engine = fakeEngine({
      index: async () => {
        engine.indexed.push("tried");
        throw new BookUnreadableError("This book has no text to search.");
      },
    });
    const search = createBookSearch({
      storageDir: await storage(),
      engine,
      warn: () => undefined,
    });
    expect(await settle(search)).toEqual({
      state: "unavailable",
      reason: "This book has no text to search.",
    });
    expect(await search.search(BOOK, "")).toMatchObject({
      state: "unavailable",
    });
    expect(engine.indexed).toEqual(["tried"]);
  });

  it("tries a failure that may pass again after a few minutes", async () => {
    let attempts = 0;
    const engine = fakeEngine({
      index: async () => {
        attempts++;
        throw new Error("fetch failed");
      },
    });
    const warnings: string[] = [];
    const search = createBookSearch({
      storageDir: await storage(),
      engine,
      warn: (message) => warnings.push(message),
    });
    expect(await settle(search)).toMatchObject({ state: "unavailable" });
    expect(attempts).toBe(1);
    expect(warnings).toEqual([
      "[Seyirlik] book search indexing failed: Error: fetch failed",
    ]);

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 6 * 60_000);
    expect((await search.search(BOOK, "")).state).toBe("preparing");
    vi.useRealTimers();
    await settle(search);
    expect(attempts).toBe(2);
  });

  it("reads one book at a time", async () => {
    let running = 0;
    let most = 0;
    const engine = fakeEngine();
    const index = engine.index;
    engine.index = async (filePath, onProgress) => {
      running++;
      most = Math.max(most, running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running--;
      return index(filePath, onProgress);
    };
    const search = createBookSearch({ storageDir: await storage(), engine });
    const other = {
      itemId: "33333333-3333-4333-8333-333333333333",
      filePath: "/media/Books/Prens.epub",
      sourceKey: "file-3:ghi",
    };
    await Promise.all([search.search(BOOK, ""), search.search(other, "")]);
    await Promise.all([settle(search), settle(search, other)]);
    expect(most).toBe(1);
    // Each search reads the disk before it queues, so either may go first.
    expect([...engine.indexed].sort()).toEqual(
      [BOOK.filePath, other.filePath].sort(),
    );
  });

  it("prepares the library ahead of time, once", async () => {
    const storageDir = await storage();
    const engine = fakeEngine();
    const search = createBookSearch({ storageDir, engine });
    const other = { ...BOOK, itemId: OTHER.itemId, filePath: OTHER.filePath };

    await search.preindex([BOOK, other]);
    await settle(search);
    await settle(search, other);
    expect(engine.indexed).toEqual([BOOK.filePath, OTHER.filePath]);

    // A restarted server finds them prepared on disk.
    const restarted = fakeEngine();
    const again = createBookSearch({ storageDir, engine: restarted });
    await again.preindex([BOOK, other]);
    expect(restarted.indexed).toEqual([]);

    // Known to be current, so a later sweep does not even look at the disk:
    // with the files gone, a sweep that read them would prepare both again.
    await rm(storageDir, { recursive: true });
    await again.preindex([BOOK, other]);
    expect(restarted.indexed).toEqual([]);
  });

  it("reads a book a reader is waiting for before the rest of the library", async () => {
    const releases: Array<() => void> = [];
    const engine = fakeEngine();
    const index = engine.index;
    engine.index = async (filePath, onProgress) => {
      await new Promise<void>((resolve) => releases.push(resolve));
      return index(filePath, onProgress);
    };
    const search = createBookSearch({ storageDir: await storage(), engine });
    const books = ["a", "b", "c"].map((letter, at) => ({
      itemId: `${String(at + 1).repeat(8)}-1111-4111-8111-111111111111`,
      filePath: `/media/Books/${letter}.epub`,
      sourceKey: letter,
    }));

    await search.preindex(books);
    // "a" is being read; a reader opens search in "c".
    expect((await search.search(books[2]!, "")).state).toBe("preparing");
    for (let step = 0; step < 3; step++) {
      await vi.waitFor(() => expect(releases.length).toBe(step + 1));
      releases[step]!();
    }
    await vi.waitFor(() => expect(engine.indexed).toHaveLength(3));
    expect(engine.indexed).toEqual([
      "/media/Books/a.epub",
      "/media/Books/c.epub",
      "/media/Books/b.epub",
    ]);
  });

  it("leaves out of a sweep a book that failed, until it may be tried again", async () => {
    const engine = fakeEngine({
      index: async () => {
        engine.indexed.push("tried");
        throw new BookUnreadableError("This EPUB is copy-protected (DRM).");
      },
    });
    const search = createBookSearch({ storageDir: await storage(), engine });
    await search.preindex([BOOK]);
    await vi.waitFor(() => expect(engine.indexed).toEqual(["tried"]));
    await search.preindex([BOOK]);
    expect(engine.indexed).toEqual(["tried"]);
  });

  it("refuses an item id that is not one before building a path from it", async () => {
    const search = createBookSearch({
      storageDir: await storage(),
      engine: fakeEngine(),
    });
    await expect(
      search.search({ ...BOOK, itemId: "../../etc/passwd" }, ""),
    ).rejects.toThrow("Not an item id.");
  });
});
