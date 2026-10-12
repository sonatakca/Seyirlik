import {
  GalleryVerticalEnd,
  Loader2,
  Maximize,
  Pause,
  PictureInPicture2,
  Play,
  RotateCcw,
  RotateCw,
  Settings,
} from "lucide-react";
import { useLanguage } from "../../i18n/LanguageContext";
import { SeekBar, type SeekPointerAxis } from "./SeekBar";
import { VolumeControl } from "./VolumeControl";
import { PlayerSettingsPanel } from "./PlayerSettingsPanel";
import type { PlaybackQueue } from "../../lib/playbackQueue";
import type {
  PlaybackQualityOption,
  PlaybackSourceCandidate,
} from "../../lib/types";
import { useState } from "react";
import { Tooltip } from "../ui/Tooltip";
import { PlayerQueuePanel } from "./PlayerQueuePanel";
import type { CompleteFileQualityControls } from "./types";

interface PlayerControlsProps {
  visible: boolean;
  isPlaying: boolean;
  playWaiting: boolean;
  currentTime: number;
  duration: number;
  bufferedEnd: number;
  volume: number;
  muted: boolean;
  source: PlaybackSourceCandidate;
  qualityOptions: PlaybackQualityOption[];
  selectedQualityId: string;
  selectedAudioStreamIndex?: number;
  selectedSubtitleStreamIndex: number;
  subtitleDelaySeconds: number;
  canSwitchAudio: boolean;
  /**
   * Why a track or quality change did not take effect.
   *
   * Rendered inside the settings panel, next to the row that was clicked: a
   * refusal announced anywhere else is indistinguishable from the click doing
   * nothing at all.
   */
  audioNoticeText?: string;
  canSwitchSubtitles: boolean;
  completeFileQuality?: CompleteFileQualityControls;
  isSubtitleEditMode?: boolean;
  settingsOpen: boolean;
  playbackQueue?: PlaybackQueue | null;
  queueOpen?: boolean;
  itemId: string;
  mediaSourceId?: string;
  checkpointSeconds?: number | null;
  previewAspectRatio?: number;
  seekPreviewLoading?: boolean;
  seekPointerAxis?: SeekPointerAxis;
  compactSeekPreview?: boolean;
  compactLayout?: boolean;
  onTogglePlay: () => void;
  onControlsHoverStart?: () => void;
  onControlsHoverEnd?: () => void;
  onSeek: (seconds: number) => void;
  onSeekBy: (seconds: number) => void;
  onToggleMute: () => void;
  onVolumeChange: (volume: number) => void;
  onToggleFullscreen: () => void;
  /** Shown only where the element can go into Picture in Picture. */
  canPictureInPicture?: boolean;
  isPictureInPicture?: boolean;
  onTogglePictureInPicture?: () => void;
  onOpenQueue?: () => void;
  onPlayQueueItem?: (itemId: string) => void;
  onOpenSettings: () => void;
  onSelectAutoQuality: () => void;
  onSelectQuality: (quality: PlaybackQualityOption) => void;
  onSelectAudioStream: (streamIndex: number) => void;
  onSelectSubtitleStream: (streamIndex: number) => void;
  onSubtitleDelayChange: (seconds: number) => void;
  onStartSubtitleEdit?: () => void;
  onSeekPreview?: (seconds: number) => void;
  onSeekPreviewCancel?: () => void;
}

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return "0:00";
  }

  const totalSeconds = Math.floor(seconds);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const remainingSeconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, "0")}:${remainingSeconds.toString().padStart(2, "0")}`;
  }

  return `${minutes}:${remainingSeconds.toString().padStart(2, "0")}`;
}

export function PlayerControls({
  visible,
  isPlaying,
  playWaiting,
  currentTime,
  duration,
  bufferedEnd,
  volume,
  muted,
  source,
  qualityOptions,
  selectedQualityId,
  selectedAudioStreamIndex,
  selectedSubtitleStreamIndex,
  subtitleDelaySeconds,
  canSwitchAudio,
  audioNoticeText,
  canSwitchSubtitles,
  completeFileQuality,
  isSubtitleEditMode = false,
  settingsOpen,
  playbackQueue = null,
  queueOpen = false,
  itemId,
  mediaSourceId,
  checkpointSeconds,
  previewAspectRatio,
  seekPreviewLoading = false,
  seekPointerAxis = "horizontal",
  compactSeekPreview = false,
  compactLayout = false,
  onTogglePlay,
  onControlsHoverStart,
  onControlsHoverEnd,
  onSeek,
  onSeekBy,
  onToggleMute,
  onVolumeChange,
  onToggleFullscreen,
  canPictureInPicture = false,
  isPictureInPicture = false,
  onTogglePictureInPicture,
  onOpenQueue,
  onPlayQueueItem,
  onOpenSettings,
  onSelectAutoQuality,
  onSelectQuality,
  onSelectAudioStream,
  onSelectSubtitleStream,
  onSubtitleDelayChange,
  onStartSubtitleEdit,
  onSeekPreview,
  onSeekPreviewCancel,
}: PlayerControlsProps) {
  const { t } = useLanguage();
  const [showRemainingTime, setShowRemainingTime] = useState(false);
  const [isVolumeControlOpen, setIsVolumeControlOpen] = useState(false);
  const remainingTime = Math.max(duration - currentTime, 0);
  const timeDisplay = showRemainingTime
    ? `-${formatTime(remainingTime)} / ${formatTime(duration)}`
    : `${formatTime(currentTime)} / ${formatTime(duration)}`;
  const playbackQueueLabel = playbackQueue
    ? playbackQueue.kind === "series"
      ? t("player.queueEpisodes")
      : t("player.queueCollection")
    : t("player.playbackQueue");

  return (
    <div
      data-mobile-tight-controls
      className={`seyirlik-player-chrome seyirlik-player-bottom-chrome pointer-events-none absolute inset-x-0 bottom-0 z-30 px-[max(0.55rem,env(safe-area-inset-left))] pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-6 sm:px-[max(1rem,env(safe-area-inset-left))] sm:pb-[max(1.25rem,env(safe-area-inset-bottom))] sm:pt-14 ${
        visible
          ? "seyirlik-player-chrome--visible"
          : "seyirlik-player-chrome--hidden"
      }`}
    >
      <div
        className="seyirlik-player-controls-inner pointer-events-auto mx-auto w-[100%]"
        onMouseEnter={onControlsHoverStart}
        onMouseLeave={onControlsHoverEnd}
        onPointerEnter={onControlsHoverStart}
        onPointerLeave={onControlsHoverEnd}
      >
        <div className="seyirlik-seekbar-position relative">
          <SeekBar
            currentTime={currentTime}
            duration={duration}
            bufferedEnd={bufferedEnd}
            itemId={itemId}
            mediaSourceId={mediaSourceId}
            checkpointSeconds={checkpointSeconds}
            previewAspectRatio={previewAspectRatio}
            onSeek={onSeek}
            onSeekPreview={onSeekPreview}
            onSeekPreviewCancel={onSeekPreviewCancel}
            pointerAxis={seekPointerAxis}
            compactPreview={compactSeekPreview}
          />
        </div>
        <div
          className="relative mt-1 sm:mt-3"
          onMouseLeave={() => setIsVolumeControlOpen(false)}
          onPointerLeave={() => setIsVolumeControlOpen(false)}
          onBlur={(event) => {
            if (
              !event.currentTarget.contains(event.relatedTarget as Node | null)
            ) {
              setIsVolumeControlOpen(false);
            }
          }}
        >
          <div
            aria-hidden="true"
            className="pointer-events-auto absolute inset-x-0 top-0 z-0 h-[calc(100%+max(1.25rem,env(safe-area-inset-bottom)))]"
          />

          <div className="relative z-10 flex items-center justify-between gap-1 sm:gap-3">
            <div className="flex min-w-0 flex-1 items-center gap-1 sm:gap-2">
              <Tooltip
                content={
                  playWaiting
                    ? t("player.waitingForSyncPlay")
                    : isPlaying
                      ? t("common.pause")
                      : t("common.play")
                }
                offset="2.1rem"
                shortcut="␣"
                group="player-controls"
              >
                <button
                  type="button"
                  onClick={onTogglePlay}
                  aria-busy={playWaiting}
                  className="seyirlik-player-main-toggle relative flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-white transition-[backdrop-filter] hover:bg-white/[0.12] hover:backdrop-blur-lg hover:duration-1000 duration-[500ms] focus:outline-none focus:ring-2 focus:ring-[var(--accent)] sm:flex"
                  aria-label={
                    playWaiting
                      ? t("player.waitingForSyncPlay")
                      : isPlaying
                        ? t("common.pause")
                        : t("common.play")
                  }
                >
                  {playWaiting ? (
                    <>
                      <Loader2
                        size={38}
                        className="absolute animate-spin text-white sm:size-12"
                        strokeWidth={2}
                      />
                      <Play
                        size={18}
                        className="ml-0.5 text-white"
                        fill="currentColor"
                        strokeWidth={2.4}
                      />
                    </>
                  ) : isPlaying ? (
                    <Pause
                      size={25}
                      className="text-white sm:size-7"
                      fill="currentColor"
                      strokeWidth={2.4}
                    />
                  ) : (
                    <Play
                      size={25}
                      className="ml-0.5 text-white sm:size-7"
                      fill="currentColor"
                      strokeWidth={2.4}
                    />
                  )}
                </button>
              </Tooltip>
              <Tooltip
                content={t("player.rewind5")}
                offset="2.5rem"
                shortcut="←"
                group="player-controls"
              >
                <button
                  type="button"
                  onClick={() => onSeekBy(-5)}
                  className="seyirlik-player-skip-control hidden h-11 w-11 items-center justify-center rounded-full text-white transition-[backdrop-filter] hover:bg-white/[0.12] hover:backdrop-blur-lg hover:duration-1000 duration-[500ms] focus:outline-none focus:ring-2 focus:ring-[var(--accent)] sm:flex"
                  aria-label={t("player.rewind5")}
                >
                  <RotateCcw size={21} />
                </button>
              </Tooltip>
              <Tooltip
                content={t("player.forward5")}
                offset="2.5rem"
                shortcut="→"
                group="player-controls"
              >
                <button
                  type="button"
                  onClick={() => onSeekBy(5)}
                  className="seyirlik-player-skip-control hidden h-11 w-11 items-center justify-center rounded-full text-white transition-[backdrop-filter] hover:bg-white/[0.12] hover:backdrop-blur-lg hover:duration-1000 duration-[500ms] focus:outline-none focus:ring-2 focus:ring-[var(--accent)] sm:flex"
                  aria-label={t("player.forward5")}
                >
                  <RotateCw size={21} />
                </button>
              </Tooltip>
              <VolumeControl
                volume={volume}
                muted={muted}
                isExpanded={isVolumeControlOpen}
                onToggleMute={onToggleMute}
                onVolumeChange={onVolumeChange}
                onRequestExpand={() => setIsVolumeControlOpen(true)}
              />
              <div className="seyirlik-player-clock ml-0.5 flex min-w-[4.8rem] items-center gap-1 whitespace-nowrap text-xs font-medium text-white/[0.82] sm:ml-1 sm:min-w-[7.5rem] sm:gap-2 sm:text-sm">
                <Tooltip
                  content={
                    showRemainingTime
                      ? t("player.showElapsedTime")
                      : t("player.showRemainingTime")
                  }
                  offset="2.8rem"
                  group="player-controls"
                >
                  <button
                    type="button"
                    onClick={() => setShowRemainingTime((value) => !value)}
                    className="rounded-full px-4 py-2.5 text-left hover:bg-white/[0.08] hover:backdrop-blur-lg transition-[backdrop-filter] hover:duration-1000 duration-[500ms] hover:text-white focus:outline-none focus:ring-2 focus:ring-[var(--accent)]"
                    aria-label={
                      showRemainingTime
                        ? t("player.showElapsedTime")
                        : t("player.showRemainingTime")
                    }
                  >
                    {timeDisplay}
                  </button>
                </Tooltip>

                {seekPreviewLoading ? (
                  <span className="inline-flex items-center gap-1 rounded-full border border-white/10 bg-white/[0.08] px-2 py-0.5 text-[0.65rem] font-bold uppercase tracking-[0.12em] text-white/70">
                    <Loader2 className="h-3 w-3 animate-spin text-[var(--accent)]" />
                    <span className="hidden sm:inline">
                      {t("player.seeking")}
                    </span>
                  </span>
                ) : null}
              </div>
            </div>

            <div className="flex shrink-0 items-center gap-1 sm:gap-2">
              {playbackQueue ? (
                <div className="relative" data-player-queue-root>
                  {queueOpen && !isSubtitleEditMode ? (
                    <PlayerQueuePanel
                      queue={playbackQueue}
                      compact={compactLayout}
                      onPlayItem={(queueItem) =>
                        onPlayQueueItem?.(queueItem.Id)
                      }
                    />
                  ) : null}

                  <Tooltip
                    content={playbackQueueLabel}
                    offset="2.5rem"
                    group="player-controls"
                  >
                    <button
                      type="button"
                      onClick={onOpenQueue}
                      className={`flex h-11 w-11 items-center justify-center rounded-full transition-[backdrop-filter] hover:bg-white/[0.12] hover:backdrop-blur-lg hover:duration-1000 duration-[500ms] hover:text-white focus:outline-none focus:ring-2 focus:ring-[var(--accent)] ${
                        queueOpen ? "text-white" : "text-white/85"
                      }`}
                      aria-label={playbackQueueLabel}
                      aria-pressed={queueOpen}
                    >
                      <GalleryVerticalEnd size={22} strokeWidth={2.2} />
                    </button>
                  </Tooltip>
                </div>
              ) : null}

              <div className="relative" data-player-settings-root>
                {settingsOpen && !isSubtitleEditMode ? (
                  <PlayerSettingsPanel
                    source={source}
                    qualityOptions={qualityOptions}
                    selectedQualityId={selectedQualityId}
                    selectedAudioStreamIndex={selectedAudioStreamIndex}
                    selectedSubtitleStreamIndex={selectedSubtitleStreamIndex}
                    subtitleDelaySeconds={subtitleDelaySeconds}
                    canSwitchAudio={canSwitchAudio}
                    {...(audioNoticeText ? { audioNoticeText } : {})}
                    canSwitchSubtitles={canSwitchSubtitles}
                    completeFileQuality={completeFileQuality}
                    compact={compactLayout}
                    onSelectAutoQuality={onSelectAutoQuality}
                    onSelectQuality={onSelectQuality}
                    onSelectAudioStream={onSelectAudioStream}
                    onSelectSubtitleStream={onSelectSubtitleStream}
                    onSubtitleDelayChange={onSubtitleDelayChange}
                    onStartSubtitleEdit={onStartSubtitleEdit}
                  />
                ) : null}

                <Tooltip
                  content={t("player.settingsTitle")}
                  offset="2.5rem"
                  group="player-controls"
                >
                  <button
                    type="button"
                    onClick={onOpenSettings}
                    className="flex h-11 w-11 items-center justify-center rounded-full text-white/85 transition-[backdrop-filter] hover:bg-white/[0.12] hover:backdrop-blur-lg hover:duration-1000 duration-[500ms] hover:text-white focus:outline-none focus:ring-2 focus:ring-[var(--accent)]"
                    aria-label={t("player.settingsLabel")}
                  >
                    <Settings size={22} strokeWidth={2.2} />
                  </button>
                </Tooltip>
              </div>
              {canPictureInPicture && onTogglePictureInPicture ? (
                <Tooltip
                  content={t("player.pictureInPicture")}
                  offset="2.5rem"
                  group="player-controls"
                >
                  <button
                    type="button"
                    onClick={onTogglePictureInPicture}
                    className="flex h-11 w-11 items-center justify-center rounded-full text-white/85 transition-[backdrop-filter] hover:bg-white/[0.12] hover:backdrop-blur-lg hover:duration-1000 duration-[500ms] hover:text-white focus:outline-none focus:ring-2 focus:ring-[var(--accent)]"
                    aria-label={t("player.pictureInPicture")}
                    aria-pressed={isPictureInPicture}
                  >
                    <PictureInPicture2 size={22} strokeWidth={2.2} />
                  </button>
                </Tooltip>
              ) : null}
              <Tooltip
                content={t("player.fullscreen")}
                offset="2.5rem"
                shortcut="F"
                group="player-controls"
              >
                <button
                  type="button"
                  onClick={onToggleFullscreen}
                  className="flex h-11 w-11 items-center justify-center rounded-full text-white/85 transition-[backdrop-filter] hover:bg-white/[0.12] hover:backdrop-blur-lg hover:duration-1000 duration-[500ms] hover:text-white focus:outline-none focus:ring-2 focus:ring-[var(--accent)]"
                  aria-label={t("player.fullscreen")}
                >
                  <Maximize size={22} strokeWidth={2.2} />
                </button>
              </Tooltip>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
