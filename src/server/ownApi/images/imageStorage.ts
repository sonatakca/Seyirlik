import { createHash } from "node:crypto";
import {
  mkdir,
  readFile,
  realpath,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import {
  ARTWORK_VARIANT_WIDTHS,
  MAX_ARTWORK_WIDTH,
  clampArtworkWidth,
} from "../../../lib/artworkSizes";
import {
  CARD_LOGO_OVERLAY_VARIANT,
  clampLogoLayout,
  type LogoLayout,
} from "../../../lib/logoLayout";
import { isPathInsideRoot } from "../../pathSecurity";
import {
  REFERENCE_CARD_WIDTH,
  logoBox,
  logoLayerSvg,
} from "../share/posterCard";

/**
 * Artwork storage spanning title-owned originals and generated cache variants.
 *
 * New cover, backdrop and logo originals use stable names in the title's own
 * content/ directory. Legacy originals and derived WebP variants stay
 * content-addressed on the generated-storage volume; the content hash remains
 * the HTTP cache validator for both layouts.
 */

const MAX_IMAGE_BYTES = 12 * 1_024 * 1_024;

/**
 * File-byte limits alone do not stop a highly compressed image from
 * expanding to unreasonable dimensions during decoding. Comfortably above
 * the largest artwork a provider publishes: a 3840x2160 backdrop decodes to
 * roughly 8.3 megapixels.
 */
const MAX_IMAGE_PIXELS = 40_000_000;

const ALLOWED_CONTENT_TYPES: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

export interface StoredImageBytes {
  contentHash: string;
  contentType: string;
  sizeBytes: number;
  /** Path relative to the image root; never absolute in any response. */
  storageKey: string;
}

export type TitleArtworkType = "cover" | "backdrop" | "logo";

export interface ImageStorage {
  /** Absolute path for a stored key, for delivery. */
  resolve(storageKey: string): string;
  store(bytes: Buffer, contentType: string): Promise<StoredImageBytes>;
  fetchAndStore(url: string): Promise<StoredImageBytes>;
  /** Writes the canonical human-readable file inside a title's content/. */
  storeTitleArtwork(
    bytes: Buffer,
    contentType: string,
    titleRoot: string,
    imageType: TitleArtworkType,
  ): Promise<StoredImageBytes>;
  fetchAndStoreTitleArtwork(
    url: string,
    titleRoot: string,
    imageType: TitleArtworkType,
  ): Promise<StoredImageBytes>;
  /** A persistent, card-sized WebP derived from immutable original bytes. */
  getVariant(
    image: Pick<StoredImageBytes, "contentHash" | "storageKey">,
    maxWidth: number,
  ): Promise<StoredImageBytes>;
  /** A transparent 2:3 card layer with the placed logo and shadow rasterized. */
  getCardLogoOverlay(
    image: Pick<StoredImageBytes, "contentHash" | "storageKey">,
    layout: LogoLayout,
    maxWidth: number,
  ): Promise<StoredImageBytes>;
  /**
   * The bytes an image is drawn from: its original file or, when that file is
   * gone, the largest cached variant of it.
   */
  readSource(
    image: Pick<StoredImageBytes, "contentHash" | "storageKey">,
  ): Promise<Buffer>;
  /** Whether `readSource` has anything to read. */
  hasSource(
    image: Pick<StoredImageBytes, "contentHash" | "storageKey">,
  ): Promise<boolean>;
  remove(storageKey: string): Promise<void>;
}

/**
 * Verifies the declared type against the actual magic bytes. A provider that
 * mislabels a response, or a redirect to an HTML error page, must not be stored
 * and later served as an image.
 */
export function detectImageType(bytes: Buffer): string | null {
  if (bytes.length < 12) return null;

  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return "image/png";
  }
  if (
    bytes.toString("ascii", 0, 4) === "RIFF" &&
    bytes.toString("ascii", 8, 12) === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}

/**
 * Whether downloaded bytes can become the canonical file untouched.
 *
 * Re-encoding a provider JPEG at quality 92 spends a generation of detail for
 * nothing — the bytes already are the format the canonical file uses. Only a
 * format change, or an EXIF orientation that `.rotate()` has to bake into the
 * pixels, earns a trip through the encoder.
 */
async function isCanonicalAlready(
  bytes: Buffer,
  actualType: string,
  canonicalType: string,
): Promise<boolean> {
  if (actualType !== canonicalType) return false;
  try {
    const { orientation } = await sharp(bytes, {
      limitInputPixels: MAX_IMAGE_PIXELS,
    }).metadata();
    return orientation === undefined || orientation === 1;
  } catch {
    return false;
  }
}

export interface CreateImageStorageOptions {
  /** Directory under the generated-storage volume. */
  imageRoot: string;
  /** Root containing title folders. Required for title-owned artwork writes. */
  mediaRoot?: string;
  fetchImpl?: typeof fetch;
}

export function createImageStorage({
  imageRoot,
  mediaRoot,
  fetchImpl = fetch,
}: CreateImageStorageOptions): ImageStorage {
  const root = path.resolve(imageRoot);
  const resolvedMediaRoot = mediaRoot ? path.resolve(mediaRoot) : undefined;
  const variantRequests = new Map<string, Promise<StoredImageBytes>>();

  // A bounded set prevents an authenticated client from creating an unbounded
  // number of almost-identical cached files by varying maxWidth one pixel at a
  // time. Each request is rounded up, so the browser never receives less than
  // it asked for.
  function normalizedVariantWidth(maxWidth: number): number {
    const requested = clampArtworkWidth(maxWidth);
    return (
      ARTWORK_VARIANT_WIDTHS.find((width) => width >= requested) ??
      MAX_ARTWORK_WIDTH
    );
  }

  function keyFor(contentHash: string, extension: string): string {
    // Two levels of fan-out keep any one directory small enough for a
    // filesystem that degrades on very large directories.
    return `${contentHash.slice(0, 2)}/${contentHash.slice(2, 4)}/${contentHash}.${extension}`;
  }

  async function store(
    bytes: Buffer,
    declaredContentType: string,
  ): Promise<StoredImageBytes> {
    if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) {
      throw new Error("The artwork is empty or too large.");
    }

    const actualType = detectImageType(bytes);
    if (!actualType || !ALLOWED_CONTENT_TYPES[actualType]) {
      throw new Error("The artwork is not a supported image.");
    }
    if (
      ALLOWED_CONTENT_TYPES[declaredContentType] &&
      declaredContentType !== actualType
    ) {
      throw new Error("The artwork content type does not match its bytes.");
    }

    const extension = ALLOWED_CONTENT_TYPES[actualType] as string;
    const contentHash = createHash("sha256").update(bytes).digest("hex");
    const storageKey = keyFor(contentHash, extension);
    const absolutePath = path.join(root, storageKey);

    await mkdir(path.dirname(absolutePath), { recursive: true });

    // Write to a unique temporary name and rename into place, so a concurrent
    // reader never observes a partially written image.
    const temporaryPath = `${absolutePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporaryPath, bytes);
    try {
      await rename(temporaryPath, absolutePath);
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }

    return {
      contentHash,
      contentType: actualType,
      sizeBytes: bytes.length,
      storageKey,
    };
  }

  async function download(url: string): Promise<{
    bytes: Buffer;
    contentType: string;
  }> {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") {
      throw new Error("Artwork must be fetched over HTTPS.");
    }

    const response = await fetchImpl(parsed, {
      headers: { Accept: "image/jpeg,image/png,image/webp" },
      redirect: "follow",
    });
    if (!response.ok) {
      throw new Error("The artwork could not be downloaded.");
    }

    const declaredLength = Number(response.headers.get("content-length") ?? 0);
    if (declaredLength > MAX_IMAGE_BYTES) {
      throw new Error("The artwork is empty or too large.");
    }

    const bytes = Buffer.from(await response.arrayBuffer());
    return {
      bytes,
      // A downloaded image is typed by its bytes, not by its header. TMDB's
      // CDN negotiates on Accept and will answer `image/webp` for the PNG it
      // then sends, which the declared-vs-actual guard rejected outright as a
      // mislabelled image — intermittently, on whichever titles happened to
      // negotiate that way. The guard still binds an operator's upload, where
      // the declared type really is an assertion worth checking.
      contentType: detectImageType(bytes) ?? "",
    };
  }

  function validateRelativeTitleRoot(titleRoot: string): string[] {
    if (
      !titleRoot ||
      titleRoot.includes("\0") ||
      path.isAbsolute(titleRoot) ||
      titleRoot.split(/[\\/]/).includes("..")
    ) {
      throw new Error("The title root must be a safe relative path.");
    }
    return titleRoot.split(/[\\/]/).filter(Boolean);
  }

  async function storeTitleArtwork(
    bytes: Buffer,
    declaredContentType: string,
    titleRoot: string,
    imageType: TitleArtworkType,
  ): Promise<StoredImageBytes> {
    if (!resolvedMediaRoot) {
      throw new Error("Title artwork storage has no media root.");
    }

    // Validate the supplied bytes before sharp sees them.
    const actualType = detectImageType(bytes);
    if (
      bytes.length === 0 ||
      bytes.length > MAX_IMAGE_BYTES ||
      !actualType ||
      !ALLOWED_CONTENT_TYPES[actualType] ||
      (ALLOWED_CONTENT_TYPES[declaredContentType] &&
        declaredContentType !== actualType)
    ) {
      throw new Error("The artwork is not a supported image.");
    }

    const segments = validateRelativeTitleRoot(titleRoot);
    const realMediaRoot = await realpath(resolvedMediaRoot);
    const titleDirectory = path.resolve(realMediaRoot, ...segments);
    const realTitleDirectory = await realpath(titleDirectory);
    if (!isPathInsideRoot(realMediaRoot, realTitleDirectory)) {
      throw new Error("The title root escapes the media root.");
    }

    const contentDirectory = path.join(realTitleDirectory, "content");
    await mkdir(contentDirectory, { recursive: true });
    const realContentDirectory = await realpath(contentDirectory);
    if (!isPathInsideRoot(realMediaRoot, realContentDirectory)) {
      throw new Error("The title content directory escapes the media root.");
    }

    // The canonical files deliberately use stable formats and names: JPEG for
    // photographic art, PNG for a logo that may carry transparency.
    const isLogo = imageType === "logo";
    const extension = isLogo ? "png" : "jpg";
    const contentType = isLogo ? "image/png" : "image/jpeg";
    const canonicalBytes = (await isCanonicalAlready(
      bytes,
      actualType,
      contentType,
    ))
      ? bytes
      : isLogo
        ? await sharp(bytes, { limitInputPixels: MAX_IMAGE_PIXELS })
            .rotate()
            .png({ compressionLevel: 9 })
            .toBuffer()
        : await sharp(bytes, { limitInputPixels: MAX_IMAGE_PIXELS })
            .rotate()
            .jpeg({ quality: 92, mozjpeg: true })
            .toBuffer();
    const fileName = `${imageType}.${extension}`;
    const absolutePath = path.join(realContentDirectory, fileName);
    const temporaryPath = `${absolutePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporaryPath, canonicalBytes);
    try {
      await rename(temporaryPath, absolutePath);
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }

    const relativePath = path.posix.join(...segments, "content", fileName);
    return {
      contentHash: createHash("sha256").update(canonicalBytes).digest("hex"),
      contentType,
      sizeBytes: canonicalBytes.length,
      storageKey: `media:${relativePath}`,
    };
  }

  async function createVariant(
    image: Pick<StoredImageBytes, "contentHash" | "storageKey">,
    maxWidth: number,
  ): Promise<StoredImageBytes> {
    const width = normalizedVariantWidth(maxWidth);
    const existing = await cachedVariant(image.contentHash, width);
    if (existing) return existing;
    const { variantHash, storageKey } = variantKey(image.contentHash, width);
    const absolutePath = path.join(root, storageKey);

    // An original that is gone leaves its cached variants behind. Serve the
    // nearest one as it is rather than deriving a new width from it, so no
    // variant is ever filled with a copy of a copy.
    if (!(await isFile(resolveStorageKey(image.storageKey)))) {
      const standIn = await nearestCachedVariant(image.contentHash, width);
      if (standIn) return standIn;
    }

    await mkdir(path.dirname(absolutePath), { recursive: true });
    const temporaryPath = `${absolutePath}.${process.pid}.${Date.now()}.tmp`;
    try {
      /*
       * Read the bytes here rather than handing sharp a path.
       *
       * libvips keeps its own handle on a file it was given by name, and on
       * Windows a file with an open handle cannot be deleted or moved. Measured
       * on Windows 11: every recursive removal of a directory containing an
       * image sharp had opened by path failed with `EBUSY`, six times out of
       * six and with no timeout; through a `Buffer`, six out of six succeeded.
       *
       * For a media server that is the wrong kind of leak. `remove` swallows
       * the error and reports success, so a deleted image quietly stays on
       * disk — and worse, a handle on a media file is exactly what stops the
       * volume it lives on from being released, which is the operation this
       * system's whole storage-identity design exists to make safe.
       *
       * `sequentialRead` goes with it: it is an instruction about how to read a
       * file, and there is no longer a file being read. Artwork is bounded by
       * `MAX_IMAGE_PIXELS` and is a few megabytes at worst, which is what
       * `store` has always held in memory anyway.
       */
      const sourceBytes = await readFile(resolveStorageKey(image.storageKey));
      const result = await sharp(sourceBytes, {
        limitInputPixels: MAX_IMAGE_PIXELS,
      })
        .rotate()
        .resize({ width, fit: "inside", withoutEnlargement: true })
        .webp({ quality: 82, alphaQuality: 90, effort: 4 })
        .toFile(temporaryPath);
      await rename(temporaryPath, absolutePath);
      return {
        contentHash: variantHash,
        contentType: "image/webp",
        sizeBytes: result.size,
        storageKey,
      };
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      // Another server process may have completed the same immutable variant
      // between our initial check and rename. Its result is equally valid.
      const completed = await stat(absolutePath).catch(() => null);
      if (completed?.isFile()) {
        return {
          contentHash: variantHash,
          contentType: "image/webp",
          sizeBytes: completed.size,
          storageKey,
        };
      }
      throw error;
    }
  }

  async function createCardLogoOverlay(
    image: Pick<StoredImageBytes, "contentHash" | "storageKey">,
    layout: LogoLayout,
    maxWidth: number,
  ): Promise<StoredImageBytes> {
    const width = normalizedVariantWidth(maxWidth);
    const normalizedLayout = clampLogoLayout(layout);
    const variantHash = createHash("sha256")
      .update(
        JSON.stringify([
          CARD_LOGO_OVERLAY_VARIANT,
          image.contentHash,
          width,
          normalizedLayout,
        ]),
      )
      .digest("hex");
    const storageKey = `${CARD_LOGO_OVERLAY_VARIANT}/${variantHash.slice(0, 2)}/${variantHash.slice(2, 4)}/${variantHash}-w${width}.webp`;
    const absolutePath = path.join(root, storageKey);
    const existing = await stat(absolutePath).catch(() => null);
    if (existing?.isFile()) {
      return {
        contentHash: variantHash,
        contentType: "image/webp",
        sizeBytes: existing.size,
        storageKey,
      };
    }

    await mkdir(path.dirname(absolutePath), { recursive: true });
    const temporaryPath = `${absolutePath}.${process.pid}.${Date.now()}.tmp`;
    try {
      const source = sharp(await readSource(image), { limitInputPixels: MAX_IMAGE_PIXELS });
      const metadata = await source.metadata();
      if (!metadata.width || !metadata.height) {
        throw new Error("The logo has no size.");
      }

      // Embed only as many source pixels as this card can draw. Besides keeping
      // the SVG small, this avoids asking librsvg to decode a multi-megapixel
      // logo merely to paint it into a few hundred pixels.
      const drawnWidth = Math.max(
        1,
        Math.ceil(
          (logoBox(normalizedLayout, metadata.width, metadata.height).width *
            width) /
            REFERENCE_CARD_WIDTH,
        ),
      );
      const logo = await source
        .rotate()
        .resize({ width: drawnWidth, withoutEnlargement: true })
        .png()
        .toBuffer();
      const svg = logoLayerSvg({
        logo,
        logoType: "image/png",
        logoWidth: metadata.width,
        logoHeight: metadata.height,
        layout: normalizedLayout,
        outputWidth: width,
      });
      const result = await sharp(Buffer.from(svg), {
        limitInputPixels: MAX_IMAGE_PIXELS,
      })
        .webp({ lossless: true, effort: 4 })
        .toFile(temporaryPath);
      await rename(temporaryPath, absolutePath);
      return {
        contentHash: variantHash,
        contentType: "image/webp",
        sizeBytes: result.size,
        storageKey,
      };
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      const completed = await stat(absolutePath).catch(() => null);
      if (completed?.isFile()) {
        return {
          contentHash: variantHash,
          contentType: "image/webp",
          sizeBytes: completed.size,
          storageKey,
        };
      }
      throw error;
    }
  }

  function variantKey(contentHash: string, width: number) {
    const variantHash = createHash("sha256")
      .update(`webp-v1:${contentHash}:${width}`)
      .digest("hex");
    return {
      variantHash,
      storageKey: `variants/v1/${variantHash.slice(0, 2)}/${variantHash.slice(2, 4)}/${variantHash}-w${width}.webp`,
    };
  }

  async function isFile(absolutePath: string): Promise<boolean> {
    return (await stat(absolutePath).catch(() => null))?.isFile() ?? false;
  }

  async function cachedVariant(
    contentHash: string,
    width: number,
  ): Promise<StoredImageBytes | null> {
    const { variantHash, storageKey } = variantKey(contentHash, width);
    const existing = await stat(path.join(root, storageKey)).catch(() => null);
    return existing?.isFile()
      ? {
          contentHash: variantHash,
          contentType: "image/webp",
          sizeBytes: existing.size,
          storageKey,
        }
      : null;
  }

  /**
   * The cached variant closest to `width`: the narrowest at least as wide,
   * else the widest there is. Generated storage keeps variants after their
   * original is lost — the library moved, a title folder never came back —
   * and they are the same picture, already chosen.
   */
  async function nearestCachedVariant(
    contentHash: string,
    width: number = MAX_ARTWORK_WIDTH,
  ): Promise<StoredImageBytes | null> {
    const wider = ARTWORK_VARIANT_WIDTHS.filter((w) => w >= width);
    const narrower = ARTWORK_VARIANT_WIDTHS.filter((w) => w < width).reverse();
    for (const candidate of [...wider, ...narrower]) {
      const variant = await cachedVariant(contentHash, candidate);
      if (variant) return variant;
    }
    return null;
  }

  async function readSource(
    image: Pick<StoredImageBytes, "contentHash" | "storageKey">,
  ): Promise<Buffer> {
    try {
      return await readFile(resolveStorageKey(image.storageKey));
    } catch (error) {
      const standIn = await nearestCachedVariant(image.contentHash);
      if (!standIn) throw error;
      return readFile(path.join(root, standIn.storageKey));
    }
  }

  function resolveStorageKey(storageKey: string): string {
    if (storageKey.startsWith("media:")) {
      if (!resolvedMediaRoot) {
        throw new Error("Title artwork storage has no media root.");
      }
      const relativePath = storageKey.slice("media:".length);
      const segments = validateRelativeTitleRoot(relativePath);
      const resolved = path.resolve(resolvedMediaRoot, ...segments);
      if (!isPathInsideRoot(resolvedMediaRoot, resolved)) {
        throw new Error("The image path escapes the media root.");
      }
      return resolved;
    }
    return path.join(root, storageKey);
  }

  return {
    resolve: resolveStorageKey,

    store,

    fetchAndStore: async (url) => {
      const downloaded = await download(url);
      return store(downloaded.bytes, downloaded.contentType);
    },

    storeTitleArtwork,

    fetchAndStoreTitleArtwork: async (url, titleRoot, imageType) => {
      const downloaded = await download(url);
      return storeTitleArtwork(
        downloaded.bytes,
        downloaded.contentType,
        titleRoot,
        imageType,
      );
    },

    getVariant: (image, maxWidth) => {
      const width = normalizedVariantWidth(maxWidth);
      const key = `${image.contentHash}:${width}`;
      const existing = variantRequests.get(key);
      if (existing) return existing;

      const request = createVariant(image, width).finally(() => {
        variantRequests.delete(key);
      });
      variantRequests.set(key, request);
      return request;
    },

    getCardLogoOverlay: (image, layout, maxWidth) => {
      const width = normalizedVariantWidth(maxWidth);
      const normalizedLayout = clampLogoLayout(layout);
      const key = `${CARD_LOGO_OVERLAY_VARIANT}:${image.contentHash}:${width}:${JSON.stringify(normalizedLayout)}`;
      const existing = variantRequests.get(key);
      if (existing) return existing;

      const request = createCardLogoOverlay(
        image,
        normalizedLayout,
        width,
      ).finally(() => {
        variantRequests.delete(key);
      });
      variantRequests.set(key, request);
      return request;
    },

    readSource,

    hasSource: async (image) =>
      (await isFile(resolveStorageKey(image.storageKey))) ||
      (await nearestCachedVariant(image.contentHash)) !== null,

    remove: async (storageKey) => {
      await unlink(resolveStorageKey(storageKey)).catch(() => undefined);
    },
  };
}
