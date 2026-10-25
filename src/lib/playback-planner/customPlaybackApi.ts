import type {
  MediaSource,
  MediaStream,
  PlaybackMode as ViewModelPlaybackMode,
  PlaybackSourceCandidate,
} from "../types";
import { buildClientCapabilities } from "./clientCapabilities";
import type { PlaybackPlan } from "./types";

const CAPABILITY_CACHE_TTL_MS = 30 * 60 * 1000;
const pendingPlaybackRequests = new Map<
  string,
  Promise<PlaybackSourceCandidate | null>
>();
let cachedCapabilities:
  | {
      testedAtMs: number;
      value: Awaited<ReturnType<typeof buildClientCapabilities>>;
    }
  | undefined;
let capabilityPromise: Promise<
  Awaited<ReturnType<typeof buildClientCapabilities>>
> | null = null;

function getBackendUrl(): string | null {
  const rawUrl = import.meta.env.VITE_SEYIRLIK_PLAYBACK_BACKEND_URL;

  if (!rawUrl) {
    return null;
  }

  return rawUrl.replace(/\/+$/, "");
}

export function getCustomPlaybackBackendUrl(): string | null {
  return getBackendUrl();
}

function buildPlaybackEndpoint(baseUrl: string): string {
  if (baseUrl.endsWith("/api/playback")) {
    return `${baseUrl}/request`;
  }

  return `${baseUrl}/api/playback/request`;
}

function safeItemLabel(itemId: string): string {
  return itemId.length <= 12 ? itemId : `${itemId.slice(0, 12)}...`;
}

function buildPlaybackRequestKey(itemId: string): string {
  return JSON.stringify({ itemId });
}

function buildSessionStopEndpoint(baseUrl: string, sessionId: string): string {
  if (baseUrl.endsWith("/api/playback")) {
    return `${baseUrl}/sessions/${encodeURIComponent(sessionId)}/stop`;
  }

  return `${baseUrl}/api/playback/sessions/${encodeURIComponent(sessionId)}/stop`;
}

function makePlanUrlAbsolute(baseUrl: string, url: string | undefined): string {
  if (!url) {
    throw new Error("Custom playback backend did not return a delivery URL.");
  }

  return new URL(url, `${baseUrl}/`).toString();
}

function getMimeType(plan: PlaybackPlan): string {
  if (plan.delivery.type === "hls") {
    return "application/vnd.apple.mpegurl";
  }

  switch (plan.container.input) {
    case "mp4":
      return "video/mp4";
    case "mov":
      return "video/quicktime";
    case "m4v":
      return "video/mp4";
    case "webm":
      return "video/webm";
    case "mkv":
      return "video/x-matroska";
    default:
      return "application/octet-stream";
  }
}

function mapMode(plan: PlaybackPlan): ViewModelPlaybackMode {
  switch (plan.mode) {
    case "direct-play":
      return "DirectPlay";
    case "remux":
    case "audio-transcode":
      return "DirectStream";
    case "subtitle-burn":
    case "video-transcode":
      return "Transcoding";
    default:
      return "Unknown";
  }
}

function mapHlsKind(
  plan: PlaybackPlan,
): PlaybackSourceCandidate["hlsKind"] | undefined {
  if (plan.delivery.type !== "hls") {
    return "direct";
  }

  switch (plan.mode) {
    case "remux":
      return "stream-copy";
    case "audio-transcode":
      return "audio-transcode";
    case "subtitle-burn":
    case "video-transcode":
      return "forced-transcode";
    default:
      return undefined;
  }
}

function getTranscodingReasonCodes(plan: PlaybackPlan): string[] {
  return plan.mode === "direct-play"
    ? []
    : plan.reasons.map((reason) => reason.code);
}

/**
 * Rebuilds a media source in the shape the player's view model expects. The
 * full probe result rides along in `plan.diagnostics.media`, so every audio and
 * subtitle track of the source is listed even when the delivered file is a
 * generated rendition that carries only one audio track and no embedded
 * subtitles: the picker offers the source's tracks and the player fetches
 * subtitle text from the API by stream index. Listing only the selected streams left the subtitle menu empty.
 */
function buildSyntheticMediaSource(plan: PlaybackPlan): MediaSource {
  const transcodeReasons = getTranscodingReasonCodes(plan);
  const analysis = plan.diagnostics?.media;

  const analysedStreams: MediaStream[] = analysis
    ? [
        ...analysis.videoStreams.map((stream) => ({
          Index: stream.index,
          Type: "Video" as const,
          Codec: stream.codecName,
          Profile: stream.profile,
          Width: stream.width,
          Height: stream.height,
          BitRate: stream.bitrate,
        })),
        ...analysis.audioStreams.map((stream) => ({
          Index: stream.index,
          Type: "Audio" as const,
          Codec: stream.codecName,
          Language: stream.language,
          Title: stream.title,
          Channels: stream.channels,
          BitRate: stream.bitrate,
          IsDefault: stream.isDefault,
        })),
        // Image-based subtitles (PGS, VOBSUB) cannot be delivered as WebVTT
        // text, and the player renders text cues only, so listing them would
        // offer tracks that can never load.
        ...analysis.subtitleStreams
          .filter((stream) => !stream.isImageBased)
          .map((stream) => ({
            Index: stream.index,
            Type: "Subtitle" as const,
            Codec: stream.codecName,
            Language: stream.language,
            Title: stream.title,
            IsDefault: stream.isDefault,
            IsForced: stream.isForced,
            IsExternal: stream.isExternal ?? false,
            IsTextSubtitleStream: true,
          })),
      ]
    : [];

  const fallbackStreams: MediaStream[] = [
    {
      Index: plan.selected.videoStreamIndex,
      Type: "Video",
      Codec: plan.video.outputCodec ?? plan.video.inputCodec,
    },
    ...(plan.selected.audioStreamIndex !== undefined
      ? [
          {
            Index: plan.selected.audioStreamIndex,
            Type: "Audio" as const,
            Codec: plan.audio.outputCodec ?? plan.audio.inputCodec,
          },
        ]
      : []),
    ...(plan.selected.subtitleStreamIndex !== undefined
      ? [
          {
            Index: plan.selected.subtitleStreamIndex,
            Type: "Subtitle" as const,
            Codec: plan.subtitles.inputCodec,
          },
        ]
      : []),
  ];

  const mediaStreams =
    analysedStreams.length > 0 ? analysedStreams : fallbackStreams;
  const defaultAudio = analysis?.audioStreams.find(
    (stream) => stream.isDefault,
  );

  return {
    Id: plan.mediaId,
    Name: plan.mediaId,
    Container: plan.container.input,
    SupportsDirectPlay: plan.mode === "direct-play",
    SupportsDirectStream:
      plan.mode === "remux" || plan.mode === "audio-transcode",
    SupportsTranscoding:
      plan.mode === "subtitle-burn" || plan.mode === "video-transcode",
    TranscodingReasons: transcodeReasons,
    ...(defaultAudio ? { DefaultAudioStreamIndex: defaultAudio.index } : {}),
    MediaStreams: mediaStreams,
  };
}

