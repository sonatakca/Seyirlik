/**
 * Searching a book by what a passage means rather than the words it uses.
 *
 * The first search of a book reads it into passages and gives each a meaning
 * vector (bookSearchProcess.ts); that is minutes of background work, so the
 * answer meanwhile is "preparing" and the reader asks again. The result is
 * kept as one file per book under the server's generated storage, so a book
 * is read once, not once per restart. A question is then one vector and a dot
 * product with every passage — milliseconds, even for a long novel.
 *
 * An index names the file it was built from (`sourceKey`) and the model; when
 * either changes, the book is read again.
 *
 * Books are read one at a time. The server prepares the whole library ahead of
 * time (`preindex`, see bookPreindexing.ts), so a search rarely finds its book
 * unprepared; when one does, that book goes to the front of the line.
 */

import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import type { BookPassage } from "./bookText";
import {
  BookUnreadableError,
  type BookSearchProcess,
} from "./bookSearchProcess";
import { EMBEDDING_MODEL, INDEX_KEY } from "./bookSearchProtocol";
import { rankPassages } from "./bookSearchRank";

export interface BookToSearch {
  itemId: string;
  filePath: string;
  /** Changes whenever the book's file does. */
  sourceKey: string;
}

export interface BookSearchHit {
  section: number;
  block: number;
  anchor: string;
  text: string;
  /** Where in its section the passage starts, 0 to 1, by its text. */
  place: number;
  /** Meaning and words together; only meaningful against other hits. */
  score: number;
}

export type BookSearchOutcome =
  | {
      state: "ready";
      hits: BookSearchHit[];
      /** The query's words a hit holds, to mark: see `markText`. */
      terms: string[];
      /** The whole query, to mark as one, when a hit holds it as written. */
      phrase: string[];
      /** A quoted search: its words are marked only as written. */
      exact: boolean;
    }
  /** `progress` is 0 to 1, or null while the book waits its turn or the model loads. */
  | { state: "preparing"; progress: number | null }
  | { state: "unavailable"; reason: string };

export interface BookSearch {
  /** An empty query only prepares the book. */
  search(book: BookToSearch, query: string): Promise<BookSearchOutcome>;
  /**
   * Puts every book without a current index in line, behind any a reader is
   * waiting for. Cheap to repeat: a book known to be current is skipped
   * without touching the disk.
   */
  preindex(books: BookToSearch[]): Promise<void>;
  close(): void;
}

interface BookIndex {
  sourceKey: string;
  passages: BookPassage[];
  vectors: Float32Array;
}

interface StoredIndex {
  format: 1;
  model: string;
  sourceKey: string;
  passages: BookPassage[];
  /** Float32, little-endian, base64. */
  vectors: string;
}

/** Indexes held in memory; a few MB each. */
const LOADED = 6;
/** A failure that may pass (a download, a crash) is retried after this. */
const RETRY_AFTER_MS = 5 * 60_000;
const ITEM_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function toStored(index: BookIndex): StoredIndex {
  const { buffer, byteOffset, byteLength } = index.vectors;
  return {
    format: 1,
    model: INDEX_KEY,
    sourceKey: index.sourceKey,
    passages: index.passages,
    vectors: Buffer.from(buffer, byteOffset, byteLength).toString("base64"),
  };
}

function fromStored(value: unknown, sourceKey: string): BookIndex | null {
  const stored = value as Partial<StoredIndex> | null;
  if (
    !stored ||
    stored.format !== 1 ||
    stored.model !== INDEX_KEY ||
    stored.sourceKey !== sourceKey ||
    !Array.isArray(stored.passages) ||
    typeof stored.vectors !== "string"
  )
    return null;
  const bytes = Buffer.from(stored.vectors, "base64");
  const expected = stored.passages.length * EMBEDDING_MODEL.dimensions;
  if (bytes.byteLength !== expected * 4) return null;
  // Copied so the floats are aligned, whatever Buffer's pool gave.
  const vectors = new Float32Array(expected);
  new Uint8Array(vectors.buffer).set(bytes);
  return { sourceKey, passages: stored.passages, vectors };
}

