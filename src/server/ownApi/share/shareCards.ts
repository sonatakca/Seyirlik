import { createHash } from "node:crypto";
import {
  mkdir,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { isPathInsideRoot } from "../../pathSecurity";
import { MAX_BOOK_UPLOAD_BYTES, readEpub } from "../books/bookUpload";
import type { CatalogueRepository } from "../catalogue/catalogueRepository";
import type { ImageStorage } from "../images/imageStorage";
import { renderShareCard } from "./posterCard";
import type { ShareItemRow, ShareRepository } from "./shareRepository";
import { shareText, type ShareText } from "./shareText";

/**
 * Bumped whenever the drawing changes, so every stored card is redrawn rather
 * than served from a file made by older code.
 */
const RENDERER_VERSION = "share-card-v1";

export interface ShareCardImage {
  /** Content-derived: changes exactly when the picture would. */
  version: string;
  width: number;
  height: number;
}

export interface ShareCardInfo extends ShareText {
  kind: ShareItemRow["kind"];
  /** Null when the title lacks a cover or a logo: the link keeps Seyirlik's. */
  image: ShareCardImage | null;
}

export interface ShareCards {
  describe(itemId: string): Promise<ShareCardInfo | null>;
  /** The stored card's file, drawing it first if it has not been yet. */
  image(itemId: string): Promise<{ path: string; version: string } | null>;
  /** Draws a title's card ahead of any share, e.g. when its layout is saved. */
  warm(itemId: string): Promise<void>;
}

interface Logger {
  warn?(event: string, context: Record<string, unknown>): void;
}

export interface ShareCardsOptions {
  repository: ShareRepository;
  imageStorage: ImageStorage;
  catalogue: Pick<CatalogueRepository, "getPrimaryFile">;
  mediaRoot: string;
  logger?: Logger;
}

/** One card at a time: a 2000×3000 render is the heaviest thing sharp does here. */
function createSerialQueue() {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(task: () => Promise<T>): Promise<T> => {
    const run = tail.then(task, task);
    tail = run.catch(() => undefined);
    return run;
  };
}

export function createShareCards({
  repository,
  imageStorage,
  catalogue,
  mediaRoot,
  logger,
}: ShareCardsOptions): ShareCards {
  const resolvedMediaRoot = path.resolve(mediaRoot);
  const inFlight = new Map<string, Promise<ShareCardImage | null>>();
  const sizes = new Map<string, ShareCardImage>();
  const serial = createSerialQueue();
  const books = new Map<
    string,
    { author: string | null; description: string | null } | null
  >();

  function versionOf(item: ShareItemRow): string | null {
    if (!item.cover || !item.logo) return null;
    return createHash("sha256")
      .update(
        JSON.stringify([
          RENDERER_VERSION,
          item.cover.contentHash,
          item.logo.contentHash,
          item.logoLayout,
        ]),
      )
      .digest("hex");
  }

  /** Beside the artwork variants, content-addressed like them. */
  function storageKey(version: string): string {
    return `share/v1/${version.slice(0, 2)}/${version.slice(2, 4)}/${version}.jpg`;
  }

  /**
   * A card already on disk. Its size is read from the bytes rather than by
   * handing sharp the path — on Windows libvips keeps a handle on a file it
   * opened by name (see `createVariant`) — and remembered after that.
   */
  async function stored(version: string): Promise<ShareCardImage | null> {
    const known = sizes.get(version);
    const file = imageStorage.resolve(storageKey(version));
    if (!(await stat(file).catch(() => null))?.isFile()) return null;
    if (known) return known;
    const meta = await readFile(file)
      .then((bytes) => sharp(bytes).metadata())
      .catch(() => null);
    if (!meta?.width || !meta.height) return null;
    return remember({ version, width: meta.width, height: meta.height });
  }

  function remember(card: ShareCardImage): ShareCardImage {
    if (sizes.size >= 1024) sizes.delete(sizes.keys().next().value!);
    sizes.set(card.version, card);
    return card;
  }

  async function draw(
    item: ShareItemRow,
    version: string,
  ): Promise<ShareCardImage> {
    const target = imageStorage.resolve(storageKey(version));
    const card = await renderShareCard({
      cover: await imageStorage.readSource(item.cover!),
      logo: await imageStorage.readSource(item.logo!),
      layout: item.logoLayout,
    });
    await mkdir(path.dirname(target), { recursive: true });
    const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
    try {
      await writeFile(temporary, card.jpeg);
      await rename(temporary, target);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      // The same immutable card, finished by someone else, is just as good.
      if (!(await stat(target).catch(() => null))?.isFile()) throw error;
    }
    return remember({ version, width: card.width, height: card.height });
  }

  /**
   * The card for this cover, logo and layout — drawn once, then kept. Its name
   * is a hash of exactly those, so an adjusted layout is a new file and an
   * unchanged one is never drawn twice.
   */
  async function ensure(item: ShareItemRow): Promise<ShareCardImage | null> {
    const version = versionOf(item);
    if (!version) return null;
    const pending = inFlight.get(version);
    if (pending) return pending;

    const request = (async () => {
      const existing = await stored(version);
      if (existing) return existing;
      try {
        return await serial(() => draw(item, version));
      } catch (error) {
        logger?.warn?.("share.card_render_failed", {
          itemId: item.id,
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      }
    })().finally(() => inFlight.delete(version));
    inFlight.set(version, request);
    return request;
  }

  /**
   * The author and blurb a book gives itself. Read from the EPUB once per
   * file version and remembered, since the catalogue holds neither.
   */
  async function bookInfo(itemId: string) {
    const file = await catalogue.getPrimaryFile(itemId);
    if (!file || file.missingSince !== null) return null;
    if (!file.relativePath.toLowerCase().endsWith(".epub")) return null;
    const key = `${file.id}:${file.mtimeMs}`;
    if (books.has(key)) return books.get(key)!;

    let info: { author: string | null; description: string | null } | null =
      null;
    const absolute = path.resolve(
      resolvedMediaRoot,
      ...file.relativePath.split("/"),
    );
    if (
      isPathInsideRoot(resolvedMediaRoot, absolute) &&
      Number(file.sizeBytes) <= MAX_BOOK_UPLOAD_BYTES
    ) {
      try {
        const metadata = readEpub(await readFile(absolute));
        info = { author: metadata.author, description: metadata.description };
      } catch {
        // Unreadable or protected: the preview goes without, as the reader would.
      }
    }
    if (books.size >= 256) books.delete(books.keys().next().value!);
    books.set(key, info);
    return info;
  }

  return {
    describe: async (itemId) => {
      const item = await repository.getItem(itemId);
      if (!item) return null;
      const book = item.kind === "book" ? await bookInfo(itemId) : null;
      return {
        kind: item.kind,
        ...shareText(item, book),
        image: await ensure(item),
      };
    },

    image: async (itemId) => {
      const item = await repository.getItem(itemId);
      if (!item) return null;
      const card = await ensure(item);
      return card
        ? {
            path: imageStorage.resolve(storageKey(card.version)),
            version: card.version,
          }
        : null;
    },

    warm: async (itemId) => {
      const item = await repository.getItem(itemId);
      if (item) await ensure(item);
    },
  };
}
