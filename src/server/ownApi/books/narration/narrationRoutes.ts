import { createHash, randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { OwnApiError } from "../../ownApiHandler";
import { sendData } from "../../api/envelope";
import { serveFile } from "../../api/fileDelivery";
import type {
  RouteContext,
  RouteDefinition,
  RouteNarrator,
} from "../../api/router";
import {
  asObjectBody,
  requireUuid,
  validationError,
} from "../../api/validation";
import type { CatalogueRepository } from "../../catalogue/catalogueRepository";
import { BookRejectedError } from "../epubArchive";
import { bookFilePath } from "../bookRoutes";
import {
  NARRATION_SCRIPT_VERSION,
  buildNarrationScript,
  type NarrationScript,
} from "./narrationScript";
import type {
  BookNarration,
  NarrationApproval,
  NarrationProgress,
  NarrationRepository,
  NarrationSection,
} from "./narrationRepository";
import {
  MAX_NARRATION_PART_BYTES,
  StagedAudioError,
  StagedSizeError,
  type NarrationStore,
} from "./narrationStore";
import { TimingsError, checkTimings } from "./narrationTimings";
import {
  CheckError,
  checkLines,
  pronunciationKey,
  scriptHasWord,
  spokenForm,
  type NarrationCheckLine,
} from "./narrationReview";

/** A narrator's key: `snk_` and 32 random bytes, of which only the SHA-256 is kept. */
export const NARRATOR_KEY_PREFIX = "snk_";
/** A narration whose narrator has said nothing for this long can be taken by another. */
export const NARRATOR_STALE_SECONDS = 15 * 60;
/** The word timings of one section, with room: a long novel's are a few MB. */
const MAX_TIMINGS_BYTES = 32 * 1024 * 1024;
/** Every line of a section as it was heard: a long novel's are about a megabyte. */
const MAX_CHECK_BYTES = 32 * 1024 * 1024;
const CHUNK_ID = /^\d{1,6}-\d{1,7}-\d{1,5}$/;
const MAX_SECTION = 100_000;

export function newNarratorKey(): string {
  return `${NARRATOR_KEY_PREFIX}${randomBytes(32).toString("base64url")}`;
}

export function hashNarratorKey(key: string): Buffer {
  return createHash("sha256").update(key, "utf8").digest();
}

/**
 * The narrator a request's `Authorization: Bearer` key belongs to, or null.
 * A key is 256 random bits, so looking it up by its hash is safe to do
 * directly; a revoked key finds nothing.
 */
export function createNarratorResolver(
  narrations: Pick<NarrationRepository, "findKey">,
) {
  return async (request: IncomingMessage): Promise<RouteNarrator | null> => {
    const header = request.headers.authorization;
    const match =
      typeof header === "string" ? /^Bearer (\S+)$/.exec(header) : null;
    const key = match?.[1];
    if (!key?.startsWith(NARRATOR_KEY_PREFIX) || key.length > 200) return null;
    const found = await narrations.findKey(hashNarratorKey(key));
    return found ? { keyId: found.id, label: found.label } : null;
  };
}

export interface NarrationRoutesOptions {
  narrations: NarrationRepository;
  store: NarrationStore;
  catalogue: CatalogueRepository;
  mediaRoot: string;
}

/** What the reader is told: see BookNarration in src/lib/bookNarrationApi.ts. */
export interface BookNarrationDto {
  version: 1;
  state: BookNarration["state"] | "outdated";
  voice: string | null;
  requestedAt: string;
  finishedAt: string | null;
  progress: NarrationProgress | null;
  error: string | null;
  /** When a narrator last asked for work; for an administrator only. */
  narratorSeenAt?: string | null;
  sections: Array<{
    section: number;
    duration: number;
    version: string;
    /** Whether its lines were sent, for the review page; for an administrator only. */
    checked?: boolean;
  }>;
}

const notFound = () =>
  new OwnApiError("NARRATION_NOT_FOUND", "This book has no narration.", 404);
const notHeld = () =>
  new OwnApiError(
    "NARRATION_NOT_HELD",
    "This narrator is not reading that book.",
    409,
  );

function readSection(raw: string | undefined): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > MAX_SECTION)
    throw validationError("section is invalid.");
  return value;
}