const placesOf = new WeakMap<BookIndex["passages"], Float64Array>();

/**
 * Where each passage starts in its section, 0 to 1, by the text before it:
 * the reader turns this into a place in the whole book with its own map of
 * the book, so a hit is told in the reader's own percentages.
 */
function places(passages: BookIndex["passages"]): Float64Array {
  let found = placesOf.get(passages);
  if (!found) {
    found = new Float64Array(passages.length);
    const lengths = new Map<number, number>();
    for (const { section, text } of passages)
      lengths.set(section, (lengths.get(section) ?? 0) + text.length);
    const before = new Map<number, number>();
    passages.forEach(({ section, text }, at) => {
      const done = before.get(section) ?? 0;
      found![at] = done / Math.max(1, lengths.get(section)!);
      before.set(section, done + text.length);
    });
    placesOf.set(passages, found);
  }
  return found;
}

/** The passages that best answer the query, best first (bookSearchRank.ts). */
function rank(
  index: BookIndex,
  query: string,
  vector: Float32Array,
): BookSearchOutcome {
  const dimensions = EMBEDDING_MODEL.dimensions;
  const meaning = new Float64Array(index.passages.length);
  for (let at = 0; at < index.passages.length; at++) {
    let score = 0;
    const offset = at * dimensions;
    for (let k = 0; k < dimensions; k++)
      score += index.vectors[offset + k]! * vector[k]!;
    meaning[at] = score;
  }
  const { ranked, terms, phrase, exact } = rankPassages(
    index.passages,
    meaning,
    query,
  );
  const placeOf = places(index.passages);
  return {
    state: "ready",
    hits: ranked.map(({ at, score }) => {
      const passage = index.passages[at]!;
      return {
        section: passage.section,
        block: passage.block,
        anchor: passage.anchor,
        text: passage.text,
        place: Math.round(placeOf[at]! * 1000) / 1000,
        score: Math.round(score * 1000) / 1000,
      };
    }),
    terms,
    phrase,
    exact,
  };
}

