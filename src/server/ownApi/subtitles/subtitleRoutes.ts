import type { RouteDefinition } from "../api/router";
import { sendAccepted, sendData } from "../api/envelope";
import {
  asObjectBody,
  requireBodyString,
  requireUuid,
  validationError,
} from "../api/validation";
import type { JobQueue } from "../tasks/jobQueue";
import type { SubtitleRepository } from "./subtitleRepository";
import { normalizeWant } from "./subtitleState";
import { SUBTITLE_JOB_TYPES } from "./subtitleJobs";
import {
  parseSessionMaterial,
  type ProviderSessionVault,
} from "./providerSessionVault";
import type { SubtitleProvider } from "./subtitleProvider";
import {
  isOpenSubtitlesSlot,
  parseAccountInput,
  parseApiKey,
  type OpenSubtitlesAccountStore,
} from "./openSubtitlesAccounts";
import { OPENSUBTITLES_ID, openSubtitlesLogin } from "./openSubtitlesProvider";
import { OwnApiError } from "../ownApiHandler";
import { readBinaryBody } from "../api/http";
import { normalizeLanguage } from "../../../renditions/processing/languages";
import { MAX_SUBTITLE_BYTES } from "./subtitlePayload";
import type { SubtitleUploader } from "./subtitleUpload";
import type { SubtitleSyncService } from "./subtitleSync";

/** The providers this deployment asks, and where their sign-ins are kept. */
export interface SubtitleSessionRoutesOptions {
  readonly providers: readonly Pick<
    SubtitleProvider,
    "id" | "label" | "requiresSession" | "languages"
  >[];
  readonly vault: ProviderSessionVault;
  /** OpenSubtitles' API key and accounts, when it is one of the providers. */
  readonly openSubtitles?: {
    readonly accounts: OpenSubtitlesAccountStore;
    /** Signs an account in before it is saved, so a wrong password is said at once. */
    readonly login?: typeof openSubtitlesLogin;
  };
}

function parsePolicy(body: Record<string, unknown>) {
  if (
    (body.forced !== undefined && typeof body.forced !== "boolean") ||
    (body.replace !== undefined && typeof body.replace !== "boolean") ||
    (body.hearingImpaired !== undefined &&
      !["prefer", "avoid", "indifferent"].includes(
        String(body.hearingImpaired),
      ))
  )
    throw validationError("Invalid subtitle policy.");
  const want = normalizeWant({
    language: requireBodyString(body, "language", { maxLength: 16 }),
    forced: body.forced === true,
    hearingImpaired: body.hearingImpaired as
      | "prefer"
      | "avoid"
      | "indifferent"
      | undefined,
  });
  if (want.language === "und")
    throw validationError("A known subtitle language is required.");
  return want;
}

/**
 * The languages an uploaded subtitle may be filed under.
 *
 * The player only ever offers English and Turkish tracks, so accepting a third
 * would file a subtitle correctly and then never show it — a worse answer than
 * a refusal that says so.
 */
const UPLOADABLE_LANGUAGES = new Set(["eng", "tur"]);

/**
 * The correction a client may ask for, read out of a request body.
 *
 * A client names *tracks*, by the stream indexes the catalogue gave them, and
 * never a path — the same rule the upload route follows, for the same reason:
 * the destination of every byte this subsystem writes is derived on the server
 * from the media file, and letting a request body name one would undo that.
 */
