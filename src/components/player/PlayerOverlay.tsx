import { useEffect, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { move, REST } from "../../lib/compositorMotion";
import {
  ChevronLeft,
  LoaderCircle,
  Pause,
  Play,
  RotateCcw,
  RotateCw,
} from "lucide-react";
import { Link } from "react-router-dom";
import { useLanguage } from "../../i18n/LanguageContext";
import { LoadingRing } from "../LoadingRing";
import { Tooltip } from "../ui/Tooltip";

interface SeekFeedbackItem {
  amount: number;
  visible: boolean;
  pulse: number;
  spinPulse: number;
}

interface PlayerOverlayProps {
  title: string;
  titleLogoUrl?: string;
  episodeLabel?: string | null;
  episodeName?: string | null;
  subtitle?: string | null;
  backTo: string;
  visible: boolean;
  isPlaying: boolean;
  isPlayPausePending?: boolean;
  isPlayPauseLoading?: boolean;
  notice?: string | null;
  topRightControls?: ReactNode;
  onTogglePlay: () => void;
  onControlsHoverStart?: () => void;
  onControlsHoverEnd?: () => void;
  seekFeedback?: {
    backward: SeekFeedbackItem;
    forward: SeekFeedbackItem;
  };
}

const PLAY_PAUSE_ICON_SWAP_DURATION_MS = 111;
const SEEK_FEEDBACK_SPIN_MS = 1000;
const SEEK_FEEDBACK_NUMBER_SWAP_MS = 600;
const SEEK_FEEDBACK_SPIN_EASE = [0.16, 1, 0.3, 1] as const;
const SEEK_FEEDBACK_NUMBER_EASE = [0.22, 1, 0.36, 1] as const;
const CENTER_STATE_EASE = [0.16, 1, 0.3, 1] as const;

function isSubtitleMetadataPart(part: string): boolean {
  const normalized = part.trim().toLowerCase().replace(/\s+/g, "");

  if (!normalized) {
    return true;
  }

  if (/^\d{4}$/.test(normalized)) {
    return true;
  }

  return /^(?=.*\d)(?:\d+(?:h|hr|hrs|hour|hours|sa|saat))?(?:\d+(?:m|min|mins|minute|minutes|dk|dakika))?$/.test(
    normalized,
  );
}

function getCleanSubtitleLine(subtitle?: string | null): string | null {
  if (!subtitle) {
    return null;
  }

  const parts = subtitle
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean);

  const meaningfulParts = parts.filter((part) => !isSubtitleMetadataPart(part));
  const cleanSubtitle = meaningfulParts.join(" / ");

  return cleanSubtitle || null;
}

