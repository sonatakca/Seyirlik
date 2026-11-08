import { OwnApiError } from "../ownApiHandler";
import { sendData } from "../api/envelope";
import type { RouteDefinition } from "../api/router";
import { asObjectBody, requireUuid } from "../api/validation";
import { headerValue, readBinaryBody } from "../api/http";
import type { ImageFocus } from "../catalogue/itemDto";
import type { ImageRepository } from "../images/imageRepository";
import type { ImageStorage } from "../images/imageStorage";
import type { JobQueue } from "../tasks/jobQueue";
import { JOB_TYPES } from "../tasks/jobHandlers";
import type { MetadataRepository, MetadataTarget } from "./metadataRepository";
import {
  PROVIDER_ARTWORK_SIZES,
  PROVIDER_PREVIEW_SIZE,
} from "./providerArtworkSizes";
import {
  TMDB_IMAGE_BASE_URL,
  type TmdbArtworkKind,
  type TmdbClient,
} from "./tmdbClient";

export interface ArtworkRoutesOptions {
  metadata: MetadataRepository;
  images: ImageRepository;
  imageStorage: ImageStorage;
  tmdb: TmdbClient;
  queue: JobQueue;
  /**
   * Told after a layout is saved, so the title's share card is drawn now —
   * while someone is looking at it — rather than by the first crawler to ask.
   */
  onLogoLayoutChanged?: (itemId: string) => void;
}

/**
 * How a provider artwork set maps onto a stored image type, and the width the
 * newly chosen variant is warmed at.
 *
 * The import sizes come from the shared table rather than being restated here:
 * the two copies drifted once already, and an operator's pick must land at the
 * same size as the automatic pass so a layout cannot shift simply because a
 * human chose the poster.
 */
const ARTWORK_TARGETS: Record<
  TmdbArtworkKind,
  { imageType: string; size: string; uploadPreviewWidth: number }
> = {
  poster: {
    imageType: "cover",
    size: PROVIDER_ARTWORK_SIZES.poster,
    uploadPreviewWidth: 440,
  },
  backdrop: {
    imageType: "backdrop",
    size: PROVIDER_ARTWORK_SIZES.backdrop,
    uploadPreviewWidth: 1280,
  },
  logo: {
    imageType: "logo",
    size: PROVIDER_ARTWORK_SIZES.logo,
    uploadPreviewWidth: 520,
  },
};

const PREVIEW_SIZE = PROVIDER_PREVIEW_SIZE;

const ARTWORK_KINDS = Object.keys(ARTWORK_TARGETS) as TmdbArtworkKind[];

/** Items that own a card/cover rather than inheriting one from a parent. */
const APPLICABLE_KINDS = new Set(["movie", "series", "book"]);
const TMDB_KINDS = new Set(["movie", "series"]);

/** Keep admin uploads comfortably below the storage layer's 12 MiB ceiling. */
const MAX_CUSTOM_IMAGE_BYTES = 8 * 1_024 * 1_024;
const MAX_CUSTOM_IMAGE_JSON_BYTES =
  Math.ceil((MAX_CUSTOM_IMAGE_BYTES * 4) / 3) + 4 * 1_024;
const CUSTOM_IMAGE_CONTENT_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
]);

function itemNotFound(): OwnApiError {
  return new OwnApiError(
    "ITEM_NOT_FOUND",
    "The requested item could not be found.",
    404,
  );
}

/**
 * TMDB file paths arrive from the provider but are echoed back to us by the
 * browser, so they are re-validated rather than trusted: the shape is a leading
 * slash, one path segment, and a known image extension.
 */
function requireProviderFilePath(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^\/[A-Za-z0-9_-]+\.(jpg|png|webp)$/.test(value)
  ) {
    throw new OwnApiError(
      "VALIDATION_FAILED",
      "filePath is not a provider image path.",
      422,
    );
  }
  return value;
}

function requireArtworkKind(value: unknown): TmdbArtworkKind {
  if (typeof value !== "string" || !(value in ARTWORK_TARGETS)) {
    throw new OwnApiError(
      "VALIDATION_FAILED",
      `kind must be one of ${ARTWORK_KINDS.join(", ")}.`,
      422,
    );
  }
  return value as TmdbArtworkKind;
}