function readChunk(raw: string | undefined): string {
  if (typeof raw !== "string" || !CHUNK_ID.test(raw))
    throw validationError("chunk is invalid.");
  return raw;
}

/** Approved in this very reading: one read again is heard otherwise. */
function isApproved(
  approval: NarrationApproval | undefined,
  line: NarrationCheckLine,
): boolean {
  return (
    approval !== undefined &&
    approval.heard === line.heard &&
    approval.duration === line.duration
  );
}

const finite = (value: unknown, min: number, max: number) =>
  typeof value === "number" &&
  Number.isFinite(value) &&
  value >= min &&
  value <= max;

/** The most lines a narrator reads at once, with room (it reads four). */
const MAX_READING = 16;

function readProgress(raw: unknown): NarrationProgress {
  const body = asObjectBody(
    raw,
    [
      "fraction",
      "sectionsDone",
      "sectionsTotal",
      "etaSeconds",
      "activity",
      "section",
      "reading",
      "sent",
    ],
    "The progress is invalid.",
  );
  const { fraction, sectionsDone, sectionsTotal, etaSeconds, activity } = body;
  // Said only by narrators that know them; an older one leaves them out.
  const { section = null, reading = [], sent = null } = body;
  if (
    !(
      section === null ||
      (Number.isInteger(section) && finite(section, 0, MAX_SECTION))
    ) ||
    !(sent === null || finite(sent, 0, 1)) ||
    !Array.isArray(reading) ||
    reading.length > MAX_READING ||
    !reading.every((entry: unknown) => {
      if (typeof entry !== "object" || entry === null) return false;
      const { chunk, take, ...rest } = entry as Record<string, unknown>;
      return (
        Object.keys(rest).length === 0 &&
        typeof chunk === "string" &&
        CHUNK_ID.test(chunk) &&
        Number.isInteger(take) &&
        finite(take, 1, 100)
      );
    })
  )
    throw validationError("The progress is invalid.");
  if (
    !finite(fraction, 0, 1) ||
    !Number.isInteger(sectionsDone) ||
    !Number.isInteger(sectionsTotal) ||
    !finite(sectionsDone, 0, MAX_SECTION) ||
    !finite(sectionsTotal, 0, MAX_SECTION) ||
    (etaSeconds !== null && !finite(etaSeconds, 0, 365 * 24 * 3600)) ||
    (activity !== null &&
      (typeof activity !== "string" || !/^[a-z][a-z-]{0,31}$/.test(activity)))
  )
    throw validationError("The progress is invalid.");
  return {
    fraction: fraction as number,
    sectionsDone: sectionsDone as number,
    sectionsTotal: sectionsTotal as number,
    etaSeconds: etaSeconds === null ? null : Math.round(etaSeconds as number),
    activity: activity as string | null,
    section: section as number | null,
    reading: (reading as Array<{ chunk: string; take: number }>).map(
      ({ chunk, take }) => ({ chunk, take }),
    ),
    sent: sent as number | null,
  };
}

