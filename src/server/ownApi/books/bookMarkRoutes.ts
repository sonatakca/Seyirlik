import { OwnApiError } from "../ownApiHandler";
import { sendData } from "../api/envelope";
import type { RouteDefinition } from "../api/router";
import {
  asObjectBody,
  requireBodyInteger,
  requireBodyString,
  requireUuid,
  validationError,
} from "../api/validation";
import type { CatalogueRepository } from "../catalogue/catalogueRepository";
import {
  BOOK_MARK_COLORS,
  type BookMark,
  type BookMarkChange,
  type BookMarkColor,
  type BookMarkRepository,
} from "./bookMarkRepository";

export interface BookMarkRoutesOptions {
  marks: BookMarkRepository;
  catalogue: CatalogueRepository;
}

export interface BookMarkDto {
  id: string;
  cfi: string;
  label: string;
  excerpt: string;
  progress: number | null;
  color: BookMarkColor | null;
  /** ms since the epoch. */
  createdAt: number;
  changedAt: number;
}

/** The most changes one request may carry; a device with more sends several. */
export const MAX_MARK_CHANGES = 20;
export const MAX_MARK_CFI_LENGTH = 4_096;
export const MAX_MARK_LABEL_LENGTH = 500;
export const MAX_MARK_EXCERPT_LENGTH = 10_000;

const MARK_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
/** Nothing was marked before Seyirlik had books. */
const EARLIEST_MARK_AT = Date.UTC(2020, 0, 1);

function toDto(mark: BookMark): BookMarkDto {
  return {
    id: mark.id,
    cfi: mark.cfi,
    label: mark.label,
    excerpt: mark.excerpt,
    progress: mark.progress,
    color: mark.color,
    createdAt: mark.createdAt.getTime(),
    changedAt: mark.changedAt.getTime(),
  };
}

function readMoment(body: Record<string, unknown>, field: string): Date {
  return new Date(
    requireBodyInteger(body, field, {
      min: EARLIEST_MARK_AT,
      max: Number.MAX_SAFE_INTEGER,
    }),
  );
}

function readChange(value: unknown): BookMarkChange {
  const change = asObjectBody(
    value,
    ["id", "changedAt", "mark"],
    "changes is invalid.",
  );
  const id = change.id;
  if (typeof id !== "string" || !MARK_ID_PATTERN.test(id)) {
    throw validationError("id is invalid.");
  }
  const changedAt = readMoment(change, "changedAt");
  if (change.mark === null) {
    return { id, changedAt, mark: null };
  }

  const mark = asObjectBody(
    change.mark,
    ["cfi", "label", "excerpt", "progress", "color", "createdAt"],
    "mark is invalid.",
  );
  const cfi = requireBodyString(mark, "cfi", {
    maxLength: MAX_MARK_CFI_LENGTH,
  });
  if (!/^epubcfi\(.+\)$/.test(cfi)) {
    throw validationError("cfi is invalid.");
  }
  const progress = mark.progress ?? null;
  if (
    progress !== null &&
    (typeof progress !== "number" ||
      !Number.isFinite(progress) ||
      progress < 0 ||
      progress > 1)
  ) {
    throw validationError("progress is invalid.");
  }
  const color = mark.color ?? null;
  if (color !== null && !BOOK_MARK_COLORS.includes(color as BookMarkColor)) {
    throw validationError("color is invalid.");
  }

  return {
    id,
    changedAt,
    mark: {
      cfi,
      label: requireBodyString(mark, "label", {
        minLength: 0,
        maxLength: MAX_MARK_LABEL_LENGTH,
      }),
      excerpt: requireBodyString(mark, "excerpt", {
        minLength: 0,
        maxLength: MAX_MARK_EXCERPT_LENGTH,
      }),
      progress,
      color: color as BookMarkColor | null,
      createdAt: readMoment(mark, "createdAt"),
    },
  };
}

export function createBookMarkRoutes({
  marks,
  catalogue,
}: BookMarkRoutesOptions): RouteDefinition[] {
  /**
   * Only a book the caller can see has marks. An item in a library they
   * cannot see answers exactly like one that does not exist, so the route
   * cannot be used to probe for content.
   */
  async function requireBook(userId: string, itemId: string): Promise<void> {
    const item = await catalogue.getItem(userId, itemId);
    if (!item || item.kind !== "book") {
      throw new OwnApiError(
        "ITEM_NOT_FOUND",
        "The requested item could not be found.",
        404,
      );
    }
  }

  return [
    {
      method: "GET",
      path: "/books/:itemId/marks",
      access: "authenticated",
      handle: async (context) => {
        const principal = context.requirePrincipal();
        const itemId = requireUuid(context.params.itemId, "itemId");
        await requireBook(principal.userId, itemId);
        sendData(
          context.response,
          context.requestId,
          (await marks.list(principal.userId, itemId)).map(toDto),
        );
      },
    },
    {
      method: "POST",
      path: "/books/:itemId/marks",
      access: "authenticated",
      handle: async (context) => {
        const principal = context.requirePrincipal();
        const itemId = requireUuid(context.params.itemId, "itemId");
        await requireBook(principal.userId, itemId);

        const body = asObjectBody(await context.readJson(2 * 1_024 * 1_024), [
          "changes",
        ]);
        if (
          !Array.isArray(body.changes) ||
          body.changes.length < 1 ||
          body.changes.length > MAX_MARK_CHANGES
        ) {
          throw validationError("changes is invalid.");
        }
        const changes = body.changes.map(readChange);
        if (
          new Set(changes.map((change) => change.id)).size !== changes.length
        ) {
          throw validationError("changes is invalid.");
        }

        // A change that loses to a later one is not an error: the reply is
        // every mark now on record, so the device that lost takes the winner.
        sendData(
          context.response,
          context.requestId,
          (await marks.apply(principal.userId, itemId, changes)).map(toDto),
        );
      },
    },
  ];
}
