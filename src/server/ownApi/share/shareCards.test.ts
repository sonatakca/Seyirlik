import type { IncomingMessage, ServerResponse } from "node:http";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RouteContext } from "../api/router";
import type { ImageStorage } from "../images/imageStorage";
import { createShareCards, type ShareCards } from "./shareCards";
import type { ShareItemRow, ShareRepository } from "./shareRepository";
import { createShareRoutes } from "./shareRoutes";
import { clipDescription, shareText } from "./shareText";

const ITEM_ID = "a504de76-a209-450e-8035-10b36fa56b3e";

function item(overrides: Partial<ShareItemRow> = {}): ShareItemRow {
  return {
    id: ITEM_ID,
    kind: "movie",
    title: "Dune: Part Two",
    overview: "Paul Atreides unites with the Fremen.",
    productionYear: 2024,
    indexNumber: null,
    parentIndexNumber: null,
    seriesTitle: null,
    seriesOverview: null,
    seriesYear: null,
    cardItemId: ITEM_ID,
    cover: { contentHash: "cover-1", contentType: "image/jpeg", storageKey: "cover.jpg" },
    logo: { contentHash: "logo-1", contentType: "image/png", storageKey: "logo.png" },
    logoLayout: null,
    ...overrides,
  };
}

describe("share cards", () => {
  let root: string;
  let row: ShareItemRow | null;
  let cards: ShareCards;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "share-cards-"));
    await mkdir(root, { recursive: true });
    await writeFile(
      path.join(root, "cover.jpg"),
      await sharp({
        create: { width: 200, height: 300, channels: 3, background: "#456" },
      })
        .jpeg()
        .toBuffer(),
    );
    await writeFile(
      path.join(root, "logo.png"),
      await sharp({
        create: { width: 80, height: 30, channels: 4, background: "#fffa" },
      })
        .png()
        .toBuffer(),
    );
    row = item();
    const repository: ShareRepository = { getItem: async () => row };
    cards = createShareCards({
      repository,
      imageStorage: {
        resolve: (key: string) => path.join(root, key),
        readSource: (image: { storageKey: string }) =>
          readFile(path.join(root, image.storageKey)),
      } as unknown as ImageStorage,
      catalogue: { getPrimaryFile: async () => null },
      mediaRoot: root,
    });
  });

  afterEach(() => rm(root, { recursive: true, force: true }));

  async function storedCards(): Promise<string[]> {
    const found: string[] = [];
    async function walk(dir: string) {
      for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) await walk(full);
        else found.push(full);
      }
    }
    await walk(path.join(root, "share"));
    return found;
  }

  it("draws a title's card at its cover's size, once", async () => {
    const first = await cards.describe(ITEM_ID);
    expect(first).toMatchObject({
      kind: "movie",
      title: "Dune: Part Two (2024)",
      description: "Paul Atreides unites with the Fremen.",
      image: { width: 200, height: 300 },
    });
    const again = await cards.describe(ITEM_ID);
    expect(again?.image?.version).toBe(first?.image?.version);
    expect(await storedCards()).toHaveLength(1);
  });

  it("draws a new card when the layout changes", async () => {
    const before = await cards.describe(ITEM_ID);
    row = item({ logoLayout: { x: 0.5, y: 0.2, width: 0.6, shadow: 1 } });
    const after = await cards.describe(ITEM_ID);
    expect(after?.image?.version).not.toBe(before?.image?.version);
    expect(await storedCards()).toHaveLength(2);
  });

  it("has no card for a title missing its cover or its logo", async () => {
    row = item({ logo: null });
    expect((await cards.describe(ITEM_ID))?.image).toBeNull();
    row = item({ cover: null });
    expect(await cards.image(ITEM_ID)).toBeNull();
    expect(await storedCards()).toHaveLength(0);
  });

  it("answers nothing for an unknown title", async () => {
    row = null;
    expect(await cards.describe(ITEM_ID)).toBeNull();
    expect(await cards.image(ITEM_ID)).toBeNull();
  });
});

