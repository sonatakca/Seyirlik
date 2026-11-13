import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { Link } from "react-router-dom";
import {
  ChevronLeft,
  GalleryVerticalEnd,
  Loader2,
  Maximize,
  Minimize,
  PanelRight,
  Pause,
  PictureInPicture2,
  Play,
  RotateCcw,
  RotateCw,
  Settings,
  TvMinimalPlay,
} from "lucide-react";
import { useLanguage } from "../../../i18n/LanguageContext";
import { formatTemplate } from "../../../lib/format";
import { getPrimaryImageUrl } from "../../../lib/mediaApi";
import type { PlaybackQueue } from "../../../lib/playbackQueue";
import type {
  MediaItem,
  PlaybackSourceCandidate,
} from "../../../lib/types";
import { Tooltip } from "../../ui/Tooltip";
import { formatTime } from "../PlayerControls";
import {
  AUTOMATIC_QUALITY_MODES,
  getSelectableStreams,
} from "../settingsChoices";
import { SeekBar } from "../SeekBar";
import { streamLabels } from "../streamLabels";
import type { CompleteFileQualityControls } from "../types";
import { VolumeControl } from "../VolumeControl";
import { rectFor, type SahneLayout, type SahneMode } from "./sahneGeometry";
import "./sahne.css";

export interface SahneChromeProps {
  mode: SahneMode;
  layout: SahneLayout;
  lobbyOpen: boolean;
  onToggleLobby: () => void;
  /** The element on screen, for the room's light. */
  getVideo: () => HTMLVideoElement | null;

  backTo: string;
  title: string;
  titleLogoUrl?: string;
  episodeLabel?: string | null;
  episodeName?: string | null;
  topActions: ReactNode;

  isPlaying: boolean;
  playWaiting: boolean;
  currentTime: number;
  duration: number;
  bufferedEnd: number;
  volume: number;
  muted: boolean;
  itemId: string;
  mediaSourceId?: string;
  checkpointSeconds: number | null;
  previewAspectRatio?: number;
  seekPreviewLoading: boolean;
  onTogglePlay: () => void;
  onSeek: (seconds: number) => void;
  onSeekPreview?: (seconds: number) => void;
  onSeekPreviewCancel?: () => void;
  onSeekBy: (seconds: number) => void;
  onToggleMute: () => void;
  onVolumeChange: (volume: number) => void;
  canFullscreen: boolean;
  isFullscreen: boolean;
  onToggleFullscreen: () => void;
  canNativeFullscreen: boolean;
  onEnterNativeFullscreen?: () => void;
  canPictureInPicture: boolean;
  isPictureInPicture: boolean;
  onTogglePictureInPicture?: () => void;
  queueLabel: string;
  playbackQueue: PlaybackQueue | null;
  queueOpen: boolean;
  onOpenQueue: () => void;
  queuePanel: ReactNode;
  settingsOpen: boolean;
  onOpenSettings: () => void;
  settingsPanel: ReactNode;
  onControlsHoverStart: () => void;
  onControlsHoverEnd: () => void;

  facts: string[];
  overview: string | null;
  onPlayQueueItem?: (itemId: string) => void;
  source: PlaybackSourceCandidate;
  selectedAudioStreamIndex?: number;
  selectedSubtitleStreamIndex: number;
  canSwitchAudio: boolean;
  canSwitchSubtitles: boolean;
  completeFileQuality?: CompleteFileQualityControls;
  onSelectAudioStream: (streamIndex: number) => void;
  onSelectSubtitleStream: (streamIndex: number) => void;
}

const ICON = "flex h-11 w-11 shrink-0 items-center justify-center rounded-full";

function IconButton({
  label,
  onClick,
  pressed,
  tooltipShortcut,
  children,
}: {
  label: string;
  onClick?: () => void;
  pressed?: boolean;
  tooltipShortcut?: string;
  children: ReactNode;
}) {
  return (
    <Tooltip
      content={label}
      offset="2.5rem"
      shortcut={tooltipShortcut}
      group="player-controls"
    >
      <button
        type="button"
        onClick={onClick}
        aria-label={label}
        aria-pressed={pressed}
        className={`sahne-icon ${ICON}`}
      >
        {children}
      </button>
    </Tooltip>
  );
}

/**
 * The room's light: the picture's own colours, small and blurred, standing
 * behind it and fading to nothing well before its own edge.
 */