export function createNarrationRoutes({
  narrations,
  store,
  catalogue,
  mediaRoot,
}: NarrationRoutesOptions): RouteDefinition[] {
  const resolvedMediaRoot = path.resolve(mediaRoot);

  const removeFiles = (itemId: string) =>
    store
      .removeAll(itemId)
      .catch((error: unknown) =>
        console.error("narration.files.remove_failed", { itemId, error }),
      );

  /** The book a person can see, or 404 (a hidden book answers as a missing one). */
  const visibleBook = async (context: RouteContext) => {
    const principal = context.requirePrincipal();
    const itemId = requireUuid(context.params.itemId, "itemId");
    const item = await catalogue.getItem(principal.userId, itemId);
    if (!item || item.kind !== "book")
      throw new OwnApiError(
        "ITEM_NOT_FOUND",
        "The requested item could not be found.",
        404,
      );
    return { itemId, principal };
  };

  /**
   * A narration is outdated once the script it was read from is not the one
   * the server would give now, or the book's file is another edition: its
   * words point at text the reader no longer shows.
   */
  const isOutdated = async (narration: BookNarration) => {
    if (narration.scriptVersion === null) return false;
    if (narration.scriptVersion !== NARRATION_SCRIPT_VERSION) return true;
    const file = await catalogue.getPrimaryFile(narration.itemId);
    return !file || file.fingerprint !== narration.bookFingerprint;
  };

  /** The narration with sections a reader may play, or 404. */
  const playable = async (itemId: string) => {
    const found = await narrations.get(itemId);
    if (!found || (await isOutdated(found.narration))) throw notFound();
    return found;
  };

  const servedSection = (sections: NarrationSection[], section: number) => {
    const found = sections.find((row) => row.section === section);
    if (!found) throw notFound();
    return found;
  };

  // Scripts are built from the book's file, which lives on the media volume;
  // a narrator asks for one per book, and every upload is checked against it.
  const scripts = new Map<string, Promise<NarrationScript>>();
  const scriptOf = async (itemId: string, fingerprint: string | null) => {
    const file = await catalogue.getPrimaryFile(itemId);
    if (!file || file.missingSince !== null)
      throw new OwnApiError(
        "BOOK_FILE_MISSING",
        "The book's file is missing.",
        409,
      );
    if (fingerprint !== null && file.fingerprint !== fingerprint)
      throw new OwnApiError(
        "BOOK_CHANGED",
        "The book's file changed since this narration began; ask for work again.",
        409,
      );
    const key = `${file.id}:${file.fingerprint}`;
    let script = scripts.get(key);
    if (!script) {
      const absolutePath = bookFilePath(resolvedMediaRoot, file);
      if (!absolutePath)
        throw new OwnApiError(
          "BOOK_FILE_MISSING",
          "The book's file is missing.",
          409,
        );
      script = readFile(absolutePath).then(buildNarrationScript);
      script.catch(() => scripts.delete(key));
      scripts.set(key, script);
      while (scripts.size > 4)
        scripts.delete(scripts.keys().next().value as string);
    }
    try {
      return await script;
    } catch (error) {
      if (error instanceof BookRejectedError)
        throw new OwnApiError("BOOK_UNREADABLE", error.message, 422);
      throw error;
    }
  };

  /** The narration this narrator holds, or 409. */
  const held = async (context: RouteContext) => {
    const narrator = context.narrator;
    if (!narrator) throw notHeld();
    const itemId = requireUuid(context.params.itemId, "itemId");
    const found = await narrations.get(itemId);
    if (
      !found ||
      found.narration.state !== "narrating" ||
      found.narration.narratorKeyId !== narrator.keyId
    )
      throw notHeld();
    return { itemId, narrator, ...found };
  };

  /** A section's lines as the narrator sent them for its upload now, or null. */
  const checkedLines = async (
    itemId: string,
    row: NarrationSection,
  ): Promise<NarrationCheckLine[] | null> =>
    row.checked
      ? readFile(
          store.files(itemId, row.section, row.audioSha256).check,
          "utf8",
        ).then(
          (raw) => JSON.parse(raw) as NarrationCheckLine[],
          () => null,
        )
      : null;

  /** The line as it is heard in the narration now, or 409 when its section's lines are not there. */
  const currentLine = async (itemId: string, chunk: string) => {
    const found = await narrations.get(itemId);
    if (!found || (await isOutdated(found.narration))) throw notFound();
    const section = Number(chunk.split("-")[0]);
    const row = found.sections.find(
      (candidate) => candidate.section === section,
    );
    const line = row
      ? (await checkedLines(itemId, row))?.find(
          (candidate) => candidate.chunk === chunk,
        )
      : undefined;
    if (!line)
      throw new OwnApiError(
        "NARRATION_LINE_UNKNOWN",
        "That line is not heard in the narration as it is now.",
        409,
      );
    return line;
  };

  const toDto = async (
    narration: BookNarration,
    sections: NarrationSection[],
    administrator: boolean,
  ): Promise<BookNarrationDto> => {
    const outdated = await isOutdated(narration);
    return {
      version: 1,
      state: outdated ? "outdated" : narration.state,
      voice: narration.voice,
      requestedAt: narration.requestedAt.toISOString(),
      finishedAt: narration.finishedAt?.toISOString() ?? null,
      progress: narration.progress,
      error: narration.error,
      ...(administrator
        ? {
            narratorSeenAt:
              (await narrations.lastSeen())?.toISOString() ?? null,
          }
        : {}),
      sections: outdated
        ? []
        : sections.map((row) => ({
            section: row.section,
            duration: row.durationSeconds,
            // In the files' URLs, so a section replaced by a new upload is
            // fetched afresh and an unchanged one comes from the cache.
            version: row.audioSha256.slice(0, 16),
            // The review page follows a line read again by this: its new
            // lines are there to read once the section is checked.
            ...(administrator ? { checked: row.checked } : {}),
          })),
    };
  };

  const readerRoutes: RouteDefinition[] = [
    {
      method: "GET",
      path: "/books/:itemId/narration",
      access: "authenticated",
      handle: async (context) => {
        const { itemId, principal } = await visibleBook(context);
        const found = await narrations.get(itemId);
        if (!found) throw notFound();
        sendData(
          context.response,
          context.requestId,
          await toDto(
            found.narration,
            found.sections,
            principal.isAdministrator,
          ),
        );
      },
    },
    {
      method: "GET",
      path: "/books/:itemId/narration/sections/:section/words",
      access: "authenticated",
      handle: async (context) => {
        const { itemId } = await visibleBook(context);
        const section = readSection(context.params.section);
        const row = servedSection((await playable(itemId)).sections, section);
        const words = await readFile(
          store.files(itemId, section, row.audioSha256).words,
          "utf8",
        ).catch(() => {
          throw notFound();
        });
        sendData(context.response, context.requestId, JSON.parse(words));
      },
    },
    {
      method: "GET",
      path: "/books/:itemId/narration/sections/:section/audio",
      access: "authenticated",
      // An <audio> element asks for it, and cannot send a CSRF header.
      skipCsrf: true,
      handle: async (context) => {
        const { itemId } = await visibleBook(context);
        const section = readSection(context.params.section);
        const row = servedSection((await playable(itemId)).sections, section);
        const range = context.request.headers.range;
        await serveFile(
          context.response,
          store.files(itemId, section, row.audioSha256).audio,
          typeof range === "string" ? range : undefined,
          context.method === "HEAD",
          // The URL names the upload (?v=), so an unchanged section is never fetched twice.
          "private, max-age=31536000, immutable",
        );
      },
    },
  ];

  /**
   * Gives back to the narrator every narration a change of this word's
   * pronunciation touches: read through, or being read, of the edition the
   * book is now, with the word in its text. Returns how many.
   */
  const readAgainWith = async (key: string) => {
    let count = 0;
    for (const book of await narrations.list()) {
      if (book.state !== "ready" && book.state !== "narrating") continue;
      const found = await narrations.get(book.itemId);
      if (!found || (await isOutdated(found.narration))) continue;
      const script = await scriptOf(
        book.itemId,
        found.narration.bookFingerprint,
      ).catch(() => null);
      if (
        script &&
        scriptHasWord(script, key) &&
        (await narrations.readAgain(book.itemId))
      )
        count += 1;
    }
    return count;
  };

  const reviewRoutes: RouteDefinition[] = [
    {
      // The narrated books, for the review page to choose from.
      method: "GET",
      path: "/admin/narrations",
      access: "admin",
      handle: async (context) => {
        sendData(
          context.response,
          context.requestId,
          (await narrations.list()).map((book) => ({
            itemId: book.itemId,
            title: book.title,
            state: book.state,
            sections: book.sections,
            duration: book.duration,
            requestedAt: book.requestedAt.toISOString(),
          })),
        );
      },
    },
    {
      // Every line of the narration beside the book's text, as the narrator heard it.
      method: "GET",
      path: "/admin/books/:itemId/narration/review",
      access: "admin",
      handle: async (context) => {
        const { itemId } = await visibleBook(context);
        const found = await narrations.get(itemId);
        if (!found) throw notFound();
        const outdated = await isOutdated(found.narration);
        const script = outdated
          ? null
          : await scriptOf(itemId, found.narration.bookFingerprint).catch(
              () => null,
            );
        const asked = new Map(
          (await narrations.retakes(itemId)).map((row) => [
            row.chunk,
            row.count,
          ]),
        );
        const approvals = new Map(
          (await narrations.approvals(itemId)).map((row) => [row.chunk, row]),
        );
        const sections = await Promise.all(
          found.sections.map(async (row) => {
            const read = script?.sections.find(
              (candidate) => candidate.section === row.section,
            );
            const lines = read ? await checkedLines(itemId, row) : null;
            const texts = new Map(
              (read?.blocks ?? []).map((block) => [block.block, block.text]),
            );
            return {
              section: row.section,
              duration: row.durationSeconds,
              version: row.audioSha256.slice(0, 16),
              // Null when the narrator has not sent this upload's lines.
              lines:
                lines?.map((line) => ({
                  ...line,
                  text: (texts.get(line.block) ?? "").slice(
                    line.start,
                    line.end,
                  ),
                  asked: asked.get(line.chunk) ?? 0,
                  approved: isApproved(approvals.get(line.chunk), line),
                })) ?? null,
            };
          }),
        );
        sendData(context.response, context.requestId, {
          narration: await toDto(found.narration, found.sections, true),
          sections,
          pronunciations: (await narrations.pronunciations()).map((row) => ({
            word: row.word,
            spoken: row.spoken,
            updatedAt: row.updatedAt.toISOString(),
          })),
        });
      },
    },
    {
      // Asks for one line to be read again; the narrator reads it, and nothing else, next.
      method: "POST",
      path: "/admin/books/:itemId/narration/retakes",
      access: "admin",
      handle: async (context) => {
        const { itemId, principal } = await visibleBook(context);
        const body = asObjectBody(await context.readJson(), ["chunk"]);
        if (typeof body.chunk !== "string" || !CHUNK_ID.test(body.chunk))
          throw validationError("chunk is invalid.");
        const found = await narrations.get(itemId);
        if (!found || (await isOutdated(found.narration))) throw notFound();
        const section = Number(body.chunk.split("-")[0]);
        if (!found.sections.some((row) => row.section === section))
          throw new OwnApiError(
            "NARRATION_SECTION_UNKNOWN",
            "That line is in a section not read yet.",
            409,
          );
        const count = await narrations.addRetake(
          itemId,
          body.chunk,
          principal.userId,
        );
        // Asked for again is not right as it is: the new reading is judged anew.
        await narrations.unapprove(itemId, body.chunk);
        await narrations.readAgain(itemId);
        sendData(context.response, context.requestId, {
          chunk: body.chunk,
          count,
        });
      },
    },
    {
      // Takes a line as right in the reading there is now: it is no longer one to listen to.
      method: "PUT",
      path: "/admin/books/:itemId/narration/approvals/:chunk",
      access: "admin",
      handle: async (context) => {
        const { itemId, principal } = await visibleBook(context);
        const chunk = readChunk(context.params.chunk);
        const line = await currentLine(itemId, chunk);
        await narrations.approve(
          itemId,
          { chunk, heard: line.heard, duration: line.duration },
          principal.userId,
        );
        sendData(context.response, context.requestId, {
          chunk,
          approved: true,
        });
      },
    },
    {
      method: "DELETE",
      path: "/admin/books/:itemId/narration/approvals/:chunk",
      access: "admin",
      handle: async (context) => {
        const { itemId } = await visibleBook(context);
        const chunk = readChunk(context.params.chunk);
        await narrations.unapprove(itemId, chunk);
        sendData(context.response, context.requestId, {
          chunk,
          approved: false,
        });
      },
    },
    {
      method: "GET",
      path: "/admin/narration/pronunciations",
      access: "admin",
      handle: async (context) => {
        sendData(
          context.response,
          context.requestId,
          (await narrations.pronunciations()).map((row) => ({
            word: row.word,
            spoken: row.spoken,
            updatedAt: row.updatedAt.toISOString(),
          })),
        );
      },
    },
    {
      // Says a word another way in every book, and has the books with it read where it is.
      method: "PUT",
      path: "/admin/narration/pronunciations/:word",
      access: "admin",
      handle: async (context) => {
        const principal = context.requirePrincipal();
        const word = pronunciationKey(context.params.word ?? "");
        if (!word) throw validationError("That is not one word.");
        const body = asObjectBody(await context.readJson(), ["spoken"]);
        const spoken = spokenForm(body.spoken);
        if (!spoken)
          throw validationError("Say how the word sounds, in letters.");
        await narrations.setPronunciation(word, spoken, principal.userId);
        sendData(context.response, context.requestId, {
          word,
          spoken,
          books: await readAgainWith(word),
        });
      },
    },
    {
      method: "DELETE",
      path: "/admin/narration/pronunciations/:word",
      access: "admin",
      handle: async (context) => {
        const word = pronunciationKey(context.params.word ?? "");
        if (!word || !(await narrations.removePronunciation(word)))
          throw new OwnApiError(
            "PRONUNCIATION_NOT_FOUND",
            "That word is not on the list.",
            404,
          );
        sendData(context.response, context.requestId, {
          word,
          books: await readAgainWith(word),
        });
      },
    },
  ];

  const adminRoutes: RouteDefinition[] = [
    {
      // Whether a narrator is there to read, before a book is asked for.
      method: "GET",
      path: "/admin/narrator",
      access: "admin",
      handle: async (context) => {
        sendData(context.response, context.requestId, {
          seenAt: (await narrations.lastSeen())?.toISOString() ?? null,
        });
      },
    },
    {
      method: "POST",
      path: "/books/:itemId/narration",
      access: "admin",
      handle: async (context) => {
        const { itemId, principal } = await visibleBook(context);
        const file = await catalogue.getPrimaryFile(itemId);
        if (!file || file.missingSince !== null)
          throw new OwnApiError(
            "BOOK_FILE_MISSING",
            "The book's file is missing.",
            409,
          );
        if (!(await narrations.request(itemId, principal.userId)))
          throw new OwnApiError(
            "NARRATION_EXISTS",
            "This book is already narrated or on its way.",
            409,
          );
        const found = await narrations.get(itemId);
        sendData(
          context.response,
          context.requestId,
          await toDto(found!.narration, found!.sections, true),
          202,
        );
      },
    },
    {
      method: "DELETE",
      path: "/books/:itemId/narration",
      access: "admin",
      handle: async (context) => {
        const { itemId } = await visibleBook(context);
        if (!(await narrations.remove(itemId))) throw notFound();
        // The rows are gone first, so nothing names the files while they go.
        // A file still open (a listener, an upload) can keep Windows from
        // removing the folder; the narration is gone either way.
        await removeFiles(itemId);
        context.response.statusCode = 204;
        context.response.end();
      },
    },
  ];

  const narratorRoutes: RouteDefinition[] = [
    {
      method: "GET",
      path: "/narrator/hello",
      access: "narrator",
      handle: async (context) => {
        await narrations.touchKey(context.narrator!.keyId);
        sendData(context.response, context.requestId, {
          label: context.narrator!.label,
          scriptVersion: NARRATION_SCRIPT_VERSION,
        });
      },
    },
    {
      method: "POST",
      path: "/narrator/claim",
      access: "narrator",
      handle: async (context) => {
        const narrator = context.narrator!;
        const body = asObjectBody(await context.readJson(), ["voice"]);
        const voice = body.voice;
        if (
          typeof voice !== "string" ||
          !/^[a-z0-9][a-z0-9-]{0,39}$/.test(voice)
        )
          throw validationError("voice is invalid.");
        await narrations.touchKey(narrator.keyId);
        const claim = await narrations.claim({
          keyId: narrator.keyId,
          voice,
          scriptVersion: NARRATION_SCRIPT_VERSION,
          staleSeconds: NARRATOR_STALE_SECONDS,
          bookOf: async (itemId) => {
            if ((await catalogue.getItemKind(itemId)) !== "book") return null;
            const file = await catalogue.getPrimaryFile(itemId);
            return file && file.missingSince === null
              ? { fileId: file.id, fingerprint: file.fingerprint }
              : null;
          },
        });
        // What was uploaded for another voice, script or edition is gone.
        if (claim?.reset) await removeFiles(claim.narration.itemId);
        sendData(context.response, context.requestId, {
          job: claim
            ? {
                itemId: claim.narration.itemId,
                voice: claim.narration.voice,
                scriptVersion: claim.narration.scriptVersion,
                sections: claim.sections.map((row) => ({
                  section: row.section,
                  audioSha256: row.audioSha256,
                  checkSha256: row.checked ? row.audioSha256 : null,
                })),
                // How words are said, and the lines asked for again: both
                // are part of what the narrator reads a line as.
                pronunciations: (await narrations.pronunciations()).map(
                  (row) => ({ word: row.word, spoken: row.spoken }),
                ),
                retakes: await narrations.retakes(claim.narration.itemId),
              }
            : null,
        });
      },
    },
    {
      method: "GET",
      path: "/narrator/jobs/:itemId/script",
      access: "narrator",
      handle: async (context) => {
        const { itemId, narration } = await held(context);
        sendData(
          context.response,
          context.requestId,
          await scriptOf(itemId, narration.bookFingerprint),
        );
      },
    },
    {
      method: "POST",
      path: "/narrator/jobs/:itemId/progress",
      access: "narrator",
      handle: async (context) => {
        const narrator = context.narrator!;
        const itemId = requireUuid(context.params.itemId, "itemId");
        const progress = readProgress(await context.readJson());
        if (!(await narrations.heartbeat(itemId, narrator.keyId, progress)))
          throw notHeld();
        context.response.statusCode = 204;
        context.response.end();
      },
    },
    {
      method: "GET",
      path: "/narrator/jobs/:itemId/sections/:section/staged",
      access: "narrator",
      handle: async (context) => {
        const { itemId } = await held(context);
        const section = readSection(context.params.section);
        sendData(context.response, context.requestId, {
          size: await store.stagedSize(itemId, section),
        });
      },
    },
    {
      method: "PUT",
      path: "/narrator/jobs/:itemId/sections/:section/audio",
      access: "narrator",
      handle: async (context) => {
        const { itemId } = await held(context);
        const section = readSection(context.params.section);
        const offset = Number(context.url.searchParams.get("offset"));
        const length = Number(context.request.headers["content-length"]);
        if (!Number.isInteger(offset) || offset < 0)
          throw validationError("offset is invalid.");
        if (
          !Number.isInteger(length) ||
          length <= 0 ||
          length > MAX_NARRATION_PART_BYTES
        )
          throw new OwnApiError(
            "NARRATION_PART_SIZE",
            `A part must say its length and carry at most ${MAX_NARRATION_PART_BYTES} bytes.`,
            413,
          );
        try {
          const size = await store.append(
            itemId,
            section,
            offset,
            context.request,
            length,
          );
          sendData(context.response, context.requestId, { size });
        } catch (error) {
          if (error instanceof StagedSizeError)
            throw new OwnApiError(
              "NARRATION_PART_OFFSET",
              `The upload so far is ${error.size} bytes; send the next part from there.`,
              409,
            );
          if (error instanceof StagedAudioError)
            throw new OwnApiError(
              "NARRATION_AUDIO_REJECTED",
              error.message,
              422,
            );
          throw error;
        }
      },
    },
    {
      method: "POST",
      path: "/narrator/jobs/:itemId/sections/:section",
      access: "narrator",
      handle: async (context) => {
        const { itemId, narrator, narration } = await held(context);
        const section = readSection(context.params.section);
        const body = asObjectBody(await context.readJson(MAX_TIMINGS_BYTES), [
          "sha256",
          "duration",
          "words",
        ]);
        const sha256 = body.sha256;
        if (typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256))
          throw validationError("sha256 is invalid.");
        const script = await scriptOf(itemId, narration.bookFingerprint);
        const read = script.sections.find(
          (candidate) => candidate.section === section,
        );
        if (!read)
          throw new OwnApiError(
            "NARRATION_SECTION_UNKNOWN",
            "The script has no such section.",
            422,
          );

        let words;
        try {
          words = checkTimings(read, body.words, body.duration as number);
        } catch (error) {
          if (error instanceof TimingsError)
            throw new OwnApiError(
              "NARRATION_TIMINGS_REJECTED",
              error.message,
              422,
            );
          throw error;
        }
        const duration = body.duration as number;
        let audioBytes: number;
        try {
          audioBytes = await store.commit(
            itemId,
            section,
            sha256,
            JSON.stringify({ version: 1, section, duration, words }),
          );
        } catch (error) {
          if (error instanceof StagedAudioError)
            throw new OwnApiError(
              "NARRATION_AUDIO_REJECTED",
              error.message,
              422,
            );
          throw error;
        }

        const committed = await narrations.commitSection(
          itemId,
          narrator.keyId,
          {
            section,
            audioSha256: sha256,
            audioBytes,
            durationSeconds: duration,
            wordCount: words.length,
          },
        );
        if (!committed) {
          // Taken away meanwhile: these files are nobody's, unless the very
          // same audio is what the book already serves.
          const now = await narrations.get(itemId);
          if (!now?.sections.some((row) => row.audioSha256 === sha256))
            await store.removeVersion(itemId, section, sha256);
          throw notHeld();
        }
        if (committed.replaced)
          await store.removeVersion(itemId, section, committed.replaced);
        sendData(context.response, context.requestId, { section, sha256 });
      },
    },
    {
      // Every line of an upload as the narrator heard it, for the review page.
      method: "PUT",
      path: "/narrator/jobs/:itemId/sections/:section/check",
      access: "narrator",
      handle: async (context) => {
        const { itemId, narrator, narration, sections } = await held(context);
        const section = readSection(context.params.section);
        const body = asObjectBody(await context.readJson(MAX_CHECK_BYTES), [
          "sha256",
          "lines",
        ]);
        const row = sections.find((candidate) => candidate.section === section);
        if (!row || row.audioSha256 !== body.sha256)
          throw new OwnApiError(
            "NARRATION_CHECK_STALE",
            "These lines are not of the section's audio as it is now.",
            409,
          );
        const script = await scriptOf(itemId, narration.bookFingerprint);
        const read = script.sections.find(
          (candidate) => candidate.section === section,
        );
        if (!read)
          throw new OwnApiError(
            "NARRATION_SECTION_UNKNOWN",
            "The script has no such section.",
            422,
          );
        let lines;
        try {
          lines = checkLines(read, body.lines, row.durationSeconds);
        } catch (error) {
          if (error instanceof CheckError)
            throw new OwnApiError(
              "NARRATION_CHECK_REJECTED",
              error.message,
              422,
            );
          throw error;
        }
        await store.writeCheck(
          itemId,
          section,
          row.audioSha256,
          JSON.stringify(lines),
        );
        if (
          !(await narrations.markChecked(
            itemId,
            narrator.keyId,
            section,
            row.audioSha256,
          ))
        )
          throw notHeld();
        context.response.statusCode = 204;
        context.response.end();
      },
    },
    {
      method: "POST",
      path: "/narrator/jobs/:itemId/finish",
      access: "narrator",
      handle: async (context) => {
        const { itemId, narrator, narration } = await held(context);
        const body = asObjectBody(await context.readJson(), ["ready", "error"]);
        let finished: boolean;
        if (body.ready === true) {
          const script = await scriptOf(itemId, narration.bookFingerprint);
          finished = await narrations.finish(itemId, narrator.keyId, {
            ready: true,
            sections: script.sections.map((read) => read.section),
          });
          if (!finished)
            throw new OwnApiError(
              "NARRATION_INCOMPLETE",
              "Not every section of the script is uploaded.",
              409,
            );
        } else if (
          body.ready === false &&
          typeof body.error === "string" &&
          body.error.trim()
        ) {
          finished = await narrations.finish(itemId, narrator.keyId, {
            ready: false,
            error: body.error.trim(),
          });
          if (!finished) throw notHeld();
        } else {
          throw validationError("Say ready, or not ready and why.");
        }
        context.response.statusCode = 204;
        context.response.end();
      },
    },
  ];

  return [...readerRoutes, ...adminRoutes, ...reviewRoutes, ...narratorRoutes];
}
