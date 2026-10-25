import path from "node:path";
import { readFile, stat } from "node:fs/promises";
import { OwnApiError } from "../ownApiHandler";
import { serveFile } from "../api/fileDelivery";
import { sendData, sendNoContent } from "../api/envelope";
import type { RouteDefinition } from "../api/router";
import {
  asObjectBody,
  optionalBodyInteger,
  optionalBodyString,
  requireUuid,
  validationError,
} from "../api/validation";
import { isPathInsideRoot } from "../../pathSecurity";
import { decidePlaybackPlan } from "../../../lib/playback-planner/playbackDecision";
import {
  PlaybackCapacityError,
  PlaybackSessionStartupError,
  type PlaybackSessionManager,
} from "../../../lib/playback-planner/playbackSessionManager";
import { PlaybackConversionUnavailableError } from "../../../lib/playback-planner/ffmpegCommandBuilder";
import type {
  ClientCapabilities,
  PlaybackPlan,
} from "../../../lib/playback-planner/types";
import type { CatalogueRepository } from "../catalogue/catalogueRepository";
import { buildAnalysisFromInventory } from "../probe/analysisFromInventory";
import type { PlaybackSessionStore } from "./playbackSessionStore";
import type {
  PackagedSubtitle,
  RenditionService,
} from "../../renditionService";
import type { MediaQualityManifest } from "../../../renditions/contracts";
import {
  extractSubtitleAsWebVtt,
  packagedSubtitleFor,
  resolveTextSubtitleInput,
  withPackagedSubtitles,
} from "./subtitleDelivery";
import { captureFrameAsPng, isHdrTransfer } from "./frameCapture";
import {
  writeLocalPackagePlaylist,
  type LocalPlaylistCopy,
} from "../../../renditions/adaptive/localPlaylist";
import {
  applyAdaptiveMasterSelection,
  parseAdaptiveMasterSelection,
} from "../../../renditions/adaptive/masterSelection";

export const PLAYBACK_SESSION_ROUTE_BASE = "/ownAPI/v1/playback/sessions";

/**
 * Where pre-encoded renditions are served from. Inside the API namespace, so a
 * rendition is behind the same session cookie as everything else rather than on
 * a second, separately-authorized surface.
 */
export const PLAYBACK_RENDITION_ROUTE_BASE = "/ownAPI/v1/playback/renditions";

export interface PlaybackRoutesOptions {
  catalogue: CatalogueRepository;
  sessions: PlaybackSessionStore;
  sessionManager: PlaybackSessionManager;
  mediaRoot: string;
  ffmpegPath?: string;
  /**
   * Absent when no rendition root is configured, in which case playback still
   * works — it just has nothing but the original and live transcodes to offer.
   */
  renditions?: RenditionService;
}

/** Native plan modes; the browser never sees an upstream transcode reason again. */
type NativeMode = "DIRECT_PLAY" | "REMUX" | "DIRECT_STREAM" | "TRANSCODE";

export function toNativeMode(plan: PlaybackPlan): NativeMode {
  if (!plan.requiresFfmpeg) return "DIRECT_PLAY";
  if (plan.video.action === "transcode" || plan.subtitles.action === "burn") {
    return "TRANSCODE";
  }
  if (plan.audio.action === "transcode") return "DIRECT_STREAM";
  return "REMUX";
}

/**
 * Reason codes are stable machine-readable identifiers; the human strings that
 * accompany them are for diagnostics only and must never be parsed by a client.
 */
export function toReasonCodes(plan: PlaybackPlan): string[] {
  const codes: string[] = [];
  if (plan.container.action !== "direct") codes.push("CONTAINER_NOT_SUPPORTED");
  if (plan.video.action === "transcode")
    codes.push("VIDEO_CODEC_NOT_SUPPORTED");
  if (plan.audio.action === "transcode")
    codes.push("AUDIO_CODEC_NOT_SUPPORTED");
  if (plan.subtitles.action === "burn") codes.push("SUBTITLE_BURN_IN_REQUIRED");
  return codes;
}

