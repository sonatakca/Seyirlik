import {
  Check,
  ChevronLeft,
  ChevronRight,
  SlidersHorizontal,
  Volume2,
  Subtitles,
} from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { AnimatePresence, motion } from "framer-motion";
import type {
  MediaStream,
  PlaybackQualityOption,
  PlaybackSourceCandidate,
} from "../../lib/types";
import {
  COUNTRY_NAME_FLAG_CODES,
  LANGUAGE_FLAG_COUNTRY_CODES,
} from "../../lib/flagCountryCodes";
import { isVisibleSubtitleLanguage } from "../../lib/subtitleLanguages";
import { getPlaybackModeLabel } from "../../lib/playbackDiagnostics";
import { useLanguage } from "../../i18n/LanguageContext";
import type { TranslationKey } from "../../i18n/translations";
import { SwapText } from "../SwapText";
import { qualityBadgeForLabel, type QualityBadge } from "./qualityBadge";
import { AnimatedWidth } from "../AnimatedWidth";
import type {
  AutomaticQualityMode,
  CompleteFileQualityControls,
} from "./types";

import { streamLabels } from "./streamLabels";

const HIDE_QUALITY_SETTINGS = false;
const HIDE_AUDIO_SETTINGS = false;
const DISABLE_AUDIO_SELECTION = false;
const SUBTITLE_DELAY_MIN_SECONDS = -40;
const SUBTITLE_DELAY_MAX_SECONDS = 40;
const SUBTITLE_DELAY_STEP_SECONDS = 0.25;

type SettingsSection = "quality" | "audio" | "subtitles";

interface PlayerSettingsPanelProps {
  source: PlaybackSourceCandidate;
  qualityOptions: PlaybackQualityOption[];
  selectedQualityId: string;
  selectedAudioStreamIndex?: number;
  selectedSubtitleStreamIndex: number;
  subtitleDelaySeconds: number;
  canSwitchAudio: boolean;
  canSwitchSubtitles: boolean;
  completeFileQuality?: CompleteFileQualityControls;
  onSelectAutoQuality: () => void;
  onSelectQuality: (quality: PlaybackQualityOption) => void;
  onSelectAudioStream: (streamIndex: number) => void;
  /** Shown in the audio section when a track could not be started. */
  audioNoticeText?: string;
  onSelectSubtitleStream: (streamIndex: number) => void;
  onSubtitleDelayChange: (seconds: number) => void;
  onStartSubtitleEdit?: () => void;
  compact?: boolean;
}

function getStreamsOfType(
  source: PlaybackSourceCandidate,
  type: "Audio" | "Subtitle",
): MediaStream[] {
  return (
    source.mediaSource.MediaStreams?.filter(
      (stream) =>
        stream.Type?.toLowerCase() === type.toLowerCase() &&
        (type !== "Subtitle" || isVisibleSubtitleLanguage(stream.Language)),
    ) ?? []
  );
}

function getUniqueStreams(streams: MediaStream[]): MediaStream[] {
  const seenKeys = new Set<string>();

  return streams.filter((stream, index) => {
    const key =
      stream.Index !== undefined
        ? `index-${stream.Index}`
        : [
            stream.DisplayTitle,
            stream.Title,
            stream.Language,
            stream.Codec,
            stream.IsExternal,
            stream.IsDefault,
            index,
          ].join("-");

    if (seenKeys.has(key)) {
      return false;
    }

    seenKeys.add(key);
    return true;
  });
}

function formatTemplate(
  template: string,
  values: Record<string, string | number>,
): string {
  return Object.entries(values).reduce(
    (result, [key, value]) => result.split(`{${key}}`).join(String(value)),
    template,
  );
}