function requireCustomImageBytes(
  contentType: unknown,
  dataBase64: unknown,
): { bytes: Buffer; contentType: string } {
  if (
    typeof contentType !== "string" ||
    !CUSTOM_IMAGE_CONTENT_TYPES.has(contentType)
  ) {
    throw new OwnApiError(
      "VALIDATION_FAILED",
      "contentType must be image/jpeg, image/png, or image/webp.",
      422,
    );
  }
  if (
    typeof dataBase64 !== "string" ||
    dataBase64.length === 0 ||
    dataBase64.length > Math.ceil((MAX_CUSTOM_IMAGE_BYTES * 4) / 3) + 4 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      dataBase64,
    )
  ) {
    throw new OwnApiError(
      "INVALID_ARTWORK_FILE",
      "The custom artwork is not a valid image upload.",
      422,
    );
  }

  const bytes = Buffer.from(dataBase64, "base64");
  if (
    bytes.length === 0 ||
    bytes.length > MAX_CUSTOM_IMAGE_BYTES ||
    bytes.toString("base64").replace(/=+$/, "") !==
      dataBase64.replace(/=+$/, "")
  ) {
    throw new OwnApiError(
      "INVALID_ARTWORK_FILE",
      "The custom artwork is not a valid image upload.",
      422,
    );
  }

  return { bytes, contentType };
}

export interface LogoLayout {
  x: number;
  y: number;
  width: number;
  shadow: number;
}

/** Matches the ranges the columns' constraints enforce. */
const MIN_LOGO_WIDTH = 0.15;
const MAX_LOGO_SHADOW = 2;

function requireFraction(
  value: unknown,
  field: string,
  minimum: number,
  maximum = 1,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new OwnApiError(
      "VALIDATION_FAILED",
      `${field} must be a number.`,
      422,
    );
  }
  if (value < minimum || value > maximum) {
    throw new OwnApiError(
      "VALIDATION_FAILED",
      `${field} must be between ${minimum} and ${maximum}.`,
      422,
    );
  }
  return value;
}

/**
 * A layout, or null to hand the card back to its untouched look.
 *
 * Null is a value here rather than an omission: clearing an adjustment and
 * failing to send one have to be told apart.
 */
function parseLogoLayout(value: unknown): LogoLayout | null {
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new OwnApiError(
      "VALIDATION_FAILED",
      "layout must be an object or null.",
      422,
    );
  }

  const layout = value as Record<string, unknown>;
  for (const key of Object.keys(layout)) {
    if (!["x", "y", "width", "shadow"].includes(key)) {
      throw new OwnApiError(
        "VALIDATION_FAILED",
        `layout has an unknown field: ${key}.`,
        422,
      );
    }
  }

  return {
    x: requireFraction(layout.x, "layout.x", 0),
    y: requireFraction(layout.y, "layout.y", 0),
    width: requireFraction(layout.width, "layout.width", MIN_LOGO_WIDTH),
    shadow: requireFraction(layout.shadow, "layout.shadow", 0, MAX_LOGO_SHADOW),
  };
}

/**
 * The point of a backdrop a crop keeps in view, or null to return to the
 * picture's centre. As with a logo layout, null is a value and not an
 * omission.
 */
function parseFocus(value: unknown): ImageFocus | null {
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new OwnApiError(
      "VALIDATION_FAILED",
      "focus must be an object or null.",
      422,
    );
  }
  const focus = value as Record<string, unknown>;
  for (const key of Object.keys(focus)) {
    if (key !== "x" && key !== "y") {
      throw new OwnApiError(
        "VALIDATION_FAILED",
        `focus has an unknown field: ${key}.`,
        422,
      );
    }
  }
  return {
    x: requireFraction(focus.x, "focus.x", 0),
    y: requireFraction(focus.y, "focus.y", 0),
  };
}

/**
 * A BCP 47 tag, which is all TMDB accepts. Anything else is rejected rather
 * than passed through, so a malformed value cannot reshape the provider query.
 */