export function PlayerOverlay({
  title,
  titleLogoUrl,
  episodeLabel,
  episodeName,
  subtitle,
  backTo,
  visible,
  isPlaying,
  isPlayPausePending = false,
  isPlayPauseLoading = false,
  notice,
  topRightControls,
  onTogglePlay,
  onControlsHoverStart,
  onControlsHoverEnd,
  seekFeedback,
}: PlayerOverlayProps) {
  const { t } = useLanguage();
  const shouldReduceMotion = useReducedMotion();
  const displaySubtitle = episodeName?.trim() || getCleanSubtitleLine(subtitle);

  const wasPlayPausePendingRef = useRef(isPlayPausePending);
  const waveTimeoutRef = useRef<number | null>(null);
  const iconSwapTimeoutRef = useRef<number | null>(null);
  const [showPlayPauseWave, setShowPlayPauseWave] = useState(false);
  const [displayedIsPlaying, setDisplayedIsPlaying] = useState(isPlaying);
  const [isIconScaledOut, setIsIconScaledOut] = useState(false);

  useEffect(() => {
    const wasPending = wasPlayPausePendingRef.current;

    if (wasPending && !isPlayPausePending) {
      setShowPlayPauseWave(true);

      if (waveTimeoutRef.current !== null) {
        window.clearTimeout(waveTimeoutRef.current);
      }

      waveTimeoutRef.current = window.setTimeout(() => {
        setShowPlayPauseWave(false);
        waveTimeoutRef.current = null;
      }, 520);
    }

    wasPlayPausePendingRef.current = isPlayPausePending;
  }, [isPlayPausePending]);

  useEffect(() => {
    return () => {
      if (waveTimeoutRef.current !== null) {
        window.clearTimeout(waveTimeoutRef.current);
      }

      if (iconSwapTimeoutRef.current !== null) {
        window.clearTimeout(iconSwapTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (displayedIsPlaying === isPlaying && !isIconScaledOut) {
      return;
    }

    if (iconSwapTimeoutRef.current !== null) {
      window.clearTimeout(iconSwapTimeoutRef.current);
      iconSwapTimeoutRef.current = null;
    }

    if (displayedIsPlaying === isPlaying) {
      setIsIconScaledOut(false);
      return;
    }

    setIsIconScaledOut(true);

    iconSwapTimeoutRef.current = window.setTimeout(() => {
      setDisplayedIsPlaying(isPlaying);
      setIsIconScaledOut(false);
      iconSwapTimeoutRef.current = null;
    }, PLAY_PAUSE_ICON_SWAP_DURATION_MS);
  }, [displayedIsPlaying, isIconScaledOut, isPlaying]);

  const backwardFeedback = seekFeedback?.backward;
  const forwardFeedback = seekFeedback?.forward;

  return (
    <>
      <div
        className={`seyirlik-player-chrome seyirlik-player-top-chrome pointer-events-none absolute inset-x-0 top-0 z-30 px-[max(0.65rem,env(safe-area-inset-left))] pb-8 pt-[max(0.55rem,env(safe-area-inset-top))] sm:px-[max(1rem,env(safe-area-inset-left))] sm:pb-16 sm:pt-[max(1rem,env(safe-area-inset-top))] ${
          visible
            ? "seyirlik-player-chrome--visible"
            : "seyirlik-player-chrome--hidden"
        }`}
      >
        <div
          // A portrait phone has no room for the title beside the controls,
          // so the title takes a line of its own under them.
          className="seyirlik-player-top-bar pointer-events-auto mx-auto flex w-[99%] flex-wrap items-center justify-between gap-x-4 gap-y-1 sm:flex-nowrap"
          onMouseEnter={onControlsHoverStart}
          onMouseLeave={onControlsHoverEnd}
          onPointerEnter={onControlsHoverStart}
          onPointerLeave={onControlsHoverEnd}
        >
          <Tooltip content={t("player.backToDetails")} offset="1rem">
            <Link
              to={backTo}
              replace
              className="seyirlik-player-back-button group flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-white transition-[background-color,backdrop-filter] duration-500 hover:bg-white/[0.12] hover:backdrop-blur-lg hover:duration-1000 focus:outline-none focus:ring-2 focus:ring-[var(--accent)]"
              aria-label={t("player.backToDetails")}
            >
              <ChevronLeft
                size={22}
                strokeWidth={2.2}
                className="transition-transform duration-300 group-hover:-translate-x-[0rem]"
              />
            </Link>
          </Tooltip>

          <div className="order-last flex min-w-0 basis-full items-center gap-4 pl-2.5 sm:order-none sm:flex-1 sm:basis-auto sm:gap-6 sm:pl-0">
            <div className="min-w-0 shrink-0">
              {titleLogoUrl ? (
                <img
                  src={titleLogoUrl}
                  alt={title}
                  className="max-h-10 max-w-[min(16rem,60vw)] object-contain object-left drop-shadow-[0_10px_28px_rgba(0,0,0,0.85)] sm:max-h-12 sm:max-w-[min(18rem,40vw)]"
                />
              ) : (
                <p className="max-w-[min(16rem,60vw)] truncate text-base font-bold text-white sm:max-w-[min(18rem,40vw)] sm:text-lg">
                  {title}
                </p>
              )}
            </div>

            {episodeLabel || displaySubtitle ? (
              <div className="min-w-0 leading-tight drop-shadow-[0_2px_8px_rgba(0,0,0,0.95)]">
                {episodeLabel ? (
                  <p className="truncate text-base font-medium text-white/[0.78]">
                    {episodeLabel}
                  </p>
                ) : null}

                {displaySubtitle ? (
                  <p className="mt-1 truncate text-sm text-white/[0.68]">
                    {displaySubtitle}
                  </p>
                ) : null}
              </div>
            ) : null}
          </div>

          {topRightControls ? (
            <div className="ml-auto flex shrink-0 items-center justify-end">
              {topRightControls}
            </div>
          ) : null}
        </div>
      </div>

      {notice ? (
        <div className="seyirlik-player-notice pointer-events-none absolute left-1/2 top-28 z-40 sm:top-24 w-[min(34rem,calc(100vw-2rem))] -translate-x-1/2 rounded-lg border border-[var(--accent)]/30 bg-black/[0.78] px-4 py-3 text-center text-sm font-semibold text-white shadow-[0_18px_80px_rgba(0,0,0,0.55)] backdrop-blur-xl">
          {notice}
        </div>
      ) : null}

      {backwardFeedback ? (
        <div
          className={`seyirlik-seek-feedback seyirlik-seek-feedback--backward ${
            backwardFeedback.visible ? "seyirlik-seek-feedback--visible" : ""
          }`}
          aria-hidden="true"
        >
          <div className="seyirlik-seek-feedback__bubble">
            <span className="seyirlik-seek-feedback__icon">
              <motion.span
                key={backwardFeedback.spinPulse}
                className="flex"
                initial={{ transform: "rotate(0deg)" }}
                animate={{
                  transform:
                    backwardFeedback.spinPulse > 0
                      ? "rotate(-360deg)"
                      : "rotate(0deg)",
                }}
                transition={{
                  duration: SEEK_FEEDBACK_SPIN_MS / 1000,
                  ease: SEEK_FEEDBACK_SPIN_EASE,
                }}
              >
                <RotateCcw size={60} strokeWidth={1.5} />
              </motion.span>
            </span>
            <span className="seyirlik-seek-feedback__number relative inline-flex min-h-[1em] min-w-[1.65em] items-center justify-center leading-none">
              <AnimatePresence initial={false}>
                <motion.span
                  key={backwardFeedback.amount}
                  className="absolute inset-0 flex origin-center items-center justify-center leading-none"
                  initial={{ transform: "scale(0)" }}
                  animate={{ transform: "scale(1)" }}
                  exit={{ transform: ["scale(1)", "scale(0)"] }}
                  transition={{
                    duration: SEEK_FEEDBACK_NUMBER_SWAP_MS / 1000,
                    ease: SEEK_FEEDBACK_NUMBER_EASE,
                  }}
                >
                  {backwardFeedback.amount}
                </motion.span>
              </AnimatePresence>
            </span>
          </div>
        </div>
      ) : null}

      {forwardFeedback ? (
        <div
          className={`seyirlik-seek-feedback seyirlik-seek-feedback--forward ${
            forwardFeedback.visible ? "seyirlik-seek-feedback--visible" : ""
          }`}
          aria-hidden="true"
        >
          <div className="seyirlik-seek-feedback__bubble">
            <span className="seyirlik-seek-feedback__icon">
              <motion.span
                key={forwardFeedback.spinPulse}
                className="flex"
                initial={{ transform: "rotate(0deg)" }}
                animate={{
                  transform:
                    forwardFeedback.spinPulse > 0
                      ? "rotate(360deg)"
                      : "rotate(0deg)",
                }}
                transition={{
                  duration: SEEK_FEEDBACK_SPIN_MS / 1000,
                  ease: SEEK_FEEDBACK_SPIN_EASE,
                }}
              >
                <RotateCw size={60} strokeWidth={1.5} />
              </motion.span>
            </span>
            <span className="seyirlik-seek-feedback__number relative inline-flex min-h-[1em] min-w-[1.65em] items-center justify-center leading-none">
              <AnimatePresence initial={false}>
                <motion.span
                  key={forwardFeedback.amount}
                  className="absolute inset-0 flex origin-center items-center justify-center leading-none"
                  initial={{ transform: "scale(0)" }}
                  animate={{ transform: "scale(1)" }}
                  exit={{ transform: ["scale(1)", "scale(0)"] }}
                  transition={{
                    duration: SEEK_FEEDBACK_NUMBER_SWAP_MS / 1000,
                    ease: SEEK_FEEDBACK_NUMBER_EASE,
                  }}
                >
                  {forwardFeedback.amount}
                </motion.span>
              </AnimatePresence>
            </span>
          </div>
        </div>
      ) : null}

      <button
        type="button"
        onClick={onTogglePlay}
        onMouseEnter={onControlsHoverStart}
        onMouseLeave={onControlsHoverEnd}
        onPointerEnter={onControlsHoverStart}
        onPointerLeave={onControlsHoverEnd}
        className={`seyirlik-player-center-toggle absolute left-1/2 top-1/2 z-20 flex shrink-0 -translate-x-1/2 -translate-y-1/2 cursor-pointer items-center justify-center bg-transparent text-white shadow-none focus:outline-none focus:ring-0 focus:ring-[var(--accent)] ${
          isPlayPauseLoading
            ? "h-28 w-28 sm:h-36 sm:w-36"
            : "h-16 w-16 hover:scale-110 sm:h-20 sm:w-20"
        } ${
          visible || !isPlaying || isPlayPausePending || isPlayPauseLoading
            ? "seyirlik-player-center-toggle--visible scale-100 opacity-100"
            : "seyirlik-player-center-toggle--hidden pointer-events-none scale-0 opacity-0"
        }`}
        aria-label={
          isPlayPauseLoading
            ? t("common.loading")
            : isPlaying
              ? t("common.pause")
              : t("common.play")
        }
      >
        <AnimatePresence initial={false}>
          {isPlayPauseLoading ? (
            <motion.span
              key="loading"
              data-testid="player-loading-state"
              className="pointer-events-none absolute flex items-center justify-center"
              initial={{
                opacity: 0,
                transform: move({ scale: shouldReduceMotion ? 1 : 0.94 }),
              }}
              animate={{ opacity: 1, transform: REST }}
              exit={{
                opacity: 0,
                transform: [
                  REST,
                  move({ scale: shouldReduceMotion ? 1 : 0.96 }),
                ],
              }}
              transition={{
                duration: shouldReduceMotion ? 0.12 : 0.22,
                ease: CENTER_STATE_EASE,
              }}
            >
              <LoadingRing size={80} stroke={2.5} />
            </motion.span>
          ) : (
            <motion.span
              key="play-pause"
              data-testid="player-play-pause-state"
              className="absolute flex h-16 w-16 items-center justify-center rounded-full bg-white/[0.15] backdrop-blur-2xl sm:h-20 sm:w-20"
              initial={{
                opacity: 0,
                transform: move({ scale: shouldReduceMotion ? 1 : 0.94 }),
              }}
              animate={{ opacity: 1, transform: REST }}
              exit={{
                opacity: 0,
                transform: [
                  REST,
                  move({ scale: shouldReduceMotion ? 1 : 0.96 }),
                ],
              }}
              transition={{
                duration: shouldReduceMotion ? 0.12 : 0.18,
                ease: CENTER_STATE_EASE,
              }}
            >
              <span className="relative flex items-center justify-center">
                {showPlayPauseWave ? (
                  <span className="seyirlik-play-pause-wave" />
                ) : null}

                {isPlayPausePending ? (
                  <LoaderCircle
                    aria-hidden="true"
                    className="pointer-events-none absolute h-14 w-14 animate-[spin_1.2s_linear_infinite] text-[var(--accent)] opacity-90 [filter:drop-shadow(0_0_10px_rgba(255,153,31,0.28))] sm:h-[6.5rem] sm:w-[6.5rem]"
                    strokeWidth={1.4}
                  />
                ) : null}

                <span
                  className={`flex items-center justify-center transition-transform ease-out ${
                    isIconScaledOut ? "scale-0" : "scale-100"
                  }`}
                  style={{
                    transitionDuration: `${PLAY_PAUSE_ICON_SWAP_DURATION_MS}ms`,
                  }}
                >
                  {displayedIsPlaying ? (
                    <Pause
                      className="h-7 w-7 [filter:drop-shadow(0_2px_4px_rgba(0,0,0,0.45))] sm:h-[42px] sm:w-[42px]"
                      fill="currentColor"
                      strokeWidth={2.2}
                    />
                  ) : (
                    <Play
                      className="ml-0.5 h-7 w-7 [filter:drop-shadow(0_2px_4px_rgba(0,0,0,0.45))] sm:ml-1 sm:h-[44px] sm:w-[44px]"
                      fill="currentColor"
                      strokeWidth={2.2}
                    />
                  )}
                </span>
              </span>
            </motion.span>
          )}
        </AnimatePresence>
      </button>
    </>
  );
}