function normalizeFlagText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function getFlagCountryCode(value?: string): string | undefined {
  if (!value) {
    return undefined;
  }

  const normalized = normalizeFlagText(value);
  const exactLanguageCode = LANGUAGE_FLAG_COUNTRY_CODES[normalized];

  if (exactLanguageCode) {
    return exactLanguageCode;
  }

  const exactCountryCode = COUNTRY_NAME_FLAG_CODES[normalized];

  if (exactCountryCode) {
    return exactCountryCode;
  }

  const localeRegion = normalized.match(/\b[a-z]{2,3}[-_ ]([a-z]{2})\b/);

  if (localeRegion?.[1]) {
    return localeRegion[1];
  }

  if (normalized.includes("united kingdom")) {
    return "gb";
  }

  if (normalized.includes("united states")) {
    return "us";
  }

  const tokens = normalized.split(/[^a-z0-9]+/).filter(Boolean);
  const countryToken = tokens.find((token) => COUNTRY_NAME_FLAG_CODES[token]);

  if (countryToken) {
    return COUNTRY_NAME_FLAG_CODES[countryToken];
  }

  const languageToken = tokens.find(
    (token) => LANGUAGE_FLAG_COUNTRY_CODES[token],
  );

  return languageToken ? LANGUAGE_FLAG_COUNTRY_CODES[languageToken] : undefined;
}

function getStreamFlagCountryCode(stream: MediaStream): string | undefined {
  return [stream.Language, stream.DisplayTitle, stream.Title]
    .map(getFlagCountryCode)
    .find(Boolean);
}

function StreamFlag({ stream }: { stream: MediaStream }) {
  const countryCode = getStreamFlagCountryCode(stream);

  if (!countryCode) {
    return null;
  }

  return (
    <span
      className={`fi fi-${countryCode} block h-[18px] w-[25px] shrink-0 rounded-sm shadow-sm`}
      aria-hidden="true"
    />
  );
}

function getDefaultSettingsSection(showQuality: boolean): SettingsSection {
  if (showQuality) {
    return "quality";
  }

  if (!HIDE_AUDIO_SETTINGS) {
    return "audio";
  }

  return "subtitles";
}

function getSettingsTabButtonClass(active: boolean, disabled = false): string {
  if (disabled) {
    return "cursor-not-allowed bg-white/[0.03] text-white/25 opacity-60";
  }

  if (active) {
    return "bg-[var(--accent)] text-black";
  }

  return "bg-white/[0.06] text-white/65 hover:bg-white/[0.1] hover:text-white";
}

function formatSubtitleDelaySeconds(seconds: number): string {
  const roundedSeconds = Math.round(seconds * 100) / 100;
  const normalizedSeconds = Object.is(roundedSeconds, -0) ? 0 : roundedSeconds;
  const sign = normalizedSeconds > 0 ? "+" : "";
  const value = Number.isInteger(normalizedSeconds)
    ? normalizedSeconds.toFixed(1)
    : normalizedSeconds.toFixed(2).replace(/0$/, "");

  return `${sign}${value}s`;
}

