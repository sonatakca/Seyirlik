import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { OwnApiError } from "../ownApiHandler";
import {
  MAX_ARTWORK_WIDTH,
  clampArtworkWidth,
} from "../../../lib/artworkSizes";
import {
  CARD_LOGO_OVERLAY_VARIANT,
  type LogoLayout,
} from "../../../lib/logoLayout";
import type { RouteDefinition } from "../api/router";
import {
  parseEnum,
  parseOptionalNonNegativeInteger,
  requireUuid,
} from "../api/validation";
import type { CatalogueRepository } from "../catalogue/catalogueRepository";
import type { ImageRepository } from "./imageRepository";
import type { ImageStorage } from "./imageStorage";

/**
 * The artwork roles a title can carry.
 *
 * `thumb` here is a real thumbnail — a picture of the title — and is unrelated
 * to trickplay, which is seek-bar preview sheets and is named for itself.
 */
export const IMAGE_TYPES = [
  "cover",
  "backdrop",
  "logo",
  "thumb",
  "banner",
] as const;

export interface ImageRoutesOptions {
  images: ImageRepository;
  imageStorage: ImageStorage;
  catalogue: CatalogueRepository;
}

function notFound(): OwnApiError {
  return new OwnApiError(
    "IMAGE_NOT_FOUND",
    "The requested image could not be found.",
    404,
  );
}

export function createImageRoutes({
  images,
  imageStorage,
  catalogue,
}: ImageRoutesOptions): RouteDefinition[] {
  /**
   * Serves cached artwork.
   *
   * The content hash is the ETag, and because storage is content-addressed the
   * bytes behind a given hash never change — so the response can be cached
   * aggressively and still be correct the moment the artwork is replaced.
   */
  async function serveImage(
    context: Parameters<RouteDefinition["handle"]>[0],
    image: {
      contentHash: string;
      contentType: string;
      storageKey: string;
    },
  ): Promise<void> {
    const etag = `"${image.contentHash}"`;
    const ifNoneMatch = context.request.headers["if-none-match"];

    context.response.setHeader("ETag", etag);
    context.response.setHeader("Content-Type", image.contentType);
    context.response.setHeader("X-Content-Type-Options", "nosniff");
    // Private: artwork is behind an authorization check, so a shared cache must
    // never keep a copy.
    context.response.setHeader("Cache-Control", "private, max-age=604800");

    if (
      typeof ifNoneMatch === "string" &&
      ifNoneMatch.includes(image.contentHash)
    ) {
      context.response.statusCode = 304;
      context.response.end();
      return;
    }

    const absolutePath = imageStorage.resolve(image.storageKey);
    const stats = await stat(absolutePath).catch(() => null);
    if (!stats?.isFile()) throw notFound();

    context.response.statusCode = 200;
    context.response.setHeader("Content-Length", String(stats.size));

    if (context.method === "HEAD") {
      context.response.end();
      return;
    }

    await new Promise<void>((resolve, reject) => {
      const stream = createReadStream(absolutePath);
      context.response.on("close", () => stream.destroy());
      stream.on("error", reject);
      stream.pipe(context.response).on("finish", resolve).on("error", reject);
    });
  }

  async function serveRequestedSize(
    context: Parameters<RouteDefinition["handle"]>[0],
    image: {
      contentHash: string;
      contentType: string;
      storageKey: string;
    },
    logoLayout?: LogoLayout,
  ): Promise<void> {
    const requestedWidth = parseOptionalNonNegativeInteger(
      context.url.searchParams.get("maxWidth"),
      "maxWidth",
    );
    // Clamped rather than rejected: the variant pipeline caps at
    // MAX_ARTWORK_WIDTH anyway, so a wider request would return identical
    // bytes. Failing it instead cost the caller the image entirely — which is
    // how a hero asking for 2200px ended up showing its poster.
    const maxWidth = requestedWidth
      ? clampArtworkWidth(requestedWidth)
      : requestedWidth;
    const variant = context.url.searchParams.get("variant");
    if (variant === CARD_LOGO_OVERLAY_VARIANT) {
      if (!maxWidth || !logoLayout) {
        throw new OwnApiError(
          "INVALID_IMAGE_VARIANT",
          "The card logo overlay needs a placed logo and a requested width.",
          422,
        );
      }
      const requestedImage = await imageStorage.getCardLogoOverlay(
        image,
        logoLayout,
        maxWidth,
      );
      await serveImage(context, requestedImage);
      return;
    }

    // The full-size request for an image whose original file is gone gets its
    // widest cached variant instead of a 404.
    const width =
      maxWidth ||
      ((
        await stat(imageStorage.resolve(image.storageKey)).catch(() => null)
      )?.isFile()
        ? 0
        : MAX_ARTWORK_WIDTH);
    const requestedImage = width
      ? await imageStorage.getVariant(image, width).catch(() => image)
      : image;
    await serveImage(context, requestedImage);
  }

  return [
    {
      method: "GET",
      path: "/images/:imageId",
      access: "authenticated",
      // Requested by an <img> element, which cannot send a CSRF header. Safe:
      // read-only, and the session cookie still authorizes it.
      skipCsrf: true,
      handle: async (context) => {
        const principal = context.requirePrincipal();
        const imageId = requireUuid(context.params.imageId, "imageId");

        const image = await images.getById(imageId);
        if (!image) throw notFound();

        // Artwork inherits the visibility of the item it belongs to; holding an
        // image id is not authorization.
        if (
          !(await catalogue.canUserAccessItem(principal.userId, image.itemId))
        ) {
          throw notFound();
        }

        await serveRequestedSize(context, image);
      },
    },

    {
      method: "GET",
      path: "/items/:itemId/images/:imageType",
      access: "authenticated",
      skipCsrf: true,
      handle: async (context) => {
        const principal = context.requirePrincipal();
        const itemId = requireUuid(context.params.itemId, "itemId");
        const imageType = parseEnum(
          context.params.imageType ?? null,
          IMAGE_TYPES,
          "cover",
          "imageType",
        );
        const imageIndex =
          parseOptionalNonNegativeInteger(
            context.url.searchParams.get("index"),
            "index",
            50,
          ) ?? 0;

        if (!(await catalogue.canUserAccessItem(principal.userId, itemId))) {
          throw notFound();
        }

        let image = await images.findByItemAndType(
          itemId,
          imageType,
          imageIndex,
        );

        // An episode with no artwork of its own falls back to its season's and
        // then its series', which is what the card is expected to show.
        if (!image) {
          const item = await catalogue.getItem(principal.userId, itemId);
          const parents = [item?.parentId, item?.seriesId].filter(
            (id): id is string => typeof id === "string",
          );
          for (const parentId of parents) {
            image = await images.findByItemAndType(
              parentId,
              imageType,
              imageIndex,
            );
            if (image) break;
          }
        }

        if (!image) throw notFound();

        let logoLayout: LogoLayout | undefined;
        if (
          context.url.searchParams.get("variant") === CARD_LOGO_OVERLAY_VARIANT
        ) {
          if (imageType !== "logo") {
            throw new OwnApiError(
              "INVALID_IMAGE_VARIANT",
              "The card logo overlay is only available for logos.",
              422,
            );
          }
          const layoutItemId = requireUuid(
            context.url.searchParams.get("layoutItemId") ?? undefined,
            "layoutItemId",
          );
          const layoutItem = await catalogue.getItem(
            principal.userId,
            layoutItemId,
          );
          if (!layoutItem?.logoLayout) throw notFound();
          logoLayout = layoutItem.logoLayout;
        }

        await serveRequestedSize(context, image, logoLayout);
      },
    },
  ];
}
