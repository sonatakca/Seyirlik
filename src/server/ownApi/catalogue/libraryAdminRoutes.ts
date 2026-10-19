import type { RouteDefinition } from "../api/router";
import { sendData } from "../api/envelope";
import {
  asObjectBody,
  requireBodyString,
  requireUuid,
  validationError,
} from "../api/validation";
import type { TmdbClient } from "../metadata/tmdbClient";
import type { JobQueue } from "../tasks/jobQueue";
import { JOB_TYPES } from "../tasks/jobHandlers";
import { OwnApiError } from "../ownApiHandler";
import {
  cacheSeriesCatalogue,
  loadTitleDetail,
  type LibraryAdminRepository,
} from "./libraryAdmin";
import { TitleRemovalError, type TitleRemoval } from "./titleRemoval";

const REMOVAL_STATUS: Record<TitleRemovalError["code"], number> = {
  "not-found": 404,
  confirmation: 400,
  busy: 409,
  unsafe: 409,
};

/** Administrator-only: every title, including the ones with nothing to play. */
export function createLibraryAdminRoutes(options: {
  repository: LibraryAdminRepository;
  tmdb: TmdbClient | undefined;
  removal: TitleRemoval;
  queue: JobQueue;
}): RouteDefinition[] {
  const catalogue = options.tmdb && cacheSeriesCatalogue(options.tmdb);
  return [
    {
      /**
       * Fetches TMDB artwork for every matched title whose cover is missing or
       * whose stored file is gone. One metadata refresh per title, keyed as a
       * hand-pressed refresh is, so pressing this twice queues nothing new.
       */
      method: "POST",
      path: "/library/titles/artwork",
      access: "admin",
      handle: async (context) => {
        context.requirePrincipal();
        const missing = await options.repository.titlesMissingArtwork();
        for (const itemId of missing)
          await options.queue.enqueue({
            jobType: JOB_TYPES.metadataRefresh,
            payload: { itemId },
            dedupeKey: `${JOB_TYPES.metadataRefresh}:${itemId}`,
          });
        sendData(context.response, context.requestId, {
          queued: missing.length,
        });
      },
    },
    {
      method: "GET",
      path: "/library/titles",
      access: "admin",
      handle: async (context) => {
        context.requirePrincipal();
        const kind = context.url.searchParams.get("kind") ?? "movie";
        if (kind !== "movie" && kind !== "series" && kind !== "book")
          throw validationError("Choose movies, shows or books.");
        sendData(context.response, context.requestId, {
          items: await options.repository.listTitles(kind),
        });
      },
    },
    {
      method: "GET",
      path: "/library/titles/:itemId",
      access: "admin",
      handle: async (context) => {
        context.requirePrincipal();
        const detail = await loadTitleDetail(
          options.repository,
          catalogue,
          requireUuid(context.params.itemId, "itemId"),
        );
        if (!detail)
          throw new OwnApiError("NOT_FOUND", "No such movie or show.", 404);
        sendData(context.response, context.requestId, detail);
      },
    },
    {
      /**
       * A removal's deletion, which goes on after `/remove` has answered: the
       * catalogue lets go at once, the bytes can take minutes on a Drive mount.
       */
      method: "GET",
      path: "/library/removals/:itemId",
      access: "admin",
      handle: async (context) => {
        context.requirePrincipal();
        const status = options.removal.status(
          requireUuid(context.params.itemId, "itemId"),
        );
        if (!status)
          throw new OwnApiError("NOT_FOUND", "No such removal.", 404);
        sendData(context.response, context.requestId, status);
      },
    },
    {
      /**
       * Irreversible. The body must repeat the title, so a request cannot be
       * produced by a stray click or a replayed id alone.
       */
      method: "POST",
      path: "/library/titles/:itemId/remove",
      access: "admin",
      handle: async (context) => {
        context.requirePrincipal();
        const itemId = requireUuid(context.params.itemId, "itemId");
        const body = asObjectBody(await context.readJson(), ["confirmTitle"]);
        const confirmTitle = requireBodyString(body, "confirmTitle", {
          maxLength: 500,
        });
        try {
          sendData(
            context.response,
            context.requestId,
            await options.removal.remove(itemId, confirmTitle),
          );
        } catch (error) {
          if (error instanceof TitleRemovalError)
            throw new OwnApiError(
              `REMOVAL_${error.code.toUpperCase().replace("-", "_")}`,
              error.message,
              REMOVAL_STATUS[error.code],
            );
          throw error;
        }
      },
    },
  ];
}