function SettingsButton({
  title,
  subtitle,
  leading,
  active,
  disabled,
  hasSubmenu,
  badge,
  compact,
  buttonRef,
  ariaExpanded,
  onClick,
}: {
  title: string;
  subtitle?: string;
  /** Small class tag shown above the title's baseline, as "4K" or "HD". */
  badge?: QualityBadge | undefined;
  leading?: ReactNode;
  active?: boolean;
  disabled?: boolean;
  hasSubmenu?: boolean;
  compact?: boolean;
  buttonRef?: RefObject<HTMLButtonElement>;
  ariaExpanded?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      ref={buttonRef}
      disabled={disabled}
      aria-expanded={ariaExpanded}
      onClick={onClick}
      className={`flex w-full items-center justify-between gap-3 rounded-xl px-3 py-2.5 text-left transition ${
        disabled
          ? "cursor-not-allowed opacity-45"
          : "hover:bg-white/[0.09] focus:bg-white/[0.09] focus:outline-none"
      }`}
    >
      <span className="flex min-w-0 items-center gap-3">
        {leading ? <span className="shrink-0">{leading}</span> : null}
        <span className="min-w-0">
          {/*
           * The tag is a sibling of the title, not a child of it.
           *
           * It lived inside the truncating span, where `overflow: hidden`
           * clips anything raised above the line box — so a superscript was
           * shown with its top sliced off. Kept alongside instead, the
           * truncation still applies to the name while the tag sits in its
           * own column and is never cut.
           */}
          <span className="flex min-w-0 items-start gap-[0.15rem]">
            <span className="min-w-0 truncate text-sm font-bold text-white">
              {compact ? (
                title
              ) : (
                <AnimatedWidth value={title}>
                  <SwapText value={title} />
                </AnimatedWidth>
              )}
            </span>
            {badge ? (
              /*
               * A chip rather than loose text, so it reads as a mark on the
               * rendition instead of a fragment of its name. 4K borrows the
               * accent because it is the tier worth noticing; HD stays neutral
               * so a list of mostly-HD rungs does not turn into a wall of
               * colour. Both are kept tiny — the number is still the thing
               * being read.
               */
              <span
                className={`mt-[0.1rem] shrink-0 rounded-[3px] pl-1 pr-[0.2rem] py-[0.08rem] text-[7px] font-black uppercase leading-[1.35] tracking-[0.1em] ring-1 ${
                  badge === "4K"
                    ? /*
                       * The theme's own alpha tokens rather than an opacity
                       * modifier on an arbitrary value: `bg-[var(--accent)]/20`
                       * does not survive the build here, and silently rendered
                       * a chip with no fill and a solid ring.
                       */
                      "bg-[var(--accent-soft)] text-[var(--accent)] ring-[var(--accent-strong)]"
                    : "bg-white/10 text-white/65 ring-white/15"
                }`}
              >
                {badge}
              </span>
            ) : null}
          </span>
          {subtitle ? (
            <span className="mt-0.5 block truncate text-xs text-white/45">
              {compact ? (
                subtitle
              ) : (
                <AnimatedWidth value={subtitle}>
                  <SwapText value={subtitle} />
                </AnimatedWidth>
              )}
            </span>
          ) : null}
        </span>
      </span>

      <span className="flex shrink-0 items-center gap-2 text-white/55">
        {active ? <Check size={16} className="text-[var(--accent)]" /> : null}
        {hasSubmenu ? <ChevronRight size={16} /> : null}
      </span>
    </button>
  );
}

const AUTOMATIC_QUALITY_MODES: Array<{
  mode: AutomaticQualityMode;
  labelKey: TranslationKey;
  descriptionKey: TranslationKey;
}> = [
  {
    mode: "low-data",
    labelKey: "player.qualityLowData",
    descriptionKey: "player.qualityLowDataDescription",
  },
  {
    mode: "auto",
    labelKey: "settings.auto",
    descriptionKey: "player.qualityFileAutoDescription",
  },
  {
    mode: "higher-resolution",
    labelKey: "player.qualityHigherResolution",
    descriptionKey: "player.qualityHigherResolutionDescription",
  },
];

/**
 * The four top-level complete-file quality modes. Advanced opens a submenu that
 * lists every quality actually backed by a playable original or a validated
 * generated file — nothing here can request a quality that does not exist yet.
 */