function requireLanguageTag(value: string | null): string {
  const language = value?.trim() ?? "";
  if (!/^[a-z]{2}(-[A-Z]{2})?$/.test(language)) {
    throw new OwnApiError(
      "VALIDATION_FAILED",
      "language must be a tag such as tr-TR.",
      422,
    );
  }
  return language;
}

/**
 * The provider id to ask about, and the provider's own media type.
 *
 * A season or an episode has no artwork set of its own in this surface: the
 * automatic pass gives it the series' artwork, and an operator who wants to
 * change it changes the series.
 */
function resolveProviderTarget(target: MetadataTarget): {
  kind: "movie" | "tv";
  providerId: string;
} {
  if (!TMDB_KINDS.has(target.kind)) {
    throw new OwnApiError(
      "ARTWORK_NOT_APPLICABLE",
      "Artwork can only be chosen for a film or a series.",
      422,
    );
  }

  const providerId = target.providerIds.tmdb;
  if (!providerId) {
    throw new OwnApiError(
      "PROVIDER_ID_MISSING",
      "Identify this title against TMDB before choosing artwork.",
      409,
    );
  }

  return { kind: target.kind === "series" ? "tv" : "movie", providerId };
}

function requireArtworkTarget(target: MetadataTarget): void {
  if (!APPLICABLE_KINDS.has(target.kind)) {
    throw new OwnApiError(
      "ARTWORK_NOT_APPLICABLE",
      "Artwork can only be stored for a film, series, or book.",
      422,
    );
  }
}

function optionalProviderTarget(target: MetadataTarget): {
  kind: "movie" | "tv";
  providerId: string;
} | null {
  if (!TMDB_KINDS.has(target.kind) || !target.providerIds.tmdb) return null;
  return {
    kind: target.kind === "series" ? "tv" : "movie",
    providerId: target.providerIds.tmdb,
  };
}