function SahneGlow({
  getVideo,
  active,
  style,
}: {
  getVideo: () => HTMLVideoElement | null;
  active: boolean;
  style: CSSProperties;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    if (!active) return undefined;
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return undefined;

    const draw = () => {
      if (document.visibilityState !== "visible") return;
      const video = getVideo();
      if (!video || video.readyState < 2) return;
      try {
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
      } catch {
        // A picture the canvas may not draw leaves the room unlit.
      }
    };
    draw();
    const timer = window.setInterval(draw, 125);
    return () => window.clearInterval(timer);
  }, [active, getVideo]);

  return (
    <canvas
      ref={canvasRef}
      width={48}
      height={20}
      aria-hidden="true"
      className="sahne-glow"
      style={style}
    />
  );
}

function Chip({
  active,
  onClick,
  disabled,
  children,
}: {
  active: boolean;
  onClick?: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={active}
      disabled={disabled || !onClick}
      onClick={onClick}
      className={`sahne-chip${active ? " sahne-chip--on" : ""}`}
    >
      {children}
    </button>
  );
}

function queueWindow(queue: PlaybackQueue): MediaItem[] {
  const season = queue.seasons?.find(
    (candidate) => candidate.id === queue.currentSeasonId,
  );
  const items = season?.episodes ?? queue.items;
  const index = Math.max(
    0,
    items.findIndex((item) => item.Id === queue.currentItemId),
  );
  const start = Math.max(0, Math.min(index, items.length - 4));
  return items.slice(start, start + 4);
}

function queueRowMeta(item: MediaItem, language: string): string {
  if (
    typeof item.ParentIndexNumber === "number" &&
    typeof item.IndexNumber === "number"
  ) {
    return `S${item.ParentIndexNumber} · ${language === "tr" ? "B" : "E"}${item.IndexNumber}`;
  }
  return item.ProductionYear ? String(item.ProductionYear) : "";
}