function CompleteFileQualitySection({
  controls,
  compact,
  isAdvancedOpen,
  onToggleAdvanced,
}: {
  controls: CompleteFileQualityControls;
  compact: boolean;
  isAdvancedOpen: boolean;
  onToggleAdvanced: (open: boolean) => void;
  source: PlaybackSourceCandidate;
}) {
  const { t } = useLanguage();
  const advancedButtonRef = useRef<HTMLButtonElement>(null);
  const shouldRestoreAdvancedFocus = useRef(false);

  useEffect(() => {
    if (isAdvancedOpen || !shouldRestoreAdvancedFocus.current) return;
    shouldRestoreAdvancedFocus.current = false;
    advancedButtonRef.current?.focus();
  }, [isAdvancedOpen]);

  const closeAdvanced = () => {
    shouldRestoreAdvancedFocus.current = true;
    onToggleAdvanced(false);
  };

  const handleAdvancedKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape") return;
    // Escape steps back to the mode list first so the whole settings panel is
    // not dismissed while the viewer is still choosing a quality.
    event.stopPropagation();
    closeAdvanced();
  };

  const lockedOption = controls.advancedOptions.find(
    (option) => option.id === controls.lockedQualityId,
  );

  if (isAdvancedOpen) {
    return (
      <div onKeyDown={handleAdvancedKeyDown}>
        <button
          type="button"
          onClick={closeAdvanced}
          className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-xs font-bold text-white/70 transition hover:bg-white/[0.09] focus:bg-white/[0.09] focus:outline-none"
        >
          <ChevronLeft size={16} />
          {t("player.qualityBackToModes")}
        </button>

        {controls.advancedOptions.length > 0 ? (
          controls.advancedOptions.map((option) => (
            <SettingsButton
              key={option.id}
              title={option.label}
              badge={qualityBadgeForLabel(option.label, option.maxHeight)}
              // A switch can take a while on a slow link, so the row the viewer
              // picked says so rather than looking inert.
              subtitle={
                controls.preparingQualityId === option.id
                  ? t("player.qualityPreparing")
                  : option.subtitle
              }
              active={
                controls.activeMode === "advanced" &&
                controls.lockedQualityId === option.id
              }
              compact={compact}
              onClick={() => controls.onSelectAdvancedQuality(option.id)}
            />
          ))
        ) : (
          <SettingsButton
            title={t("settings.manualQuality")}
            subtitle={t("settings.noAlternateQualities")}
            disabled
            compact={compact}
          />
        )}
      </div>
    );
  }

  return (
    <>
      {AUTOMATIC_QUALITY_MODES.map(({ mode, labelKey, descriptionKey }) => {
        const effectiveLabel = controls.modeQualityLabels[mode];

        return (
          <SettingsButton
            key={mode}
            title={
              mode === "auto" && effectiveLabel
                ? formatTemplate(t("player.qualityAutoEffective"), {
                    quality: effectiveLabel,
                  })
                : t(labelKey)
            }
            subtitle={
              mode === "auto"
                ? undefined
                : (effectiveLabel ?? t(descriptionKey))
            }
            /*
             * Auto puts the rendition in its own title; the biased modes put
             * it in the subtitle. Either way the tag describes the same thing,
             * so it is read from whichever line is carrying it.
             */
            badge={
              effectiveLabel ? qualityBadgeForLabel(effectiveLabel) : undefined
            }
            active={controls.activeMode === mode}
            compact={compact}
            onClick={() => controls.onSelectMode(mode)}
          />
        );
      })}

      <SettingsButton
        title={t("player.qualityAdvanced")}
        /*
         * The rendition alone. The row is already the selected one and reads
         * "Advanced" above it, so spelling out that it is locked adds a word
         * without adding a fact.
         */
        subtitle={
          controls.activeMode === "advanced" && lockedOption
            ? lockedOption.label
            : undefined
        }
        badge={
          controls.activeMode === "advanced" && lockedOption
            ? qualityBadgeForLabel(lockedOption.label, lockedOption.maxHeight)
            : undefined
        }
        active={controls.activeMode === "advanced"}
        hasSubmenu
        compact={compact}
        buttonRef={advancedButtonRef}
        ariaExpanded={false}
        onClick={() => onToggleAdvanced(true)}
      />
    </>
  );
}

/**
 * How the panel resolves a change of size.
 *
 * Slightly slower than the fade beneath it, so the box has settled by the time
 * the incoming section is fully legible rather than the two finishing together
 * and reading as one abrupt jump.
 */
const PANEL_RESIZE = { duration: 0.32, ease: [0.22, 1, 0.36, 1] } as const;

/**
 * How one section gives way to another.
 *
 * Opacity only. Sections used to animate their own height as well, which meant
 * every switch had two elements interpolating the same dimension from
 * different starting measurements.
 */
const SECTION_FADE = { duration: 0.16, ease: "easeInOut" } as const;