function planToPlaybackCandidate(
  itemId: string,
  plan: PlaybackPlan,
  baseUrl: string,
): PlaybackSourceCandidate {
  const url = makePlanUrlAbsolute(baseUrl, plan.delivery.url);
  const reason = plan.reasons.map((item) => item.message).join(" ");
  const transcodeReasons = getTranscodingReasonCodes(plan);
  const qualityManifest = plan.qualityManifest
    ? {
        ...plan.qualityManifest,
        ...(plan.qualityManifest.adaptive
          ? {
              adaptive: {
                ...plan.qualityManifest.adaptive,
                playbackUrl: makePlanUrlAbsolute(
                  baseUrl,
                  plan.qualityManifest.adaptive.playbackUrl,
                ),
              },
            }
          : {}),
        qualities: plan.qualityManifest.qualities.map((quality) => ({
          ...quality,
          playbackUrl: makePlanUrlAbsolute(baseUrl, quality.playbackUrl),
        })),
      }
    : undefined;

  const adaptive = qualityManifest?.adaptive;
  return {
    id: `custom-${plan.mode}-${plan.delivery.sessionId ?? "file"}`,
    itemId,
    mediaSourceId: plan.mediaId,
    playSessionId: plan.delivery.sessionId,
    mode: adaptive ? "DirectPlay" : mapMode(plan),
    url: adaptive?.playbackUrl ?? url,
    mimeType: adaptive?.mimeType ?? getMimeType(plan),
    isHls: Boolean(adaptive) || plan.delivery.type === "hls",
    hlsKind: adaptive ? "adaptive-rendition" : mapHlsKind(plan),
    label: `Custom ${plan.mode}`,
    mediaSource: buildSyntheticMediaSource(plan),
    playbackDiagnostics: plan.diagnostics,
    qualityManifest,
    reason,
    transcodeReasons,
    priority: 0,
  };
}

export function isCustomPlaybackBackendConfigured(): boolean {
  return Boolean(getBackendUrl());
}

export function isCustomPlaybackCandidate(
  source: PlaybackSourceCandidate | null | undefined,
): boolean {
  return Boolean(source?.id.startsWith("custom-"));
}

async function getCachedClientCapabilities() {
  const now = Date.now();

  if (
    cachedCapabilities &&
    now - cachedCapabilities.testedAtMs < CAPABILITY_CACHE_TTL_MS
  ) {
    return cachedCapabilities.value;
  }

  if (!capabilityPromise) {
    capabilityPromise = buildClientCapabilities()
      .then((capabilities) => {
        cachedCapabilities = {
          testedAtMs: Date.now(),
          value: capabilities,
        };
        return capabilities;
      })
      .finally(() => {
        capabilityPromise = null;
      });
  }

  return capabilityPromise;
}

export async function requestCustomPlaybackCandidate(
  itemId: string,
): Promise<PlaybackSourceCandidate | null> {
  const baseUrl = getBackendUrl();

  if (!baseUrl) {
    return null;
  }

  const requestKey = buildPlaybackRequestKey(itemId);
  const pendingRequest = pendingPlaybackRequests.get(requestKey);

  if (pendingRequest) {
    console.info(
      `[Seyirlik Playback] Custom playback request deduplicated for item ${safeItemLabel(
        itemId,
      )}.`,
    );
    return pendingRequest;
  }

  const request = (async () => {
    const clientCapabilities = await getCachedClientCapabilities();
    const response = await fetch(buildPlaybackEndpoint(baseUrl), {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        mediaId: itemId,
        clientCapabilities,
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `Custom playback request failed with ${response.status}: ${text}`,
      );
    }

    const plan = (await response.json()) as PlaybackPlan;
    return planToPlaybackCandidate(itemId, plan, baseUrl);
  })().finally(() => {
    pendingPlaybackRequests.delete(requestKey);
  });

  pendingPlaybackRequests.set(requestKey, request);
  return request;
}

export async function stopCustomPlaybackSession(
  source: PlaybackSourceCandidate | null | undefined,
  options: { keepalive?: boolean } = {},
): Promise<void> {
  const baseUrl = getBackendUrl();
  const sessionId = source?.playSessionId;

  if (!baseUrl || !sessionId || !isCustomPlaybackCandidate(source)) {
    return;
  }

  await fetch(buildSessionStopEndpoint(baseUrl, sessionId), {
    method: "POST",
    keepalive: options.keepalive,
  });
}