/** Selects an already-validated adaptive package before live ffmpeg starts. */
export function buildAdaptiveRenditionPlan(
  planned: PlaybackPlan,
  qualityManifest: MediaQualityManifest | undefined,
  options: {
    selectedAudioStreamIndex?: number;
    maxHeight?: number;
    /** Exact rendition lock, as opposed to the `maxHeight` ceiling. */
    qualityHeight?: number;
  } = {},
): PlaybackPlan | null {
  const adaptive = qualityManifest?.adaptive;
  if (
    !adaptive ||
    planned.subtitles.action === "burn" ||
    (options.selectedAudioStreamIndex !== undefined &&
      !adaptive.audioTracks.some(
        (track) => track.sourceStreamIndex === options.selectedAudioStreamIndex,
      ))
  ) {
    return null;
  }

  const url = new URL(adaptive.playbackUrl, "http://seyirlik.local");
  if (options.maxHeight !== undefined) {
    url.searchParams.set("maxHeight", String(options.maxHeight));
  }
  if (options.qualityHeight !== undefined) {
    url.searchParams.set("height", String(options.qualityHeight));
  }
  // Carried in the URL rather than only validated, because Safari's native HLS
  // engine picks its audio rendition from the manifest and from nothing else.
  if (options.selectedAudioStreamIndex !== undefined) {
    url.searchParams.set(
      "audioStreamIndex",
      String(options.selectedAudioStreamIndex),
    );
  }
  const deliveryUrl = `${url.pathname}${url.search}`;
  const selectedManifest: MediaQualityManifest = {
    ...qualityManifest,
    adaptive: { ...adaptive, playbackUrl: deliveryUrl },
  };

  return {
    ...planned,
    mode: "direct-play",
    requiresFfmpeg: false,
    preservesOriginalVideoQuality: false,
    expectedStartup: "instant",
    container: {
      input: planned.container.input,
      output: "hls-fmp4",
      action: "direct",
    },
    video: {
      inputCodec: adaptive.qualities[0]?.videoCodec ?? planned.video.inputCodec,
      action: "copy",
    },
    audio: { inputCodec: "aac", action: "copy" },
    subtitles: {
      action: planned.subtitles.action === "external" ? "external" : "none",
    },
    reasons: [
      {
        code: "direct_play_supported",
        severity: "info",
        message:
          "A validated pre-generated aligned CMAF/HLS package is available.",
      },
    ],
    delivery: { type: "hls", url: deliveryUrl },
    qualityManifest: selectedManifest,
  };
}

function parseCapabilities(value: unknown): ClientCapabilities {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw validationError("clientCapabilities is invalid.");
  }
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.supportsHlsNative !== "boolean" ||
    typeof candidate.supportsMediaSource !== "boolean" ||
    !Array.isArray(candidate.directFileContainers) ||
    !Array.isArray(candidate.mseContainers) ||
    typeof candidate.video !== "object" ||
    typeof candidate.audio !== "object" ||
    typeof candidate.subtitles !== "object"
  ) {
    throw validationError("clientCapabilities is invalid.");
  }
  return value as ClientCapabilities;
}