export function PlayerSettingsPanel({
  source,
  qualityOptions,
  selectedQualityId,
  selectedAudioStreamIndex,
  selectedSubtitleStreamIndex,
  subtitleDelaySeconds,
  canSwitchAudio,
  canSwitchSubtitles,
  completeFileQuality,
  onSelectAutoQuality,
  onSelectQuality,
  onSelectAudioStream,
  audioNoticeText,
  onSelectSubtitleStream,
  onSubtitleDelayChange,
  onStartSubtitleEdit,
  compact = false,
}: PlayerSettingsPanelProps) {
  const { t, language = "en" } = useLanguage();
  const audioStreams = getUniqueStreams(getStreamsOfType(source, "Audio"));
  const subtitleStreams = getUniqueStreams(
    getStreamsOfType(source, "Subtitle"),
  );
  const audioLabels = streamLabels(audioStreams, "audio", language, t);
  const subtitleLabels = streamLabels(subtitleStreams, "subtitle", language, t);
  // A stored copy is one rung, kept as it was downloaded: there is no
  // quality to choose, so the tab is not offered at all.
  const showQuality = !HIDE_QUALITY_SETTINGS && source.offline !== true;
  const [activeSection, setActiveSection] = useState<SettingsSection>(() =>
    getDefaultSettingsSection(showQuality),
  );
  const [isAdvancedQualityOpen, setIsAdvancedQualityOpen] = useState(false);
  const canSelectAudio = canSwitchAudio && !DISABLE_AUDIO_SELECTION;

  return (
    /*
     * One element owns the panel's size, and it is this one.
     *
     * Size used to be animated here *and* on the scroll container *and* on
     * each section, which all measure independently: three animators chasing
     * the same box. Stepping into Advanced changed the content underneath them
     * with no transition of its own, so the height jumped while the outer
     * animation was still interpolating towards the old target and the panel
     * appeared to stutter and overshoot. Now the sections only fade, and the
     * single layout animation below resolves whatever size that leaves.
     */
    <motion.div
      layout
      transition={PANEL_RESIZE}
      className="seyirlik-player-settings-panel fixed inset-x-2 bottom-[calc(env(safe-area-inset-bottom)+0.5rem)] z-[70] max-h-[calc(100dvh-1rem)] overflow-hidden rounded-2xl border border-white/10 bg-[rgba(18,18,20,0.96)] shadow-[0_24px_90px_rgba(0,0,0,0.72)] backdrop-blur-2xl sm:absolute sm:inset-x-auto sm:bottom-[5.25rem] sm:right-0 sm:w-[min(22rem,calc(100vw-2rem))]"
    >
      <div className="seyirlik-player-settings-header border-b border-white/10 px-4 py-3">
        <p className="text-xs font-bold uppercase tracking-[0.18em] text-[var(--accent)]">
          {t("settings.settings")}
        </p>
        <h2 className="mt-0.5 text-base font-black text-white">
          {t("settings.playbackOptions")}
        </h2>

        <div
          className={`seyirlik-player-settings-tabs mt-3 grid gap-2 ${
            showQuality ? "grid-cols-3" : "grid-cols-2"
          }`}
        >
          {showQuality ? (
            <button
              type="button"
              onClick={() => setActiveSection("quality")}
              className={`flex items-center justify-center gap-1.5 rounded-xl px-2 py-2 text-xs font-bold transition ${getSettingsTabButtonClass(
                activeSection === "quality",
              )}`}
            >
              <SlidersHorizontal size={15} strokeWidth={2.2} />
              <span>{t("settings.quality")}</span>
            </button>
          ) : null}

          <button
            type="button"
            disabled={HIDE_AUDIO_SETTINGS}
            onClick={
              HIDE_AUDIO_SETTINGS ? undefined : () => setActiveSection("audio")
            }
            className={`flex items-center justify-center gap-1.5 rounded-xl px-2 py-2 text-xs font-bold transition ${getSettingsTabButtonClass(
              activeSection === "audio",
              HIDE_AUDIO_SETTINGS,
            )}`}
          >
            <Volume2 size={15} strokeWidth={2.2} />
            <span>{t("settings.audio")}</span>
          </button>

          <button
            type="button"
            onClick={() => setActiveSection("subtitles")}
            className={`flex items-center justify-center gap-1.5 rounded-xl px-2 py-2 text-xs font-bold transition ${getSettingsTabButtonClass(
              activeSection === "subtitles",
            )}`}
          >
            <Subtitles size={15} strokeWidth={2.2} />
            <span>{t("settings.subtitles")}</span>
          </button>
        </div>
      </div>

      <div className="seyirlik-player-settings-content max-h-[calc(100dvh-8.75rem)] overflow-y-auto p-2 sm:max-h-[min(28rem,calc(100svh-15rem))]">
        <AnimatePresence mode="wait" initial={false}>
          {showQuality && activeSection === "quality" ? (
            <motion.div
              key="quality"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={SECTION_FADE}
            >
              <div className="px-2 pb-1 pt-2 text-xs font-black uppercase tracking-[0.16em] text-white/40">
                {t("settings.quality")}
              </div>

              {completeFileQuality?.noticeText ? (
                <p
                  role="status"
                  className="mx-2 mb-2 rounded-xl bg-white/[0.05] px-3 py-2 text-[11px] leading-relaxed text-white/70"
                >
                  {completeFileQuality.noticeText}
                </p>
              ) : null}

              {completeFileQuality ? (
                <CompleteFileQualitySection
                  controls={completeFileQuality}
                  compact={compact}
                  isAdvancedOpen={isAdvancedQualityOpen}
                  onToggleAdvanced={setIsAdvancedQualityOpen}
                  source={source}
                />
              ) : (
                <>
                  <SettingsButton
                    title={getPlaybackModeLabel(source.mode, t)}
                    subtitle={
                      source.mediaSource.Container
                        ? `${source.mediaSource.Container.toUpperCase()} · ${t("settings.currentSource")}`
                        : t("settings.currentSource")
                    }
                    active
                    compact={compact}
                  />

                  <SettingsButton
                    title={t("settings.auto")}
                    subtitle={
                      selectedQualityId === "auto"
                        ? t("settings.bestSource")
                        : t("settings.useBestSource")
                    }
                    active={selectedQualityId === "auto"}
                    compact={compact}
                    onClick={onSelectAutoQuality}
                  />

                  {qualityOptions.length > 0 ? (
                    qualityOptions.map((quality) => (
                      <SettingsButton
                        key={quality.id}
                        title={quality.label}
                        subtitle={
                          selectedQualityId === quality.id
                            ? t("settings.currentQuality")
                            : formatTemplate(t("settings.hlsUpTo"), {
                                mbps: Math.round(
                                  quality.maxStreamingBitrate / 1_000_000,
                                ),
                              })
                        }
                        active={selectedQualityId === quality.id}
                        compact={compact}
                        onClick={() => onSelectQuality(quality)}
                      />
                    ))
                  ) : (
                    <SettingsButton
                      title={t("settings.manualQuality")}
                      subtitle={t("settings.noAlternateQualities")}
                      disabled
                      hasSubmenu
                      compact={compact}
                    />
                  )}
                </>
              )}

              {completeFileQuality?.limitationsText ? (
                <p className="px-3 pb-1 pt-2 text-[11px] leading-relaxed text-white/45">
                  {completeFileQuality.limitationsText}
                </p>
              ) : null}
            </motion.div>
          ) : null}

          {!HIDE_AUDIO_SETTINGS && activeSection === "audio" ? (
            <motion.div
              key="audio"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={SECTION_FADE}
            >
              <div className="px-2 pb-1 pt-2 text-xs font-black uppercase tracking-[0.16em] text-white/40">
                {t("settings.audio")}
              </div>

              {/*
                A failed audio change has to be reported where the viewer is
                looking. The same notice is shown under Quality, and an audio
                failure announced only there is indistinguishable from the
                click doing nothing at all.
              */}
              {audioNoticeText ? (
                <p
                  role="status"
                  className="mx-2 mb-2 rounded-xl bg-white/[0.05] px-3 py-2 text-[11px] leading-relaxed text-white/70"
                >
                  {audioNoticeText}
                </p>
              ) : null}

              {audioStreams.length > 0 ? (
                audioStreams.map((stream, index) => (
                  <SettingsButton
                    key={`${stream.Index ?? index}-audio`}
                    leading={<StreamFlag stream={stream} />}
                    title={audioLabels[index]}
                    subtitle={
                      stream.Index === selectedAudioStreamIndex
                        ? t("settings.currentAudio")
                        : canSwitchAudio
                          ? t("settings.clickToSwitch")
                          : t("settings.requiresTranscoding")
                    }
                    active={stream.Index === selectedAudioStreamIndex}
                    disabled={stream.Index === undefined || !canSelectAudio}
                    compact={compact}
                    onClick={
                      stream.Index === undefined || !canSelectAudio
                        ? undefined
                        : () => onSelectAudioStream(stream.Index as number)
                    }
                  />
                ))
              ) : (
                <p className="mx-2 rounded-xl bg-white/[0.05] px-3 py-2 text-sm text-white/50">
                  {t("settings.noAudioTracks")}
                </p>
              )}
            </motion.div>
          ) : null}

          {activeSection === "subtitles" ? (
            <motion.div
              key="subtitles"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={SECTION_FADE}
            >
              <div className="px-2 pb-1 pt-2 text-xs font-black uppercase tracking-[0.16em] text-white/40">
                {t("settings.subtitles")}
              </div>

              <SettingsButton
                title={t("settings.off")}
                subtitle={
                  selectedSubtitleStreamIndex === -1
                    ? t("settings.subtitlesOff")
                    : t("settings.disableSubtitles")
                }
                active={selectedSubtitleStreamIndex === -1}
                disabled={!canSwitchSubtitles}
                compact={compact}
                onClick={
                  canSwitchSubtitles
                    ? () => onSelectSubtitleStream(-1)
                    : undefined
                }
              />

              {subtitleStreams.length > 0 ? (
                subtitleStreams.map((stream, index) => (
                  <SettingsButton
                    key={`${stream.Index ?? index}-subtitle`}
                    leading={<StreamFlag stream={stream} />}
                    title={subtitleLabels[index]}
                    subtitle={
                      stream.Index === selectedSubtitleStreamIndex
                        ? t("settings.currentSubtitle")
                        : canSwitchSubtitles
                          ? t("settings.clickToEnable")
                          : t("settings.subtitleUnavailable")
                    }
                    active={stream.Index === selectedSubtitleStreamIndex}
                    disabled={stream.Index === undefined || !canSwitchSubtitles}
                    compact={compact}
                    onClick={
                      stream.Index === undefined || !canSwitchSubtitles
                        ? undefined
                        : () => onSelectSubtitleStream(stream.Index as number)
                    }
                  />
                ))
              ) : (
                <p className="mx-2 rounded-xl bg-white/[0.05] px-3 py-2 text-sm text-white/50">
                  {t("settings.noSubtitles")}
                </p>
              )}

              <div className="mx-2 mt-2 rounded-xl bg-white/[0.05] px-3 py-3">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-sm font-bold text-white">
                    {t("settings.subtitleDelay")}
                  </span>
                  <span className="shrink-0 rounded-full bg-white/[0.08] px-2 py-1 text-xs font-black text-[var(--accent)]">
                    {formatSubtitleDelaySeconds(subtitleDelaySeconds)}
                  </span>
                </div>
                <input
                  type="range"
                  min={SUBTITLE_DELAY_MIN_SECONDS}
                  max={SUBTITLE_DELAY_MAX_SECONDS}
                  step={SUBTITLE_DELAY_STEP_SECONDS}
                  value={subtitleDelaySeconds}
                  aria-label={t("settings.subtitleDelay")}
                  onChange={(event) =>
                    onSubtitleDelayChange(Number(event.currentTarget.value))
                  }
                  className="mt-3 h-2 w-full cursor-pointer accent-[var(--accent)]"
                />
                <div className="mt-1 flex items-center justify-between text-[0.65rem] font-bold text-white/35">
                  <span>
                    {formatSubtitleDelaySeconds(SUBTITLE_DELAY_MIN_SECONDS)}
                  </span>
                  <span>
                    {formatSubtitleDelaySeconds(SUBTITLE_DELAY_MAX_SECONDS)}
                  </span>
                </div>
              </div>

              <SettingsButton
                title={t("settings.editSubtitles")}
                subtitle={
                  selectedSubtitleStreamIndex >= 0
                    ? t("settings.dragResizeSubtitles")
                    : t("settings.enableSubtitlesToEdit")
                }
                disabled={
                  selectedSubtitleStreamIndex < 0 ||
                  !canSwitchSubtitles ||
                  !onStartSubtitleEdit
                }
                compact={compact}
                onClick={
                  selectedSubtitleStreamIndex < 0 ||
                  !canSwitchSubtitles ||
                  !onStartSubtitleEdit
                    ? undefined
                    : onStartSubtitleEdit
                }
              />
            </motion.div>
          ) : null}
        </AnimatePresence>
      </div>
    </motion.div>
  );
}