describe("share routes", () => {
  function context(pathname: string, params: Record<string, string>, headers = {}) {
    const headersOut: Record<string, string> = {};
    const response = {
      statusCode: 200,
      setHeader: (key: string, value: string) => {
        headersOut[key.toLowerCase()] = value;
      },
      end: vi.fn(),
    };
    return {
      headersOut,
      response,
      context: {
        request: { headers } as unknown as IncomingMessage,
        response: response as unknown as ServerResponse,
        requestId: "req-1",
        url: new URL(`https://playback.seyirlik.test${pathname}`),
        params,
        method: "GET",
        principal: null,
      } as unknown as RouteContext,
    };
  }

  it("are open to a crawler with no session, and nothing else", () => {
    const routes = createShareRoutes({} as ShareCards);
    expect(routes.map((route) => [route.method, route.path, route.access])).toEqual([
      ["GET", "/share/items/:itemId", "public"],
      ["GET", "/share/items/:itemId/image", "public"],
    ]);
  });

  it("refuse anything but a title id", async () => {
    const describe = vi.fn();
    const [card] = createShareRoutes({ describe } as unknown as ShareCards);
    const { context: ctx } = context("/share/items/x", { itemId: "../../etc" });
    await expect(card.handle(ctx)).rejects.toMatchObject({ statusCode: 422 });
    expect(describe).not.toHaveBeenCalled();
  });

  it("answer 404 for a title without a card image", async () => {
    const [, image] = createShareRoutes({
      image: async () => null,
    } as unknown as ShareCards);
    const { context: ctx } = context(`/share/items/${ITEM_ID}/image`, { itemId: ITEM_ID });
    await expect(image.handle(ctx)).rejects.toMatchObject({ statusCode: 404 });
  });

  it("let a crawler keep the current card, and only briefly an old one", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "share-route-"));
    const file = path.join(root, "card.jpg");
    await writeFile(file, "jpeg");
    try {
      const [, image] = createShareRoutes({
        image: async () => ({ path: file, version: "v2" }),
      } as unknown as ShareCards);

      const stale = context(`/share/items/${ITEM_ID}/image?v=v1`, { itemId: ITEM_ID }, {
        "if-none-match": '"v2"',
      });
      await image.handle(stale.context);
      expect(stale.response.statusCode).toBe(304);
      expect(stale.headersOut["cache-control"]).toBe("public, max-age=300");

      const current = context(`/share/items/${ITEM_ID}/image?v=v2`, { itemId: ITEM_ID });
      await image.handle(current.context).catch(() => undefined);
      expect(current.headersOut["cache-control"]).toContain("immutable");
      expect(current.headersOut["content-type"]).toBe("image/jpeg");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("share text", () => {
  it("names an episode through its series", () => {
    expect(
      shareText(
        item({
          kind: "episode",
          title: "Pilot",
          overview: null,
          seriesTitle: "Ezel",
          seriesOverview: "Ömer returns as Ezel.",
          parentIndexNumber: 1,
          indexNumber: 3,
        }),
      ),
    ).toEqual({
      title: "Ezel · 1. Sezon, 3. Bölüm · Pilot",
      description: "Ömer returns as Ezel.",
    });
  });

  it("introduces a book by its author and blurb", () => {
    expect(
      shareText(item({ kind: "book", title: "1984", overview: null, productionYear: 1949 }), {
        author: "George Orwell",
        description: "Big Brother is watching.",
      }),
    ).toEqual({ title: "1984 · George Orwell", description: "Big Brother is watching." });
  });

  it("cuts a long description at a word", () => {
    const clipped = clipDescription("word ".repeat(200), 40);
    expect(clipped.length).toBeLessThanOrEqual(40);
    expect(clipped.endsWith("word…")).toBe(true);
  });
});
