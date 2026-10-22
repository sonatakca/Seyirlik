import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { MAX_ARTWORK_WIDTH } from "../../../lib/artworkSizes";
import type { RouteContext, RouteDefinition } from "../api/router";
import type { CatalogueRepository } from "../catalogue/catalogueRepository";
import type { ImageRepository } from "./imageRepository";
import type { ImageStorage } from "./imageStorage";
import { createImageRoutes } from "./imageRoutes";

const ITEM_ID = "a504de76-a209-450e-8035-10b36fa56b3e";

const STORED_IMAGE = {
  id: "3f2ab1de-0000-4000-8000-000000000001",
  itemId: ITEM_ID,
  imageType: "backdrop",
  imageIndex: 0,
  contentHash: "hash-original",
  contentType: "image/jpeg",
  storageKey: "ab/cd/hash-original.jpg",
};

function buildRoutes({ originalOnDisk = false } = {}) {
  const getVariant = vi.fn(async (_image: unknown, maxWidth: number) => ({
    contentHash: `hash-w${maxWidth}`,
    contentType: "image/webp",
    storageKey: `variants/v1/hash-w${maxWidth}.webp`,
  }));
  const getCardLogoOverlay = vi.fn(
    async (_image: unknown, _layout: unknown, maxWidth: number) => ({
      contentHash: `overlay-w${maxWidth}`,
      contentType: "image/webp",
      storageKey: `card-logo-overlay-v1/overlay-w${maxWidth}.webp`,
    }),
  );

  const images = {
    findByItemAndType: vi.fn(async () => STORED_IMAGE),
    getById: vi.fn(async () => STORED_IMAGE),
  } as unknown as ImageRepository;

  const imageStorage = {
    getVariant,
    getCardLogoOverlay,
    // Resolving to a path that does not exist makes serveImage throw
    // IMAGE_NOT_FOUND after the width has been negotiated, which is all these
    // tests need to observe.
    resolve: (storageKey: string) =>
      originalOnDisk && !storageKey.startsWith("variants/")
        ? import.meta.filename
        : `/nonexistent/${storageKey}`,
  } as unknown as ImageStorage;

  const catalogue = {
    canUserAccessItem: vi.fn(async () => true),
    getItem: vi.fn(async () => ({
      logoLayout: { x: 0.5, y: 0.8, width: 0.74, shadow: 1 },
    })),
  } as unknown as CatalogueRepository;

  return {
    routes: createImageRoutes({ images, imageStorage, catalogue }),
    getVariant,
    getCardLogoOverlay,
  };
}

function itemImageRoute(routes: RouteDefinition[]): RouteDefinition {
  const route = routes.find(
    (candidate) => candidate.path === "/items/:itemId/images/:imageType",
  );

  if (!route) {
    throw new Error("The item image route is missing.");
  }

  return route;
}

async function callRoute(
  route: RouteDefinition,
  query: string,
  imageType = "backdrop",
) {
  const context = {
    request: { headers: {} } as unknown as IncomingMessage,
    response: {
      statusCode: 200,
      setHeader: () => undefined,
      end: () => undefined,
    } as unknown as ServerResponse,
    requestId: "req-1",
    url: new URL(
      `https://seyirlik.test/items/${ITEM_ID}/images/${imageType}${query}`,
    ),
    params: { itemId: ITEM_ID, imageType },
    method: "GET",
    principal: { userId: "user-1" },
    requirePrincipal: () => ({ userId: "user-1" }),
    readJson: async () => ({}),
  } as unknown as RouteContext;

  return await route.handle(context).then(
    () => null,
    (error: unknown) => error,
  );
}

describe("image routes", () => {
  it("clamps an oversized width instead of rejecting the request", async () => {
    // The hero asked for a 2200px backdrop and got a 422, so the image failed
    // to load and the hero fell back to the poster.
    const { routes, getVariant } = buildRoutes();

    const error = await callRoute(itemImageRoute(routes), "?maxWidth=2200");

    expect(getVariant).toHaveBeenCalledWith(
      expect.anything(),
      MAX_ARTWORK_WIDTH,
    );
    // The request got past validation; only the missing file on disk stopped it.
    expect((error as { code?: string })?.code).toBe("IMAGE_NOT_FOUND");
  });

  it("passes a supported width through untouched", async () => {
    const { routes, getVariant } = buildRoutes();

    await callRoute(itemImageRoute(routes), "?maxWidth=900");

    expect(getVariant).toHaveBeenCalledWith(expect.anything(), 900);
  });

  it("still rejects a width that is not a non-negative integer", async () => {
    const { routes, getVariant } = buildRoutes();

    const error = await callRoute(itemImageRoute(routes), "?maxWidth=-10");

    expect((error as { statusCode?: number })?.statusCode).toBe(422);
    expect(getVariant).not.toHaveBeenCalled();
  });

  it("serves the original when no width is requested", async () => {
    const { routes, getVariant } = buildRoutes({ originalOnDisk: true });

    await callRoute(itemImageRoute(routes), "");

    expect(getVariant).not.toHaveBeenCalled();
  });

  it("serves the widest variant when the original's file is gone", async () => {
    const { routes, getVariant } = buildRoutes();

    await callRoute(itemImageRoute(routes), "");

    expect(getVariant).toHaveBeenCalledWith(
      expect.anything(),
      MAX_ARTWORK_WIDTH,
    );
  });

  it("renders a placed logo into a transparent card layer", async () => {
    const { routes, getVariant, getCardLogoOverlay } = buildRoutes();

    const error = await callRoute(
      itemImageRoute(routes),
      `?maxWidth=440&variant=card-logo-overlay-v1&layoutItemId=${ITEM_ID}`,
      "logo",
    );

    expect(getCardLogoOverlay).toHaveBeenCalledWith(
      expect.anything(),
      { x: 0.5, y: 0.8, width: 0.74, shadow: 1 },
      440,
    );
    expect(getVariant).not.toHaveBeenCalled();
    // The request reached the generated file; this fixture deliberately has
    // no files on disk, so serving it is the only remaining failure.
    expect((error as { code?: string })?.code).toBe("IMAGE_NOT_FOUND");
  });
});