function parseSyncBody(body: Record<string, unknown>) {
  const reference = body.reference as Record<string, unknown> | undefined;
  const index = (value: unknown) =>
    Number.isSafeInteger(value) && (value as number) >= 0
      ? (value as number)
      : null;
  const targetStreamIndex = index(body.targetStreamIndex);
  const referenceStreamIndex = index(reference?.streamIndex);
  if (
    targetStreamIndex === null ||
    !reference ||
    (reference.kind !== "subtitle" && reference.kind !== "audio") ||
    referenceStreamIndex === null
  )
    throw validationError(
      "A subtitle sync names a subtitle track and what to time it against.",
    );
  /*
   * A hand-given correction is passed through as the operator wrote it and is
   * only checked for being a correction at all. The bounds are wide on purpose:
   * this is the escape hatch for the case the aligner cannot serve, and
   * narrowing it to what seems reasonable is how an escape hatch stops working.
   */
  if (
    (body.offsetSeconds !== undefined &&
      (typeof body.offsetSeconds !== "number" ||
        !Number.isFinite(body.offsetSeconds) ||
        Math.abs(body.offsetSeconds) > 24 * 3600)) ||
    (body.rate !== undefined &&
      (typeof body.rate !== "number" ||
        !Number.isFinite(body.rate) ||
        body.rate <= 0.5 ||
        body.rate >= 2)) ||
    (body.dryRun !== undefined && typeof body.dryRun !== "boolean")
  )
    throw validationError("That correction is not a plausible one.");
  return {
    targetStreamIndex,
    reference: { kind: reference.kind, streamIndex: referenceStreamIndex },
    ...(body.offsetSeconds === undefined
      ? {}
      : { offsetSeconds: body.offsetSeconds }),
    ...(body.rate === undefined ? {} : { rate: body.rate }),
    dryRun: body.dryRun === true,
  };
}

