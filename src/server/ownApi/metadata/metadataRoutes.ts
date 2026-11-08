import { OwnApiError } from "../ownApiHandler";
import { sendAccepted, sendData } from "../api/envelope";
import type { RouteDefinition } from "../api/router";
import {
  asObjectBody,
  optionalBodyString,
  optionalBodyStringArray,
  parseOptionalUuid,
  requireUuid,
} from "../api/validation";
import type { JobQueue } from "../tasks/jobQueue";
import { JOB_TYPES } from "../tasks/jobHandlers";
import type { MetadataRepository } from "./metadataRepository";
import type { TmdbClient } from "./tmdbClient";
import { selectBestMatch } from "./matcher";

export interface MetadataRoutesOptions {
  metadata: MetadataRepository;
  tmdb: TmdbClient;
  queue: JobQueue;
}

const LOCKABLE_FIELDS = [
  "identity",
  "title",
  "originalTitle",
  "overview",
  "tagline",
  "premiereDate",
  "productionYear",
  "officialRating",
];

function itemNotFound(): OwnApiError {
  return new OwnApiError(
    "ITEM_NOT_FOUND",
    "The requested item could not be found.",
    404,
  );
}

export function createMetadataRoutes({
  metadata,
  tmdb,
  queue,
}: MetadataRoutesOptions): RouteDefinition[] {
  return [
    {
      method: "GET",
      path: "/admin/items/:itemId/metadata/candidates",
      access: "admin",
      handle: async (context) => {
        const itemId = requireUuid(context.params.itemId, "itemId");
        const target = await metadata.getTarget(itemId);
        if (!target) throw itemNotFound();

        const searchTitle =
          context.url.searchParams.get("q")?.trim() || target.title;
        const candidates =
          target.kind === "series"
            ? await tmdb.searchSeries(
                searchTitle,
                target.productionYear ?? undefined,
              )
            : await tmdb.searchMovies(
                searchTitle,
                target.productionYear ?? undefined,
              );

        // The suggested match is returned alongside the list so an operator can
        // see what the automatic pass would have chosen, and why it did not.
        const suggested = selectBestMatch(
          {
            title: target.title,
            ...(target.productionYear === null
              ? {}
              : { year: target.productionYear }),
          },
          candidates,
        );

        sendData(context.response, context.requestId, {
          candidates,
          suggested: suggested
            ? {
                providerId: suggested.candidate.providerId,
                confidence: suggested.confidence,
              }
            : null,
        });
      },
    },

    {
      method: "POST",
      path: "/admin/items/:itemId/identify",
      access: "admin",
      handle: async (context) => {
        const itemId = requireUuid(context.params.itemId, "itemId");
        const target = await metadata.getTarget(itemId);
        if (!target) throw itemNotFound();

        const body = asObjectBody(await context.readJson(2 * 1_024), [
          "providerId",
        ]);
        const providerId = optionalBodyString(body, "providerId", {
          maxLength: 32,
        });
        if (!providerId || !/^[0-9]+$/.test(providerId)) {
          throw new OwnApiError(
            "VALIDATION_FAILED",
            "providerId is invalid.",
            422,
          );
        }

        // An operator's explicit choice is recorded and the identity locked, so
        // a later automatic pass cannot undo it.
        await metadata.applyTitleMetadata(itemId, {
          providerIds: { tmdb: providerId },
          metadataState: "matched",
        });
        await metadata.lockFields(itemId, ["identity"]);

        const taskId = await queue.enqueue({
          jobType: JOB_TYPES.metadataRefresh,
          payload: { itemId },
          dedupeKey: `${JOB_TYPES.metadataRefresh}:${itemId}`,
        });
        sendAccepted(context.response, context.requestId, taskId);
      },
    },

    {
      method: "POST",
      path: "/admin/items/:itemId/metadata/refresh",
      access: "admin",
      handle: async (context) => {
        const itemId = requireUuid(context.params.itemId, "itemId");
        if (!(await metadata.getTarget(itemId))) throw itemNotFound();

        const taskId = await queue.enqueue({
          jobType: JOB_TYPES.metadataRefresh,
          payload: { itemId },
          dedupeKey: `${JOB_TYPES.metadataRefresh}:${itemId}`,
        });
        sendAccepted(context.response, context.requestId, taskId);
      },
    },

    {
      method: "POST",
      path: "/admin/metadata/refresh",
      access: "admin",
      handle: async (context) => {
        const libraryId = parseOptionalUuid(
          context.url.searchParams.get("libraryId"),
          "libraryId",
        );
        const taskId = await queue.enqueue({
          jobType: JOB_TYPES.metadataScan,
          payload: libraryId ? { libraryId } : {},
          dedupeKey: `${JOB_TYPES.metadataScan}:${libraryId ?? "all"}`,
        });
        sendAccepted(context.response, context.requestId, taskId);
      },
    },

    {
      method: "PATCH",
      path: "/admin/items/:itemId/metadata",
      access: "admin",
      handle: async (context) => {
        const itemId = requireUuid(context.params.itemId, "itemId");
        if (!(await metadata.getTarget(itemId))) throw itemNotFound();

        const body = asObjectBody(await context.readJson(16 * 1_024), [
          "title",
          "originalTitle",
          "overview",
          "tagline",
          "officialRating",
          "lockFields",
        ]);

        const lockFields = optionalBodyStringArray(body, "lockFields", {
          maxItems: LOCKABLE_FIELDS.length,
          maxLength: 40,
        });
        if (lockFields?.some((field) => !LOCKABLE_FIELDS.includes(field))) {
          throw new OwnApiError(
            "VALIDATION_FAILED",
            "lockFields contains an unknown field.",
            422,
          );
        }

        const title = optionalBodyString(body, "title", { maxLength: 500 });
        const update = {
          ...(title ? { title } : {}),
          ...(optionalBodyString(body, "originalTitle", { maxLength: 500 })
            ? {
                originalTitle: optionalBodyString(body, "originalTitle", {
                  maxLength: 500,
                }) as string,
              }
            : {}),
          ...(optionalBodyString(body, "overview", { maxLength: 5_000 })
            ? {
                overview: optionalBodyString(body, "overview", {
                  maxLength: 5_000,
                }) as string,
              }
            : {}),
          ...(optionalBodyString(body, "tagline", { maxLength: 500 })
            ? {
                tagline: optionalBodyString(body, "tagline", {
                  maxLength: 500,
                }) as string,
              }
            : {}),
          ...(optionalBodyString(body, "officialRating", { maxLength: 32 })
            ? {
                officialRating: optionalBodyString(body, "officialRating", {
                  maxLength: 32,
                }) as string,
              }
            : {}),
        };

        // Edited fields are locked implicitly: an operator who bothered to type
        // a title does not expect the next refresh to replace it.
        const impliedLocks = Object.keys(update);
        const fieldsToLock = [
          ...new Set([...(lockFields ?? []), ...impliedLocks]),
        ];

        // The operator's value passes through any lock already on the field:
        // a field is locked because they edited it before, and a second edit
        // of their own must land rather than be refused by their first.
        if (Object.keys(update).length > 0) {
          await metadata.applyTitleMetadata(itemId, update, {
            overrideLocks: true,
          });
        }
        if (fieldsToLock.length > 0) {
          await metadata.lockFields(itemId, fieldsToLock);
        }

        sendData(context.response, context.requestId, {
          itemId,
          lockedFields: fieldsToLock,
        });
      },
    },
  ];
}