export function SahneChrome(props: SahneChromeProps) {
  const {
    mode,
    layout,
    lobbyOpen,
    onToggleLobby,
    getVideo,
    backTo,
    title,
    titleLogoUrl,
    episodeLabel,
    episodeName,
    topActions,
    isPlaying,
    playWaiting,
    currentTime,
    duration,
    volume,
    muted,
    onTogglePlay,
    onSeekBy,
    onToggleMute,
    onVolumeChange,
    onControlsHoverStart,
    onControlsHoverEnd,
  } = props;
  const { t, language } = useLanguage();
  const [showRemaining, setShowRemaining] = useState(false);
  const [isVolumeOpen, setIsVolumeOpen] = useState(false);
  const [isAdvancedOpen, setIsAdvancedOpen] = useState(false);
  // The clock the end time is read from, refreshed while the room shows.
  const [now, setNow] = useState(() => Date.now());

  const shown = mode !== "full";
  useEffect(() => {
    if (!shown) return undefined;
    const tick = () => setNow(Date.now());
    tick();
    const timer = window.setInterval(tick, 15_000);
    return () => window.clearInterval(timer);
  }, [shown]);
  // The room's furniture keeps its place while the picture is full, so it
  // fades where it stands instead of travelling with the picture.
  const ui = rectFor(layout, lobbyOpen ? "lobby" : "controls");
  const target = rectFor(layout, mode);
  const lobby = layout.lobby;

  const remaining = Math.max(duration - currentTime, 0);
  const endsAt = new Date(now + remaining * 1000);
  const endsLabel = formatTemplate(t("player.endsAt"), {
    time: endsAt.toLocaleTimeString(language, {
      hour: "2-digit",
      minute: "2-digit",
    }),
  });
  const minutesLeft = formatTemplate(t("player.minutesLeft"), {
    minutes: Math.max(1, Math.ceil(remaining / 60)),
  });

  const rootStyle = {
    "--sahne-ux": `${ui.x}px`,
    "--sahne-uy": `${ui.y}px`,
    "--sahne-uw": `${ui.w}px`,
    "--sahne-uh": `${ui.h}px`,
    "--sahne-lx": `${lobby.x}px`,
    "--sahne-ly": `${lobby.y}px`,
    "--sahne-lw": `${lobby.w}px`,
    "--sahne-lh": `${lobby.h}px`,
    "--sahne-g": `${layout.gutter}px`,
  } as CSSProperties;
  const glowStyle: CSSProperties = {
    transform: `translate(${target.x - target.w * 0.24}px, ${
      target.y - target.h * 0.55
    }px) scale(${(target.w * 1.48) / 48}, ${(target.h * 2.1) / 20})`,
  };

  const audioStreams = getSelectableStreams(props.source, "Audio");
  const subtitleStreams = getSelectableStreams(props.source, "Subtitle");
  const audioLabels = streamLabels(audioStreams, "audio", language, t);
  const subtitleLabels = streamLabels(subtitleStreams, "subtitle", language, t);
  const quality = props.completeFileQuality;
  const showAdvanced =
    quality !== undefined &&
    (isAdvancedOpen || quality.activeMode === "advanced");
  const queueItems = props.playbackQueue
    ? queueWindow(props.playbackQueue)
    : [];

  return (
    <div
      className="sahne"
      data-sahne-mode={mode}
      data-sahne-lobby={lobbyOpen ? "" : undefined}
      style={rootStyle}
    >
      <SahneGlow getVideo={getVideo} active={shown} style={glowStyle} />

      <header
        className="sahne-ui sahne-top"
        data-sahne-shown={shown ? "" : undefined}
        onPointerEnter={onControlsHoverStart}
        onPointerLeave={onControlsHoverEnd}
      >
        <Tooltip content={t("player.backToDetails")} offset="1rem">
          <Link
            to={backTo}
            replace
            aria-label={t("player.backToDetails")}
            className={`sahne-icon -ml-2.5 ${ICON}`}
          >
            <ChevronLeft size={22} strokeWidth={2.2} />
          </Link>
        </Tooltip>
        <div className="sahne-where">
          {titleLogoUrl ? (
            <img src={titleLogoUrl} alt={title} className="sahne-top-logo" />
          ) : (
            <p className="sahne-top-title">{title}</p>
          )}
          {episodeLabel || episodeName ? (
            <p className="sahne-top-episode">
              {episodeLabel ? (
                <span className="sahne-caps">{episodeLabel}</span>
              ) : null}
              {episodeName ? <b>{episodeName}</b> : null}
            </p>
          ) : null}
        </div>
        <div className="sahne-top-actions">{topActions}</div>
      </header>

      <section
        className="sahne-ui sahne-deck"
        data-sahne-shown={shown ? "" : undefined}
        onPointerEnter={onControlsHoverStart}
        onPointerLeave={(event) => {
          onControlsHoverEnd();
          if (event.pointerType !== "touch") setIsVolumeOpen(false);
        }}
      >
        <div className="relative">
          <SeekBar
            currentTime={currentTime}
            duration={duration}
            bufferedEnd={props.bufferedEnd}
            itemId={props.itemId}
            mediaSourceId={props.mediaSourceId}
            checkpointSeconds={props.checkpointSeconds}
            previewAspectRatio={props.previewAspectRatio}
            onSeek={props.onSeek}
            onSeekPreview={props.onSeekPreview}
            onSeekPreviewCancel={props.onSeekPreviewCancel}
          />
        </div>
        <div className="sahne-row">
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
              aria-label={
                playWaiting
                  ? t("player.waitingForSyncPlay")
                  : isPlaying
                    ? t("common.pause")
                    : t("common.play")
              }
              className="sahne-play"
            >
              {playWaiting ? (
                <Loader2 size={24} className="animate-spin" strokeWidth={2.4} />
              ) : isPlaying ? (
                <Pause size={24} fill="currentColor" strokeWidth={2.2} />
              ) : (
                <Play
                  size={24}
                  className="ml-0.5"
                  fill="currentColor"
                  strokeWidth={2.2}
                />
              )}
            </button>
          </Tooltip>
          <IconButton
            label={t("player.rewind5")}
            tooltipShortcut="←"
            onClick={() => onSeekBy(-5)}
          >
            <RotateCcw size={21} />
          </IconButton>
          <IconButton
            label={t("player.forward5")}
            tooltipShortcut="→"
            onClick={() => onSeekBy(5)}
          >
            <RotateCw size={21} />
          </IconButton>
          <VolumeControl
            volume={volume}
            muted={muted}
            isExpanded={isVolumeOpen}
            onToggleMute={onToggleMute}
            onVolumeChange={onVolumeChange}
            onRequestExpand={() => setIsVolumeOpen(true)}
          />
          <Tooltip
            content={
              showRemaining
                ? t("player.showElapsedTime")
                : t("player.showRemainingTime")
            }
            offset="2.8rem"
            group="player-controls"
          >
            <button
              type="button"
              className="sahne-clock"
              onClick={() => setShowRemaining((value) => !value)}
              aria-label={
                showRemaining
                  ? t("player.showElapsedTime")
                  : t("player.showRemainingTime")
              }
            >
              <b>
                {showRemaining
                  ? `-${formatTime(remaining)}`
                  : formatTime(currentTime)}
              </b>
              <span> / {formatTime(duration)}</span>
            </button>
          </Tooltip>
          {duration > 0 ? (
            <span className="sahne-ends">{endsLabel}</span>
          ) : null}
          {props.seekPreviewLoading ? (
            <Loader2
              aria-label={t("player.seeking")}
              className="ml-2 h-4 w-4 animate-spin text-[var(--accent)]"
            />
          ) : null}

          <div className="sahne-row-end">
            <button
              type="button"
              onClick={onToggleLobby}
              aria-pressed={lobbyOpen}
              className={`sahne-pill${lobbyOpen ? " sahne-pill--on" : ""}`}
            >
              <PanelRight size={18} strokeWidth={2.2} />
              {t("player.lobby")}
            </button>
            {props.playbackQueue ? (
              <div className="relative" data-player-queue-root>
                {props.queueOpen ? props.queuePanel : null}
                <IconButton
                  label={props.queueLabel}
                  pressed={props.queueOpen}
                  onClick={props.onOpenQueue}
                >
                  <GalleryVerticalEnd size={22} strokeWidth={2.2} />
                </IconButton>
              </div>
            ) : null}
            <div className="relative" data-player-settings-root>
              {props.settingsOpen ? props.settingsPanel : null}
              <IconButton
                label={t("player.settingsLabel")}
                pressed={props.settingsOpen}
                onClick={props.onOpenSettings}
              >
                <Settings size={22} strokeWidth={2.2} />
              </IconButton>
            </div>
            {props.canPictureInPicture && props.onTogglePictureInPicture ? (
              <IconButton
                label={t("player.pictureInPicture")}
                pressed={props.isPictureInPicture}
                onClick={props.onTogglePictureInPicture}
              >
                <PictureInPicture2 size={22} strokeWidth={2.2} />
              </IconButton>
            ) : null}
            {props.canNativeFullscreen && props.onEnterNativeFullscreen ? (
              <IconButton
                label={t("player.nativeFullscreen")}
                onClick={props.onEnterNativeFullscreen}
              >
                <TvMinimalPlay size={22} strokeWidth={2.2} />
              </IconButton>
            ) : null}
            {props.canFullscreen ? (
              <IconButton
                label={t(
                  props.isFullscreen
                    ? "player.exitFullscreen"
                    : "player.fullscreen",
                )}
                pressed={props.isFullscreen}
                tooltipShortcut="F"
                onClick={props.onToggleFullscreen}
              >
                {props.isFullscreen ? (
                  <Minimize size={22} strokeWidth={2.2} />
                ) : (
                  <Maximize size={22} strokeWidth={2.2} />
                )}
              </IconButton>
            ) : null}
          </div>
        </div>
      </section>

      <aside
        className="sahne-lobby sahne-info"
        data-sahne-lobby-content
        data-sahne-shown={mode === "lobby" ? "" : undefined}
        aria-hidden={mode !== "lobby"}
      >
        {titleLogoUrl ? (
          <img src={titleLogoUrl} alt="" className="sahne-info-logo" />
        ) : (
          <h2 className="sahne-info-title">{title}</h2>
        )}
        {props.facts.length > 0 ? (
          <p className="sahne-facts">
            {props.facts.map((fact) => (
              <span key={fact}>{fact}</span>
            ))}
          </p>
        ) : null}
        <div className="sahne-now">
          <span className="sahne-caps">
            {[episodeLabel, duration > 0 ? minutesLeft : null]
              .filter(Boolean)
              .join(" · ")}
          </span>
          {episodeName ? <h1>{episodeName}</h1> : null}
        </div>
        {props.overview ? (
          <p className="sahne-overview">{props.overview}</p>
        ) : null}
        {queueItems.length > 1 ? (
          <div className="sahne-queue">
            <span className="sahne-caps">{props.queueLabel}</span>
            <div className="sahne-queue-list">
              {queueItems.map((queueItem) => {
                const isCurrent =
                  queueItem.Id === props.playbackQueue?.currentItemId;
                const thumb = queueItem.ImageTags?.Primary
                  ? getPrimaryImageUrl(
                      queueItem.Id,
                      queueItem.ImageTags.Primary,
                      400,
                    )
                  : "";
                return (
                  <button
                    key={queueItem.Id}
                    type="button"
                    disabled={isCurrent || !props.onPlayQueueItem}
                    onClick={() => props.onPlayQueueItem?.(queueItem.Id)}
                    className={`sahne-q${isCurrent ? " sahne-q--now" : ""}`}
                  >
                    <span className="sahne-q-art">
                      {thumb ? <img src={thumb} alt="" loading="lazy" /> : null}
                    </span>
                    <span className="sahne-q-title">{queueItem.Name}</span>
                    <span className="sahne-q-meta">
                      {isCurrent
                        ? t("player.nowPlaying")
                        : queueRowMeta(queueItem, language)}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        ) : null}
      </aside>

      <section
        className="sahne-lobby sahne-prefs"
        data-sahne-lobby-content
        data-sahne-shown={mode === "lobby" ? "" : undefined}
        aria-hidden={mode !== "lobby"}
      >
        {audioStreams.length > 1 ? (
          <div className="sahne-pref" role="group" aria-label={t("settings.audio")}>
            <span className="sahne-caps">{t("settings.audio")}</span>
            <div className="sahne-chips">
              {audioStreams.map((stream, index) => (
                <Chip
                  key={`${stream.Index ?? index}-audio`}
                  active={stream.Index === props.selectedAudioStreamIndex}
                  onClick={
                    stream.Index === undefined || !props.canSwitchAudio
                      ? undefined
                      : () => props.onSelectAudioStream(stream.Index as number)
                  }
                >
                  {audioLabels[index]}
                </Chip>
              ))}
            </div>
          </div>
        ) : null}
        {subtitleStreams.length > 0 ? (
          <div
            className="sahne-pref"
            role="group"
            aria-label={t("settings.subtitles")}
          >
            <span className="sahne-caps">{t("settings.subtitles")}</span>
            <div className="sahne-chips">
              <Chip
                active={props.selectedSubtitleStreamIndex === -1}
                onClick={
                  props.canSwitchSubtitles
                    ? () => props.onSelectSubtitleStream(-1)
                    : undefined
                }
              >
                {t("settings.off")}
              </Chip>
              {subtitleStreams.map((stream, index) => (
                <Chip
                  key={`${stream.Index ?? index}-subtitle`}
                  active={stream.Index === props.selectedSubtitleStreamIndex}
                  onClick={
                    stream.Index === undefined || !props.canSwitchSubtitles
                      ? undefined
                      : () =>
                          props.onSelectSubtitleStream(stream.Index as number)
                  }
                >
                  {subtitleLabels[index]}
                </Chip>
              ))}
            </div>
          </div>
        ) : null}
        {quality ? (
          <div
            className="sahne-pref"
            role="group"
            aria-label={t("settings.quality")}
          >
            <span className="sahne-caps">{t("settings.quality")}</span>
            <div className="sahne-chips">
              {AUTOMATIC_QUALITY_MODES.map(({ mode: qualityMode, labelKey }) => {
                const effective = quality.modeQualityLabels[qualityMode];
                return (
                  <Chip
                    key={qualityMode}
                    active={quality.activeMode === qualityMode}
                    onClick={() => {
                      setIsAdvancedOpen(false);
                      quality.onSelectMode(qualityMode);
                    }}
                  >
                    {qualityMode === "auto" && effective
                      ? formatTemplate(t("player.qualityAutoEffective"), {
                          quality: effective,
                        })
                      : t(labelKey)}
                  </Chip>
                );
              })}
              {quality.advancedOptions.length > 0 ? (
                <Chip
                  active={quality.activeMode === "advanced"}
                  onClick={() => setIsAdvancedOpen((open) => !open)}
                >
                  {t("player.qualityAdvanced")}
                </Chip>
              ) : null}
            </div>
            {showAdvanced ? (
              <div className="sahne-chips sahne-chips--sub">
                {quality.advancedOptions.map((option) => (
                  <Chip
                    key={option.id}
                    active={
                      quality.activeMode === "advanced" &&
                      quality.lockedQualityId === option.id
                    }
                    onClick={() => quality.onSelectAdvancedQuality(option.id)}
                  >
                    {quality.preparingQualityId === option.id
                      ? `${option.label} · ${t("player.qualityPreparing")}`
                      : option.label}
                  </Chip>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
        <div className="sahne-pref">
          <span className="sahne-caps" aria-hidden="true">
            &nbsp;
          </span>
          <div className="sahne-chips">
            <button
              type="button"
              className="sahne-chip"
              data-player-settings-root
              onClick={props.onOpenSettings}
            >
              <Settings size={15} strokeWidth={2.2} />
              {t("player.allSettings")}
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