export function createSubtitleRoutes(
  repository: SubtitleRepository,
  queue: JobQueue,
  sessions?: SubtitleSessionRoutesOptions,
  uploader?: SubtitleUploader,
  sync?: SubtitleSyncService,
): RouteDefinition[] {
  /**
   * The one media file a sync request can mean.
   *
   * A film is one video and one subtitle belongs to one video, so a whole show
   * is refused here rather than resolved to whichever episode sorted first —
   * the same refusal the upload route makes, and for the same reason: a
   * translation timed to one episode is wrong against every other.
   */
  const soleMediaFile = async (itemId: string): Promise<string> => {
    const files = await repository.titleMediaFiles(itemId);
    if (files.length === 0)
      throw new OwnApiError(
        "NOT_FOUND",
        "This title has no playable file.",
        404,
      );
    if (files.length > 1)
      throw validationError(
        "This title has more than one file. Sync the subtitle from the episode it belongs to.",
      );
    return files[0] as string;
  };

  /**
   * The task that applies a proposal an operator has looked at.
   *
   * Built from the preview task's own result, read here on the server: the
   * client names the preview and nothing else, so what is applied is exactly
   * what the server proposed, for exactly the bytes it analysed, and a body
   * cannot slip in a placement of its own.
   */
  const reviewedPayload = async (
    mediaFileId: string,
    body: Record<string, unknown>,
  ) => {
    if (
      body.offsetSeconds !== undefined ||
      body.rate !== undefined ||
      body.dryRun !== undefined
    )
      throw validationError(
        "Apply a reviewed proposal, or a correction typed by hand, not both.",
      );
    if (
      body.unmatched !== undefined &&
      body.unmatched !== "keep" &&
      body.unmatched !== "exclude"
    )
      throw validationError("Unmatched lines are either kept or excluded.");
    const previewTaskId = requireUuid(
      typeof body.previewTaskId === "string" ? body.previewTaskId : "",
      "previewTaskId",
    );
    const preview = await queue.get(previewTaskId);
    const result = preview?.result as
      | {
          outcome?: unknown;
          subtitleSha256?: unknown;
          alignment?: { verdict?: unknown; cues?: unknown } | null;
        }
      | null
      | undefined;
    if (
      !preview ||
      preview.jobType !== SUBTITLE_JOB_TYPES.sync ||
      preview.payload.mediaFileId !== mediaFileId ||
      preview.status !== "succeeded" ||
      result?.outcome !== "analysed" ||
      typeof result.subtitleSha256 !== "string" ||
      !Array.isArray(result.alignment?.cues)
    )
      throw new OwnApiError(
        "TASK_NOT_FOUND",
        "That proposal could not be found, or it has nothing to apply.",
        404,
      );
    return {
      mediaFileId,
      targetStreamIndex: preview.payload.targetStreamIndex as number,
      reference: preview.payload.reference as Record<string, unknown>,
      reviewed: {
        subtitleSha256: result.subtitleSha256,
        previewTaskId,
        unmatched: body.unmatched === "exclude" ? "exclude" : "keep",
        verdict: result.alignment?.verdict,
        placements: (result.alignment?.cues as Record<string, unknown>[]).map(
          (cue) => ({
            index: cue.index,
            disposition: cue.disposition,
            startSeconds: cue.startSeconds,
            endSeconds: cue.endSeconds,
          }),
        ),
      },
    };
  };

  const streamIndexOf = (value: string | null | undefined | unknown) => {
    const index = typeof value === "string" ? Number(value) : value;
    if (!Number.isSafeInteger(index) || (index as number) < 0)
      throw validationError("A subtitle track is required.");
    return index as number;
  };

  const revisionRoutes: RouteDefinition[] = sync
    ? [
        {
          /**
           * Every version of one sidecar, newest first: what it was before
           * this system touched it, every correction, every restore. Without
           * the bytes, and without the library path.
           */
          method: "GET",
          path: "/subtitles/items/:itemId/revisions",
          access: "admin",
          handle: async (context) => {
            context.requirePrincipal();
            const itemId = requireUuid(context.params.itemId, "itemId");
            const mediaFileId = await soleMediaFile(itemId);
            const listing = await sync.revisions(
              mediaFileId,
              streamIndexOf(context.url.searchParams.get("streamIndex")),
            );
            if (!listing)
              throw new OwnApiError(
                "NOT_FOUND",
                "That subtitle cannot be corrected, so it has no versions.",
                404,
              );
            sendData(context.response, context.requestId, {
              fileName: listing.fileName,
              revisions: listing.revisions.map(
                ({ relativePath: _path, mediaFileId: _file, ...revision }) =>
                  revision,
              ),
            });
          },
        },
        {
          /** What changed between a version and the one before it, or another. */
          method: "GET",
          path: "/subtitles/items/:itemId/revisions/:revisionId/compare",
          access: "admin",
          handle: async (context) => {
            context.requirePrincipal();
            const itemId = requireUuid(context.params.itemId, "itemId");
            const revisionId = requireUuid(
              context.params.revisionId,
              "revisionId",
            );
            const against = context.url.searchParams.get("against");
            const mediaFileId = await soleMediaFile(itemId);
            const comparison = await sync.compare({
              mediaFileId,
              targetStreamIndex: streamIndexOf(
                context.url.searchParams.get("streamIndex"),
              ),
              revisionId,
              ...(against
                ? { againstRevisionId: requireUuid(against, "against") }
                : {}),
            });
            if (!comparison)
              throw new OwnApiError(
                "NOT_FOUND",
                "Those versions could not be compared.",
                404,
              );
            sendData(context.response, context.requestId, comparison);
          },
        },
        {
          /**
           * Puts an earlier version back. Queued like a correction and under
           * the same key, so it cannot race one; the restore is itself a new
           * version, and the one it replaces stays in the history.
           */
          method: "POST",
          path: "/subtitles/items/:itemId/revisions/:revisionId/restore",
          access: "admin",
          handle: async (context) => {
            context.requirePrincipal();
            const itemId = requireUuid(context.params.itemId, "itemId");
            const revisionId = requireUuid(
              context.params.revisionId,
              "revisionId",
            );
            const body = asObjectBody(await context.readJson(), [
              "targetStreamIndex",
            ]);
            const targetStreamIndex = streamIndexOf(body.targetStreamIndex);
            const mediaFileId = await soleMediaFile(itemId);
            const jobId = await queue.enqueue({
              jobType: SUBTITLE_JOB_TYPES.sync,
              payload: {
                mediaFileId,
                targetStreamIndex,
                restoreRevisionId: revisionId,
              },
              dedupeKey: `subtitle-sync:${mediaFileId}:${targetStreamIndex}`,
            });
            sendAccepted(context.response, context.requestId, jobId);
          },
        },
      ]
    : [];

  const syncRoutes: RouteDefinition[] = sync
    ? [
        {
          /** Which subtitle can be corrected, and what it can be timed against. */
          method: "GET",
          path: "/subtitles/items/:itemId/sync",
          access: "admin",
          handle: async (context) => {
            context.requirePrincipal();
            const itemId = requireUuid(context.params.itemId, "itemId");
            sendData(
              context.response,
              context.requestId,
              await sync.tracks(await soleMediaFile(itemId)),
            );
          },
        },
        {
          /**
           * Move one subtitle onto the film's timeline.
           *
           * Queued rather than answered, because the work is bounded by a disk
           * rather than by arithmetic: reading the audio out of a twenty-gigabyte
           * remux took most of six minutes on the deployed host, which no HTTP
           * request between here and a browser survives. The proposal and what
           * was done with it come back as the task's own result.
           */
          method: "POST",
          path: "/subtitles/items/:itemId/sync",
          access: "admin",
          handle: async (context) => {
            context.requirePrincipal();
            const itemId = requireUuid(context.params.itemId, "itemId");
            const body = asObjectBody(await context.readJson(), [
              "targetStreamIndex",
              "reference",
              "offsetSeconds",
              "rate",
              "dryRun",
              "previewTaskId",
              "unmatched",
            ]);
            const mediaFileId = await soleMediaFile(itemId);
            const payload =
              body.previewTaskId === undefined
                ? { mediaFileId, ...parseSyncBody(body) }
                : await reviewedPayload(mediaFileId, body);
            const jobId = await queue.enqueue({
              jobType: SUBTITLE_JOB_TYPES.sync,
              payload,
              // One correction of one track at a time. A second press of the
              // button joins the first rather than racing it for the lock.
              dedupeKey: `subtitle-sync:${mediaFileId}:${payload.targetStreamIndex}`,
            });
            sendAccepted(context.response, context.requestId, jobId);
          },
        },
        {
          /**
           * What became of one correction.
           *
           * The task list says a task finished; it deliberately forwards
           * nothing of a result but counters, so it cannot say whether the file
           * was rewritten, by how much, or why it was refused. The operator who
           * pressed the button needs exactly that, so this answers it — for a
           * sync task of this title and nothing else, and without the
           * library-relative path the result carries.
           */
          method: "GET",
          path: "/subtitles/items/:itemId/sync/:taskId",
          access: "admin",
          handle: async (context) => {
            context.requirePrincipal();
            const itemId = requireUuid(context.params.itemId, "itemId");
            const taskId = requireUuid(context.params.taskId, "taskId");
            const mediaFileId = await soleMediaFile(itemId);
            const job = await queue.get(taskId);
            if (
              !job ||
              job.jobType !== SUBTITLE_JOB_TYPES.sync ||
              job.payload.mediaFileId !== mediaFileId
            )
              throw new OwnApiError(
                "TASK_NOT_FOUND",
                "That subtitle sync could not be found.",
                404,
              );
            const { relativePath: _path, ...result } = job.result ?? {};
            sendData(context.response, context.requestId, {
              taskId: job.id,
              status: job.status,
              message: job.status === "running" ? job.progressMessage : null,
              result: job.status === "succeeded" && job.result ? result : null,
            });
          },
        },
      ]
    : [];
  const uploadRoutes: RouteDefinition[] = uploader
    ? [
        {
          /**
           * A subtitle somebody already has, filed and named by this system.
           *
           * The bytes arrive as the request body and the policy in the query,
           * which is the same shape the custom-artwork upload uses. A caller
           * never names a path: the destination is derived from the media file
           * the item resolves to, exactly as it is for a downloaded one.
           */
          method: "POST",
          path: "/subtitles/items/:itemId/upload",
          access: "admin",
          handle: async (context) => {
            context.requirePrincipal();
            const itemId = requireUuid(context.params.itemId, "itemId");
            const language = normalizeLanguage(
              context.url.searchParams.get("language") ?? "",
            );
            if (!UPLOADABLE_LANGUAGES.has(language))
              throw validationError(
                "Subtitles can be uploaded as Turkish or English.",
              );
            const flag = (name: string) =>
              context.url.searchParams.get(name) === "true";
            const bytes = await readBinaryBody(
              context.request,
              MAX_SUBTITLE_BYTES,
            );
            const result = await uploader.upload({
              itemId,
              language,
              forced: flag("forced"),
              hearingImpaired: flag("hearingImpaired"),
              replace: flag("replace"),
              bytes,
            });
            if (result.outcome === "error")
              throw new OwnApiError(
                "SUBTITLE_UPLOAD_REFUSED",
                result.reason,
                409,
              );
            sendData(context.response, context.requestId, result);
          },
        },
      ]
    : [];
  const sessionRoutes: RouteDefinition[] = sessions
    ? [
        {
          /** Which providers are asked, and whether each can be right now. Never material. */
          method: "GET",
          path: "/subtitles/providers",
          access: "admin",
          handle: async (context) => {
            context.requirePrincipal();
            sendData(context.response, context.requestId, {
              providers: await Promise.all(
                sessions.providers.map(async (provider) => ({
                  id: provider.id,
                  label: provider.label,
                  languages: provider.languages,
                  requiresSession: provider.requiresSession,
                  session: provider.requiresSession
                    ? await sessions.vault.status(provider.id)
                    : null,
                })),
              ),
            });
          },
        },
        {
          /**
           * A person hands over the session their browser earned. Stored sealed,
           * never echoed; every attempt that was waiting for it is resumed.
           */
          method: "PUT",
          path: "/subtitles/providers/:providerId/session",
          access: "admin",
          handle: async (context) => {
            context.requirePrincipal();
            const provider = sessions.providers.find(
              (entry) =>
                entry.id === context.params.providerId && entry.requiresSession,
            );
            if (!provider)
              throw new OwnApiError("NOT_FOUND", "No such provider.", 404);
            const body = asObjectBody(await context.readJson(), [
              "cookie",
              "userAgent",
            ]);
            let material;
            try {
              material = parseSessionMaterial({
                cookie: body.cookie,
                userAgent: body.userAgent,
              });
            } catch (error) {
              throw validationError(
                error instanceof Error ? error.message : "Invalid session.",
              );
            }
            await sessions.vault.store(provider.id, material);
            const waiting = await repository.attemptsAwaiting(provider.id);
            for (const attemptId of waiting)
              await queue.enqueue({
                jobType: SUBTITLE_JOB_TYPES.resume,
                payload: { attemptId },
                dedupeKey: `subtitle:${attemptId}`,
              });
            sendData(context.response, context.requestId, {
              session: await sessions.vault.status(provider.id),
              resumed: waiting.length,
            });
          },
        },
        {
          method: "DELETE",
          path: "/subtitles/providers/:providerId/session",
          access: "admin",
          handle: async (context) => {
            context.requirePrincipal();
            const provider = sessions.providers.find(
              (entry) =>
                entry.id === context.params.providerId && entry.requiresSession,
            );
            if (!provider)
              throw new OwnApiError("NOT_FOUND", "No such provider.", 404);
            await sessions.vault.clear(provider.id);
            sendData(context.response, context.requestId, {
              session: await sessions.vault.status(provider.id),
            });
          },
        },
      ]
    : [];
  const openSubtitles = sessions?.openSubtitles;
  /** Every attempt parked waiting for OpenSubtitles is tried again. */
  const resumeOpenSubtitles = async () => {
    const waiting = await repository.attemptsAwaiting(OPENSUBTITLES_ID);
    for (const attemptId of waiting)
      await queue.enqueue({
        jobType: SUBTITLE_JOB_TYPES.resume,
        payload: { attemptId },
        dedupeKey: `subtitle:${attemptId}`,
      });
    return waiting.length;
  };
  const slotOf = (raw: string | undefined) => {
    const slot = Number(raw);
    if (!Number.isInteger(slot) || !isOpenSubtitlesSlot(slot))
      throw new OwnApiError("NOT_FOUND", "No such account slot.", 404);
    return slot;
  };
  /*
   * The API key and the accounts are write-only, like a TürkçeAltyazı
   * session: they are sealed on the way in, and what comes back is which
   * account is signed in and whether it can download, never a password.
   */
  const openSubtitlesRoutes: RouteDefinition[] = openSubtitles
    ? [
        {
          method: "GET",
          path: "/subtitles/providers/opensubtitles/accounts",
          access: "admin",
          handle: async (context) => {
            context.requirePrincipal();
            sendData(
              context.response,
              context.requestId,
              await openSubtitles.accounts.status(),
            );
          },
        },
        {
          method: "PUT",
          path: "/subtitles/providers/opensubtitles/api-key",
          access: "admin",
          handle: async (context) => {
            context.requirePrincipal();
            const body = asObjectBody(await context.readJson(), ["apiKey"]);
            let apiKey;
            try {
              apiKey = parseApiKey(body.apiKey);
            } catch (error) {
              throw validationError(
                error instanceof Error ? error.message : "Invalid API key.",
              );
            }
            await openSubtitles.accounts.storeApiKey(apiKey);
            const resumed = await resumeOpenSubtitles();
            sendData(context.response, context.requestId, {
              ...(await openSubtitles.accounts.status()),
              resumed,
            });
          },
        },
        {
          method: "DELETE",
          path: "/subtitles/providers/opensubtitles/api-key",
          access: "admin",
          handle: async (context) => {
            context.requirePrincipal();
            await openSubtitles.accounts.clearApiKey();
            sendData(
              context.response,
              context.requestId,
              await openSubtitles.accounts.status(),
            );
          },
        },
        {
          /**
           * Signs the account in first and saves it only if OpenSubtitles
           * accepted it, so a mistyped password is said here rather than
           * discovered by a download that fails tonight.
           */
          method: "PUT",
          path: "/subtitles/providers/opensubtitles/accounts/:slot",
          access: "admin",
          handle: async (context) => {
            context.requirePrincipal();
            const slot = slotOf(context.params.slot);
            const body = asObjectBody(await context.readJson(), [
              "username",
              "password",
            ]);
            let account;
            try {
              account = parseAccountInput({
                username: body.username,
                password: body.password,
              });
            } catch (error) {
              throw validationError(
                error instanceof Error ? error.message : "Invalid account.",
              );
            }
            const apiKey = await openSubtitles.accounts.credentials.apiKey();
            if (!apiKey)
              throw new OwnApiError(
                "OPENSUBTITLES_KEY_MISSING",
                "Add the OpenSubtitles API key first.",
                409,
              );
            const login = await (openSubtitles.login ?? openSubtitlesLogin)({
              apiKey,
              username: account.username,
              password: account.password,
            });
            if (login.outcome === "refused" || login.outcome === "key-refused")
              throw new OwnApiError(
                login.outcome === "refused"
                  ? "OPENSUBTITLES_SIGN_IN_REFUSED"
                  : "OPENSUBTITLES_KEY_REFUSED",
                login.reason,
                400,
              );
            if (login.outcome !== "ok")
              throw new OwnApiError(
                "OPENSUBTITLES_UNAVAILABLE",
                login.outcome === "error"
                  ? login.reason
                  : "OpenSubtitles asked to wait; try again in a minute.",
                502,
              );
            await openSubtitles.accounts.storeAccount(slot, account);
            const resumed = await resumeOpenSubtitles();
            sendData(context.response, context.requestId, {
              ...(await openSubtitles.accounts.status()),
              allowedDownloads: login.allowedDownloads,
              resumed,
            });
          },
        },
        {
          method: "DELETE",
          path: "/subtitles/providers/opensubtitles/accounts/:slot",
          access: "admin",
          handle: async (context) => {
            context.requirePrincipal();
            await openSubtitles.accounts.clearAccount(
              slotOf(context.params.slot),
            );
            sendData(
              context.response,
              context.requestId,
              await openSubtitles.accounts.status(),
            );
          },
        },
      ]
    : [];
  return [
    ...sessionRoutes,
    ...openSubtitlesRoutes,
    ...uploadRoutes,
    ...syncRoutes,
    ...revisionRoutes,
    {
      /**
       * Subtitles for a whole title: the film, or every episode of a show or
       * season that has a file. A file already being searched for is not asked
       * twice.
       */
      method: "POST",
      path: "/subtitles/items/:itemId",
      access: "admin",
      handle: async (context) => {
        context.requirePrincipal();
        const itemId = requireUuid(context.params.itemId, "itemId");
        const body = asObjectBody(await context.readJson(), [
          "language",
          "forced",
          "hearingImpaired",
          "replace",
        ]);
        const want = parsePolicy(body);
        const files = await repository.titleMediaFiles(itemId);
        let queued = 0;
        for (const mediaFileId of files) {
          const saved = await repository.ensureWant(mediaFileId, want);
          if (await repository.openAttempt(saved.id)) continue;
          const attempt = await repository.beginAttempt(saved.id);
          await queue.enqueue({
            jobType: SUBTITLE_JOB_TYPES.run,
            payload: { attemptId: attempt.id, replace: body.replace === true },
            dedupeKey: `subtitle:${attempt.id}`,
          });
          queued += 1;
        }
        sendData(context.response, context.requestId, {
          files: files.length,
          queued,
        });
      },
    },
    {
      method: "POST",
      path: "/subtitles",
      access: "admin",
      handle: async (context) => {
        context.requirePrincipal();
        const body = asObjectBody(await context.readJson(), [
          "mediaFileId",
          "language",
          "forced",
          "hearingImpaired",
          "replace",
        ]);
        const mediaFileId = requireUuid(
          requireBodyString(body, "mediaFileId", { maxLength: 64 }),
          "mediaFileId",
        );
        if (
          (body.forced !== undefined && typeof body.forced !== "boolean") ||
          (body.replace !== undefined && typeof body.replace !== "boolean") ||
          (body.hearingImpaired !== undefined &&
            !["prefer", "avoid", "indifferent"].includes(
              String(body.hearingImpaired),
            ))
        )
          throw validationError("Invalid subtitle policy.");
        const want = normalizeWant({
          language: requireBodyString(body, "language", { maxLength: 16 }),
          forced: body.forced === true,
          hearingImpaired: body.hearingImpaired as
            | "prefer"
            | "avoid"
            | "indifferent"
            | undefined,
        });
        if (want.language === "und")
          throw validationError("A known subtitle language is required.");
        const saved = await repository.ensureWant(mediaFileId, want);
        const attempt = await repository.beginAttempt(saved.id);
        const jobId = await queue.enqueue({
          jobType: SUBTITLE_JOB_TYPES.run,
          payload: { attemptId: attempt.id, replace: body.replace === true },
          dedupeKey: `subtitle:${attempt.id}`,
        });
        sendAccepted(context.response, context.requestId, jobId);
      },
    },
    {
      /**
       * What the subtitle system is doing, for an operator.
       *
       * Carries no provider session, no cookie and no candidate URL: the
       * provider abstraction holds those, and an attempt is identified to a
       * client by its own id and nothing else.
       */
      method: "GET",
      path: "/subtitles",
      access: "admin",
      handle: async (context) => {
        context.requirePrincipal();
        const attempts = await repository.recentAttempts();
        sendData(context.response, context.requestId, {
          attempts: attempts.map((attempt) => ({
            attemptId: attempt.id,
            mediaFileId: attempt.mediaFileId,
            language: attempt.language,
            forced: attempt.forced,
            hearingImpaired: attempt.hearingImpaired,
            state: attempt.state,
            attempt: attempt.attempt,
            providerId: attempt.providerId,
            score: attempt.score,
            failureClass: attempt.failureClass,
            awaitingProviderId: attempt.awaitingProviderId,
            title: attempt.title,
            seasonNumber: attempt.seasonNumber,
            episodeNumber: attempt.episodeNumber,
          })),
        });
      },
    },
    {
      method: "GET",
      path: "/subtitles/:attemptId",
      access: "admin",
      handle: async (context) => {
        context.requirePrincipal();
        const record = await repository.getAttempt(
          requireUuid(context.params.attemptId, "attemptId"),
        );
        if (!record)
          throw validationError("The subtitle attempt does not exist.");
        sendData(context.response, context.requestId, {
          attemptId: record.id,
          state: record.state,
          awaitingProviderId: record.awaitingProviderId,
          failureClass: record.failureClass,
        });
      },
    },
    {
      method: "POST",
      path: "/subtitles/:attemptId/resume",
      access: "admin",
      handle: async (context) => {
        context.requirePrincipal();
        const id = requireUuid(context.params.attemptId, "attemptId");
        const record = await repository.getAttempt(id);
        if (!record || record.state !== "needs-authentication")
          throw validationError(
            "This subtitle attempt is not waiting for authentication.",
          );
        const jobId = await queue.enqueue({
          jobType: SUBTITLE_JOB_TYPES.resume,
          payload: { attemptId: id },
          dedupeKey: `subtitle:${id}`,
        });
        sendAccepted(context.response, context.requestId, jobId);
      },
    },
  ];
}