export function createPlaybackRoutes({
  catalogue,
  sessions,
  sessionManager,
  mediaRoot,
  ffmpegPath,
  renditions,
}: PlaybackRoutesOptions): RouteDefinition[] {
  const resolvedMediaRoot = path.resolve(mediaRoot);

  /**
   * Resolves an item to a playable file for one specific user.
   *
   * Authorization happens here rather than in a shared resolver, so possession
   * of an item or file id can never be traded for bytes from a library the
   * caller cannot see.
   */
  /** The subtitles a file's package carries; none without a ready package. */
  async function packagedSubtitlesOf(file: {
    id: string;
    relativePath: string;
    sizeBytes: string | number;
    mtimeMs: string | number;
  }): Promise<PackagedSubtitle[]> {
    if (!renditions?.findPackagedSubtitles) return [];
    return renditions
      .findPackagedSubtitles({
        mediaId: file.id,
        filePath: path.resolve(
          resolvedMediaRoot,
          ...file.relativePath.split("/"),
        ),
        size: Number(file.sizeBytes),
        mtimeMs: Number(file.mtimeMs),
      })
      .catch(() => []);
  }

  async function resolvePlayable(
    userId: string,
    itemId: string,
    mediaFileId?: string,
  ) {
    if (!(await catalogue.canUserAccessItem(userId, itemId))) {
      throw new OwnApiError(
        "ITEM_NOT_FOUND",
        "The requested item could not be found.",
        404,
      );
    }

    const file = mediaFileId
      ? await catalogue.getFileById(mediaFileId)
      : await catalogue.getPrimaryFile(itemId);

    if (!file || file.itemId !== itemId || file.missingSince !== null) {
      throw new OwnApiError(
        "MEDIA_NOT_FOUND",
        "The requested media could not be found.",
        404,
      );
    }
    const absolutePath = path.resolve(
      resolvedMediaRoot,
      ...file.relativePath.split("/"),
    );
    if (!isPathInsideRoot(resolvedMediaRoot, absolutePath)) {
      throw new OwnApiError(
        "MEDIA_NOT_FOUND",
        "The requested media could not be found.",
        404,
      );
    }

    /*
     * A probe that never succeeded is usually a file that is not ready yet.
     * For one class of title it is a file that will never be probed again: once
     * packaging has replaced the source with a complete adaptive package the
     * source bytes are removed, and ffprobe has nothing left to read. Those
     * titles are entirely playable — the package is what playback serves — so
     * refusing them here made every fully processed film permanently
     * unplayable.
     *
     * The package is consulted rather than trusted from a flag: it is the same
     * artefact the session will stream, so if it is not there the refusal below
     * is the honest answer.
     */
    const packaged =
      (file.probeState === "failed" || file.probeState === "packaged") &&
      renditions
        ? await renditions.describePackagedSource({
            mediaId: file.id,
            filePath: absolutePath,
            size: Number(file.sizeBytes),
            mtimeMs: Number(file.mtimeMs),
          })
        : null;

    if (file.probeState !== "probed" && !packaged) {
      throw file.probeState === "failed"
        ? // Analysis ran and the file itself was rejected. Saying it "has not
          // finished" invites a client to keep asking for something that will
          // never arrive.
          new OwnApiError(
            "MEDIA_UNPLAYABLE",
            "This file could not be read and cannot be played.",
            422,
          )
        : new OwnApiError(
            "MEDIA_NOT_READY",
            "The media has not finished analysis yet.",
            409,
          );
    }

    const [catalogued, chapters, packagedSubtitles] = await Promise.all([
      catalogue.listStreams(file.id),
      catalogue.listChapters(itemId),
      packagedSubtitlesOf(file),
    ]);
    const streams = withPackagedSubtitles(catalogued, packagedSubtitles);

    const analysis = buildAnalysisFromInventory({
      file,
      streams,
      filePath: absolutePath,
      chapters,
    });

    return {
      file,
      absolutePath,
      // The catalogue row of a packaged title has no duration and no streams:
      // it was written from a registry record of a file that is gone, and the
      // planner refuses media with no video stream. The package recorded the
      // source's own description at build time, so use that.
      analysis: packaged
        ? {
            ...analysis,
            durationSeconds: packaged.durationSeconds,
            videoStreams: [packaged.video],
            audioStreams: packaged.audio,
            subtitleStreams: packaged.subtitles,
          }
        : analysis,
    };
  }

  function planRequestBody(raw: unknown) {
    const body = asObjectBody(raw, [
      "itemId",
      "mediaFileId",
      "clientCapabilities",
      "audioStreamIndex",
      "subtitleStreamIndex",
      "maxHeight",
      "qualityHeight",
      "maxBitrateBps",
      "startTimeMs",
    ]);

    return {
      itemId: requireUuid(optionalBodyString(body, "itemId"), "itemId"),
      mediaFileId: body.mediaFileId
        ? requireUuid(optionalBodyString(body, "mediaFileId"), "mediaFileId")
        : undefined,
      clientCapabilities: parseCapabilities(body.clientCapabilities),
      audioStreamIndex: optionalBodyInteger(body, "audioStreamIndex", {
        min: 0,
        max: 100_000,
      }),
      subtitleStreamIndex: optionalBodyInteger(body, "subtitleStreamIndex", {
        min: 0,
        max: 100_000,
      }),
      maxHeight: optionalBodyInteger(body, "maxHeight", {
        min: 144,
        max: 4_320,
      }),
      // An exact adaptive rendition lock, distinct from the `maxHeight`
      // ceiling: a client asking for 720p means 720p, not "720p or less".
      qualityHeight: optionalBodyInteger(body, "qualityHeight", {
        min: 144,
        max: 4_320,
      }),
      maxBitrateBps: optionalBodyInteger(body, "maxBitrateBps", {
        min: 100_000,
        max: 400_000_000,
      }),
      startTimeMs: optionalBodyInteger(body, "startTimeMs", {
        min: 0,
        max: 7 * 24 * 60 * 60 * 1000,
      }),
    };
  }

  function buildPlan(
    request: ReturnType<typeof planRequestBody>,
    analysis: ReturnType<typeof buildAnalysisFromInventory>,
  ): PlaybackPlan {
    return decidePlaybackPlan({
      media: analysis,
      client: request.clientCapabilities,
      ...(request.audioStreamIndex === undefined
        ? {}
        : { selectedAudioStreamIndex: request.audioStreamIndex }),
      ...(request.subtitleStreamIndex === undefined
        ? {}
        : { selectedSubtitleStreamIndex: request.subtitleStreamIndex }),
      ...(request.maxHeight === undefined && request.maxBitrateBps === undefined
        ? {}
        : {
            forceQualityLimit: {
              ...(request.maxHeight === undefined
                ? {}
                : { maxHeight: request.maxHeight }),
              ...(request.maxBitrateBps === undefined
                ? {}
                : { maxBitrateBps: request.maxBitrateBps }),
            },
          }),
    });
  }

  function planDto(plan: PlaybackPlan) {
    return {
      mode: toNativeMode(plan),
      reasonCodes: toReasonCodes(plan),
      reasons: plan.reasons,
      requiresTranscode: plan.requiresFfmpeg,
      preservesOriginalVideoQuality: plan.preservesOriginalVideoQuality,
      expectedStartup: plan.expectedStartup,
      container: plan.container,
      video: plan.video,
      audio: plan.audio,
      subtitles: plan.subtitles,
      selected: plan.selected,
    };
  }

  /**
   * The pre-encoded ladder for this file, if the offline processor produced one.
   *
   * The original is offered alongside the renditions only when it can be played
   * as-is: a plan that already needs ffmpeg has no direct file to hand over, and
   * listing one would send the browser to bytes it cannot decode.
   */
  async function buildQualityManifest(
    file: Awaited<ReturnType<typeof catalogue.getFileById>>,
    analysis: ReturnType<typeof buildAnalysisFromInventory>,
    plan: PlaybackPlan,
    capabilities: ClientCapabilities,
    deliveryUrl: string,
  ): Promise<MediaQualityManifest | undefined> {
    if (!renditions || !file) return undefined;

    const absolutePath = path.resolve(
      resolvedMediaRoot,
      ...file.relativePath.split("/"),
    );
    const video = analysis.videoStreams[0];

    try {
      return await renditions.createManifest(
        {
          mediaId: file.id,
          filePath: absolutePath,
          size: Number(file.sizeBytes),
          mtimeMs: Number(file.mtimeMs),
        },
        video && !plan.requiresFfmpeg
          ? {
              width: video.width,
              height: video.height,
              codec: video.codecName,
              container:
                analysis.container.extension ?? analysis.container.formatName,
              fileSize: Number(file.sizeBytes),
              playableUrl: deliveryUrl,
            }
          : undefined,
        {
          hevc: capabilities.video.hevc?.supported === true,
          h264: capabilities.video.h264?.supported !== false,
        },
      );
    } catch {
      // A missing or unreadable registry must not stop playback; it only means
      // there is nothing pre-encoded to offer.
      return undefined;
    }
  }

  async function requireOwnedSession(userId: string, sessionId: string) {
    const session = await sessions.get(sessionId);
    if (!session || session.userId !== userId || session.status !== "active") {
      throw new OwnApiError(
        "SESSION_NOT_FOUND",
        "The playback session could not be found.",
        404,
      );
    }
    return session;
  }

  /**
   * For reads that must outlive the idle reaper: subtitle tracks, saved
   * frames and the direct-play original. Adaptive renditions are served by media-file token and never touch
   * the session, so a few minutes into HLS playback — or into a pause — the
   * session is `ended` while the film is still on screen, and every later
   * track pick came back 404. Here the session only names the file; access is
   * re-checked on every request, as it is for renditions, and a failed session
   * stays refused.
   */
  async function requireViewableSession(userId: string, sessionId: string) {
    const session = await sessions.get(sessionId);
    if (
      !session ||
      session.userId !== userId ||
      session.status === "failed" ||
      !(await catalogue.canUserAccessItem(userId, session.itemId))
    ) {
      throw new OwnApiError(
        "SESSION_NOT_FOUND",
        "The playback session could not be found.",
        404,
      );
    }
    return session;
  }

  async function resolveAuthorizedAdaptiveAsset(
    context: Parameters<RouteDefinition["handle"]>[0],
    assetPath: string,
  ) {
    if (!renditions) return null;
    const principal = context.requirePrincipal();
    const mediaFileId = requireUuid(context.params.token, "token");
    const file = await catalogue.getFileById(mediaFileId);
    if (
      !file ||
      file.missingSince !== null ||
      !(await catalogue.canUserAccessItem(principal.userId, file.itemId))
    ) {
      throw new OwnApiError(
        "MEDIA_NOT_FOUND",
        "The requested media could not be found.",
        404,
      );
    }
    const version = context.params.version ?? "";
    const resolved = await renditions.resolveAdaptiveAsset(
      mediaFileId,
      version,
      assetPath,
    );
    if (resolved || !renditions.restoreAdaptiveAccess) return resolved;
    // See `restoreAdaptiveAccess`: a restart must not end the films in progress.
    await renditions.restoreAdaptiveAccess({
      mediaId: file.id,
      filePath: path.resolve(
        resolvedMediaRoot,
        ...file.relativePath.split("/"),
      ),
      size: Number(file.sizeBytes),
      mtimeMs: Number(file.mtimeMs),
    });
    return renditions.resolveAdaptiveAsset(mediaFileId, version, assetPath);
  }

  async function serveAdaptiveMaster(
    context: Parameters<RouteDefinition["handle"]>[0],
    assetPath: string,
  ): Promise<void> {
    const resolved = await resolveAuthorizedAdaptiveAsset(context, assetPath);
    if (!resolved) {
      throw new OwnApiError(
        "RENDITION_NOT_FOUND",
        "The requested adaptive package is unavailable.",
        404,
      );
    }

    // Safari's native HLS engine has no level or audio-track API, so a manual
    // quality or audio choice can only be expressed in the manifest it is
    // given. The package on disk is untouched; the selection is applied to the
    // bytes on the way out.
    const selection = parseAdaptiveMasterSelection(context.url.searchParams);
    const master = await readFile(resolved.absolutePath, "utf8");
    const body = Buffer.from(
      applyAdaptiveMasterSelection(master, selection),
      "utf8",
    );

    context.response.statusCode = 200;
    context.response.setHeader("Content-Type", "application/vnd.apple.mpegurl");
    context.response.setHeader("Content-Length", String(body.length));
    context.response.setHeader(
      "Cache-Control",
      "private, max-age=31536000, immutable",
    );
    context.response.setHeader("X-Content-Type-Options", "nosniff");
    context.response.end(context.method === "HEAD" ? undefined : body);
  }

  async function serveAdaptiveFile(
    context: Parameters<RouteDefinition["handle"]>[0],
    assetPath: string,
  ): Promise<void> {
    const resolved = await resolveAuthorizedAdaptiveAsset(context, assetPath);
    if (!resolved) {
      throw new OwnApiError(
        "RENDITION_NOT_FOUND",
        "The requested adaptive package asset is unavailable.",
        404,
      );
    }
    await serveFile(
      context.response,
      resolved.absolutePath,
      context.request.headers.range as string | undefined,
      context.method === "HEAD",
      "private, max-age=31536000, immutable",
    );
  }

  return [
    {
      method: "POST",
      path: "/playback/plan",
      access: "authenticated",
      handle: async (context) => {
        const principal = context.requirePrincipal();
        const request = planRequestBody(await context.readJson(32 * 1_024));
        const { analysis } = await resolvePlayable(
          principal.userId,
          request.itemId,
          request.mediaFileId,
        );

        sendData(
          context.response,
          context.requestId,
          planDto(buildPlan(request, analysis)),
        );
      },
    },

    {
      method: "POST",
      path: "/playback/sessions",
      access: "authenticated",
      handle: async (context) => {
        const principal = context.requirePrincipal();
        const request = planRequestBody(await context.readJson(32 * 1_024));
        const { file, analysis } = await resolvePlayable(
          principal.userId,
          request.itemId,
          request.mediaFileId,
        );
        const basePlan = buildPlan(request, analysis);
        const planned: PlaybackPlan = {
          ...basePlan,
          sourceDurationSeconds: analysis.durationSeconds,
          ...(request.startTimeMs === undefined
            ? {}
            : {
                startTimeSeconds: Math.min(
                  request.startTimeMs / 1000,
                  Math.max(0, analysis.durationSeconds - 0.25),
                ),
              }),
        };

        // Reserve the durable session id before choosing delivery. It gives the
        // original-file fallback a stable URL while the rendition service
        // checks for an already-generated adaptive package. No ffmpeg process
        // is started until that check has finished.
        const reservedSessionId = await sessions.nextId();
        const reservedFileUrl = `${PLAYBACK_SESSION_ROUTE_BASE}/${reservedSessionId}/file`;
        const qualityManifest = await buildQualityManifest(
          file,
          analysis,
          planned,
          request.clientCapabilities,
          reservedFileUrl,
        );
        const adaptivePlan = buildAdaptiveRenditionPlan(
          planned,
          qualityManifest,
          {
            selectedAudioStreamIndex: request.audioStreamIndex,
            maxHeight: request.maxHeight,
            qualityHeight: request.qualityHeight,
          },
        );
        const canUseAdaptive = adaptivePlan !== null;
        const plan = adaptivePlan ?? planned;
        const mode = toNativeMode(plan);

        let sessionId: string;
        let deliveryUrl: string;
        let deliveryType: "file" | "hls";
        let runtimeKey: string | null = null;

        if (canUseAdaptive) {
          sessionId = reservedSessionId;
          deliveryType = "hls";
          deliveryUrl = plan.delivery.url as string;
        } else if (plan.requiresFfmpeg) {
          let runtimeSession: Awaited<
            ReturnType<PlaybackSessionManager["createSession"]>
          >;
          try {
            runtimeSession = await sessionManager.createSession(plan, analysis);
          } catch (error) {
            if (
              error instanceof PlaybackConversionUnavailableError ||
              error instanceof PlaybackSessionStartupError ||
              error instanceof PlaybackCapacityError
            ) {
              throw new OwnApiError(
                "code" in error && typeof error.code === "string"
                  ? error.code
                  : "PLAYBACK_SESSION_START_FAILED",
                error.message,
                error.statusCode,
              );
            }
            throw error;
          }
          runtimeKey = runtimeSession.sessionId;
          sessionId = runtimeSession.sessionId;
          deliveryType = "hls";
          deliveryUrl = `${PLAYBACK_SESSION_ROUTE_BASE}/${sessionId}/master.m3u8`;
        } else {
          sessionId = reservedSessionId;
          deliveryType = "file";
          deliveryUrl = `${PLAYBACK_SESSION_ROUTE_BASE}/${sessionId}/file`;
        }

        await sessions.create({
          id: sessionId,
          userId: principal.userId,
          itemId: request.itemId,
          mediaFileId: file.id,
          mode,
          runtimeKey,
          audioStreamIndex: plan.selected.audioStreamIndex ?? null,
          subtitleStreamIndex: plan.selected.subtitleStreamIndex ?? null,
          maxHeight: request.maxHeight ?? null,
          maxBitrateBps: request.maxBitrateBps ?? null,
          reasonCodes: toReasonCodes(plan),
        });

        sendData(context.response, context.requestId, {
          sessionId,
          itemId: request.itemId,
          mediaFileId: file.id,
          plan: planDto(plan),
          delivery: { type: deliveryType, url: deliveryUrl },
          ...((plan.qualityManifest ?? qualityManifest)
            ? { qualityManifest: plan.qualityManifest ?? qualityManifest }
            : {}),
        });
      },
    },

    {
      method: "GET",
      path: "/playback/sessions/:sessionId",
      access: "authenticated",
      handle: async (context) => {
        const principal = context.requirePrincipal();
        const session = await requireOwnedSession(
          principal.userId,
          requireUuid(context.params.sessionId, "sessionId"),
        );

        sendData(context.response, context.requestId, {
          sessionId: session.id,
          itemId: session.itemId,
          mode: session.mode,
          status: session.status,
          positionMs: session.positionMs,
          isPaused: session.isPaused,
          reasonCodes: session.reasonCodes,
          createdAt: session.createdAt.toISOString(),
        });
      },
    },

    {
      method: "DELETE",
      path: "/playback/sessions/:sessionId",
      access: "authenticated",
      handle: async (context) => {
        const principal = context.requirePrincipal();
        const sessionId = requireUuid(context.params.sessionId, "sessionId");
        const session = await sessions.get(sessionId);

        // Ending a session is idempotent: a player that retries its teardown
        // during unload must not receive an error.
        if (session && session.userId === principal.userId) {
          if (session.runtimeKey) {
            await sessionManager.stopSession(session.runtimeKey);
          }
          await sessions.end(sessionId);
        }
        sendNoContent(context.response);
      },
    },

    {
      method: "GET",
      path: "/playback/sessions/:sessionId/file",
      access: "authenticated",
      // Served to a <video> element, which cannot attach a CSRF header. Safe:
      // the method is read-only and the session cookie still authorizes it.
      skipCsrf: true,
      handle: async (context) => {
        const principal = context.requirePrincipal();
        // Direct play holds no process, so an ended session only names the
        // file: resuming an original after a long pause must not 404.
        const session = await requireViewableSession(
          principal.userId,
          requireUuid(context.params.sessionId, "sessionId"),
        );

        const file = await catalogue.getFileById(session.mediaFileId);
        if (!file || file.missingSince !== null) {
          throw new OwnApiError(
            "MEDIA_NOT_FOUND",
            "The requested media could not be found.",
            404,
          );
        }

        const absolutePath = path.resolve(
          resolvedMediaRoot,
          ...file.relativePath.split("/"),
        );
        if (!isPathInsideRoot(resolvedMediaRoot, absolutePath)) {
          throw new OwnApiError(
            "MEDIA_NOT_FOUND",
            "The requested media could not be found.",
            404,
          );
        }

        await sessions.touch(session.id);
        await serveFile(
          context.response,
          absolutePath,
          context.request.headers.range as string | undefined,
          context.method === "HEAD",
          "private, max-age=0, no-cache",
        );
      },
    },

    {
      method: "GET",
      path: "/playback/sessions/:sessionId/subtitles/:subtitleAsset",
      access: "authenticated",
      skipCsrf: true,
      handle: async (context) => {
        const principal = context.requirePrincipal();
        const session = await requireViewableSession(
          principal.userId,
          requireUuid(context.params.sessionId, "sessionId"),
        );
        const assetMatch = /^(\d{1,6})\.vtt$/.exec(
          context.params.subtitleAsset ?? "",
        );
        if (!assetMatch?.[1]) {
          throw validationError("The subtitle stream is invalid.");
        }

        const streamIndex = Number(assetMatch[1]);
        const file = await catalogue.getFileById(session.mediaFileId);
        if (!file || file.missingSince !== null) {
          throw new OwnApiError(
            "SUBTITLE_NOT_FOUND",
            "The requested subtitle could not be found.",
            404,
          );
        }
        const streams = await catalogue.listStreams(file.id);
        const packaged = packagedSubtitleFor(
          streams,
          await packagedSubtitlesOf(file),
          streamIndex,
        );
        const input = packaged
          ? null
          : resolveTextSubtitleInput(
              file,
              streams,
              streamIndex,
              resolvedMediaRoot,
            );
        if (!packaged && !input) {
          throw new OwnApiError(
            "SUBTITLE_NOT_FOUND",
            "The requested subtitle could not be found.",
            404,
          );
        }

        let webVtt: Buffer;
        try {
          webVtt = packaged
            ? await readFile(packaged.path)
            : await extractSubtitleAsWebVtt(
                input!.inputPath,
                input!.inputStreamIndex,
                ffmpegPath,
              );
        } catch {
          throw new OwnApiError(
            "SUBTITLE_UNAVAILABLE",
            "The requested subtitle could not be converted.",
            422,
          );
        }

        await sessions.touch(session.id);
        context.response.statusCode = 200;
        context.response.setHeader("Content-Type", "text/vtt; charset=utf-8");
        context.response.setHeader("Content-Length", String(webVtt.length));
        context.response.setHeader("Cache-Control", "private, max-age=300");
        context.response.setHeader("X-Content-Type-Options", "nosniff");
        context.response.end(context.method === "HEAD" ? undefined : webVtt);
      },
    },

    {
      method: "GET",
      path: "/playback/sessions/:sessionId/frame.png",
      access: "authenticated",
      // Fetched by the player as a blob, which carries no CSRF header. Safe:
      // the method is read-only and the session cookie still authorizes it.
      skipCsrf: true,
      handle: async (context) => {
        const principal = context.requirePrincipal();
        const session = await requireViewableSession(
          principal.userId,
          requireUuid(context.params.sessionId, "sessionId"),
        );

        const rawAt = context.url.searchParams.get("at") ?? "";
        const atSeconds = Number(rawAt);
        if (
          rawAt.trim() === "" ||
          !Number.isFinite(atSeconds) ||
          atSeconds < 0 ||
          atSeconds > 86_400
        ) {
          throw validationError("The frame time is invalid.");
        }

        const file = await catalogue.getFileById(session.mediaFileId);
        if (!file || file.missingSince !== null) {
          throw new OwnApiError(
            "MEDIA_NOT_FOUND",
            "The requested media could not be found.",
            404,
          );
        }

        const absolutePath = path.resolve(
          resolvedMediaRoot,
          ...file.relativePath.split("/"),
        );
        if (!isPathInsideRoot(resolvedMediaRoot, absolutePath)) {
          throw new OwnApiError(
            "MEDIA_NOT_FOUND",
            "The requested media could not be found.",
            404,
          );
        }

        const frameUnavailable = () =>
          new OwnApiError(
            "FRAME_UNAVAILABLE",
            "The frame could not be captured.",
            422,
          );

        /*
         * A fully processed title keeps only its package: the source was
         * removed once Drive held every rendition. Its frames then come from
         * the package's highest video rendition, opened through its playlist
         * for the reason `PackagedVideo.playlistPath` gives — the MP4 behind it
         * takes minutes to open on the Drive mount. The rung is the source's
         * own resolution for anything packaged at full size.
         */
        const sourcePresent = await stat(absolutePath).then(
          (stats) => stats.isFile(),
          () => false,
        );
        let inputPath = absolutePath;
        let toneMap: boolean;
        let localPlaylist: LocalPlaylistCopy | null = null;
        if (sourcePresent) {
          const streams = await catalogue.listStreams(file.id);
          toneMap = streams.some(
            (stream) =>
              stream.kind === "video" && isHdrTransfer(stream.colorTransfer),
          );
        } else {
          const packaged = renditions?.findPackagedVideo
            ? await renditions
                .findPackagedVideo({
                  mediaId: file.id,
                  filePath: absolutePath,
                  size: Number(file.sizeBytes),
                  mtimeMs: Number(file.mtimeMs),
                })
                .catch(() => null)
            : null;
          if (!packaged) {
            throw frameUnavailable();
          }
          toneMap = isHdrTransfer(packaged.colorTransfer);
          try {
            localPlaylist = await writeLocalPackagePlaylist(
              packaged.playlistPath,
            );
          } catch {
            throw frameUnavailable();
          }
          inputPath = localPlaylist.path;
        }

        let png: Buffer;
        try {
          png = await captureFrameAsPng(
            inputPath,
            atSeconds,
            { toneMap },
            ffmpegPath,
          );
        } catch {
          png = Buffer.alloc(0);
        } finally {
          await localPlaylist?.remove();
        }
        // Empty also means `at` was past the last frame.
        if (png.length === 0) throw frameUnavailable();

        await sessions.touch(session.id);
        context.response.statusCode = 200;
        context.response.setHeader("Content-Type", "image/png");
        context.response.setHeader("Content-Length", String(png.length));
        context.response.setHeader("Cache-Control", "private, max-age=300");
        context.response.setHeader("X-Content-Type-Options", "nosniff");
        context.response.end(png);
      },
    },

    ...(renditions
      ? [
          {
            method: "GET",
            path: "/playback/renditions/:token/adaptive/:version/master.m3u8",
            access: "authenticated",
            skipCsrf: true,
            handle: (context) => serveAdaptiveMaster(context, "master.m3u8"),
          } satisfies RouteDefinition,
          {
            method: "GET",
            path: "/playback/renditions/:token/adaptive/:version/.seyirlik/master.m3u8",
            access: "authenticated",
            skipCsrf: true,
            handle: (context) =>
              serveAdaptiveMaster(context, ".seyirlik/master.m3u8"),
          } satisfies RouteDefinition,
          {
            method: "GET",
            path: "/playback/renditions/:token/adaptive/:version/:kind/:assetName",
            access: "authenticated",
            skipCsrf: true,
            handle: (context) =>
              serveAdaptiveFile(
                context,
                `${context.params.kind ?? ""}/${context.params.assetName ?? ""}`,
              ),
          } satisfies RouteDefinition,
          {
            method: "GET",
            path: "/playback/renditions/:token/adaptive/:version/:kind/:renditionId/:assetName",
            access: "authenticated",
            skipCsrf: true,
            handle: (context) =>
              serveAdaptiveFile(
                context,
                `${context.params.kind ?? ""}/${context.params.renditionId ?? ""}/${context.params.assetName ?? ""}`,
              ),
          } satisfies RouteDefinition,
          {
            /**
             * A pre-encoded rendition.
             *
             * The token is the media file id, so it is re-authorized here on
             * every request rather than trusted because it was minted earlier:
             * an authenticated user must still be able to see the item the file
             * belongs to. The rendition service then owns the byte serving,
             * including the walk back to the validated output root.
             */
            method: "GET",
            path: "/playback/renditions/:token/:fileId",
            access: "authenticated",
            // Served to a <video> element, which cannot attach a CSRF header.
            skipCsrf: true,
            handle: async (context) => {
              const principal = context.requirePrincipal();
              const mediaFileId = requireUuid(context.params.token, "token");

              const file = await catalogue.getFileById(mediaFileId);
              if (
                !file ||
                file.missingSince !== null ||
                !(await catalogue.canUserAccessItem(
                  principal.userId,
                  file.itemId,
                ))
              ) {
                throw new OwnApiError(
                  "MEDIA_NOT_FOUND",
                  "The requested media could not be found.",
                  404,
                );
              }

              const resolved = await renditions.resolveFile(
                mediaFileId,
                context.params.fileId ?? "",
              );
              if (!resolved) {
                throw new OwnApiError(
                  "RENDITION_NOT_FOUND",
                  "The requested rendition is unavailable.",
                  404,
                );
              }

              await serveFile(
                context.response,
                resolved.absolutePath,
                context.request.headers.range as string | undefined,
                context.method === "HEAD",
                // Addressed by content fingerprint, so it never changes; still
                // private, because it is behind a session.
                "private, max-age=31536000, immutable",
              );
            },
          } satisfies RouteDefinition,
        ]
      : []),

    {
      method: "GET",
      path: "/playback/sessions/:sessionId/master.m3u8",
      access: "authenticated",
      skipCsrf: true,
      handle: async (context) => {
        const principal = context.requirePrincipal();
        const session = await requireOwnedSession(
          principal.userId,
          requireUuid(context.params.sessionId, "sessionId"),
        );
        const runtime = session.runtimeKey
          ? sessionManager.getSession(session.runtimeKey)
          : undefined;
        if (!runtime) {
          throw new OwnApiError(
            "SESSION_NOT_FOUND",
            "The playback session could not be found.",
            404,
          );
        }

        await sessions.touch(session.id);
        await serveFile(
          context.response,
          path.join(runtime.outputDir, "master.m3u8"),
          undefined,
          context.method === "HEAD",
          // A playlist is session-bound and changes as segments appear.
          "no-store",
        );
      },
    },

    {
      method: "GET",
      path: "/playback/sessions/:sessionId/:segmentName",
      access: "authenticated",
      skipCsrf: true,
      handle: async (context) => {
        const principal = context.requirePrincipal();
        const session = await requireOwnedSession(
          principal.userId,
          requireUuid(context.params.sessionId, "sessionId"),
        );
        const runtime = session.runtimeKey
          ? sessionManager.getSession(session.runtimeKey)
          : undefined;
        if (!runtime) {
          throw new OwnApiError(
            "SESSION_NOT_FOUND",
            "The playback session could not be found.",
            404,
          );
        }

        // The HLS playlist references segments by bare filename, so they resolve
        // as siblings of master.m3u8. The name is re-validated here: it must
        // name a file inside the session's working directory and nothing else.
        const segmentName = context.params.segmentName ?? "";
        if (
          !/^[A-Za-z0-9._-]{1,128}$/.test(segmentName) ||
          segmentName.includes("..")
        ) {
          throw validationError("The segment name is invalid.");
        }

        const absolutePath = path.join(runtime.outputDir, segmentName);
        if (!isPathInsideRoot(path.resolve(runtime.outputDir), absolutePath)) {
          throw new OwnApiError(
            "MEDIA_NOT_FOUND",
            "The requested media could not be found.",
            404,
          );
        }

        await sessions.touch(session.id);
        await serveFile(
          context.response,
          absolutePath,
          context.request.headers.range as string | undefined,
          context.method === "HEAD",
          // Segments are immutable for the life of the session only.
          "private, max-age=60",
        );
      },
    },
  ];
}
