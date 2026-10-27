import type { MediaQualityManifest } from "../../renditions/contracts";

export type PlaybackMode =
  | "direct-play"
  | "remux"
  | "audio-transcode"
  | "subtitle-burn"
  | "video-transcode";

export type StreamAction = "copy" | "transcode" | "none";
export type ContainerAction = "direct" | "remux" | "hls";
export type SubtitleAction = "none" | "external" | "convert" | "burn";

export interface MediaAnalysis {
  mediaId: string;
  filePath: string;
  container: {
    formatName: string;
    extension?: string;
    isBrowserDirectPlayableContainer: boolean;
  };
  durationSeconds: number;
  overallBitrate?: number;
  videoStreams: VideoStreamAnalysis[];
  audioStreams: AudioStreamAnalysis[];
  subtitleStreams: SubtitleStreamAnalysis[];
  chapters?: Array<{
    id?: number;
    startSeconds: number;
    endSeconds: number;
    title?: string;
  }>;
  analysedAt: string;
}

export interface VideoStreamAnalysis {
  index: number;
  codecName: string;
  codecLongName?: string;
  profile?: string;
  level?: number | string;
  width: number;
  height: number;
  framerate?: number;
  bitrate?: number;
  pixFmt?: string;
  bitDepth?: number;
  colorRange?: string;
  colorSpace?: string;
  colorTransfer?: string;
  colorPrimaries?: string;
  isHdr?: boolean;
  hasDolbyVision?: boolean;
}

export interface AudioStreamAnalysis {
  index: number;
  codecName: string;
  codecLongName?: string;
  channels?: number;
  channelLayout?: string;
  bitrate?: number;
  sampleRate?: number;
  language?: string;
  title?: string;
  isDefault?: boolean;
}

export interface SubtitleStreamAnalysis {
  index: number;
  /** A mutable file beside the source, rather than an embedded track. */
  isExternal?: boolean;
  codecName: string;
  language?: string;
  title?: string;
  isDefault?: boolean;
  isForced?: boolean;
  isImageBased: boolean;
}

export interface ClientCapabilities {
  deviceId?: string;
  userAgent?: string;
  platform?: string;
  playbackEngine?: "browser" | "native";
  nativePlayer?: NativePlayerCapabilities;
  supportsHlsNative: boolean;
  supportsMediaSource: boolean;
  supportsManagedMediaSource?: boolean;
  directFileContainers: string[];
  mseContainers: string[];
  video: {
    h264?: CodecCapability;
    hevc?: CodecCapability;
    av1?: CodecCapability;
    vp9?: CodecCapability;
  };
  audio: {
    aac?: AudioCapability;
    mp3?: AudioCapability;
    opus?: AudioCapability;
    ac3?: AudioCapability;
    eac3?: AudioCapability;
    flac?: AudioCapability;
  };
  subtitles: {
    srtExternal: boolean;
    webvttExternal: boolean;
    assExternal: boolean;
    imageBasedExternal: boolean;
  };
  maxResolution?: {
    width: number;
    height: number;
  };
  maxBitrate?: number;
  testedAt: string;
}

export interface NativePlayerCapabilities {
  engine: "libmpv" | "ffmpeg" | "vlc" | "gstreamer" | "other";
  version?: string;
  supportedContainers: string[] | "*";
  supportedVideoCodecs: string[] | "*";
  supportedAudioCodecs: string[] | "*";
  hardwareDecoding: boolean;
  supports10BitVideo: boolean;
  supportsHdr: boolean;
  supportsDolbyVisionBaseLayer: boolean;
  maxWidth?: number;
  maxHeight?: number;
  maxBitrate?: number;
  maxAudioChannels?: number;
  subtitles: {
    text: boolean;
    ass: boolean;
    imageBased: boolean;
  };
}

export interface CodecCapability {
  supported: boolean;
  smooth?: boolean;
  powerEfficient?: boolean;
  mimeTypesTested?: string[];
  maxWidth?: number;
  maxHeight?: number;
  maxBitrate?: number;
  maxFramerate?: number;
  supports10Bit?: boolean;
  supportsHdr?: boolean;
}

