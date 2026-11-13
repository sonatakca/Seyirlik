import {
  useEffect,
  useLayoutEffect,
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
import type { Language } from "../../../i18n/translations";
import { getEpisodeDisplayMetadata } from "../../../lib/episodeMetadataPreferences";
import { formatTemplate } from "../../../lib/format";
import {
  getBackdropImageUrl,
  getPrimaryImageUrl,
  getThumbImageUrl,
} from "../../../lib/mediaApi";
import type { PlaybackQueue } from "../../../lib/playbackQueue";
import type { MediaItem } from "../../../lib/types";
import { Tooltip } from "../../ui/Tooltip";
import { formatTime } from "../PlayerControls";
import { SeekBar } from "../SeekBar";
import { VolumeControl } from "../VolumeControl";
import { rectFor, type SahneLayout, type SahneMode } from "./sahneGeometry";
import "./sahne.css";

export interface SahneChromeProps {
  mode: SahneMode;
  layout: SahneLayout;
  lobbyOpen: boolean;
  onToggleLobby: () => void;

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

/** What the lobby's row holds: the season being watched, or the collection. */
function stripItems(queue: PlaybackQueue): MediaItem[] {
  const season = queue.seasons?.find(
    (candidate) => candidate.id === queue.currentSeasonId,
  );
  return season?.episodes ?? queue.items;
}

/**
 * A 16:9 still for a row card. An episode's still is stored as its thumb (it
 * never has a cover); a film in a collection uses its thumb or backdrop, and
 * only then its poster.
 */
function stillFor(item: MediaItem, language: Language): string {
  if (item.Type === "Episode") {
    const chosen = getEpisodeDisplayMetadata(item, language).thumbnailUrl;
    if (chosen) return chosen;
  }
  if (item.ImageTags?.Thumb) {
    return getThumbImageUrl(item.Id, item.ImageTags.Thumb, 480);
  }
  const backdrop = item.BackdropImageTags?.[0];
  if (backdrop) return getBackdropImageUrl(item.Id, backdrop, 480);
  if (item.ImageTags?.Primary) {
    return getPrimaryImageUrl(item.Id, item.ImageTags.Primary, 480);
  }
  if (item.SeriesId && item.SeriesPrimaryImageTag) {
    return getPrimaryImageUrl(item.SeriesId, item.SeriesPrimaryImageTag, 480);
  }
  return "";
}

function stripTitle(item: MediaItem, language: Language): string {
  return item.Type === "Episode"
    ? (getEpisodeDisplayMetadata(item, language).title ?? item.Name)
    : item.Name;
}

function stripNumber(item: MediaItem, language: string): string {
  if (item.Type === "Episode" && typeof item.IndexNumber === "number") {
    return language === "tr"
      ? `${item.IndexNumber}. Bölüm`
      : `Episode ${item.IndexNumber}`;
  }
  return item.ProductionYear ? String(item.ProductionYear) : "";
}

export function SahneChrome(props: SahneChromeProps) {
  const {
    mode,
    layout,
    lobbyOpen,
    onToggleLobby,
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
  const stripRef = useRef<HTMLDivElement | null>(null);
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
  const items = props.playbackQueue ? stripItems(props.playbackQueue) : [];
  const currentId = props.playbackQueue?.currentItemId;
  const isLobby = mode === "lobby";

  // Opening the lobby brings the playing episode into view in the row.
  useLayoutEffect(() => {
    if (!isLobby) return;
    const strip = stripRef.current;
    const current = strip?.querySelector<HTMLElement>("[data-strip-current]");
    if (!strip || !current) return;
    strip.scrollLeft = Math.max(0, current.offsetLeft - strip.clientWidth * 0.25);
  }, [isLobby, currentId]);

  return (
    <div
      className="sahne"
      data-sahne-mode={mode}
      data-sahne-lobby={lobbyOpen ? "" : undefined}
      style={rootStyle}
    >
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
      </aside>

      {items.length > 1 ? (
        <section
          className="sahne-lobby sahne-strip"
          data-sahne-lobby-content
          data-sahne-shown={isLobby ? "" : undefined}
          aria-hidden={!isLobby}
          aria-label={props.queueLabel}
        >
          <span className="sahne-caps">{props.queueLabel}</span>
          <div className="sahne-strip-row" ref={stripRef}>
            {items.map((stripItem) => {
              const isCurrent = stripItem.Id === currentId;
              const still = stillFor(stripItem, language);
              return (
                <button
                  key={stripItem.Id}
                  type="button"
                  tabIndex={isLobby ? 0 : -1}
                  data-strip-current={isCurrent ? "" : undefined}
                  disabled={isCurrent || !props.onPlayQueueItem}
                  onClick={() => props.onPlayQueueItem?.(stripItem.Id)}
                  className={`sahne-card${isCurrent ? " sahne-card--now" : ""}`}
                >
                  <span className="sahne-card-still">
                    {still ? <img src={still} alt="" loading="lazy" /> : null}
                  </span>
                  <span className="sahne-card-meta">
                    {isCurrent
                      ? t("player.nowPlaying")
                      : stripNumber(stripItem, language)}
                  </span>
                  <span className="sahne-card-title">
                    {stripTitle(stripItem, language)}
                  </span>
                </button>
              );
            })}
          </div>
        </section>
      ) : null}
    </div>
  );
}