export function createArtworkRoutes({
  metadata,
  images,
  imageStorage,
  tmdb,
  queue,
  onLogoLayoutChanged,
}: ArtworkRoutesOptions): RouteDefinition[] {
  async function requireTarget(itemId: string): Promise<MetadataTarget> {
    const target = await metadata.getTarget(itemId);
    if (!target) throw itemNotFound();
    return target;
  }

  return [
    {
      method: "GET",
      path: "/admin/items/:itemId/artwork",
      access: "admin",
      handle: async (context) => {
        const itemId = requireUuid(context.params.itemId, "itemId");
        const target = await requireTarget(itemId);
        requireArtworkTarget(target);
        const provider = optionalProviderTarget(target);

        const [candidates, lockedTypes, current] = await Promise.all([
          provider
            ? tmdb.listArtwork(provider.kind, provider.providerId)
            : Promise.resolve([]),
          images.listLockedTypes(itemId),
          images.listForItems([itemId]),
        ]);

        sendData(context.response, context.requestId, {
          item: {
            id: target.id,
            title: target.title,
            kind: target.kind,
            providerId: provider?.providerId ?? null,
          },
          // Which types an operator has taken over, so the page can offer to
          // hand each one back rather than guessing from the artwork alone.
          lockedTypes,
          current,
          candidates: candidates.map((candidate) => ({
            ...candidate,
            imageType: ARTWORK_TARGETS[candidate.kind].imageType,
            previewUrl: `${TMDB_IMAGE_BASE_URL}/${PREVIEW_SIZE}${candidate.filePath}`,
          })),
        });
      },
    },

    {
      /**
       * Stores artwork supplied by the administrator rather than TMDB.
       *
       * The image storage verifies magic bytes before anything reaches disk;
       * the declared MIME type alone is never trusted. The resulting row is
       * locked for the same reason a hand-picked TMDB image is locked: an
       * automatic metadata refresh must not undo an explicit choice.
       */
      method: "POST",
      path: "/admin/items/:itemId/artwork/upload",
      access: "admin",
      handle: async (context) => {
        const itemId = requireUuid(context.params.itemId, "itemId");
        const target = await requireTarget(itemId);
        requireArtworkTarget(target);

        const contentType = headerValue(context.request.headers["content-type"])
          ?.split(";", 1)[0]
          ?.trim()
          .toLowerCase();

        let kind: TmdbArtworkKind;
        let upload: { bytes: Buffer; contentType: string };
        if (contentType === "application/json") {
          // Temporary compatibility for a service worker that still holds the
          // first upload UI. New clients send the image bytes directly.
          const body = asObjectBody(
            await context.readJson(MAX_CUSTOM_IMAGE_JSON_BYTES),
            ["kind", "contentType", "dataBase64"],
          );
          kind = requireArtworkKind(body.kind);
          upload = requireCustomImageBytes(body.contentType, body.dataBase64);
        } else {
          kind = requireArtworkKind(context.url.searchParams.get("kind"));
          if (!contentType || !CUSTOM_IMAGE_CONTENT_TYPES.has(contentType)) {
            throw new OwnApiError(
              "VALIDATION_FAILED",
              "Content-Type must be image/jpeg, image/png, or image/webp.",
              422,
            );
          }
          upload = {
            bytes: await readBinaryBody(
              context.request,
              MAX_CUSTOM_IMAGE_BYTES,
            ),
            contentType,
          };
        }

        let stored;
        try {
          stored = target.titleRoot
            ? await imageStorage.storeTitleArtwork(
                upload.bytes,
                upload.contentType,
                target.titleRoot,
                ARTWORK_TARGETS[kind].imageType as
                  | "cover"
                  | "backdrop"
                  | "logo",
              )
            : await imageStorage.store(upload.bytes, upload.contentType);
        } catch {
          throw new OwnApiError(
            "INVALID_ARTWORK_FILE",
            "Upload a JPEG, PNG, or WebP image no larger than 8 MiB.",
            422,
          );
        }

        const artworkTarget = ARTWORK_TARGETS[kind];
        // Pay the conversion cost while the administrator is already waiting
        // for the upload. Ordinary library visits can then serve the small
        // cached cover immediately. Older uploads are converted lazily by the
        // image route the first time they are requested.
        await imageStorage
          .getVariant(stored, artworkTarget.uploadPreviewWidth)
          .catch(() => undefined);

        const imageType = artworkTarget.imageType;
        const imageId = await images.replaceLocked({
          itemId,
          imageType,
          imageIndex: 0,
          contentHash: stored.contentHash,
          contentType: stored.contentType,
          width: null,
          height: null,
          sizeBytes: stored.sizeBytes,
          storageKey: stored.storageKey,
          source: "upload",
          sourceUrl: null,
        });

        sendData(context.response, context.requestId, {
          imageId,
          imageType,
          contentHash: stored.contentHash,
          isLocked: true,
        });
      },
    },

    {
      method: "POST",
      path: "/admin/items/:itemId/artwork",
      access: "admin",
      handle: async (context) => {
        const itemId = requireUuid(context.params.itemId, "itemId");
        const target = await requireTarget(itemId);
        resolveProviderTarget(target);

        const body = asObjectBody(await context.readJson(2 * 1_024), [
          "kind",
          "filePath",
        ]);
        const kind = requireArtworkKind(body.kind);
        const filePath = requireProviderFilePath(body.filePath);
        const { imageType, size } = ARTWORK_TARGETS[kind];

        const sourceUrl = tmdb.buildImageUrl(filePath, size);
        let stored;
        try {
          stored = target.titleRoot
            ? await imageStorage.fetchAndStoreTitleArtwork(
                sourceUrl,
                target.titleRoot,
                imageType as "cover" | "backdrop" | "logo",
              )
            : await imageStorage.fetchAndStore(sourceUrl);
        } catch {
          // Deliberately not the underlying message: it can carry the request
          // URL, and a v3 credential rides in that query string.
          throw new OwnApiError(
            "ARTWORK_FETCH_FAILED",
            "The chosen artwork could not be downloaded.",
            502,
          );
        }

        const imageId = await images.replaceLocked({
          itemId,
          imageType,
          imageIndex: 0,
          contentHash: stored.contentHash,
          contentType: stored.contentType,
          width: null,
          height: null,
          sizeBytes: stored.sizeBytes,
          storageKey: stored.storageKey,
          source: "tmdb",
          sourceUrl,
        });

        sendData(context.response, context.requestId, {
          imageId,
          imageType,
          isLocked: true,
        });
      },
    },

    {
      method: "DELETE",
      path: "/admin/items/:itemId/artwork/:kind",
      access: "admin",
      handle: async (context) => {
        const itemId = requireUuid(context.params.itemId, "itemId");
        const target = await requireTarget(itemId);
        requireArtworkTarget(target);
        const kind = requireArtworkKind(context.params.kind);

        // Removing the row rather than only clearing the lock is what hands the
        // type back: the next refresh finds nothing stored and fetches the
        // provider's own choice again.
        const cleared = await images.clear(
          itemId,
          ARTWORK_TARGETS[kind].imageType,
          0,
        );

        // Reverting would otherwise leave the title with no artwork of this
        // kind until something else happened to refresh it, which reads as
        // breakage rather than as a revert.
        const taskId =
          cleared && optionalProviderTarget(target)
            ? await queue.enqueue({
                jobType: JOB_TYPES.metadataRefresh,
                payload: { itemId },
                dedupeKey: `${JOB_TYPES.metadataRefresh}:${itemId}`,
              })
            : null;

        sendData(context.response, context.requestId, {
          imageType: ARTWORK_TARGETS[kind].imageType,
          cleared,
          taskId,
        });
      },
    },

    {
      /**
       * Where the logo sits on this title's card, and how large it is.
       *
       * Unlike the artwork itself this is not a provider choice, so it needs no
       * TMDB match and applies to any item that has a logo to place.
       */
      method: "PUT",
      path: "/admin/items/:itemId/logo-layout",
      access: "admin",
      handle: async (context) => {
        const itemId = requireUuid(context.params.itemId, "itemId");

        const body = asObjectBody(await context.readJson(1_024), ["layout"]);
        const layout = parseLogoLayout(body.layout ?? null);

        if (!(await metadata.setLogoLayout(itemId, layout))) {
          throw itemNotFound();
        }
        onLogoLayoutChanged?.(itemId);

        sendData(context.response, context.requestId, { layout });
      },
    },

    {
      /**
       * Which part of this title's backdrop the heroes keep in view when they
       * crop it to their own shape.
       *
       * Stored on the backdrop itself, so it applies to the picture it was
       * chosen on and is cleared when the backdrop is replaced. Like the logo
       * layout it is not a provider choice and needs no TMDB match.
       */
      method: "PUT",
      path: "/admin/items/:itemId/backdrop-focus",
      access: "admin",
      handle: async (context) => {
        const itemId = requireUuid(context.params.itemId, "itemId");

        const body = asObjectBody(await context.readJson(1_024), ["focus"]);
        const focus = parseFocus(body.focus ?? null);

        await requireTarget(itemId);
        if (!(await images.setFocus(itemId, "backdrop", 0, focus))) {
          throw new OwnApiError(
            "NOT_FOUND",
            "This title has no backdrop to adjust.",
            404,
          );
        }

        sendData(context.response, context.requestId, { focus });
      },
    },

    {
      /**
       * The title as the provider writes it in one language, for an operator to
       * compare before overwriting what is stored. Nothing is saved here — the
       * existing metadata PATCH does that, so a preview can never be mistaken
       * for a commit.
       */
      method: "GET",
      path: "/admin/items/:itemId/metadata/preview",
      access: "admin",
      handle: async (context) => {
        const itemId = requireUuid(context.params.itemId, "itemId");
        const target = await requireTarget(itemId);
        const provider = resolveProviderTarget(target);
        const language = requireLanguageTag(
          context.url.searchParams.get("language"),
        );

        const details =
          provider.kind === "tv"
            ? await tmdb.getSeries(provider.providerId, language)
            : await tmdb.getMovie(provider.providerId, language);

        sendData(context.response, context.requestId, {
          language,
          title: details.title,
          originalTitle: details.originalTitle ?? null,
          overview: details.overview ?? null,
          tagline: details.tagline ?? null,
        });
      },
    },
  ];
}
