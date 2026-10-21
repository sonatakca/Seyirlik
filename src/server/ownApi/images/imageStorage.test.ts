import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import sharp from "sharp";
import { createImageStorage, detectImageType } from "./imageStorage";

const JPEG = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
  Buffer.alloc(64, 1),
]);
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64, 2),
]);
const WEBP = Buffer.concat([
  Buffer.from("RIFF"),
  Buffer.alloc(4, 0),
  Buffer.from("WEBP"),
  Buffer.alloc(64, 3),
]);
const HTML = Buffer.from("<!doctype html><html>error page</html>");

describe("detectImageType", () => {
  it("recognizes the supported formats by magic bytes", () => {
    expect(detectImageType(JPEG)).toBe("image/jpeg");
    expect(detectImageType(PNG)).toBe("image/png");
    expect(detectImageType(WEBP)).toBe("image/webp");
  });

  it("rejects content that is not an image", () => {
    expect(detectImageType(HTML)).toBeNull();
    expect(detectImageType(Buffer.alloc(4))).toBeNull();
  });
});

describe("image storage", () => {
  let imageRoot: string;

  beforeEach(async () => {
    imageRoot = await mkdtemp(path.join(tmpdir(), "seyirlik-images-"));
  });

  afterEach(async () => {
    await rm(imageRoot, { recursive: true, force: true });
  });

  it("stores bytes under their content hash and can read them back", async () => {
    const storage = createImageStorage({ imageRoot });
    const stored = await storage.store(JPEG, "image/jpeg");

    expect(stored.contentType).toBe("image/jpeg");
    expect(stored.sizeBytes).toBe(JPEG.length);
    expect(stored.storageKey.endsWith(".jpg")).toBe(true);
    await expect(readFile(storage.resolve(stored.storageKey))).resolves.toEqual(
      JPEG,
    );
  });

  it("gives identical bytes the same key, so re-fetching costs nothing", async () => {
    const storage = createImageStorage({ imageRoot });
    const first = await storage.store(JPEG, "image/jpeg");
    const second = await storage.store(Buffer.from(JPEG), "image/jpeg");

    expect(second.storageKey).toBe(first.storageKey);
    expect(second.contentHash).toBe(first.contentHash);
  });

  it("gives different bytes different keys", async () => {
    const storage = createImageStorage({ imageRoot });
    const jpeg = await storage.store(JPEG, "image/jpeg");
    const png = await storage.store(PNG, "image/png");

    expect(png.contentHash).not.toBe(jpeg.contentHash);
  });

  it("writes canonical cover, backdrop and logo files inside the title", async () => {
    const mediaRoot = path.join(imageRoot, "media");
    const titleRoot = "Movies/Dune (2021)";
    await mkdir(path.join(mediaRoot, titleRoot), { recursive: true });
    const storage = createImageStorage({ imageRoot, mediaRoot });
    const photograph = await sharp({
      create: {
        width: 80,
        height: 120,
        channels: 3,
        background: "#c08457",
      },
    })
      .png()
      .toBuffer();
    const logo = await sharp({
      create: {
        width: 120,
        height: 40,
        channels: 4,
        background: { r: 255, g: 255, b: 255, alpha: 0.5 },
      },
    })
      .webp()
      .toBuffer();

    const cover = await storage.storeTitleArtwork(
      photograph,
      "image/png",
      titleRoot,
      "cover",
    );
    const backdrop = await storage.storeTitleArtwork(
      photograph,
      "image/png",
      titleRoot,
      "backdrop",
    );
    const storedLogo = await storage.storeTitleArtwork(
      logo,
      "image/webp",
      titleRoot,
      "logo",
    );

    expect(cover.storageKey).toBe("media:Movies/Dune (2021)/content/cover.jpg");
    expect(backdrop.storageKey).toBe(
      "media:Movies/Dune (2021)/content/backdrop.jpg",
    );
    expect(storedLogo.storageKey).toBe(
      "media:Movies/Dune (2021)/content/logo.png",
    );
    await expect(
      sharp(await readFile(storage.resolve(cover.storageKey))).metadata(),
    ).resolves.toMatchObject({ format: "jpeg" });
    await expect(
      sharp(await readFile(storage.resolve(storedLogo.storageKey))).metadata(),
    ).resolves.toMatchObject({ format: "png" });
  });

  it("stores a provider JPEG backdrop byte-for-byte", async () => {
    const mediaRoot = path.join(imageRoot, "media");
    const titleRoot = "Movies/Dune (2021)";
    await mkdir(path.join(mediaRoot, titleRoot), { recursive: true });
    const storage = createImageStorage({ imageRoot, mediaRoot });
    // What a provider serves: a full-size JPEG with no EXIF orientation. Every
    // re-encode of one of these costs a generation of detail, and the pixels
    // lost that way can never be recovered from the stored file.
    const providerBackdrop = await sharp({
      create: {
        width: 3840,
        height: 2160,
        channels: 3,
        background: "#7a1f1f",
      },
    })
      .jpeg({ quality: 90 })
      .toBuffer();

    const backdrop = await storage.storeTitleArtwork(
      providerBackdrop,
      "image/jpeg",
      titleRoot,
      "backdrop",
    );

    expect(backdrop.sizeBytes).toBe(providerBackdrop.length);
    await expect(
      readFile(storage.resolve(backdrop.storageKey)),
    ).resolves.toEqual(providerBackdrop);
    await expect(
      sharp(await readFile(storage.resolve(backdrop.storageKey))).metadata(),
    ).resolves.toMatchObject({ width: 3840, height: 2160 });
  });

  it("refuses a title artwork path outside the media root", async () => {
    const mediaRoot = path.join(imageRoot, "media");
    await mkdir(mediaRoot, { recursive: true });
    const storage = createImageStorage({ imageRoot, mediaRoot });

    await expect(
      storage.storeTitleArtwork(PNG, "image/png", "../outside", "cover"),
    ).rejects.toThrow(/safe relative path/);
  });

  it("creates and reuses a small WebP variant for a full-size custom cover", async () => {
    const storage = createImageStorage({ imageRoot });
    const fullSizeCover = await sharp({
      create: {
        width: 1600,
        height: 2400,
        channels: 3,
        background: "#b45309",
      },
    })
      .png()
      .toBuffer();
    const original = await storage.store(fullSizeCover, "image/png");

    const first = await storage.getVariant(original, 440);
    const second = await storage.getVariant(original, 440);
    /*
     * Through the bytes, not the path. libvips holds a handle on a file it is
     * given by name, and on Windows that makes the file undeletable — which is
     * how this test used to fail in its own `afterEach`, on a leak of its own
     * making rather than anything the storage did.
     */
    const metadata = await sharp(
      await readFile(storage.resolve(first.storageKey)),
    ).metadata();

    expect(first).toEqual(second);
    expect(first.contentType).toBe("image/webp");
    expect(first.storageKey).toContain("variants/v1/");
    expect(metadata.width).toBe(440);
    expect(first.sizeBytes).toBeLessThan(original.sizeBytes);
    await expect(
      stat(storage.resolve(first.storageKey)),
    ).resolves.toMatchObject({
      size: first.sizeBytes,
    });
  });

  it("coalesces nearby requested widths into one bounded cache variant", async () => {
    const storage = createImageStorage({ imageRoot });
    const cover = await sharp({
      create: {
        width: 1000,
        height: 1500,
        channels: 3,
        background: "#111827",
      },
    })
      .jpeg()
      .toBuffer();
    const original = await storage.store(cover, "image/jpeg");

    const first = await storage.getVariant(original, 441);
    const second = await storage.getVariant(original, 500);

    expect(second.storageKey).toBe(first.storageKey);
    await expect(
      // Through the bytes: see the note on the read-back above.
      sharp(await readFile(storage.resolve(first.storageKey))).metadata(),
    ).resolves.toMatchObject({ width: 520, format: "webp" });
  });

  it("draws from cached variants once the original file is gone", async () => {
    const mediaRoot = path.join(imageRoot, "media");
    const titleRoot = "Series/The Sopranos";
    await mkdir(path.join(mediaRoot, titleRoot), { recursive: true });
    const storage = createImageStorage({ imageRoot, mediaRoot });
    const cover = await storage.storeTitleArtwork(
      await sharp({
        create: {
          width: 1000,
          height: 1500,
          channels: 3,
          background: "#7c2d12",
        },
      })
        .jpeg()
        .toBuffer(),
      "image/jpeg",
      titleRoot,
      "cover",
    );
    const small = await storage.getVariant(cover, 160);
    const large = await storage.getVariant(cover, 900);
    // The title folder went missing; generated storage did not.
    await rm(path.join(mediaRoot, titleRoot), { recursive: true });

    // A cached width is still that width; another is the nearest cached one,
    // served as it is rather than re-derived from a copy.
    await expect(storage.getVariant(cover, 160)).resolves.toEqual(small);
    await expect(storage.getVariant(cover, 320)).resolves.toEqual(large);
    await expect(storage.getVariant(cover, 1920)).resolves.toEqual(large);
    await expect(storage.hasSource(cover)).resolves.toBe(true);
    await expect(
      sharp(await storage.readSource(cover)).metadata(),
    ).resolves.toMatchObject({ width: 900, format: "webp" });
  });

  it("has no source when neither the original nor a variant remains", async () => {
    const storage = createImageStorage({ imageRoot });
    const stored = await storage.store(
      await sharp({
        create: { width: 200, height: 300, channels: 3, background: "#000" },
      })
        .png()
        .toBuffer(),
      "image/png",
    );
    await rm(storage.resolve(stored.storageKey));

    await expect(storage.hasSource(stored)).resolves.toBe(false);
    await expect(storage.readSource(stored)).rejects.toThrow();
    await expect(storage.getVariant(stored, 160)).rejects.toThrow();
  });

  it("rasterizes a placed logo and its shadow into a transparent card layer", async () => {
    const storage = createImageStorage({ imageRoot });
    const logo = await sharp({
      create: {
        width: 120,
        height: 60,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      },
    })
      .composite([
        {
          input: Buffer.from(
            '<svg width="120" height="60"><rect x="30" y="20" width="60" height="20" fill="white"/></svg>',
          ),
        },
      ])
      .png()
      .toBuffer();
    const original = await storage.store(logo, "image/png");
    const layout = { x: 0.5, y: 0.8, width: 0.5, shadow: 1 };

    const first = await storage.getCardLogoOverlay(original, layout, 440);
    const second = await storage.getCardLogoOverlay(original, layout, 440);
    const bytes = await readFile(storage.resolve(first.storageKey));
    const metadata = await sharp(bytes).metadata();
    const { data, info } = await sharp(bytes)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const alphaAt = (x: number, y: number) =>
      data[(y * info.width + x) * info.channels + 3];

    expect(second).toEqual(first);
    expect(metadata).toMatchObject({
      width: 440,
      height: 660,
      format: "webp",
      hasAlpha: true,
    });
    expect(alphaAt(0, 0)).toBe(0);
    expect(alphaAt(220, 528)).toBeGreaterThan(0);
  });

  it("refuses content whose bytes are not an image", async () => {
    const storage = createImageStorage({ imageRoot });
    await expect(storage.store(HTML, "image/jpeg")).rejects.toThrow(
      /not a supported image/,
    );
  });

  it("refuses a declared type that contradicts the bytes", async () => {
    const storage = createImageStorage({ imageRoot });
    await expect(storage.store(PNG, "image/jpeg")).rejects.toThrow(
      /does not match/,
    );
  });

  it("refuses empty content", async () => {
    const storage = createImageStorage({ imageRoot });
    await expect(storage.store(Buffer.alloc(0), "image/jpeg")).rejects.toThrow(
      /empty or too large/,
    );
  });

  it("downloads over HTTPS and stores the result", async () => {
    const storage = createImageStorage({
      imageRoot,
      fetchImpl: (async () =>
        new Response(JPEG, {
          status: 200,
          headers: { "content-type": "image/jpeg" },
        })) as unknown as typeof fetch,
    });

    const stored = await storage.fetchAndStore(
      "https://images.test/poster.jpg",
    );
    expect(stored.contentType).toBe("image/jpeg");
  });

  it("types a download by its bytes when the CDN mislabels the response", async () => {
    // TMDB's CDN negotiates on the Accept header and answers `image/webp` for
    // the PNG it then sends. Believing that header cost a title its logo.
    const storage = createImageStorage({
      imageRoot,
      fetchImpl: (async () =>
        new Response(PNG, {
          status: 200,
          headers: { "content-type": "image/webp" },
        })) as unknown as typeof fetch,
    });

    const stored = await storage.fetchAndStore("https://images.test/logo.png");

    expect(stored.contentType).toBe("image/png");
    expect(stored.storageKey.endsWith(".png")).toBe(true);
  });

  it("refuses to fetch artwork over plaintext HTTP", async () => {
    const storage = createImageStorage({ imageRoot });
    await expect(
      storage.fetchAndStore("http://images.test/poster.jpg"),
    ).rejects.toThrow(/HTTPS/);
  });

  it("refuses a download that returns an error page instead of an image", async () => {
    const storage = createImageStorage({
      imageRoot,
      fetchImpl: (async () =>
        new Response(HTML, {
          status: 200,
          headers: { "content-type": "text/html" },
        })) as unknown as typeof fetch,
    });

    await expect(
      storage.fetchAndStore("https://images.test/missing.jpg"),
    ).rejects.toThrow(/not a supported image/);
  });

  it("removes a stored image without failing when it is already gone", async () => {
    const storage = createImageStorage({ imageRoot });
    const stored = await storage.store(WEBP, "image/webp");

    await storage.remove(stored.storageKey);
    await expect(storage.remove(stored.storageKey)).resolves.toBeUndefined();
  });

  /**
   * The handle, not the bytes.
   *
   * libvips keeps its own file handle when sharp is given a path, and Windows
   * will not delete or move a file that something has open. Producing a variant
   * used to leave one on the *source* image, so removing it silently did
   * nothing — and a handle on a media file is precisely what stops the volume
   * it lives on from being released.
   *
   * Vacuous on POSIX, which is happy to unlink an open file. It is Windows this
   * has to hold on, and the assertion says so out loud rather than leaving it to
   * be discovered by an `EBUSY` in somebody else's cleanup.
   */
  it("leaves nothing open on the source once a variant is made", async () => {
    const storage = createImageStorage({ imageRoot });
    const cover = await sharp({
      create: {
        width: 1200,
        height: 1800,
        channels: 3,
        background: "#0f766e",
      },
    })
      .png()
      .toBuffer();
    const original = await storage.store(cover, "image/png");
    await storage.getVariant(original, 440);

    // The whole tree, exactly as an operator releasing a volume would.
    await expect(
      rm(imageRoot, { recursive: true, force: true }),
    ).resolves.toBeUndefined();
    await mkdir(imageRoot, { recursive: true });
  });
});