export interface AudioCapability {
  supported: boolean;
  mimeTypesTested?: string[];
  maxChannels?: number;
}

export type PlaybackReasonCode =
  | "direct_play_supported"
  | "container_unsupported"
  | "video_codec_unsupported"
  | "video_profile_unsupported"
  | "video_bit_depth_unsupported"
  | "hdr_tonemap_required"
  | "resolution_too_high"
  | "bitrate_too_high"
  | "audio_codec_unsupported"
  | "audio_channels_unsupported"
  /** A non-default audio track was chosen, which direct play cannot deliver. */
  | "audio_selection_requires_remux"
  | "subtitle_external_supported"
  | "subtitle_conversion_required"
  | "subtitle_burn_required"
  | "client_capability_unknown";

export interface PlaybackReason {
  code: PlaybackReasonCode;
  severity: "info" | "warning" | "blocking";
  message: string;
}

export type PlaybackDiagnosticsMedia = Omit<MediaAnalysis, "filePath"> & {
  fileName?: string;
};

export interface PlaybackDiagnostics {
  clientCapabilities: ClientCapabilities;
  media: PlaybackDiagnosticsMedia;
  decision: {
    browserCapabilityMatch: {
      container: boolean;
      video: boolean;
      audio: boolean;
      subtitles: boolean;
    };
    byteRangeSupported: boolean;
    directMediaUrl?: string;
    directPlaySupported: boolean;
    ffmpegStarted: boolean;
    mode: PlaybackMode;
    source: {
      container: string;
      videoCodec: string;
      audioCodec?: string;
    };
    requiresFfmpeg: boolean;
    preservesOriginalVideoQuality: boolean;
    expectedStartup: "instant" | "fast" | "slow";
    containerAction: ContainerAction;
    videoAction: StreamAction;
    audioAction: StreamAction;
    subtitleAction: SubtitleAction;
    selectedVideoStreamIndex: number;
    selectedAudioStreamIndex?: number;
    selectedSubtitleStreamIndex?: number;
    reasons: PlaybackReason[];
    blockingReasons: PlaybackReason[];
  };
}

export interface PlaybackPlan {
  mode: PlaybackMode;
  requiresFfmpeg: boolean;
  preservesOriginalVideoQuality: boolean;
  expectedStartup: "instant" | "fast" | "slow";
  mediaId: string;
  /** Earliest timeline position an incremental replacement must expose. */
  startTimeSeconds?: number;
  /** Source bound used when reserving startup buffer near the end. */
  sourceDurationSeconds?: number;
  selected: {
    videoStreamIndex: number;
    audioStreamIndex?: number;
    subtitleStreamIndex?: number;
  };
  container: {
    input: string;
    output: "original" | "mp4" | "hls-fmp4" | "hls-ts";
    action: ContainerAction;
  };
  video: {
    inputCodec: string;
    outputCodec?: string;
    action: StreamAction;
    reason?: string;
  };
  audio: {
    inputCodec?: string;
    outputCodec?: string;
    action: StreamAction;
    reason?: string;
  };
  subtitles: {
    inputCodec?: string;
    action: SubtitleAction;
    reason?: string;
  };
  reasons: PlaybackReason[];
  processing?: {
    node: "server" | "client";
    videoEncoder?: string;
    hardwareAccelerated?: boolean;
    softwareThreadLimit?: number;
  };
  delivery: {
    type: "file" | "hls";
    url?: string;
    sessionId?: string;
  };
  qualityManifest?: MediaQualityManifest;
  diagnostics?: PlaybackDiagnostics;
}

export interface PlaybackQualityLimit {
  maxBitrate?: number;
  maxWidth?: number;
  maxHeight?: number;
}

export interface DecidePlaybackPlanInput {
  media: MediaAnalysis;
  client: ClientCapabilities;
  selectedVideoStreamIndex?: number;
  selectedAudioStreamIndex?: number;
  selectedSubtitleStreamIndex?: number | null;
  forceQualityLimit?: PlaybackQualityLimit;
}