export function createBookSearch({
  storageDir,
  engine,
  warn = console.warn,
}: {
  /** One `<itemId>.json` per book. */
  storageDir: string;
  engine: BookSearchProcess;
  warn?: (message: string) => void;
}): BookSearch {
  const loaded = new Map<string, BookIndex>();
  /** Books whose stored index is current, by the source it was built from. */
  const current = new Map<string, string>();
  const jobs = new Map<
    string,
    { book: BookToSearch; progress: number | null }
  >();
  const failures = new Map<
    string,
    { sourceKey: string; reason: string; until: number }
  >();
  /** Books waiting to be read, front first. One is read at a time. */
  const waiting: string[] = [];
  let reading = false;
  let closed = false;

  const fileOf = (itemId: string) => {
    // The route has already checked; a path is built from it, so again here.
    if (!ITEM_ID.test(itemId)) throw new Error("Not an item id.");
    return path.join(storageDir, `${itemId}.json`);
  };

  const remember = (itemId: string, index: BookIndex) => {
    loaded.delete(itemId);
    loaded.set(itemId, index);
    while (loaded.size > LOADED) loaded.delete(loaded.keys().next().value!);
  };

  /** The stored index, if it is current for this book. */
  const readStored = async (book: BookToSearch): Promise<BookIndex | null> => {
    let text: string;
    try {
      text = await fs.readFile(fileOf(book.itemId), "utf8");
    } catch {
      return null;
    }
    try {
      const index = fromStored(JSON.parse(text), book.sourceKey);
      if (index) current.set(book.itemId, book.sourceKey);
      return index;
    } catch {
      // Damaged (a crash can zero-fill a file); it is simply built again.
      return null;
    }
  };

  const load = async (book: BookToSearch): Promise<BookIndex | null> => {
    const held = loaded.get(book.itemId);
    if (held?.sourceKey === book.sourceKey) return held;
    const index = await readStored(book);
    if (index) remember(book.itemId, index);
    return index;
  };

  const save = async (itemId: string, index: BookIndex) => {
    await fs.mkdir(storageDir, { recursive: true });
    const target = fileOf(itemId);
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, JSON.stringify(toStored(index)));
      await fs.rename(temporary, target);
    } catch (error) {
      await fs.rm(temporary, { force: true });
      throw error;
    }
  };

  const build = async (book: BookToSearch) => {
    const job = jobs.get(book.itemId)!;
    try {
      const { passages, vectors } = await engine.index(
        book.filePath,
        (done, total) => {
          job.progress = total > 0 ? done / total : null;
        },
      );
      const index = { sourceKey: book.sourceKey, passages, vectors };
      remember(book.itemId, index);
      try {
        await save(book.itemId, index);
        current.set(book.itemId, book.sourceKey);
      } catch (error) {
        // Searchable until a restart; the next one reads it again.
        warn(`[Seyirlik] book search index not saved: ${String(error)}`);
      }
    } catch (error) {
      const unreadable = error instanceof BookUnreadableError;
      failures.set(book.itemId, {
        sourceKey: book.sourceKey,
        reason: unreadable
          ? error.message
          : "The book could not be prepared for search.",
        until: unreadable ? Infinity : Date.now() + RETRY_AFTER_MS,
      });
      if (!unreadable)
        warn(`[Seyirlik] book search indexing failed: ${String(error)}`);
    } finally {
      jobs.delete(book.itemId);
    }
  };

  const readNext = async () => {
    if (reading || closed) return;
    const itemId = waiting.shift();
    if (!itemId) return;
    reading = true;
    try {
      await build(jobs.get(itemId)!.book);
    } finally {
      reading = false;
      void readNext();
    }
  };

  /** In line, at the front when a reader is waiting for it. */
  const enqueue = (book: BookToSearch, urgent: boolean) => {
    const job = jobs.get(book.itemId);
    if (job) {
      const at = waiting.indexOf(book.itemId);
      if (urgent && at > 0) {
        waiting.splice(at, 1);
        waiting.unshift(book.itemId);
      }
      return job;
    }
    const added = { book, progress: null };
    jobs.set(book.itemId, added);
    if (urgent) waiting.unshift(book.itemId);
    else waiting.push(book.itemId);
    void readNext();
    return added;
  };

  const failedRecently = (book: BookToSearch) => {
    const failure = failures.get(book.itemId);
    return failure &&
      failure.sourceKey === book.sourceKey &&
      Date.now() < failure.until
      ? failure
      : null;
  };

  const prepare = (book: BookToSearch): BookSearchOutcome => {
    const failure = failedRecently(book);
    if (failure) return { state: "unavailable", reason: failure.reason };
    failures.delete(book.itemId);
    return { state: "preparing", progress: enqueue(book, true).progress };
  };

  return {
    search: async (book, query) => {
      fileOf(book.itemId);
      // While a book is being read, nothing on disk can be newer.
      const index = jobs.has(book.itemId) ? null : await load(book);
      if (!index) return prepare(book);
      if (!query)
        return {
          state: "ready",
          hits: [],
          terms: [],
          phrase: [],
          exact: false,
        };
      return rank(index, query, await engine.embedQuery(query));
    },
    preindex: async (books) => {
      for (const book of books) {
        if (closed) return;
        if (
          !ITEM_ID.test(book.itemId) ||
          current.get(book.itemId) === book.sourceKey ||
          jobs.has(book.itemId) ||
          failedRecently(book)
        )
          continue;
        // Read once per book per process; after that `current` knows.
        if (await readStored(book)) continue;
        enqueue(book, false);
      }
    },
    close: () => {
      closed = true;
      waiting.length = 0;
      engine.close();
    },
  };
}
